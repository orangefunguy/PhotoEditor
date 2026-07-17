/**
 * Client activity log — errors & warnings only, per profile.
 * Local cache (localStorage) + server sync for admin/agent access.
 */
(function (global) {
  "use strict";

  const MAX_ENTRIES = 200;
  const SYNC_BATCH = 25;
  let _userKey = "anon";
  let _userEmail = null;
  let _userDisplay = null;
  let _syncTimer = null;
  let _pendingSync = [];

  function storageKey() {
    return `pe.activityLog.v2.${_userKey}`;
  }

  function setUserScope(userId, opts = {}) {
    _userKey = userId || "anon";
    if (opts.email) _userEmail = opts.email;
    if (opts.display_name) _userDisplay = opts.display_name;
  }

  function setUserProfile(profile) {
    if (!profile) return;
    if (profile.id) _userKey = profile.id;
    _userEmail = profile.email || _userEmail;
    _userDisplay = profile.display_name || _userDisplay;
  }

  function readAll() {
    try {
      const raw = localStorage.getItem(storageKey());
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function writeAll(entries) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(entries.slice(0, MAX_ENTRIES)));
    } catch {
      /* quota / private mode */
    }
  }

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Build a precise log entry with real content for operators/agents.
   * @param {"error"|"warning"} level
   * @param {string} source
   * @param {string} message
   * @param {object} [meta]
   */
  function log(level, source, message, meta) {
    if (level !== "error" && level !== "warning") return null;

    const m = meta && typeof meta === "object" ? { ...meta } : {};
    // Normalize common fields into a stable shape
    const code =
      m.code ||
      m.error_code ||
      (m.status != null ? `HTTP_${m.status}` : null) ||
      null;
    let detail = m.detail || m.error || m.body || m.response || null;
    if (detail && typeof detail === "object") {
      try {
        detail = JSON.stringify(detail);
      } catch {
        detail = String(detail);
      }
    }
    if (!detail) detail = String(message || "Unknown issue");

    // Capture stack when available
    if (!m.stack && m.error instanceof Error) {
      m.stack = m.error.stack;
    }
    if (m.error instanceof Error) {
      m.error_name = m.error.name;
      m.error_message = m.error.message;
      delete m.error;
    }

    const entry = {
      id: uid(),
      at: Date.now(),
      client_at: Date.now(),
      level,
      source: String(source || "app"),
      code: code ? String(code) : undefined,
      message: String(message || "Unknown issue"),
      detail: String(detail),
      path: typeof location !== "undefined" ? location.pathname + location.search : undefined,
      url: typeof location !== "undefined" ? location.href : undefined,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      user_id: _userKey !== "anon" ? _userKey : undefined,
      user_email: _userEmail || undefined,
      user_display_name: _userDisplay || undefined,
      meta: Object.keys(m).length ? m : undefined,
    };

    const all = readAll();
    all.unshift(entry);
    writeAll(all);
    queueSync(entry);
    return entry;
  }

  function error(source, message, meta) {
    return log("error", source, message, meta);
  }

  function warning(source, message, meta) {
    return log("warning", source, message, meta);
  }

  function list({ level, source, limit, code, q } = {}) {
    let rows = readAll();
    if (level) rows = rows.filter((e) => e.level === level);
    if (source) rows = rows.filter((e) => e.source === source);
    if (code) rows = rows.filter((e) => e.code === code);
    if (q) {
      const qq = String(q).toLowerCase();
      rows = rows.filter(
        (e) =>
          String(e.message || "")
            .toLowerCase()
            .includes(qq) ||
          String(e.detail || "")
            .toLowerCase()
            .includes(qq) ||
          String(e.code || "")
            .toLowerCase()
            .includes(qq)
      );
    }
    if (limit) rows = rows.slice(0, limit);
    return rows;
  }

  function clear() {
    writeAll([]);
    _pendingSync = [];
  }

  function count() {
    return readAll().length;
  }

  function queueSync(entry) {
    _pendingSync.push(entry);
    if (_pendingSync.length > SYNC_BATCH) {
      flushSync();
      return;
    }
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(flushSync, 800);
  }

  async function flushSync() {
    if (_syncTimer) {
      clearTimeout(_syncTimer);
      _syncTimer = null;
    }
    if (!_pendingSync.length) return;
    const batch = _pendingSync.splice(0, SYNC_BATCH);
    try {
      const r = await fetch("/api/logs", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: batch }),
      });
      if (!r.ok && r.status !== 401) {
        // Re-queue on failure (except unauthenticated)
        _pendingSync = batch.concat(_pendingSync).slice(0, MAX_ENTRIES);
      }
    } catch {
      _pendingSync = batch.concat(_pendingSync).slice(0, MAX_ENTRIES);
    }
  }

  /**
   * Fetch server-side logs (admin may pass user_id).
   */
  async function fetchServer(opts = {}) {
    const params = new URLSearchParams();
    if (opts.level) params.set("level", opts.level);
    if (opts.source) params.set("source", opts.source);
    if (opts.code) params.set("code", opts.code);
    if (opts.q) params.set("q", opts.q);
    if (opts.user_id) params.set("user_id", opts.user_id);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.since != null) params.set("since", String(opts.since));
    const r = await fetch(`/api/logs?${params}`, { credentials: "same-origin" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : `HTTP ${r.status}`);
    }
    return r.json();
  }

  async function fetchAccounts(q) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const r = await fetch(`/api/logs/accounts?${params}`, { credentials: "same-origin" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : `HTTP ${r.status}`);
    }
    return r.json();
  }

  // Flush on page hide
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushSync();
    });
    window.addEventListener("pagehide", () => flushSync());
  }

  global.PELog = {
    setUserScope,
    setUserProfile,
    log,
    error,
    warning,
    list,
    clear,
    count,
    flushSync,
    fetchServer,
    fetchAccounts,
  };
})(typeof window !== "undefined" ? window : globalThis);
