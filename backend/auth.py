"""Authentication helpers modeled on LeadForge CRM (invite + session + roles).

Uses local SQLite instead of Supabase so PhotoEditor can run fully offline,
while preserving the same product flow:
  - first user becomes admin
  - admin invites by email
  - invitee completes profile (name + password)
  - session cookie for web UI
  - per-user data scope; admin can view-as other profiles in the workspace
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import smtplib
import time
from dataclasses import dataclass
from email.message import EmailMessage
from pathlib import Path
from typing import Any

import bcrypt
from fastapi import Cookie, Depends, Header, HTTPException, status

from .auth_db import db, init_db, row_to_dict  # noqa: F401 — init_db used by callers

SESSION_COOKIE = "pe_session"
VIEW_AS_COOKIE = "pe_view_as"
SESSION_DAYS = 14
INVITE_DAYS = 7

# CRM-aligned password policy (slightly relaxed length for local installs: 10+)
PASSWORD_MIN = 10

ROOT = Path(__file__).resolve().parent.parent
INVITE_LOG = ROOT / "data" / "invite_links.log"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.lower() in ("1", "true", "yes", "on")


AUTH_ENABLED = _env_bool("AUTH_ENABLED", True)


@dataclass
class AuthUser:
    id: str
    email: str
    first_name: str | None
    last_name: str | None
    role: str
    workspace_id: str
    status: str
    is_active: bool

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def display_name(self) -> str:
        parts = [p for p in (self.first_name, self.last_name) if p]
        return " ".join(parts) if parts else self.email

    def public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "email": self.email,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "display_name": self.display_name,
            "role": self.role,
            "workspace_id": self.workspace_id,
            "status": self.status,
            "is_admin": self.is_admin,
            "is_active": self.is_active,
        }


@dataclass
class AuthContext:
    user: AuthUser
    """Effective user for data access (may differ when admin is viewing-as)."""
    actor: AuthUser
    view_as_user_id: str | None = None

    @property
    def is_admin(self) -> bool:
        return self.actor.is_admin

    @property
    def data_user_id(self) -> str:
        return self.user.id

    @property
    def workspace_id(self) -> str:
        return self.user.workspace_id


def hash_password(password: str) -> str:
    raw = password.encode("utf-8")[:72]
    return bcrypt.hashpw(raw, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    try:
        raw = password.encode("utf-8")[:72]
        return bcrypt.checkpw(raw, password_hash.encode("utf-8"))
    except Exception:
        return False


def validate_password_strength(password: str) -> None:
    if len(password) < PASSWORD_MIN:
        raise ValueError(f"Password must be at least {PASSWORD_MIN} characters.")
    if not any(c.islower() for c in password):
        raise ValueError("Password must include a lowercase letter.")
    if not any(c.isupper() for c in password):
        raise ValueError("Password must include an uppercase letter.")
    if not any(c.isdigit() for c in password):
        raise ValueError("Password must include a number.")
    if not any(not c.isalnum() for c in password):
        raise ValueError("Password must include a special character.")


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def frontend_url() -> str:
    return os.getenv("FRONTEND_URL", "http://127.0.0.1:8000").rstrip("/")


def user_count() -> int:
    conn = db()
    try:
        return int(conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"])
    finally:
        conn.close()


def needs_setup() -> bool:
    return user_count() == 0


def get_user_by_id(user_id: str) -> AuthUser | None:
    conn = db()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _user_from_row(row)
    finally:
        conn.close()


def get_user_by_email(email: str) -> AuthUser | None:
    conn = db()
    try:
        row = conn.execute(
            "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
            (email.strip().lower(),),
        ).fetchone()
        return _user_from_row(row)
    finally:
        conn.close()


def _user_from_row(row: Any) -> AuthUser | None:
    d = row_to_dict(row)
    if not d:
        return None
    return AuthUser(
        id=d["id"],
        email=d["email"],
        first_name=d.get("first_name"),
        last_name=d.get("last_name"),
        role=d.get("role") or "user",
        workspace_id=d["workspace_id"],
        status=d.get("status") or "pending",
        is_active=bool(d.get("is_active", 1)),
    )


def create_workspace(name: str = "Default workspace") -> str:
    wid = secrets.token_hex(8)
    now = time.time()
    conn = db()
    try:
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
            (wid, name, now),
        )
        conn.commit()
        return wid
    finally:
        conn.close()


def create_admin_user(
    *,
    email: str,
    password: str,
    first_name: str,
    last_name: str,
) -> AuthUser:
    if not needs_setup():
        raise ValueError("Setup already completed.")
    validate_password_strength(password)
    email_n = email.strip().lower()
    wid = create_workspace("PhotoEditor Workspace")
    uid = secrets.token_hex(12)
    now = time.time()
    conn = db()
    try:
        conn.execute(
            """
            INSERT INTO users (
                id, email, password_hash, first_name, last_name, role,
                workspace_id, status, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'admin', ?, 'active', 1, ?, ?)
            """,
            (
                uid,
                email_n,
                hash_password(password),
                first_name.strip(),
                last_name.strip(),
                wid,
                now,
                now,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    user = get_user_by_id(uid)
    assert user
    return user


def create_session(user_id: str) -> str:
    raw = secrets.token_urlsafe(32)
    th = hash_token(raw)
    now = time.time()
    exp = now + SESSION_DAYS * 86400
    conn = db()
    try:
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (th, user_id, exp, now),
        )
        conn.commit()
    finally:
        conn.close()
    return raw


def delete_session(raw_token: str | None) -> None:
    if not raw_token:
        return
    conn = db()
    try:
        conn.execute(
            "DELETE FROM sessions WHERE token_hash = ?",
            (hash_token(raw_token),),
        )
        conn.commit()
    finally:
        conn.close()


def user_from_session(raw_token: str | None) -> AuthUser | None:
    if not raw_token:
        return None
    conn = db()
    try:
        row = conn.execute(
            """
            SELECT u.* FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1 AND u.status = 'active'
            """,
            (hash_token(raw_token), time.time()),
        ).fetchone()
        return _user_from_row(row)
    finally:
        conn.close()


def create_invite(
    *,
    email: str,
    role: str,
    workspace_id: str,
    invited_by: AuthUser,
) -> tuple[AuthUser, str]:
    if not invited_by.is_admin:
        raise PermissionError("Only admins can invite users.")
    if role not in ("admin", "user"):
        raise ValueError("Role must be admin or user.")
    email_n = email.strip().lower()
    existing = get_user_by_email(email_n)
    if existing and existing.status == "active":
        raise ValueError("A user with this email is already active.")

    raw_token = secrets.token_urlsafe(32)
    token_hash = hash_token(raw_token)
    now = time.time()
    exp = now + INVITE_DAYS * 86400
    conn = db()
    try:
        if existing:
            uid = existing.id
            conn.execute(
                """
                UPDATE users SET
                    role = ?, invite_token_hash = ?, invite_expires_at = ?,
                    status = 'pending', password_hash = NULL, is_active = 1,
                    updated_at = ?
                WHERE id = ?
                """,
                (role, token_hash, exp, now, uid),
            )
        else:
            uid = secrets.token_hex(12)
            conn.execute(
                """
                INSERT INTO users (
                    id, email, password_hash, first_name, last_name, role,
                    workspace_id, status, is_active, invite_token_hash,
                    invite_expires_at, created_at, updated_at
                ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, 'pending', 1, ?, ?, ?, ?)
                """,
                (uid, email_n, role, workspace_id, token_hash, exp, now, now),
            )
        conn.commit()
    finally:
        conn.close()

    user = get_user_by_id(uid)
    assert user
    link = f"{frontend_url()}/invite?token={raw_token}"
    _deliver_invite(email_n, link, invited_by.email)
    return user, link


def complete_invite(
    *,
    token: str,
    password: str,
    first_name: str,
    last_name: str,
) -> AuthUser:
    validate_password_strength(password)
    th = hash_token(token)
    now = time.time()
    conn = db()
    try:
        row = conn.execute(
            """
            SELECT * FROM users
            WHERE invite_token_hash = ? AND invite_expires_at > ? AND status = 'pending'
            """,
            (th, now),
        ).fetchone()
        if not row:
            raise ValueError("Invite is invalid or expired.")
        uid = row["id"]
        conn.execute(
            """
            UPDATE users SET
                password_hash = ?, first_name = ?, last_name = ?,
                status = 'active', invite_token_hash = NULL, invite_expires_at = NULL,
                updated_at = ?
            WHERE id = ?
            """,
            (
                hash_password(password),
                first_name.strip(),
                last_name.strip(),
                now,
                uid,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    user = get_user_by_id(uid)
    assert user
    return user


def list_workspace_users(workspace_id: str) -> list[dict[str, Any]]:
    conn = db()
    try:
        rows = conn.execute(
            """
            SELECT id, email, first_name, last_name, role, status, is_active, created_at, updated_at
            FROM users WHERE workspace_id = ?
            ORDER BY role DESC, email ASC
            """,
            (workspace_id,),
        ).fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r)
            assert d
            d["is_active"] = bool(d["is_active"])
            d["display_name"] = (
                " ".join(p for p in (d.get("first_name"), d.get("last_name")) if p)
                or d["email"]
            )
            out.append(d)
        return out
    finally:
        conn.close()


def set_user_active(user_id: str, active: bool, actor: AuthUser) -> AuthUser:
    if not actor.is_admin:
        raise PermissionError("Admin only.")
    if user_id == actor.id and not active:
        raise ValueError("You cannot deactivate yourself.")
    conn = db()
    try:
        conn.execute(
            "UPDATE users SET is_active = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
            (1 if active else 0, time.time(), user_id, actor.workspace_id),
        )
        conn.commit()
    finally:
        conn.close()
    user = get_user_by_id(user_id)
    if not user:
        raise ValueError("User not found.")
    return user


def _deliver_invite(email: str, link: str, invited_by: str) -> None:
    """Send invite email if SMTP configured; always log the link (CRM local-dev friendly)."""
    INVITE_LOG.parent.mkdir(parents=True, exist_ok=True)
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} invite for {email} by {invited_by}: {link}\n"
    with INVITE_LOG.open("a", encoding="utf-8") as f:
        f.write(line)
    print(f"[PhotoEditor invite] {email} → {link}")

    host = os.getenv("SMTP_HOST")
    if not host:
        return
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER", "")
    password = os.getenv("SMTP_PASSWORD", "")
    sender = os.getenv("SMTP_FROM", user or "photoeditor@localhost")
    use_tls = _env_bool("SMTP_TLS", True)

    msg = EmailMessage()
    msg["Subject"] = "You're invited to PhotoEditor"
    msg["From"] = sender
    msg["To"] = email
    msg.set_content(
        f"You have been invited to PhotoEditor by {invited_by}.\n\n"
        f"Accept your invite and set your password:\n{link}\n\n"
        f"This link expires in {INVITE_DAYS} days.\n"
    )
    try:
        with smtplib.SMTP(host, port, timeout=20) as smtp:
            if use_tls:
                smtp.starttls()
            if user:
                smtp.login(user, password)
            smtp.send_message(msg)
    except Exception as exc:  # noqa: BLE001
        print(f"[PhotoEditor invite] SMTP failed: {exc} (link still in {INVITE_LOG})")


async def get_optional_auth(
    pe_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    pe_view_as: str | None = Cookie(default=None, alias=VIEW_AS_COOKIE),
    authorization: str | None = Header(default=None),
) -> AuthContext | None:
    init_db()
    if not AUTH_ENABLED:
        # Dev bypass: synthetic admin
        if needs_setup():
            return None
        # If users exist, still require real auth when AUTH_ENABLED false... keep open for tests
        return None

    token = pe_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    actor = user_from_session(token)
    if not actor:
        return None

    view_user = None
    if pe_view_as and actor.is_admin:
        candidate = get_user_by_id(pe_view_as)
        if (
            candidate
            and candidate.workspace_id == actor.workspace_id
            and candidate.is_active
        ):
            view_user = candidate

    return AuthContext(
        user=view_user or actor,
        actor=actor,
        view_as_user_id=view_user.id if view_user else None,
    )


async def require_auth(
    ctx: AuthContext | None = Depends(get_optional_auth),
) -> AuthContext:
    if not AUTH_ENABLED:
        # Create ephemeral dev context if setup done without auth
        if needs_setup():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Complete first-time setup.",
            )
        # When AUTH_ENABLED=false after setup, use first admin
        conn = db()
        try:
            row = conn.execute(
                "SELECT * FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1"
            ).fetchone()
        finally:
            conn.close()
        admin = _user_from_row(row)
        if not admin:
            raise HTTPException(401, "No admin user.")
        return AuthContext(user=admin, actor=admin)

    if ctx is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
        )
    return ctx


async def require_admin(ctx: AuthContext = Depends(require_auth)) -> AuthContext:
    if not ctx.actor.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required.")
    return ctx


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
