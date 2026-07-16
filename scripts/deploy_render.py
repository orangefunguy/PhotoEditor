#!/usr/bin/env python3
"""Create or update PhotoEditor on Render.com and trigger a deploy.

Uses Web_Grok_API_Key or RENDER_API_KEY.
Loads Resend key and durable-auth secrets from environment / PhotoEditor .env
(never prints secrets).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OWNER_ID = os.getenv("RENDER_OWNER_ID", "tea-d8pmn88k1i2s73f6obng")
SERVICE_NAME = os.getenv("RENDER_SERVICE_NAME", "photoeditor")
REPO = "https://github.com/orangefunguy/PhotoEditor"
BRANCH = "main"


def load_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def api_key() -> str:
    key = os.getenv("RENDER_API_KEY") or os.getenv("Web_Grok_API_Key")
    if not key:
        sys.exit("Missing RENDER_API_KEY or Web_Grok_API_Key")
    return key


def render(method: str, path: str, body: dict | list | None = None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"https://api.render.com/v1{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        raise SystemExit(f"{method} {path} failed ({e.code}): {err}") from e


def list_services() -> list[dict]:
    data = render("GET", "/services?limit=100") or []
    return [entry.get("service") or entry for entry in data]


def env_vars() -> list[dict]:
    file_env = load_dotenv(ROOT / ".env")
    resend = (
        os.getenv("resend_key")
        or os.getenv("RESEND_API_KEY")
        or os.getenv("SMTP_PASSWORD")
        or file_env.get("SMTP_PASSWORD")
        or file_env.get("resend_key")
        or file_env.get("RESEND_API_KEY")
    )
    auth_secret = (
        os.getenv("AUTH_SYNC_SECRET")
        or file_env.get("AUTH_SYNC_SECRET")
        or ""
    )
    auth_kv_url = (
        os.getenv("AUTH_KV_URL")
        or file_env.get("AUTH_KV_URL")
        # Prefer workers.dev for server-to-server (avoids custom-domain bot rules)
        or "https://photoeditor.fernandol.workers.dev"
    )
    cf_account = (
        os.getenv("CLOUDFLARE_ACCOUNT_ID")
        or file_env.get("CLOUDFLARE_ACCOUNT_ID")
        or "831af2f854aa8c4d1f0029bfa7345165"
    )
    cf_token = (
        os.getenv("CLOUDFLARE_API_TOKEN")
        or file_env.get("CLOUDFLARE_API_TOKEN")
        or ""
    )
    kv_ns = (
        os.getenv("AUTH_KV_NAMESPACE_ID")
        or file_env.get("AUTH_KV_NAMESPACE_ID")
        or "589022e1c1d445f8a2ecc1826318f862"
    )
    pairs = [
        ("APP_ENV", "production"),
        ("AUTH_ENABLED", "true"),
        ("APP_NAME", "PhotoEditor"),
        ("FRONTEND_URL", "https://editor.herooflegend.com"),
        ("CORS_ORIGINS", "https://editor.herooflegend.com"),
        ("COOKIE_SECURE", "true"),
        ("COOKIE_SAMESITE", "lax"),
        ("SESSION_DAYS", "90"),
        ("UVICORN_WORKERS", "1"),
        ("DISABLE_DOCS", "false"),
        ("EMAIL_FROM", "noreply@herooflegend.com"),
        ("EMAIL_FROM_NAME", "PhotoEditor"),
        ("SMTP_HOST", "smtp.resend.com"),
        ("SMTP_PORT", "587"),
        ("SMTP_USER", "resend"),
        ("SMTP_TLS", "true"),
        ("SMTP_FROM", "noreply@herooflegend.com"),
        ("AUTH_KV_URL", auth_kv_url),
        ("CLOUDFLARE_ACCOUNT_ID", cf_account),
        ("AUTH_KV_NAMESPACE_ID", kv_ns),
    ]
    if cf_token:
        pairs.append(("CLOUDFLARE_API_TOKEN", cf_token))
    else:
        print(
            "WARNING: CLOUDFLARE_API_TOKEN missing — durable KV API sync disabled "
            "unless AUTH_SYNC_SECRET + Worker path works."
        )
    if auth_secret:
        pairs.append(("AUTH_SYNC_SECRET", auth_secret))
    else:
        print(
            "NOTE: AUTH_SYNC_SECRET optional when CLOUDFLARE_API_TOKEN is set "
            "(direct KV API is preferred)."
        )
    if resend:
        pairs.append(("SMTP_PASSWORD", resend))
        pairs.append(("RESEND_API_KEY", resend))
    else:
        print("WARNING: No Resend key found — invites will not email until set on Render.")

    return [{"key": k, "value": v} for k, v in pairs if v]


def create_payload(env: list[dict]) -> dict:
    return {
        "type": "web_service",
        "name": SERVICE_NAME,
        "ownerId": OWNER_ID,
        "repo": REPO,
        "branch": BRANCH,
        "autoDeploy": "yes",
        "serviceDetails": {
            "runtime": "docker",
            "plan": "free",
            "region": "oregon",
            "healthCheckPath": "/healthz",
            "env": "docker",
            "envSpecificDetails": {
                "dockerfilePath": "./Dockerfile",
                "dockerContext": ".",
            },
            "numInstances": 1,
        },
        "envVars": env,
    }


def main() -> None:
    env = env_vars()
    services = list_services()
    service = next((s for s in services if s.get("name") == SERVICE_NAME), None)

    if service:
        sid = service["id"]
        print(f"Found service {SERVICE_NAME}: {sid}")
        render("PUT", f"/services/{sid}/env-vars", env)
        print("Updated env vars")
        deploy = render("POST", f"/services/{sid}/deploys", {"clearCache": "clear"})
        deploy_id = (deploy or {}).get("id") or ((deploy or {}).get("deploy") or {}).get("id")
        print(f"Triggered deploy: {deploy_id}")
    else:
        print(f"Creating service {SERVICE_NAME} from {REPO}…")
        created = render("POST", "/services", create_payload(env))
        # API may wrap as {service: {...}} or return service directly
        service = (created or {}).get("service") or created
        sid = service["id"]
        print(f"Created service: {sid}")
        deploy_id = "initial"

    # Resolve public URL
    services = list_services()
    service = next((s for s in services if s.get("id") == sid), service)
    details = service.get("serviceDetails") or {}
    url = details.get("url") or f"https://{SERVICE_NAME}.onrender.com"
    print(f"Service URL: {url}")
    print(f"Dashboard: https://dashboard.render.com/web/{sid}")

    # Poll deploy health
    print("Waiting for service to become healthy (Render free tier can take several minutes)…")
    deadline = time.time() + 900
    last = ""
    while time.time() < deadline:
        try:
            req = urllib.request.Request(f"{url}/healthz", method="GET")
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode()
                if resp.status == 200:
                    print(f"HEALTHY: {url}/healthz → {body}")
                    print(f"NEXT: point editor.herooflegend.com CNAME → {url.replace('https://','')}")
                    print(f"Or custom domain in Render: {sid} → Settings → Custom Domains")
                    return
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            if msg != last:
                print(f"  not ready yet: {msg[:120]}")
                last = msg
        time.sleep(20)
    print("Timed out waiting for health. Check Render dashboard logs.")
    sys.exit(1)


if __name__ == "__main__":
    main()
