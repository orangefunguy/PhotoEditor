"""Per-user error/warning activity logs + agent API keys for operator/agent access."""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from typing import Any

from .auth_db import commit_and_sync, db, row_to_dict

MAX_LOGS_PER_USER = 500
KEY_PREFIX = "pe_agent_"


def ensure_log_tables() -> None:
    conn = db()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS activity_logs (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                workspace_id TEXT,
                at REAL NOT NULL,
                level TEXT NOT NULL,
                source TEXT NOT NULL,
                code TEXT,
                message TEXT NOT NULL,
                detail TEXT,
                path TEXT,
                meta_json TEXT,
                user_email TEXT,
                user_display_name TEXT,
                client_at REAL,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_activity_logs_user_at
                ON activity_logs(user_id, at DESC);
            CREATE INDEX IF NOT EXISTS idx_activity_logs_level
                ON activity_logs(user_id, level);
            CREATE INDEX IF NOT EXISTS idx_activity_logs_source
                ON activity_logs(user_id, source);

            CREATE TABLE IF NOT EXISTS agent_api_keys (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                created_by TEXT NOT NULL,
                name TEXT NOT NULL,
                key_prefix TEXT NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                created_at REAL NOT NULL,
                last_used_at REAL,
                revoked INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_agent_keys_ws
                ON agent_api_keys(workspace_id, revoked);
            """
        )
        conn.commit()
    finally:
        conn.close()


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def create_agent_key(
    *,
    workspace_id: str,
    created_by: str,
    name: str,
) -> dict[str, Any]:
    """Create an agent API key. Returns full secret once (not stored plaintext)."""
    ensure_log_tables()
    kid = secrets.token_hex(8)
    secret = secrets.token_urlsafe(32)
    raw = f"{KEY_PREFIX}{secret}"
    prefix = raw[:16]
    now = time.time()
    conn = db()
    try:
        conn.execute(
            """
            INSERT INTO agent_api_keys
            (id, workspace_id, created_by, name, key_prefix, key_hash, created_at, revoked)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (kid, workspace_id, created_by, name.strip() or "Agent key", prefix, _hash_key(raw), now),
        )
        commit_and_sync(conn)
    finally:
        conn.close()
    return {
        "id": kid,
        "name": name.strip() or "Agent key",
        "key_prefix": prefix,
        "api_key": raw,  # shown once
        "created_at": now,
        "hint": "Store this key securely. It will not be shown again.",
    }


def list_agent_keys(workspace_id: str) -> list[dict[str, Any]]:
    ensure_log_tables()
    conn = db()
    try:
        rows = conn.execute(
            """
            SELECT id, workspace_id, created_by, name, key_prefix, created_at,
                   last_used_at, revoked
            FROM agent_api_keys
            WHERE workspace_id = ?
            ORDER BY created_at DESC
            """,
            (workspace_id,),
        ).fetchall()
        return [row_to_dict(r) for r in rows]  # type: ignore[misc]
    finally:
        conn.close()


def revoke_agent_key(key_id: str, workspace_id: str) -> bool:
    ensure_log_tables()
    conn = db()
    try:
        cur = conn.execute(
            """
            UPDATE agent_api_keys SET revoked = 1
            WHERE id = ? AND workspace_id = ?
            """,
            (key_id, workspace_id),
        )
        commit_and_sync(conn)
        return cur.rowcount > 0
    finally:
        conn.close()


def verify_agent_key(raw: str | None) -> dict[str, Any] | None:
    if not raw or not raw.startswith(KEY_PREFIX):
        return None
    ensure_log_tables()
    h = _hash_key(raw)
    conn = db()
    try:
        row = conn.execute(
            """
            SELECT id, workspace_id, created_by, name, key_prefix, revoked
            FROM agent_api_keys WHERE key_hash = ?
            """,
            (h,),
        ).fetchone()
        if not row or row["revoked"]:
            return None
        conn.execute(
            "UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?",
            (time.time(), row["id"]),
        )
        conn.commit()
        return row_to_dict(row)
    finally:
        conn.close()


def _entry_public(row: dict[str, Any]) -> dict[str, Any]:
    meta = None
    if row.get("meta_json"):
        try:
            meta = json.loads(row["meta_json"])
        except json.JSONDecodeError:
            meta = {"_raw": row["meta_json"]}
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "workspace_id": row.get("workspace_id"),
        "at": row["at"],
        "level": row["level"],
        "source": row["source"],
        "code": row.get("code"),
        "message": row["message"],
        "detail": row.get("detail") or row["message"],
        "path": row.get("path"),
        "meta": meta,
        "user_email": row.get("user_email"),
        "user_display_name": row.get("user_display_name"),
        "account": {
            "id": row["user_id"],
            "email": row.get("user_email"),
            "display_name": row.get("user_display_name"),
        },
        "client_at": row.get("client_at"),
        "created_at": row.get("created_at"),
    }


