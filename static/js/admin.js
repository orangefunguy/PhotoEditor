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
      result.innerHTML = `${escapeHtml(data.message)}<br/><a href="${escapeHtml(
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

  $("#btnRefresh")?.addEventListener("click", () => loadUsers());
  $("#btnLogout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  });

  loadMe().then(loadUsers).catch((e) => {
    $("#usersTable").textContent = e.message;
  });
})();
