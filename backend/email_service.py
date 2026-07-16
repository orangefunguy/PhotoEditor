"""Outbound email for PhotoEditor (invites and transactional messages).

Supports the same delivery options used around Hero of Legend apps:

1. **SMTP** — Resend, Postmark, SendGrid, SES, etc. (``SMTP_*`` env vars)
2. **Resend HTTP API** — ``RESEND_API_KEY`` / ``resend_key`` (also used as SMTP password)
3. **Cloudflare Email Sending** REST API (``CLOUDFLARE_ACCOUNT_ID`` + ``CLOUDFLARE_API_TOKEN``)
4. **Dev fallback** — log to console + ``data/invite_links.log`` when not production

Set ``APP_ENV=production`` to require a real transport (SMTP or Cloudflare/Resend).
"""

from __future__ import annotations

import html
import os
import smtplib
import time
from dataclasses import dataclass
from email.message import EmailMessage
from pathlib import Path
from typing import Any

import httpx

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

ROOT = Path(__file__).resolve().parent.parent
EMAIL_LOG = ROOT / "data" / "email.log"

APP_NAME = os.getenv("APP_NAME", "PhotoEditor")
APP_ENV = os.getenv("APP_ENV", "development")
DEFAULT_FROM = os.getenv("SMTP_FROM") or os.getenv(
    "EMAIL_FROM", "noreply@herooflegend.com"
)
DEFAULT_FROM_NAME = os.getenv("EMAIL_FROM_NAME", "PhotoEditor")


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.lower() in ("1", "true", "yes", "on")


@dataclass
class EmailResult:
    ok: bool
    transport: str
    message: str
    detail: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "transport": self.transport,
            "message": self.message,
            "detail": self.detail,
        }


def resend_api_key() -> str | None:
    """Resend key from SMTP_PASSWORD, RESEND_API_KEY, or resend_key (zshrc)."""
    for k in ("SMTP_PASSWORD", "RESEND_API_KEY", "resend_key"):
        v = os.getenv(k)
        if v and v.strip():
            return v.strip()
    return None


def email_status() -> dict[str, Any]:
    """Public-safe status for admin UI / health."""
    key = resend_api_key()
    smtp = bool(os.getenv("SMTP_HOST")) or bool(key)
    cf = bool(os.getenv("CLOUDFLARE_ACCOUNT_ID") and os.getenv("CLOUDFLARE_API_TOKEN"))
    if os.getenv("SMTP_HOST") or key:
        transport = "smtp" if os.getenv("SMTP_HOST") else "resend"
        if key and not os.getenv("SMTP_HOST"):
            transport = "resend"
        elif key and (os.getenv("SMTP_HOST") or "").endswith("resend.com"):
            transport = "resend-smtp"
        elif os.getenv("SMTP_HOST"):
            transport = "smtp"
        else:
            transport = "resend"
    elif cf:
        transport = "cloudflare"
    else:
        transport = "log"
    configured = bool(key or os.getenv("SMTP_HOST") or cf)
    return {
        "configured": configured,
        "transport": transport,
        "from": DEFAULT_FROM if configured else None,
        "app_env": APP_ENV,
        "production_requires_transport": APP_ENV == "production",
    }


def _log(line: str) -> None:
    EMAIL_LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with EMAIL_LOG.open("a", encoding="utf-8") as f:
        f.write(f"{stamp} {line}\n")
    print(f"[PhotoEditor email] {line}")


def _send_resend_api(
    *, to: str, subject: str, text: str, html_body: str | None
) -> EmailResult:
    """Send via Resend HTTPS API (preferred when resend_key is present)."""
    api_key = resend_api_key()
    if not api_key:
        return EmailResult(False, "resend", "No Resend API key configured.", None)
    payload: dict[str, Any] = {
        "from": f"{DEFAULT_FROM_NAME} <{DEFAULT_FROM}>",
        "to": [to],
        "subject": subject,
        "text": text,
    }
    if html_body:
        payload["html"] = html_body
    try:
        with httpx.Client(timeout=30.0) as client:
            r = client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
        if r.status_code >= 400:
            _log(f"resend FAIL → {to} · {r.status_code} {r.text[:400]}")
            return EmailResult(
                False,
                "resend",
                "Resend API rejected the message.",
                r.text[:500],
            )
        _log(f"resend ok → {to} · {subject} · {r.text[:120]}")
        return EmailResult(True, "resend", f"Email sent to {to} via Resend.")
    except Exception as exc:  # noqa: BLE001
        _log(f"resend FAIL → {to} · {exc}")
        return EmailResult(False, "resend", "Resend send failed.", str(exc))


def _send_smtp(*, to: str, subject: str, text: str, html_body: str | None) -> EmailResult:
    host = os.getenv("SMTP_HOST") or "smtp.resend.com"
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER") or "resend"
    password = resend_api_key() or os.getenv("SMTP_PASSWORD", "")
    sender = DEFAULT_FROM
    use_tls = _env_bool("SMTP_TLS", True)
    use_ssl = _env_bool("SMTP_SSL", False)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{DEFAULT_FROM_NAME} <{sender}>"
    msg["To"] = to
    msg.set_content(text)
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    try:
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, timeout=30) as smtp:
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                if use_tls:
                    smtp.starttls()
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
        _log(f"smtp ok → {to} · {subject}")
        return EmailResult(True, "smtp", f"Email sent to {to} via SMTP.")
    except Exception as exc:  # noqa: BLE001
        _log(f"smtp FAIL → {to} · {exc}")
        return EmailResult(False, "smtp", "SMTP send failed.", str(exc))


