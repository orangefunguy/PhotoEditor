/**
 * PhotoEditor — local denoise + metrics (Web Worker).
 * Runs on the user's CPU so Apply is not blocked by the remote host.
 */
/* eslint-disable no-restricted-globals */

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function strengthToParams(strengthPct) {
  const s = clamp(Number(strengthPct) || 0, 0, 100) / 100;
  const t = Math.pow(s, 1.2);
  // Cap diameter for interactive speed (still strong denoise via sigma)
  let d = Math.round(3 + t * 8);
  if (d % 2 === 0) d += 1;
  return {
    bilateral_d: clamp(d, 3, 9),
    bilateral_sigma_color: 10 + t * 90,
    bilateral_sigma_space: 5 + t * 22,
    nlm_h: 1 + t * 14,
    gaussian_sigma: 0.15 + t * 2.5,
    median_ksize: Math.min(7, Math.max(3, (Math.round(1 + t * 3) * 2 + 1) | 1)),
    blend: clamp(t, 0, 1),
  };
}

function progress(id, pct, label) {
  self.postMessage({ type: "progress", id, pct, label });
}

/** RGBA Uint8ClampedArray → Float32 RGB planes (separate for speed) */
function rgbaToPlanes(data, w, h) {
  const n = w * h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    r[i] = data[p];
    g[i] = data[p + 1];
    b[i] = data[p + 2];
  }
  return { r, g, b, w, h };
}

function planesToRgba(r, g, b, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  const n = w * h;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[p] = clamp(r[i] + 0.5, 0, 255);
    out[p + 1] = clamp(g[i] + 0.5, 0, 255);
    out[p + 2] = clamp(b[i] + 0.5, 0, 255);
    out[p + 3] = 255;
  }
  return out;
}

function luminance(r, g, b, n) {
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i];
  }
  return lum;
}

function copyPlane(src) {
  return new Float32Array(src);
}

function blendPlanes(a, b, t) {
  const n = a.length;
  const out = new Float32Array(n);
  const u = 1 - t;
  for (let i = 0; i < n; i++) out[i] = a[i] * t + b[i] * u;
  return out;
}

// ── Separable Gaussian ───────────────────────────────────────────────
function gaussKernel(sigma) {
  const s = Math.max(0.15, sigma);
  const radius = Math.min(12, Math.max(1, Math.ceil(s * 3)));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  const inv = 1 / (2 * s * s);
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-i * i * inv);
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, radius };
}

function convolve1DHoriz(src, w, h, k, radius) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const xx = clamp(x + i, 0, w - 1);
        acc += src[row + xx] * k[i + radius];
      }
      out[row + x] = acc;
    }
  }
  return out;
}

function convolve1DVert(src, w, h, k, radius) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const yy = clamp(y + i, 0, h - 1);
        acc += src[yy * w + x] * k[i + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

function gaussianPlane(src, w, h, sigma) {
  const { k, radius } = gaussKernel(sigma);
  const tmp = convolve1DHoriz(src, w, h, k, radius);
  return convolve1DVert(tmp, w, h, k, radius);
}

// ── Box blur (integral image) ────────────────────────────────────────
function boxBlur(src, w, h, radius) {
  const r = Math.max(1, radius | 0);
  // integral with (w+1)*(h+1)
  const iw = w + 1;
  const ih = h + 1;
  const integ = new Float64Array(iw * ih);
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += src[(y - 1) * w + (x - 1)];
      integ[y * iw + x] = integ[(y - 1) * iw + x] + rowSum;
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
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      out[y * w + x] = (D - B - C + A) / area;
    }
  }
  return out;
}

// ── Median ───────────────────────────────────────────────────────────
function medianPlane(src, w, h, ksize) {
  let k = ksize | 0;
  if (k % 2 === 0) k += 1;
  k = clamp(k, 3, 9);
  const r = (k - 1) >> 1;
  const out = new Float32Array(src.length);
  const win = new Float32Array(k * k);
  const mid = (k * k) >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = clamp(y + dy, 0, h - 1);
        for (let dx = -r; dx <= r; dx++) {
          const xx = clamp(x + dx, 0, w - 1);
          win[n++] = src[yy * w + xx];
        }
      }
      // partial selection sort to mid
      for (let i = 0; i <= mid; i++) {
        let minI = i;
        for (let j = i + 1; j < n; j++) if (win[j] < win[minI]) minI = j;
        const t = win[i];
        win[i] = win[minI];
        win[minI] = t;
      }
      out[y * w + x] = win[mid];
    }
  }
  return out;
}

