/**
 * Cloudflare Worker — edge proxy + durable auth store for editor.herooflegend.com
 *
 * - Proxies app traffic to the Render origin with cold-start retries
 * - Stores auth snapshots in KV so accounts/sessions survive free-tier restarts
 * - Cron keep-alive pings the origin so free-tier spin-down is less frequent
 */

const SNAPSHOT_KEY = "auth:v1:snapshot";

/** Render free can take a while to wake; retry within Worker wall-time limits. */
const ORIGIN_ATTEMPTS = 4;
const ORIGIN_RETRY_BASE_MS = 1200;
const ORIGIN_ATTEMPT_TIMEOUT_MS = 18000;

/** Paths that must ship from latest main even if Render deploy lags. */
const EDGE_STATIC_PREFIXES = [
  "/static/vendor/",
  "/static/js/denoise-worker.js",
  "/static/js/client-pipeline.js",
  "/static/js/app.js",
  "/static/js/tooltips.js",
  "/static/index.html",
];

// jsDelivr is more reliable for large binaries (wasm) than raw.githubusercontent
const GITHUB_RAW =
  "https://cdn.jsdelivr.net/gh/orangefunguy/PhotoEditor@main";

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    // Internal durable-auth API (Render → Worker → KV). Not for browsers.
    if (incoming.pathname.startsWith("/_internal/auth/")) {
      return handleAuthInternal(request, env, incoming);
    }

    // Serve quality denoise assets from GitHub main when Render is stale
    if (shouldServeFromEdge(incoming.pathname)) {
      const edge = await serveEdgeStatic(incoming.pathname, request);
      if (edge) return edge;
    }

    // HTML entry: inject cache-bust for local pipeline if origin is old
    if (incoming.pathname === "/" || incoming.pathname === "/index.html") {
      const proxied = await proxyToOrigin(request, env, incoming);
      return maybeRewriteIndexHtml(proxied);
    }

    return proxyToOrigin(request, env, incoming);
  },

  async scheduled(_event, env, ctx) {
    // Keep free-tier origin warm
    ctx.waitUntil(warmOrigin(env));
  },
};

/** @param {string} pathname */
function shouldServeFromEdge(pathname) {
  const path = pathname.split("?")[0];
  return EDGE_STATIC_PREFIXES.some(
    (p) => path === p || path.startsWith(p) || path.startsWith(p.replace(/\.js$/, ""))
  );
}

/**
 * Fetch latest static file from GitHub main (bypasses stale Render free deploys).
 * @param {string} pathname
 * @param {Request} request
 */
async function serveEdgeStatic(pathname, request) {
  const path = pathname.split("?")[0];
  // normalize
  let rel = path;
  if (rel === "/static/index.html") rel = "/static/index.html";
  const url = GITHUB_RAW + rel;
  try {
    const res = await fetch(url, {
      cf: { cacheTtl: 60, cacheEverything: true },
      headers: {
        "User-Agent": "PhotoEditor-Edge/1.0",
        // conditional revalidation
        "Cache-Control": "no-cache",
      },
    });
    if (!res.ok) return null;
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "public, max-age=60, must-revalidate");
    if (rel.endsWith(".wasm")) {
      headers.set("Content-Type", "application/wasm");
    } else if (rel.endsWith(".js")) {
      headers.set("Content-Type", "application/javascript; charset=utf-8");
    } else if (rel.endsWith(".html")) {
      headers.set("Content-Type", "text/html; charset=utf-8");
    }
    // CORS for workers loading wasm from same origin is fine
    return new Response(res.body, { status: 200, headers });
  } catch {
    return null;
  }
}

/**
 * Ensure editor HTML references the quality pipeline scripts.
 * @param {Response} response
 */
