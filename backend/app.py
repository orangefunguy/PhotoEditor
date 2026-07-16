"""PhotoEditor FastAPI application.

Endpoints:
  GET  /              → static UI
  POST /api/analyze   → metrics for an uploaded image
  POST /api/denoise   → apply controllable denoise + return metrics + image
  GET  /api/health    → health check
  GET  /api/jobs/{id} → fetch stored job result metadata
  GET/POST/DELETE /api/library  → image repository + change history
"""

from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import library as libstore
from .analysis import analyze_single, load_rgb
from .denoise import DenoiseControls, denoise_image

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
UPLOADS = ROOT / "uploads"
OUTPUTS = ROOT / "outputs"

UPLOADS.mkdir(exist_ok=True)
OUTPUTS.mkdir(exist_ok=True)

app = FastAPI(
    title="PhotoEditor",
    description="Technical image analysis and controllable denoise for the web",
    version="1.2.0",
    # Human docs live at /docs; Swagger UI moves to /api/docs
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/openapi.json",
)

# In-memory job index (also persisted as JSON next to outputs)
_jobs: dict[str, dict[str, Any]] = {}


def _job_id() -> str:
    return secrets.token_hex(8)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "app": "PhotoEditor",
        "version": "1.2.0",
        "time": time.time(),
    }


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


@app.get("/api/library")
def library_list() -> JSONResponse:
    return JSONResponse({"entries": libstore.list_entries()})


@app.get("/api/library/{entry_id}")
def library_get(entry_id: str) -> JSONResponse:
    entry = libstore.get_entry(entry_id)
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
) -> JSONResponse:
    try:
        controls = json.loads(controls_json or "{}")
        history = json.loads(history_json or "[]")
        report_summary = json.loads(report_summary_json or "null")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Invalid JSON: {exc}") from exc

    source_bytes = await source.read() if source is not None else None
    output_bytes = await output.read() if output is not None else None
    source_ext = ".jpg"
    if source is not None and source.filename:
        source_ext = Path(source.filename).suffix or ".jpg"

    # Prefer job artifacts when available
    if job_id:
        job = _jobs.get(job_id)
        if job and not source_bytes and job.get("source_path"):
            p = Path(job["source_path"])
            if p.exists():
                source_bytes = p.read_bytes()
                source_ext = p.suffix or source_ext
        if job and not output_bytes and job.get("output_path"):
            p = Path(job["output_path"])
            if p.exists():
                output_bytes = p.read_bytes()
        if not output_bytes:
            p = OUTPUTS / f"{job_id}_denoised.jpg"
            if p.exists():
                output_bytes = p.read_bytes()
        if report_summary is None and job and job.get("report"):
            report_summary = _report_summary(job["report"])

    entry = libstore.save_entry(
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
def library_delete(entry_id: str) -> JSONResponse:
    libstore.delete_entry(entry_id)
    return JSONResponse({"ok": True, "id": entry_id})


@app.delete("/api/library")
def library_clear() -> JSONResponse:
    n = libstore.clear_all()
    return JSONResponse({"ok": True, "removed": n})


@app.get("/api/library/{entry_id}/source")
def library_source(entry_id: str) -> Response:
    path = libstore.resolve_image(entry_id, "source")
    if not path:
        raise HTTPException(404, "Source not found in library.")
    return FileResponse(path, filename=path.name)


@app.get("/api/library/{entry_id}/output")
def library_output(entry_id: str) -> Response:
    path = libstore.resolve_image(entry_id, "output")
    if not path:
        raise HTTPException(404, "Output not found in library.")
    return FileResponse(path, media_type="image/jpeg", filename=path.name)


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)) -> JSONResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "Please upload an image file (JPEG, PNG, WebP, etc.).")
    data = await file.read()
    if len(data) > 80 * 1024 * 1024:
        raise HTTPException(400, "Image exceeds 80 MB limit.")

    jid = _job_id()
    src_path = UPLOADS / f"{jid}_source{Path(file.filename or 'image.jpg').suffix or '.jpg'}"
    src_path.write_bytes(data)

    try:
        rgb, meta = load_rgb(str(src_path))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Could not decode image: {exc}") from exc

    metrics = analyze_single(rgb, meta)
    job = {
        "id": jid,
        "created": time.time(),
        "filename": file.filename,
        "source_path": str(src_path),
        "source_metrics": metrics,
        "source_meta": meta,
    }
    _jobs[jid] = job
    (OUTPUTS / f"{jid}_meta.json").write_text(json.dumps(job, indent=2, default=str))

    return JSONResponse(
        {
            "job_id": jid,
            "filename": file.filename,
            "metrics": metrics,
            "preview_url": f"/api/jobs/{jid}/source",
        }
    )