// ── Bilateral (luma-guided, diameter capped for interactive speed) ──
function bilateralPlane(src, guide, w, h, diameter, sigmaColor, sigmaSpace) {
  let d = diameter | 0;
  if (d % 2 === 0) d += 1;
  d = clamp(d, 3, 9);
  const radius = (d - 1) >> 1;
  const sc = Math.max(1, sigmaColor);
  const ss = Math.max(0.5, sigmaSpace);
  const invSc = 1 / (2 * sc * sc);
  const invSs = 1 / (2 * ss * ss);

  const diam = 2 * radius + 1;
  const spat = new Float32Array(diam * diam);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      spat[(dy + radius) * diam + (dx + radius)] = Math.exp(-(dx * dx + dy * dy) * invSs);
    }
  }

  // Quantized range LUT (0..255 delta) avoids per-pixel exp
  const rangeLut = new Float32Array(256);
  for (let i = 0; i < 256; i++) rangeLut[i] = Math.exp(-(i * i) * invSc);

  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const g0 = guide[y * w + x];
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      let wsum = 0;
      let vsum = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const dy = yy - y;
        for (let xx = x0; xx <= x1; xx++) {
          const dx = xx - x;
          const sp = spat[(dy + radius) * diam + (dx + radius)];
          const dg = Math.min(255, Math.abs(guide[yy * w + xx] - g0) | 0);
          const wr = sp * rangeLut[dg];
          wsum += wr;
          vsum += wr * src[yy * w + xx];
        }
      }
      out[y * w + x] = wsum > 1e-8 ? vsum / wsum : src[y * w + x];
    }
  }
  return out;
}

function bilateralRGB(planes, d, sc, ss) {
  const { r, g, b, w, h } = planes;
  const n = w * h;
  const guide = luminance(r, g, b, n);
  return {
    r: bilateralPlane(r, guide, w, h, d, sc, ss),
    g: bilateralPlane(g, guide, w, h, d, sc, ss),
    b: bilateralPlane(b, guide, w, h, d, sc, ss),
    w,
    h,
  };
}