async function maybeRewriteIndexHtml(response) {
  if (!response || response.status !== 200) return response;
  const ct = response.headers.get("Content-Type") || "";
  if (!ct.includes("text/html")) return response;
  let html = await response.text();
  if (!html.includes("client-pipeline.js")) {
    html = html.replace(
      /(<script src="\/static\/js\/tooltips\.js[^"]*"><\/script>)/,
      '$1\n    <script src="/static/js/client-pipeline.js?v=20260716d"></script>'
    );
  }
  // Force latest asset versions
  html = html.replace(
    /(\/static\/js\/(?:app|client-pipeline|denoise-worker|tooltips|store|activity-log)\.js)\?v=[^"]+/g,
    "$1?v=20260716d"
  );
  if (!html.includes("/static/js/app.js")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("content-length");
  return new Response(html, { status: response.status, headers });
}

/**
 * @param {{ API_ORIGIN?: string }} env
 */
async function warmOrigin(env) {
  const originBase = (env.API_ORIGIN || "https://photoeditor-oiom.onrender.com").replace(
    /\/$/,
    ""
  );
  try {
    await fetch(`${originBase}/healthz`, {
      method: "GET",
      headers: { "User-Agent": "PhotoEditor-KeepAlive/1.0" },
      redirect: "manual",
    });
  } catch {
    /* ignore — next browser request will retry */
  }
}

/**
 * @param {Request} request
 * @param {{ AUTH: KVNamespace, AUTH_SYNC_SECRET?: string, API_ORIGIN?: string }} env
 * @param {URL} incoming
 */
async function handleAuthInternal(request, env, incoming) {
  const secret = env.AUTH_SYNC_SECRET || "";
  if (!secret) {
    return json({ detail: "AUTH_SYNC_SECRET not configured on Worker" }, 503);
  }

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !timingSafeEqual(token, secret)) {
    return json({ detail: "Unauthorized" }, 401);
  }

  if (!env.AUTH) {
    return json({ detail: "AUTH KV binding missing" }, 503);
  }

  const path = incoming.pathname.replace(/\/$/, "") || "/";

  if (path === "/_internal/auth/snapshot" && request.method === "GET") {
    const raw = await env.AUTH.get(SNAPSHOT_KEY);
    if (!raw) {
      return json({ detail: "No snapshot" }, 404);
    }
    try {
      const parsed = JSON.parse(raw);
      return json({
        snapshot: parsed.snapshot || parsed,
        updated_at: parsed.updated_at || null,
      });
    } catch {
      return json({ detail: "Corrupt snapshot" }, 500);
    }
  }

  if (path === "/_internal/auth/snapshot" && request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ detail: "Invalid JSON body" }, 400);
    }
    const snapshot = body && body.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      return json({ detail: "Body must include snapshot object" }, 400);
    }
    const users = Array.isArray(snapshot.users) ? snapshot.users.length : 0;
    const sessions = Array.isArray(snapshot.sessions)
      ? snapshot.sessions.length
      : 0;
    const payload = {
      snapshot,
      updated_at: body.updated_at || Date.now() / 1000,
      users,
      sessions,
    };
    await env.AUTH.put(SNAPSHOT_KEY, JSON.stringify(payload));
    return json({ status: "ok", users, sessions, updated_at: payload.updated_at });
  }

  if (path === "/_internal/auth/health" && request.method === "GET") {
    const raw = await env.AUTH.get(SNAPSHOT_KEY);
    let users = 0;
    let sessions = 0;
    let updated_at = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const snap = parsed.snapshot || parsed;
        users = Array.isArray(snap.users) ? snap.users.length : 0;
        sessions = Array.isArray(snap.sessions) ? snap.sessions.length : 0;
        updated_at = parsed.updated_at || null;
      } catch {
        /* ignore */
      }
    }
    return json({
      status: "ok",
      has_snapshot: Boolean(raw),
      users,
      sessions,
      updated_at,
    });
  }

  return json({ detail: "Not found" }, 404);
}

/**
 * @param {Request} request
 * @param {{ API_ORIGIN?: string }} env
 * @param {URL} incoming
 */
