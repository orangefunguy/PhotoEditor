(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const Log = window.PELog;

  let _me = null;
  let _selectedUserId = null;
  let _serverMode = true;

  async function fetchAuthStatus() {
    let lastErr;
    for (let i = 1; i <= 5; i++) {
      try {
        const r = await fetch("/api/auth/status", { credentials: "same-origin" });
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

  function formatDetail(e) {
    const parts = [];
    if (e.code) parts.push(`code: ${e.code}`);
    if (e.path) parts.push(`path: ${e.path}`);
    if (e.detail && e.detail !== e.message) parts.push(e.detail);
    if (e.meta && Object.keys(e.meta).length) {
      try {
        parts.push(JSON.stringify(e.meta, null, 2));
      } catch {
        parts.push(String(e.meta));
      }
    }
    return parts.join("\n\n");
  }

  function setAccountIndicator(account, label) {
    const el = $("#accountIndicator");
    if (!el) return;
    if (!account) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <strong>Reading logs for</strong>
      <span class="account-chip">${escapeHtml(label || account.display_name || account.email || account.id)}</span>
      <code class="account-id" title="user_id for agents">${escapeHtml(account.id)}</code>
      ${account.email ? `<span class="account-email">${escapeHtml(account.email)}</span>` : ""}
    `;
  }

  async function loadAccounts(q) {
    const wrap = $("#accountPicker");
    if (!wrap || !_me?.actor?.is_admin) return;
    wrap.hidden = false;
    try {
      const data = await Log.fetchAccounts(q || "");
      const sel = $("#accountSelect");
      if (!sel) return;
      const current = _selectedUserId || _me.user?.id;
      const opts = [
        `<option value="">My profile (${escapeHtml(_me.user?.email || "me")})</option>`,
      ];
      (data.accounts || []).forEach((a) => {
        const label = a.account_label || `${a.display_name} <${a.email}> [${a.id}]`;
        const logs = a.log_count != null ? ` · ${a.log_count} logs` : "";
        opts.push(
          `<option value="${escapeHtml(a.id)}" ${a.id === current ? "selected" : ""}>${escapeHtml(label)}${escapeHtml(logs)}</option>`
        );
      });
      sel.innerHTML = opts.join("");
    } catch (e) {
      console.warn("account list", e);
    }
  }

  async function render() {
    const root = $("#logList");
    if (!root) return;
    const level = $("#filterLevel")?.value || "";
    const source = $("#filterSource")?.value || "";
    const code = $("#filterCode")?.value || "";
    const q = $("#filterQ")?.value?.trim() || "";

    let rows = [];
    let account = _me?.user;
    let accountLabel = null;
    let total = 0;

    if (_serverMode && Log?.fetchServer) {
      try {
        const data = await Log.fetchServer({
          level: level || undefined,
          source: source || undefined,
          code: code || undefined,
          q: q || undefined,
          user_id: _selectedUserId || undefined,
          limit: 200,
        });
        rows = data.entries || [];
        account = data.account || account;
        accountLabel = data.account_label;
        total = data.total_for_user ?? rows.length;
        setAccountIndicator(account, accountLabel);
      } catch (e) {
        // Fall back to localStorage
        rows = Log.list({
          level: level || undefined,
          source: source || undefined,
          code: code || undefined,
          q: q || undefined,
        });
        total = rows.length;
        setAccountIndicator(account, null);
        if (rows.length === 0) {
          root.innerHTML = `<div class="empty-metrics">Server logs unavailable (${escapeHtml(e.message)}). No local entries either.</div>`;
          $("#logCount").textContent = "0";
          return;
        }
      }
    } else {
      rows = Log?.list({
        level: level || undefined,
        source: source || undefined,
        code: code || undefined,
        q: q || undefined,
      }) || [];
      total = rows.length;
      setAccountIndicator(account, null);
    }

    $("#logCount").textContent = String(total);
    if (!rows.length) {
      root.innerHTML =
        '<div class="empty-metrics">No errors or warnings for this account.</div>';
      return;
    }

    root.innerHTML = rows
      .map((e) => {
        const detail = formatDetail(e);
        const metaBlock = detail
          ? `<pre class="log-meta">${escapeHtml(detail)}</pre>`
          : "";
        const accountLine =
          e.user_email || e.account?.email
            ? `<div class="log-account">${escapeHtml(
                e.user_display_name || e.account?.display_name || ""
              )} · ${escapeHtml(e.user_email || e.account?.email || "")} · <code>${escapeHtml(
                e.user_id || e.account?.id || ""
              )}</code></div>`
            : "";
        return `<article class="log-entry log-${escapeHtml(e.level)}">
          <div class="log-entry-head">
            <span class="log-level">${escapeHtml(e.level)}</span>
            <span class="log-source">${escapeHtml(e.source)}</span>
            ${e.code ? `<span class="log-code">${escapeHtml(e.code)}</span>` : ""}
            <span class="log-time">${escapeHtml(formatTime(e.at))}</span>
          </div>
          ${accountLine}
          <p class="log-message">${escapeHtml(e.message)}</p>
          ${metaBlock}
        </article>`;
      })
      .join("");
  }

  async function initAuthScope() {
    try {
      const st = await fetchAuthStatus();
      if (!st.authenticated) {
        location.href = "/login?next=/logs";
        return false;
      }
      _me = st;
      if (Log?.setUserScope && st.user?.id) {
        Log.setUserScope(st.user.id, {
          email: st.user.email,
          display_name: st.user.display_name,
        });
      }
      if (Log?.setUserProfile) Log.setUserProfile(st.user);
      const sub = $("#logSub");
      if (sub && st.user) {
        sub.textContent = `${st.user.display_name || st.user.email} · errors & warnings (server + local)`;
      }
      if (st.actor?.is_admin) {
        await loadAccounts("");
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

  $("#filterLevel")?.addEventListener("change", render);
  $("#filterSource")?.addEventListener("change", render);
  $("#filterCode")?.addEventListener("change", () => render());
  $("#filterQ")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") render();
  });
  $("#btnSearch")?.addEventListener("click", render);
  $("#btnRefresh")?.addEventListener("click", () => {
    loadAccounts($("#accountSearch")?.value || "").then(render);
  });
  $("#btnClearLog")?.addEventListener("click", async () => {
    if (!confirm("Clear error and warning logs for the selected account?")) return;
    try {
      const params = new URLSearchParams();
      if (_selectedUserId) params.set("user_id", _selectedUserId);
      await fetch(`/api/logs?${params}`, { method: "DELETE", credentials: "same-origin" });
    } catch {
      /* ignore */
    }
    if (!_selectedUserId || _selectedUserId === _me?.user?.id) Log?.clear();
    render();
  });
  $("#accountSelect")?.addEventListener("change", (e) => {
    _selectedUserId = e.target.value || null;
    render();
  });
  $("#accountSearch")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadAccounts(e.target.value).then(render);
    }
  });
  $("#btnFindAccount")?.addEventListener("click", () => {
    loadAccounts($("#accountSearch")?.value || "").then(render);
  });

  if (Log) {
    try {
      render();
    } catch {
      /* ignore */
    }
  }

  initAuthScope().then((ok) => {
    if (ok) render();
  });
})();
