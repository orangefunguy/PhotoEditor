// AUTO: full client-pipeline for edge when GitHub is stale
const EMBEDDED_CLIENT_PIPELINE = "/**\n * PhotoEditor client pipeline — local denoise / analyze via Web Worker.\n *\n * Important: do NOT warm-load OpenCV on a separate \"ping\" job. Workers are\n * single-threaded; a hung WASM compile would block denoise until the client\n * times out. OpenCV loads inside the denoise/analyze job with progress.\n */\n(function (global) {\n  \"use strict\";\n\n  let _worker = null;\n  let _seq = 0;\n  /** @type {Map<string, {resolve:Function, reject:Function, onProgress?:Function, lastProgressAt:number}>} */\n  const _pending = new Map();\n\n  function workerUrl() {\n    const scripts = document.querySelectorAll(\"script[src*='client-pipeline']\");\n    const src = scripts[scripts.length - 1]?.getAttribute(\"src\") || \"\";\n    const q = src.includes(\"?\") ? src.slice(src.indexOf(\"?\")) : \"\";\n    // Always bust denoise-worker cache when pipeline version changes\n    return `/static/js/denoise-worker.js${q || \"?v=local\"}`;\n  }\n\n  function rejectAllPending(err) {\n    for (const [, p] of _pending) {\n      try {\n        p.reject(err);\n      } catch {\n        /* ignore */\n      }\n    }\n    _pending.clear();\n  }\n\n  /**\n   * Terminate worker and fail pending jobs.\n   * @param {Error|DOMException} err\n   */\n  function failAll(err) {\n    if (_worker) {\n      try {\n        _worker.terminate();\n      } catch {\n        /* ignore */\n      }\n      _worker = null;\n    }\n    rejectAllPending(err);\n    return err;\n  }\n\n  /** User-initiated stop */\n  function cancelAll(reason) {\n    return failAll(new DOMException(reason || \"Stopped by user\", \"AbortError\"));\n  }\n\n  function getWorker() {\n    if (_worker) return _worker;\n    _worker = new Worker(workerUrl());\n    _worker.onmessage = (ev) => {\n      const msg = ev.data || {};\n      const p = _pending.get(msg.id);\n      if (!p) return;\n      if (msg.type === \"progress\") {\n        p.onProgress?.(msg.pct, msg.label);\n        p.lastProgressAt = Date.now();\n        return;\n      }\n      if (msg.type === \"error\") {\n        _pending.delete(msg.id);\n        p.reject(new Error(msg.message || \"Local processing failed\"));\n        return;\n      }\n      if (msg.type === \"result\" || msg.type === \"analyze_result\") {\n        _pending.delete(msg.id);\n        p.resolve(msg);\n        return;\n      }\n      if (msg.type === \"pong\") {\n        _pending.delete(msg.id);\n        p.resolve(msg);\n      }\n    };\n    _worker.onerror = (e) => {\n      console.error(\"Denoise worker error\", e);\n      failAll(new Error(e.message || \"Worker crashed\"));\n    };\n    _worker.onmessageerror = () => {\n      failAll(new Error(\"Worker message error\"));\n    };\n    // No warm ping — it blocked the single worker thread behind OpenCV load.\n    return _worker;\n  }\n\n  function nextId() {\n    _seq += 1;\n    return `pe-${Date.now().toString(36)}-${_seq}`;\n  }\n\n  async function blobToTransfer(blob) {\n    const buffer = await blob.arrayBuffer();\n    return {\n      buffer,\n      mime: blob.type || \"application/octet-stream\",\n      fileBytes: blob.size,\n    };\n  }\n\n  function isAbortError(e) {\n    if (!e) return false;\n    if (e.name === \"AbortError\") {\n      // Only treat explicit user stop as abort — not timeouts mislabeled AbortError\n      const msg = String(e.message || \"\");\n      return /stop|cancel|abort/i.test(msg) && !/timed?\\s*out|stall/i.test(msg);\n    }\n    return /stopped by user|user cancel/i.test(String(e.message || e));\n  }\n\n  /**\n   * @param {Blob|File} imageBlob\n   * @param {object} controls\n   * @param {{\n   *   onProgress?: (pct:number, label?:string)=>void,\n   *   maxProcessSide?: number,\n   *   signal?: AbortSignal,\n   *   timeoutMs?: number,\n   * }} [opts]\n   */\n  async function denoiseLocal(imageBlob, controls, opts = {}) {\n    if (!imageBlob) throw new Error(\"No image to process.\");\n    if (opts.signal?.aborted) {\n      throw new DOMException(\"Stopped by user\", \"AbortError\");\n    }\n\n    const id = nextId();\n    const w = getWorker();\n    const transfer = await blobToTransfer(imageBlob);\n    // First OpenCV compile can be slow; allow 2 min. Pure filter should be <30s.\n    const timeoutMs = opts.timeoutMs || 120000;\n\n    const result = await new Promise((resolve, reject) => {\n      let settled = false;\n      const finish = (fn, arg) => {\n        if (settled) return;\n        settled = true;\n        cleanup();\n        _pending.delete(id);\n        fn(arg);\n      };\n\n      let timeoutTimer = null;\n      let stallTimer = null;\n\n      const cleanup = () => {\n        if (timeoutTimer) clearTimeout(timeoutTimer);\n        if (stallTimer) clearInterval(stallTimer);\n        opts.signal?.removeEventListener(\"abort\", onAbort);\n      };\n\n      const onAbort = () => {\n        failAll(new DOMException(\"Stopped by user\", \"AbortError\"));\n        // failAll already rejects pending; mark settled\n        settled = true;\n        cleanup();\n      };\n\n      if (opts.signal) {\n        opts.signal.addEventListener(\"abort\", onAbort, { once: true });\n      }\n\n      // Timeout: regular Error so app can fall back to server (not AbortError)\n      timeoutTimer = setTimeout(() => {\n        const err = new Error(\n          \"Denoise timed out. Falling back or try bilateral / a smaller image.\"\n        );\n        err.code = \"DENOISE_TIMEOUT\";\n        failAll(err);\n        settled = true;\n        cleanup();\n      }, timeoutMs);\n\n      const started = Date.now();\n      _pending.set(id, {\n        resolve: (msg) => finish(resolve, msg),\n        reject: (err) => finish(reject, err),\n        onProgress: opts.onProgress,\n        lastProgressAt: Date.now(),\n      });\n\n      // Heartbeat only — do not kill the job here (timeout handles hard stop)\n      stallTimer = setInterval(() => {\n        const p = _pending.get(id);\n        if (!p) return;\n        const idle = Date.now() - (p.lastProgressAt || started);\n        if (idle > 12000) {\n          opts.onProgress?.(\n            Math.min(40, 8 + Math.floor(idle / 4000)),\n            idle > 40000\n              ? \"Still loading denoise engine… (first run downloads ~7MB)\"\n              : \"Working…\"\n          );\n          // Keep lastProgressAt so we don't spam; still allow timeout to fire\n        }\n      }, 2500);\n\n      try {\n        w.postMessage(\n          {\n            type: \"denoise\",\n            id,\n            buffer: transfer.buffer,\n            mime: transfer.mime,\n            fileBytes: transfer.fileBytes,\n            controls: controls || {},\n            maxProcessSide: opts.maxProcessSide || 1280,\n          },\n          [transfer.buffer]\n        );\n      } catch (e) {\n        finish(reject, e instanceof Error ? e : new Error(String(e)));\n      }\n    });\n\n    const jpegBlob = new Blob([result.jpeg], { type: \"image/jpeg\" });\n    return {\n      outputBlob: jpegBlob,\n      width: result.width,\n      height: result.height,\n      report: result.report,\n      engine: \"client-webworker\",\n      jpegBytes: result.jpegBytes,\n    };\n  }\n\n  /**\n   * @param {Blob|File} imageBlob\n   * @param {{ onProgress?: Function, signal?: AbortSignal, maxSide?: number }} [opts]\n   */\n  async function analyzeLocal(imageBlob, opts = {}) {\n    if (!imageBlob) throw new Error(\"No image to analyze.\");\n    if (opts.signal?.aborted) {\n      throw new DOMException(\"Stopped by user\", \"AbortError\");\n    }\n    const id = nextId();\n    const w = getWorker();\n    const transfer = await blobToTransfer(imageBlob);\n    const result = await new Promise((resolve, reject) => {\n      const onAbort = () => {\n        failAll(new DOMException(\"Stopped by user\", \"AbortError\"));\n      };\n      opts.signal?.addEventListener(\"abort\", onAbort, { once: true });\n      _pending.set(id, {\n        resolve: (msg) => {\n          opts.signal?.removeEventListener(\"abort\", onAbort);\n          _pending.delete(id);\n          resolve(msg);\n        },\n        reject: (err) => {\n          opts.signal?.removeEventListener(\"abort\", onAbort);\n          _pending.delete(id);\n          reject(err);\n        },\n        onProgress: opts.onProgress,\n        lastProgressAt: Date.now(),\n      });\n      w.postMessage(\n        {\n          type: \"analyze\",\n          id,\n          buffer: transfer.buffer,\n          mime: transfer.mime,\n          fileBytes: transfer.fileBytes,\n          maxSide: opts.maxSide || 1600,\n        },\n        [transfer.buffer]\n      );\n    });\n    return {\n      metrics: result.metrics,\n      width: result.width,\n      height: result.height,\n      engine: \"client-webworker\",\n    };\n  }\n\n  function isSupported() {\n    return typeof Worker !== \"undefined\" && typeof OffscreenCanvas !== \"undefined\";\n  }\n\n  function isBusy() {\n    return _pending.size > 0;\n  }\n\n  global.PEClientPipeline = {\n    denoiseLocal,\n    analyzeLocal,\n    isSupported,\n    cancelAll,\n    isBusy,\n    isAbortError,\n  };\n})(typeof window !== \"undefined\" ? window : globalThis);\n";

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
/** Long-running image denoise / analyze need more than the default proxy timeout. */
const ORIGIN_DENOISE_TIMEOUT_MS = 120000;
const ORIGIN_HEAVY_PATHS = ["/api/denoise", "/api/analyze", "/api/library"];

