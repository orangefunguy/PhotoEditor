/**
 * PhotoEditor client pipeline — local denoise / analyze via Web Worker.
 *
 * Important: do NOT warm-load OpenCV on a separate "ping" job. Workers are
 * single-threaded; a hung WASM compile would block denoise until the client
 * times out. OpenCV loads inside the denoise/analyze job with progress.
 */
(function (global) {
  "use strict";

  let _worker = null;
  let _seq = 0;
  /** @type {Map<string, {resolve:Function, reject:Function, onProgress?:Function, lastProgressAt:number}>} */
  const _pending = new Map();

  function workerUrl() {
    const scripts = document.querySelectorAll("script[src*='client-pipeline']");
    const src = scripts[scripts.length - 1]?.getAttribute("src") || "";
    const q = src.includes("?") ? src.slice(src.indexOf("?")) : "";
    // Always bust denoise-worker cache when pipeline version changes
    return `/static/js/denoise-worker.js${q || "?v=local"}`;
  }

  function rejectAllPending(err) {
    for (const [, p] of _pending) {
      try {
        p.reject(err);
      } catch {
        /* ignore */
      }
    }
    _pending.clear();
  }

  /**
   * Terminate worker and fail pending jobs.
   * @param {Error|DOMException} err
   */
  function failAll(err) {
    if (_worker) {
      try {
        _worker.terminate();
      } catch {
        /* ignore */
      }
      _worker = null;
    }
    rejectAllPending(err);
    return err;
  }

  /** User-initiated stop */
  function cancelAll(reason) {
    return failAll(new DOMException(reason || "Stopped by user", "AbortError"));
  }

  function getWorker() {
    if (_worker) return _worker;
    _worker = new Worker(workerUrl());
    _worker.onmessage = (ev) => {
      const msg = ev.data || {};
      const p = _pending.get(msg.id);
      if (!p) return;
      if (msg.type === "progress") {
        p.onProgress?.(msg.pct, msg.label);
        p.lastProgressAt = Date.now();
        return;
      }
      if (msg.type === "error") {
        _pending.delete(msg.id);
        p.reject(new Error(msg.message || "Local processing failed"));
        return;
      }
      if (msg.type === "result" || msg.type === "analyze_result") {
        _pending.delete(msg.id);
        p.resolve(msg);
        return;
      }
      if (msg.type === "pong") {
        _pending.delete(msg.id);
        p.resolve(msg);
      }
    };
    _worker.onerror = (e) => {
      console.error("Denoise worker error", e);
      failAll(new Error(e.message || "Worker crashed"));
    };
    _worker.onmessageerror = () => {
      failAll(new Error("Worker message error"));
    };
    // No warm ping — it blocked the single worker thread behind OpenCV load.
    return _worker;
  }

  function nextId() {
    _seq += 1;
    return `pe-${Date.now().toString(36)}-${_seq}`;
  }

  async function blobToTransfer(blob) {
    const buffer = await blob.arrayBuffer();
    return {
      buffer,
      mime: blob.type || "application/octet-stream",
      fileBytes: blob.size,
    };
  }

  function isAbortError(e) {
    if (!e) return false;
    if (e.name === "AbortError") {
      // Only treat explicit user stop as abort — not timeouts mislabeled AbortError
      const msg = String(e.message || "");
      return /stop|cancel|abort/i.test(msg) && !/timed?\s*out|stall/i.test(msg);
    }
    return /stopped by user|user cancel/i.test(String(e.message || e));
  }

  /**
   * @param {Blob|File} imageBlob
   * @param {object} controls
   * @param {{
   *   onProgress?: (pct:number, label?:string)=>void,
   *   maxProcessSide?: number,
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   * }} [opts]
   */
  async function denoiseLocal(imageBlob, controls, opts = {}) {
    if (!imageBlob) throw new Error("No image to process.");
    if (opts.signal?.aborted) {
      throw new DOMException("Stopped by user", "AbortError");
    }

    const id = nextId();
    const w = getWorker();
    const transfer = await blobToTransfer(imageBlob);
    // First OpenCV compile can be slow; allow 2 min. Pure filter should be <30s.
    const timeoutMs = opts.timeoutMs || 120000;

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        cleanup();
        _pending.delete(id);
        fn(arg);
      };

      let timeoutTimer = null;
      let stallTimer = null;

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (stallTimer) clearInterval(stallTimer);
        opts.signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        failAll(new DOMException("Stopped by user", "AbortError"));
        // failAll already rejects pending; mark settled
        settled = true;
        cleanup();
      };

      if (opts.signal) {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Timeout: regular Error so app can fall back to server (not AbortError)
      timeoutTimer = setTimeout(() => {
        const err = new Error(
          "Denoise timed out. Falling back or try bilateral / a smaller image."
        );
        err.code = "DENOISE_TIMEOUT";
        failAll(err);
        settled = true;
        cleanup();
      }, timeoutMs);

      const started = Date.now();
      _pending.set(id, {
        resolve: (msg) => finish(resolve, msg),
        reject: (err) => finish(reject, err),
        onProgress: opts.onProgress,
        lastProgressAt: Date.now(),
      });

      // Heartbeat only — do not kill the job here (timeout handles hard stop)
      stallTimer = setInterval(() => {
        const p = _pending.get(id);
        if (!p) return;
        const idle = Date.now() - (p.lastProgressAt || started);
        if (idle > 12000) {
          opts.onProgress?.(
            Math.min(40, 8 + Math.floor(idle / 4000)),
            idle > 40000
              ? "Still loading denoise engine… (first run downloads ~7MB)"
              : "Working…"
          );
          // Keep lastProgressAt so we don't spam; still allow timeout to fire
        }
      }, 2500);

      try {
        w.postMessage(
          {
            type: "denoise",
            id,
            buffer: transfer.buffer,
            mime: transfer.mime,
            fileBytes: transfer.fileBytes,
            controls: controls || {},
            maxProcessSide: opts.maxProcessSide || 1280,
          },
          [transfer.buffer]
        );
      } catch (e) {
        finish(reject, e instanceof Error ? e : new Error(String(e)));
      }
    });

    const jpegBlob = new Blob([result.jpeg], { type: "image/jpeg" });
    return {
      outputBlob: jpegBlob,
      width: result.width,
      height: result.height,
      report: result.report,
      engine: "client-webworker",
      jpegBytes: result.jpegBytes,
    };
  }

  /**
   * @param {Blob|File} imageBlob
   * @param {{ onProgress?: Function, signal?: AbortSignal, maxSide?: number }} [opts]
   */
  async function analyzeLocal(imageBlob, opts = {}) {
    if (!imageBlob) throw new Error("No image to analyze.");
    if (opts.signal?.aborted) {
      throw new DOMException("Stopped by user", "AbortError");
    }
    const id = nextId();
    const w = getWorker();
    const transfer = await blobToTransfer(imageBlob);
    const result = await new Promise((resolve, reject) => {
      const onAbort = () => {
        failAll(new DOMException("Stopped by user", "AbortError"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      _pending.set(id, {
        resolve: (msg) => {
          opts.signal?.removeEventListener("abort", onAbort);
          _pending.delete(id);
          resolve(msg);
        },
        reject: (err) => {
          opts.signal?.removeEventListener("abort", onAbort);
          _pending.delete(id);
          reject(err);
        },
        onProgress: opts.onProgress,
        lastProgressAt: Date.now(),
      });
      w.postMessage(
        {
          type: "analyze",
          id,
          buffer: transfer.buffer,
          mime: transfer.mime,
          fileBytes: transfer.fileBytes,
          maxSide: opts.maxSide || 1600,
        },
        [transfer.buffer]
      );
    });
    return {
      metrics: result.metrics,
      width: result.width,
      height: result.height,
      engine: "client-webworker",
    };
  }

  function isSupported() {
    return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
  }

  function isBusy() {
    return _pending.size > 0;
  }

  global.PEClientPipeline = {
    denoiseLocal,
    analyzeLocal,
    isSupported,
    cancelAll,
    isBusy,
    isAbortError,
  };
})(typeof window !== "undefined" ? window : globalThis);
