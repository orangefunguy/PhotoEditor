/**
 * Client activity log — stores only error and warning events (per profile).
 * Used by session/cache controls and upload failures; viewed on /logs.
 */
(function (global) {
  "use strict";

  const MAX_ENTRIES = 200;
  let _userKey = "anon";

  function storageKey() {
    return `pe.activityLog.v1.${_userKey}`;
  }

  function setUserScope(userId) {
    _userKey = userId || "anon";
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

  /**
   * @param {"error"|"warning"} level
   * @param {string} source e.g. "session", "cache", "upload"
   * @param {string} message
   * @param {object} [meta]
   */
  function log(level, source, message, meta) {
    if (level !== "error" && level !== "warning") return null;
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      level,
      source: String(source || "app"),
      message: String(message || "Unknown issue"),
      meta: meta && typeof meta === "object" ? meta : undefined,
    };
    const all = readAll();
    all.unshift(entry);
    writeAll(all);
    return entry;
  }

  function error(source, message, meta) {
    return log("error", source, message, meta);
  }

  function warning(source, message, meta) {
    return log("warning", source, message, meta);
  }

  function list({ level, source, limit } = {}) {
    let rows = readAll();
    if (level) rows = rows.filter((e) => e.level === level);
    if (source) rows = rows.filter((e) => e.source === source);
    if (limit) rows = rows.slice(0, limit);
    return rows;
  }

  function clear() {
    writeAll([]);
  }

  function count() {
    return readAll().length;
  }

  global.PELog = {
    setUserScope,
    log,
    error,
    warning,
    list,
    clear,
    count,
  };
})(typeof window !== "undefined" ? window : globalThis);
