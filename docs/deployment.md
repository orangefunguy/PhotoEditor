# Deploy PhotoEditor to editor.herooflegend.com

PhotoEditor is a single FastAPI service (API + static UI). Production target:

| Piece | Value |
|-------|--------|
| Public URL | **https://editor.herooflegend.com** |
| App host | Render (Docker) or any Docker host |
| Auth | CRM-style invite + session cookies |
| Email | Resend SMTP **or** Cloudflare Email Sending |
| Data | Persistent disk: SQLite auth DB, uploads, library |

Same DNS pattern as `crm.herooflegend.com`: point the subdomain at your host (CNAME to Render, or A/AAAA to a VPS).

---

## 1. Prerequisites

- [ ] Domain DNS access for `herooflegend.com`
- [ ] Render account (or Docker VPS)
- [ ] Email provider:
  - **Resend** (recommended): verify `herooflegend.com`, create API key
  - **or Cloudflare Email Sending** with a verified sender (same stack as CRM feedback)

---

## 2. DNS

Create:

```
editor.herooflegend.com  CNAME  <your-render-service>.onrender.com
```

(Or A record to your VPS IP.) Enable HTTPS (Render provides TLS automatically).

---

## 3. Deploy on Render

### Option A — Blueprint

1. Push this repo to GitHub (already: `orangefunguy/PhotoEditor`).
2. Render Dashboard → **New → Blueprint** → select the repo.
3. Confirm service `photoeditor` from [`render.yaml`](../render.yaml).
4. Set secret env vars (Dashboard → Environment):

| Variable | Example |
|----------|---------|
| `SMTP_HOST` | `smtp.resend.com` |
| `SMTP_USER` | `resend` |
| `SMTP_PASSWORD` | `re_…` |
| `SMTP_FROM` / `EMAIL_FROM` | `noreply@herooflegend.com` |

5. Attach **persistent disk** at `/app/data` (Blueprint includes 10 GB).  
   Also persist uploads if possible (see note below).

### Option B — Manual Docker web service

- Runtime: Docker  
- Dockerfile path: `./Dockerfile`  
- Health check: `/healthz`  
- Env: copy from [`.env.production.example`](../.env.production.example)

### Disk note

Render mounts one disk by default (`/app/data`). SQLite auth lives there.  
Uploads/outputs/library default under `/app/uploads` etc. For full persistence either:

- Point those paths under `/app/data/...` via future env (or symlink in start script), or  
- Use a larger single volume and set working dirs under it.

Current start script ensures `/app/data`, `/app/uploads`, `/app/outputs`, `/app/library` exist. Prefer mounting a volume that covers all four for long-term production.

---

## 4. Email setup (Resend SMTP)

Matches CRM’s production email approach:

1. [resend.com](https://resend.com) → Domain → add `herooflegend.com` DNS records.  
2. Create API key.  
3. On Render:

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASSWORD=re_xxxxxxxx
SMTP_FROM=noreply@herooflegend.com
SMTP_TLS=true
EMAIL_FROM=noreply@herooflegend.com
EMAIL_FROM_NAME=PhotoEditor
FRONTEND_URL=https://editor.herooflegend.com
APP_ENV=production
COOKIE_SECURE=true
```

4. After deploy, open **Admin → Invite**, send a test invite to yourself.  
5. Confirm `GET /api/health` → `"email": { "configured": true, "transport": "smtp" }`.

### Cloudflare Email (alternative)

```
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_API_TOKEN=…   # Email Sending permission
EMAIL_FROM=noreply@herooflegend.com
```

Leave `SMTP_HOST` unset so Cloudflare is used.

---

## 5. First admin account

1. Visit **https://editor.herooflegend.com/login**
2. Click **Sign up**
3. Create the first admin (email + strong password)
4. Sign in → **Admin** → invite teammates by email  
   Invite tokens **expire after 3 days** (shown in the email and admin UI).

Invite emails use `FRONTEND_URL` so links are:

`https://editor.herooflegend.com/invite?token=…`

---

## 6. Local production smoke test

```bash
cp .env.production.example .env.production
# fill SMTP secrets
docker compose -f docker-compose.prod.yml up -d --build
curl -s http://127.0.0.1:8000/healthz
curl -s http://127.0.0.1:8000/api/health | jq .
```

---

## 7. Security checklist

- [ ] `APP_ENV=production`
- [ ] `AUTH_ENABLED=true`
- [ ] `COOKIE_SECURE=true` (HTTPS only)
- [ ] `FRONTEND_URL=https://editor.herooflegend.com`
- [ ] Real SMTP or Cloudflare credentials (not log-only)
- [ ] Strong first-admin password
- [ ] Persistent volume for `data/` (and media)
- [ ] Optional: `DISABLE_DOCS=true` to hide Swagger publicly

---

## 8. Useful endpoints

| Path | Purpose |
|------|---------|
| `/healthz` | Liveness |
| `/api/health` | Status + email transport info |
| `/api/auth/email-status` | Admin: email config |
| `/login` | Sign in / first admin |
| `/admin` | Invites + view-as |
| `/api/docs` | OpenAPI (if not disabled) |

---

## 9. Cloudflare DNS (Hero of Legend)

If DNS is in Cloudflare (like CRM):

1. Add CNAME `editor` → Render hostname  
2. Proxy status: DNS only or Proxied (both work; Proxied adds CF CDN)  
3. SSL/TLS mode: **Full (strict)** when Render has a cert  

No separate Worker is required: PhotoEditor serves UI + API from one origin.
