"""Server-side image repository for PhotoEditor.

Persists created/edited images under library/ with a change log so work
survives browser cache clears when the same local server is used.
"""

from __future__ import annotations

import json
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = ROOT / "library"
INDEX_PATH = LIBRARY / "index.json"


def _ensure() -> None:
    LIBRARY.mkdir(exist_ok=True)
    if not INDEX_PATH.exists():
        INDEX_PATH.write_text("[]", encoding="utf-8")


def _read_index() -> list[dict[str, Any]]:
    _ensure()
    try:
        data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _write_index(rows: list[dict[str, Any]]) -> None:
    _ensure()
    INDEX_PATH.write_text(json.dumps(rows, indent=2), encoding="utf-8")


def _entry_dir(entry_id: str) -> Path:
    return LIBRARY / entry_id


def list_entries() -> list[dict[str, Any]]:
    rows = _read_index()
    rows.sort(key=lambda r: r.get("updated_at", 0), reverse=True)
    return rows


def get_entry(entry_id: str) -> dict[str, Any] | None:
    d = _entry_dir(entry_id)
    meta_path = d / "meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    hist_path = d / "history.json"
    if hist_path.exists():
        try:
            meta["history"] = json.loads(hist_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            meta["history"] = []
    meta["has_source"] = (d / "source.jpg").exists() or (d / "source.bin").exists()
    meta["has_output"] = (d / "output.jpg").exists()
    return meta


def save_entry(
    *,
    entry_id: str | None,
    filename: str | None,
    job_id: str | None,
    controls: dict[str, Any] | None,
    report_summary: dict[str, Any] | None,
    history: list[dict[str, Any]] | None,
    source_bytes: bytes | None,
    output_bytes: bytes | None,
    source_ext: str = ".jpg",
) -> dict[str, Any]:
    _ensure()
    eid = entry_id or secrets.token_hex(8)
    d = _entry_dir(eid)
    d.mkdir(exist_ok=True)
    now = time.time()

    existing = get_entry(eid)
    created = existing.get("created_at", now) if existing else now

    if source_bytes:
        ext = source_ext if source_ext.startswith(".") else f".{source_ext}"
        # Normalize common cases
        if ext.lower() in (".jpeg", ".jpg"):
            (d / "source.jpg").write_bytes(source_bytes)
        else:
            (d / f"source{ext}").write_bytes(source_bytes)
            # also keep a copy path hint
            (d / "source.bin").write_bytes(source_bytes)

    if output_bytes:
        (d / "output.jpg").write_bytes(output_bytes)

    hist = history if history is not None else (existing or {}).get("history", [])
    (d / "history.json").write_text(json.dumps(hist, indent=2), encoding="utf-8")

    meta: dict[str, Any] = {
        "id": eid,
        "filename": filename or (existing or {}).get("filename") or "image",
        "job_id": job_id or (existing or {}).get("job_id"),
        "created_at": created,
        "updated_at": now,
        "controls": controls or (existing or {}).get("controls"),
        "report_summary": report_summary or (existing or {}).get("report_summary"),
        "history_count": len(hist),
    }
    (d / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    # Update index (lightweight, no blobs)
    rows = [r for r in _read_index() if r.get("id") != eid]
    rows.append(
        {
            "id": eid,
            "filename": meta["filename"],
            "job_id": meta.get("job_id"),
            "created_at": meta["created_at"],
            "updated_at": meta["updated_at"],
            "history_count": meta["history_count"],
            "report_summary": meta.get("report_summary"),
        }
    )
    # Cap index at 200
    rows.sort(key=lambda r: r.get("updated_at", 0), reverse=True)
    if len(rows) > 200:
        for stale in rows[200:]:
            delete_entry(stale["id"])
        rows = rows[:200]
    _write_index(rows)
    return get_entry(eid) or meta


def delete_entry(entry_id: str) -> bool:
    d = _entry_dir(entry_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    rows = [r for r in _read_index() if r.get("id") != entry_id]
    _write_index(rows)
    return True


def clear_all() -> int:
    rows = _read_index()
    n = len(rows)
    if LIBRARY.exists():
        shutil.rmtree(LIBRARY, ignore_errors=True)
    _ensure()
    return n


def resolve_image(entry_id: str, kind: str) -> Path | None:
    d = _entry_dir(entry_id)
    if kind == "output":
        p = d / "output.jpg"
        return p if p.exists() else None
    if kind == "source":
        for name in ("source.jpg", "source.jpeg", "source.png", "source.webp", "source.bin"):
            p = d / name
            if p.exists():
                return p
        # any source*
        for p in d.glob("source*"):
            if p.is_file():
                return p
    return None
