"""PhotoEditor FastAPI application with CRM-style auth and per-user isolation."""

from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import library as libstore
from .analysis import analyze_single, load_rgb
from .auth import AuthContext, get_optional_auth, require_auth
from .auth_db import init_db
from .auth_routes import router as auth_router
from .denoise import DenoiseControls, denoise_image
from .email_service import email_status

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
UPLOADS = ROOT / "uploads"
OUTPUTS = ROOT / "outputs"

UPLOADS.mkdir(exist_ok=True)
OUTPUTS.mkdir(exist_ok=True)

APP_ENV = os.getenv("APP_ENV", "development")
DISABLE_DOCS = os.getenv("DISABLE_DOCS", "false").lower() in ("1", "true", "yes")

app = FastAPI(
    title="PhotoEditor",
    description="Technical image analysis and controllable denoise (authenticated)",
    version="2.1.0",
    docs_url=None if DISABLE_DOCS else "/api/docs",
    redoc_url=None if DISABLE_DOCS else "/api/redoc",
    openapi_url=None if DISABLE_DOCS else "/openapi.json",
)

# Same-origin deploy (editor.herooflegend.com) does not need CORS; allow override for split hosting.
_cors = os.getenv("CORS_ORIGINS", "").strip()
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in _cors.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(auth_router)

# In-memory job index keyed by job_id (also on disk under user dirs)
_jobs: dict[str, dict[str, Any]] = {}


def _job_id() -> str:
    return secrets.token_hex(8)


def _user_dirs(user_id: str) -> tuple[Path, Path]:
    up = UPLOADS / user_id
    out = OUTPUTS / user_id
    up.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    return up, out


