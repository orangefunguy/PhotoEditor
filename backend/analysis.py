"""Image analysis metrics for PhotoEditor.

Computes the same technical categories used in denoise evaluation:
geometry/encoding, pixel difference, luminance, color, high-frequency energy,
noise proxies, and structural similarity.
"""

from __future__ import annotations

import io
import os
from typing import Any

import numpy as np
from PIL import Image


def load_rgb(path_or_bytes: str | bytes) -> tuple[np.ndarray, dict[str, Any]]:
    """Load an image as float64 RGB HxWx3 in [0, 255] plus file metadata."""
    if isinstance(path_or_bytes, bytes):
        im = Image.open(io.BytesIO(path_or_bytes))
        size_bytes = len(path_or_bytes)
        source = "bytes"
    else:
        im = Image.open(path_or_bytes)
        size_bytes = os.path.getsize(path_or_bytes)
        source = path_or_bytes

    fmt = im.format or "unknown"
    mode_in = im.mode
    has_icc = bool(im.info.get("icc_profile"))
    dpi = im.info.get("dpi", (72, 72))
    im = im.convert("RGB")
    arr = np.asarray(im, dtype=np.float64)
    meta = {
        "source": source,
        "format": fmt,
        "mode_in": mode_in,
        "width": int(arr.shape[1]),
        "height": int(arr.shape[0]),
        "channels": 3,
        "bit_depth": 8,
        "has_icc": has_icc,
        "dpi": [float(dpi[0]) if dpi else 72.0, float(dpi[1]) if dpi else 72.0],
        "file_bytes": int(size_bytes),
        "pixel_count": int(arr.shape[0] * arr.shape[1]),
        "aspect_ratio": float(arr.shape[1] / arr.shape[0]) if arr.shape[0] else 0.0,
    }
    return arr, meta


def luminance(rgb: np.ndarray) -> np.ndarray:
    """Rec.709 luma."""
    return 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]


def _box_blur(gray: np.ndarray, k: int = 5) -> np.ndarray:
    ker = np.ones(k, dtype=np.float64) / k
    tmp = np.apply_along_axis(lambda m: np.convolve(m, ker, mode="same"), 1, gray)
    return np.apply_along_axis(lambda m: np.convolve(m, ker, mode="same"), 0, tmp)


def laplacian_stats(gray: np.ndarray) -> dict[str, float]:
    p = np.pad(gray, 1, mode="edge")
    lap = (
        p[:-2, 1:-1]
        + p[2:, 1:-1]
        + p[1:-1, :-2]
        + p[1:-1, 2:]
        - 4 * p[1:-1, 1:-1]
    )
    return {
        "variance": float(lap.var()),
        "mean_abs": float(np.abs(lap).mean()),
    }


def residual_std(gray: np.ndarray, k: int = 5) -> float:
    """Std of residual after k×k box blur — noise proxy."""
    return float(np.std(gray - _box_blur(gray, k)))


def local_std_stats(gray: np.ndarray, k: int = 5) -> dict[str, float]:
    """Mean/median of local standard deviation in a k×k window."""
    mu = _box_blur(gray, k)
    mu2 = _box_blur(gray * gray, k)
    local = np.sqrt(np.maximum(mu2 - mu * mu, 0.0))
    return {
        "mean": float(local.mean()),
        "median": float(np.median(local)),
    }


def ssim_global(x: np.ndarray, y: np.ndarray) -> float:
    """Global SSIM-like score on two 2D arrays (not windowed SSIM)."""
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    mx, my = float(x.mean()), float(y.mean())
    sx, sy = float(x.std()), float(y.std())
    sxy = float(((x - mx) * (y - my)).mean())
    return float(
        ((2 * mx * my + c1) * (2 * sxy + c2))
        / ((mx * mx + my * my + c1) * (sx * sx + sy * sy + c2) + 1e-12)
    )


