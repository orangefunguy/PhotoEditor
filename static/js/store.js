/**
 * PhotoEditor persistence layer (IndexedDB).
 *
 * Stores:
 *  - session   : current work-in-progress (survives reload / brief offline)
 *  - history   : undo/redo steps for the active project (with image blobs)
 *  - library   : repository of edited images + brief change logs
 *  - settings  : user prefs
 */
(function (global) {
  "use strict";

  const DB_NAME = "photoeditor";
  const DB_VERSION = 1;
  const MAX_HISTORY = 40;
  const MAX_LIBRARY = 100;

  let _db = null;

  function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("library")) {
          const lib = db.createObjectStore("library", { keyPath: "id" });
          lib.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      };
      req.onsuccess = () => {
        _db = req.result;
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("aborted"));
    });
  }

  async function kvGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function kvSet(key, value) {
    const db = await openDb();
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put({ key, value });
    await txDone(tx);
  }

  async function kvDelete(key) {
    const db = await openDb();
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").delete(key);
    await txDone(tx);
  }

  function uid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  }

  async function blobFromUrl(url) {
    if (!url) return null;
    if (url.startsWith("blob:")) {
      try {
        const r = await fetch(url);
        return await r.blob();
      } catch {
        return null;
      }
    }
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.blob();
    } catch {
      return null;
    }
  }

  // ── Session ──────────────────────────────────────────────────────────
  async function saveSession(session) {
    const payload = {
      ...session,
      savedAt: Date.now(),
      version: 1,
    };
    await kvSet("session", payload);
    return payload;
  }

  async function loadSession() {
    return (await kvGet("session")) || null;
  }

  async function clearSession() {
    await kvDelete("session");
  }

  // ── Active project history (undo stack) ──────────────────────────────
  async function saveHistoryState(hist) {
    // Cap stack size
    if (hist.steps && hist.steps.length > MAX_HISTORY) {
      const drop = hist.steps.length - MAX_HISTORY;
      hist.steps = hist.steps.slice(drop);
      hist.index = Math.max(0, hist.index - drop);
    }
    await kvSet("history", hist);
    return hist;
  }

  async function loadHistoryState() {
    return (
      (await kvGet("history")) || {
        projectId: null,
        steps: [],
        index: -1,
      }
    );
  }

  async function clearHistoryState() {
    await kvDelete("history");
  }

  // ── Library (image repository) ───────────────────────────────────────
  async function listLibrary() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("library", "readonly");
      const req = tx.objectStore("library").getAll();
      req.onsuccess = () => {
        const rows = req.result || [];
        rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function getLibraryEntry(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("library", "readonly");
      const req = tx.objectStore("library").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function putLibraryEntry(entry) {
    const db = await openDb();
    const tx = db.transaction("library", "readwrite");
    tx.objectStore("library").put(entry);
    await txDone(tx);

    // Enforce max library size (drop oldest)
    const all = await listLibrary();
    if (all.length > MAX_LIBRARY) {
      const drop = all.slice(MAX_LIBRARY);
      const db2 = await openDb();
      const tx2 = db2.transaction("library", "readwrite");
      drop.forEach((e) => tx2.objectStore("library").delete(e.id));
      await txDone(tx2);
    }
    return entry;
  }

  async function deleteLibraryEntry(id) {
    const db = await openDb();
    const tx = db.transaction("library", "readwrite");
    tx.objectStore("library").delete(id);
    await txDone(tx);
  }

  async function clearLibrary() {
    const db = await openDb();
    const tx = db.transaction("library", "readwrite");
    tx.objectStore("library").clear();
    await txDone(tx);
  }

  async function clearAll() {
    await clearSession();
    await clearHistoryState();
    await clearLibrary();
    await kvDelete("settings");
  }

  async function estimateUsage() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0 };
      } catch {
        /* fall through */
      }
    }
    return { usage: null, quota: null };
  }

  global.PEStore = {
    uid,
    blobFromUrl,
    saveSession,
    loadSession,
    clearSession,
    saveHistoryState,
    loadHistoryState,
    clearHistoryState,
    listLibrary,
    getLibraryEntry,
    putLibraryEntry,
    deleteLibraryEntry,
    clearLibrary,
    clearAll,
    estimateUsage,
    MAX_HISTORY,
    MAX_LIBRARY,
  };
})(typeof window !== "undefined" ? window : globalThis);
