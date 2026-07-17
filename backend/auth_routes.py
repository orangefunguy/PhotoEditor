"""Auth HTTP routes — setup, login, invite, complete-invite, workspace users."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, EmailStr, Field

from . import auth as authmod
from .auth import (
    SESSION_COOKIE,
    VIEW_AS_COOKIE,
    AuthContext,
    cookie_samesite,
    cookie_secure,
    create_admin_user,
    create_invite,
    create_session,
    delete_session,
    get_optional_auth,
    get_user_by_email,
    get_user_by_id,
    list_workspace_users,
    require_admin,
    require_auth,
    set_user_active,
    verify_password,
)
from .auth_db import db
from .auth_sync import kv_enabled
from .email_service import email_status

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


class SetupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class InviteRequest(BaseModel):
    email: EmailStr
    role: str = Field(default="user", pattern="^(admin|user)$")


class CompleteInviteRequest(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=10, max_length=128)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)


class ViewAsRequest(BaseModel):
    user_id: str


def _set_session_cookie(response: Response, token: str) -> None:
    # path=/ + no Domain attribute so iOS Safari/Chrome same-site cookies stick
    # under the public host (editor.herooflegend.com) through the CF Worker.
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite=cookie_samesite(),
        secure=cookie_secure(),
        max_age=authmod.SESSION_DAYS * 86400,
        path="/",
    )


def _set_view_as_cookie(response: Response, user_id: str) -> None:
    response.set_cookie(
        key=VIEW_AS_COOKIE,
        value=user_id,
        httponly=True,
        samesite=cookie_samesite(),
        secure=cookie_secure(),
        max_age=authmod.SESSION_DAYS * 86400,
        path="/",
    )


@router.get("/status")
def auth_status(ctx: AuthContext | None = Depends(get_optional_auth)) -> dict[str, Any]:
    return {
        "auth_enabled": authmod.AUTH_ENABLED,
        "needs_setup": authmod.needs_setup(),
        "authenticated": ctx is not None,
        "user": ctx.user.public_dict() if ctx else None,
        "actor": ctx.actor.public_dict() if ctx else None,
        "view_as_user_id": ctx.view_as_user_id if ctx else None,
        "viewing_as_other": bool(ctx and ctx.view_as_user_id),
        "email": email_status(),
        "frontend_url": authmod.frontend_url(),
        "session_days": authmod.SESSION_DAYS,
        "durable_auth": kv_enabled(),
    }


@router.post("/setup")
def setup(body: SetupRequest, response: Response) -> dict[str, Any]:
    if not authmod.needs_setup():
        raise HTTPException(400, "Setup already completed. Sign in instead.")
    try:
        user = create_admin_user(
            email=str(body.email),
            password=body.password,
            first_name=body.first_name,
            last_name=body.last_name,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    token = create_session(user.id)
    _set_session_cookie(response, token)
    return {
        "status": "ok",
        "message": "Admin account created.",
        "user": user.public_dict(),
    }


@router.post("/login")
def login(body: LoginRequest, response: Response) -> dict[str, Any]:
    if authmod.needs_setup():
        raise HTTPException(400, "Complete first-time setup first.")
    user = get_user_by_email(str(body.email))
    if not user or not user.is_active or user.status != "active":
        raise HTTPException(401, "Invalid email or password.")
    conn = db()
    try:
        row = conn.execute(
            "SELECT password_hash FROM users WHERE id = ?", (user.id,)
        ).fetchone()
        ph = row["password_hash"] if row else None
    finally:
        conn.close()
    if not verify_password(body.password, ph):
        raise HTTPException(401, "Invalid email or password.")
    token = create_session(user.id)
    _set_session_cookie(response, token)
    response.delete_cookie(VIEW_AS_COOKIE, path="/")
    return {"status": "ok", "user": user.public_dict()}


@router.post("/logout")
def logout(
    response: Response,
    pe_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, str]:
    delete_session(pe_session)
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(VIEW_AS_COOKIE, path="/")
    return {"status": "ok"}


@router.get("/me")
def me(ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    return {
        "user": ctx.user.public_dict(),
        "actor": ctx.actor.public_dict(),
        "view_as_user_id": ctx.view_as_user_id,
        "viewing_as_other": bool(ctx.view_as_user_id),
        "workspace_id": ctx.workspace_id,
    }


@router.post("/invite")
def invite(
    body: InviteRequest,
    ctx: AuthContext = Depends(require_admin),
) -> dict[str, Any]:
    try:
        user, link, email_result = create_invite(
            email=str(body.email),
            role=body.role,
            workspace_id=ctx.actor.workspace_id,
            invited_by=ctx.actor,
        )
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    days = authmod.INVITE_DAYS
    if email_result.ok and email_result.transport != "log":
        message = (
            f"Invite email sent to {user.email} via {email_result.transport}. "
            f"The invite link expires in {days} days."
        )
    elif email_result.ok:
        message = (
            f"Invite created (expires in {days} days). Email is in log-only mode — copy the link "
            "below (or check data/invite_links.log)."
        )
    else:
        message = (
            f"Invite created but email failed ({email_result.message}). "
            f"Copy the link below and share it manually. Link expires in {days} days."
        )

    return {
        "status": "ok",
        "user": user.public_dict(),
        "invite_link": link,
        "invite_expires_days": days,
        "email": email_result.as_dict(),
        "message": message,
    }


@router.post("/complete-invite")
def complete_invite_route(body: CompleteInviteRequest, response: Response) -> dict[str, Any]:
    try:
        user = authmod.complete_invite(
            token=body.token,
            password=body.password,
            first_name=body.first_name,
            last_name=body.last_name,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    token = create_session(user.id)
    _set_session_cookie(response, token)
    return {
        "status": "complete",
        "user": user.public_dict(),
        "message": "Profile completed. You are signed in.",
    }


@router.get("/users")
def users(ctx: AuthContext = Depends(require_admin)) -> dict[str, Any]:
    return {
        "workspace_id": ctx.actor.workspace_id,
        "users": list_workspace_users(ctx.actor.workspace_id),
    }


@router.post("/users/{user_id}/deactivate")
def deactivate(user_id: str, ctx: AuthContext = Depends(require_admin)) -> dict[str, Any]:
    try:
        user = set_user_active(user_id, False, ctx.actor)
    except (PermissionError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"status": "ok", "user": user.public_dict()}


@router.post("/users/{user_id}/activate")
def activate(user_id: str, ctx: AuthContext = Depends(require_admin)) -> dict[str, Any]:
    try:
        user = set_user_active(user_id, True, ctx.actor)
    except (PermissionError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"status": "ok", "user": user.public_dict()}


@router.post("/view-as")
def view_as(
    body: ViewAsRequest,
    response: Response,
    ctx: AuthContext = Depends(require_admin),
) -> dict[str, Any]:
    """Admin: view another profile's data within the same workspace."""
    target = get_user_by_id(body.user_id)
    if not target or target.workspace_id != ctx.actor.workspace_id:
        raise HTTPException(404, "User not found in your workspace.")
    if not target.is_active:
        raise HTTPException(400, "User is inactive.")
    _set_view_as_cookie(response, target.id)
    return {
        "status": "ok",
        "view_as": target.public_dict(),
        "message": f"Now viewing workspace data as {target.display_name}.",
    }


@router.delete("/view-as")
def clear_view_as(
    response: Response,
    ctx: AuthContext = Depends(require_admin),
) -> dict[str, Any]:
    response.delete_cookie(VIEW_AS_COOKIE, path="/")
    return {
        "status": "ok",
        "message": "Returned to your own profile.",
        "user": ctx.actor.public_dict(),
    }


@router.get("/email-status")
def get_email_status(ctx: AuthContext = Depends(require_admin)) -> dict[str, Any]:
    """Admin: whether outbound email is configured for production invites."""
    return email_status()