def analyze_single(rgb: np.ndarray, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """Full metric pack for one image (no comparison)."""
    meta = meta or {}
    lum = luminance(rgb)
    lap = laplacian_stats(lum)
    loc = local_std_stats(lum)
    means = rgb.mean(axis=(0, 1))
    return {
        "geometry": {
            "width": int(rgb.shape[1]),
            "height": int(rgb.shape[0]),
            "pixel_count": int(rgb.shape[0] * rgb.shape[1]),
            "aspect_ratio": float(rgb.shape[1] / rgb.shape[0]),
            "file_bytes": meta.get("file_bytes"),
            "format": meta.get("format"),
            "bit_depth": meta.get("bit_depth", 8),
            "channels": 3,
            "has_icc": meta.get("has_icc", False),
            "dpi": meta.get("dpi", [72.0, 72.0]),
        },
        "luminance": {
            "mean": float(lum.mean()),
            "std": float(lum.std()),
        },
        "color_means": {
            "r": float(means[0]),
            "g": float(means[1]),
            "b": float(means[2]),
        },
        "high_frequency": {
            "laplacian_variance": lap["variance"],
            "laplacian_mean_abs": lap["mean_abs"],
        },
        "noise_proxies": {
            "residual_std_5x5": residual_std(lum, 5),
            "local_std_mean_5x5": loc["mean"],
            "local_std_median_5x5": loc["median"],
        },
    }


def compare(
    src: np.ndarray,
    out: np.ndarray,
    src_meta: dict[str, Any] | None = None,
    out_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compare source vs output. If sizes differ, LANCZOS-resize source to output size for pixel metrics."""
    from PIL import Image as PILImage

    src_meta = src_meta or {}
    out_meta = out_meta or {}

    src_metrics = analyze_single(src, src_meta)
    out_metrics = analyze_single(out, out_meta)

    if src.shape[:2] != out.shape[:2]:
        src_img = PILImage.fromarray(np.clip(src, 0, 255).astype(np.uint8))
        src_r = np.asarray(
            src_img.resize((out.shape[1], out.shape[0]), PILImage.Resampling.LANCZOS),
            dtype=np.float64,
        )
        resize_note = (
            f"Source resized {src.shape[1]}x{src.shape[0]} → "
            f"{out.shape[1]}x{out.shape[0]} (LANCZOS) for pixel comparison"
        )
    else:
        src_r = src
        resize_note = "Same resolution — direct pixel comparison"

    a = src_r
    b = out
    diff = b - a
    abs_diff = np.abs(diff)
    mse = float((diff ** 2).mean())
    mae = float(abs_diff.mean())
    rmse = float(np.sqrt(mse))
    psnr = float(10 * np.log10((255.0 ** 2) / (mse + 1e-12)))
    max_abs = float(abs_diff.max())
    mean_signed = diff.mean(axis=(0, 1))
    std_delta = diff.std(axis=(0, 1))

    max_ch = abs_diff.max(axis=2)
    thresholds = {}
    for thr in (1, 5, 10, 20, 40):
        thresholds[str(thr)] = float((max_ch > thr).mean() * 100.0)

    src_lum = luminance(a)
    out_lum = luminance(b)
    src_lap = laplacian_stats(src_lum)
    out_lap = laplacian_stats(out_lum)
    src_res = residual_std(src_lum, 5)
    out_res = residual_std(out_lum, 5)
    src_loc = local_std_stats(src_lum, 5)
    out_loc = local_std_stats(out_lum, 5)

    def pct_change(new: float, old: float) -> float:
        if abs(old) < 1e-12:
            return 0.0
        return float((new / old - 1.0) * 100.0)

    return {
        "comparison_note": resize_note,
        "source": src_metrics,
        "output": out_metrics,
        "geometry_delta": {
            "width_scale": float(out.shape[1] / src.shape[1]) if src.shape[1] else 0.0,
            "height_scale": float(out.shape[0] / src.shape[0]) if src.shape[0] else 0.0,
            "pixel_count_ratio": float(
                (out.shape[0] * out.shape[1]) / (src.shape[0] * src.shape[1])
            )
            if src.shape[0] and src.shape[1]
            else 0.0,
            "file_bytes_ratio": (
                float(out_meta["file_bytes"] / src_meta["file_bytes"])
                if src_meta.get("file_bytes") and out_meta.get("file_bytes")
                else None
            ),
            "resolution_preserved": bool(src.shape[:2] == out.shape[:2]),
        },
        "pixel_difference": {
            "mae": mae,
            "mae_rgb": [float(x) for x in abs_diff.mean(axis=(0, 1))],
            "rmse": rmse,
            "psnr_db": psnr,
            "max_abs": max_abs,
            "mean_signed_delta_rgb": [float(x) for x in mean_signed],
            "std_delta_rgb": [float(x) for x in std_delta],
            "pct_pixels_max_abs_over": thresholds,
        },
        "luminance_delta": {
            "source_mean": float(src_lum.mean()),
            "output_mean": float(out_lum.mean()),
            "mean_delta": float(out_lum.mean() - src_lum.mean()),
            "source_std": float(src_lum.std()),
            "output_std": float(out_lum.std()),
            "std_delta": float(out_lum.std() - src_lum.std()),
        },
        "color_delta": {
            "mean_delta_rgb": [
                float(out_metrics["color_means"]["r"] - src_metrics["color_means"]["r"]),
                float(out_metrics["color_means"]["g"] - src_metrics["color_means"]["g"]),
                float(out_metrics["color_means"]["b"] - src_metrics["color_means"]["b"]),
            ],
        },
        "high_frequency_delta": {
            "laplacian_variance_source": src_lap["variance"],
            "laplacian_variance_output": out_lap["variance"],
            "laplacian_variance_pct_change": pct_change(out_lap["variance"], src_lap["variance"]),
            "laplacian_mean_abs_source": src_lap["mean_abs"],
            "laplacian_mean_abs_output": out_lap["mean_abs"],
            "laplacian_mean_abs_pct_change": pct_change(out_lap["mean_abs"], src_lap["mean_abs"]),
        },
        "noise_proxy_delta": {
            "residual_std_source": src_res,
            "residual_std_output": out_res,
            "residual_std_pct_change": pct_change(out_res, src_res),
            "local_std_mean_source": src_loc["mean"],
            "local_std_mean_output": out_loc["mean"],
            "local_std_mean_pct_change": pct_change(out_loc["mean"], src_loc["mean"]),
            "local_std_median_source": src_loc["median"],
            "local_std_median_output": out_loc["median"],
            "local_std_median_pct_change": pct_change(out_loc["median"], src_loc["median"]),
        },
        "structural_similarity": {
            "luma_ssim_global": ssim_global(src_lum, out_lum),
            "r_ssim_global": ssim_global(a[:, :, 0], b[:, :, 0]),
            "g_ssim_global": ssim_global(a[:, :, 1], b[:, :, 1]),
            "b_ssim_global": ssim_global(a[:, :, 2], b[:, :, 2]),
        },
    }


def encode_jpeg(rgb: np.ndarray, quality: int = 95) -> bytes:
    im = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), mode="RGB")
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=int(np.clip(quality, 1, 100)), optimize=True)
    return buf.getvalue()


def encode_png(rgb: np.ndarray) -> bytes:
    im = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), mode="RGB")
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
