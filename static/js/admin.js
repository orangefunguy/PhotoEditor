(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      credentials: "same-origin",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      ...opts,
    });
    if (r.status === 401) {
      location.href = "/login?next=/admin";
      throw new Error("Unauthorized");
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : r.statusText);
    }
    return data;
  }

  async function loadMe() {
    const me = await api("/api/auth/me");
    if (!me.actor?.is_admin) {
      location.href = "/";
      return me;
    }
    $("#adminSub").textContent = `${me.actor.display_name} · ${me.actor.email}`;
    const banner = $("#viewAsBanner");
    if (me.viewing_as_other) {
      banner.hidden = false;
      banner.className = "auth-alert ok";
      banner.innerHTML = `Viewing as <strong>${me.user.display_name}</strong> (${me.user.email}).
        <button type="button" class="btn" id="btnClearView" style="margin-left:0.5rem">Return to my profile</button>`;
      $("#btnClearView")?.addEventListener("click", async () => {
        await api("/api/auth/view-as", { method: "DELETE" });
        location.reload();
      });
    } else {
      banner.hidden = true;
    }
    try {
      const em = await api("/api/auth/email-status");
      const el = $("#emailStatus");
      if (el) {
        if (em.configured) {
          el.className = "auth-alert ok";
          el.textContent = `Email ready · transport: ${em.transport} · from: ${em.from || "—"}`;
        } else {
          el.className = "auth-alert error";
          el.textContent =
            "Email not configured — invites will only show a copyable link. Set SMTP_* or Cloudflare Email env vars for editor.herooflegend.com.";
        }
      }
    } catch {
      /* ignore */
    }
    return me;
  }

  async function loadUsers() {
    const data = await api("/api/auth/users");
    const root = $("#usersTable");
    if (!data.users?.length) {
      root.textContent = "No users yet.";
      return;
    }
    root.innerHTML = data.users
      .map((u) => {
        const roleCls = u.role === "admin" ? "admin" : "";
        const statusCls = u.status === "pending" ? "pending" : "";
        return `<div class="user-row" data-id="${u.id}">
          <div class="meta">
            <strong>${escapeHtml(u.display_name || u.email)}
              <span class="badge-role ${roleCls}">${escapeHtml(u.role)}</span>
              <span class="badge-status ${statusCls}">${escapeHtml(u.status)}${u.is_active ? "" : " · inactive"}</span>
            </strong>
            <span>${escapeHtml(u.email)}</span>
          </div>
          <div class="actions">
            ${
              u.status === "active" && u.is_active
                ? `<button type="button" class="btn" data-view="${u.id}">View profile data</button>`
                : ""
            }
            ${
              u.is_active
                ? `<button type="button" class="btn" data-deact="${u.id}">Deactivate</button>`
                : `<button type="button" class="btn" data-act="${u.id}">Activate</button>`
            }
          </div>
        </div>`;
      })
      .join("");

    root.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api("/api/auth/view-as", {
          method: "POST",
          body: JSON.stringify({ user_id: btn.getAttribute("data-view") }),
        });
        location.href = "/";
      });
    });
    root.querySelectorAll("[data-deact]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Deactivate this user?")) return;
        await api(`/api/auth/users/${btn.getAttribute("data-deact")}/deactivate`, {
          method: "POST",
        });
        loadUsers();
      });
    });
    root.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/auth/users/${btn.getAttribute("data-act")}/activate`, {
          method: "POST",
        });
        loadUsers();
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  $("#inviteForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const result = $("#inviteResult");
    try {
      const data = await api("/api/auth/invite", {
        method: "POST",
        body: JSON.stringify({ email: fd.get("email"), role: fd.get("role") }),
      });
      result.hidden = false;
      result.className = "auth-alert ok";
      const days = data.invite_expires_days ?? 3;
      result.innerHTML = `${escapeHtml(data.message)}<br/>
        <strong>This invite expires in ${days} days.</strong> The invitee must set their password before then.<br/>
        <a href="${escapeHtml(
          data.invite_link
        )}" target="_blank" rel="noopener">${escapeHtml(data.invite_link)}</a>`;
      e.target.reset();
      loadUsers();
    } catch (err) {
      result.hidden = false;
      result.className = "auth-alert error";
      result.textContent = err.message;
    }
  });

  async function loadApiKeys() {
    const root = $("#apiKeysList");
    if (!root) return;
    try {
      const data = await api("/api/logs/api-keys");
      const keys = data.keys || [];
      if (!keys.length) {
        root.innerHTML = '<div class="help-text">No agent API keys yet.</div>';
        return;
      }
      root.innerHTML = keys
        .map((k) => {
          const revoked = k.revoked ? " · revoked" : "";
          const used = k.last_used_at
            ? ` · last used ${new Date(k.last_used_at * 1000).toLocaleString()}`
            : " · never used";
          return `<div class="key-row" data-key-id="${escapeHtml(k.id)}">
            <div>
              <strong>${escapeHtml(k.name || "Key")}</strong>
              <div><code>${escapeHtml(k.key_prefix)}…</code>${escapeHtml(revoked)}${escapeHtml(used)}</div>
            </div>
            ${
              k.revoked
                ? ""
                : `<button type="button" class="btn" data-revoke="${escapeHtml(k.id)}">Revoke</button>`
            }
          </div>`;
        })
        .join("");
      root.querySelectorAll("[data-revoke]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Revoke this agent API key?")) return;
          await api(`/api/logs/api-keys/${btn.getAttribute("data-revoke")}`, {
            method: "DELETE",
          });
          loadApiKeys();
        });
      });
    } catch (e) {
      root.textContent = e.message;
    }
  }

  $("#apiKeyForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const box = $("#apiKeyResult");
    try {
      const data = await api("/api/logs/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: fd.get("name") }),
      });
      box.hidden = false;
      box.innerHTML = `<strong>Copy this API key now</strong> (shown once):<br/><code id="newApiKeyValue">${escapeHtml(
        data.api_key
      )}</code><br/>
        <button type="button" class="btn" id="btnCopyApiKey" style="margin-top:0.5rem">Copy</button>
        <div class="help-text" style="margin-top:0.5rem">${escapeHtml(data.hint || "")}</div>
        <div class="help-text">Example: <code>curl -H "Authorization: Bearer …" "https://editor.herooflegend.com/api/agent/v1/accounts?q=user@…"</code></div>`;
      $("#btnCopyApiKey")?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(data.api_key);
          $("#btnCopyApiKey").textContent = "Copied";
        } catch {
          /* ignore */
        }
      });
      e.target.reset();
      loadApiKeys();
    } catch (err) {
      box.hidden = false;
      box.textContent = err.message;
    }
  });

  $("#btnRefresh")?.addEventListener("click", () => loadUsers());
  $("#btnLogout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  });

  loadMe()
    .then(() => {
      loadUsers();
      loadApiKeys();
    })
    .catch((e) => {
      $("#usersTable").textContent = e.message;
    });
})();
