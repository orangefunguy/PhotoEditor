# Changelog

Notable product and engineering changes. Dates use the project’s working timeline around the on-device denoise and editor UX work.

## 2026-07-17 — Mobile login + responsive editor (iPhone Chrome)

- Fix iOS/WebKit **login reload loops**: safe `next` URLs, `location.replace`, post-login session poll before navigating, session “just signed in” grace on the editor.
- Edge Worker preserves **Set-Cookie** correctly (`getSetCookie`) so session cookies work through Cloudflare on mobile.
- Login form: 16px inputs (no focus-zoom), 48px tap targets, `viewport-fit=cover`, safe-area padding, password-manager friendly (no status re-fetch while typing).
- Editor layout: single-column stack under 900px, larger controls, sticky top status bar, reduced-motion support, `100dvh` / overflow fixes for modern mobile CPUs.

## 2026-07-17 — Precise logs + agent API + account finder

- Error/warning entries now carry **code**, full **detail**, path, and structured **meta** (status, algorithm, stacks, etc.).
- Logs **sync to the server** per account (SQLite) in addition to localStorage.
- **Admin account picker** on `/logs` (search email/name/id) with a clear “Reading logs for …” indicator and `user_id`.
- **Agent API keys** (`pe_agent_…`) managed in Admin; agents call:
  - `GET /api/agent/v1/accounts?q=` — find account
  - `GET /api/agent/v1/logs?user_id=` — precise logs for that account
- Guide: [agent-logs.md](agent-logs.md).

## 2026-07-17 — Server denoise 502 on large uploads

- Server fallback no longer posts full multi‑tens‑of‑MB originals through Cloudflare → Render.
- Client **downscales/recompresses** to ~2048px long side JPEG before `POST /api/denoise`.
- Edge proxy uses a **120s timeout** for `/api/denoise` and `/api/analyze` (was 18s — caused false 502s).
- On local failure, retries **on-device bilateral** once before server upload.
- Clearer user message when the origin is cold or the upload is still too heavy.

## 2026-07 — Editor UX, local denoise reliability, edge asset serving

### New project / remove image

- **Preview → New project** opens a dialog to clear the current image and start fresh.
- Options:
  - **Keep edit history** (default) — leaves undo steps in the History tab; archives current work to the library first when not deleting.
  - **Also remove from library** — deletes the linked library entry (browser IndexedDB + server) when one exists.
- Detaches `libraryEntryId` so the next save creates a new library entry rather than overwriting the previous project.

### Apply progress & stop

- Progress and status during Apply are shown in a **sticky top status bar** under the app header (message, progress bar, %, spinner).
- The mid-preview floating processing card is **disabled** so the image stays fully visible.
- **Stop** (top bar, controls panel, or **Esc**) terminates the denoise Web Worker and restores the UI.
- Left-panel apply progress block is unused; primary UX is the top bar.

### On-device denoise (Web Worker + OpenCV)

- Denoise and analyze still prefer **local CPU** via `static/js/denoise-worker.js` + OpenCV WASM.
- **Hybrid / NLM** no longer run pure-JavaScript Non-Local Means (too slow in the browser → timeouts). Hybrid uses an **OpenCV bilateral stack** on luminance + light chroma + finish (edge-preserving, completes in seconds).
- Native `fastNlMeansDenoisingColored` is used when the OpenCV build exposes it; otherwise the bilateral hybrid path is used.
- Working resolution is capped (default ~1280px long side) for responsiveness.
- OpenCV WASM is loaded from **`/static/vendor/opencv.wasm`** with magic-byte validation (`\0asm`). Relative paths that resolved under `/static/js/` (JSON 404 → bad WASM magic) are fixed in `opencv.js` `locateFile` and in the edge worker.
- **No warm-up ping that loads OpenCV** — workers are single-threaded; a warm load was blocking denoise until client timeout.
- Client timeout rejects with a normal `Error` (not user-cancel `AbortError`) so **server denoise fallback** can run.
- If local denoise fails or times out, Apply **falls back to `POST /api/denoise`** on the origin.

### OpenCV / static vendor

- `static/vendor/opencv.js` default binary path is absolute: `/static/vendor/opencv.wasm`.
- `locateFile` does not join absolute paths with the worker `scriptDirectory` (`/static/js/`), which previously produced `/static/js//static/vendor/opencv.wasm`.
- Backend serves `/static/vendor/opencv.{js,wasm}` explicitly and can proxy from jsDelivr if the container is missing the files (stale Render image).

### Session / library correctness

- Client-only job ids (`local-*`) are **not** rehydrated from `/api/jobs/{id}/source|output` (avoids noisy 404s).
- Library clear/delete still mirrors browser + server.

### Cloudflare edge Worker (`worker/index.js`)

- Serves critical static assets from GitHub/jsDelivr when the Render origin lags (`/static/vendor/`, denoise pipeline JS, app.js, styles, etc.).
- Rewrites broken Emscripten wasm paths under `/static/js/…/static/vendor/…` to the real vendor URL.
- Patches legacy denoise-worker (fast hybrid, no blocking ping) and embeds a known-good **client-pipeline** (`worker/embedded-pipeline.js`) when GitHub main is behind.
- Injects top status bar HTML/CSS and Stop wiring when origin HTML is stale.
- Cache-busts script/CSS query strings on the HTML shell.

### Files touched (summary)

| Area | Paths |
|------|--------|
| UI | `static/index.html`, `static/css/styles.css`, `static/js/app.js`, `static/js/tooltips.js` |
| Local pipeline | `static/js/client-pipeline.js`, `static/js/denoise-worker.js` |
| OpenCV | `static/vendor/opencv.js` |
| API | `backend/app.py` (vendor routes) |
| Edge | `worker/index.js`, `worker/embedded-pipeline.js` |
| Docs | `static/docs.html`, `README.md`, `docs/deployment.md`, this file |

### Operator notes

- After UI/pipeline changes: **hard-refresh** the browser (or private window).
- Redeploy edge after Worker changes: `npx wrangler deploy`.
- Redeploy Render when `static/vendor/opencv.wasm` or backend vendor routes must ship on the origin (edge can still serve WASM from jsDelivr).
- DevTools message **“Could not establish connection. Receiving end does not exist.”** is typically a **browser extension**, not the app.

---

## Earlier (abbreviated)

- On-device denoise/analysis via Web Worker (`be819f9` and follow-ups).
- Edge static CDN for OpenCV WASM when Render free-tier lags.
- Invite auth, admin view-as, session/library IndexedDB + server mirror.
