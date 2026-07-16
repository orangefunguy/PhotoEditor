/**
 * ELI5 tooltips for PhotoEditor left-panel controls.
 * Uses data-tip on elements; positions a floating tooltip on hover/focus.
 */
(function () {
  "use strict";

  /** @type {Record<string, { title: string, eli5: string, docs?: string }>} */
  const TIPS = {
    upload:
      "Drop or pick a photo so the app can measure it and clean noise. JPEG, PNG, and WebP work.",
    strength:
      "How hard the cleaner tries. Low = gentle. High = stronger noise removal, but real details can get soft too.",
    algorithm:
      "Which cleaning method to use. Hybrid is the best default. Median is great for random speckles. Gaussian is a simple blur.",
    lapVar:
      "How much to reduce “sparkly” fine detail energy. That sparkle is both grain and tiny real texture—don’t crank it unless you mean to.",
    resStd:
      "After a light blur, freckles of noise remain. This target says how much of that freckling you want gone.",
    locStd:
      "Makes small neighborhoods calmer (less bumpy). Good for grainy skies and walls; watch faces and fabric.",
    lumOff:
      "Brighten or darken the whole picture a little after cleaning. Doesn’t remove noise by itself.",
    rOff: "Add or remove red. A little more red / less blue can warm a cold photo.",
    gOff: "Add or remove green. Handy for fixing weird green/magenta casts.",
    bOff: "Add or remove blue. More blue cools the photo; less blue warms it.",
    jpegQ:
      "How carefully to save the cleaned JPEG. Higher = larger file, fewer blocky save artifacts.",
    scale:
      "Change the pixel size of the result. Leave at 1× unless you really want to shrink or enlarge.",
    preserveRes:
      "When on, the cleaned photo keeps the same width and height as the input. Leave this on for fair comparisons.",
    nlmH:
      "Manual strength for Non-Local Means. 0 means “pick automatically from the Strength slider.”",
    bilSigmaC:
      "Bilateral color range: how different two colors can be and still mix. Higher = more smoothing across edges. 0 = auto.",
    bilSigmaS:
      "Bilateral distance range: how far away a neighbor can be and still count. Higher = wider blur. 0 = auto.",
    gaussSigma:
      "Width of the simple Gaussian blur. Higher = softer. 0 = auto from Strength.",
    apply:
      "Apply the current filter settings. You’ll see a progress bar while the image is processing.",
    analyze: "Measure the loaded image again without cleaning it.",
    download: "Save the cleaned photo to your computer as a JPEG.",
    reset: "Put all sliders and options back to defaults. Your image stays loaded.",
    saveSession: "Force-save your current work into this browser’s cache right now.",
    clearSession: "Forget the saved work-in-progress cache. The open image stays until you reload.",
    clearHistory: "Throw away the undo steps for this project.",
    clearLibrary: "Delete every photo from the local image repository (browser + server).",
    clearAll: "Wipe session, undo history, and library—start completely fresh.",
    errorLog:
      "Open a page that lists only errors and warnings from uploads, Apply, and session/cache actions.",
    advanced: "Show expert knobs: JPEG quality, scale, and manual algorithm parameters.",
  };

  const DOCS = {
    upload: "/docs#tool-upload",
    strength: "/docs#tool-strength",
    algorithm: "/docs#tool-algorithm",
    lapVar: "/docs#tool-lap-var",
    resStd: "/docs#tool-res-std",
    locStd: "/docs#tool-loc-std",
    lumOff: "/docs#tool-lum-off",
    rOff: "/docs#tool-rgb-off",
    gOff: "/docs#tool-rgb-off",
    bOff: "/docs#tool-rgb-off",
    jpegQ: "/docs#tool-jpeg-q",
    scale: "/docs#tool-scale",
    preserveRes: "/docs#tool-preserve",
    nlmH: "/docs#tool-nlm-h",
    bilSigmaC: "/docs#tool-bil-sigma",
    bilSigmaS: "/docs#tool-bil-sigma",
    gaussSigma: "/docs#tool-gauss-sigma",
    apply: "/docs#tool-apply",
    analyze: "/docs#tool-analyze",
    download: "/docs#tool-download",
    reset: "/docs#tool-reset",
    saveSession: "/docs#tool-session",
    clearSession: "/docs#tool-clear-cache",
    clearHistory: "/docs#tool-history",
    clearLibrary: "/docs#tool-library",
    clearAll: "/docs#tool-clear-cache",
    errorLog: "/logs",
    advanced: "/docs#advanced",
  };

  function ensureTipEls() {
    document.querySelectorAll("[data-tip]").forEach((el) => {
      if (el.querySelector(":scope > .tip-icon")) return;
      // Prefer attaching icon to labels
      const key = el.getAttribute("data-tip");
      if (!key || !TIPS[key]) return;

      const icon = document.createElement("button");
      icon.type = "button";
      icon.className = "tip-icon";
      icon.setAttribute("aria-label", `Help: ${key}`);
      icon.setAttribute("data-tip-key", key);
      icon.innerHTML = "?";
      icon.tabIndex = 0;

      // Insert into label if present
      if (el.classList.contains("group-label") || el.tagName === "LABEL") {
        const hint = el.querySelector(".hint");
        if (hint) el.insertBefore(icon, hint);
        else el.appendChild(icon);
      } else if (el.classList.contains("section-title")) {
        el.appendChild(icon);
      } else if (el.classList.contains("checkbox-row")) {
        el.appendChild(icon);
      } else if (el.classList.contains("btn") || el.tagName === "BUTTON") {
        el.classList.add("has-tip");
        el.setAttribute("data-tip-key", key);
        // buttons use themselves as the hover target
      } else {
        el.appendChild(icon);
      }
    });
  }

  function createTooltip() {
    let tip = document.getElementById("pe-tooltip");
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = "pe-tooltip";
    tip.className = "pe-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  function showTip(anchor, key) {
    const text = TIPS[key];
    if (!text) return;
    const tip = createTooltip();
    const docs = DOCS[key];
    tip.innerHTML = `
      <div class="pe-tooltip-title">Quick tip</div>
      <div class="pe-tooltip-body">${escapeHtml(text)}</div>
      ${
        docs
          ? `<a class="pe-tooltip-link" href="${docs}" target="_blank" rel="noopener">Full docs →</a>`
          : ""
      }
    `;
    tip.hidden = false;
    positionTip(anchor, tip);
  }

  function hideTip() {
    const tip = document.getElementById("pe-tooltip");
    if (tip) tip.hidden = true;
  }

  function positionTip(anchor, tip) {
    const rect = anchor.getBoundingClientRect();
    const pad = 8;
    const tw = tip.offsetWidth || 260;
    const th = tip.offsetHeight || 80;
    let left = rect.right + pad;
    let top = rect.top + rect.height / 2 - th / 2;

    if (left + tw > window.innerWidth - 12) {
      left = rect.left - tw - pad;
    }
    if (left < 12) left = 12;
    if (top < 12) top = 12;
    if (top + th > window.innerHeight - 12) {
      top = window.innerHeight - th - 12;
    }

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function bind() {
    ensureTipEls();
    const tip = createTooltip();
    let hideTimer = null;

    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideTip, 120);
    };
    const cancelHide = () => clearTimeout(hideTimer);

    document.addEventListener(
      "pointerover",
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const anchor =
          t.closest(".tip-icon") ||
          t.closest("[data-tip-key].btn") ||
          t.closest("[data-tip-key].has-tip");
        if (!anchor) return;
        const key = anchor.getAttribute("data-tip-key") || anchor.getAttribute("data-tip");
        if (!key) return;
        cancelHide();
        showTip(anchor, key);
      },
      true
    );

    document.addEventListener(
      "pointerout",
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest(".tip-icon") || t.closest("[data-tip-key]")) scheduleHide();
      },
      true
    );

    tip.addEventListener("pointerenter", cancelHide);
    tip.addEventListener("pointerleave", scheduleHide);

    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const anchor = t.closest(".tip-icon") || t.closest("[data-tip-key]");
      if (!anchor) return;
      const key = anchor.getAttribute("data-tip-key") || anchor.getAttribute("data-tip");
      if (key) showTip(anchor, key);
    });

    document.addEventListener("focusout", () => scheduleHide());
    window.addEventListener("scroll", hideTip, true);
    window.addEventListener("resize", hideTip);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
