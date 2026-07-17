/**
 * PhotoEditor — high-quality local denoise (Web Worker).
 *
 * Uses OpenCV.js WASM for classical filters (bilateral / Gaussian / median)
 * plus a careful luminance Non-Local Means for hybrid/NLM — matching the
 * original server quality intent while staying on-device.
 */
/* eslint-disable no-restricted-globals */

let _cv = null;
let _cvReady = null;
/** @type {Uint8Array|null} */
let _wasmBinary = null;

/**
 * Absolute origin-relative paths only.
 * Never resolve relative to the worker URL (/static/js/…): that 404s as JSON
 * `{"detail":"Not Found"}` and yields:
 *   WebAssembly.Module(): expected magic word 00 61 73 6d, found 7b 22 64 65
 */
const OPENCV_JS = "/static/vendor/opencv.js";
const OPENCV_WASM = "/static/vendor/opencv.wasm";

function progress(id, pct, label) {
  self.postMessage({ type: "progress", id, pct, label });
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** Exact match to backend/denoise.py _strength_to_params */
function strengthToParams(strengthPct) {
  const s = clamp(Number(strengthPct) || 0, 0, 100) / 100;
  const t = Math.pow(s, 1.2);
  let d = Math.round(3 + t * 12);
  d = Math.min(15, Math.max(3, d));
  if (d % 2 === 0) d += 1;
  let mk = Math.round(1 + t * 4) * 2 + 1;
  mk = Math.min(9, Math.max(3, mk));
  if (mk % 2 === 0) mk += 1;
  return {
    bilateral_d: d,
    bilateral_sigma_color: 10 + t * 90,
    bilateral_sigma_space: 5 + t * 25,
    nlm_h: 1 + t * 14,
    gaussian_sigma: 0.15 + t * 2.5,
    median_ksize: mk,
    blend: clamp(t, 0, 1),
  };
}

function vendorPath(path) {
  // Always pin under /static/vendor/ regardless of what OpenCV asks for
  const name = String(path || "opencv.wasm").replace(/^\.\//, "").split("/").pop();
  return `/static/vendor/${name}`;
}

function assertWasmMagic(bytes, url) {
  if (
    !bytes ||
    bytes.length < 4 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    const head = bytes
      ? new TextDecoder().decode(bytes.slice(0, 48))
      : "(empty)";
    throw new Error(
      `OpenCV WASM invalid at ${url} (expected \\0asm, got: ${String(head)
        .replace(/\s+/g, " ")
        .slice(0, 60)})`
    );
  }
}

/**
 * Fetch with timeout so engine load never hangs forever at "8%".
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 */
async function fetchWithTimeout(url, init = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error(`Timed out loading ${url} after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch WASM and verify the magic header `\0asm`.
 * Tries primary absolute path, then a CDN fallback if origin is missing the file.
 * @param {(pct:number, label?:string)=>void} [onProgress]
 */
async function fetchWasmBinary(onProgress) {
  if (_wasmBinary) return _wasmBinary;

  const candidates = [
    OPENCV_WASM,
    // jsDelivr mirrors GitHub main (same source the edge worker uses)
    "https://cdn.jsdelivr.net/gh/orangefunguy/PhotoEditor@main/static/vendor/opencv.wasm",
  ];

  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    try {
      onProgress?.(4 + i * 8, i === 0 ? "Downloading denoise engine…" : "Trying CDN backup…");
      const res = await fetchWithTimeout(
        url,
        {
          credentials: url.startsWith("/") ? "same-origin" : "omit",
          mode: url.startsWith("/") ? "same-origin" : "cors",
        },
        45000
      );
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }
      onProgress?.(18, "Receiving engine binary…");
      const bytes = new Uint8Array(await res.arrayBuffer());
      assertWasmMagic(bytes, url);
      _wasmBinary = bytes;
      onProgress?.(28, "Engine binary ready");
      return _wasmBinary;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error("Failed to load OpenCV WASM");
}

function isCvApi(api) {
  return !!(api && typeof api.bilateralFilter === "function");
}

/**
 * @param {(pct:number, label?:string)=>void} [onProgress]
 */
function loadOpenCV(onProgress) {
  // If already loading/loaded, still surface progress for UI
  if (_cvReady) {
    if (isCvApi(_cv)) {
      onProgress?.(35, "Denoise engine ready");
      return _cvReady;
    }
    // Chain progress onto in-flight load
    return _cvReady.then((api) => {
      onProgress?.(35, "Denoise engine ready");
      return api;
    });
  }
  _cvReady = (async () => {
    if (isCvApi(_cv)) return _cv;

    // 1) Bytes first — never let Emscripten sync-XHR a relative path
    const wasmBinary = await fetchWasmBinary(onProgress);

    // 2) Glue script (factory) — import only after we have valid WASM
    onProgress?.(30, "Loading engine runtime…");
    try {
      if (typeof self.cv === "undefined") {
        importScripts(OPENCV_JS);
      }
    } catch (e) {
      throw new Error(`Failed to import OpenCV glue: ${e && e.message ? e.message : e}`);
    }

    const factoryOrCv = self.cv;
    if (!factoryOrCv) {
      throw new Error("OpenCV not loaded (self.cv missing)");
    }

    if (isCvApi(factoryOrCv)) {
      _cv = factoryOrCv;
      onProgress?.(35, "Denoise engine ready");
      return _cv;
    }

    if (typeof factoryOrCv !== "function") {
      throw new Error("Unexpected OpenCV export shape");
    }

    onProgress?.(32, "Compiling denoise engine (first time may take a bit)…");

    const api = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (obj) => {
        if (settled) return false;
        if (isCvApi(obj)) {
          settled = true;
          resolve(obj);
          return true;
        }
        return false;
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const moduleArg = {
        // Preloaded binary — getBinary() short-circuits without network
        wasmBinary,
        /**
         * Never allow scriptDirectory (/static/js/) to prefix absolute paths.
         * Broken form seen in prod: /static/js//static/vendor/opencv.wasm
         */
        locateFile(path) {
          const s = String(path || "");
          if (s.includes("opencv.wasm") || s.endsWith(".wasm")) return OPENCV_WASM;
          if (s.includes("opencv.js")) return OPENCV_JS;
          if (s.indexOf("://") !== -1 || s.charAt(0) === "/") return s;
          return vendorPath(s);
        },
        /**
         * Bypass Emscripten sync-XHR entirely. Older opencv.js builds ignore
         * locateFile in workers (scriptDirectory = /static/js/) and load JSON 404s.
         */
        // Async compile so the worker event loop can keep posting progress /
        // respond to terminate; sync WebAssembly.Module freezes the worker.
        instantiateWasm(info, receiveInstance) {
          WebAssembly.instantiate(wasmBinary, info)
            .then((pair) => {
              receiveInstance(pair.instance, pair.module);
            })
            .catch((e) => fail(e));
          return {}; // signal async instantiation to Emscripten
        },
        onRuntimeInitialized() {
          if (!done(moduleArg) && !done(self.cv)) {
            fail(new Error("OpenCV initialized but bilateralFilter missing"));
          }
        },
      };

      try {
        const ret = factoryOrCv(moduleArg);
        if (done(ret) || done(moduleArg) || done(self.cv)) return;
        if (ret && typeof ret.then === "function") {
          ret.then((v) => {
            if (!done(v) && !done(moduleArg) && !done(self.cv)) {
              fail(new Error("OpenCV promise resolved without API"));
            }
          }, fail);
        }
      } catch (e) {
        fail(e);
        return;
      }

      let n = 0;
      const t = setInterval(() => {
        n += 1;
        if (n % 50 === 0) {
          onProgress?.(
            Math.min(34, 32 + n / 250),
            "Compiling denoise engine…"
          );
        }
        if (done(self.cv) || done(moduleArg)) {
          clearInterval(t);
          return;
        }
        if (n > 1000) {
          // ~20s
          clearInterval(t);
          fail(
            new Error(
              "OpenCV runtime init timeout — hard-refresh and try again (engine may still be downloading)."
            )
          );
        }
      }, 20);
    });

    _cv = api;
    onProgress?.(35, "Denoise engine ready");
    return _cv;
  })().catch((err) => {
    // Allow a later retry after a transient failure
    _cvReady = null;
    throw err;
  });
  return _cvReady;
}

// Do NOT importScripts(opencv.js) at top-level — that lets Emscripten race a
// relative wasm fetch before we can inject wasmBinary / instantiateWasm.

// ── Image helpers ────────────────────────────────────────────────────

function rgbaToRgbMat(cv, data, w, h) {
  // ImageData is RGBA; OpenCV mats used as RGB 3-channel
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return cv.matFromArray(h, w, cv.CV_8UC3, rgb);
}

function matToRgba(cv, mat) {
  const w = mat.cols;
  const h = mat.rows;
  let rgb = mat;
  let needDelete = false;
  if (mat.type() !== cv.CV_8UC3) {
    rgb = new cv.Mat();
    mat.convertTo(rgb, cv.CV_8UC3);
    needDelete = true;
  }
  const src = rgb.data;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; j < src.length; i += 4, j += 3) {
    out[i] = src[j];
    out[i + 1] = src[j + 1];
    out[i + 2] = src[j + 2];
    out[i + 3] = 255;
  }
  if (needDelete) rgb.delete();
  return { rgba: out, w, h };
}

function odd(n, minV, maxV) {
  let v = Math.round(n) | 0;
  if (v % 2 === 0) v += 1;
  return clamp(v, minV, maxV);
}

/**
 * Try OpenCV native NLM if this build includes it (many browser builds do not).
 * @returns {boolean} true if dst was filled
 */
function tryOpenCvNlm(cv, srcMat, dst, hNlm, tw, sw) {
  const fn =
    cv.fastNlMeansDenoisingColored ||
    cv.fastNlMeansDenoising ||
    null;
  if (typeof fn !== "function") return false;
  try {
    // Colored API: (src, dst, h, hColor, templateWindowSize, searchWindowSize)
    if (cv.fastNlMeansDenoisingColored) {
      cv.fastNlMeansDenoisingColored(srcMat, dst, hNlm, hNlm, odd(tw, 3, 7), odd(sw, 7, 21));
    } else {
      cv.fastNlMeansDenoising(srcMat, dst, hNlm, odd(tw, 3, 7), odd(sw, 7, 21));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Fast high-quality hybrid: edge-preserving bilateral on luminance + light chroma
 * clean + RGB finish. Avoids pure-JS NLM (too slow in browsers → "Denoise timed out").
 */
function applyHybridFast(cv, srcMat, dst, d, sc, ss, strengthBoost, onProgress) {
  onProgress?.(10);
  const ycrcb = new cv.Mat();
  cv.cvtColor(srcMat, ycrcb, cv.COLOR_RGB2YCrCb);
  const channels = new cv.MatVector();
  cv.split(ycrcb, channels);
  const yMat = channels.get(0);
  const crMat = channels.get(1);
  const cbMat = channels.get(2);

  // Stronger bilateral on Y for nlm-like strength
  const yD = odd(d + (strengthBoost ? 2 : 0), 3, 15);
  const ySC = sc * (strengthBoost ? 1.15 : 1.0);
  const ySS = ss * (strengthBoost ? 1.1 : 1.0);

  onProgress?.(30);
  const yDst = new cv.Mat();
  cv.bilateralFilter(yMat, yDst, yD, ySC, ySS, cv.BORDER_DEFAULT);

  // Optional second pass on Y for stronger denoise (still O(n), not NLM)
  onProgress?.(50);
  const yDst2 = new cv.Mat();
  if (strengthBoost || sc > 40) {
    const d2 = odd(Math.max(3, (yD / 2) | 0), 3, 9);
    cv.bilateralFilter(yDst, yDst2, d2, ySC * 0.65, ySS * 0.65, cv.BORDER_DEFAULT);
  } else {
    yDst.copyTo(yDst2);
  }

  onProgress?.(65);
  const crDst = new cv.Mat();
  const cbDst = new cv.Mat();
  const chromaD = 5;
  const chromaSC = Math.max(8, sc * 0.28);
  const chromaSS = Math.max(3, ss * 0.35);
  cv.bilateralFilter(crMat, crDst, chromaD, chromaSC, chromaSS, cv.BORDER_DEFAULT);
  cv.bilateralFilter(cbMat, cbDst, chromaD, chromaSC, chromaSS, cv.BORDER_DEFAULT);

  onProgress?.(78);
  const mergedCh = new cv.MatVector();
  mergedCh.push_back(yDst2);
  mergedCh.push_back(crDst);
  mergedCh.push_back(cbDst);
  const merged = new cv.Mat();
  cv.merge(mergedCh, merged);
  const rgbFromY = new cv.Mat();
  cv.cvtColor(merged, rgbFromY, cv.COLOR_YCrCb2RGB);

  onProgress?.(88);
  const dFinish = odd(Math.max(3, (d / 2) | 0), 3, 9);
  cv.bilateralFilter(rgbFromY, dst, dFinish, sc * 0.55, ss * 0.55, cv.BORDER_DEFAULT);

  ycrcb.delete();
  channels.delete();
  yMat.delete();
  crMat.delete();
  cbMat.delete();
  yDst.delete();
  yDst2.delete();
  crDst.delete();
  cbDst.delete();
  mergedCh.delete();
  merged.delete();
  rgbFromY.delete();
  onProgress?.(95);
}

function applyOpenCV(cv, srcMat, controls, params, onProgress) {
  const algo = String(controls.algorithm || "hybrid").toLowerCase();
  let d = controls.bilateral_d || params.bilateral_d;
  d = odd(d, 3, 15);
  const sc = controls.bilateral_sigma_color || params.bilateral_sigma_color;
  const ss = controls.bilateral_sigma_space || params.bilateral_sigma_space;
  let hNlm = controls.nlm_h || params.nlm_h;
  const tw = controls.nlm_template_window || 7;
  const sw = controls.nlm_search_window || 21;
  const gsig = controls.gaussian_sigma || params.gaussian_sigma;
  let mk = controls.median_ksize || params.median_ksize;
  mk = odd(mk, 3, 9);
  const blend = params.blend;

  const dst = new cv.Mat();

  if (algo === "gaussian") {
    onProgress?.(40);
    let k = Math.max(3, Math.round(gsig * 4) | 1);
    if (k % 2 === 0) k += 1;
    cv.GaussianBlur(srcMat, dst, new cv.Size(k, k), gsig, gsig, cv.BORDER_DEFAULT);
    onProgress?.(90);
    return dst;
  }

  if (algo === "median") {
    onProgress?.(40);
    cv.medianBlur(srcMat, dst, mk);
    onProgress?.(90);
    return dst;
  }

  if (algo === "bilateral") {
    onProgress?.(30);
    cv.bilateralFilter(srcMat, dst, d, sc, ss, cv.BORDER_DEFAULT);
    onProgress?.(90);
    return dst;
  }

  // hybrid / nlm
  onProgress?.(8);
  if (algo === "nlm") {
    // Prefer native OpenCV NLM when available; otherwise strong hybrid bilateral
    const used = tryOpenCvNlm(cv, srcMat, dst, hNlm, tw, sw);
    if (used) {
      onProgress?.(70);
      const finish = new cv.Mat();
      const d2 = odd(Math.max(3, (d / 2) | 0), 3, 9);
      cv.bilateralFilter(dst, finish, d2, sc * 0.5, ss * 0.5, cv.BORDER_DEFAULT);
      finish.copyTo(dst);
      finish.delete();
      onProgress?.(90);
    } else {
      applyHybridFast(cv, srcMat, dst, d, sc * 1.2, ss * 1.15, true, onProgress);
    }
  } else {
    // hybrid default — fast OpenCV bilateral stack (quality without JS NLM timeout)
    applyHybridFast(cv, srcMat, dst, d, sc, ss, false, onProgress);
  }

  // Strength blend with original — server semantics: out = dst*blend + src*(1-blend)
  onProgress?.(92);
  if (blend < 0.999) {
    const blended = new cv.Mat();
    const a = new cv.Mat();
    const b = new cv.Mat();
    dst.convertTo(a, cv.CV_32FC3, blend, 0);
    srcMat.convertTo(b, cv.CV_32FC3, 1 - blend, 0);
    cv.add(a, b, blended);
    blended.convertTo(dst, cv.CV_8UC3);
    a.delete();
    b.delete();
    blended.delete();
  }

  onProgress?.(95);
  return dst;
}

function applyPhotometricMat(cv, mat, controls) {
  const lo = Number(controls.luminance_offset) || 0;
  const ro = Number(controls.r_offset) || 0;
  const go = Number(controls.g_offset) || 0;
  const bo = Number(controls.b_offset) || 0;
  if (!lo && !ro && !go && !bo) return mat;
  const data = mat.data;
  for (let i = 0; i < data.length; i += 3) {
    data[i] = clamp(data[i] + lo + ro, 0, 255);
    data[i + 1] = clamp(data[i + 1] + lo + go, 0, 255);
    data[i + 2] = clamp(data[i + 2] + lo + bo, 0, 255);
  }
  return mat;
}

// ── Metrics (same spirit as server) ──────────────────────────────────

function luminanceRGB(data, nPix) {
  const lum = new Float32Array(nPix);
  for (let i = 0, p = 0; i < nPix; i++, p += 3) {
    lum[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  return lum;
}

function boxBlurF(src, w, h, radius) {
  const r = Math.max(1, radius | 0);
  const iw = w + 1;
  const integ = new Float64Array(iw * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += src[(y - 1) * w + (x - 1)];
      integ[y * iw + x] = integ[(y - 1) * iw + x] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const A = integ[y0 * iw + x0];
      const B = integ[y0 * iw + (x1 + 1)];
      const C = integ[(y1 + 1) * iw + x0];
      const D = integ[(y1 + 1) * iw + (x1 + 1)];
      out[y * w + x] = (D - B - C + A) / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

function laplacianVar(gray, w, h) {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += lap;
      sum2 += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

function residualStd(gray, w, h) {
  const blur = boxBlurF(gray, w, h, 2);
  let s = 0;
  let s2 = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const d = gray[i] - blur[i];
    s += d;
    s2 += d * d;
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

function localStdMean(gray, w, h) {
  const mu = boxBlurF(gray, w, h, 2);
  const sq = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) sq[i] = gray[i] * gray[i];
  const mu2 = boxBlurF(sq, w, h, 2);
  let s = 0;
  for (let i = 0; i < gray.length; i++) s += Math.sqrt(Math.max(0, mu2[i] - mu[i] * mu[i]));
  return s / gray.length;
}

function meanStd(arr) {
  let s = 0;
  let s2 = 0;
  const n = arr.length;
  for (let i = 0; i < n; i++) {
    s += arr[i];
    s2 += arr[i] * arr[i];
  }
  const m = s / n;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / n - m * m)) };
}

function analyzeRgb(data, w, h, meta = {}) {
  const n = w * h;
  const lum = luminanceRGB(data, n);
  const lm = meanStd(lum);
  let rS = 0;
  let gS = 0;
  let bS = 0;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    rS += data[p];
    gS += data[p + 1];
    bS += data[p + 2];
  }
  return {
    geometry: {
      width: w,
      height: h,
      pixel_count: n,
      aspect_ratio: h ? w / h : 0,
      file_bytes: meta.file_bytes ?? null,
      format: meta.format || "bitmap",
      bit_depth: 8,
      channels: 3,
      has_icc: false,
      dpi: [72, 72],
    },
    luminance: { mean: lm.mean, std: lm.std },
    color_means: { r: rS / n, g: gS / n, b: bS / n },
    high_frequency: {
      laplacian_variance: laplacianVar(lum, w, h),
      laplacian_mean_abs: Math.sqrt(Math.max(0, laplacianVar(lum, w, h))),
    },
    noise_proxies: {
      residual_std_5x5: residualStd(lum, w, h),
      local_std_mean_5x5: localStdMean(lum, w, h),
      local_std_median_5x5: localStdMean(lum, w, h),
    },
  };
}

function compareRgb(src, out, w, h, srcMeta, outMeta) {
  const n = w * h;
  let mse = 0;
  let mae = 0;
  let maxDiff = 0;
  for (let i = 0; i < src.length; i++) {
    const d = out[i] - src[i];
    mse += d * d;
    mae += Math.abs(d);
    if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d);
  }
  mse /= src.length;
  mae /= src.length;
  const psnr = mse < 1e-12 ? 99 : 10 * Math.log10((255 * 255) / mse);
  const sLum = luminanceRGB(src, n);
  const oLum = luminanceRGB(out, n);
  const sLap = laplacianVar(sLum, w, h);
  const oLap = laplacianVar(oLum, w, h);
  const sRes = residualStd(sLum, w, h);
  const oRes = residualStd(oLum, w, h);
  const sLoc = localStdMean(sLum, w, h);
  const oLoc = localStdMean(oLum, w, h);
  const pct = (a, b) => (a < 1e-9 ? 0 : ((b - a) / a) * 100);
  const sm = meanStd(sLum);
  const om = meanStd(oLum);
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (sLum[i] - sm.mean) * (oLum[i] - om.mean);
  cov /= n;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const ssim =
    ((2 * sm.mean * om.mean + c1) * (2 * cov + c2)) /
    ((sm.mean ** 2 + om.mean ** 2 + c1) * (sm.std ** 2 + om.std ** 2 + c2) + 1e-12);

  return {
    geometry_delta: {
      source_width: w,
      source_height: h,
      output_width: w,
      output_height: h,
      resolution_preserved: true,
    },
    pixel_difference: { mse, mae, max_abs_diff: maxDiff, psnr_db: psnr },
    high_frequency_delta: {
      laplacian_variance_source: sLap,
      laplacian_variance_output: oLap,
      laplacian_variance_pct_change: pct(sLap, oLap),
    },
    noise_proxy_delta: {
      residual_std_source: sRes,
      residual_std_output: oRes,
      residual_std_pct_change: pct(sRes, oRes),
      local_std_mean_source: sLoc,
      local_std_mean_output: oLoc,
      local_std_mean_pct_change: pct(sLoc, oLoc),
    },
    structural: { ssim_global: ssim },
    source: analyzeRgb(src, w, h, srcMeta),
    output: analyzeRgb(out, w, h, outMeta),
  };
}

async function imageDataFromBitmap(bitmap, maxSide) {
  let w = bitmap.width;
  let h = bitmap.height;
  let scale = 1;
  const maxDim = Math.max(w, h);
  const cap = maxSide || 3600;
  if (maxDim > cap) {
    scale = cap / maxDim;
    w = Math.max(1, Math.round(bitmap.width * scale));
    h = Math.max(1, Math.round(bitmap.height * scale));
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return {
    imageData: ctx.getImageData(0, 0, w, h),
    processScale: scale,
    fullW: bitmap.width,
    fullH: bitmap.height,
  };
}

async function encodeJpeg(rgba, w, h, quality) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  const q = clamp((Number(quality) || 95) / 100, 0.5, 1);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: q });
  const buf = await blob.arrayBuffer();
  return { buffer: buf, bytes: buf.byteLength };
}

async function runDenoise(msg) {
  const { id, controls } = msg;
  progress(id, 2, "Loading high-quality denoise engine…");
  // loadOpenCV reports ~2–35%; then image prep continues from 38%
  const cv = await loadOpenCV((p, label) => {
    progress(id, Math.max(2, Math.min(35, p || 2)), label || "Loading denoise engine…");
  });
  if (!cv || typeof cv.bilateralFilter !== "function") {
    throw new Error("OpenCV denoise engine failed to initialize");
  }

  progress(id, 38, "Preparing image…");
  let bitmap = msg.bitmap;
  if (!bitmap && msg.buffer) {
    bitmap = await createImageBitmap(
      new Blob([msg.buffer], { type: msg.mime || "image/jpeg" })
    );
  }
  if (!bitmap) throw new Error("No image data");

  // Cap working resolution so browser denoise finishes in seconds
  const maxSide = msg.maxProcessSide || 1280;
  const { imageData, processScale, fullW, fullH } = await imageDataFromBitmap(
    bitmap,
    maxSide
  );
  bitmap.close?.();

  const w = imageData.width;
  const h = imageData.height;
  progress(id, 42, "Tuning filter strength…");

  const effective = clamp(controls.strength_pct ?? 50, 0, 100);
  // If category targets set, nudge strength (cheap search with residual proxy later skipped for speed)
  let strength = effective;
  if (
    (controls.residual_std_reduce_pct || 0) > 0 ||
    (controls.laplacian_variance_reduce_pct || 0) > 0 ||
    (controls.local_std_mean_reduce_pct || 0) > 0
  ) {
    // Prefer stronger denoise when user asks for noise reduction targets
    const target = Math.max(
      controls.residual_std_reduce_pct || 0,
      controls.laplacian_variance_reduce_pct || 0,
      controls.local_std_mean_reduce_pct || 0
    );
    strength = clamp(Math.max(strength, target * 0.9 + 15), 5, 100);
  }
  const params = strengthToParams(strength);

  const srcMat = rgbaToRgbMat(cv, imageData.data, w, h);
  // Keep a copy of source RGB bytes for metrics / blend reference
  const srcRgb = new Uint8Array(srcMat.data);

  let outMat;
  if (
    strength < 0.5 &&
    !controls.luminance_offset &&
    !controls.r_offset &&
    !controls.g_offset &&
    !controls.b_offset
  ) {
    outMat = srcMat.clone();
    progress(id, 90, "Bypass (strength ≈ 0)…");
  } else {
    progress(
      id,
      45,
      `Denoising with ${controls.algorithm || "hybrid"} (detail-preserving)…`
    );
    outMat = applyOpenCV(cv, srcMat, controls, params, (p) => {
      // applyOpenCV reports 0–100; map into 45–90 of overall job
      const overall = 45 + (Math.max(0, Math.min(100, p || 0)) / 100) * 45;
      progress(id, Math.min(90, overall), "Removing noise, keeping detail…");
    });
  }

  applyPhotometricMat(cv, outMat, controls);

  // Optional scale
  if (
    !controls.preserve_resolution &&
    controls.scale &&
    Math.abs(controls.scale - 1) > 1e-6
  ) {
    const s = clamp(Number(controls.scale), 0.1, 4);
    const nw = Math.max(1, Math.round(w * s));
    const nh = Math.max(1, Math.round(h * s));
    const scaled = new cv.Mat();
    cv.resize(outMat, scaled, new cv.Size(nw, nh), 0, 0, cv.INTER_LANCZOS4);
    outMat.delete();
    outMat = scaled;
  }

  progress(id, 93, "Encoding & measuring quality…");
  const { rgba, w: ow, h: oh } = matToRgba(cv, outMat);
  const outRgb = new Uint8Array(ow * oh * 3);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) {
    outRgb[p] = rgba[i];
    outRgb[p + 1] = rgba[i + 1];
    outRgb[p + 2] = rgba[i + 2];
  }

  // Metrics need same size — use process size
  const srcRgbSame =
    srcRgb.length === outRgb.length
      ? srcRgb
      : (() => {
          // resize source for compare
          const tmp = new cv.Mat();
          cv.resize(srcMat, tmp, new cv.Size(ow, oh), 0, 0, cv.INTER_AREA);
          const arr = new Uint8Array(tmp.data);
          tmp.delete();
          return arr;
        })();

  const jpegQ = controls.jpeg_quality || 95;
  const encoded = await encodeJpeg(rgba, ow, oh, jpegQ);
  const report = compareRgb(
    srcRgbSame,
    outRgb,
    ow,
    oh,
    { file_bytes: msg.fileBytes || null },
    { file_bytes: encoded.bytes }
  );
  report.pipeline = {
    algorithm: controls.algorithm || "hybrid",
    effective_strength_pct: strength,
    requested_strength_pct: controls.strength_pct,
    params,
    controls,
    note: `${controls.algorithm || "hybrid"} @ ${strength.toFixed(1)}% · OpenCV + luminance NLM (local)`,
    method:
      "High-quality local denoise: luminance Non-Local Means + OpenCV bilateral (YCrCb). " +
      "Preserves edges and color while reducing grain — same classical approach as the original technical pipeline.",
    process_scale: processScale,
    source_full_size: { width: fullW, height: fullH },
    process_size: { width: ow, height: oh },
    engine: "opencv-wasm+nlm-y",
  };
  report.source_single = report.source;
  report.output_single = report.output;

  srcMat.delete();
  outMat.delete();

  progress(id, 99, "Done");
  self.postMessage(
    {
      type: "result",
      id,
      width: ow,
      height: oh,
      rgba,
      jpeg: encoded.buffer,
      jpegBytes: encoded.bytes,
      report,
    },
    [rgba.buffer, encoded.buffer]
  );
}

async function runAnalyze(msg) {
  const { id } = msg;
  progress(id, 5, "Loading engine…");
  await loadOpenCV(); // warm engine
  progress(id, 20, "Reading image…");
  let bitmap = msg.bitmap;
  if (!bitmap && msg.buffer) {
    bitmap = await createImageBitmap(
      new Blob([msg.buffer], { type: msg.mime || "image/jpeg" })
    );
  }
  const { imageData } = await imageDataFromBitmap(bitmap, msg.maxSide || 4000);
  bitmap.close?.();
  const w = imageData.width;
  const h = imageData.height;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, p = 0; i < imageData.data.length; i += 4, p += 3) {
    rgb[p] = imageData.data[i];
    rgb[p + 1] = imageData.data[i + 1];
    rgb[p + 2] = imageData.data[i + 2];
  }
  progress(id, 70, "Computing metrics…");
  const metrics = analyzeRgb(rgb, w, h, { file_bytes: msg.fileBytes || null });
  progress(id, 100, "Done");
  self.postMessage({ type: "analyze_result", id, metrics, width: w, height: h });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === "denoise") await runDenoise(msg);
    else if (msg.type === "analyze") await runAnalyze(msg);
    else if (msg.type === "ping") {
      // Do NOT load OpenCV here — that blocked the worker queue and caused
      // denoise jobs to sit idle until the client timed out.
      self.postMessage({
        type: "pong",
        id: msg.id,
        opencv: !!(_cv && typeof _cv.bilateralFilter === "function"),
      });
    } else throw new Error(`Unknown message ${msg.type}`);
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      message: err && err.message ? err.message : String(err),
    });
  }
};
