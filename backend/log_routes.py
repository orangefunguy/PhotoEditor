"""Error/warning activity log APIs (session + agent API key)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from . import activity_logs as alogs
from .auth import AuthContext, get_user_by_id, require_admin, require_auth

router = APIRouter(tags=["Activity logs"])


class LogIngestBody(BaseModel):
    entries: list[dict[str, Any]] = Field(default_factory=list, max_length=100)


class CreateKeyBody(BaseModel):
    name: str = Field(default="Agent key", min_length=1, max_length=120)


def _agent_from_headers(
    authorization: str | None,
    x_api_key: str | None,
    x_pe_agent_key: str | None,
) -> dict[str, Any]:
    raw = None
    if x_pe_agent_key:
        raw = x_pe_agent_key.strip()
    elif x_api_key:
        raw = x_api_key.strip()
    elif authorization and authorization.lower().startswith("bearer "):
        raw = authorization[7:].strip()
    key = alogs.verify_agent_key(raw)
    if not key:
        raise HTTPException(401, "Invalid or revoked agent API key.")
    return key


# ── Session-authenticated (browser) ───────────────────────────────────


@router.post("/api/logs")
def ingest_logs(
    body: LogIngestBody,
    ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    n = alogs.ingest_logs(
        ctx.data_user_id,
        ctx.workspace_id,
        body.entries,
        user_email=ctx.user.email,
        user_display_name=ctx.user.display_name,
    )
    return {"inserted": n, "user_id": ctx.data_user_id}


@router.get("/api/logs")
def get_logs(
    level: str | None = None,
    source: str | None = None,
    code: str | None = None,
    q: str | None = None,
    since: float | None = None,
    limit: int = 100,
    user_id: str | None = Query(
        None,
        description="Admin only: read logs for this account id",
    ),
    ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    target_id = ctx.data_user_id
    account = {
        "id": ctx.user.id,
        "email": ctx.user.email,
        "display_name": ctx.user.display_name,
        "role": ctx.user.role,
    }
    if user_id and user_id != ctx.data_user_id:
        if not ctx.actor.is_admin:
            raise HTTPException(403, "Only admins can read another account's logs.")
        target = get_user_by_id(user_id)
        if not target or target.workspace_id != ctx.actor.workspace_id:
            raise HTTPException(404, "Account not found in this workspace.")
        target_id = target.id
        account = target.public_dict()

    entries = alogs.list_logs(
        target_id,
        level=level,
        source=source,
        code=code,
        q=q,
        since=since,
        limit=limit,
    )
    return {
        "account": account,
        "account_label": f"{account.get('display_name') or account.get('email')} <{account.get('email')}> [{account.get('id')}]",
        "count": len(entries),
        "total_for_user": alogs.count_logs(target_id),
        "entries": entries,
    }


@router.delete("/api/logs")
def delete_logs(
    user_id: str | None = Query(None, description="Admin only: clear another account"),
    ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    target_id = ctx.data_user_id
    if user_id and user_id != ctx.data_user_id:
        if not ctx.actor.is_admin:
            raise HTTPException(403, "Only admins can clear another account's logs.")
        target = get_user_by_id(user_id)
        if not target or target.workspace_id != ctx.actor.workspace_id:
            raise HTTPException(404, "Account not found.")
        target_id = target.id
    n = alogs.clear_logs(target_id)
    return {"cleared": n, "user_id": target_id}


@router.get("/api/logs/accounts")
def log_accounts(
    q: str | None = None,
    limit: int = 50,
    ctx: AuthContext = Depends(require_admin),
) -> dict[str, Any]:
    """Admin account finder for selecting whose logs to inspect."""
    accounts = alogs.search_accounts(ctx.actor.workspace_id, q=q, limit=limit)
    return {
        "workspace_id": ctx.actor.workspace_id,
        "query": q,
        "count": len(accounts),
        "accounts": accounts,
    }


@router.get("/api/logs/api-keys")
def list_keys(ctx: AuthContext = Depends(require_admin)) -> dict[str, Any]:
    return {"keys": alogs.list_agent_keys(ctx.actor.workspace_id)}


@router.post("/api/logs/api-keys")
def create_key(
    body: CreateKeyBody,
    ctx: AuthContext = Depends(require_admin),
) -> dict[str, Any]:
    key = alogs.create_agent_key(
        workspace_id=ctx.actor.workspace_id,
        created_by=ctx.actor.id,
        name=body.name,
    )
    return key


@router.delete("/api/logs/api-keys/{key_id}")
def revoke_key(key_id: str, ctx: AuthContext = Depends(require_admin)) -> dict[str, Any]:
    ok = alogs.revoke_agent_key(key_id, ctx.actor.workspace_id)
    if not ok:
        raise HTTPException(404, "API key not found.")
    return {"revoked": True, "id": key_id}


# ── Agent API (API key) ───────────────────────────────────────────────


@router.get("/api/agent/v1/accounts")
def agent_accounts(
    q: str | None = Query(None, description="Search email, name, or user id"),
    limit: int = 50,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None, alias="X-API-Key"),
    x_pe_agent_key: str | None = Header(None, alias="X-PhotoEditor-Agent-Key"),
) -> dict[str, Any]:
    """
    Account finder for agents (Grok, etc.).

    Use this first to resolve which user_id to pass to /api/agent/v1/logs.
    Auth: Authorization: Bearer pe_agent_…  or  X-API-Key / X-PhotoEditor-Agent-Key
    """
    key = _agent_from_headers(authorization, x_api_key, x_pe_agent_key)
    accounts = alogs.search_accounts(key["workspace_id"], q=q, limit=limit)
    return {
        "workspace_id": key["workspace_id"],
        "query": q,
        "count": len(accounts),
        "accounts": accounts,
        "usage_hint": {
            "next": "GET /api/agent/v1/logs?user_id={id}&level=error&limit=50",
            "account_fields": ["id", "email", "display_name", "account_label", "log_count"],
        },
    }


@router.get("/api/agent/v1/logs")
def agent_logs(
    user_id: str = Query(..., description="Exact account id from /api/agent/v1/accounts"),
    level: str | None = None,
    source: str | None = None,
    code: str | None = None,
    q: str | None = Query(None, description="Full-text search in message/detail/code/path"),
    since: float | None = None,
    limit: int = 100,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None, alias="X-API-Key"),
    x_pe_agent_key: str | None = Header(None, alias="X-PhotoEditor-Agent-Key"),
) -> dict[str, Any]:
    """
    Read precise error/warning logs for one account.

    Always pass user_id from the account finder so multi-tenant workspaces
    are unambiguous for agents.
    """
    key = _agent_from_headers(authorization, x_api_key, x_pe_agent_key)
    target = get_user_by_id(user_id)
    if not target or target.workspace_id != key["workspace_id"]:
        raise HTTPException(
            404,
            f"Account not found for user_id={user_id!r} in this workspace. "
            "Call GET /api/agent/v1/accounts?q=… first.",
        )
    entries = alogs.list_logs(
        target.id,
        level=level,
        source=source,
        code=code,
        q=q,
        since=since,
        limit=limit,
    )
    return {
        "account": target.public_dict(),
        "account_label": f"{target.display_name} <{target.email}> [{target.id}]",
        "count": len(entries),
        "total_for_user": alogs.count_logs(target.id),
        "filters": {
            "user_id": user_id,
            "level": level,
            "source": source,
            "code": code,
            "q": q,
            "since": since,
            "limit": limit,
        },
        "entries": entries,
    }


@router.get("/api/agent/v1/health")
def agent_health(
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None, alias="X-API-Key"),
    x_pe_agent_key: str | None = Header(None, alias="X-PhotoEditor-Agent-Key"),
) -> dict[str, Any]:
    key = _agent_from_headers(authorization, x_api_key, x_pe_agent_key)
    return {
        "status": "ok",
        "workspace_id": key["workspace_id"],
        "key_name": key.get("name"),
        "endpoints": [
            "GET /api/agent/v1/accounts?q=",
            "GET /api/agent/v1/logs?user_id=",
            "GET /api/agent/v1/health",
        ],
    }