// ── Fast Non-Local Means (sampled, multi-channel) ────────────────────
function nlmRGB(planes, hParam, templateWindow, searchWindow, onProgress) {
  const { r, g, b, w, h } = planes;
  const n = w * h;
  let tw = templateWindow | 0;
  let sw = searchWindow | 0;
  if (tw % 2 === 0) tw += 1;
  if (sw % 2 === 0) sw += 1;
  tw = clamp(tw, 3, 7);
  // Cap search for speed — still strong denoise
  sw = clamp(sw, 7, 15);
  const tr = (tw - 1) >> 1;
  const sr = (sw - 1) >> 1;
  const h2 = Math.max(0.5, hParam) * Math.max(0.5, hParam);
  const invH = 1 / h2;

  // Process at reduced resolution for large images, then upsample weights conceptually
  // by running on a grid (step) and filling.
  const px = w * h;
  let step = 1;
  if (px > 2_500_000) step = 3;
  else if (px > 1_200_000) step = 2;

  const outR = new Float32Array(n);
  const outG = new Float32Array(n);
  const outB = new Float32Array(n);
  // Initialize with source
  outR.set(r);
  outG.set(g);
  outB.set(b);

  const patchDist = (x, y, nx, ny) => {
    let dist = 0;
    let count = 0;
    for (let dy = -tr; dy <= tr; dy++) {
      const y1 = clamp(y + dy, 0, h - 1);
      const y2 = clamp(ny + dy, 0, h - 1);
      for (let dx = -tr; dx <= tr; dx++) {
        const x1 = clamp(x + dx, 0, w - 1);
        const x2 = clamp(nx + dx, 0, w - 1);
        const i1 = y1 * w + x1;
        const i2 = y2 * w + x2;
        const dr = r[i1] - r[i2];
        const dg = g[i1] - g[i2];
        const db = b[i1] - b[i2];
        dist += dr * dr + dg * dg + db * db;
        count += 3;
      }
    }
    return dist / count;
  };

  let done = 0;
  const total = Math.ceil(h / step) * Math.ceil(w / step);
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      let wsum = 0;
      let srR = 0;
      let srG = 0;
      let srB = 0;
      const y0 = Math.max(0, y - sr);
      const y1 = Math.min(h - 1, y + sr);
      const x0 = Math.max(0, x - sr);
      const x1 = Math.min(w - 1, x + sr);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          const d = patchDist(x, y, nx, ny);
          const weight = Math.exp(-d * invH);
          wsum += weight;
          const idx = ny * w + nx;
          srR += weight * r[idx];
          srG += weight * g[idx];
          srB += weight * b[idx];
        }
      }
      const i = y * w + x;
      if (wsum > 1e-8) {
        outR[i] = srR / wsum;
        outG[i] = srG / wsum;
        outB[i] = srB / wsum;
      }
      done++;
      if (onProgress && done % 2000 === 0) {
        onProgress(5 + (done / total) * 70);
      }
    }
  }

  // Fill skipped pixels by bilinear-ish neighbor average from processed grid
  if (step > 1) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (y % step === 0 && x % step === 0) continue;
        const x0 = Math.floor(x / step) * step;
        const y0 = Math.floor(y / step) * step;
        const x1 = Math.min(w - 1, x0 + step);
        const y1 = Math.min(h - 1, y0 + step);
        const fx = step > 0 ? (x - x0) / step : 0;
        const fy = step > 0 ? (y - y0) / step : 0;
        const i00 = y0 * w + x0;
        const i10 = y0 * w + x1;
        const i01 = y1 * w + x0;
        const i11 = y1 * w + x1;
        const lerp = (a, b, t) => a + (b - a) * t;
        outR[y * w + x] = lerp(lerp(outR[i00], outR[i10], fx), lerp(outR[i01], outR[i11], fx), fy);
        outG[y * w + x] = lerp(lerp(outG[i00], outG[i10], fx), lerp(outG[i01], outG[i11], fx), fy);
        outB[y * w + x] = lerp(lerp(outB[i00], outB[i10], fx), lerp(outB[i01], outB[i11], fx), fy);
      }
    }
  }

  return { r: outR, g: outG, b: outB, w, h };
}

function applyAlgorithm(planes, controls, params, onProgress) {
  const algo = String(controls.algorithm || "hybrid").toLowerCase();
  const d = controls.bilateral_d || params.bilateral_d;
  const sc = controls.bilateral_sigma_color || params.bilateral_sigma_color;
  const ss = controls.bilateral_sigma_space || params.bilateral_sigma_space;
  const hNlm = controls.nlm_h || params.nlm_h;
  const tw = controls.nlm_template_window || 7;
  const sw = controls.nlm_search_window || 21;
  const gsig = controls.gaussian_sigma || params.gaussian_sigma;
  let mk = controls.median_ksize || params.median_ksize;
  if (mk % 2 === 0) mk += 1;

  if (algo === "gaussian") {
    onProgress?.(30);
    return {
      r: gaussianPlane(planes.r, planes.w, planes.h, gsig),
      g: gaussianPlane(planes.g, planes.w, planes.h, gsig),
      b: gaussianPlane(planes.b, planes.w, planes.h, gsig),
      w: planes.w,
      h: planes.h,
    };
  }
  if (algo === "median") {
    onProgress?.(30);
    return {
      r: medianPlane(planes.r, planes.w, planes.h, mk),
      g: medianPlane(planes.g, planes.w, planes.h, mk),
      b: medianPlane(planes.b, planes.w, planes.h, mk),
      w: planes.w,
      h: planes.h,
    };
  }
  if (algo === "bilateral") {
    onProgress?.(25);
    return bilateralRGB(planes, d, sc, ss);
  }
  if (algo === "nlm") {
    return nlmRGB(planes, hNlm, tw, Math.min(sw, 15), onProgress);
  }
  // hybrid (default): dual edge-preserving bilateral + original blend — fast on CPU
  onProgress?.(22);
  const pass1 = bilateralRGB(planes, d, sc, ss);
  onProgress?.(60);
  // Second pass slightly softer — adds NLM-like calm without patch search cost
  const d2 = Math.max(3, ((d / 2) | 0) * 2 + 1);
  const pass2 = bilateralRGB(pass1, d2, sc * 0.55, ss * 0.55);
  onProgress?.(88);
  const blend = params.blend;
  return {
    r: blendPlanes(pass2.r, planes.r, blend),
    g: blendPlanes(pass2.g, planes.g, blend),
    b: blendPlanes(pass2.b, planes.b, blend),
    w: planes.w,
    h: planes.h,
  };
}

