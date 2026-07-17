# Agent access to error & warning logs

PhotoEditor stores **errors** and **warnings** per account (browser cache + server). Admins create **agent API keys** so tools like Grok can read logs over HTTPS with an explicit account selector.

## 1. Create an API key (admin)

1. Sign in as workspace **admin**.
2. Open **Admin** → **Agent API keys**.
3. Name the key (e.g. `Grok operator`) → **Create API key**.
4. **Copy the secret once** (`pe_agent_…`). It is not shown again.

## 2. Account finder (required for multi-tenant precision)

Always resolve which account to read before fetching logs.

```http
GET /api/agent/v1/accounts?q=alice@example.com
Authorization: Bearer pe_agent_<secret>
```

Or:

```http
X-API-Key: pe_agent_<secret>
X-PhotoEditor-Agent-Key: pe_agent_<secret>
```

Response includes:

| Field | Meaning |
|-------|---------|
| `id` | **user_id** — pass this to the logs endpoint |
| `email` | Account email |
| `display_name` | Human name |
| `account_label` | Ready-made `Name <email> [id]` string |
| `log_count` | Number of stored log rows |
| `last_log_at` | Unix time of newest log (if any) |

Example:

```bash
curl -sS -H "Authorization: Bearer pe_agent_…" \
  "https://editor.herooflegend.com/api/agent/v1/accounts?q=hero"
```

## 3. Read logs for one account

```http
GET /api/agent/v1/logs?user_id=<exact-id>&level=error&limit=50
Authorization: Bearer pe_agent_<secret>
```

Optional query params:

| Param | Description |
|-------|-------------|
| `user_id` | **Required.** From account finder |
| `level` | `error` or `warning` |
| `source` | e.g. `apply`, `upload`, `session`, `cache` |
| `code` | e.g. `HTTP_502`, `DENOISE_TIMEOUT` |
| `q` | Search message / detail / code / path |
| `since` | Unix timestamp (seconds) |
| `limit` | 1–500 (default 100) |

Each entry includes:

- `message` — short summary  
- `detail` — full text / stack / server body when available  
- `code` — machine-readable code  
- `source`, `path`, `meta` — extra structured fields  
- `account` — `{ id, email, display_name }`  

## 4. Health check

```http
GET /api/agent/v1/health
Authorization: Bearer pe_agent_<secret>
```

## 5. Browser (session) APIs

| Method | Path | Who |
|--------|------|-----|
| `POST` | `/api/logs` | Authenticated client (sync) |
| `GET` | `/api/logs?user_id=` | User (self) or admin (any workspace member) |
| `DELETE` | `/api/logs?user_id=` | Same |
| `GET` | `/api/logs/accounts?q=` | Admin account finder |
| `POST/GET/DELETE` | `/api/logs/api-keys` | Admin key management |

## 6. Agent workflow (Grok)

1. Authenticate with the agent key.  
2. `GET /api/agent/v1/accounts?q=<email or name>` → pick exact `id`.  
3. `GET /api/agent/v1/logs?user_id=<id>&level=error&q=502` → read precise content.  
4. Use `account_label` in replies so humans know which profile was inspected.

## Security

- Keys are workspace-scoped; only that workspace’s accounts are visible.  
- Revoke compromised keys in Admin.  
- Prefer short-lived operational use; do not embed keys in public repos.
