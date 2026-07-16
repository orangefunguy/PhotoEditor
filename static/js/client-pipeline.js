/**
 * PhotoEditor client pipeline — local denoise / analyze via Web Worker.
 * Keeps Apply on-device so free-tier server latency never blocks filters.
 */
(function (global) {
  "use strict";

  let _worker = null;
  let _seq = 0;
  const _pending = new Map();

  function workerUrl() {
    // Match cache-bust query used by the page if present
    const scripts = document.querySelectorAll("script[src*='client-pipeline']");
    const src = scripts[scripts.length - 1]?.getAttribute("src") || "";
    const q = src.includes("?") ? src.slice(src.indexOf("?")) : "";
    return `/static/js/denoise-worker.js${q}`;
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
      }
    };
    _worker.onerror = (e) => {
      console.error("Denoise worker error", e);
      for (const [, p] of _pending) {
        p.reject(new Error(e.message || "Worker crashed"));
      }
      _pending.clear();
      _worker = null;
    };
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

  /**
   * @param {Blob|File} imageBlob
   * @param {object} controls
   * @param {{ onProgress?: (pct:number, label?:string)=>void }} [opts]
   */
  async function denoiseLocal(imageBlob, controls, opts = {}) {
    if (!imageBlob) throw new Error("No image to process.");
    const id = nextId();
    const w = getWorker();
    const transfer = await blobToTransfer(imageBlob);
    const result = await new Promise((resolve, reject) => {
      _pending.set(id, { resolve, reject, onProgress: opts.onProgress });
      w.postMessage(
        {
          type: "denoise",
          id,
          buffer: transfer.buffer,
          mime: transfer.mime,
          fileBytes: transfer.fileBytes,
          controls: controls || {},
          maxProcessSide: opts.maxProcessSide || 2800,
        },
        [transfer.buffer]
      );
    });

    const jpegBlob = new Blob([result.jpeg], { type: "image/jpeg" });
    // Also build a PNG/blob for canvas preview from rgba when needed
    let rgbaBlob = null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext("2d");
      const imgData = new ImageData(
        new Uint8ClampedArray(result.rgba),
        result.width,
        result.height
      );
      ctx.putImageData(imgData, 0, 0);
      rgbaBlob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.95));
    } catch {
      rgbaBlob = jpegBlob;
    }

    return {
      outputBlob: jpegBlob || rgbaBlob,
      width: result.width,
      height: result.height,
      report: result.report,
      engine: "client-webworker",
      jpegBytes: result.jpegBytes,
    };
  }

  /**
   * @param {Blob|File} imageBlob
   * @param {{ onProgress?: Function }} [opts]
   */
  async function analyzeLocal(imageBlob, opts = {}) {
    if (!imageBlob) throw new Error("No image to analyze.");
    const id = nextId();
    const w = getWorker();
    const transfer = await blobToTransfer(imageBlob);
    const result = await new Promise((resolve, reject) => {
      _pending.set(id, { resolve, reject, onProgress: opts.onProgress });
      w.postMessage(
        {
          type: "analyze",
          id,
          buffer: transfer.buffer,
          mime: transfer.mime,
          fileBytes: transfer.fileBytes,
          maxSide: opts.maxSide || 4000,
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

  global.PEClientPipeline = {
    denoiseLocal,
    analyzeLocal,
    isSupported,
  };
})(typeof window !== "undefined" ? window : globalThis);