// ── Metrics ──────────────────────────────────────────────────────────
function laplacianVar(gray, w, h) {
  let sum = 0;
  let sum2 = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += lap;
      sum2 += lap * lap;
      count++;
    }
  }
  const mean = sum / count;
  return sum2 / count - mean * mean;
}

function residualStd(gray, w, h) {
  const blur = boxBlur(gray, w, h, 2);
  let sum = 0;
  let sum2 = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const d = gray[i] - blur[i];
    sum += d;
    sum2 += d * d;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

function localStdMean(gray, w, h) {
  const mu = boxBlur(gray, w, h, 2);
  const sq = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) sq[i] = gray[i] * gray[i];
  const mu2 = boxBlur(sq, w, h, 2);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += Math.sqrt(Math.max(0, mu2[i] - mu[i] * mu[i]));
  }
  return sum / gray.length;
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

function analyzePlanes(planes, meta = {}) {
  const { r, g, b, w, h } = planes;
  const n = w * h;
  const lum = luminance(r, g, b, n);
  const lap = laplacianVar(lum, w, h);
  const res = residualStd(lum, w, h);
  const loc = localStdMean(lum, w, h);
  const rm = meanStd(r);
  const gm = meanStd(g);
  const bm = meanStd(b);
  const lm = meanStd(lum);
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
    luminance: {
      mean: lm.mean,
      std: lm.std,
      min: lm.mean - 2 * lm.std,
      max: lm.mean + 2 * lm.std,
    },
    color_means: {
      r: rm.mean,
      g: gm.mean,
      b: bm.mean,
    },
    high_frequency: {
      laplacian_variance: lap,
      laplacian_mean_abs: Math.sqrt(Math.max(0, lap)),
    },
    noise_proxies: {
      residual_std_5x5: res,
      local_std_mean_5x5: loc,
      local_std_median_5x5: loc,
    },
  };
}

function comparePlanes(src, out, srcMeta, outMeta) {
  const n = src.w * src.h;
  const sLum = luminance(src.r, src.g, src.b, n);
  const oLum = luminance(out.r, out.g, out.b, n);
  let mse = 0;
  let mae = 0;
  let maxDiff = 0;
  for (let i = 0; i < n; i++) {
    const dr = src.r[i] - out.r[i];
    const dg = src.g[i] - out.g[i];
    const db = src.b[i] - out.b[i];
    const d2 = (dr * dr + dg * dg + db * db) / 3;
    mse += d2;
    mae += (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) / 3;
    maxDiff = Math.max(maxDiff, Math.abs(dr), Math.abs(dg), Math.abs(db));
  }
  mse /= n;
  mae /= n;
  const psnr = mse < 1e-12 ? 99 : 10 * Math.log10((255 * 255) / mse);

  const sLap = laplacianVar(sLum, src.w, src.h);
  const oLap = laplacianVar(oLum, out.w, out.h);
  const sRes = residualStd(sLum, src.w, src.h);
  const oRes = residualStd(oLum, out.w, out.h);
  const sLoc = localStdMean(sLum, src.w, src.h);
  const oLoc = localStdMean(oLum, out.w, out.h);

  const pct = (a, b) => (a < 1e-9 ? 0 : ((b - a) / a) * 100);

  // SSIM-like global
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
      source_width: src.w,
      source_height: src.h,
      output_width: out.w,
      output_height: out.h,
      resolution_preserved: src.w === out.w && src.h === out.h,
    },
    pixel_difference: {
      mse,
      mae,
      max_abs_diff: maxDiff,
      psnr_db: psnr,
    },
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
    source: analyzePlanes(src, srcMeta),
    output: analyzePlanes(out, outMeta),
  };
}