def _send_cloudflare(
    *, to: str, subject: str, text: str, html_body: str | None
) -> EmailResult:
    account_id = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/email/send"
    payload: dict[str, Any] = {
        "from": {"address": DEFAULT_FROM, "name": DEFAULT_FROM_NAME},
        "to": [to],
        "subject": subject,
        "text": text,
    }
    if html_body:
        payload["html"] = html_body
    try:
        with httpx.Client(timeout=30.0) as client:
            r = client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
        if r.status_code >= 400:
            _log(f"cloudflare FAIL → {to} · {r.status_code} {r.text[:300]}")
            return EmailResult(
                False,
                "cloudflare",
                "Cloudflare Email API rejected the message.",
                r.text[:500],
            )
        _log(f"cloudflare ok → {to} · {subject}")
        return EmailResult(True, "cloudflare", f"Email sent to {to} via Cloudflare.")
    except Exception as exc:  # noqa: BLE001
        _log(f"cloudflare FAIL → {to} · {exc}")
        return EmailResult(False, "cloudflare", "Cloudflare send failed.", str(exc))


def send_email(
    *,
    to: str,
    subject: str,
    text: str,
    html_body: str | None = None,
) -> EmailResult:
    """Send email using the first configured transport."""
    to_n = to.strip().lower()
    key = resend_api_key()

    # Prefer Resend HTTP API when a resend key is available (zshrc resend_key / SMTP_PASSWORD)
    if key and key.startswith("re_"):
        result = _send_resend_api(
            to=to_n, subject=subject, text=text, html_body=html_body
        )
        if result.ok:
            return result
        # Fall through to SMTP if API fails (e.g. domain issues) and SMTP_HOST set
        if os.getenv("SMTP_HOST"):
            smtp_result = _send_smtp(
                to=to_n, subject=subject, text=text, html_body=html_body
            )
            if smtp_result.ok:
                return smtp_result
            return result  # return original Resend error detail
        return result

    if os.getenv("SMTP_HOST"):
        return _send_smtp(to=to_n, subject=subject, text=text, html_body=html_body)
    if os.getenv("CLOUDFLARE_ACCOUNT_ID") and os.getenv("CLOUDFLARE_API_TOKEN"):
        return _send_cloudflare(to=to_n, subject=subject, text=text, html_body=html_body)

    # Dev / unconfigured
    _log(f"log-only → {to_n} · {subject}\n{text}")
    if APP_ENV == "production":
        return EmailResult(
            False,
            "none",
            "No email transport configured in production. Set resend_key/SMTP_* or Cloudflare credentials.",
            None,
        )
    return EmailResult(
        True,
        "log",
        "Email logged locally (dev mode). Configure Resend or Cloudflare for real delivery.",
        None,
    )


def invite_email_html(*, invitee_email: str, invited_by: str, link: str, days: int) -> str:
    safe_link = html.escape(link)
    return f"""\
<!DOCTYPE html>
<html>
<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;background:#f6f7f9;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 24px;border:1px solid #e5e7eb">
    <h1 style="margin:0 0 8px;font-size:20px">{html.escape(APP_NAME)}</h1>
    <p style="margin:0 0 16px;color:#555">You've been invited to the photo workspace.</p>
    <p style="margin:0 0 8px"><strong>Account:</strong> {html.escape(invitee_email)}</p>
    <p style="margin:0 0 20px"><strong>Invited by:</strong> {html.escape(invited_by)}</p>
    <p style="margin:0 0 20px">
      <a href="{safe_link}" style="display:inline-block;background:#4d8ef7;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">
        Accept invite &amp; set password
      </a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#666;word-break:break-all">
      Or paste this link into your browser:<br/>{safe_link}
    </p>
    <p style="margin:16px 0 0;font-size:12px;color:#888">
      This link expires in {days} days. If you did not expect this email, you can ignore it.
    </p>
  </div>
</body>
</html>
"""


def send_invite_email(
    *,
    to: str,
    link: str,
    invited_by: str,
    days: int = 3,
) -> EmailResult:
    subject = f"You're invited to {APP_NAME}"
    text = (
        f"You have been invited to {APP_NAME} by {invited_by}.\n\n"
        f"Accept your invite and set your password:\n{link}\n\n"
        f"This link expires in {days} days.\n"
        f"If you did not expect this email, you can ignore it.\n"
    )
    html_body = invite_email_html(
        invitee_email=to, invited_by=invited_by, link=link, days=days
    )
    return send_email(to=to, subject=subject, text=text, html_body=html_body)


def send_welcome_email(*, to: str, display_name: str) -> EmailResult:
    base = os.getenv("FRONTEND_URL", "https://editor.herooflegend.com").rstrip("/")
    subject = f"Welcome to {APP_NAME}"
    text = (
        f"Hi {display_name},\n\n"
        f"Your {APP_NAME} account is ready.\n"
        f"Sign in at: {base}/login\n\n"
        f"— {APP_NAME}\n"
    )
    html_body = f"""\
<html><body style="font-family:system-ui,sans-serif;line-height:1.5">
  <h2>Welcome to {html.escape(APP_NAME)}</h2>
  <p>Hi {html.escape(display_name)},</p>
  <p>Your account is ready. Sign in at
    <a href="{html.escape(base)}/login">{html.escape(base)}/login</a>.
  </p>
</body></html>
"""
    return send_email(to=to, subject=subject, text=text, html_body=html_body)