def _assert_job_owner(job: dict[str, Any], user_id: str) -> None:
    if job.get("user_id") and job["user_id"] != user_id:
        raise HTTPException(404, "Job not found.")


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "app": "PhotoEditor",
        "version": "2.1.0",
        "auth": True,
        "env": APP_ENV,
        "email": email_status(),
        "time": time.time(),
    }


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Load balancer liveness probe."""
    return {"status": "ok"}


def _report_summary(report: dict[str, Any] | None) -> dict[str, Any] | None:
    if not report:
        return None
    pd = report.get("pixel_difference") or {}
    hf = report.get("high_frequency_delta") or {}
    nd = report.get("noise_proxy_delta") or {}
    pipe = report.get("pipeline") or {}
    return {
        "algorithm": pipe.get("algorithm"),
        "strength_pct": pipe.get("effective_strength_pct"),
        "psnr_db": pd.get("psnr_db"),
        "mae": pd.get("mae"),
        "laplacian_var_pct": hf.get("laplacian_variance_pct_change"),
        "residual_std_pct": nd.get("residual_std_pct_change"),
        "resolution_preserved": (report.get("geometry_delta") or {}).get(
            "resolution_preserved"
        ),
    }


# ── Library (auth + user scope) ───────────────────────────────────────


@app.get("/api/library")
def library_list(ctx: AuthContext = Depends(require_auth)) -> JSONResponse:
    return JSONResponse({"entries": libstore.list_entries(ctx.data_user_id)})


@app.get("/api/library/{entry_id}")
def library_get(entry_id: str, ctx: AuthContext = Depends(require_auth)) -> JSONResponse:
    entry = libstore.get_entry(ctx.data_user_id, entry_id)
    if not entry:
        raise HTTPException(404, "Library entry not found.")
    return JSONResponse(
        {
            **entry,
            "source_url": f"/api/library/{entry_id}/source",
            "output_url": f"/api/library/{entry_id}/output",
        }
    )


@app.post("/api/library")
async def library_save(
    entry_id: str | None = Form(None),
    filename: str | None = Form(None),
    job_id: str | None = Form(None),
    controls_json: str = Form("{}"),
    history_json: str = Form("[]"),
    report_summary_json: str = Form("null"),
    source: UploadFile | None = File(None),
    output: UploadFile | None = File(None),
    ctx: AuthContext = Depends(require_auth),
) -> JSONResponse:
    try:
        controls = json.loads(controls_json or "{}")
        history = json.loads(history_json or "[]")
        report_summary = json.loads(report_summary_json or "null")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Invalid JSON: {exc}") from exc

    uid = ctx.data_user_id
    uploads_dir, outputs_dir = _user_dirs(uid)
    source_bytes = await source.read() if source is not None else None
    output_bytes = await output.read() if output is not None else None
    source_ext = ".jpg"
    if source is not None and source.filename:
        source_ext = Path(source.filename).suffix or ".jpg"

    if job_id:
        job = _jobs.get(job_id)
        if job and job.get("user_id") == uid:
            if not source_bytes and job.get("source_path"):
                p = Path(job["source_path"])
                if p.exists():
                    source_bytes = p.read_bytes()
                    source_ext = p.suffix or source_ext
            if not output_bytes and job.get("output_path"):
                p = Path(job["output_path"])
                if p.exists():
                    output_bytes = p.read_bytes()
            if report_summary is None and job.get("report"):
                report_summary = _report_summary(job["report"])
        if not output_bytes:
            p = outputs_dir / f"{job_id}_denoised.jpg"
            if p.exists():
                output_bytes = p.read_bytes()

    entry = libstore.save_entry(
        user_id=uid,
        entry_id=entry_id,
        filename=filename,
        job_id=job_id,
        controls=controls if isinstance(controls, dict) else {},
        report_summary=report_summary if isinstance(report_summary, dict) else None,
        history=history if isinstance(history, list) else [],
        source_bytes=source_bytes,
        output_bytes=output_bytes,
        source_ext=source_ext,
    )
    eid = entry["id"]
    return JSONResponse(
        {
            "entry": entry,
            "source_url": f"/api/library/{eid}/source",
            "output_url": f"/api/library/{eid}/output",
        }
    )


@app.delete("/api/library/{entry_id}")
def library_delete(entry_id: str, ctx: AuthContext = Depends(require_auth)) -> JSONResponse:
    libstore.delete_entry(ctx.data_user_id, entry_id)
    return JSONResponse({"ok": True, "id": entry_id})


@app.delete("/api/library")
def library_clear(ctx: AuthContext = Depends(require_auth)) -> JSONResponse:
    n = libstore.clear_all(ctx.data_user_id)
    return JSONResponse({"ok": True, "removed": n})


@app.get("/api/library/{entry_id}/source")
def library_source(entry_id: str, ctx: AuthContext = Depends(require_auth)) -> Response:
    path = libstore.resolve_image(ctx.data_user_id, entry_id, "source")
    if not path:
        raise HTTPException(404, "Source not found in library.")
    return FileResponse(path, filename=path.name)


@app.get("/api/library/{entry_id}/output")
def library_output(entry_id: str, ctx: AuthContext = Depends(require_auth)) -> Response:
    path = libstore.resolve_image(ctx.data_user_id, entry_id, "output")
    if not path:
        raise HTTPException(404, "Output not found in library.")
    return FileResponse(path, media_type="image/jpeg", filename=path.name)


# ── Analyze / denoise ─────────────────────────────────────────────────


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    ctx: AuthContext = Depends(require_auth),
) -> JSONResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "Please upload an image file (JPEG, PNG, WebP, etc.).")
    data = await file.read()
    if len(data) > 80 * 1024 * 1024:
        raise HTTPException(400, "Image exceeds 80 MB limit.")

    uid = ctx.data_user_id
    uploads_dir, _ = _user_dirs(uid)
    jid = _job_id()
    src_path = uploads_dir / f"{jid}_source{Path(file.filename or 'image.jpg').suffix or '.jpg'}"
    src_path.write_bytes(data)

    try:
        rgb, meta = load_rgb(str(src_path))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Could not decode image: {exc}") from exc

    metrics = analyze_single(rgb, meta)
    job = {
        "id": jid,
        "user_id": uid,
        "created": time.time(),
        "filename": file.filename,
        "source_path": str(src_path),
        "source_metrics": metrics,
        "source_meta": meta,
    }
    _jobs[jid] = job
    (uploads_dir / f"{jid}_meta.json").write_text(
        json.dumps(
            {
                "id": jid,
                "user_id": uid,
                "filename": file.filename,
                "source_metrics": metrics,
            },
            indent=2,
            default=str,
        )
    )

    return JSONResponse(
        {
            "job_id": jid,
            "filename": file.filename,
            "metrics": metrics,
            "preview_url": f"/api/jobs/{jid}/source",
            "user_id": uid,
        }
    )


@app.post("/api/denoise")
async def denoise(
    file: UploadFile | None = File(None),
    job_id: str | None = Form(None),
    controls_json: str = Form("{}"),
    ctx: AuthContext = Depends(require_auth),
) -> JSONResponse:
    try:
        controls_data = json.loads(controls_json or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Invalid controls JSON: {exc}") from exc

    controls = DenoiseControls.from_dict(controls_data)
    uid = ctx.data_user_id
    uploads_dir, outputs_dir = _user_dirs(uid)

    if job_id and job_id in _jobs:
        job = _jobs[job_id]
        _assert_job_owner(job, uid)
        src_path = Path(job["source_path"])
        if not src_path.exists():
            raise HTTPException(404, "Source file for job no longer on disk.")
        data = src_path.read_bytes()
        jid = job_id
        filename = job.get("filename")
    elif file is not None:
        if not file.content_type or not file.content_type.startswith("image/"):
            raise HTTPException(400, "Please upload an image file.")
        data = await file.read()
        jid = _job_id()
        filename = file.filename
        src_path = uploads_dir / f"{jid}_source{Path(filename or 'image.jpg').suffix or '.jpg'}"
        src_path.write_bytes(data)
    else:
        # Try load job from disk for this user
        if job_id:
            candidates = list(uploads_dir.glob(f"{job_id}_source*"))
            if candidates:
                src_path = candidates[0]
                data = src_path.read_bytes()
                jid = job_id
                filename = src_path.name
            else:
                raise HTTPException(400, "Provide either an image file or a valid job_id.")
        else:
            raise HTTPException(400, "Provide either an image file or an existing job_id.")

    try:
        rgb, meta = load_rgb(data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Could not decode image: {exc}") from exc

    max_side = int(controls_data.get("max_process_side", 4000))
    h, w = rgb.shape[:2]
    process_rgb = rgb
    if max(h, w) > max_side:
        scale = max_side / max(h, w)
        import cv2

        process_rgb = cv2.resize(
            rgb.astype("uint8"),
            (max(1, int(w * scale)), max(1, int(h * scale))),
            interpolation=cv2.INTER_AREA,
        ).astype("float64")
        meta = {**meta, "processed_from": f"{w}x{h}", "process_scale": scale}

    result = denoise_image(process_rgb, controls, meta)
    out_path = outputs_dir / f"{jid}_denoised.jpg"
    out_path.write_bytes(result["jpeg_bytes"])

    report = result["report"]
    prior = _jobs.get(jid, {})
    resolved_source = prior.get("source_path") or str(src_path)
    if not Path(resolved_source).exists():
        resolved_source = str(
            uploads_dir / f"{jid}_source{Path(filename or 'image.jpg').suffix or '.jpg'}"
        )
        Path(resolved_source).write_bytes(data)

    job = {
        "id": jid,
        "user_id": uid,
        "created": time.time(),
        "filename": filename,
        "source_path": resolved_source,
        "output_path": str(out_path),
        "controls": controls_data,
        "report": report,
        "source_metrics": prior.get("source_metrics") or report.get("source"),
    }
    _jobs[jid] = job
    (outputs_dir / f"{jid}_report.json").write_text(
        json.dumps(
            {
                "id": jid,
                "user_id": uid,
                "filename": filename,
                "controls": controls_data,
                "report": report,
            },
            indent=2,
            default=str,
        )
    )

    return JSONResponse(
        {
            "job_id": jid,
            "filename": filename,
            "report": report,
            "source_url": f"/api/jobs/{jid}/source",
            "output_url": f"/api/jobs/{jid}/output?t={int(time.time())}",
            "download_url": f"/api/jobs/{jid}/download",
            "user_id": uid,
        }
    )


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, ctx: AuthContext = Depends(require_auth)) -> JSONResponse:
    uid = ctx.data_user_id
    job = _jobs.get(job_id)
    if job:
        _assert_job_owner(job, uid)
        return JSONResponse(
            {
                "id": job["id"],
                "filename": job.get("filename"),
                "source_metrics": job.get("source_metrics"),
                "report": job.get("report"),
                "controls": job.get("controls"),
                "source_url": f"/api/jobs/{job_id}/source",
                "output_url": f"/api/jobs/{job_id}/output",
                "download_url": f"/api/jobs/{job_id}/download",
            }
        )
    _, outputs_dir = _user_dirs(uid)
    report_path = outputs_dir / f"{job_id}_report.json"
    if report_path.exists():
        return JSONResponse(json.loads(report_path.read_text()))
    raise HTTPException(404, "Job not found.")


@app.get("/api/jobs/{job_id}/source")
def get_source(job_id: str, ctx: AuthContext = Depends(require_auth)) -> Response:
    uid = ctx.data_user_id
    job = _jobs.get(job_id)
    path = None
    if job:
        _assert_job_owner(job, uid)
        if job.get("source_path"):
            path = Path(job["source_path"])
    if not path or not path.exists():
        uploads_dir, _ = _user_dirs(uid)
        candidates = list(uploads_dir.glob(f"{job_id}_source*"))
        path = candidates[0] if candidates else None
    if not path or not path.exists():
        raise HTTPException(404, "Source image not found.")
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@app.get("/api/jobs/{job_id}/output")
def get_output(job_id: str, ctx: AuthContext = Depends(require_auth)) -> Response:
    uid = ctx.data_user_id
    job = _jobs.get(job_id)
    if job:
        _assert_job_owner(job, uid)
    _, outputs_dir = _user_dirs(uid)
    path = outputs_dir / f"{job_id}_denoised.jpg"
    if not path.exists():
        raise HTTPException(404, "Denoised output not found.")
    return FileResponse(path, media_type="image/jpeg", filename=path.name)


@app.get("/api/jobs/{job_id}/download")
def download_output(job_id: str, ctx: AuthContext = Depends(require_auth)) -> Response:
    uid = ctx.data_user_id
    job = _jobs.get(job_id)
    if job:
        _assert_job_owner(job, uid)
    _, outputs_dir = _user_dirs(uid)
    path = outputs_dir / f"{job_id}_denoised.jpg"
    if not path.exists():
        raise HTTPException(404, "Denoised output not found.")
    return FileResponse(
        path,
        media_type="image/jpeg",
        filename=f"photoeditor_{job_id}_denoised.jpg",
        headers={
            "Content-Disposition": f'attachment; filename="photoeditor_{job_id}_denoised.jpg"'
        },
    )


# ── HTML pages (gate with optional auth + redirect) ───────────────────


@app.get("/login")
def login_page() -> FileResponse:
    return FileResponse(STATIC / "login.html")


@app.get("/invite")
def invite_page() -> FileResponse:
    return FileResponse(STATIC / "invite.html")


@app.get("/")
async def index(ctx: AuthContext | None = Depends(get_optional_auth)) -> Response:
    if ctx is None:
        return RedirectResponse(url="/login?next=/", status_code=302)
    return FileResponse(STATIC / "index.html")


@app.get("/docs")
async def human_docs(ctx: AuthContext | None = Depends(get_optional_auth)) -> Response:
    if ctx is None:
        return RedirectResponse(url="/login?next=/docs", status_code=302)
    return FileResponse(STATIC / "docs.html")


@app.get("/admin")
async def admin_page(ctx: AuthContext | None = Depends(get_optional_auth)) -> Response:
    if ctx is None:
        return RedirectResponse(url="/login?next=/admin", status_code=302)
    if not ctx.actor.is_admin:
        return RedirectResponse(url="/?error=admin", status_code=302)
    return FileResponse(STATIC / "admin.html")


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
