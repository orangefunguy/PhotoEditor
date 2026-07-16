(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const Log = window.PELog;

  async function fetchAuthStatus() {
    let lastErr;
    for (let i = 1; i <= 5; i++) {
      try {
        const r = await fetch("/api/auth/status", { credentials: "same-origin" });
        // Retry cold-start gateway statuses
        if (r.status === 502 || r.status === 503 || r.status === 504) {
          lastErr = new Error(`Server starting up (${r.status})`);
          await new Promise((res) => setTimeout(res, 800 * i));
          continue;
        }
        const st = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(
            typeof st.detail === "string" ? st.detail : `Auth check failed (${r.status})`
          );
        }
        return st;
      } catch (e) {
        lastErr = e;
        if (i < 5) await new Promise((res) => setTimeout(res, 800 * i));
      }
    }
    throw lastErr || new Error("Could not reach server");
  }

  async function initAuthScope() {
    try {
      const st = await fetchAuthStatus();
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
    } catch (e) {
      const list = $("#logList");
      if (list) {
        list.innerHTML = `<div class="empty-metrics">
          Could not verify session (${escapeHtml(e.message || "network error")}).
          <p style="margin-top:0.75rem">
            <button type="button" class="btn btn-primary" id="btnRetryLogs">Retry</button>
            <a class="btn" href="/login?next=/logs">Sign in</a>
          </p>
        </div>`;
        $("#btnRetryLogs")?.addEventListener("click", () => location.reload());
      }
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

  // Logs are localStorage-only; still show them if auth is slow
  if (Log) {
    try {
      render();
    } catch {
      /* ignore until scoped */
    }
  }

  initAuthScope().then((ok) => {
    if (ok) render();
  });
})();