function measureNoise(planes) {
  const lum = luminance(planes.r, planes.g, planes.b, planes.w * planes.h);
  return {
    laplacian_variance: laplacianVar(lum, planes.w, planes.h),
    residual_std_5x5: residualStd(lum, planes.w, planes.h),
    local_std_mean_5x5: localStdMean(lum, planes.w, planes.h),
  };
}

function strengthForTargets(planes, controls) {
  const targets = [];
  if (controls.residual_std_reduce_pct > 0)
    targets.push(["residual_std_5x5", controls.residual_std_reduce_pct]);
  if (controls.laplacian_variance_reduce_pct > 0)
    targets.push(["laplacian_variance", controls.laplacian_variance_reduce_pct]);
  if (controls.local_std_mean_reduce_pct > 0)
    targets.push(["local_std_mean_5x5", controls.local_std_mean_reduce_pct]);
  if (!targets.length) return clamp(controls.strength_pct ?? 50, 0, 100);

  // Fast search — fewer trials, use bilateral-only for search speed
  const base = measureNoise(planes);
  let bestS = controls.strength_pct || 50;
  let bestErr = Infinity;
  for (let s = 10; s <= 100; s += 10) {
    const params = strengthToParams(s);
    const trial = bilateralRGB(
      planes,
      params.bilateral_d,
      params.bilateral_sigma_color,
      params.bilateral_sigma_space
    );
    const m = measureNoise(trial);
    let err = 0;
    for (const [key, reduce] of targets) {
      const desired = base[key] * (1 - reduce / 100);
      err += Math.abs(m[key] - desired) / (base[key] + 1e-6);
    }
    if (err < bestErr) {
      bestErr = err;
      bestS = s;
    }
  }
  return bestS;
}

function applyPhotometric(planes, controls) {
  const lo = Number(controls.luminance_offset) || 0;
  const ro = Number(controls.r_offset) || 0;
  const go = Number(controls.g_offset) || 0;
  const bo = Number(controls.b_offset) || 0;
  if (!lo && !ro && !go && !bo) return planes;
  const n = planes.w * planes.h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = clamp(planes.r[i] + lo + ro, 0, 255);
    g[i] = clamp(planes.g[i] + lo + go, 0, 255);
    b[i] = clamp(planes.b[i] + lo + bo, 0, 255);
  }
  return { r, g, b, w: planes.w, h: planes.h };
}

function scalePlanes(planes, scale, preserve) {
  if (preserve || Math.abs(scale - 1) < 1e-6) return planes;
  const s = clamp(scale, 0.1, 4);
  const nw = Math.max(1, Math.round(planes.w * s));
  const nh = Math.max(1, Math.round(planes.h * s));
  // Draw via OffscreenCanvas for quality
  const rgba = planesToRgba(planes.r, planes.g, planes.b, planes.w, planes.h);
  const src = new ImageData(rgba, planes.w, planes.h);
  const c = new OffscreenCanvas(planes.w, planes.h);
  c.getContext("2d").putImageData(src, 0, 0);
  const d = new OffscreenCanvas(nw, nh);
  const ctx = d.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(c, 0, 0, nw, nh);
  const out = ctx.getImageData(0, 0, nw, nh);
  return rgbaToPlanes(out.data, nw, nh);
}

async function imageDataFromBitmap(bitmap, maxSide) {
  let w = bitmap.width;
  let h = bitmap.height;
  let scale = 1;
  const maxDim = Math.max(w, h);
  // Keep quality high but avoid multi-second freezes on huge photos
  const cap = maxSide || 2400;
  if (maxDim > cap) {
    scale = cap / maxDim;
    w = Math.max(1, Math.round(bitmap.width * scale));
    h = Math.max(1, Math.round(bitmap.height * scale));
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return { imageData: img, processScale: scale, fullW: bitmap.width, fullH: bitmap.height };
}

async function encodeJpeg(planes, quality) {
  const rgba = planesToRgba(planes.r, planes.g, planes.b, planes.w, planes.h);
  const canvas = new OffscreenCanvas(planes.w, planes.h);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(rgba, planes.w, planes.h), 0, 0);
  const q = clamp((Number(quality) || 95) / 100, 0.5, 1);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: q });
  const buf = await blob.arrayBuffer();
  return { buffer: buf, bytes: buf.byteLength };
}

