# Deploy PhotoEditor to editor.herooflegend.com

PhotoEditor is a single FastAPI service (API + static UI) fronted by a Cloudflare Worker.

| Piece | Value |
|-------|--------|
| Public URL | **https://editor.herooflegend.com** |
| App host | Render (Docker) |
| Edge | Cloudflare Worker (`photoeditor`) + KV auth snapshot |
| Auth | Invite + session cookies (90-day sliding sessions) |
| Email | Resend SMTP **or** Cloudflare Email Sending |
| Durable auth | Cloudflare KV via Worker `/_internal/auth/*` |

Traffic: browser → Cloudflare Worker → Render origin. Auth accounts are mirrored to KV so free-tier Render restarts do not wipe logins.

### Edge static / denoise assets

The Worker also serves (or rewrites) critical frontend assets so free-tier origin lag does not break the editor:

| Asset | Why |
|-------|-----|
| `/static/vendor/opencv.wasm` (+ `opencv.js`) | On-device denoise; must be real WASM (`\0asm`), not JSON 404 |
| `/static/js/denoise-worker.js` | Local filter pipeline (fast hybrid; no blocking OpenCV warm-up) |
| `/static/js/client-pipeline.js` | Embedded known-good pipeline when GitHub main is stale (`worker/embedded-pipeline.js`) |
| `/static/js/app.js`, tooltips, styles | UX patches (top status bar, Stop, server fallback, new project) |
| HTML shell | Cache-bust query params; inject top status bar / Stop if origin HTML is old |

Broken Emscripten paths such as `/static/js//static/vendor/opencv.wasm` are rewritten to `/static/vendor/opencv.wasm`.

After Worker changes:

```bash
npx wrangler deploy
```

After origin static/backend changes that must live on Render (not only edge): push `main` and redeploy the Render service. See **[CHANGELOG.md](CHANGELOG.md)** for product-facing detail.

---

## 1. Prerequisites

- [ ] Domain DNS for `herooflegend.com` (Cloudflare recommended)
- [ ] Render account
- [ ] Wrangler / Cloudflare account for the Worker + KV
- [ ] Email provider: **Resend** (recommended) with verified `herooflegend.com`

---

## 2. Architecture

```
https://editor.herooflegend.com
        │
        ▼
 Cloudflare Worker (photoeditor)
   ├─ /_internal/auth/*  →  KV namespace PHOTOEDITOR_AUTH (durable)
   └─ everything else    →  https://photoeditor-*.onrender.com
```

On boot, the FastAPI app restores users/sessions from KV when `AUTH_KV_URL` and
`AUTH_SYNC_SECRET` are set. Every auth write pushes a fresh snapshot.

---

## 3. Cloudflare Worker + KV

Namespace (already created in this project):

- Binding: `AUTH`
- ID: `589022e1c1d445f8a2ecc1826318f862`

Deploy from repo root:

```bash
npx wrangler deploy
printf '%s' "$AUTH_SYNC_SECRET" | npx wrangler secret put AUTH_SYNC_SECRET
```

`wrangler.jsonc` binds KV and points `API_ORIGIN` at the Render service.

---

## 4. Render env vars

| Variable | Example |
|----------|---------|
| `APP_ENV` | `production` |
| `AUTH_ENABLED` | `true` |
| `FRONTEND_URL` | `https://editor.herooflegend.com` |
| `COOKIE_SECURE` | `true` |
| `SESSION_DAYS` | `90` |
| `AUTH_KV_URL` | `https://editor.herooflegend.com` |
| `AUTH_SYNC_SECRET` | same secret as Worker |
| `SMTP_HOST` | `smtp.resend.com` |
| `SMTP_USER` | `resend` |
| `SMTP_PASSWORD` | `re_…` |
| `SMTP_FROM` / `EMAIL_FROM` | `noreply@herooflegend.com` |

Optional helper:

```bash
python3 scripts/deploy_render.py
```

Use `UVICORN_WORKERS=1` on free tier so a single process owns the local SQLite cache (KV remains the durable store).

---

## 5. Email setup (Resend SMTP)

1. [resend.com](https://resend.com) → Domain → add `herooflegend.com` DNS records.
2. Create API key.
3. Set SMTP vars on Render (table above).
4. After deploy, open **Admin → Invite**, send a test invite.
5. Confirm `GET /api/health` → `"email": { "configured": true, "transport": "smtp" }`.

---

## 6. Sign-in (production)

Production already has an admin account once created and synced to KV. Users:

1. Visit **https://editor.herooflegend.com/login**
2. **Sign in** with their email + password
3. Admins invite teammates from **Admin** — invite links expire after **3 days**

Invite links:

`https://editor.herooflegend.com/invite?token=…`

If the durable store is empty (brand-new install only), Sign up creates the first admin once. That path is not needed once an admin exists in KV.

---

## 7. Security checklist

- [ ] `APP_ENV=production`
- [ ] `AUTH_ENABLED=true`
- [ ] `COOKIE_SECURE=true` (HTTPS only)
- [ ] `FRONTEND_URL=https://editor.herooflegend.com`
- [ ] `AUTH_KV_URL` + matching `AUTH_SYNC_SECRET` on Worker and Render
- [ ] Real SMTP credentials
- [ ] Optional: `DISABLE_DOCS=true` to hide Swagger publicly

---

## 8. Useful endpoints

| Path | Purpose |
|------|---------|
| `/healthz` | Liveness |
| `/api/health` | Status + email transport info |
| `/api/auth/status` | Auth + `durable_auth` flag |
| `/api/auth/email-status` | Admin: email config |
| `/login` | Sign in |
| `/admin` | Invites + view-as |
| `/_internal/auth/health` | Worker: KV snapshot status (Bearer secret) |

---

## 9. DNS

`editor.herooflegend.com` is a **custom domain on the Worker** (see `wrangler.jsonc` routes). Do not point DNS only at Render if you want durable KV auth — traffic must hit the Worker.
