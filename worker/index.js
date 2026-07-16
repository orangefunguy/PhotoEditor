/**
 * Cloudflare Worker — edge proxy + durable auth store for editor.herooflegend.com
 *
 * - Proxies app traffic to the Render origin
 * - Stores auth snapshots in KV so accounts/sessions survive free-tier restarts
 */

const SNAPSHOT_KEY = "auth:v1:snapshot";

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    // Internal durable-auth API (Render → Worker → KV). Not for browsers.
    if (incoming.pathname.startsWith("/_internal/auth/")) {
      return handleAuthInternal(request, env, incoming);
    }

    return proxyToOrigin(request, env, incoming);
  },
};

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

  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
    headers.set("X-Real-IP", clientIp);
  }
  headers.set("X-Forwarded-Proto", "https");
  headers.set("X-Forwarded-Host", incoming.host);

  /** @type {RequestInit} */
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let response;
  try {
    response = await fetch(targetUrl, init);
  } catch (err) {
    return new Response(
      JSON.stringify({
        detail: "PhotoEditor origin unreachable",
        origin: originBase,
        error: String(err && err.message ? err.message : err),
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

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

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outHeaders,
  });
}

/**
 * @param {unknown} data
 * @param {number} status
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
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
    // Still walk to reduce length-oracle timing; always false
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
