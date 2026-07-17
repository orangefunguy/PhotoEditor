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
    // Keep alert in view on mobile without scrolling the password field away
    try {
      alertEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch {
      /* ignore */
    }
  }

  function hideAlert() {
    if (!alertEl) return;
    alertEl.hidden = true;
    alertEl.textContent = "";
  }

  function params() {
    return new URLSearchParams(location.search);
  }

  /**
   * Safe same-origin relative redirect target.
   * Prevents open redirects and /login → /login loops (common on mobile).
   */
  function safeNext(raw) {
    let n = raw || params().get("next") || "/";
    try {
      n = decodeURIComponent(String(n));
    } catch {
      n = "/";
    }
    // Absolute URLs or protocol-relative
    if (!n.startsWith("/") || n.startsWith("//")) return "/";
    // Never bounce back into auth pages
    const path = n.split("?")[0].split("#")[0];
    if (
      path === "/login" ||
      path === "/invite" ||
      path.startsWith("/login/") ||
      path.startsWith("/static/")
    ) {
      return "/";
    }
    return n;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * After Set-Cookie, iOS/WebKit sometimes needs a beat before the cookie is
   * visible to subsequent fetches. Poll status, then navigate with replace
   * (no history stack churn → fewer reload loops).
   */
  async function goAfterAuth(next) {
    const dest = safeNext(next);
    // Mark that we just authenticated so the editor can avoid a tight bounce
    try {
      sessionStorage.setItem("pe.authJustSignedIn", String(Date.now()));
    } catch {
      /* private mode */
    }
    for (let i = 0; i < 10; i++) {
      try {
        const st = await api("/api/auth/status");
        if (st.authenticated) {
          location.replace(dest);
          return;
        }
      } catch {
        /* cold start */
      }
      await sleep(120 + i * 80);
    }
    // Last resort: full navigation (still replace)
    location.replace(dest);
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    // Avoid treating HTML error pages as empty JSON on mobile gateways
    const ct = r.headers.get("Content-Type") || "";
    let data = {};
    if (ct.includes("application/json")) {
      data = await r.json().catch(() => ({}));
    } else {
      const text = await r.text().catch(() => "");
      if (!r.ok) {
        throw new Error(
          r.status === 502 || r.status === 503
            ? "Server is starting up. Wait a few seconds and try again."
            : text.slice(0, 160) || r.statusText || "Request failed"
        );
      }
    }
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
    btn.setAttribute("aria-busy", busy ? "true" : "false");
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
    const sub = $("#subtitle");
    if (sub) sub.textContent = "Sign in to your workspace";
    hideAlert();
  }

  function showSignupPanel(needsSetup) {
    const loginPanel = $("#loginPanel");
    const signupPanel = $("#signupPanel");
    const setupForm = $("#setupForm");
    const inviteOnly = $("#signupInviteOnly");
    if (loginPanel) loginPanel.hidden = true;
    if (signupPanel) signupPanel.hidden = false;
    const sub = $("#subtitle");
    if (needsSetup) {
      if (sub) sub.textContent = "Create your admin account";
      if (setupForm) setupForm.hidden = false;
      if (inviteOnly) inviteOnly.hidden = true;
    } else {
      if (sub) sub.textContent = "Sign up";
      if (setupForm) setupForm.hidden = true;
      if (inviteOnly) inviteOnly.hidden = false;
    }
    hideAlert();
  }

  async function initLogin() {
    const loginForm = $("#loginForm");
    const setupForm = $("#setupForm");
    if (!loginForm) return;

    // Prevent double-init on iOS bfcache / back-forward
    if (loginForm.dataset.bound === "1") return;
    loginForm.dataset.bound = "1";

    let needsSetup = false;
    let statusChecked = false;
    try {
      const status = await api("/api/auth/status");
      statusChecked = true;
      if (status.authenticated) {
        // Use replace so Back doesn't re-enter a login loop
        location.replace(safeNext(params().get("next")));
        return;
      }
      needsSetup = !!status.needs_setup;
    } catch (e) {
      showAlert(
        e.message || "Could not reach the server. Check your connection and try again.",
        "error"
      );
    }

    showLoginPanel();

    // Don't re-run status on every focus (interrupts password managers on iOS)
    $("#showSignup")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      showSignupPanel(needsSetup);
    });
    $("#showSignin")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      showLoginPanel();
    });

    loginForm.addEventListener(
      "submit",
      async (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideAlert();
        const btn = $("#btnSignIn");
        const fd = new FormData(loginForm);
        setBusy(btn, true);
        try {
          if (needsSetup) {
            showAlert(
              "This workspace has no accounts yet. Use Sign up below to create the first admin.",
              "error"
            );
            return;
          }
          const data = await api("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({
              email: String(fd.get("email") || "").trim(),
              password: fd.get("password"),
            }),
          });
          const name = data.user?.display_name || data.user?.email || "you";
          showAlert(`Signed in as ${name}. Opening editor…`, "ok");
          // Keep button busy during redirect so double-submit can't fire
          await goAfterAuth(params().get("next"));
        } catch (err) {
          showAlert(err.message || "Sign in failed", "error");
          setBusy(btn, false, "Sign in");
        }
      },
      { passive: false }
    );

    setupForm?.addEventListener(
      "submit",
      async (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideAlert();
        const btn = $("#btnSignUp");
        const fd = new FormData(setupForm);
        setBusy(btn, true);
        try {
          const data = await api("/api/auth/setup", {
            method: "POST",
            body: JSON.stringify({
              email: String(fd.get("email") || "").trim(),
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
          await goAfterAuth(params().get("next"));
        } catch (err) {
          showAlert(err.message || "Setup failed", "error");
          setBusy(btn, false, "Create account & sign in");
        }
      },
      { passive: false }
    );

    if (params().get("mode") === "signup") {
      showSignupPanel(needsSetup);
    }

    // Soft notice if we bounced from the editor without a session (mobile cookie lag)
    if (params().get("reason") === "session" && statusChecked) {
      showAlert(
        "Your session was not available yet. Sign in again — on mobile this can take a second after the first try.",
        "error"
      );
    }
  }

  async function initInvite() {
    const form = $("#inviteForm");
    if (!form || location.pathname !== "/invite") return;
    if (form.dataset.bound === "1") return;
    form.dataset.bound = "1";
    const token = params().get("token");
    if (!token) {
      showAlert(
        "Missing invite token. Open the full link from your email or admin. Invites expire after 3 days.",
        "error"
      );
      form.hidden = true;
      return;
    }
    form.addEventListener(
      "submit",
      async (e) => {
        e.preventDefault();
        e.stopPropagation();
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
          await goAfterAuth("/");
        } catch (err) {
          showAlert(err.message, "error");
          setBusy(btn, false);
        }
      },
      { passive: false }
    );
  }

  // pageshow: ignore bfcache re-exec that re-triggers redirects
  window.addEventListener("pageshow", (ev) => {
    if (ev.persisted) {
      // Restore idle buttons if user navigated back
      ["#btnSignIn", "#btnSignUp"].forEach((sel) => {
        const b = $(sel);
        if (b && b.disabled) setBusy(b, false);
      });
    }
  });

  initLogin().catch((e) => showAlert(e.message, "error"));
  initInvite().catch((e) => showAlert(e.message, "error"));
})();
