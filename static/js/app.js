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

  function applyHistoryStep(step, { fit = false } = {}) {
    if (!step) return;
    state._restoring = true;
    revokeTrackedUrls();
    state.jobId = step.jobId || state.jobId;
    state.filename = step.filename || state.filename;
    state.sourceMetrics = step.sourceMetrics || state.sourceMetrics;
    state.report = step.report || null;
    state.view = step.outputBlob ? step.view || "compare" : "source";
    state.fitOnLoad = fit;
    state.sourceUrl = urlFromBlob(step.sourceBlob) || state.sourceUrl;
    state.outputUrl = step.outputBlob ? urlFromBlob(step.outputBlob) : null;
    if (step.sourceBlob) {
      state.file = new File(
        [step.sourceBlob],
        step.filename || state.filename || "image.jpg",
        { type: step.sourceBlob.type || "image/jpeg" }
      );
    }
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
        await Store.deleteLibraryEntry(id);
        try {
          await fetch(`/api/library/${id}`, { method: "DELETE" });
        } catch {
          /* offline */
        }
        if (state.libraryEntryId === id) state.libraryEntryId = null;
        renderLibraryPanel();
        refreshCacheMeta();
        setStatus("Removed from library");
      });
    });
  }

  async function openLibraryEntry(id) {
    setStatus("Opening library entry…", "busy");
    let entry = await Store.getLibraryEntry(id);
    if (!entry || (!entry.sourceBlob && !entry.outputBlob)) {
      // fetch from server
      try {
        const metaR = await fetch(`/api/library/${id}`);
        if (!metaR.ok) throw new Error("Not found");
        const meta = await metaR.json();
        let sourceBlob = null;
        let outputBlob = null;
        try {
          const s = await fetch(`/api/library/${id}/source`);
          if (s.ok) sourceBlob = await s.blob();
        } catch {
          /* */
        }
        try {
          const o = await fetch(`/api/library/${id}/output`);
          if (o.ok) outputBlob = await o.blob();
        } catch {
          /* */
        }
        entry = {
          id,
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
    state.libraryEntryId = id;
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
    if (!Store) return;
    try {
      const sess = await Store.loadSession();
      const hist = await Store.loadHistoryState();
      if (!sess && !(hist.steps && hist.steps.length)) {
        refreshCacheMeta();
        return;
      }
      state._restoring = true;
      if (hist.steps && hist.steps.length) {
        state.history = hist.steps;
        state.historyIndex = Math.min(
          Math.max(0, hist.index ?? hist.steps.length - 1),
          hist.steps.length - 1
        );
        state.projectId = hist.projectId || sess?.projectId || Store.uid();
        applyHistoryStep(state.history[state.historyIndex], { fit: true });
      } else if (sess?.sourceBlob) {
        state.projectId = sess.projectId || Store.uid();
        state.libraryEntryId = sess.libraryEntryId || null;
        state.jobId = sess.jobId;
        state.filename = sess.filename || sess.fileName;
        state.sourceMetrics = sess.sourceMetrics;
        state.report = sess.report;
        state.view = sess.view || "source";
        state.zoomPct = sess.zoomPct || 100;
        if (sess.controls) applyControlsToForm(sess.controls);
        state.sourceUrl = urlFromBlob(sess.sourceBlob);
        state.outputUrl = sess.outputBlob ? urlFromBlob(sess.outputBlob) : null;
        state.file = new File([sess.sourceBlob], state.filename || "image.jpg", {
          type: sess.fileType || sess.sourceBlob.type || "image/jpeg",
        });
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
      }
      state._restoring = false;
      setCacheBadge(true, "restored");
      setStatus("Restored previous session from cache");
      updateUndoRedoButtons();
      renderHistoryPanel();
      refreshCacheMeta();
    } catch (e) {
      state._restoring = false;
      console.warn("Session restore failed", e);
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

  function card(title, rows) {
    const tr = rows
      .map(([k, v, cls]) => {
        const raw = v == null ? "—" : String(v);
        const isLong = raw.length > 48 || raw.includes("Classical") || raw.includes(" · ");
        const longCls = isLong ? "is-long" : "";
        const toggle = isLong
          ? `<button type="button" class="value-toggle" data-value-toggle>Show more</button>`
          : "";
        return `<tr>
          <th>${escapeHtml(k)}</th>
          <td class="${cls || ""}">
            <span class="metric-value-text ${longCls}">${escapeHtml(raw)}</span>
            ${toggle}
          </td>
        </tr>`;
      })
      .join("");
    return `<div class="metric-card is-resizable-card">
      <h3>
        <span class="card-title-text">${escapeHtml(title)}</span>
        <button type="button" class="card-expand-btn" data-card-expand title="Expand / resize this card">Resize</button>
      </h3>
      <table class="metric-table">${tr}</table>
    </div>`;
  }

  function bindMetricCardInteractions(root) {
    if (!root) return;
    root.querySelectorAll("[data-value-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = btn.parentElement?.querySelector(".metric-value-text");
        if (!text) return;
        const open = text.classList.toggle("is-open");
        btn.textContent = open ? "Show less" : "Show more";
      });
    });
    root.querySelectorAll("[data-card-expand]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cardEl = btn.closest(".metric-card");
        if (!cardEl) return;
        const expanded = cardEl.classList.toggle("is-expanded");
        btn.textContent = expanded ? "Done" : "Resize";
        if (expanded) {
          // Nudge panel wider if still cramped
          const w = getMetricsWidth();
          if (w < 480) setMetricsWidth(Math.min(560, w + 80));
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
    if (!state.sourceUrl && !state.outputUrl) {
      img.hidden = true;
      els.placeholder.hidden = false;
      els.compareWrap.classList.remove("active");
      els.singleView.style.display = "grid";
      state.naturalW = 0;
      state.naturalH = 0;
      applyZoomLayout();
      return;
    }
    els.placeholder.hidden = true;

    if (state.view === "compare" && state.sourceUrl && state.outputUrl) {
      els.singleView.style.display = "none";
      els.compareWrap.classList.add("active");
      const onReady = () => onImageNaturalReady(els.compareBefore);
      els.compareBefore.onload = onReady;
      els.compareAfter.onload = null;
      els.compareBefore.src = state.sourceUrl;
      els.compareAfter.src = state.outputUrl;
      if (els.compareBefore.complete && els.compareBefore.naturalWidth) onReady();
      return;
    }

    els.compareWrap.classList.remove("active");
    els.singleView.style.display = "grid";
    img.hidden = false;
    const url =
      state.view === "output" && state.outputUrl ? state.outputUrl : state.sourceUrl;
    const onReady = () => onImageNaturalReady(img);
    img.onload = onReady;
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
    setStatus("Analyzing image…", "busy");
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/analyze", { method: "POST", body: fd });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.statusText);
    }
    const data = await r.json();
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
    await saveToLibrary();
    setStatus("Analysis complete · session cached");
  }

  async function runDenoise() {
    if (!state.file && !state.jobId) return;
    setStatus("Denoising… this may take a few seconds for large images", "busy");
    els.btnDenoise.disabled = true;
    const controls = collectControls();
    const fd = new FormData();
    if (state.jobId) fd.append("job_id", state.jobId);
    if (state.file) fd.append("file", state.file);
    fd.append("controls_json", JSON.stringify(controls));
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
      const algo = controls.algorithm || "hybrid";
      const strength = controls.strength_pct;
      const summary = `PSNR ${fmtNum(psnr)} dB · HF ${fmtNum(hf)}% · ${algo} ${strength}%`;

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
      setStatus(`Done · ${summary} · saved to history & library`);
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

  // Cache controls
  els.btnSaveSession.addEventListener("click", async () => {
    try {
      await persistSession();
      await saveToLibrary();
      setStatus("Session & library saved");
    } catch (e) {
      setStatus(e.message || "Save failed", "error");
    }
  });

  els.btnClearSession.addEventListener("click", async () => {
    if (!confirm("Clear the current session cache? The open image stays until you reload.")) return;
    if (Store) await Store.clearSession();
    setCacheBadge(false, "cache");
    refreshCacheMeta();
    setStatus("Session cache cleared");
  });

  els.btnClearHistory.addEventListener("click", async () => {
    if (!confirm("Clear undo history for this project?")) return;
    state.history = [];
    state.historyIndex = -1;
    if (Store) await Store.clearHistoryState();
    updateUndoRedoButtons();
    renderHistoryPanel();
    await persistSession();
    setStatus("Edit history cleared");
  });

  els.btnClearLibrary.addEventListener("click", async () => {
    if (!confirm("Delete ALL images from the local repository (browser + server)?")) return;
    if (Store) await Store.clearLibrary();
    try {
      await fetch("/api/library", { method: "DELETE" });
    } catch {
      /* offline */
    }
    state.libraryEntryId = null;
    renderLibraryPanel();
    refreshCacheMeta();
    setStatus("Image library cleared");
  });

  els.btnClearAllCache.addEventListener("click", async () => {
    if (
      !confirm(
        "Clear ALL cache: session, undo history, and image repository? This cannot be undone."
      )
    ) {
      return;
    }
    if (Store) await Store.clearAll();
    try {
      await fetch("/api/library", { method: "DELETE" });
    } catch {
      /* offline */
    }
    revokeTrackedUrls();
    state.file = null;
    state.jobId = null;
    state.sourceUrl = null;
    state.outputUrl = null;
    state.sourceMetrics = null;
    state.report = null;
    state.history = [];
    state.historyIndex = -1;
    state.projectId = null;
    state.libraryEntryId = null;
    state.filename = null;
    els.btnDenoise.disabled = true;
    els.btnAnalyze.disabled = true;
    els.btnDownload.disabled = true;
    els.jobBadge.textContent = "no job";
    els.fileMeta.textContent = "No image loaded";
    refreshMetrics();
    setPreview();
    updateUndoRedoButtons();
    renderHistoryPanel();
    renderLibraryPanel();
    setCacheBadge(false, "cache");
    refreshCacheMeta();
    setStatus("All caches cleared — ready for a new image");
  });

  // Persist zoom changes
  ["zoomIn", "zoomOut", "zoomFit", "zoom100"].forEach((id) => {
    const el = els[id];
    if (el) el.addEventListener("click", () => scheduleSessionSave());
  });
  els.zoomPctInput.addEventListener("change", () => scheduleSessionSave());

  // Initial zoom UI + resizable metrics panel
  updateZoomUi();
  updateUndoRedoButtons();
  initMetricsPanelResize();

  checkHealth();
  setInterval(checkHealth, 15000);
  restoreSessionOnLoad();
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