/** Paths that must ship from latest main even if Render deploy lags. */
const EDGE_STATIC_PREFIXES = [
  "/static/vendor/",
  "/static/js/denoise-worker.js",
  "/static/js/client-pipeline.js",
  "/static/js/app.js",
  "/static/js/tooltips.js",
  "/static/css/styles.css",
  "/static/index.html",
  "/static/login.html",
  "/static/invite.html",
  "/static/js/auth-pages.js",
  "/static/css/auth.css",
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

    // Broken Emscripten path: /static/js/ + /static/vendor/opencv.wasm
    // → /static/js//static/vendor/opencv.wasm (or /static/js/static/vendor/...)
    const fixedWasm = rewriteBrokenWasmPath(incoming.pathname);
    if (fixedWasm) {
      const edge = await serveEdgeStatic(fixedWasm, request);
      if (edge) return edge;
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
 * Emscripten worker bug: scriptDirectory (/static/js/) + absolute wasm path
 * produces /static/js//static/vendor/opencv.wasm. Map those back to the real asset.
 * @param {string} pathname
 * @returns {string|null} corrected pathname or null
 */
function rewriteBrokenWasmPath(pathname) {
  const path = pathname.split("?")[0].replace(/\/{2,}/g, "/");
  // /static/js/static/vendor/opencv.wasm  or  /static/js//static/vendor/...
  const m = path.match(/^\/static\/js\/(?:static\/)?vendor\/(opencv\.wasm|opencv\.js)$/);
  if (m) return `/static/vendor/${m[1]}`;
  // Also catch double-slash form before normalize if present in raw path
  if (pathname.includes("/static/js/") && pathname.includes("/static/vendor/opencv")) {
    if (pathname.includes("opencv.wasm")) return "/static/vendor/opencv.wasm";
    if (pathname.includes("opencv.js")) return "/static/vendor/opencv.js";
  }
  return null;
}

/**
 * Harden legacy denoise-worker builds that sync-XHR `./opencv.wasm` relative to
 * /static/js/ (404 JSON → WebAssembly magic error 7b226465).
 * @param {string} js
 */
function patchLegacyDenoiseWorker(js) {
  // Always ensure top-level importScripts race is gone
  js = js.replace(
    /\/\/ Preload OpenCV glue[\s\S]*?try \{\s*importScripts\("\/static\/vendor\/opencv\.js"\);\s*\} catch \(e\) \{\s*console\.error\("Failed to import OpenCV", e\);\s*\}/,
    "// OpenCV glue is loaded inside loadOpenCV after WASM bytes are validated."
  );

  // If already has timeout + instantiateWasm, leave loadOpenCV alone
  if (js.includes("fetchWithTimeout") && js.includes("instantiateWasm")) {
    return js;
  }

  // Replace loadOpenCV with hardened loader (absolute WASM + timeout + progress)
  const hardened = `
function loadOpenCV(onProgress) {
  if (_cvReady) {
    if (_cv && typeof _cv.bilateralFilter === "function") {
      if (onProgress) onProgress(35, "Denoise engine ready");
      return _cvReady;
    }
    return _cvReady.then(function (api) {
      if (onProgress) onProgress(35, "Denoise engine ready");
      return api;
    });
  }
  _cvReady = (async function () {
    if (_cv && typeof _cv.bilateralFilter === "function") return _cv;
    var WASM_URL = "/static/vendor/opencv.wasm";
    var JS_URL = "/static/vendor/opencv.js";
    var CDN = "https://cdn.jsdelivr.net/gh/orangefunguy/PhotoEditor@main/static/vendor/opencv.wasm";
    async function loadBytes(url, cred) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 45000);
      try {
        var res = await fetch(url, {
          credentials: cred || "omit",
          mode: url.indexOf("http") === 0 ? "cors" : "same-origin",
          signal: ctrl.signal
        });
        if (!res.ok) throw new Error("OpenCV WASM HTTP " + res.status + " at " + url);
        var bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length < 4 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
          var head = new TextDecoder().decode(bytes.slice(0, 40));
          throw new Error("OpenCV WASM magic invalid at " + url + ": " + head);
        }
        return bytes;
      } catch (e) {
        if (e && e.name === "AbortError") throw new Error("Timed out loading " + url);
        throw e;
      } finally { clearTimeout(timer); }
    }
    if (onProgress) onProgress(4, "Downloading denoise engine…");
    var wasmBinary;
    try { wasmBinary = await loadBytes(WASM_URL, "same-origin"); }
    catch (e1) {
      if (onProgress) onProgress(12, "Trying CDN backup…");
      wasmBinary = await loadBytes(CDN, "omit");
    }
    if (onProgress) onProgress(30, "Loading engine runtime…");
    if (typeof self.cv === "undefined") importScripts(JS_URL);
    var factory = self.cv;
    if (!factory) throw new Error("OpenCV factory missing");
    if (typeof factory.bilateralFilter === "function") { _cv = factory; return _cv; }
    if (typeof factory !== "function") throw new Error("Unexpected OpenCV export");
    if (onProgress) onProgress(32, "Compiling denoise engine (first time may take a bit)…");
    return await new Promise(function (resolve, reject) {
      var settled = false;
      function ok(api) {
        if (settled) return false;
        if (api && typeof api.bilateralFilter === "function") {
          settled = true; _cv = api; resolve(api); return true;
        }
        return false;
      }
      function fail(e) { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } }
      var moduleArg = {
        wasmBinary: wasmBinary,
        locateFile: function (path) {
          var s = String(path || "");
          if (s.indexOf("opencv.wasm") !== -1 || s.slice(-5) === ".wasm") return WASM_URL;
          if (s.indexOf("opencv.js") !== -1) return JS_URL;
          if (s.indexOf("://") !== -1 || s.charAt(0) === "/") return s;
          return "/static/vendor/" + s.replace(/^\\.\\//, "").split("/").pop();
        },
        instantiateWasm: function (info, receiveInstance) {
          try {
            var module = new WebAssembly.Module(wasmBinary);
            var instance = new WebAssembly.Instance(module, info);
            receiveInstance(instance, module);
            return instance.exports;
          } catch (e) { fail(e); return {}; }
        },
        onRuntimeInitialized: function () {
          if (!ok(moduleArg) && !ok(self.cv)) fail(new Error("OpenCV init missing bilateralFilter"));
        }
      };
      try {
        var ret = factory(moduleArg);
        if (ok(ret) || ok(moduleArg) || ok(self.cv)) return;
      } catch (e) { fail(e); return; }
      var n = 0;
      var t = setInterval(function () {
        n++;
        if (n % 50 === 0 && onProgress) onProgress(Math.min(34, 32 + n / 250), "Compiling denoise engine…");
        if (ok(self.cv) || ok(moduleArg)) { clearInterval(t); return; }
        if (n > 1000) { clearInterval(t); fail(new Error("OpenCV runtime init timeout")); }
      }, 20);
    });
  })().catch(function (err) { _cvReady = null; throw err; });
  return _cvReady;
}
`;

  if (/function loadOpenCV\s*\(/.test(js)) {
    // Match loadOpenCV() or loadOpenCV(onProgress) through return _cvReady;
    js = js.replace(
      /function loadOpenCV\s*\([^)]*\)\s*\{[\s\S]*?\n  return _cvReady;\n\}/,
      hardened.trim()
    );
  } else {
    js = hardened + "\n" + js;
  }

  // Ensure runDenoise passes progress into loadOpenCV (old bodies call loadOpenCV())
  js = js.replace(
    /progress\(id,\s*\d+,\s*"Loading high-quality denoise engine…"\);\s*(?:const|let|var) cv = await loadOpenCV\(\);/,
    `progress(id, 2, "Loading high-quality denoise engine…");
  const cv = await loadOpenCV(function (p, label) {
    progress(id, Math.max(2, Math.min(35, p || 2)), label || "Loading denoise engine…");
  });`
  );
  // Also catch bare loadOpenCV() right after engine label variants
  js = js.replace(
    /await loadOpenCV\(\);(\s*if \(!cv)/,
    `await loadOpenCV(function (p, label) {
    progress(id, Math.max(2, Math.min(35, p || 2)), label || "Loading denoise engine…");
  });$1`
  );
  // After engine load at ~35%, don't drop progress back to 4%
  js = js.replace(
    /progress\(id,\s*4,\s*"Preparing image…"\);/,
    'progress(id, 38, "Preparing image…");'
  );
  js = js.replace(
    /progress\(id,\s*8,\s*"Tuning filter strength…"\);/,
    'progress(id, 42, "Tuning filter strength…");'
  );

  // Kill pure-JS NLM (browser timeout). Use OpenCV bilateral hybrid instead.
  if (js.includes("nlmLumaMultiscale") && !js.includes("PE_FAST_HYBRID_V2")) {
    js = js.replace(
      /function nlmLuma\([\s\S]*?\nfunction nlmLumaMultiscale\([\s\S]*?\nfunction applyOpenCV\(/,
      `/* PE_FAST_HYBRID_V2: pure-JS NLM removed */
function applyHybridFast(cv, srcMat, dst, d, sc, ss, strengthBoost, onProgress) {
  onProgress && onProgress(15);
  var ycrcb = new cv.Mat();
  cv.cvtColor(srcMat, ycrcb, cv.COLOR_RGB2YCrCb);
  var channels = new cv.MatVector();
  cv.split(ycrcb, channels);
  var yMat = channels.get(0), crMat = channels.get(1), cbMat = channels.get(2);
  var yD = d + (strengthBoost ? 2 : 0); if (yD % 2 === 0) yD += 1;
  yD = Math.min(15, Math.max(3, yD));
  var yDst = new cv.Mat();
  onProgress && onProgress(35);
  cv.bilateralFilter(yMat, yDst, yD, sc * (strengthBoost ? 1.15 : 1), ss * (strengthBoost ? 1.1 : 1), cv.BORDER_DEFAULT);
  var yDst2 = new cv.Mat();
  onProgress && onProgress(55);
  if (strengthBoost || sc > 40) {
    var d2 = Math.max(3, (yD / 2) | 0); if (d2 % 2 === 0) d2 += 1;
    cv.bilateralFilter(yDst, yDst2, d2, sc * 0.65, ss * 0.65, cv.BORDER_DEFAULT);
  } else { yDst.copyTo(yDst2); }
  var crDst = new cv.Mat(), cbDst = new cv.Mat();
  onProgress && onProgress(70);
  cv.bilateralFilter(crMat, crDst, 5, Math.max(8, sc * 0.28), Math.max(3, ss * 0.35), cv.BORDER_DEFAULT);
  cv.bilateralFilter(cbMat, cbDst, 5, Math.max(8, sc * 0.28), Math.max(3, ss * 0.35), cv.BORDER_DEFAULT);
  var mergedCh = new cv.MatVector();
  mergedCh.push_back(yDst2); mergedCh.push_back(crDst); mergedCh.push_back(cbDst);
  var merged = new cv.Mat(); cv.merge(mergedCh, merged);
  var rgbFromY = new cv.Mat(); cv.cvtColor(merged, rgbFromY, cv.COLOR_YCrCb2RGB);
  onProgress && onProgress(88);
  var dFinish = Math.max(3, (d / 2) | 0); if (dFinish % 2 === 0) dFinish += 1;
  cv.bilateralFilter(rgbFromY, dst, dFinish, sc * 0.55, ss * 0.55, cv.BORDER_DEFAULT);
  ycrcb.delete(); channels.delete(); yMat.delete(); crMat.delete(); cbMat.delete();
  yDst.delete(); yDst2.delete(); crDst.delete(); cbDst.delete();
  mergedCh.delete(); merged.delete(); rgbFromY.delete();
  onProgress && onProgress(95);
}
function applyOpenCV(`
    );
    // Replace hybrid/nlm body to call applyHybridFast instead of nlmLumaMultiscale
    js = js.replace(
      /\/\/ hybrid \(default\) and nlm[\s\S]*?onProgress\?\.\(95\);\s*return dst;/,
      `// hybrid / nlm — PE_FAST_HYBRID_V2 (OpenCV bilateral, no pure-JS NLM)
  onProgress?.(8);
  if (algo === "nlm") {
    applyHybridFast(cv, srcMat, dst, d, sc * 1.2, ss * 1.15, true, onProgress);
  } else {
    applyHybridFast(cv, srcMat, dst, d, sc, ss, false, onProgress);
  }
  onProgress?.(92);
  if (blend < 0.999) {
    const blended = new cv.Mat();
    const a = new cv.Mat();
    const b = new cv.Mat();
    dst.convertTo(a, cv.CV_32FC3, blend, 0);
    srcMat.convertTo(b, cv.CV_32FC3, 1 - blend, 0);
    cv.add(a, b, blended);
    blended.convertTo(dst, cv.CV_8UC3);
    a.delete(); b.delete(); blended.delete();
  }
  onProgress?.(95);
  return dst;`
    );
    // Cap default process side
    js = js.replace(/maxProcessSide \|\| 3600/g, "maxProcessSide || 1280");
    js = js.replace(/maxProcessSide \|\| 2400/g, "maxProcessSide || 1280");
    js = js.replace(/maxProcessSide \|\| 1600/g, "maxProcessSide || 1280");
  }

  // CRITICAL: ping must not await loadOpenCV — that blocks the denoise queue
  js = js.replace(
    /else if \(msg\.type === "ping"\) \{[\s\S]*?\} else throw new Error/,
    `else if (msg.type === "ping") {
      self.postMessage({
        type: "pong",
        id: msg.id,
        opencv: !!(_cv && typeof _cv.bilateralFilter === "function"),
      });
    } else throw new Error`
  );
  return js;
}

/**
 * Always replace PEClientPipeline with a known-good implementation.
 * Old edge patches left warm-ping + AbortError timeouts that skipped server fallback.
 */
function patchClientPipeline(js) {
  // Strip any warm ping that loads OpenCV
  js = js.replace(
    /\/\/ Soft warm[\s\S]*?setTimeout\(\(\) => \{\s*if \(_pending\.has\(warmId\)\) _pending\.delete\(warmId\);\s*\}, 90000\);/g,
    "// no warm ping"
  );
  js = js.replace(
    /\/\/ Warm OpenCV[\s\S]*?_worker\.postMessage\(\{ type: "ping"[\s\S]*?\}\);/g,
    "// no warm ping"
  );
  js = js.replace(
    /const warmId = nextId\(\);[\s\S]*?_worker\.postMessage\(\{\s*type: "ping"[\s\S]*?\}\);[\s\S]*?return _worker;/g,
    "return _worker;"
  );

  // Timeout must reject with Error (not AbortError via cancelAll)
  js = js.replace(
    /cancelAll\(["']Denoise timed out["']\);\s*(?:finish\()?\s*reject\(\s*new (?:DOMException|Error)\([^)]*\)\s*\)?/g,
    `var __to = new Error("Denoise timed out. Falling back or try bilateral / smaller image.");
        __to.code = "DENOISE_TIMEOUT";
        if (_worker) { try { _worker.terminate(); } catch(e){} _worker = null; }
        _pending.forEach(function(p){ try { p.reject(__to); } catch(e){} });
        _pending.clear();
        reject(__to)`
  );

  // Fix isAbortError so timeouts are not treated as user cancel
  if (js.includes("function isAbortError")) {
    js = js.replace(
      /function isAbortError\([^)]*\)\s*\{[\s\S]*?\n  \}/,
      `function isAbortError(e) {
    if (!e) return false;
    if (e.name === "AbortError") {
      var msg = String(e.message || "");
      return /stop|cancel|abort/i.test(msg) && !/timed?\\s*out|stall/i.test(msg);
    }
    return /stopped by user|user cancel/i.test(String(e.message || e));
  }`
    );
  } else {
    js = js.replace(
      /function isSupported\(\)/,
      `function cancelAll(reason) {
    var err = new DOMException(reason || "Stopped by user", "AbortError");
    if (_worker) { try { _worker.terminate(); } catch (e) {} _worker = null; }
    _pending.forEach(function (p) { try { p.reject(err); } catch (e) {} });
    _pending.clear();
    return err;
  }
  function isBusy() { return _pending.size > 0; }
  function isAbortError(e) {
    if (!e) return false;
    if (e.name === "AbortError") {
      var msg = String(e.message || "");
      return /stop|cancel|abort/i.test(msg) && !/timed?\\s*out|stall/i.test(msg);
    }
    return /stopped by user|user cancel/i.test(String(e.message || e));
  }
  function isSupported()`
    );
    js = js.replace(
      /global\.PEClientPipeline = \{[\s\S]*?\};/,
      `global.PEClientPipeline = {
    denoiseLocal, analyzeLocal, isSupported, cancelAll, isBusy, isAbortError,
  };`
    );
  }

  // Prefer shorter timeout + smaller side when still using old denoiseLocal
  js = js.replace(/timeoutMs \|\| 180000/g, "timeoutMs || 120000");
  js = js.replace(/timeoutMs: 180000/g, "timeoutMs: 120000");
  js = js.replace(/maxProcessSide \|\| 3600/g, "maxProcessSide || 1280");
  js = js.replace(/maxProcessSide \|\| 2400/g, "maxProcessSide || 1280");
  js = js.replace(/maxProcessSide \|\| 1600/g, "maxProcessSide || 1280");
  return js;
}

/** Patch app.js so local-* jobs never hit /api/jobs and progress isn't stuck at 8%. */
function patchAppJs(js) {
  if (!js.includes("function isServerJobId") && js.includes("rehydrateStepFromServer")) {
    js = js.replace(
      /async function rehydrateStepFromServer\(step\) \{/,
      `function isServerJobId(jobId) {
    if (!jobId) return false;
    const id = String(jobId);
    return !id.startsWith("local-") && !id.startsWith("cached-");
  }

  async function rehydrateStepFromServer(step) {`
    );
    js = js.replace(
      /async function rehydrateStepFromServer\(step\) \{\s*if \(!step\) return step;\s*const next = \{ \.\.\.step \};\s*if \(!isUsableBlob\(next\.sourceBlob\) && next\.jobId\) \{/,
      `async function rehydrateStepFromServer(step) {
    if (!step) return step;
    const next = { ...step };
    if (!isServerJobId(next.jobId)) return next;
    if (!isUsableBlob(next.sourceBlob) && next.jobId) {`
    );
  }
  // Session restore: skip local job endpoints
  js = js.replace(
    /if \(!sourceBlob && sess\.jobId\) \{\s*sourceBlob = await Store\.blobFromUrl\(`\/api\/jobs\/\$\{sess\.jobId\}\/source`\);/,
    "if (!sourceBlob && isServerJobId(sess.jobId)) {\n          sourceBlob = await Store.blobFromUrl(`/api/jobs/${sess.jobId}/source`);"
  );
  js = js.replace(
    /if \(!outputBlob && sess\.jobId\) \{\s*outputBlob = await Store\.blobFromUrl\(`\/api\/jobs\/\$\{sess\.jobId\}\/output`\);/,
    "if (!outputBlob && isServerJobId(sess.jobId)) {\n          outputBlob = await Store.blobFromUrl(`/api/jobs/${sess.jobId}/output`);"
  );
  // Progress: don't freeze at 8% during engine load
  js = js.replace(
    /setProgressUI\(8,\s*"Using this device['’]s CPU…"\);/,
    'setProgressUI(3, "Starting denoise engine on this device…");'
  );
  js = js.replace(
    /onProgress:\s*\(pct,\s*label\)\s*=>\s*\{\s*setProgressUI\(Math\.max\(_progressValue,\s*pct\s*\|\|\s*0\),\s*label\s*\|\|\s*"Denoising…"\);\s*\}/,
    `onProgress: (pct, label) => {
            const raw = Math.max(0, Math.min(100, Number(pct) || 0));
            const mapped = 3 + (raw / 100) * 90;
            setProgressUI(mapped, label || "Denoising…");
          }`
  );

  // Always ensure Stop UI + cancel wiring (works even if origin HTML is stale)
  if (!js.includes("PE_STOP_WIRED_V1")) {
    js += `
;(function () {
  /* PE_STOP_WIRED_V1 */
  function ensureStopButtons() {
    function makeBtn(id, label, extraStyle) {
      var existing = document.getElementById(id);
      if (existing) return existing;
      var b = document.createElement("button");
      b.type = "button";
      b.id = id;
      b.className = "btn";
      b.hidden = true;
      b.textContent = label;
      b.title = "Stop filter";
      b.style.cssText = "border-color:rgba(243,18,96,.55);color:#ffb4c8;background:rgba(243,18,96,.12);font-weight:600;" + (extraStyle || "");
      return b;
    }
    var denoise = document.getElementById("btnDenoise");
    if (denoise && denoise.parentElement && !document.getElementById("btnStopApply")) {
      var row = document.createElement("div");
      row.className = "btn-row";
      row.style.marginTop = "0.45rem";
      row.appendChild(makeBtn("btnStopApply", "Stop filter", "width:100%"));
      denoise.parentElement.insertAdjacentElement("afterend", row);
    }
    var prog = document.getElementById("applyProgress");
    if (prog && !document.getElementById("btnStopApplyInline")) {
      prog.appendChild(makeBtn("btnStopApplyInline", "Stop filter", "width:100%;margin-top:0.5rem"));
    }
    var card = document.querySelector(".preview-processing-card");
    if (card && !document.getElementById("btnStopApplyOverlay")) {
      card.appendChild(makeBtn("btnStopApplyOverlay", "Stop", "margin-top:0.75rem;min-width:6rem"));
    }
  }
  function setStopVisible(show) {
    ["btnStopApply", "btnStopApplyInline", "btnStopApplyOverlay"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.hidden = !show;
      btn.disabled = !show;
    });
  }
  function doCancel() {
    var Pipeline = window.PEClientPipeline;
    if (Pipeline && Pipeline.cancelAll) Pipeline.cancelAll("Stopped by user");
    setStopVisible(false);
    var denoise = document.getElementById("btnDenoise");
    if (denoise) {
      denoise.disabled = false;
      denoise.classList.remove("is-processing");
      if (denoise.dataset.idleLabel) denoise.innerHTML = denoise.dataset.idleLabel;
    }
    var ap = document.getElementById("applyProgress");
    var pp = document.getElementById("previewProcessing");
    if (ap) ap.hidden = true;
    if (pp) pp.hidden = true;
    if (typeof setStatus === "function") setStatus("Filter stopped. Adjust settings and click Apply when ready.");
  }
  function wireStop() {
    ensureStopButtons();
    ["btnStopApply", "btnStopApplyInline", "btnStopApplyOverlay"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn || btn.dataset.peStopWired) return;
      btn.dataset.peStopWired = "1";
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        doCancel();
      });
    });
  }
  // Show Stop while Apply is in processing state
  var obs = new MutationObserver(function () {
    var denoise = document.getElementById("btnDenoise");
    var busy = denoise && denoise.classList.contains("is-processing");
    if (busy) {
      ensureStopButtons();
      setStopVisible(true);
    }
  });
  function startObs() {
    wireStop();
    var denoise = document.getElementById("btnDenoise");
    if (denoise) obs.observe(denoise, { attributes: true, attributeFilter: ["class"] });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startObs);
  else startObs();
  setTimeout(startObs, 300);
  setTimeout(startObs, 1500);
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var denoise = document.getElementById("btnDenoise");
    if (denoise && denoise.classList.contains("is-processing")) {
      e.preventDefault();
      doCancel();
    }
  });
})();
`;
  }

  // Ensure denoiseLocal gets signal + timeout + SERVER FALLBACK on failure
  if (!js.includes("denoiseOnServer") && js.includes("denoiseLocal(sourceBlob")) {
    js = js.replace(
      /const result = await Pipeline\.denoiseLocal\(sourceBlob, controls, \{[\s\S]*?\}\);\s*outputBlob = result\.outputBlob;\s*report = result\.report;/,
      `async function denoiseOnServer(label) {
          setProgressUI(25, label || "Using server denoise…");
          var fd = new FormData();
          fd.append("file", sourceBlob, state.filename || "image.jpg");
          fd.append("controls_json", JSON.stringify(controls));
          var r = await fetch("/api/denoise", { method: "POST", body: fd, credentials: "same-origin" });
          if (!r.ok) {
            var err = await r.json().catch(function(){ return {}; });
            throw new Error(typeof err.detail === "string" ? err.detail : r.statusText);
          }
          var data = await r.json();
          if (data.job_id) state.jobId = data.job_id;
          var blob = Store ? await Store.blobFromUrl(data.output_url) : null;
          if (!blob) {
            var br = await fetch(data.output_url, { credentials: "same-origin" });
            blob = await br.blob();
          }
          return { outputBlob: blob, report: data.report };
        }
        var __peAbort = (typeof AbortController !== "undefined") ? new AbortController() : null;
        window.__peApplyAbort = __peAbort;
        var result;
        try {
          result = await Pipeline.denoiseLocal(sourceBlob, controls, {
            signal: __peAbort && __peAbort.signal,
            timeoutMs: 120000,
            onProgress: function(pct, label) {
              var raw = Math.max(0, Math.min(100, Number(pct) || 0));
              setProgressUI(3 + (raw / 100) * 90, label || "Denoising…");
            },
            maxProcessSide: 1280,
          });
        } catch (localErr) {
          var msg = String(localErr && localErr.message || localErr || "");
          var userStop = localErr && localErr.name === "AbortError" && /stop|cancel/i.test(msg) && !/timed?\\s*out/i.test(msg);
          if (userStop) throw localErr;
          console.warn("Local denoise failed, server fallback", localErr);
          setStatus("Local engine issue — switching to server…", "busy");
          result = await denoiseOnServer("Using server denoise…");
        }
        outputBlob = result.outputBlob;
        report = result.report;`
    );
  }

  // Top status bar progress (if origin app.js is stale)
  if (!js.includes("topStatusBar") && !js.includes("TOP_STATUS_SHIM_V1")) {
    js += `
;(function(){
  /* TOP_STATUS_SHIM_V1 */
  function ensureTopBar(){
    if (document.getElementById("topStatusBar")) return;
    var bar=document.createElement("div");
    bar.className="top-status-bar"; bar.id="topStatusBar";
    bar.innerHTML='<div class="top-status-main"><span class="top-status-spinner" id="topStatusSpinner" hidden></span><span class="top-status-text" id="topStatusText">Ready</span></div><div class="top-status-progress" id="topStatusProgress" hidden><div class="top-status-track" id="topStatusTrack" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="top-status-fill" id="topStatusFill"></div></div><span class="top-status-pct" id="topStatusPct">0%</span><button type="button" class="btn btn-stop top-status-stop" id="btnStopApplyTop" hidden>Stop</button></div>';
    var main=document.querySelector("main.app-shell");
    if (main) main.parentNode.insertBefore(bar, main);
    else document.body.insertBefore(bar, document.body.firstChild);
  }
  var _origSetProgress = null;
  function wire(){
    ensureTopBar();
    // Hide floating preview processing if shown
    var pp=document.getElementById("previewProcessing");
    if (pp) { pp.hidden=true; pp.style.display="none"; }
    var ap=document.getElementById("applyProgress");
    if (ap) { ap.hidden=true; }
    // Patch setProgressUI if exists in closure — observe Apply button class
    var denoise=document.getElementById("btnDenoise");
    if (denoise && !denoise.dataset.topProgObs) {
      denoise.dataset.topProgObs="1";
      new MutationObserver(function(){
        ensureTopBar();
        var busy=denoise.classList.contains("is-processing");
        var prog=document.getElementById("topStatusProgress");
        var spin=document.getElementById("topStatusSpinner");
        var stop=document.getElementById("btnStopApplyTop");
        if (prog) prog.hidden=!busy;
        if (spin) spin.hidden=!busy;
        if (stop) { stop.hidden=!busy; stop.disabled=!busy; }
        if (pp) { pp.hidden=true; pp.style.display="none"; }
      }).observe(denoise,{attributes:true,attributeFilter:["class"]});
    }
    var stop=document.getElementById("btnStopApplyTop");
    if (stop && !stop.dataset.wired) {
      stop.dataset.wired="1";
      stop.addEventListener("click", function(e){
        e.preventDefault();
        if (window.PEClientPipeline && window.PEClientPipeline.cancelAll) window.PEClientPipeline.cancelAll("Stopped by user");
        var d=document.getElementById("btnDenoise");
        if (d) { d.classList.remove("is-processing"); d.disabled=false; if (d.dataset.idleLabel) d.innerHTML=d.dataset.idleLabel; }
        var prog=document.getElementById("topStatusProgress");
        if (prog) prog.hidden=true;
      });
    }
    // Mirror left status text to top
    var st=document.getElementById("statusText");
    var tt=document.getElementById("topStatusText");
    if (st && tt && !st.dataset.topMirror) {
      st.dataset.topMirror="1";
      new MutationObserver(function(){ tt.textContent=st.textContent; }).observe(st,{childList:true,characterData:true,subtree:true});
    }
    // Mirror apply progress fill if present
    var fill=document.getElementById("applyProgressFill") || document.getElementById("previewProcessingFill");
    var topFill=document.getElementById("topStatusFill");
    var topPct=document.getElementById("topStatusPct");
    if (fill && topFill && !fill.dataset.topMirror) {
      fill.dataset.topMirror="1";
      new MutationObserver(function(){
        topFill.style.width=fill.style.width||"0%";
        if (topPct) topPct.textContent=fill.style.width||"0%";
        var prog=document.getElementById("topStatusProgress");
        if (prog && fill.style.width && fill.style.width!=="0%") prog.hidden=false;
      }).observe(fill,{attributes:true,attributeFilter:["style"]});
    }
  }
  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
  setTimeout(wire, 200);
  setTimeout(wire, 1000);
})();
`;
  }

  return js;
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
    // Build clean response headers (do not forward jsDelivr etag/age — those
    // cause CDNs to treat patched bodies as identical to upstream).
    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("X-PE-Edge", "1");
    if (rel.endsWith(".wasm")) {
      headers.set("Content-Type", "application/wasm");
      headers.set("Cache-Control", "public, max-age=300, must-revalidate");
      // Validate wasm magic so we never serve a JSON error body as WASM
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      if (
        u8.length < 4 ||
        u8[0] !== 0x00 ||
        u8[1] !== 0x61 ||
        u8[2] !== 0x73 ||
        u8[3] !== 0x6d
      ) {
        return null; // fall through to origin
      }
      headers.set("Content-Length", String(u8.byteLength));
      return new Response(buf, { status: 200, headers });
    } else if (rel.endsWith(".js")) {
      headers.set("Content-Type", "application/javascript; charset=utf-8");
      // Denoise worker must not be cached stale — it carries the WASM load fix
      const isDenoiseWorker = rel.includes("denoise-worker.js");
      const isOpencvJs =
        rel.endsWith("/opencv.js") || rel === "/static/vendor/opencv.js";
      headers.set(
        "Cache-Control",
        isDenoiseWorker || isOpencvJs
          ? "no-store, must-revalidate"
          : "public, max-age=60, must-revalidate"
      );
      let js = await res.text();
      // Pin OpenCV wasm path + fix locateFile so absolute paths are not joined
      // with scriptDirectory (/static/js/ + /static/vendor/... = broken double path).
      if (isOpencvJs) {
        js = js.replace(
          /let opencvWasmBinaryFile\s*=\s*['"][^'"]+['"]/,
          "let opencvWasmBinaryFile = '/static/vendor/opencv.wasm'"
        );
        // Replace default locateFile body (idempotent if already patched)
        if (!js.includes("Absolute URLs/paths must not be joined")) {
          js = js.replace(
            /function locateFile\(path\) \{\s*if \(Module\["locateFile"\]\) \{\s*return Module\["locateFile"\]\(path, scriptDirectory\)\s*\}\s*return scriptDirectory \+ path\s*\}/,
            `function locateFile(path) {
                    if (Module["locateFile"]) {
                        return Module["locateFile"](path, scriptDirectory)
                    }
                    // Absolute URLs/paths must not be joined with scriptDirectory.
                    if (path && (path.indexOf("://") !== -1 || path.charAt(0) === "/")) {
                        return path
                    }
                    return scriptDirectory + path
                }`
          );
        }
        headers.set("X-PE-Edge", "opencv-js-locatefile-v3");
      }
      // Harden denoise worker even when GitHub main still has the old loader
      if (isDenoiseWorker) {
        js = patchLegacyDenoiseWorker(js);
        headers.set(
          "X-PE-Edge",
          js.includes("fetchWithTimeout") || js.includes("Timed out loading")
            ? "denoise-patched-v4"
            : js.includes("instantiateWasm")
              ? "denoise-patched-v3"
              : "denoise-unpatched"
        );
      }
      // Patch app.js for local-job 404s + progress mapping + Stop (until GitHub main catches up)
      if (rel.includes("/app.js") || rel.endsWith("app.js")) {
        js = patchAppJs(js);
        headers.set("X-PE-Edge", "app-patched-v5");
        headers.set("Cache-Control", "no-store, must-revalidate");
      }
      if (rel.includes("client-pipeline.js")) {
        // Always serve the known-good pipeline (GitHub main may be stale)
        if (typeof EMBEDDED_CLIENT_PIPELINE === "string" && EMBEDDED_CLIENT_PIPELINE.length > 100) {
          js = EMBEDDED_CLIENT_PIPELINE;
          headers.set("X-PE-Edge", "pipeline-embedded-v1");
        } else {
          js = patchClientPipeline(js);
          headers.set("X-PE-Edge", "pipeline-patched");
        }
        headers.set("Cache-Control", "no-store, must-revalidate");
      }
      return new Response(js, { status: 200, headers });
    } else if (rel.endsWith(".html")) {
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "no-store");
    } else {
      headers.set("Cache-Control", "public, max-age=60, must-revalidate");
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
      '$1\n    <script src="/static/js/client-pipeline.js?v=20260717m"></script>'
    );
  }
  // Force latest asset versions (bump when pipeline / wasm load path changes)
  html = html.replace(
    /(\/static\/js\/(?:app|client-pipeline|denoise-worker|tooltips|store|activity-log)\.js)\?v=[^"]+/g,
    "$1?v=20260717m"
  );
  html = html.replace(
    /(\/static\/css\/styles\.css)\?v=[^"]+/g,
    "$1?v=20260717m"
  );
  // Inject Stop control if origin HTML is stale
  if (!html.includes("btnStopApply")) {
    html = html.replace(
      /(<button[^>]*id="btnDenoise"[^>]*>[\s\S]*?<\/button>\s*<\/div>)/,
      `$1
          <div class="btn-row" style="grid-template-columns:1fr;margin-top:0.45rem">
            <button type="button" class="btn" id="btnStopApply" hidden title="Stop filter"
              style="border-color:rgba(243,18,96,.55);color:#ffb4c8;background:rgba(243,18,96,.12);font-weight:600">
              Stop filter
            </button>
          </div>`
    );
    // Also place a stop control inside apply-progress if present
    if (html.includes("applyProgress") && !html.includes("btnStopApplyInline")) {
      html = html.replace(
        /(<div class="apply-progress"[^>]*id="applyProgress"[^>]*>)/,
        `$1
            <button type="button" class="btn" id="btnStopApplyInline" hidden
              style="width:100%;margin-top:0.5rem;border-color:rgba(243,18,96,.55);color:#ffb4c8;background:rgba(243,18,96,.12)">Stop filter</button>`
      );
    }
  }
  // Favicon so DevTools is quiet
  if (!html.includes('rel="icon"')) {
    html = html.replace(
      "</head>",
      `    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%236ea8fe'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-size='14' font-family='system-ui' fill='%23061018' font-weight='700'%3EPE%3C/text%3E%3C/svg%3E" />\n  </head>`
    );
  }
  // Top status bar: progress at top of page (no mid-preview floating card)
  if (!html.includes("topStatusBar")) {
    const topBar = `
    <div class="top-status-bar" id="topStatusBar" aria-live="polite">
      <div class="top-status-main">
        <span class="top-status-spinner" id="topStatusSpinner" hidden></span>
        <span class="top-status-text" id="topStatusText">Ready</span>
      </div>
      <div class="top-status-progress" id="topStatusProgress" hidden>
        <div class="top-status-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="topStatusTrack">
          <div class="top-status-fill" id="topStatusFill"></div>
        </div>
        <span class="top-status-pct" id="topStatusPct">0%</span>
        <button type="button" class="btn btn-stop top-status-stop" id="btnStopApplyTop" hidden title="Stop filter">Stop</button>
      </div>
    </div>
`;
    if (html.includes('<main class="app-shell">')) {
      html = html.replace('<main class="app-shell">', topBar + '\n    <main class="app-shell">');
    } else if (html.includes("<main")) {
      html = html.replace(/<main/, topBar + "\n    <main");
    }
  }
  if (!html.includes("PE_TOP_STATUS_CSS")) {
    html = html.replace(
      "</head>",
      `<style id="pe-top-status-css">/* PE_TOP_STATUS_CSS */
.top-status-bar{position:sticky;top:64px;z-index:45;display:flex;align-items:center;justify-content:space-between;gap:.85rem 1.25rem;flex-wrap:wrap;min-height:40px;padding:.45rem 1.25rem;border-bottom:1px solid #222833;background:rgba(14,17,24,.94);backdrop-filter:blur(10px)}
.top-status-main{display:flex;align-items:center;gap:.55rem;min-width:0;flex:1 1 200px}
.top-status-spinner{width:12px;height:12px;border:2px solid #2a3140;border-top-color:#6ea8fe;border-radius:50%;animation:peSpin .7s linear infinite}
.top-status-spinner[hidden]{display:none!important}
.top-status-text{font-size:.84rem;color:#e8ecf4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top-status-bar.is-busy .top-status-text{color:#6ea8fe}
.top-status-bar.is-error .top-status-text{color:#f31260}
.top-status-progress{display:flex;align-items:center;gap:.55rem;flex:1 1 280px;max-width:min(560px,100%);min-width:0}
.top-status-progress[hidden]{display:none!important}
.top-status-track{flex:1;min-width:80px;height:8px;border-radius:999px;background:rgba(0,0,0,.4);border:1px solid #222833;overflow:hidden}
.top-status-fill{height:100%;width:0%;border-radius:inherit;background:linear-gradient(90deg,#4d8ef7,#6ea8fe,#a78bfa);transition:width .2s ease-out}
.top-status-pct{font-family:ui-monospace,monospace;font-size:.78rem;font-weight:600;color:#6ea8fe;min-width:2.6rem;text-align:right}
.top-status-stop{flex-shrink:0;padding:.3rem .7rem;font-size:.78rem;min-width:3.6rem;border-color:rgba(243,18,96,.55);color:#ffb4c8;background:rgba(243,18,96,.12);font-weight:600;cursor:pointer}
.preview-processing{display:none!important}
@keyframes peSpin{to{transform:rotate(360deg)}}
</style>
  </head>`
    );
  }
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

  const pathOnly = incoming.pathname.split("?")[0];
  const isHeavy =
    request.method === "POST" &&
    ORIGIN_HEAVY_PATHS.some((p) => pathOnly === p || pathOnly.startsWith(p + "/"));
  // Denoise of even a compressed image can exceed 18s on free-tier cold starts
  const attemptTimeoutMs = isHeavy ? ORIGIN_DENOISE_TIMEOUT_MS : ORIGIN_ATTEMPT_TIMEOUT_MS;
  // Fewer retries on huge buffered bodies to stay under Worker CPU/time limits
  const maxAttempts = isHeavy ? 2 : ORIGIN_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
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
      if (shouldRetryOrigin(response.status) && attempt < maxAttempts) {
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
      if (attempt < maxAttempts) {
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

  // Preserve Set-Cookie correctly (Headers() can fold/drop cookies in Workers).
  // Critical for mobile Safari/Chrome login sessions through the edge proxy.
  try {
    if (typeof response.headers.getSetCookie === "function") {
      const cookies = response.headers.getSetCookie();
      if (cookies && cookies.length) {
        outHeaders.delete("set-cookie");
        for (const c of cookies) {
          // Force cookie host to the public edge host (no Domain=render host)
          let fixed = c;
          fixed = fixed.replace(/;\s*Domain=[^;]*/gi, "");
          outHeaders.append("Set-Cookie", fixed);
        }
      }
    }
  } catch {
    /* leave cookies as copied */
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
