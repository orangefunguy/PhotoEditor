(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const alertEl = $("#alert");

  function showAlert(msg, type = "", { html = false } = {}) {
    if (!alertEl) return;
    alertEl.hidden = false;
    alertEl.className = `auth-alert ${type}`.trim();
    if (html) alertEl.innerHTML = msg;
    else alertEl.textContent = msg;
  }

  function hideAlert() {
    if (!alertEl) return;
    alertEl.hidden = true;
    alertEl.textContent = "";
  }

  function params() {
    return new URLSearchParams(location.search);
  }

  function nextUrl() {
    return params().get("next") || "/";
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
            : data.message || r.statusText;
      throw new Error(msg || "Request failed");
    }
    return data;
  }

  function setBusy(btn, busy, labelIdle) {
    if (!btn) return;
    btn.disabled = !!busy;
    if (busy) {
      btn.dataset.idleLabel = btn.dataset.idleLabel || btn.textContent;
      btn.textContent = "Working…";
    } else {
      btn.textContent = labelIdle || btn.dataset.idleLabel || btn.textContent;
    }
  }

  function showLoginPanel() {
    const loginPanel = $("#loginPanel");
    const signupPanel = $("#signupPanel");
    if (loginPanel) loginPanel.hidden = false;
    if (signupPanel) signupPanel.hidden = true;
    $("#subtitle").textContent = "Sign in to your workspace";
    hideAlert();
  }

  function showSignupPanel(needsSetup) {
    const loginPanel = $("#loginPanel");
    const signupPanel = $("#signupPanel");
    const setupForm = $("#setupForm");
    const inviteOnly = $("#signupInviteOnly");
    if (loginPanel) loginPanel.hidden = true;
    if (signupPanel) signupPanel.hidden = false;
    if (needsSetup) {
      $("#subtitle").textContent = "Create your admin account";
      if (setupForm) setupForm.hidden = false;
      if (inviteOnly) inviteOnly.hidden = true;
    } else {
      $("#subtitle").textContent = "Sign up";
      if (setupForm) setupForm.hidden = true;
      if (inviteOnly) inviteOnly.hidden = false;
    }
    hideAlert();
  }

  async function initLogin() {
    const loginForm = $("#loginForm");
    const setupForm = $("#setupForm");
    if (!loginForm) return;

    let needsSetup = false;
    try {
      const status = await api("/api/auth/status");
      if (status.authenticated) {
        location.href = nextUrl();
        return;
      }
      needsSetup = !!status.needs_setup;
    } catch (e) {
      showAlert(e.message || "Could not reach the server.", "error");
    }

    // Always start on Sign in; Sign up is a secondary link underneath
    showLoginPanel();
    if (needsSetup) {
      showAlert(
        "No admin exists yet. Use Sign up below to create the first admin account.",
        "ok"
      );
    }

    $("#showSignup")?.addEventListener("click", () => showSignupPanel(needsSetup));
    $("#showSignin")?.addEventListener("click", () => {
      showLoginPanel();
      if (needsSetup) {
        showAlert(
          "No admin exists yet. Use Sign up below to create the first admin account.",
          "ok"
        );
      }
    });

    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideAlert();
      const btn = $("#btnSignIn");
      const fd = new FormData(loginForm);
      setBusy(btn, true);
      try {
        if (needsSetup) {
          showAlert(
            "No admin account exists yet. Click Sign up to create one first.",
            "error"
          );
          return;
        }
        const data = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            email: fd.get("email"),
            password: fd.get("password"),
          }),
        });
        const name = data.user?.display_name || data.user?.email || "you";
        showAlert(`Signed in as ${name}. Opening editor…`, "ok");
        setTimeout(() => {
          location.href = nextUrl();
        }, 400);
      } catch (err) {
        showAlert(err.message, "error");
      } finally {
        setBusy(btn, false, "Sign in");
      }
    });

    setupForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideAlert();
      const btn = $("#btnSignUp");
      const fd = new FormData(setupForm);
      setBusy(btn, true);
      try {
        const data = await api("/api/auth/setup", {
          method: "POST",
          body: JSON.stringify({
            email: fd.get("email"),
            password: fd.get("password"),
            first_name: fd.get("first_name"),
            last_name: fd.get("last_name"),
          }),
        });
        const email = data.user?.email || fd.get("email");
        showAlert(
          `Admin account created for ${email}. You are signed in — opening the editor…`,
          "ok"
        );
        needsSetup = false;
        setTimeout(() => {
          location.href = nextUrl();
        }, 900);
      } catch (err) {
        showAlert(err.message, "error");
      } finally {
        setBusy(btn, false, "Create account & sign in");
      }
    });

    // Deep-link: /login?mode=signup
    if (params().get("mode") === "signup") {
      showSignupPanel(needsSetup);
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
      const btn = form.querySelector('button[type="submit"]');
      setBusy(btn, true);
      try {
        const data = await api("/api/auth/complete-invite", {
          method: "POST",
          body: JSON.stringify({
            token,
            password: fd.get("password"),
            first_name: fd.get("first_name"),
            last_name: fd.get("last_name"),
          }),
        });
        showAlert(
          `Welcome, ${data.user?.display_name || "there"}! Account ready — opening editor…`,
          "ok"
        );
        setTimeout(() => {
          location.href = "/";
        }, 800);
      } catch (err) {
        showAlert(err.message, "error");
      } finally {
        setBusy(btn, false);
      }
    });
  }

  initLogin().catch((e) => showAlert(e.message, "error"));
  initInvite().catch((e) => showAlert(e.message, "error"));
})();
