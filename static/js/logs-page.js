(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const Log = window.PELog;

  async function initAuthScope() {
    try {
      const r = await fetch("/api/auth/status", { credentials: "same-origin" });
      const st = await r.json();
      if (!st.authenticated) {
        location.href = "/login?next=/logs";
        return false;
      }
      if (Log?.setUserScope && st.user?.id) Log.setUserScope(st.user.id);
      const sub = $("#logSub");
      if (sub && st.user) {
        sub.textContent = `${st.user.display_name || st.user.email} · errors & warnings only`;
      }
      return true;
    } catch {
      location.href = "/login?next=/logs";
      return false;
    }
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render() {
    if (!Log) {
      $("#logList").textContent = "Activity log module not loaded.";
      return;
    }
    const level = $("#filterLevel")?.value || "";
    const source = $("#filterSource")?.value || "";
    const rows = Log.list({
      level: level || undefined,
      source: source || undefined,
    });
    $("#logCount").textContent = String(rows.length);
    const root = $("#logList");
    if (!rows.length) {
      root.innerHTML =
        '<div class="empty-metrics">No errors or warnings recorded for this profile.</div>';
      return;
    }
    root.innerHTML = rows
      .map((e) => {
        const meta =
          e.meta && Object.keys(e.meta).length
            ? `<pre class="log-meta">${escapeHtml(JSON.stringify(e.meta, null, 2))}</pre>`
            : "";
        return `<article class="log-entry log-${escapeHtml(e.level)}">
          <div class="log-entry-head">
            <span class="log-level">${escapeHtml(e.level)}</span>
            <span class="log-source">${escapeHtml(e.source)}</span>
            <span class="log-time">${escapeHtml(formatTime(e.at))}</span>
          </div>
          <p class="log-message">${escapeHtml(e.message)}</p>
          ${meta}
        </article>`;
      })
      .join("");
  }

  $("#filterLevel")?.addEventListener("change", render);
  $("#filterSource")?.addEventListener("change", render);
  $("#btnRefresh")?.addEventListener("click", render);
  $("#btnClearLog")?.addEventListener("click", () => {
    if (!confirm("Clear all error and warning log entries for this profile?")) return;
    Log?.clear();
    render();
  });

  initAuthScope().then((ok) => {
    if (ok) render();
  });
})();
