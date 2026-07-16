/**
 * PhotoEditor client — upload, analyze, denoise, render technical metrics.
 */
(() => {
  "use strict";

  const ZOOM_MIN = 5;
  const ZOOM_MAX = 800;
  const ZOOM_STEP = 10; // percentage points for ± buttons

  const state = {
    file: null,
    jobId: null,
    sourceUrl: null,
    outputUrl: null,
    sourceMetrics: null,
    report: null,
    view: "source",
    /** Display size as % of native pixels (100 = 1 CSS px per image px). */
    zoomPct: 100,
    /** When true, next layout will set zoom to fit-in-view. */
    fitOnLoad: true,
    naturalW: 0,
    naturalH: 0,
    /** Persistence */
    projectId: null,
    libraryEntryId: null,
    filename: null,
    history: [], // undo steps (blobs + metadata)
    historyIndex: -1,
    sideTab: "metrics",
    _objectUrls: [],
    _restoring: false,
    _sessionTimer: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const els = {
    dropzone: $("#dropzone"),
    fileInput: $("#fileInput"),
    fileMeta: $("#fileMeta"),
    uploadProgress: $("#uploadProgress"),
    uploadProgressLabel: $("#uploadProgressLabel"),
    uploadProgressPct: $("#uploadProgressPct"),
    uploadProgressFill: $("#uploadProgressFill"),
    uploadProgressBar: $("#uploadProgressBar"),
    errorLogBadge: $("#errorLogBadge"),
    status: $("#status"),
    statusText: $("#statusText"),
    healthBadge: $("#healthBadge"),
    cacheBadge: $("#cacheBadge"),
    cacheMeta: $("#cacheMeta"),
    jobBadge: $("#jobBadge"),
    metricsRoot: $("#metricsRoot"),
    historyRoot: $("#historyRoot"),
    libraryRoot: $("#libraryRoot"),
    sideTabs: $("#sideTabs"),
    previewImg: $("#previewImg"),
    placeholder: $("#placeholder"),
    singleView: $("#singleView"),
    compareWrap: $("#compareWrap"),
    compareBefore: $("#compareBefore"),
    compareAfter: $("#compareAfter"),
    compareSlider: $("#compareSlider"),
    previewStage: $("#previewStage"),
    previewScroll: $("#previewScroll"),
    previewCanvas: $("#previewCanvas"),
    zoomPctInput: $("#zoomPctInput"),
    zoomMeta: $("#zoomMeta"),
    zoomIn: $("#zoomIn"),
    zoomOut: $("#zoomOut"),
    zoomFit: $("#zoomFit"),
    zoom100: $("#zoom100"),
    btnDenoise: $("#btnDenoise"),
    applyProgress: $("#applyProgress"),
    applyProgressLabel: $("#applyProgressLabel"),
    applyProgressPct: $("#applyProgressPct"),
    applyProgressFill: $("#applyProgressFill"),
    applyProgressBar: $("#applyProgressBar"),
    previewProcessing: $("#previewProcessing"),
    previewProcessingTitle: $("#previewProcessingTitle"),
    previewProcessingFill: $("#previewProcessingFill"),
    previewProcessingPct: $("#previewProcessingPct"),
    btnAnalyze: $("#btnAnalyze"),
    btnDownload: $("#btnDownload"),
    btnReset: $("#btnReset"),
    btnUndo: $("#btnUndo"),
    btnRedo: $("#btnRedo"),
    btnSaveSession: $("#btnSaveSession"),
    btnClearSession: $("#btnClearSession"),
    btnClearHistory: $("#btnClearHistory"),
    btnClearLibrary: $("#btnClearLibrary"),
    btnClearAllCache: $("#btnClearAllCache"),
    toggleAdvanced: $("#toggleAdvanced"),
    advanced: $("#advanced"),
  };

  const Store = window.PEStore;
  const Log = window.PELog;

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
  function refreshErrorLogBadge() {
    if (!els.errorLogBadge || !Log) return;
    const n = Log.count();
    if (n > 0) {
      els.errorLogBadge.hidden = false;
      els.errorLogBadge.textContent = n > 99 ? "99+" : String(n);
    } else {
      els.errorLogBadge.hidden = true;
    }
  }

  function logIssue(level, source, message, meta) {
    if (!Log) return;
    if (level === "error") Log.error(source, message, meta);
    else if (level === "warning") Log.warning(source, message, meta);
    refreshErrorLogBadge();
  }

  function setStatus(text, mode = "", opts = {}) {
    els.status.className = `status-bar ${mode}`.trim();
    els.statusText.textContent = text;
    if (mode === "error") {
      logIssue("error", opts.source || "app", text, opts.meta);
    } else if (mode === "warning") {
      logIssue("warning", opts.source || "app", text, opts.meta);
    }
  }

  function setUploadProgress(pct, label) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (els.uploadProgress) els.uploadProgress.hidden = false;
    if (els.uploadProgressFill) els.uploadProgressFill.style.width = `${p}%`;
    if (els.uploadProgressPct) els.uploadProgressPct.textContent = `${p}%`;
    if (els.uploadProgressBar) els.uploadProgressBar.setAttribute("aria-valuenow", String(p));
    if (els.uploadProgressLabel && label) els.uploadProgressLabel.textContent = label;
    if (els.dropzone) els.dropzone.classList.add("is-uploading");
  }

  function hideUploadProgress() {
    if (els.uploadProgress) els.uploadProgress.hidden = true;
    if (els.uploadProgressFill) els.uploadProgressFill.style.width = "0%";
    if (els.uploadProgressPct) els.uploadProgressPct.textContent = "0%";
    if (els.dropzone) els.dropzone.classList.remove("is-uploading");
  }

  /** POST FormData with upload progress (XHR). Returns parsed JSON. */
  function postFormWithUploadProgress(url, formData, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.withCredentials = true;
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) {
          if (onProgress) onProgress(null, "Uploading…");
          return;
        }
        const pct = (e.loaded / e.total) * 100;
        if (onProgress) onProgress(pct, "Uploading image…");
      };
      xhr.upload.onload = () => {
        if (onProgress) onProgress(100, "Upload complete · analyzing…");
      };
      xhr.onerror = () => reject(new Error("Network error during upload."));
      xhr.onabort = () => reject(new Error("Upload aborted."));
      xhr.onload = () => {
        const status = xhr.status;
        const data = xhr.response;
        if (status >= 200 && status < 300) {
          resolve(data && typeof data === "object" ? data : {});
          return;
        }
        let msg = xhr.statusText || `HTTP ${status}`;
        try {
          const body = data || JSON.parse(xhr.responseText || "{}");
          if (typeof body.detail === "string") msg = body.detail;
          else if (Array.isArray(body.detail)) {
            msg = body.detail.map((d) => d.msg || JSON.stringify(d)).join("; ");
          }
        } catch {
          /* ignore */
        }
        reject(new Error(msg));
      };
      xhr.send(formData);
    });
  }

  function trackUrl(url) {
    if (url && url.startsWith("blob:")) state._objectUrls.push(url);
    return url;
  }

  function revokeTrackedUrls() {
    state._objectUrls.forEach((u) => {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    });
    state._objectUrls = [];
  }

  function urlFromBlob(blob) {
    if (!blob) return null;
    return trackUrl(URL.createObjectURL(blob));
  }

  function setCacheBadge(ok, label) {
    if (!els.cacheBadge) return;
    els.cacheBadge.classList.toggle("cached", !!ok);
    els.cacheBadge.innerHTML = `<span class="dot"></span> ${label || (ok ? "cached" : "cache")}`;
  }

  async function refreshCacheMeta() {
    if (!els.cacheMeta || !Store) return;
    try {
      const est = await Store.estimateUsage();
      const sess = await Store.loadSession();
      const hist = await Store.loadHistoryState();
      const lib = await Store.listLibrary();
      const usage =
        est.usage != null ? `${(est.usage / (1024 * 1024)).toFixed(1)} MB used` : "usage n/a";
      const when = sess?.savedAt ? new Date(sess.savedAt).toLocaleString() : "none";
      els.cacheMeta.textContent = `Cache: session ${when} · undo ${hist.steps?.length || 0} · library ${lib.length} · ${usage}`;
      setCacheBadge(!!sess, sess ? "cached" : "cache");
    } catch {
      els.cacheMeta.textContent = "Cache: unavailable";
    }
  }

  function applyControlsToForm(controls) {
    if (!controls) return;
    const setPair = (id, val, fmt) => {
      const r = document.getElementById(id);
      const n = document.getElementById(id + "Num");
      const h = document.getElementById(id + "Val");
      if (r) r.value = val;
      if (n) n.value = val;
      if (h && fmt) h.textContent = fmt(val);
    };
    if (controls.strength_pct != null) setPair("strength", controls.strength_pct, (v) => `${v}%`);
    if (controls.laplacian_variance_reduce_pct != null)
      setPair("lapVar", controls.laplacian_variance_reduce_pct, (v) => `${v}%`);
    if (controls.residual_std_reduce_pct != null)
      setPair("resStd", controls.residual_std_reduce_pct, (v) => `${v}%`);
    if (controls.local_std_mean_reduce_pct != null)
      setPair("locStd", controls.local_std_mean_reduce_pct, (v) => `${v}%`);
    if (controls.luminance_offset != null) setPair("lumOff", controls.luminance_offset, String);
    if (controls.r_offset != null) setPair("rOff", controls.r_offset, String);
    if (controls.g_offset != null) setPair("gOff", controls.g_offset, String);
    if (controls.b_offset != null) setPair("bOff", controls.b_offset, String);
    if (controls.jpeg_quality != null) setPair("jpegQ", controls.jpeg_quality, String);
    if (controls.scale != null) setPair("scale", controls.scale, (v) => `${Number(v).toFixed(2)}×`);
    if (controls.algorithm) $("#algorithm").value = controls.algorithm;
    if (controls.preserve_resolution != null) $("#preserveRes").checked = !!controls.preserve_resolution;
    if (controls.nlm_h != null) $("#nlmH").value = controls.nlm_h;
    if (controls.bilateral_sigma_color != null) $("#bilSigmaC").value = controls.bilateral_sigma_color;
    if (controls.bilateral_sigma_space != null) $("#bilSigmaS").value = controls.bilateral_sigma_space;
    if (controls.gaussian_sigma != null) $("#gaussSigma").value = controls.gaussian_sigma;
  }

  function briefReportSummary(report) {
    if (!report) return null;
    const pd = report.pixel_difference || {};
    const hf = report.high_frequency_delta || {};
    const nd = report.noise_proxy_delta || {};
    const pipe = report.pipeline || {};
    return {
      algorithm: pipe.algorithm,
      strength_pct: pipe.effective_strength_pct,
      psnr_db: pd.psnr_db,
      mae: pd.mae,
      laplacian_var_pct: hf.laplacian_variance_pct_change,
      residual_std_pct: nd.residual_std_pct_change,
      resolution_preserved: (report.geometry_delta || {}).resolution_preserved,
    };
  }

  function formatStepSummary(step) {
    if (!step) return "";
    if (step.summary) return step.summary;
    const s = step.reportSummary;
    if (!s) return step.label || "Step";
    const bits = [];
    if (s.psnr_db != null) bits.push(`PSNR ${fmtNum(s.psnr_db)} dB`);
    if (s.laplacian_var_pct != null) bits.push(`HF ${fmtNum(s.laplacian_var_pct)}%`);
    if (s.residual_std_pct != null) bits.push(`noise ${fmtNum(s.residual_std_pct)}%`);
    return bits.join(" · ") || step.label;
  }

  function updateUndoRedoButtons() {
    els.btnUndo.disabled = state.historyIndex <= 0;
    els.btnRedo.disabled =
      state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
  }

  // ── Persistence: session / history / library ────────────────────────
  function scheduleSessionSave() {
    if (state._restoring || !Store) return;
    clearTimeout(state._sessionTimer);
    state._sessionTimer = setTimeout(() => {
      persistSession().catch(() => {});
    }, 600);
  }

  async function persistSession() {
    if (!Store || state._restoring) return;
    const sourceBlob =
      state.file ||
      (await Store.blobFromUrl(state.sourceUrl)) ||
      (state.history[state.historyIndex] && state.history[state.historyIndex].sourceBlob);
    const outputBlob =
      (await Store.blobFromUrl(state.outputUrl)) ||
      (state.history[state.historyIndex] && state.history[state.historyIndex].outputBlob);

    // Keep history steps' blobs; strip heavy report objects already summarized
    const histLite = {
      projectId: state.projectId,
      index: state.historyIndex,
      steps: state.history.map((s) => ({
        id: s.id,
        at: s.at,
        label: s.label,
        summary: s.summary,
        controls: s.controls,
        jobId: s.jobId,
        view: s.view,
        filename: s.filename,
        sourceBlob: s.sourceBlob,
        outputBlob: s.outputBlob || null,
        sourceMetrics: s.sourceMetrics,
        reportSummary: s.reportSummary,
        report: s.report || null,
      })),
    };

    await Store.saveHistoryState(histLite);
    await Store.saveSession({
      projectId: state.projectId,
      libraryEntryId: state.libraryEntryId,
      jobId: state.jobId,
      filename: state.filename || state.file?.name || null,
      view: state.view,
      zoomPct: state.zoomPct,
      controls: collectControls(),
      sourceMetrics: state.sourceMetrics,
      report: state.report,
      historyIndex: state.historyIndex,
      sourceBlob: sourceBlob || null,
      outputBlob: outputBlob || null,
      fileName: state.filename || state.file?.name || "image",
      fileType: state.file?.type || sourceBlob?.type || "image/jpeg",
    });
    setCacheBadge(true, "cached");
    refreshCacheMeta();
  }

  async function pushHistoryStep(step) {
    // Drop redo tail
    if (state.historyIndex < state.history.length - 1) {
      state.history = state.history.slice(0, state.historyIndex + 1);
    }
    state.history.push(step);
    if (state.history.length > Store.MAX_HISTORY) {
      const drop = state.history.length - Store.MAX_HISTORY;
      state.history = state.history.slice(drop);
    }
    state.historyIndex = state.history.length - 1;
    updateUndoRedoButtons();
    renderHistoryPanel();
    await persistSession();
  }

  function clearPreviewImages() {
    const imgs = [els.previewImg, els.compareBefore, els.compareAfter];
    imgs.forEach((img) => {
      if (!img) return;
      img.onload = null;
      img.onerror = null;
      img.removeAttribute("src");
      img.src = "";
      img.hidden = true;
    });
    if (els.compareWrap) els.compareWrap.classList.remove("active");
    if (els.singleView) els.singleView.style.display = "grid";
    if (els.placeholder) els.placeholder.hidden = false;
    state.naturalW = 0;
    state.naturalH = 0;
    if (els.zoomMeta) els.zoomMeta.textContent = "Size —";
  }

  function showBlankWorkspace(message) {
    revokeTrackedUrls();
    state.sourceUrl = null;
    state.outputUrl = null;
    state.file = null;
    state.naturalW = 0;
    state.naturalH = 0;
    clearPreviewImages();
    applyZoomLayout();
    if (els.btnDenoise) els.btnDenoise.disabled = true;
    if (els.btnAnalyze) els.btnAnalyze.disabled = true;
    if (els.btnDownload) els.btnDownload.disabled = true;
    if (els.fileMeta) els.fileMeta.textContent = "No image loaded";
    if (els.jobBadge) els.jobBadge.textContent = "no job";
    if (message) setStatus(message);
  }

  function isUsableBlob(b) {
    return !!(b && typeof b.size === "number" && b.size > 0);
  }

  async function rehydrateStepFromServer(step) {
    if (!step) return step;
    const next = { ...step };
    if (!isUsableBlob(next.sourceBlob) && next.jobId) {
      try {
        const r = await fetch(`/api/jobs/${next.jobId}/source`, {
          credentials: "same-origin",
        });
        if (r.ok) next.sourceBlob = await r.blob();
      } catch {
        /* ignore */
      }
    }
    if (!isUsableBlob(next.outputBlob) && next.jobId) {
      try {
        const r = await fetch(`/api/jobs/${next.jobId}/output`, {
          credentials: "same-origin",
        });
        if (r.ok) next.outputBlob = await r.blob();
      } catch {
        /* ignore */
      }
    }
    return next;
  }

  function applyHistoryStep(step, { fit = false } = {}) {
    if (!step) {
      showBlankWorkspace();
      return;
    }
    state._restoring = true;
    revokeTrackedUrls();

    const hasSource = isUsableBlob(step.sourceBlob);
    const hasOutput = isUsableBlob(step.outputBlob);

    if (!hasSource) {
      // Never keep a revoked/stale blob URL — that causes broken image icons
      state.sourceUrl = null;
      state.outputUrl = null;
      state.file = null;
      clearPreviewImages();
      state._restoring = false;
      setStatus("Could not restore image data for this step. Load an image to continue.");
      els.btnDenoise.disabled = true;
      els.btnAnalyze.disabled = true;
      els.btnDownload.disabled = true;
      els.fileMeta.textContent = step.filename
        ? `${step.filename} (preview unavailable)`
        : "Preview unavailable";
      return;
    }

    state.jobId = step.jobId || state.jobId;
    state.filename = step.filename || state.filename;
    state.sourceMetrics = step.sourceMetrics || state.sourceMetrics;
    state.report = step.report || null;
    state.view = hasOutput ? step.view || "compare" : "source";
    state.fitOnLoad = fit;
    state.sourceUrl = urlFromBlob(step.sourceBlob);
    state.outputUrl = hasOutput ? urlFromBlob(step.outputBlob) : null;
    state.file = new File(
      [step.sourceBlob],
      step.filename || state.filename || "image.jpg",
      { type: step.sourceBlob.type || "image/jpeg" }
    );
    if (step.controls) applyControlsToForm(step.controls);
    els.btnDenoise.disabled = !state.sourceUrl;
    els.btnAnalyze.disabled = !state.file;
    els.btnDownload.disabled = !state.outputUrl;
    if (state.outputUrl) {
      els.btnDownload.onclick = () => {
        const a = document.createElement("a");
        a.href = state.outputUrl;
        a.download = `photoeditor_${state.jobId || "edit"}_denoised.jpg`;
        a.click();
      };
    }
    els.jobBadge.textContent = state.jobId || "cached";
    els.fileMeta.textContent = state.filename
      ? `${state.filename}${state.sourceMetrics?.geometry ? ` · ${state.sourceMetrics.geometry.width}×${state.sourceMetrics.geometry.height}` : ""}`
      : "Restored session";
    $$("#viewToggle button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === state.view)
    );
    refreshMetrics();
    setPreview();
    updateUndoRedoButtons();
    renderHistoryPanel();
    state._restoring = false;
  }

  async function undo() {
    if (state.historyIndex <= 0) return;
    state.historyIndex -= 1;
    applyHistoryStep(state.history[state.historyIndex], { fit: false });
    await persistSession();
    setStatus(`Undo → ${state.history[state.historyIndex].label}`);
  }

  async function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex += 1;
    applyHistoryStep(state.history[state.historyIndex], { fit: false });
    await persistSession();
    setStatus(`Redo → ${state.history[state.historyIndex].label}`);
  }

  function renderHistoryPanel() {
    if (!els.historyRoot) return;
    if (!state.history.length) {
      els.historyRoot.innerHTML =
        '<div class="empty-metrics">No edit history yet. Upload an image and apply denoise to build an undo stack.</div>';
      return;
    }
    const items = state.history
      .map((step, i) => {
        const active = i === state.historyIndex ? "active" : "";
        const thumbSrc = step.outputBlob
          ? URL.createObjectURL(step.outputBlob)
          : step.sourceBlob
            ? URL.createObjectURL(step.sourceBlob)
            : "";
        if (thumbSrc) trackUrl(thumbSrc);
        const when = step.at ? new Date(step.at).toLocaleTimeString() : "";
        return `<button type="button" class="history-item ${active}" data-hist-idx="${i}">
          ${thumbSrc ? `<img class="thumb" src="${thumbSrc}" alt="" />` : `<div class="thumb"></div>`}
          <div class="meta">
            <strong>${step.label || "Step " + (i + 1)}</strong>
            <span>${formatStepSummary(step)}</span>
            <span>${when}</span>
          </div>
          <span class="idx">#${i + 1}</span>
        </button>`;
      })
      .join("");
    els.historyRoot.innerHTML = `<div class="history-list">${items}</div>
      <p class="help-text" style="margin-top:0.75rem">Click a step to restore it. Undo/Redo also move through this list.</p>`;
    els.historyRoot.querySelectorAll("[data-hist-idx]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = Number(btn.getAttribute("data-hist-idx"));
        state.historyIndex = idx;
        applyHistoryStep(state.history[idx], { fit: false });
        await persistSession();
        setStatus(`Restored: ${state.history[idx].label}`);
      });
    });
  }

  async function syncLibraryToServer(entry) {
    try {
      const fd = new FormData();
      if (entry.id) fd.append("entry_id", entry.id);
      fd.append("filename", entry.filename || "image");
      if (entry.jobId) fd.append("job_id", entry.jobId);
      fd.append("controls_json", JSON.stringify(entry.controls || {}));
      fd.append("history_json", JSON.stringify(entry.changelog || []));
      fd.append("report_summary_json", JSON.stringify(entry.reportSummary || null));
      if (entry.sourceBlob) {
        fd.append("source", entry.sourceBlob, entry.filename || "source.jpg");
      }
      if (entry.outputBlob) {
        fd.append("output", entry.outputBlob, "output.jpg");
      }
      const r = await fetch("/api/library", { method: "POST", body: fd });
      if (!r.ok) return null;
      const data = await r.json();
      return data.entry;
    } catch {
      return null;
    }
  }

  async function saveToLibrary() {
    if (!Store) return;
    const step = state.history[state.historyIndex];
    const sourceBlob =
      step?.sourceBlob ||
      state.file ||
      (await Store.blobFromUrl(state.sourceUrl));
    const outputBlob =
      step?.outputBlob || (await Store.blobFromUrl(state.outputUrl));
    if (!sourceBlob && !outputBlob) return;

    const changelog = state.history.map((s) => ({
      id: s.id,
      at: s.at,
      label: s.label,
      summary: s.summary || formatStepSummary(s),
      controls: s.controls,
    }));

    const id = state.libraryEntryId || Store.uid();
    const entry = {
      id,
      filename: state.filename || state.file?.name || "image",
      jobId: state.jobId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      controls: collectControls(),
      reportSummary: briefReportSummary(state.report),
      changelog,
      sourceBlob: sourceBlob || null,
      outputBlob: outputBlob || null,
      thumbBlob: outputBlob || sourceBlob || null,
    };
    // preserve createdAt if existing
    const prev = await Store.getLibraryEntry(id);
    if (prev?.createdAt) entry.createdAt = prev.createdAt;

    await Store.putLibraryEntry(entry);
    state.libraryEntryId = id;
    const serverEntry = await syncLibraryToServer(entry);
    if (serverEntry?.id) state.libraryEntryId = serverEntry.id;
    renderLibraryPanel();
    refreshCacheMeta();
  }

  async function renderLibraryPanel() {
    if (!els.libraryRoot || !Store) return;
    let local = [];
    try {
      local = await Store.listLibrary();
    } catch {
      local = [];
    }
    let server = [];
    try {
      const r = await fetch("/api/library");
      if (r.ok) {
        const data = await r.json();
        server = data.entries || [];
      }
    } catch {
      /* offline */
    }

    // Merge by id (prefer local blobs)
    const map = new Map();
    server.forEach((e) => map.set(e.id, { ...e, _server: true }));
    local.forEach((e) => {
      const prev = map.get(e.id) || {};
      map.set(e.id, { ...prev, ...e, _local: true });
    });
    const entries = [...map.values()].sort(
      (a, b) => (b.updatedAt || b.updated_at || 0) - (a.updatedAt || a.updated_at || 0)
    );

    if (!entries.length) {
      els.libraryRoot.innerHTML =
        '<div class="empty-metrics">No images in the repository yet. Denoise an image and it will be saved here with a change log.</div>';
      return;
    }

    const html = entries
      .map((e) => {
        const name = e.filename || "image";
        const when = new Date(e.updatedAt || e.updated_at || Date.now()).toLocaleString();
        const log = (e.changelog || e.history || []).slice(-4).reverse();
        const thumb = e.thumbBlob || e.outputBlob || e.sourceBlob;
        const thumbUrl = thumb ? trackUrl(URL.createObjectURL(thumb)) : e._server
          ? `/api/library/${e.id}/output?t=${e.updated_at || e.updatedAt || 0}`
          : "";
        const summary = e.reportSummary || e.report_summary || {};
        const sumLine = [
          summary.psnr_db != null ? `PSNR ${fmtNum(summary.psnr_db)}` : null,
          summary.algorithm || null,
        ]
          .filter(Boolean)
          .join(" · ");
        const logHtml = log.length
          ? `<ul class="changelog">${log
              .map(
                (c) =>
                  `<li>${c.label || "edit"}${c.summary ? " — " + c.summary : ""}</li>`
              )
              .join("")}</ul>`
          : "";
        return `<div class="library-item" data-lib-id="${e.id}">
          ${thumbUrl ? `<img class="thumb" src="${thumbUrl}" alt="" />` : `<div class="thumb"></div>`}
          <div class="meta">
            <strong>${name}</strong>
            <span>${when}${sumLine ? " · " + sumLine : ""}</span>
            ${logHtml}
            <div class="actions">
              <button type="button" class="btn" data-lib-open="${e.id}">Open</button>
              <button type="button" class="btn" data-lib-del="${e.id}">Delete</button>
            </div>
          </div>
        </div>`;
      })
      .join("");

    els.libraryRoot.innerHTML = `<div class="library-list">${html}</div>`;
    els.libraryRoot.querySelectorAll("[data-lib-open]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openLibraryEntry(btn.getAttribute("data-lib-open"));
      });
    });
    els.libraryRoot.querySelectorAll("[data-lib-del]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const id = btn.getAttribute("data-lib-del");
        if (!confirm("Delete this image from the repository?")) return;
        const serverId = Store.serverLibraryId ? Store.serverLibraryId(id) : id;
        await Store.deleteLibraryEntry(id);
        try {
          await fetch(`/api/library/${serverId}`, {
            method: "DELETE",
            credentials: "same-origin",
          });
        } catch {
          /* offline */
        }
        if (state.libraryEntryId === id || state.libraryEntryId === serverId) {
          state.libraryEntryId = null;
        }
        renderLibraryPanel();
        refreshCacheMeta();
        setStatus("Removed from library");
      });
    });
  }

  async function openLibraryEntry(id) {
    setStatus("Opening library entry…", "busy");
    const serverId = Store.serverLibraryId ? Store.serverLibraryId(id) : id;
    let entry = await Store.getLibraryEntry(id);
    if (!entry || (!entry.sourceBlob && !entry.outputBlob)) {
      // fetch from server
      try {
        const metaR = await fetch(`/api/library/${serverId}`, {
          credentials: "same-origin",
        });
        if (!metaR.ok) throw new Error("Not found");
        const meta = await metaR.json();
        let sourceBlob = null;
        let outputBlob = null;
        try {
          const s = await fetch(`/api/library/${serverId}/source`, {
            credentials: "same-origin",
          });
          if (s.ok) sourceBlob = await s.blob();
        } catch {
          /* */
        }
        try {
          const o = await fetch(`/api/library/${serverId}/output`, {
            credentials: "same-origin",
          });
          if (o.ok) outputBlob = await o.blob();
        } catch {
          /* */
        }
        entry = {
          id: serverId,
          filename: meta.filename,
          jobId: meta.job_id || meta.jobId,
          controls: meta.controls,
          reportSummary: meta.report_summary || meta.reportSummary,
          changelog: meta.history || meta.changelog || [],
          sourceBlob,
          outputBlob,
          thumbBlob: outputBlob || sourceBlob,
        };
        if (sourceBlob || outputBlob) await Store.putLibraryEntry({ ...entry, updatedAt: Date.now(), createdAt: Date.now() });
      } catch (e) {
        setStatus(e.message || "Could not open entry", "error");
        return;
      }
    }

    state.projectId = Store.uid();
    state.libraryEntryId = serverId;
    state.jobId = entry.jobId || null;
    state.filename = entry.filename;
    state.history = [];
    state.historyIndex = -1;

    if (entry.sourceBlob) {
      const orig = {
        id: Store.uid(),
        at: Date.now(),
        label: "Original (from library)",
        summary: entry.filename || "source",
        controls: entry.controls || collectControls(),
        jobId: state.jobId,
        view: "source",
        filename: entry.filename,
        sourceBlob: entry.sourceBlob,
        outputBlob: null,
        sourceMetrics: null,
        reportSummary: null,
        report: null,
      };
      state.history.push(orig);
      if (entry.outputBlob) {
        state.history.push({
          id: Store.uid(),
          at: Date.now(),
          label: "Library output",
          summary: formatStepSummary({ reportSummary: entry.reportSummary }),
          controls: entry.controls || collectControls(),
          jobId: state.jobId,
          view: "compare",
          filename: entry.filename,
          sourceBlob: entry.sourceBlob,
          outputBlob: entry.outputBlob,
          sourceMetrics: null,
          reportSummary: entry.reportSummary || null,
          report: null,
        });
      }
      // Expand changelog as metadata-only steps if longer
      state.historyIndex = state.history.length - 1;
      applyHistoryStep(state.history[state.historyIndex], { fit: true });
    }
    await persistSession();
    setSideTab("history");
    setStatus(`Opened “${entry.filename || id}” from library`);
  }

  function setSideTab(name) {
    state.sideTab = name;
    $$(".side-tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    els.metricsRoot.hidden = name !== "metrics";
    els.historyRoot.hidden = name !== "history";
    els.libraryRoot.hidden = name !== "library";
    if (name === "history") renderHistoryPanel();
    if (name === "library") renderLibraryPanel();
  }

  async function restoreSessionOnLoad() {
    if (!Store) {
      showBlankWorkspace();
      return;
    }
    try {
      const sess = await Store.loadSession();
      const hist = await Store.loadHistoryState();
      const hasSteps = !!(hist?.steps && hist.steps.length);

      if (!sess && !hasSteps) {
        showBlankWorkspace("Ready — drop an image to begin");
        refreshMetrics();
        refreshCacheMeta();
        updateUndoRedoButtons();
        renderHistoryPanel();
        return;
      }

      state._restoring = true;
      setStatus("Restoring your last session…", "busy");

      if (hasSteps) {
        // Rehydrate any steps that lost blob payloads (e.g. only job ids survived)
        const steps = [];
        for (const raw of hist.steps) {
          // eslint-disable-next-line no-await-in-loop
          steps.push(await rehydrateStepFromServer(raw));
        }
        state.history = steps;
        state.historyIndex = Math.min(
          Math.max(0, hist.index ?? steps.length - 1),
          steps.length - 1
        );
        state.projectId = hist.projectId || sess?.projectId || Store.uid();
        state.libraryEntryId = sess?.libraryEntryId || null;
        if (sess?.controls) applyControlsToForm(sess.controls);

        const step = state.history[state.historyIndex];
        if (isUsableBlob(step?.sourceBlob)) {
          applyHistoryStep(step, { fit: true });
          setCacheBadge(true, "restored");
          setStatus(
            `Restored “${step.filename || "last image"}”${step.label ? ` · ${step.label}` : ""}`
          );
        } else {
          // Keep history metadata but show clean blank preview
          state._restoring = false;
          showBlankWorkspace(
            "Your edit history was found, but the image files are no longer available. Load an image to continue."
          );
          updateUndoRedoButtons();
          renderHistoryPanel();
        }
      } else if (sess) {
        // Session without full history — try blobs, then job endpoints
        let sourceBlob = isUsableBlob(sess.sourceBlob) ? sess.sourceBlob : null;
        let outputBlob = isUsableBlob(sess.outputBlob) ? sess.outputBlob : null;
        if (!sourceBlob && sess.jobId) {
          sourceBlob = await Store.blobFromUrl(`/api/jobs/${sess.jobId}/source`);
        }
        if (!outputBlob && sess.jobId) {
          outputBlob = await Store.blobFromUrl(`/api/jobs/${sess.jobId}/output`);
        }

        state.projectId = sess.projectId || Store.uid();
        state.libraryEntryId = sess.libraryEntryId || null;
        state.jobId = sess.jobId;
        state.filename = sess.filename || sess.fileName;
        state.sourceMetrics = sess.sourceMetrics;
        state.report = sess.report;
        state.view = sess.view || (outputBlob ? "compare" : "source");
        state.zoomPct = sess.zoomPct || 100;
        if (sess.controls) applyControlsToForm(sess.controls);

        if (sourceBlob) {
          state.sourceUrl = urlFromBlob(sourceBlob);
          state.outputUrl = outputBlob ? urlFromBlob(outputBlob) : null;
          state.file = new File([sourceBlob], state.filename || "image.jpg", {
            type: sourceBlob.type || sess.fileType || "image/jpeg",
          });
          // Seed history so undo/UI stay consistent
          state.history = [
            {
              id: Store.uid(),
              at: Date.now(),
              label: "Restored session",
              summary: state.filename || "cached image",
              controls: sess.controls || collectControls(),
              jobId: state.jobId,
              view: state.view,
              filename: state.filename,
              sourceBlob,
              outputBlob: outputBlob || null,
              sourceMetrics: state.sourceMetrics,
              reportSummary: briefReportSummary(state.report),
              report: state.report,
            },
          ];
          state.historyIndex = 0;
          els.btnDenoise.disabled = false;
          els.btnAnalyze.disabled = false;
          els.btnDownload.disabled = !state.outputUrl;
          els.jobBadge.textContent = state.jobId || "cached";
          els.fileMeta.textContent = `${state.filename || "Restored"} (from cache)`;
          $$("#viewToggle button").forEach((b) =>
            b.classList.toggle("active", b.dataset.view === state.view)
          );
          refreshMetrics();
          setPreview();
          setCacheBadge(true, "restored");
          setStatus(`Restored “${state.filename || "last image"}” from your last session`);
        } else {
          showBlankWorkspace(
            "Welcome back — no saved image for this profile. Drop a photo to start."
          );
          refreshMetrics();
        }
      }

      state._restoring = false;
      updateUndoRedoButtons();
      renderHistoryPanel();
      refreshCacheMeta();
      // Persist rehydrated blobs so next login is instant
      if (state.sourceUrl) persistSession().catch(() => {});
    } catch (e) {
      state._restoring = false;
      console.warn("Session restore failed", e);
      showBlankWorkspace("Could not restore session. Drop an image to start.");
      refreshCacheMeta();
    }
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Remember which metric categories are open across re-renders. */
  const categoryOpenState = new Map();

  /**
   * Build an expandable metrics category.
   * @param {object} opts
   * @param {string} opts.id stable id for open-state
   * @param {string} opts.title
   * @param {string} [opts.summary] short header preview
   * @param {string} [opts.descriptor] full category description
   * @param {Array} opts.rows [label, value, class?, description?]
   * @param {boolean} [opts.defaultOpen]
   */
  function metricCategory({ id, title, summary = "", descriptor = "", rows = [], defaultOpen = false }) {
    const open =
      categoryOpenState.has(id) ? categoryOpenState.get(id) : defaultOpen;
    const items = rows
      .map((row, i) => {
        const [label, value, cls, description] = row;
        const raw = value == null || value === "" ? "—" : String(value);
        const desc = description || METRIC_DESCRIPTORS[label] || "";
        const long = raw.length > 56 || raw.includes("\n");
        const rowId = `${id}-r${i}`;
        return `<div class="metric-row" data-row-id="${escapeHtml(rowId)}">
          <div class="metric-row-head">
            <button type="button" class="metric-label-btn" data-desc-toggle aria-expanded="false" title="Show descriptor">
              <span class="metric-label-text">${escapeHtml(label)}</span>
              ${desc ? `<span class="metric-info-icon" aria-hidden="true">i</span>` : ""}
            </button>
            <button type="button" class="metric-value-btn ${cls || ""} ${long ? "is-clampable" : ""}" data-value-toggle aria-expanded="false" title="Expand full value">
              <span class="metric-value-text ${long ? "is-clamped" : ""}">${escapeHtml(raw)}</span>
            </button>
          </div>
          ${
            desc
              ? `<div class="metric-descriptor" hidden>
                  <strong>About this metric</strong>
                  <p>${escapeHtml(desc)}</p>
                </div>`
              : ""
          }
          ${
            long
              ? `<div class="metric-value-full" hidden>
                  <strong>Full value</strong>
                  <pre class="metric-value-pre">${escapeHtml(raw)}</pre>
                </div>`
              : ""
          }
        </div>`;
      })
      .join("");

    return `<details class="metric-category" data-cat-id="${escapeHtml(id)}" ${open ? "open" : ""}>
      <summary class="metric-category-summary">
        <span class="cat-chevron" aria-hidden="true"></span>
        <span class="cat-title">${escapeHtml(title)}</span>
        ${summary ? `<span class="cat-summary">${escapeHtml(summary)}</span>` : ""}
        <span class="cat-count">${rows.length}</span>
      </summary>
      <div class="metric-category-body">
        ${
          descriptor
            ? `<div class="cat-descriptor">
                <button type="button" class="cat-descriptor-toggle" data-cat-desc-toggle aria-expanded="false">
                  About this category
                </button>
                <div class="cat-descriptor-body" hidden>
                  <p>${escapeHtml(descriptor)}</p>
                </div>
              </div>`
            : ""
        }
        <div class="metric-rows">${items}</div>
      </div>
    </details>`;
  }

  /** Full plain-language descriptors for metric labels. */
  const METRIC_DESCRIPTORS = {
    Method:
      "Processing approach used for this result. Classical OpenCV denoise preserves resolution by default; it is not a generative re-synthesis of the photo.",
    Algorithm:
      "Denoise algorithm selected: hybrid (NLM + bilateral), non-local means (nlm), bilateral, gaussian, or median.",
    "Requested strength":
      "Master strength percentage you set (0–100). Maps to algorithm parameters such as NLM h and bilateral sigma.",
    "Effective strength":
      "Strength actually applied after optional category-target search (e.g. residual-std reduction goals).",
    Note: "Short pipeline note (algorithm, strength, or bypass when strength ≈ 0).",
    "Auto params":
      "Internal parameters derived from strength: NLM h, bilateral σ color/space, blend factor with the original.",
    "Resolution preserved":
      "Whether output width×height matches the processed source. PhotoEditor defaults to preserving resolution.",
    "Width scale": "output_width / source_width. 1.0 means no horizontal resize.",
    "Height scale": "output_height / source_height. 1.0 means no vertical resize.",
    "Pixel count ratio": "output_pixels / source_pixels. Below 1.0 means fewer pixels (downscale).",
    "File size ratio": "output_file_bytes / source_file_bytes after JPEG encode (not a quality score).",
    MAE: "Mean Absolute Error: average |output − source| over all channels (0–255 scale). Lower means closer to source.",
    "MAE RGB": "Mean Absolute Error computed separately for red, green, and blue channels.",
    RMSE: "Root Mean Square Error of pixel differences. More sensitive to large local deviations than MAE.",
    "PSNR (dB)":
      "Peak Signal-to-Noise Ratio in decibels from MSE vs a 255 peak. Higher usually means closer to the source (typical denoise ~25–40 dB).",
    "Max |Δ|": "Largest absolute channel difference between source and output at any pixel.",
    "Mean signed Δ RGB":
      "Average signed change per channel (output − source). Negative means that channel got darker overall.",
    "Std Δ RGB": "Standard deviation of per-channel differences — spread of change, not just the mean shift.",
    "% pixels max|Δ| > 1": "Share of pixels where at least one channel changed by more than 1 level.",
    "% pixels max|Δ| > 5": "Share of pixels with any-channel change greater than 5 levels.",
    "% pixels max|Δ| > 10": "Share of pixels with any-channel change greater than 10 levels.",
    "% pixels max|Δ| > 20": "Share of pixels with any-channel change greater than 20 levels.",
    "% pixels max|Δ| > 40": "Share of pixels with any-channel change greater than 40 levels.",
    "Compare note":
      "How source and output were aligned for comparison (same size vs LANCZOS resize of source to output size).",
    "Source mean / std": "Rec.709 luminance mean and standard deviation of the comparison source.",
    "Output mean / std": "Rec.709 luminance mean and standard deviation of the output image.",
    "Mean Δ": "Change in mean luminance (output − source). Negative = darker overall.",
    "Std Δ": "Change in luminance standard deviation (contrast proxy).",
    "Δ R · G · B": "Change in mean red, green, and blue (output − source) on a 0–255 scale.",
    "Laplacian var src → out":
      "Laplacian variance of luminance before → after. High values mean more high-frequency energy (detail + noise).",
    "Laplacian var % change":
      "Percent change in Laplacian variance. Negative values indicate high-frequency energy was reduced (typical of denoise).",
    "Mean |L| src → out": "Mean absolute Laplacian response before → after (edge/noise energy proxy).",
    "Mean |L| % change": "Percent change in mean |Laplacian|. Negative = less high-frequency energy.",
    "Residual std src → out":
      "Std of residual after 5×5 box blur before → after. A noise proxy: lower after denoise is expected.",
    "Residual std % change": "Percent change in residual std. Negative = less residual high-frequency noise.",
    "Local std mean src → out":
      "Mean of local 5×5 standard deviation maps before → after (texture/noise energy).",
    "Local std mean % change": "Percent change in mean local std. Negative = smoother local neighborhoods.",
    "Local std median % change":
      "Percent change in median local std (robust to bright outliers like string lights).",
    "Luma SSIM-like":
      "Global SSIM-like score on Rec.709 luminance (not windowed SSIM). Near 1.0 means structure is largely preserved.",
    "R / G / B": "Global SSIM-like scores on red, green, and blue channels separately.",
    "Width × height": "Image dimensions in pixels (width × height).",
    "Pixel count": "Total number of pixels (width × height).",
    "Aspect ratio": "width / height. Portrait photos are typically near 0.67 (2:3).",
    "File size": "Encoded file size on disk (or of the last export).",
    Format: "Container/codec format of the loaded or exported image (JPEG, PNG, …).",
    "Bit depth / channels": "Bits per sample and channel count (RGB = 3 channels at 8-bit).",
    "ICC profile": "Whether an embedded ICC color profile was present on load.",
    DPI: "Dots-per-inch metadata from the file (often 72 for web photos; not physical print size).",
    Mean: "Average Rec.709 luminance (0.2126R + 0.7152G + 0.0722B) across all pixels.",
    Std: "Standard deviation of Rec.709 luminance — overall contrast/spread of brightness.",
    R: "Mean red channel value (0–255).",
    G: "Mean green channel value (0–255).",
    B: "Mean blue channel value (0–255).",
    "Laplacian variance":
      "Variance of a 3×3 Laplacian on luminance. Higher = more high-frequency content (fine detail and/or grain).",
    "Mean |Laplacian|": "Mean absolute Laplacian response — average high-frequency energy magnitude.",
    "Residual std (5×5 box)":
      "Standard deviation of (image − 5×5 box blur). Isolates fine residual noise/texture.",
    "Local std mean (5×5)":
      "Average of per-pixel local standard deviation in a 5×5 window — local texture/noise energy.",
    "Local std median (5×5)":
      "Median of the local std map — robust summary less skewed by bright speculars or lights.",
  };

  const CATEGORY_DESCRIPTORS = {
    pipeline:
      "How the denoise pipeline ran: algorithm, requested vs effective strength, and internal parameters. Use this to verify what was applied and whether category targets adjusted strength.",
    geometry_delta:
      "Spatial and file-size changes between source and output. PhotoEditor aims to preserve resolution; scales near 1.0 and resolution_preserved=yes indicate no unintended downscale.",
    pixel_difference:
      "Pixel-level difference statistics between source and output after optional size alignment. MAE/RMSE/PSNR quantify overall change; threshold percentages show how widespread edits are.",
    luminance_delta:
      "Brightness changes using Rec.709 luminance. Mean Δ tracks overall lightening/darkening; Std Δ tracks contrast change.",
    color_delta:
      "Average color shift per RGB channel after processing. Useful for spotting unwanted warm/cool casts introduced by denoise or photometric offsets.",
    high_frequency_delta:
      "High-frequency energy before vs after denoise via Laplacian statistics. Strong negative % change means grain/detail energy dropped — expected for denoise, but can also soften real detail.",
    noise_proxy_delta:
      "Noise-oriented proxies (residual std after blur, local std maps). Negative % changes indicate smoother local neighborhoods and less residual grain.",
    structural_similarity:
      "Global SSIM-like structure scores. Values near 1.0 mean coarse structure is preserved even when noise is reduced.",
    geometry:
      "Intrinsic image geometry and encoding metadata: dimensions, aspect ratio, file size, format, bit depth, ICC, and DPI.",
    luminance:
      "Global Rec.709 luminance statistics for a single image (mean brightness and contrast spread).",
    color:
      "Mean red, green, and blue channel levels on a 0–255 scale for a single image.",
    high_frequency:
      "Laplacian-based high-frequency energy for a single image. Combines fine detail and noise; use deltas after denoise to see reduction.",
    noise_proxies:
      "Single-image noise/texture proxies without a reference pair: residual after 5×5 blur and local standard deviation maps.",
    source_metrics:
      "Full metric pack for the source (or comparison-aligned source) image before denoise.",
    output_metrics:
      "Full metric pack for the denoised output image.",
  };

  function metricsToolbarHtml() {
    return `<div class="metrics-toolbar">
      <span class="metrics-toolbar-label">Categories</span>
      <div class="metrics-toolbar-actions">
        <button type="button" class="btn" data-metrics-expand-all title="Expand all categories">Expand all</button>
        <button type="button" class="btn" data-metrics-collapse-all title="Collapse all categories">Collapse all</button>
      </div>
    </div>`;
  }

  function bindMetricCardInteractions(root) {
    if (!root) return;

    // Persist open/closed category state
    root.querySelectorAll("details.metric-category").forEach((det) => {
      const id = det.getAttribute("data-cat-id");
      if (!id) return;
      det.addEventListener("toggle", () => {
        categoryOpenState.set(id, det.open);
      });
    });

    root.querySelectorAll("[data-metrics-expand-all]").forEach((btn) => {
      btn.addEventListener("click", () => {
        root.querySelectorAll("details.metric-category").forEach((d) => {
          d.open = true;
          const id = d.getAttribute("data-cat-id");
          if (id) categoryOpenState.set(id, true);
        });
      });
    });

    root.querySelectorAll("[data-metrics-collapse-all]").forEach((btn) => {
      btn.addEventListener("click", () => {
        root.querySelectorAll("details.metric-category").forEach((d) => {
          d.open = false;
          const id = d.getAttribute("data-cat-id");
          if (id) categoryOpenState.set(id, false);
        });
      });
    });

    // Category descriptor expand
    root.querySelectorAll("[data-cat-desc-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const wrap = btn.closest(".cat-descriptor");
        const body = wrap?.querySelector(".cat-descriptor-body");
        if (!body) return;
        const open = body.hasAttribute("hidden");
        if (open) {
          body.removeAttribute("hidden");
          btn.setAttribute("aria-expanded", "true");
          btn.classList.add("is-open");
        } else {
          body.setAttribute("hidden", "");
          btn.setAttribute("aria-expanded", "false");
          btn.classList.remove("is-open");
        }
      });
    });

    // Per-metric descriptor expand
    root.querySelectorAll("[data-desc-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".metric-row");
        const desc = row?.querySelector(".metric-descriptor");
        if (!desc) return;
        const open = desc.hasAttribute("hidden");
        if (open) {
          desc.removeAttribute("hidden");
          btn.setAttribute("aria-expanded", "true");
          btn.classList.add("is-open");
        } else {
          desc.setAttribute("hidden", "");
          btn.setAttribute("aria-expanded", "false");
          btn.classList.remove("is-open");
        }
      });
    });

    // Full value expand (for long text)
    root.querySelectorAll("[data-value-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".metric-row");
        const full = row?.querySelector(".metric-value-full");
        const text = btn.querySelector(".metric-value-text");
        if (full) {
          const open = full.hasAttribute("hidden");
          if (open) {
            full.removeAttribute("hidden");
            btn.setAttribute("aria-expanded", "true");
            text?.classList.remove("is-clamped");
            text?.classList.add("is-open");
          } else {
            full.setAttribute("hidden", "");
            btn.setAttribute("aria-expanded", "false");
            text?.classList.add("is-clamped");
            text?.classList.remove("is-open");
          }
          return;
        }
        // Short values: still allow unclamp if clampable
        if (text?.classList.contains("is-clampable") || text?.classList.contains("is-clamped")) {
          text.classList.toggle("is-clamped");
          text.classList.toggle("is-open");
          btn.setAttribute(
            "aria-expanded",
            text.classList.contains("is-open") ? "true" : "false"
          );
        }
      });
    });
  }

  const METRICS_W_DEFAULT = 380;
  const METRICS_W_MIN = 280;
  const METRICS_W_MAX = 720;

  function getMetricsWidth() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--metrics-w").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : METRICS_W_DEFAULT;
  }

  function setMetricsWidth(px, { persist = true } = {}) {
    const w = Math.min(METRICS_W_MAX, Math.max(METRICS_W_MIN, Math.round(px)));
    document.documentElement.style.setProperty("--metrics-w", `${w}px`);
    const label = document.getElementById("metricsWidthLabel");
    if (label) label.textContent = String(w);
    const panel = document.getElementById("metricsPanel");
    if (panel) panel.classList.toggle("is-narrow", w < 340);
    if (persist) {
      try {
        localStorage.setItem("pe.metricsWidth", String(w));
      } catch {
        /* ignore */
      }
    }
    // Reflow preview zoom canvas after panel width change
    if (state.naturalW) {
      requestAnimationFrame(() => applyZoomLayout({ keepScroll: true }));
    }
    return w;
  }

  function initMetricsPanelResize() {
    const stored = (() => {
      try {
        return parseInt(localStorage.getItem("pe.metricsWidth") || "", 10);
      } catch {
        return NaN;
      }
    })();
    setMetricsWidth(Number.isFinite(stored) ? stored : METRICS_W_DEFAULT, { persist: false });

    const handle = document.getElementById("metricsResizeHandle");
    const panel = document.getElementById("metricsPanel");
    const narrower = document.getElementById("metricsNarrower");
    const wider = document.getElementById("metricsWider");
    const reset = document.getElementById("metricsWidthReset");
    if (!handle || !panel) return;

    narrower?.addEventListener("click", () => setMetricsWidth(getMetricsWidth() - 40));
    wider?.addEventListener("click", () => setMetricsWidth(getMetricsWidth() + 40));
    reset?.addEventListener("click", () => setMetricsWidth(METRICS_W_DEFAULT));

    let dragging = false;
    let startX = 0;
    let startW = 0;

    const onMove = (clientX) => {
      if (!dragging) return;
      // Dragging the left edge: move left (smaller clientX) => wider panel
      const delta = startX - clientX;
      setMetricsWidth(startW + delta);
    };

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startW = getMetricsWidth();
      document.body.classList.add("is-resizing-metrics");
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (dragging) onMove(e.clientX);
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("is-resizing-metrics");
    });

    // Keyboard resize for accessibility
    handle.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setMetricsWidth(getMetricsWidth() + 20);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setMetricsWidth(getMetricsWidth() - 20);
      } else if (e.key === "Home") {
        e.preventDefault();
        setMetricsWidth(METRICS_W_DEFAULT);
      }
    });

    // Touch
    handle.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        if (!t) return;
        dragging = true;
        startX = t.clientX;
        startW = getMetricsWidth();
        document.body.classList.add("is-resizing-metrics");
      },
      { passive: true }
    );
    window.addEventListener(
      "touchmove",
      (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        if (t) onMove(t.clientX);
      },
      { passive: true }
    );
    window.addEventListener("touchend", () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("is-resizing-metrics");
    });
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
  function renderSourceMetrics(m, { idPrefix = "src", defaultOpen = false, wrapToolbar = true } = {}) {
    if (!m) return "";
    const g = m.geometry || {};
    const L = m.luminance || {};
    const c = m.color_means || {};
    const hf = m.high_frequency || {};
    const n = m.noise_proxies || {};
    const cats = [
      metricCategory({
        id: `${idPrefix}-geometry`,
        title: "Geometry / encoding",
        summary: g.width && g.height ? `${g.width}×${g.height}` : "",
        descriptor: CATEGORY_DESCRIPTORS.geometry,
        defaultOpen,
        rows: [
          ["Width × height", `${g.width} × ${g.height}`],
          ["Pixel count", g.pixel_count?.toLocaleString?.() ?? g.pixel_count],
          ["Aspect ratio", fmtNum(g.aspect_ratio, 4)],
          ["File size", fmtBytes(g.file_bytes)],
          ["Format", g.format || "—"],
          ["Bit depth / channels", `${g.bit_depth}-bit · ${g.channels} ch`],
          ["ICC profile", g.has_icc ? "yes" : "no"],
          [
            "DPI",
            Array.isArray(g.dpi) ? g.dpi.map((x) => fmtNum(x, 1)).join(" × ") : "—",
          ],
        ],
      }),
      metricCategory({
        id: `${idPrefix}-luminance`,
        title: "Luminance (Rec.709)",
        summary: L.mean != null ? `μ ${fmtNum(L.mean)}` : "",
        descriptor: CATEGORY_DESCRIPTORS.luminance,
        defaultOpen,
        rows: [
          ["Mean", fmtNum(L.mean)],
          ["Std", fmtNum(L.std)],
        ],
      }),
      metricCategory({
        id: `${idPrefix}-color`,
        title: "Color means (RGB 0–255)",
        summary:
          c.r != null ? `R${fmtNum(c.r, 0)} G${fmtNum(c.g, 0)} B${fmtNum(c.b, 0)}` : "",
        descriptor: CATEGORY_DESCRIPTORS.color,
        defaultOpen,
        rows: [
          ["R", fmtNum(c.r)],
          ["G", fmtNum(c.g)],
          ["B", fmtNum(c.b)],
        ],
      }),
      metricCategory({
        id: `${idPrefix}-hf`,
        title: "High-frequency energy",
        summary:
          hf.laplacian_variance != null ? `var ${fmtNum(hf.laplacian_variance)}` : "",
        descriptor: CATEGORY_DESCRIPTORS.high_frequency,
        defaultOpen,
        rows: [
          ["Laplacian variance", fmtNum(hf.laplacian_variance)],
          ["Mean |Laplacian|", fmtNum(hf.laplacian_mean_abs)],
        ],
      }),
      metricCategory({
        id: `${idPrefix}-noise`,
        title: "Noise proxies",
        summary:
          n.residual_std_5x5 != null ? `res ${fmtNum(n.residual_std_5x5)}` : "",
        descriptor: CATEGORY_DESCRIPTORS.noise_proxies,
        defaultOpen,
        rows: [
          ["Residual std (5×5 box)", fmtNum(n.residual_std_5x5)],
          ["Local std mean (5×5)", fmtNum(n.local_std_mean_5x5)],
          ["Local std median (5×5)", fmtNum(n.local_std_median_5x5)],
        ],
      }),
    ];
    const body = cats.join("");
    if (!wrapToolbar) return body;
    return `${metricsToolbarHtml()}<div class="metrics-accordion">${body}</div>`;
  }

  function renderReport(report) {
    if (!report) return renderSourceMetrics(state.sourceMetrics);

    const parts = [];
    const pipe = report.pipeline || {};
    if (pipe.algorithm || pipe.method) {
      const methodFull = pipe.method || "classical denoise";
      const autoParams = pipe.params
        ? [
            `NLM h ≈ ${fmtNum(pipe.params.nlm_h, 2)}`,
            `bilateral σ color ≈ ${fmtNum(pipe.params.bilateral_sigma_color, 1)}`,
            `bilateral σ space ≈ ${fmtNum(pipe.params.bilateral_sigma_space, 1)}`,
            `bilateral d ≈ ${fmtNum(pipe.params.bilateral_d, 0)}`,
            `gaussian σ ≈ ${fmtNum(pipe.params.gaussian_sigma, 2)}`,
            `median ksize ≈ ${fmtNum(pipe.params.median_ksize, 0)}`,
            `blend with original ≈ ${fmtNum(pipe.params.blend, 3)}`,
          ].join("\n")
        : "—";
      parts.push(
        metricCategory({
          id: "cmp-pipeline",
          title: "Pipeline",
          summary: `${pipe.algorithm || "—"} · ${fmtNum(pipe.effective_strength_pct, 0)}%`,
          descriptor: CATEGORY_DESCRIPTORS.pipeline,
          defaultOpen: true,
          rows: [
            ["Method", methodFull],
            ["Algorithm", pipe.algorithm || "—"],
            ["Requested strength", `${fmtNum(pipe.requested_strength_pct, 1)}%`],
            ["Effective strength", `${fmtNum(pipe.effective_strength_pct, 1)}%`],
            ["Note", pipe.note || "—"],
            ["Auto params", autoParams],
          ],
        })
      );
    }

    const gd = report.geometry_delta || {};
    parts.push(
      metricCategory({
        id: "cmp-geometry",
        title: "Geometry delta",
        summary: gd.resolution_preserved ? "res preserved" : "resized",
        descriptor: CATEGORY_DESCRIPTORS.geometry_delta,
        defaultOpen: false,
        rows: [
          ["Resolution preserved", gd.resolution_preserved ? "yes" : "no"],
          ["Width scale", fmtNum(gd.width_scale, 4)],
          ["Height scale", fmtNum(gd.height_scale, 4)],
          ["Pixel count ratio", fmtNum(gd.pixel_count_ratio, 4)],
          [
            "File size ratio",
            gd.file_bytes_ratio != null ? fmtNum(gd.file_bytes_ratio, 3) : "—",
          ],
        ],
      })
    );

    const pd = report.pixel_difference || {};
    const thr = pd.pct_pixels_max_abs_over || {};
    parts.push(
      metricCategory({
        id: "cmp-pixel",
        title: "Pixel difference (src→out)",
        summary: pd.psnr_db != null ? `PSNR ${fmtNum(pd.psnr_db)} dB` : "",
        descriptor: CATEGORY_DESCRIPTORS.pixel_difference,
        defaultOpen: true,
        rows: [
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
        ],
      })
    );

    const ld = report.luminance_delta || {};
    parts.push(
      metricCategory({
        id: "cmp-luma",
        title: "Luminance delta",
        summary: ld.mean_delta != null ? `Δμ ${fmtNum(ld.mean_delta)}` : "",
        descriptor: CATEGORY_DESCRIPTORS.luminance_delta,
        defaultOpen: false,
        rows: [
          ["Source mean / std", `${fmtNum(ld.source_mean)} / ${fmtNum(ld.source_std)}`],
          ["Output mean / std", `${fmtNum(ld.output_mean)} / ${fmtNum(ld.output_std)}`],
          ["Mean Δ", fmtNum(ld.mean_delta), deltaClass(ld.mean_delta)],
          ["Std Δ", fmtNum(ld.std_delta)],
        ],
      })
    );

    const cd = report.color_delta || {};
    parts.push(
      metricCategory({
        id: "cmp-color",
        title: "Color delta (RGB means)",
        summary: Array.isArray(cd.mean_delta_rgb)
          ? cd.mean_delta_rgb.map((x) => fmtNum(x, 1)).join(" · ")
          : "",
        descriptor: CATEGORY_DESCRIPTORS.color_delta,
        defaultOpen: false,
        rows: [
          [
            "Δ R · G · B",
            Array.isArray(cd.mean_delta_rgb)
              ? cd.mean_delta_rgb.map((x) => fmtNum(x)).join(" · ")
              : "—",
          ],
        ],
      })
    );

    const hf = report.high_frequency_delta || {};
    parts.push(
      metricCategory({
        id: "cmp-hf",
        title: "High-frequency delta",
        summary:
          hf.laplacian_variance_pct_change != null
            ? `${fmtNum(hf.laplacian_variance_pct_change)}%`
            : "",
        descriptor: CATEGORY_DESCRIPTORS.high_frequency_delta,
        defaultOpen: true,
        rows: [
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
        ],
      })
    );

    const nd = report.noise_proxy_delta || {};
    parts.push(
      metricCategory({
        id: "cmp-noise",
        title: "Noise proxy delta",
        summary:
          nd.residual_std_pct_change != null
            ? `res ${fmtNum(nd.residual_std_pct_change)}%`
            : "",
        descriptor: CATEGORY_DESCRIPTORS.noise_proxy_delta,
        defaultOpen: true,
        rows: [
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
        ],
      })
    );

    const ss = report.structural_similarity || {};
    parts.push(
      metricCategory({
        id: "cmp-ssim",
        title: "Structural similarity (global)",
        summary:
          ss.luma_ssim_global != null ? `luma ${fmtNum(ss.luma_ssim_global, 3)}` : "",
        descriptor: CATEGORY_DESCRIPTORS.structural_similarity,
        defaultOpen: false,
        rows: [
          ["Luma SSIM-like", fmtNum(ss.luma_ssim_global, 4)],
          [
            "R / G / B",
            `${fmtNum(ss.r_ssim_global, 4)} / ${fmtNum(ss.g_ssim_global, 4)} / ${fmtNum(
              ss.b_ssim_global,
              4
            )}`,
          ],
        ],
      })
    );

    // Nested source / output packs as expandable groups of categories
    const srcPack = report.source || state.sourceMetrics;
    if (srcPack) {
      const open = categoryOpenState.has("pack-source")
        ? categoryOpenState.get("pack-source")
        : false;
      parts.push(`<details class="metric-category metric-pack" data-cat-id="pack-source" ${
        open ? "open" : ""
      }>
        <summary class="metric-category-summary">
          <span class="cat-chevron" aria-hidden="true"></span>
          <span class="cat-title">Source image metrics</span>
          <span class="cat-summary">full pack</span>
          <span class="cat-count">5</span>
        </summary>
        <div class="metric-category-body">
          <div class="cat-descriptor">
            <button type="button" class="cat-descriptor-toggle" data-cat-desc-toggle aria-expanded="false">
              About this category
            </button>
            <div class="cat-descriptor-body" hidden>
              <p>${escapeHtml(CATEGORY_DESCRIPTORS.source_metrics)}</p>
            </div>
          </div>
          <div class="metrics-nested">
            ${renderSourceMetrics(srcPack, {
              idPrefix: "src",
              defaultOpen: false,
              wrapToolbar: false,
            })}
          </div>
        </div>
      </details>`);
    }

    if (report.output) {
      const open = categoryOpenState.has("pack-output")
        ? categoryOpenState.get("pack-output")
        : false;
      parts.push(`<details class="metric-category metric-pack" data-cat-id="pack-output" ${
        open ? "open" : ""
      }>
        <summary class="metric-category-summary">
          <span class="cat-chevron" aria-hidden="true"></span>
          <span class="cat-title">Output image metrics</span>
          <span class="cat-summary">full pack</span>
          <span class="cat-count">5</span>
        </summary>
        <div class="metric-category-body">
          <div class="cat-descriptor">
            <button type="button" class="cat-descriptor-toggle" data-cat-desc-toggle aria-expanded="false">
              About this category
            </button>
            <div class="cat-descriptor-body" hidden>
              <p>${escapeHtml(CATEGORY_DESCRIPTORS.output_metrics)}</p>
            </div>
          </div>
          <div class="metrics-nested">
            ${renderSourceMetrics(report.output, {
              idPrefix: "out",
              defaultOpen: false,
              wrapToolbar: false,
            })}
          </div>
        </div>
      </details>`);
    }

    return `${metricsToolbarHtml()}<div class="metrics-accordion">${parts.join("")}</div>`;
  }

  function refreshMetrics() {
    if (state.report) {
      els.metricsRoot.innerHTML = renderReport(state.report);
    } else if (state.sourceMetrics) {
      els.metricsRoot.innerHTML = renderSourceMetrics(state.sourceMetrics, {
        defaultOpen: true,
      });
    } else {
      els.metricsRoot.innerHTML =
        '<div class="empty-metrics">Upload an image to see expandable metric categories: geometry, luminance, color, high-frequency energy, noise proxies, and comparison deltas after denoise.</div>';
    }
    bindMetricCardInteractions(els.metricsRoot);
  }

  // ── Zoom / preview layout ─────────────────────────────────────────
  function clampZoom(pct) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(Number(pct) || 100)));
  }

  function getActiveImageEl() {
    if (state.view === "compare" && state.outputUrl) return els.compareBefore;
    return els.previewImg;
  }

  function readNaturalSize(img) {
    if (!img || !img.naturalWidth) return null;
    return { w: img.naturalWidth, h: img.naturalHeight };
  }

  function stageContentSize() {
    const scroll = els.previewScroll;
    // Usable area for "fit" (padding so image isn't edge-flush)
    const pad = 16;
    return {
      w: Math.max(80, scroll.clientWidth - pad),
      h: Math.max(80, scroll.clientHeight - pad),
    };
  }

  function fitZoomPct() {
    if (!state.naturalW || !state.naturalH) return 100;
    const { w, h } = stageContentSize();
    const sx = (w / state.naturalW) * 100;
    const sy = (h / state.naturalH) * 100;
    return clampZoom(Math.min(sx, sy));
  }

  function displaySize() {
    const scale = state.zoomPct / 100;
    return {
      w: Math.max(1, Math.round(state.naturalW * scale)),
      h: Math.max(1, Math.round(state.naturalH * scale)),
    };
  }

  function updateZoomUi() {
    if (els.zoomPctInput && document.activeElement !== els.zoomPctInput) {
      els.zoomPctInput.value = String(state.zoomPct);
    }
    const hasImg = state.naturalW > 0 && (state.sourceUrl || state.outputUrl);
    if (!hasImg) {
      els.zoomMeta.textContent = "Size —";
      return;
    }
    const d = displaySize();
    const fit = fitZoomPct();
    const mode =
      Math.abs(state.zoomPct - 100) < 0.5
        ? "1:1"
        : Math.abs(state.zoomPct - fit) < 0.5
          ? "fit"
          : `${state.zoomPct}%`;
    els.zoomMeta.textContent = `${state.naturalW}×${state.naturalH} px → ${d.w}×${d.h} px · ${mode}`;
  }

  function applyZoomLayout(opts = {}) {
    // Image is always top-left aligned in the preview stage.
    // keepScroll: scale existing pan from top-left origin when zoom changes.
    const { keepScroll = false } = opts;
    const canvas = els.previewCanvas;
    const scroll = els.previewScroll;
    const hasImg = state.naturalW > 0 && (state.sourceUrl || state.outputUrl);

    if (!hasImg) {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.minWidth = "100%";
      canvas.style.minHeight = "100%";
      updateZoomUi();
      return;
    }

    const prevSl = scroll.scrollLeft;
    const prevSt = scroll.scrollTop;

    const d = displaySize();
    // Canvas fills viewport at minimum; image sits at top-left
    const cw = Math.max(scroll.clientWidth, d.w);
    const ch = Math.max(scroll.clientHeight, d.h);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    canvas.style.minWidth = `${cw}px`;
    canvas.style.minHeight = `${ch}px`;

    // Size the image layers to exact display pixels
    const layers = [els.singleView, els.compareWrap];
    layers.forEach((el) => {
      el.style.width = `${d.w}px`;
      el.style.height = `${d.h}px`;
    });

    if (keepScroll && state._lastDispW && state._lastDispH) {
      const scaleX = d.w / Math.max(1, state._lastDispW);
      const scaleY = d.h / Math.max(1, state._lastDispH);
      scroll.scrollLeft = prevSl * scaleX;
      scroll.scrollTop = prevSt * scaleY;
    } else {
      // Default: pin to top-left
      scroll.scrollLeft = 0;
      scroll.scrollTop = 0;
    }

    state._lastDispW = d.w;
    state._lastDispH = d.h;
    updateZoomUi();
  }

  function setZoom(pct, { fit = false, keepScroll = false } = {}) {
    state.zoomPct = clampZoom(pct);
    state.fitOnLoad = fit;
    if (els.zoomPctInput) els.zoomPctInput.value = String(state.zoomPct);
    applyZoomLayout({ keepScroll });
  }

  function zoomBy(deltaPct) {
    setZoom(state.zoomPct + deltaPct, { keepScroll: true });
  }

  function zoomToFit() {
    if (!state.naturalW) {
      state.fitOnLoad = true;
      return;
    }
    setZoom(fitZoomPct(), { fit: true, keepScroll: false });
  }

  function zoomTo100() {
    setZoom(100, { keepScroll: false });
  }

  function onImageNaturalReady(img) {
    const nat = readNaturalSize(img);
    if (!nat) return;
    const changed = nat.w !== state.naturalW || nat.h !== state.naturalH;
    state.naturalW = nat.w;
    state.naturalH = nat.h;
    if (state.fitOnLoad || changed) {
      state.zoomPct = fitZoomPct();
      state.fitOnLoad = false;
      if (els.zoomPctInput) els.zoomPctInput.value = String(state.zoomPct);
      applyZoomLayout({ keepScroll: false });
    } else {
      applyZoomLayout({ keepScroll: true });
    }
  }

  function setPreview() {
    const img = els.previewImg;
    const validSource = !!(state.sourceUrl && String(state.sourceUrl).trim());
    const validOutput = !!(state.outputUrl && String(state.outputUrl).trim());

    if (!validSource && !validOutput) {
      clearPreviewImages();
      applyZoomLayout();
      return;
    }

    if (els.placeholder) els.placeholder.hidden = true;

    const bindError = (el) => {
      if (!el) return;
      el.onerror = () => {
        // Broken URL (expired job, revoked blob, 401) → clean blank stage
        console.warn("Preview image failed to load", el.currentSrc || el.src);
        showBlankWorkspace(
          "Preview image could not be loaded. Drop an image or re-open from History/Library."
        );
      };
    };

    if (state.view === "compare" && validSource && validOutput) {
      els.singleView.style.display = "none";
      els.compareWrap.classList.add("active");
      img.hidden = true;
      img.removeAttribute("src");
      els.compareBefore.hidden = false;
      els.compareAfter.hidden = false;
      const onReady = () => onImageNaturalReady(els.compareBefore);
      els.compareBefore.onload = onReady;
      els.compareAfter.onload = null;
      bindError(els.compareBefore);
      bindError(els.compareAfter);
      els.compareBefore.src = state.sourceUrl;
      els.compareAfter.src = state.outputUrl;
      if (els.compareBefore.complete && els.compareBefore.naturalWidth) onReady();
      return;
    }

    els.compareWrap.classList.remove("active");
    els.compareBefore.hidden = true;
    els.compareAfter.hidden = true;
    els.compareBefore.removeAttribute("src");
    els.compareAfter.removeAttribute("src");
    els.singleView.style.display = "grid";
    img.hidden = false;
    const url =
      state.view === "output" && validOutput ? state.outputUrl : state.sourceUrl;
    if (!url) {
      clearPreviewImages();
      applyZoomLayout();
      return;
    }
    const onReady = () => onImageNaturalReady(img);
    img.onload = onReady;
    bindError(img);
    const prev = img.getAttribute("src");
    if (prev === url && img.complete && img.naturalWidth) {
      onReady();
    } else {
      img.src = url;
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
    setStatus("Uploading image…", "busy");
    setUploadProgress(0, "Starting upload…");
    if (els.dropzone) els.dropzone.setAttribute("aria-busy", "true");

    const fd = new FormData();
    fd.append("file", file);

    let data;
    try {
      data = await postFormWithUploadProgress("/api/analyze", fd, {
        onProgress: (pct, label) => {
          if (pct == null) {
            setUploadProgress(15, label || "Uploading…");
            return;
          }
          // Reserve 0–85% for bytes upload; remainder is server analyze
          const mapped = Math.min(85, pct * 0.85);
          setUploadProgress(mapped, label);
        },
      });
      setUploadProgress(90, "Analyzing image…");
      setStatus("Analyzing image…", "busy");
    } catch (err) {
      hideUploadProgress();
      if (els.dropzone) els.dropzone.removeAttribute("aria-busy");
      logIssue("error", "upload", err.message || "Upload failed", {
        filename: file?.name,
        size: file?.size,
      });
      throw err;
    }

    try {
      revokeTrackedUrls();
      state.projectId = Store ? Store.uid() : String(Date.now());
      state.libraryEntryId = null;
      state.jobId = data.job_id;
      state.filename = file.name;
      state.sourceMetrics = data.metrics;
      state.report = null;
      state.sourceUrl = data.preview_url + `?t=${Date.now()}`;
      state.outputUrl = null;
      state.view = "source";
      state.fitOnLoad = true;
      state.history = [];
      state.historyIndex = -1;
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
      setUploadProgress(96, "Updating preview…");
      refreshMetrics();
      setPreview();

      // Seed undo history with original
      const sourceBlob = file;
      await pushHistoryStep({
        id: Store ? Store.uid() : String(Date.now()),
        at: Date.now(),
        label: "Original upload",
        summary: `${g.width}×${g.height} · ${fmtBytes(g.file_bytes)}`,
        controls: collectControls(),
        jobId: data.job_id,
        view: "source",
        filename: file.name,
        sourceBlob,
        outputBlob: null,
        sourceMetrics: data.metrics,
        reportSummary: null,
        report: null,
      });
      setUploadProgress(99, "Caching session…");
      await saveToLibrary();
      setUploadProgress(100, "Done");
      setStatus("Analysis complete · session cached");
    } catch (err) {
      logIssue("error", "upload", err.message || "Post-upload processing failed", {
        filename: file?.name,
      });
      throw err;
    } finally {
      setTimeout(() => {
        hideUploadProgress();
        if (els.dropzone) els.dropzone.removeAttribute("aria-busy");
      }, 500);
    }
  }

  /** Simulated staged progress while waiting on /api/denoise (no server stream yet). */
  let _progressTimer = null;
  let _progressValue = 0;

  function setProgressUI(pct, label) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    _progressValue = p;
    const fillW = `${p}%`;
    if (els.applyProgressFill) els.applyProgressFill.style.width = fillW;
    if (els.applyProgressPct) els.applyProgressPct.textContent = `${p}%`;
    if (els.applyProgressBar) els.applyProgressBar.setAttribute("aria-valuenow", String(p));
    if (els.applyProgressLabel && label) els.applyProgressLabel.textContent = label;
    if (els.previewProcessingFill) els.previewProcessingFill.style.width = fillW;
    if (els.previewProcessingPct) els.previewProcessingPct.textContent = `${p}%`;
    if (els.previewProcessingTitle && label) els.previewProcessingTitle.textContent = label;
  }

  function startApplyProgress() {
    stopApplyProgress(false);
    _progressValue = 0;
    if (els.applyProgress) els.applyProgress.hidden = false;
    if (els.previewProcessing) els.previewProcessing.hidden = false;
    if (els.btnDenoise) {
      els.btnDenoise.disabled = true;
      els.btnDenoise.classList.add("is-processing");
      els.btnDenoise.dataset.idleLabel = els.btnDenoise.dataset.idleLabel || "Apply";
      els.btnDenoise.innerHTML = `<span class="spinner" style="display:inline-block;margin-right:0.4rem;vertical-align:middle;width:12px;height:12px;border-width:2px"></span>Applying…`;
    }
    if (els.btnAnalyze) els.btnAnalyze.disabled = true;
    setProgressUI(2, "Preparing image…");
    setStatus("Applying filter…", "busy");

    // Ease toward ~92% while the request runs; finish jumps to 100% on complete
    const started = Date.now();
    _progressTimer = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      // asymptotic approach: fast early, slower later
      let target;
      let label;
      if (elapsed < 0.4) {
        target = 8 + elapsed * 40;
        label = "Preparing image…";
      } else if (elapsed < 1.2) {
        target = 28 + (elapsed - 0.4) * 25;
        label = "Running denoise filter…";
      } else if (elapsed < 4) {
        target = 48 + (1 - Math.exp(-(elapsed - 1.2) / 2.2)) * 35;
        label = "Smoothing noise…";
      } else {
        target = 83 + (1 - Math.exp(-(elapsed - 4) / 6)) * 9;
        label = "Computing metrics…";
      }
      // never go backwards; cap before completion
      const next = Math.min(92, Math.max(_progressValue, target));
      setProgressUI(next, label);
    }, 120);
  }

  function stopApplyProgress(success) {
    if (_progressTimer) {
      clearInterval(_progressTimer);
      _progressTimer = null;
    }
    if (success) {
      setProgressUI(100, "Done");
    }
    if (els.btnDenoise) {
      els.btnDenoise.classList.remove("is-processing");
      els.btnDenoise.innerHTML = els.btnDenoise.dataset.idleLabel || "Apply";
      els.btnDenoise.disabled = !(state.file || state.jobId || state.sourceUrl);
    }
    if (els.btnAnalyze) els.btnAnalyze.disabled = !state.file;
    // brief hold at 100% then hide
    const hideDelay = success ? 450 : 0;
    setTimeout(() => {
      if (els.applyProgress) els.applyProgress.hidden = true;
      if (els.previewProcessing) els.previewProcessing.hidden = true;
      setProgressUI(0, "Processing…");
    }, hideDelay);
  }

  async function runDenoise() {
    if (!state.file && !state.jobId) return;
    startApplyProgress();
    const controls = collectControls();
    const fd = new FormData();
    if (state.jobId) fd.append("job_id", state.jobId);
    if (state.file) fd.append("file", state.file);
    fd.append("controls_json", JSON.stringify(controls));
    try {
      setProgressUI(Math.max(_progressValue, 18), "Uploading & starting filter…");
      const r = await fetch("/api/denoise", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(typeof err.detail === "string" ? err.detail : r.statusText);
      }
      setProgressUI(Math.max(_progressValue, 88), "Receiving result…");
      const data = await r.json();
      setProgressUI(94, "Updating preview…");
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
      const algo = controls.algorithm || "hybrid";
      const strength = controls.strength_pct;
      const summary = `PSNR ${fmtNum(psnr)} dB · HF ${fmtNum(hf)}% · ${algo} ${strength}%`;

      setProgressUI(97, "Saving history…");
      // Capture blobs for undo / repository
      let sourceBlob = state.file;
      if (!sourceBlob && Store) sourceBlob = await Store.blobFromUrl(state.sourceUrl);
      let outputBlob = null;
      if (Store) outputBlob = await Store.blobFromUrl(state.outputUrl);

      await pushHistoryStep({
        id: Store ? Store.uid() : String(Date.now()),
        at: Date.now(),
        label: `Denoise · ${algo} · ${strength}%`,
        summary,
        controls,
        jobId: data.job_id,
        view: "compare",
        filename: state.filename || state.file?.name,
        sourceBlob: sourceBlob || null,
        outputBlob: outputBlob || null,
        sourceMetrics: state.sourceMetrics || data.report?.source,
        reportSummary: briefReportSummary(data.report),
        report: data.report,
      });
      await saveToLibrary();
      stopApplyProgress(true);
      setStatus(`Done · ${summary} · saved to history & library`);
    } catch (e) {
      stopApplyProgress(false);
      setStatus(e.message || String(e), "error", { source: "apply" });
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

  // Zoom controls
  els.zoomIn.addEventListener("click", () => zoomBy(ZOOM_STEP));
  els.zoomOut.addEventListener("click", () => zoomBy(-ZOOM_STEP));
  els.zoomFit.addEventListener("click", () => zoomToFit());
  els.zoom100.addEventListener("click", () => zoomTo100());
  els.zoomPctInput.addEventListener("change", () => {
    setZoom(els.zoomPctInput.value, { keepScroll: true });
  });
  els.zoomPctInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setZoom(els.zoomPctInput.value, { keepScroll: true });
      els.zoomPctInput.blur();
    }
  });

  // Trackpad / mouse wheel zoom over preview (pinch-zoom on trackpads often sends ctrl+wheel)
  els.previewStage.addEventListener(
    "wheel",
    (e) => {
      if (!state.naturalW) return;
      // Always zoom when over preview (not only with ctrl) so scroll pans only when not zooming.
      // Use ctrl/meta OR vertical wheel with preventDefault for zoom UX.
      const zoomGesture = e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX);
      if (!zoomGesture) return;
      e.preventDefault();
      const direction = e.deltaY > 0 ? -1 : 1;
      // finer steps when pinching
      const step = e.ctrlKey || e.metaKey ? Math.max(2, Math.round(state.zoomPct * 0.04)) : ZOOM_STEP;
      const scroll = els.previewScroll;
      const rect = scroll.getBoundingClientRect();
      const mx = e.clientX - rect.left + scroll.scrollLeft;
      const my = e.clientY - rect.top + scroll.scrollTop;
      const prevW = state._lastDispW || displaySize().w;
      const prevH = state._lastDispH || displaySize().h;
      setZoom(state.zoomPct + direction * step, { keepScroll: true });
      const d = displaySize();
      const scaleX = d.w / Math.max(1, prevW);
      const scaleY = d.h / Math.max(1, prevH);
      // Keep point under cursor stable while image stays top-left anchored in canvas
      scroll.scrollLeft = mx * scaleX - (e.clientX - rect.left);
      scroll.scrollTop = my * scaleY - (e.clientY - rect.top);
    },
    { passive: false }
  );

  // Double-click preview: toggle fit ↔ 100%
  els.previewStage.addEventListener("dblclick", (e) => {
    if (!state.naturalW) return;
    if (e.target.closest(".compare-slider")) return;
    const fit = fitZoomPct();
    if (Math.abs(state.zoomPct - fit) < 1) zoomTo100();
    else zoomToFit();
  });

  // Drag-to-pan when zoomed larger than stage
  (function initPan() {
    const scroll = els.previewScroll;
    const stage = els.previewStage;
    let panning = false;
    let sx = 0;
    let sy = 0;
    let sl = 0;
    let st = 0;
    stage.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".compare-slider")) return;
      if (!state.naturalW) return;
      // Only pan if content overflows
      if (scroll.scrollWidth <= scroll.clientWidth && scroll.scrollHeight <= scroll.clientHeight) {
        return;
      }
      panning = true;
      stage.classList.add("is-panning", "dragging");
      sx = e.clientX;
      sy = e.clientY;
      sl = scroll.scrollLeft;
      st = scroll.scrollTop;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!panning) return;
      scroll.scrollLeft = sl - (e.clientX - sx);
      scroll.scrollTop = st - (e.clientY - sy);
    });
    window.addEventListener("mouseup", () => {
      if (!panning) return;
      panning = false;
      stage.classList.remove("dragging");
      // keep is-panning if still overflow for cursor hint
      if (scroll.scrollWidth <= scroll.clientWidth && scroll.scrollHeight <= scroll.clientHeight) {
        stage.classList.remove("is-panning");
      }
    });
  })();

  // Keep fit accurate on window resize
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.naturalW) return;
      // If user was approximately at fit, re-fit; otherwise re-layout at current %
      const fit = fitZoomPct();
      if (Math.abs(state.zoomPct - fit) < 2 || state.fitOnLoad) {
        zoomToFit();
      } else {
        applyZoomLayout({ keepScroll: true });
      }
      // Update pan cursor
      const scroll = els.previewScroll;
      if (scroll.scrollWidth > scroll.clientWidth || scroll.scrollHeight > scroll.clientHeight) {
        els.previewStage.classList.add("is-panning");
      } else {
        els.previewStage.classList.remove("is-panning");
      }
    }, 100);
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
      e.stopPropagation();
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) setX(e.clientX);
    });
    wrap.addEventListener("click", (e) => {
      if (e.target === slider || e.target.closest(".compare-slider")) return;
      // Don't steal clicks when user was panning — only direct clicks on images
      if (e.target.tagName === "IMG") setX(e.clientX);
    });
  })();

  // Side tabs: Metrics / History / Library
  if (els.sideTabs) {
    els.sideTabs.querySelectorAll(".side-tab").forEach((tab) => {
      tab.addEventListener("click", () => setSideTab(tab.dataset.tab));
    });
  }

  // Undo / Redo
  els.btnUndo.addEventListener("click", () => undo());
  els.btnRedo.addEventListener("click", () => redo());
  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (key === "z" && e.shiftKey) {
      e.preventDefault();
      redo();
    } else if (key === "y") {
      e.preventDefault();
      redo();
    }
  });

  /** Run a session/cache action; errors & warnings go to /logs only (not success noise). */
  async function runCacheAction(source, fn) {
    try {
      await fn();
      refreshErrorLogBadge();
    } catch (e) {
      const msg = e.message || String(e);
      setStatus(msg, "error", { source });
      // Open dedicated log page so the user sees errors/warnings only
      setTimeout(() => {
        location.href = "/logs";
      }, 350);
    }
  }

  // Cache controls
  els.btnSaveSession.addEventListener("click", () =>
    runCacheAction("session", async () => {
      await persistSession();
      await saveToLibrary();
      setStatus("Session & library saved");
    })
  );

  els.btnClearSession.addEventListener("click", () =>
    runCacheAction("session", async () => {
      if (!confirm("Clear the current session cache? The open image stays until you reload.")) {
        return;
      }
      if (Store) await Store.clearSession();
      setCacheBadge(false, "cache");
      refreshCacheMeta();
      setStatus("Session cache cleared");
    })
  );

  els.btnClearHistory.addEventListener("click", () =>
    runCacheAction("history", async () => {
      if (!confirm("Clear undo history for this project?")) return;
      state.history = [];
      state.historyIndex = -1;
      if (Store) await Store.clearHistoryState();
      updateUndoRedoButtons();
      renderHistoryPanel();
      await persistSession();
      setStatus("Edit history cleared");
    })
  );

  els.btnClearLibrary.addEventListener("click", () =>
    runCacheAction("library", async () => {
      if (!confirm("Delete ALL images from the local repository (browser + server)?")) return;
      if (Store) await Store.clearLibrary();
      const r = await fetch("/api/library", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!r.ok) {
        throw new Error("Server library clear failed.");
      }
      state.libraryEntryId = null;
      renderLibraryPanel();
      refreshCacheMeta();
      setStatus("Image library cleared");
    })
  );

  els.btnClearAllCache.addEventListener("click", () =>
    runCacheAction("cache", async () => {
      if (
        !confirm(
          "Clear ALL cache: session, undo history, and image repository? This cannot be undone."
        )
      ) {
        return;
      }
      if (Store) await Store.clearAll();
      const r = await fetch("/api/library", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!r.ok) {
        logIssue("warning", "cache", "Local cache cleared but server library clear failed.");
      }
      state.history = [];
      state.historyIndex = -1;
      state.projectId = null;
      state.libraryEntryId = null;
      state.filename = null;
      state.jobId = null;
      state.sourceMetrics = null;
      state.report = null;
      showBlankWorkspace("All caches cleared — ready for a new image");
      refreshMetrics();
      updateUndoRedoButtons();
      renderHistoryPanel();
      renderLibraryPanel();
      setCacheBadge(false, "cache");
      refreshCacheMeta();
      // Preserve error log so operators can still inspect issues
    })
  );

  // Persist zoom changes
  ["zoomIn", "zoomOut", "zoomFit", "zoom100"].forEach((id) => {
    const el = els[id];
    if (el) el.addEventListener("click", () => scheduleSessionSave());
  });
  els.zoomPctInput.addEventListener("change", () => scheduleSessionSave());

  // ── Auth bootstrap (session cookie) ──────────────────────────────
  async function initAuth() {
    try {
      const r = await fetch("/api/auth/status", { credentials: "same-origin" });
      const st = await r.json();
      if (!st.authenticated) {
        location.href = "/login?next=/";
        return false;
      }
      const user = st.user;
      const actor = st.actor || user;
      if (Store?.setUserScope) Store.setUserScope(user.id);
      if (Log?.setUserScope) Log.setUserScope(user.id);
      refreshErrorLogBadge();
      const userBadge = document.getElementById("userBadge");
      if (userBadge) {
        userBadge.textContent = user.display_name || user.email;
        userBadge.title = `${user.email} · ${user.role}`;
      }
      const adminLink = document.getElementById("adminLink");
      if (adminLink && actor.is_admin) adminLink.hidden = false;

      const bar = document.getElementById("viewAsBar");
      const viewBadge = document.getElementById("viewAsBadge");
      if (st.viewing_as_other) {
        if (bar) {
          bar.hidden = false;
          document.getElementById("viewAsText").textContent =
            `Admin view: showing ${user.display_name || user.email}'s workspace data`;
        }
        if (viewBadge) {
          viewBadge.hidden = false;
          viewBadge.classList.add("view-as");
          viewBadge.textContent = `as ${user.email}`;
        }
      }
      document.getElementById("btnStopViewAs")?.addEventListener("click", async () => {
        await fetch("/api/auth/view-as", { method: "DELETE", credentials: "same-origin" });
        location.reload();
      });
      document.getElementById("btnLogout")?.addEventListener("click", async () => {
        await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
        location.href = "/login";
      });
      return true;
    } catch (e) {
      console.warn(e);
      location.href = "/login";
      return false;
    }
  }

  // Initial zoom UI + resizable metrics panel
  updateZoomUi();
  updateUndoRedoButtons();
  initMetricsPanelResize();

  checkHealth();
  setInterval(checkHealth, 15000);

  // Clean stage immediately (avoids broken-image flash before restore)
  clearPreviewImages();

  initAuth().then((ok) => {
    if (!ok) return;
    restoreSessionOnLoad();
  });

  // Persist before unload
  window.addEventListener("beforeunload", () => {
    // best-effort sync write is not available for IDB; fire-and-forget
    persistSession().catch(() => {});
  });
  // Periodic autosave
  setInterval(() => {
    if (state.sourceUrl || state.history.length) persistSession().catch(() => {});
  }, 30000);
})();