async function proxyToOrigin(request, env, incoming) {
  const originBase = (env.API_ORIGIN || "https://photoeditor-oiom.onrender.com").replace(
    /\/$/,
    ""
  );
  const targetUrl = originBase + incoming.pathname + incoming.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("cf-ipcountry");
  headers.delete("content-length");
  // Avoid Cloudflare bot-score quirks when re-fetching origin
  if (!headers.get("User-Agent")) {
    headers.set("User-Agent", "PhotoEditor-Edge/1.0");
  }

  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
    headers.set("X-Real-IP", clientIp);
  }
  headers.set("X-Forwarded-Proto", "https");
  headers.set("X-Forwarded-Host", incoming.host);

  // Buffer body once so we can retry non-GET methods
  let bodyBuf = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    bodyBuf = await request.arrayBuffer();
  }

  let lastErr = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= ORIGIN_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ORIGIN_ATTEMPT_TIMEOUT_MS);
    try {
      /** @type {RequestInit} */
      const init = {
        method: request.method,
        headers,
        redirect: "manual",
        signal: controller.signal,
        // cf property is Worker-specific
        cf: {
          cacheTtl: 0,
          cacheEverything: false,
        },
      };
      if (bodyBuf) {
        init.body = bodyBuf;
      }

      const response = await fetch(targetUrl, init);
      clearTimeout(timer);

      // Retry typical cold-start / gateway failures from origin or intermediate
      if (shouldRetryOrigin(response.status) && attempt < ORIGIN_ATTEMPTS) {
        lastStatus = response.status;
        // Drain body so connection can close cleanly
        try {
          await response.arrayBuffer();
        } catch {
          /* ignore */
        }
        await sleep(ORIGIN_RETRY_BASE_MS * attempt);
        continue;
      }

      return rewriteOriginResponse(response, originBase, incoming);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < ORIGIN_ATTEMPTS) {
        await sleep(ORIGIN_RETRY_BASE_MS * attempt);
        continue;
      }
    }
  }

  const detail =
    lastErr && lastErr.message
      ? String(lastErr.message)
      : lastStatus
        ? `origin returned ${lastStatus}`
        : "origin unreachable";

  // Browser navigations get a readable HTML page; API/XHR get JSON
  const accept = request.headers.get("Accept") || "";
  const wantsHtml =
    request.method === "GET" && accept.includes("text/html") && !incoming.pathname.startsWith("/api/");

  if (wantsHtml) {
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PhotoEditor — starting up</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f1419;color:#e7ecf1;display:grid;place-items:center;min-height:100vh;margin:0}
    .card{max-width:28rem;padding:1.5rem 1.75rem;border:1px solid #2a3540;border-radius:12px;background:#151b22}
    h1{font-size:1.15rem;margin:0 0 .5rem}
    p{margin:.4rem 0;line-height:1.45;color:#a8b3bf;font-size:.95rem}
    button{margin-top:1rem;padding:.55rem 1rem;border-radius:8px;border:0;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
    code{font-size:.8rem;color:#94a3b8}
  </style>
</head>
<body>
  <div class="card">
    <h1>PhotoEditor is waking up</h1>
    <p>The host was idle and is starting. This usually takes a few seconds on free hosting.</p>
    <p><code>${escapeHtml(detail)}</code></p>
    <button type="button" onclick="location.reload()">Try again</button>
  </div>
  <script>setTimeout(function(){location.reload()},4000)</script>
</body>
</html>`,
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "5",
        },
      }
    );
  }

  return new Response(
    JSON.stringify({
      detail: "PhotoEditor origin temporarily unavailable (cold start or network).",
      origin: originBase,
      error: detail,
      retryable: true,
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": "5",
      },
    }
  );
}

/**
 * @param {Response} response
 * @param {string} originBase
 * @param {URL} incoming
 */
function rewriteOriginResponse(response, originBase, incoming) {
  const outHeaders = new Headers(response.headers);
  const location = outHeaders.get("Location");
  if (location) {
    try {
      const originHost = new URL(originBase).host;
      const locUrl = new URL(location, originBase);
      if (locUrl.host === originHost) {
        locUrl.protocol = "https:";
        locUrl.host = incoming.host;
        outHeaders.set("Location", locUrl.toString());
      }
    } catch {
      /* leave Location as-is */
    }
  }

  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");

  // Cache policy: HTML/API/auth never cached; JS/CSS revalidate quickly
  // (avoids stale editor after deploys behind Cloudflare)
  const ct = (outHeaders.get("Content-Type") || "").toLowerCase();
  const path = incoming.pathname || "";
  if (
    response.status >= 400 ||
    ct.includes("text/html") ||
    ct.includes("application/json")
  ) {
    outHeaders.set("Cache-Control", "no-store");
  } else if (
    path.startsWith("/static/") ||
    ct.includes("javascript") ||
    ct.includes("text/css")
  ) {
    outHeaders.set("Cache-Control", "public, max-age=60, must-revalidate");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outHeaders,
  });
}

/** @param {number} status */
function shouldRetryOrigin(status) {
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 520 ||
    status === 521 ||
    status === 522 ||
    status === 523 ||
    status === 524
  );
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {unknown} data
 * @param {number} status
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Constant-time string compare for secrets.
 * @param {string} a
 * @param {string} b
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) {
    let diff = ba.length ^ bb.length;
    const n = Math.max(ba.length, bb.length);
    for (let i = 0; i < n; i++) {
      diff |= (ba[i] || 0) ^ (bb[i] || 0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}
