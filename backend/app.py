"""PhotoEditor FastAPI application.

Endpoints:
  GET  /              → static UI
  POST /api/analyze   → metrics for an uploaded image
  POST /api/denoise   → apply controllable denoise + return metrics + image
  GET  /api/health    → health check
  GET  /api/jobs/{id} → fetch stored job result metadata
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
    version="1.0.0",
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
        "version": "1.0.0",
        "time": time.time(),
    }


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


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