async function runDenoise(msg) {
  const { id, controls, maxProcessSide } = msg;
  progress(id, 2, "Preparing image on this device…");

  let bitmap = msg.bitmap;
  if (!bitmap && msg.buffer) {
    const blob = new Blob([msg.buffer], { type: msg.mime || "image/jpeg" });
    bitmap = await createImageBitmap(blob);
  }
  if (!bitmap) throw new Error("No image data for local denoise.");

  const preserve = controls.preserve_resolution !== false;
  // Full-res when small enough; otherwise process at cap then we keep process res
  // (user preserve means we don't downscale *more* after filter)
  const maxSide = preserve ? maxProcessSide || 2800 : maxProcessSide || 2000;
  const { imageData, processScale, fullW, fullH } = await imageDataFromBitmap(
    bitmap,
    maxSide
  );
  bitmap.close?.();

  progress(id, 8, "Reading pixels…");
  let planes = rgbaToPlanes(imageData.data, imageData.width, imageData.height);
  const srcPlanes = {
    r: copyPlane(planes.r),
    g: copyPlane(planes.g),
    b: copyPlane(planes.b),
    w: planes.w,
    h: planes.h,
  };

  progress(id, 12, "Tuning strength…");
  const effective = strengthForTargets(planes, controls);
  const params = strengthToParams(effective);

  let out;
  if (
    effective < 0.5 &&
    !controls.luminance_offset &&
    !controls.r_offset &&
    !controls.g_offset &&
    !controls.b_offset
  ) {
    out = planes;
    progress(id, 90, "Bypass (strength ≈ 0)…");
  } else {
    progress(id, 15, `Running ${controls.algorithm || "hybrid"} on your CPU…`);
    out = applyAlgorithm(planes, controls, params, (p) =>
      progress(id, Math.min(88, p), "Denoising on this device…")
    );
  }

  out = applyPhotometric(out, controls);
  out = scalePlanes(out, Number(controls.scale) || 1, !!controls.preserve_resolution);

  progress(id, 90, "Computing metrics…");
  const jpegQ = controls.jpeg_quality || 95;
  const encoded = await encodeJpeg(out, jpegQ);
  const srcMeta = { file_bytes: msg.fileBytes || null };
  const outMeta = { file_bytes: encoded.bytes };
  const report = comparePlanes(srcPlanes, out, srcMeta, outMeta);
  report.pipeline = {
    algorithm: controls.algorithm || "hybrid",
    effective_strength_pct: effective,
    requested_strength_pct: controls.strength_pct,
    params,
    controls,
    note: `${controls.algorithm || "hybrid"} @ strength ${effective.toFixed(1)}% (local CPU)`,
    method:
      "Local browser denoise (Web Worker). Uses this device’s CPU/memory — not the remote server.",
    process_scale: processScale,
    source_full_size: { width: fullW, height: fullH },
    process_size: { width: planes.w, height: planes.h },
    engine: "client-webworker",
  };
  report.source_single = analyzePlanes(srcPlanes, srcMeta);
  report.output_single = analyzePlanes(out, outMeta);

  const rgba = planesToRgba(out.r, out.g, out.b, out.w, out.h);
  progress(id, 98, "Finalizing…");

  self.postMessage(
    {
      type: "result",
      id,
      width: out.w,
      height: out.h,
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
  progress(id, 10, "Analyzing on this device…");
  let bitmap = msg.bitmap;
  if (!bitmap && msg.buffer) {
    bitmap = await createImageBitmap(new Blob([msg.buffer], { type: msg.mime || "image/jpeg" }));
  }
  const { imageData } = await imageDataFromBitmap(bitmap, msg.maxSide || 4000);
  bitmap.close?.();
  progress(id, 50, "Computing metrics…");
  const planes = rgbaToPlanes(imageData.data, imageData.width, imageData.height);
  const metrics = analyzePlanes(planes, { file_bytes: msg.fileBytes || null });
  progress(id, 100, "Done");
  self.postMessage({ type: "analyze_result", id, metrics, width: planes.w, height: planes.h });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === "denoise") await runDenoise(msg);
    else if (msg.type === "analyze") await runAnalyze(msg);
    else throw new Error(`Unknown worker message: ${msg.type}`);
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      message: err && err.message ? err.message : String(err),
    });
  }
};
