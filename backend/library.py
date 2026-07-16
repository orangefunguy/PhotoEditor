"""Server-side image repository for PhotoEditor (per-user isolation)."""

from __future__ import annotations

import json
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LIBRARY_ROOT = ROOT / "library"


def _user_root(user_id: str) -> Path:
    return LIBRARY_ROOT / user_id


def _ensure_user(user_id: str) -> Path:
    d = _user_root(user_id)
    d.mkdir(parents=True, exist_ok=True)
    index = d / "index.json"
    if not index.exists():
        index.write_text("[]", encoding="utf-8")
    return d


def _index_path(user_id: str) -> Path:
    return _ensure_user(user_id) / "index.json"


def _read_index(user_id: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(_index_path(user_id).read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _write_index(user_id: str, rows: list[dict[str, Any]]) -> None:
    _index_path(user_id).write_text(json.dumps(rows, indent=2), encoding="utf-8")


def _entry_dir(user_id: str, entry_id: str) -> Path:
    return _user_root(user_id) / entry_id


def list_entries(user_id: str) -> list[dict[str, Any]]:
    rows = _read_index(user_id)
    rows.sort(key=lambda r: r.get("updated_at", 0), reverse=True)
    return rows


def get_entry(user_id: str, entry_id: str) -> dict[str, Any] | None:
    d = _entry_dir(user_id, entry_id)
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
    meta["user_id"] = user_id
    return meta


def save_entry(
    *,
    user_id: str,
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
    _ensure_user(user_id)
    eid = entry_id or secrets.token_hex(8)
    d = _entry_dir(user_id, eid)
    d.mkdir(exist_ok=True)
    now = time.time()

    existing = get_entry(user_id, eid)
    created = existing.get("created_at", now) if existing else now

    if source_bytes:
        ext = source_ext if source_ext.startswith(".") else f".{source_ext}"
        if ext.lower() in (".jpeg", ".jpg"):
            (d / "source.jpg").write_bytes(source_bytes)
        else:
            (d / f"source{ext}").write_bytes(source_bytes)
            (d / "source.bin").write_bytes(source_bytes)

    if output_bytes:
        (d / "output.jpg").write_bytes(output_bytes)

    hist = history if history is not None else (existing or {}).get("history", [])
    (d / "history.json").write_text(json.dumps(hist, indent=2), encoding="utf-8")

    meta: dict[str, Any] = {
        "id": eid,
        "user_id": user_id,
        "filename": filename or (existing or {}).get("filename") or "image",
        "job_id": job_id or (existing or {}).get("job_id"),
        "created_at": created,
        "updated_at": now,
        "controls": controls or (existing or {}).get("controls"),
        "report_summary": report_summary or (existing or {}).get("report_summary"),
        "history_count": len(hist),
    }
    (d / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    rows = [r for r in _read_index(user_id) if r.get("id") != eid]
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
    rows.sort(key=lambda r: r.get("updated_at", 0), reverse=True)
    if len(rows) > 200:
        for stale in rows[200:]:
            delete_entry(user_id, stale["id"])
        rows = rows[:200]
    _write_index(user_id, rows)
    return get_entry(user_id, eid) or meta


def delete_entry(user_id: str, entry_id: str) -> bool:
    d = _entry_dir(user_id, entry_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    rows = [r for r in _read_index(user_id) if r.get("id") != entry_id]
    _write_index(user_id, rows)
    return True


def clear_all(user_id: str) -> int:
    rows = _read_index(user_id)
    n = len(rows)
    root = _user_root(user_id)
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    _ensure_user(user_id)
    return n


def resolve_image(user_id: str, entry_id: str, kind: str) -> Path | None:
    d = _entry_dir(user_id, entry_id)
    if kind == "output":
        p = d / "output.jpg"
        return p if p.exists() else None
    if kind == "source":
        for name in ("source.jpg", "source.jpeg", "source.png", "source.webp", "source.bin"):
            p = d / name
            if p.exists():
                return p
        for p in d.glob("source*"):
            if p.is_file():
                return p
    return None
