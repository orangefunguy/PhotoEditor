(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const alertEl = $("#alert");

  function showAlert(msg, type = "") {
    if (!alertEl) return;
    alertEl.hidden = false;
    alertEl.className = `auth-alert ${type}`.trim();
    alertEl.textContent = msg;
  }

  function params() {
    return new URLSearchParams(location.search);
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = data.detail;
      const msg =
        typeof detail === "string"
          ? detail
          : Array.isArray(detail)
            ? detail.map((d) => d.msg || JSON.stringify(d)).join("; ")
            : r.statusText;
      throw new Error(msg || "Request failed");
    }
    return data;
  }

  async function initLogin() {
    const setupForm = $("#setupForm");
    const loginForm = $("#loginForm");
    if (!setupForm && !loginForm) return;

    const status = await api("/api/auth/status");
    if (status.authenticated) {
      location.href = params().get("next") || "/";
      return;
    }

    if (status.needs_setup) {
      $("#subtitle").textContent = "First-time admin setup";
      setupForm.hidden = false;
      setupForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(setupForm);
        try {
          await api("/api/auth/setup", {
            method: "POST",
            body: JSON.stringify({
              email: fd.get("email"),
              password: fd.get("password"),
              first_name: fd.get("first_name"),
              last_name: fd.get("last_name"),
            }),
          });
          location.href = params().get("next") || "/";
        } catch (err) {
          showAlert(err.message, "error");
        }
      });
    } else {
      loginForm.hidden = false;
      loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(loginForm);
        try {
          await api("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({
              email: fd.get("email"),
              password: fd.get("password"),
            }),
          });
          location.href = params().get("next") || "/";
        } catch (err) {
          showAlert(err.message, "error");
        }
      });
    }
  }

  async function initInvite() {
    const form = $("#inviteForm");
    if (!form || location.pathname !== "/invite") return;
    const token = params().get("token");
    if (!token) {
      showAlert("Missing invite token. Open the full link from your email or admin.", "error");
      form.hidden = true;
      return;
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api("/api/auth/complete-invite", {
          method: "POST",
          body: JSON.stringify({
            token,
            password: fd.get("password"),
            first_name: fd.get("first_name"),
            last_name: fd.get("last_name"),
          }),
        });
        location.href = "/";
      } catch (err) {
        showAlert(err.message, "error");
      }
    });
  }

  initLogin().catch((e) => showAlert(e.message, "error"));
  initInvite().catch((e) => showAlert(e.message, "error"));
})();