@app.post("/api/denoise")
async def denoise(
    file: UploadFile | None = File(None),
    job_id: str | None = Form(None),
    controls_json: str = Form("{}"),
) -> JSONResponse:
    try:
        controls_data = json.loads(controls_json or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Invalid controls JSON: {exc}") from exc

    controls = DenoiseControls.from_dict(controls_data)

    if job_id and job_id in _jobs:
        src_path = Path(_jobs[job_id]["source_path"])
        if not src_path.exists():
            raise HTTPException(404, "Source file for job no longer on disk.")
        data = src_path.read_bytes()
        jid = job_id
        filename = _jobs[job_id].get("filename")
    elif file is not None:
        if not file.content_type or not file.content_type.startswith("image/"):
            raise HTTPException(400, "Please upload an image file.")
        data = await file.read()
        jid = _job_id()
        filename = file.filename
        src_path = UPLOADS / f"{jid}_source{Path(filename or 'image.jpg').suffix or '.jpg'}"
        src_path.write_bytes(data)
    else:
        raise HTTPException(400, "Provide either an image file or an existing job_id.")

    try:
        rgb, meta = load_rgb(data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Could not decode image: {exc}") from exc

    # Cap processing size for responsiveness (analysis still reports original)
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
    out_path = OUTPUTS / f"{jid}_denoised.jpg"
    out_path.write_bytes(result["jpeg_bytes"])

    report = result["report"]
    prior = _jobs.get(jid, {})
    resolved_source = prior.get("source_path") or str(src_path)
    if not Path(resolved_source).exists():
        resolved_source = str(
            UPLOADS / f"{jid}_source{Path(filename or 'image.jpg').suffix or '.jpg'}"
        )
        Path(resolved_source).write_bytes(data)

    job = {
        "id": jid,
        "created": time.time(),
        "filename": filename,
        "source_path": resolved_source,
        "output_path": str(out_path),
        "controls": controls_data,
        "report": report,
        "source_metrics": prior.get("source_metrics") or report.get("source"),
    }
    _jobs[jid] = job
    # Strip huge nested arrays before disk write
    (OUTPUTS / f"{jid}_report.json").write_text(
        json.dumps(
            {
                "id": jid,
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
        }
    )


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> JSONResponse:
    job = _jobs.get(job_id)
    if not job:
        report_path = OUTPUTS / f"{job_id}_report.json"
        if report_path.exists():
            return JSONResponse(json.loads(report_path.read_text()))
        raise HTTPException(404, "Job not found.")
    # Return serializable subset
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


@app.get("/api/jobs/{job_id}/source")
def get_source(job_id: str) -> Response:
    job = _jobs.get(job_id)
    path = None
    if job and job.get("source_path"):
        path = Path(job["source_path"])
    else:
        candidates = list(UPLOADS.glob(f"{job_id}_source*"))
        path = candidates[0] if candidates else None
    if not path or not path.exists():
        raise HTTPException(404, "Source image not found.")
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@app.get("/api/jobs/{job_id}/output")
def get_output(job_id: str) -> Response:
    path = OUTPUTS / f"{job_id}_denoised.jpg"
    if not path.exists():
        raise HTTPException(404, "Denoised output not found. Run /api/denoise first.")
    return FileResponse(path, media_type="image/jpeg", filename=path.name)


@app.get("/api/jobs/{job_id}/download")
def download_output(job_id: str) -> Response:
    path = OUTPUTS / f"{job_id}_denoised.jpg"
    if not path.exists():
        raise HTTPException(404, "Denoised output not found.")
    return FileResponse(
        path,
        media_type="image/jpeg",
        filename=f"photoeditor_{job_id}_denoised.jpg",
        headers={"Content-Disposition": f'attachment; filename="photoeditor_{job_id}_denoised.jpg"'},
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/docs")
def human_docs() -> FileResponse:
    """User-facing documentation (ELI5 + technical tool reference)."""
    return FileResponse(STATIC / "docs.html")


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
