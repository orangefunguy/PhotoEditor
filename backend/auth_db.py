"""SQLite persistence for PhotoEditor auth (invites + profiles + sessions).

In production on ephemeral hosts, pair with auth_sync → Cloudflare KV so
accounts and sessions survive restarts.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DB_PATH = DATA / "photoeditor.db"

_lock = threading.Lock()
_initialized = False


def _connect() -> sqlite3.Connection:
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    global _initialized
    with _lock:
        if _initialized:
            return
        conn = _connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS workspaces (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT,
                    first_name TEXT,
                    last_name TEXT,
                    role TEXT NOT NULL DEFAULT 'user',
                    workspace_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    is_active INTEGER NOT NULL DEFAULT 1,
                    invite_token_hash TEXT,
                    invite_expires_at REAL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    created_at REAL NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
                CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id);
                CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
                """
            )
            conn.commit()

            # Restore durable accounts from Cloudflare KV when configured
            try:
                from .auth_sync import restore_on_boot

                status = restore_on_boot(conn)
                print(f"[PhotoEditor auth] init: {status}")
            except Exception as exc:  # noqa: BLE001
                print(f"[PhotoEditor auth] durable restore skipped: {exc}")

            _initialized = True
        finally:
            conn.close()


def db() -> sqlite3.Connection:
    init_db()
    return _connect()


def commit_and_sync(conn: sqlite3.Connection) -> None:
    """Commit local transaction and push durable snapshot when KV is enabled."""
    conn.commit()
    try:
        from .auth_sync import sync_after_write

        sync_after_write(conn)
    except Exception as exc:  # noqa: BLE001
        print(f"[PhotoEditor auth] sync after write failed: {exc}")


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}
