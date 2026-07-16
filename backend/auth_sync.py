"""Durable auth snapshot sync (Cloudflare KV).

Render free instances have ephemeral disks, so SQLite alone loses accounts on
restart. Prefer the Cloudflare KV HTTP API when credentials are set; otherwise
fall back to the edge Worker internal endpoints.

Env (preferred — direct KV API):
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN          # Workers KV Storage:Edit
  AUTH_KV_NAMESPACE_ID          # PHOTOEDITOR_AUTH namespace id

Env (fallback — via Worker):
  AUTH_KV_URL                   # e.g. https://photoeditor.<subdomain>.workers.dev
  AUTH_SYNC_SECRET
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any

SNAPSHOT_KEY = "auth:v1:snapshot"

_lock = threading.Lock()
_last_push = 0.0
_MIN_PUSH_INTERVAL = 0.25


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def kv_api_enabled() -> bool:
    return bool(
        _env("CLOUDFLARE_ACCOUNT_ID")
        and _env("CLOUDFLARE_API_TOKEN")
        and _env("AUTH_KV_NAMESPACE_ID")
    )


def worker_sync_enabled() -> bool:
    return bool(_env("AUTH_KV_URL") and _env("AUTH_SYNC_SECRET"))


def kv_enabled() -> bool:
    return kv_api_enabled() or worker_sync_enabled()


def _kv_value_url(key: str) -> str:
    account = _env("CLOUDFLARE_ACCOUNT_ID")
    ns = _env("AUTH_KV_NAMESPACE_ID")
    from urllib.parse import quote

    return (
        f"https://api.cloudflare.com/client/v4/accounts/{account}"
        f"/storage/kv/namespaces/{ns}/values/{quote(key, safe='')}"
    )


def _http(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 15.0,
) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except Exception as exc:  # noqa: BLE001
        print(f"[PhotoEditor auth_sync] {method} {url} error: {exc}")
        return 0, str(exc).encode()


def _fetch_via_api() -> dict[str, Any] | None:
    status, raw = _http(
        "GET",
        _kv_value_url(SNAPSHOT_KEY),
        headers={
            "Authorization": f"Bearer {_env('CLOUDFLARE_API_TOKEN')}",
            "Accept": "application/json",
            "User-Agent": "PhotoEditor-AuthSync/1.0",
        },
    )
    if status == 404:
        return None
    if status != 200:
        print(f"[PhotoEditor auth_sync] KV GET failed status={status} body={raw[:300]!r}")
        return None
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        print("[PhotoEditor auth_sync] KV GET returned non-JSON")
        return None
    snap = parsed.get("snapshot") if isinstance(parsed, dict) else None
    return snap if isinstance(snap, dict) else (parsed if isinstance(parsed, dict) else None)


def _push_via_api(snapshot: dict[str, Any]) -> bool:
    payload = json.dumps(
        {
            "snapshot": snapshot,
            "updated_at": time.time(),
            "users": len(snapshot.get("users") or []),
            "sessions": len(snapshot.get("sessions") or []),
        }
    ).encode("utf-8")
    status, raw = _http(
        "PUT",
        _kv_value_url(SNAPSHOT_KEY),
        headers={
            "Authorization": f"Bearer {_env('CLOUDFLARE_API_TOKEN')}",
            "Content-Type": "application/json",
            "User-Agent": "PhotoEditor-AuthSync/1.0",
        },
        body=payload,
    )
    if status not in (200, 201):
        print(f"[PhotoEditor auth_sync] KV PUT failed status={status} body={raw[:300]!r}")
        return False
    return True


def _worker_url(path: str) -> str:
    return f"{_env('AUTH_KV_URL').rstrip('/')}{path}"


def _fetch_via_worker() -> dict[str, Any] | None:
    status, raw = _http(
        "GET",
        _worker_url("/_internal/auth/snapshot"),
        headers={
            "Authorization": f"Bearer {_env('AUTH_SYNC_SECRET')}",
            "Accept": "application/json",
            "User-Agent": "PhotoEditor-AuthSync/1.0",
        },
    )
    if status == 404:
        return None
    if status != 200:
        print(
            f"[PhotoEditor auth_sync] worker GET failed status={status} body={raw[:300]!r}"
        )
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return None
    snap = data.get("snapshot") if isinstance(data, dict) else None
    return snap if isinstance(snap, dict) else None


def _push_via_worker(snapshot: dict[str, Any]) -> bool:
    body = json.dumps(
        {"snapshot": snapshot, "updated_at": time.time()}
    ).encode("utf-8")
    status, raw = _http(
        "PUT",
        _worker_url("/_internal/auth/snapshot"),
        headers={
            "Authorization": f"Bearer {_env('AUTH_SYNC_SECRET')}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "PhotoEditor-AuthSync/1.0",
        },
        body=body,
    )
    if status not in (200, 201):
        print(
            f"[PhotoEditor auth_sync] worker PUT failed status={status} body={raw[:300]!r}"
        )
        return False
    return True


def fetch_snapshot() -> dict[str, Any] | None:
    if not kv_enabled():
        return None
    if kv_api_enabled():
        return _fetch_via_api()
    return _fetch_via_worker()


def push_snapshot(snapshot: dict[str, Any]) -> bool:
    if not kv_enabled():
        return False
    global _last_push
    with _lock:
        now = time.time()
        if now - _last_push < _MIN_PUSH_INTERVAL:
            time.sleep(_MIN_PUSH_INTERVAL)
        if kv_api_enabled():
            ok = _push_via_api(snapshot)
        else:
            ok = _push_via_worker(snapshot)
        _last_push = time.time()
    return ok


def export_db(conn) -> dict[str, Any]:
    workspaces = [
        dict(r) for r in conn.execute("SELECT * FROM workspaces").fetchall()
    ]
    users = [dict(r) for r in conn.execute("SELECT * FROM users").fetchall()]
    sessions = [
        dict(r) for r in conn.execute("SELECT * FROM sessions").fetchall()
    ]
    return {
        "version": 1,
        "workspaces": workspaces,
        "users": users,
        "sessions": sessions,
        "exported_at": time.time(),
    }


def import_db(conn, snapshot: dict[str, Any]) -> int:
    """Replace local auth tables with remote snapshot. Returns user count."""
    workspaces = snapshot.get("workspaces") or []
    users = snapshot.get("users") or []
    sessions = snapshot.get("sessions") or []

    conn.execute("DELETE FROM sessions")
    conn.execute("DELETE FROM users")
    conn.execute("DELETE FROM workspaces")

    for w in workspaces:
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
            (w["id"], w["name"], float(w["created_at"])),
        )
    for u in users:
        conn.execute(
            """
            INSERT INTO users (
                id, email, password_hash, first_name, last_name, role,
                workspace_id, status, is_active, invite_token_hash,
                invite_expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                u["id"],
                u["email"],
                u.get("password_hash"),
                u.get("first_name"),
                u.get("last_name"),
                u.get("role") or "user",
                u["workspace_id"],
                u.get("status") or "pending",
                int(u.get("is_active", 1)),
                u.get("invite_token_hash"),
                u.get("invite_expires_at"),
                float(u["created_at"]),
                float(u["updated_at"]),
            ),
        )
    now = time.time()
    for s in sessions:
        exp = float(s["expires_at"])
        if exp <= now:
            continue
        conn.execute(
            """
            INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                s["token_hash"],
                s["user_id"],
                exp,
                float(s["created_at"]),
            ),
        )
    conn.commit()
    return len(users)


def sync_after_write(conn) -> None:
    if not kv_enabled():
        return
    try:
        snap = export_db(conn)
        ok = push_snapshot(snap)
        if ok:
            print(
                f"[PhotoEditor auth_sync] pushed snapshot "
                f"users={len(snap['users'])} sessions={len(snap['sessions'])}"
            )
    except Exception as exc:  # noqa: BLE001
        print(f"[PhotoEditor auth_sync] push error: {exc}")


def restore_on_boot(conn) -> str:
    if not kv_enabled():
        return "kv_disabled"

    mode = "api" if kv_api_enabled() else "worker"
    local_users = int(conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"])
    remote = fetch_snapshot()
    if remote is None:
        if local_users > 0:
            sync_after_write(conn)
            return f"{mode}:kv_empty_pushed_local users={local_users}"
        return f"{mode}:kv_empty_local_empty"

    remote_users = len(remote.get("users") or [])
    if remote_users == 0:
        if local_users > 0:
            sync_after_write(conn)
            return f"{mode}:kv_zero_users_pushed_local users={local_users}"
        return f"{mode}:kv_zero_users"

    n = import_db(conn, remote)
    return f"{mode}:kv_restored users={n} (was local={local_users})"
