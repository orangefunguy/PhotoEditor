/**
 * PhotoEditor client — upload, analyze, denoise, render technical metrics.
 */
(() => {
  "use strict";

  const state = {
    file: null,
    jobId: null,
    sourceUrl: null,
    outputUrl: null,
    sourceMetrics: null,
    report: null,
    view: "source",
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const els = {
    dropzone: $("#dropzone"),
    fileInput: $("#fileInput"),
    fileMeta: $("#fileMeta"),
    status: $("#status"),
    statusText: $("#statusText"),
    healthBadge: $("#healthBadge"),
    jobBadge: $("#jobBadge"),
    metricsRoot: $("#metricsRoot"),
    previewImg: $("#previewImg"),
    placeholder: $("#placeholder"),
    singleView: $("#singleView"),
    compareWrap: $("#compareWrap"),
    compareBefore: $("#compareBefore"),
    compareAfter: $("#compareAfter"),
    compareSlider: $("#compareSlider"),
    btnDenoise: $("#btnDenoise"),
    btnAnalyze: $("#btnAnalyze"),
    btnDownload: $("#btnDownload"),
    btnReset: $("#btnReset"),
    toggleAdvanced: $("#toggleAdvanced"),
    advanced: $("#advanced"),
  };

  // ── paired range + number controls ──────────────────────────────────
  const pairs = [
    ["strength", "strengthNum", "strengthVal", (v) => `${v}%`],
    ["lapVar", "lapVarNum", "lapVarVal", (v) => `${v}%`],
    ["resStd", "resStdNum", "resStdVal", (v) => `${v}%`],
    ["locStd", "locStdNum", "locStdVal", (v) => `${v}%`],
    ["lumOff", "lumOffNum", "lumOffVal", (v) => String(v)],
    ["rOff", "rOffNum", "rOffVal", (v) => String(v)],
    ["gOff", "gOffNum", "gOffVal", (v) => String(v)],
    ["bOff", "bOffNum", "bOffVal", (v) => String(v)],
    ["jpegQ", "jpegQNum", "jpegQVal", (v) => String(v)],
    ["scale", "scaleNum", "scaleVal", (v) => `${Number(v).toFixed(2)}×`],
  ];

  function bindPair(rangeId, numId, hintId, fmt) {
    const range = document.getElementById(rangeId);
    const num = document.getElementById(numId);
    const hint = document.getElementById(hintId);
    const sync = (from) => {
      const v = from.value;
      if (from === range) num.value = v;
      else range.value = v;
      if (hint) hint.textContent = fmt(num.value);
    };
    range.addEventListener("input", () => sync(range));
    num.addEventListener("input", () => sync(num));
    sync(range);
  }

  pairs.forEach(([r, n, h, f]) => bindPair(r, n, h, f));

  // ── helpers ─────────────────────────────────────────────────────────
  function setStatus(text, mode = "") {
    els.status.className = `status-bar ${mode}`.trim();
    els.statusText.textContent = text;
  }

  function fmtNum(n, digits = 2) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    if (typeof n !== "number") return String(n);
    if (Math.abs(n) >= 1000) return n.toFixed(1);
    if (Math.abs(n) >= 10) return n.toFixed(digits);
    return n.toFixed(Math.min(4, digits + 1));
  }

  function fmtBytes(b) {
    if (b == null) return "—";
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  }

  function deltaClass(v, invertGood = false) {
    if (v == null || Math.abs(v) < 1e-9) return "delta-neutral";
    const negIsGood = invertGood; // e.g. HF reduction: negative % change is good
    if (negIsGood) return v < 0 ? "delta-neg" : "delta-pos";
    return v < 0 ? "delta-pos" : "delta-neg";
  }

  function card(title, rows) {
    const tr = rows
      .map(
        ([k, v, cls]) =>
          `<tr><th>${k}</th><td class="${cls || ""}">${v}</td></tr>`
      )
      .join("");
    return `<div class="metric-card"><h3>${title}</h3><table class="metric-table">${tr}</table></div>`;
  }

  function collectControls() {
    const preserve = $("#preserveRes").checked;
    const scale = Number($("#scaleNum").value);
    return {
      strength_pct: Number($("#strengthNum").value),
      algorithm: $("#algorithm").value,
      laplacian_variance_reduce_pct: Number($("#lapVarNum").value),
      residual_std_reduce_pct: Number($("#resStdNum").value),
      local_std_mean_reduce_pct: Number($("#locStdNum").value),
      luminance_offset: Number($("#lumOffNum").value),
      r_offset: Number($("#rOffNum").value),
      g_offset: Number($("#gOffNum").value),
      b_offset: Number($("#bOffNum").value),
      jpeg_quality: Number($("#jpegQNum").value),
      scale: preserve ? 1.0 : scale,
      preserve_resolution: preserve,
      nlm_h: Number($("#nlmH").value) || 0,
      bilateral_sigma_color: Number($("#bilSigmaC").value) || 0,
      bilateral_sigma_space: Number($("#bilSigmaS").value) || 0,
      gaussian_sigma: Number($("#gaussSigma").value) || 0,
    };
  }

  // ── metrics rendering ───────────────────────────────────────────────
  function renderSourceMetrics(m) {
    if (!m) return "";
    const g = m.geometry || {};
    const L = m.luminance || {};
    const c = m.color_means || {};
    const hf = m.high_frequency || {};
    const n = m.noise_proxies || {};
    return [
      card("Geometry / encoding", [
        ["Width × height", `${g.width} × ${g.height}`],
        ["Pixel count", g.pixel_count?.toLocaleString?.() ?? g.pixel_count],
        ["Aspect ratio", fmtNum(g.aspect_ratio, 4)],
        ["File size", fmtBytes(g.file_bytes)],
        ["Format", g.format || "—"],
        ["Bit depth / channels", `${g.bit_depth}-bit · ${g.channels} ch`],
        ["ICC profile", g.has_icc ? "yes" : "no"],
        ["DPI", Array.isArray(g.dpi) ? g.dpi.map((x) => fmtNum(x, 1)).join(" × ") : "—"],
      ]),
      card("Luminance (Rec.709)", [
        ["Mean", fmtNum(L.mean)],
        ["Std", fmtNum(L.std)],
      ]),
      card("Color means (RGB 0–255)", [
        ["R", fmtNum(c.r)],
        ["G", fmtNum(c.g)],
        ["B", fmtNum(c.b)],
      ]),
      card("High-frequency energy", [
        ["Laplacian variance", fmtNum(hf.laplacian_variance)],
        ["Mean |Laplacian|", fmtNum(hf.laplacian_mean_abs)],
      ]),
      card("Noise proxies", [
        ["Residual std (5×5 box)", fmtNum(n.residual_std_5x5)],
        ["Local std mean (5×5)", fmtNum(n.local_std_mean_5x5)],
        ["Local std median (5×5)", fmtNum(n.local_std_median_5x5)],
      ]),
    ].join("");
  }

  function renderReport(report) {
    if (!report) return renderSourceMetrics(state.sourceMetrics);

    const parts = [];
    const pipe = report.pipeline || {};
    if (pipe.algorithm) {
      parts.push(
        card("Pipeline", [
          ["Method", pipe.method || "classical denoise"],
          ["Algorithm", pipe.algorithm],
          ["Requested strength", `${fmtNum(pipe.requested_strength_pct, 1)}%`],
          ["Effective strength", `${fmtNum(pipe.effective_strength_pct, 1)}%`],
          ["Note", pipe.note || "—"],
          [
            "Auto params",
            pipe.params
              ? `NLM h≈${fmtNum(pipe.params.nlm_h, 2)}, bil σc≈${fmtNum(
                  pipe.params.bilateral_sigma_color,
                  1
                )}, blend=${fmtNum(pipe.params.blend, 3)}`
              : "—",
          ],
        ])
      );
    }

    const gd = report.geometry_delta || {};
    parts.push(
      card("Geometry delta", [
        ["Resolution preserved", gd.resolution_preserved ? "yes" : "no"],
        ["Width scale", fmtNum(gd.width_scale, 4)],
        ["Height scale", fmtNum(gd.height_scale, 4)],
        ["Pixel count ratio", fmtNum(gd.pixel_count_ratio, 4)],
        [
          "File size ratio",
          gd.file_bytes_ratio != null ? fmtNum(gd.file_bytes_ratio, 3) : "—",
        ],
      ])
    );

    const pd = report.pixel_difference || {};
    const thr = pd.pct_pixels_max_abs_over || {};
    parts.push(
      card("Pixel difference (src→out)", [
        ["MAE", fmtNum(pd.mae)],
        [
          "MAE RGB",
          Array.isArray(pd.mae_rgb) ? pd.mae_rgb.map((x) => fmtNum(x)).join(" · ") : "—",
        ],
        ["RMSE", fmtNum(pd.rmse)],
        ["PSNR (dB)", fmtNum(pd.psnr_db)],
        ["Max |Δ|", fmtNum(pd.max_abs, 1)],
        [
          "Mean signed Δ RGB",
          Array.isArray(pd.mean_signed_delta_rgb)
            ? pd.mean_signed_delta_rgb.map((x) => fmtNum(x)).join(" · ")
            : "—",
        ],
        [
          "Std Δ RGB",
          Array.isArray(pd.std_delta_rgb)
            ? pd.std_delta_rgb.map((x) => fmtNum(x)).join(" · ")
            : "—",
        ],
        ["% pixels max|Δ| > 1", `${fmtNum(thr["1"], 2)}%`],
        ["% pixels max|Δ| > 5", `${fmtNum(thr["5"], 2)}%`],
        ["% pixels max|Δ| > 10", `${fmtNum(thr["10"], 2)}%`],
        ["% pixels max|Δ| > 20", `${fmtNum(thr["20"], 2)}%`],
        ["% pixels max|Δ| > 40", `${fmtNum(thr["40"], 2)}%`],
        ["Compare note", report.comparison_note || "—"],
      ])
    );

    const ld = report.luminance_delta || {};
    parts.push(
      card("Luminance delta", [
        ["Source mean / std", `${fmtNum(ld.source_mean)} / ${fmtNum(ld.source_std)}`],
        ["Output mean / std", `${fmtNum(ld.output_mean)} / ${fmtNum(ld.output_std)}`],
        [
          "Mean Δ",
          fmtNum(ld.mean_delta),
          deltaClass(ld.mean_delta),
        ],
        ["Std Δ", fmtNum(ld.std_delta)],
      ])
    );

    const cd = report.color_delta || {};
    parts.push(
      card("Color delta (RGB means)", [
        [
          "Δ R · G · B",
          Array.isArray(cd.mean_delta_rgb)
            ? cd.mean_delta_rgb.map((x) => fmtNum(x)).join(" · ")
            : "—",
        ],
      ])
    );

    const hf = report.high_frequency_delta || {};
    parts.push(
      card("High-frequency delta", [
        [
          "Laplacian var src → out",
          `${fmtNum(hf.laplacian_variance_source)} → ${fmtNum(hf.laplacian_variance_output)}`,
        ],
        [
          "Laplacian var % change",
          `${fmtNum(hf.laplacian_variance_pct_change)}%`,
          deltaClass(hf.laplacian_variance_pct_change, true),
        ],
        [
          "Mean |L| src → out",
          `${fmtNum(hf.laplacian_mean_abs_source)} → ${fmtNum(hf.laplacian_mean_abs_output)}`,
        ],
        [
          "Mean |L| % change",
          `${fmtNum(hf.laplacian_mean_abs_pct_change)}%`,
          deltaClass(hf.laplacian_mean_abs_pct_change, true),
        ],
      ])
    );

    const nd = report.noise_proxy_delta || {};
    parts.push(
      card("Noise proxy delta", [
        [
          "Residual std src → out",
          `${fmtNum(nd.residual_std_source)} → ${fmtNum(nd.residual_std_output)}`,
        ],
        [
          "Residual std % change",
          `${fmtNum(nd.residual_std_pct_change)}%`,
          deltaClass(nd.residual_std_pct_change, true),
        ],
        [
          "Local std mean src → out",
          `${fmtNum(nd.local_std_mean_source)} → ${fmtNum(nd.local_std_mean_output)}`,
        ],
        [
          "Local std mean % change",
          `${fmtNum(nd.local_std_mean_pct_change)}%`,
          deltaClass(nd.local_std_mean_pct_change, true),
        ],
        [
          "Local std median % change",
          `${fmtNum(nd.local_std_median_pct_change)}%`,
          deltaClass(nd.local_std_median_pct_change, true),
        ],
      ])
    );

    const ss = report.structural_similarity || {};
    parts.push(
      card("Structural similarity (global)", [
        ["Luma SSIM-like", fmtNum(ss.luma_ssim_global, 4)],
        ["R / G / B", `${fmtNum(ss.r_ssim_global, 4)} / ${fmtNum(ss.g_ssim_global, 4)} / ${fmtNum(ss.b_ssim_global, 4)}`],
      ])
    );

    parts.push(`<p class="section-title" style="margin:0.5rem 0">Source metrics</p>`);
    parts.push(renderSourceMetrics(report.source || state.sourceMetrics));
    if (report.output) {
      parts.push(`<p class="section-title" style="margin:0.5rem 0">Output metrics</p>`);
      parts.push(renderSourceMetrics(report.output));
    }

    return parts.join("");
  }

  function refreshMetrics() {
    if (state.report) {
      els.metricsRoot.innerHTML = renderReport(state.report);
    } else if (state.sourceMetrics) {
      els.metricsRoot.innerHTML = renderSourceMetrics(state.sourceMetrics);
    } else {
      els.metricsRoot.innerHTML =
        '<div class="empty-metrics">Upload an image to see technical metrics.</div>';
    }
  }

  function setPreview() {
    const img = els.previewImg;
    if (!state.sourceUrl && !state.outputUrl) {
      img.hidden = true;
      els.placeholder.hidden = false;
      els.compareWrap.classList.remove("active");
      els.singleView.style.display = "grid";
      return;
    }
    els.placeholder.hidden = true;

    if (state.view === "compare" && state.sourceUrl && state.outputUrl) {
      els.singleView.style.display = "none";
      els.compareWrap.classList.add("active");
      els.compareBefore.src = state.sourceUrl;
      els.compareAfter.src = state.outputUrl;
      return;
    }

    els.compareWrap.classList.remove("active");
    els.singleView.style.display = "grid";
    img.hidden = false;
    if (state.view === "output" && state.outputUrl) {
      img.src = state.outputUrl;
    } else if (state.sourceUrl) {
      img.src = state.sourceUrl;
    }
  }

  // ── API ─────────────────────────────────────────────────────────────
  async function checkHealth() {
    try {
      const r = await fetch("/api/health");
      if (!r.ok) throw new Error("bad");
      els.healthBadge.classList.add("ok");
      els.healthBadge.innerHTML = '<span class="dot"></span> local';
    } catch {
      els.healthBadge.classList.remove("ok");
      els.healthBadge.innerHTML = '<span class="dot"></span> offline';
    }
  }

  async function analyzeFile(file) {
    setStatus("Analyzing image…", "busy");
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/analyze", { method: "POST", body: fd });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.statusText);
    }
    const data = await r.json();
    state.jobId = data.job_id;
    state.sourceMetrics = data.metrics;
    state.report = null;
    state.sourceUrl = data.preview_url + `?t=${Date.now()}`;
    state.outputUrl = null;
    state.view = "source";
    $$("#viewToggle button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === "source")
    );
    els.jobBadge.textContent = data.job_id;
    els.btnDenoise.disabled = false;
    els.btnAnalyze.disabled = false;
    els.btnDownload.disabled = true;
    const g = data.metrics.geometry;
    els.fileMeta.textContent = `${file.name} · ${g.width}×${g.height} · ${fmtBytes(
      g.file_bytes
    )}`;
    refreshMetrics();
    setPreview();
    setStatus("Analysis complete");
  }

  async function runDenoise() {
    if (!state.file && !state.jobId) return;
    setStatus("Denoising… this may take a few seconds for large images", "busy");
    els.btnDenoise.disabled = true;
    const fd = new FormData();
    if (state.jobId) fd.append("job_id", state.jobId);
    if (state.file) fd.append("file", state.file);
    fd.append("controls_json", JSON.stringify(collectControls()));
    try {
      const r = await fetch("/api/denoise", { method: "POST", body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(typeof err.detail === "string" ? err.detail : r.statusText);
      }
      const data = await r.json();
      state.jobId = data.job_id;
      state.report = data.report;
      state.sourceUrl = data.source_url + `?t=${Date.now()}`;
      state.outputUrl = data.output_url;
      state.view = "compare";
      $$("#viewToggle button").forEach((b) =>
        b.classList.toggle("active", b.dataset.view === "compare")
      );
      els.jobBadge.textContent = data.job_id;
      els.btnDownload.disabled = false;
      els.btnDownload.onclick = () => {
        window.location.href = data.download_url;
      };
      refreshMetrics();
      setPreview();
      const psnr = data.report?.pixel_difference?.psnr_db;
      const hf = data.report?.high_frequency_delta?.laplacian_variance_pct_change;
      setStatus(
        `Done · PSNR ${fmtNum(psnr)} dB · Laplacian var ${fmtNum(hf)}%`
      );
    } catch (e) {
      setStatus(e.message || String(e), "error");
    } finally {
      els.btnDenoise.disabled = false;
    }
  }

  // ── events ──────────────────────────────────────────────────────────
  function onFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      setStatus("Please choose an image file", "error");
      return;
    }
    state.file = file;
    analyzeFile(file).catch((e) => setStatus(e.message || String(e), "error"));
  }

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") els.fileInput.click();
  });
  els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files?.[0]) onFile(els.fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("dragover");
    });
  });
  els.dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });

  els.btnDenoise.addEventListener("click", () => runDenoise());
  els.btnAnalyze.addEventListener("click", () => {
    if (state.file) analyzeFile(state.file).catch((e) => setStatus(e.message, "error"));
  });
  els.btnReset.addEventListener("click", () => {
    $("#strength").value = 50;
    $("#strengthNum").value = 50;
    $("#strengthVal").textContent = "50%";
    ["lapVar", "resStd", "locStd"].forEach((id) => {
      $(`#${id}`).value = 0;
      $(`#${id}Num`).value = 0;
      $(`#${id}Val`).textContent = "0%";
    });
    ["lumOff", "rOff", "gOff", "bOff"].forEach((id) => {
      $(`#${id}`).value = 0;
      $(`#${id}Num`).value = 0;
      $(`#${id}Val`).textContent = "0";
    });
    $("#algorithm").value = "hybrid";
    $("#jpegQ").value = 95;
    $("#jpegQNum").value = 95;
    $("#jpegQVal").textContent = "95";
    $("#scale").value = 1;
    $("#scaleNum").value = 1;
    $("#scaleVal").textContent = "1.00×";
    $("#preserveRes").checked = true;
    $("#nlmH").value = 0;
    $("#bilSigmaC").value = 0;
    $("#bilSigmaS").value = 0;
    $("#gaussSigma").value = 0;
    setStatus("Controls reset");
  });

  els.toggleAdvanced.addEventListener("click", () => {
    els.advanced.classList.toggle("open");
    els.toggleAdvanced.textContent = els.advanced.classList.contains("open")
      ? "Advanced parameters ▾"
      : "Advanced parameters ▸";
  });

  $$("#viewToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      $$("#viewToggle button").forEach((b) => b.classList.toggle("active", b === btn));
      setPreview();
    });
  });

  // Compare slider
  (function initCompareSlider() {
    const wrap = els.compareWrap;
    const slider = els.compareSlider;
    let dragging = false;
    const setX = (clientX) => {
      const rect = wrap.getBoundingClientRect();
      let x = (clientX - rect.left) / rect.width;
      x = Math.min(0.95, Math.max(0.05, x));
      slider.style.left = `${x * 100}%`;
      els.compareAfter.style.clipPath = `inset(0 0 0 ${x * 100}%)`;
    };
    slider.addEventListener("mousedown", (e) => {
      dragging = true;
      e.preventDefault();
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) setX(e.clientX);
    });
    wrap.addEventListener("click", (e) => {
      if (e.target === slider) return;
      setX(e.clientX);
    });
  })();

  checkHealth();
  setInterval(checkHealth, 15000);
})();