def ingest_logs(
    user_id: str,
    workspace_id: str | None,
    entries: list[dict[str, Any]],
    *,
    user_email: str | None = None,
    user_display_name: str | None = None,
) -> int:
    """Insert client log entries; returns count inserted."""
    ensure_log_tables()
    if not entries:
        return 0
    now = time.time()
    conn = db()
    inserted = 0
    try:
        for raw in entries[:100]:
            if not isinstance(raw, dict):
                continue
            level = str(raw.get("level") or "").lower()
            if level not in ("error", "warning"):
                continue
            eid = str(raw.get("id") or f"{secrets.token_hex(8)}")
            msg = str(raw.get("message") or "Unknown issue")[:2000]
            detail = raw.get("detail")
            if detail is not None:
                detail = str(detail)[:8000]
            else:
                detail = msg
            code = raw.get("code")
            code = str(code)[:120] if code else None
            source = str(raw.get("source") or "app")[:80]
            path = raw.get("path")
            path = str(path)[:500] if path else None
            meta = raw.get("meta") if isinstance(raw.get("meta"), dict) else None
            # Fold useful top-level fields into meta for precision
            extra_meta = {}
            for k in ("status", "url", "method", "stack", "filename", "size", "algorithm"):
                if raw.get(k) is not None:
                    extra_meta[k] = raw[k]
            if meta:
                extra_meta.update(meta)
            meta_json = json.dumps(extra_meta, default=str) if extra_meta else None
            at = float(raw.get("at") or raw.get("client_at") or now)
            client_at = raw.get("client_at")
            client_at = float(client_at) if client_at is not None else at
            email = raw.get("user_email") or user_email
            display = raw.get("user_display_name") or user_display_name
            try:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO activity_logs
                    (id, user_id, workspace_id, at, level, source, code, message, detail,
                     path, meta_json, user_email, user_display_name, client_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        eid,
                        user_id,
                        workspace_id,
                        at,
                        level,
                        source,
                        code,
                        msg,
                        detail,
                        path,
                        meta_json,
                        email,
                        display,
                        client_at,
                        now,
                    ),
                )
                if conn.total_changes:
                    inserted += 1
            except Exception:
                continue

        # Cap per-user log size
        conn.execute(
            """
            DELETE FROM activity_logs
            WHERE user_id = ?
              AND id NOT IN (
                SELECT id FROM activity_logs
                WHERE user_id = ?
                ORDER BY at DESC
                LIMIT ?
              )
            """,
            (user_id, user_id, MAX_LOGS_PER_USER),
        )
        conn.commit()
    finally:
        conn.close()
    return inserted


def list_logs(
    user_id: str,
    *,
    level: str | None = None,
    source: str | None = None,
    code: str | None = None,
    q: str | None = None,
    since: float | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    ensure_log_tables()
    limit = max(1, min(int(limit or 100), 500))
    clauses = ["user_id = ?"]
    params: list[Any] = [user_id]
    if level in ("error", "warning"):
        clauses.append("level = ?")
        params.append(level)
    if source:
        clauses.append("source = ?")
        params.append(source)
    if code:
        clauses.append("code = ?")
        params.append(code)
    if since is not None:
        clauses.append("at >= ?")
        params.append(float(since))
    if q:
        clauses.append("(message LIKE ? OR detail LIKE ? OR code LIKE ? OR path LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like, like, like])
    where = " AND ".join(clauses)
    conn = db()
    try:
        rows = conn.execute(
            f"""
            SELECT * FROM activity_logs
            WHERE {where}
            ORDER BY at DESC
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()
        return [_entry_public(row_to_dict(r)) for r in rows]  # type: ignore[arg-type]
    finally:
        conn.close()


def clear_logs(user_id: str) -> int:
    ensure_log_tables()
    conn = db()
    try:
        cur = conn.execute("DELETE FROM activity_logs WHERE user_id = ?", (user_id,))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def count_logs(user_id: str) -> int:
    ensure_log_tables()
    conn = db()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM activity_logs WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        return int(row["n"]) if row else 0
    finally:
        conn.close()


def search_accounts(
    workspace_id: str,
    *,
    q: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Admin/agent account finder with log counts."""
    ensure_log_tables()
    limit = max(1, min(int(limit or 50), 200))
    conn = db()
    try:
        if q:
            like = f"%{q.strip()}%"
            rows = conn.execute(
                """
                SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.status, u.is_active,
                       (SELECT COUNT(*) FROM activity_logs a WHERE a.user_id = u.id) AS log_count,
                       (SELECT MAX(at) FROM activity_logs a WHERE a.user_id = u.id) AS last_log_at
                FROM users u
                WHERE u.workspace_id = ?
                  AND (
                    u.email LIKE ? COLLATE NOCASE
                    OR u.first_name LIKE ? COLLATE NOCASE
                    OR u.last_name LIKE ? COLLATE NOCASE
                    OR u.id LIKE ?
                  )
                ORDER BY (last_log_at IS NULL), last_log_at DESC, u.email ASC
                LIMIT ?
                """,
                (workspace_id, like, like, like, like, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.status, u.is_active,
                       (SELECT COUNT(*) FROM activity_logs a WHERE a.user_id = u.id) AS log_count,
                       (SELECT MAX(at) FROM activity_logs a WHERE a.user_id = u.id) AS last_log_at
                FROM users u
                WHERE u.workspace_id = ?
                ORDER BY (last_log_at IS NULL), last_log_at DESC, u.email ASC
                LIMIT ?
                """,
                (workspace_id, limit),
            ).fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r) or {}
            parts = [p for p in (d.get("first_name"), d.get("last_name")) if p]
            d["display_name"] = " ".join(parts) if parts else d.get("email")
            d["account_label"] = f"{d['display_name']} <{d.get('email')}> [{d.get('id')}]"
            out.append(d)
        return out
    finally:
        conn.close()
