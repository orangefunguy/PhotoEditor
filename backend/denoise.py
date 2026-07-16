"""Controllable denoise pipeline.

Supports percentage-based strength and category-specific numeric controls
aligned with the analysis metrics (HF energy, residual std, local std,
luminance/color offsets, optional mild resize policy).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from .analysis import (
    analyze_single,
    compare,
    encode_jpeg,
    luminance,
    laplacian_stats,
    local_std_stats,
    residual_std,
)


@dataclass
class DenoiseControls:
    """User-facing denoise controls.

    Percentage fields are 0–100 unless noted. Negative HF/noise reduction is
    ignored (clamped). Color/luma offsets are absolute level deltas in 0–255 space.
    """

    # Master strength (0–100). Used when category targets are 0 / default.
    strength_pct: float = 50.0

    # Algorithm: bilateral | nlm | gaussian | median | hybrid
    algorithm: str = "hybrid"

    # Category targets: desired *reduction* in high-frequency / noise proxies.
    # 0 = leave to strength_pct; >0 = aim for that % reduction via iterative strength.
    laplacian_variance_reduce_pct: float = 0.0
    residual_std_reduce_pct: float = 0.0
    local_std_mean_reduce_pct: float = 0.0

    # Photometric offsets applied after denoise (absolute RGB/luma levels).
    luminance_offset: float = 0.0
    r_offset: float = 0.0
    g_offset: float = 0.0
    b_offset: float = 0.0

    # Optional: scale output resolution (1.0 = preserve). Kept for completeness;
    # default preserves full resolution (unlike generative downscale).
    scale: float = 1.0

    # Export
    jpeg_quality: int = 95
    preserve_resolution: bool = True

    # Advanced algorithm knobs (absolute numbers; overridden by % when targets set)
    bilateral_d: int = 0  # 0 = auto from strength
    bilateral_sigma_color: float = 0.0
    bilateral_sigma_space: float = 0.0
    nlm_h: float = 0.0
    nlm_template_window: int = 7
    nlm_search_window: int = 21
    gaussian_sigma: float = 0.0
    median_ksize: int = 0

    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DenoiseControls":
        known = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        kwargs = {k: v for k, v in data.items() if k in known and k != "extra"}
        return cls(**kwargs)


def _clamp_u8_float(rgb: np.ndarray) -> np.ndarray:
    return np.clip(rgb, 0.0, 255.0)


def _strength_to_params(strength_pct: float) -> dict[str, float]:
    """Map 0–100 master strength to algorithm parameters."""
    s = float(np.clip(strength_pct, 0.0, 100.0)) / 100.0
    # Gentle curve: low strength stays mild; high strength more aggressive
    t = s ** 1.2
    return {
        "bilateral_d": int(np.clip(round(3 + t * 12), 3, 15) // 2 * 2 + 1),  # odd 3–15
        "bilateral_sigma_color": 10.0 + t * 90.0,
        "bilateral_sigma_space": 5.0 + t * 25.0,
        "nlm_h": 1.0 + t * 14.0,
        "gaussian_sigma": 0.15 + t * 2.5,
        "median_ksize": int(np.clip(round(1 + t * 4) * 2 + 1, 3, 9)),
        "blend": float(np.clip(t, 0.0, 1.0)),  # mix original back at low strength
    }


def _apply_algorithm(rgb_u8: np.ndarray, controls: DenoiseControls, params: dict[str, float]) -> np.ndarray:
    algo = (controls.algorithm or "hybrid").lower()
    d = controls.bilateral_d or int(params["bilateral_d"])
    sc = controls.bilateral_sigma_color or params["bilateral_sigma_color"]
    ss = controls.bilateral_sigma_space or params["bilateral_sigma_space"]
    h = controls.nlm_h or params["nlm_h"]
    tw = controls.nlm_template_window
    sw = controls.nlm_search_window
    gsig = controls.gaussian_sigma or params["gaussian_sigma"]
    mk = controls.median_ksize or int(params["median_ksize"])
    if mk % 2 == 0:
        mk += 1

    if algo == "bilateral":
        return cv2.bilateralFilter(rgb_u8, d, sc, ss)
    if algo == "nlm":
        return cv2.fastNlMeansDenoisingColored(rgb_u8, None, h, h, tw, sw)
    if algo == "gaussian":
        k = max(3, int(round(gsig * 4)) | 1)
        return cv2.GaussianBlur(rgb_u8, (k, k), gsig)
    if algo == "median":
        return cv2.medianBlur(rgb_u8, mk)
    # hybrid: NLM then light bilateral, strength-blended with original
    nlm = cv2.fastNlMeansDenoisingColored(rgb_u8, None, h, h, tw, sw)
    bil = cv2.bilateralFilter(nlm, max(3, d // 2 * 2 + 1), sc * 0.6, ss * 0.6)
    blend = params["blend"]
    # At low strength keep more original detail
    out = (bil.astype(np.float64) * blend + rgb_u8.astype(np.float64) * (1.0 - blend))
    return np.clip(out, 0, 255).astype(np.uint8)


def _measure_noise_pack(rgb: np.ndarray) -> dict[str, float]:
    lum = luminance(rgb)
    lap = laplacian_stats(lum)
    loc = local_std_stats(lum)
    return {
        "laplacian_variance": lap["variance"],
        "residual_std_5x5": residual_std(lum, 5),
        "local_std_mean_5x5": loc["mean"],
    }


def _strength_for_targets(
    src_rgb: np.ndarray,
    controls: DenoiseControls,
) -> float:
    """If category reduce_% targets are set, search strength to approximate them.

    Uses residual_std as primary objective when set; otherwise laplacian; else local std.
    Falls back to strength_pct when no targets are provided.
    """
    targets = []
    if controls.residual_std_reduce_pct > 0:
        targets.append(("residual_std_5x5", controls.residual_std_reduce_pct))
    if controls.laplacian_variance_reduce_pct > 0:
        targets.append(("laplacian_variance", controls.laplacian_variance_reduce_pct))
    if controls.local_std_mean_reduce_pct > 0:
        targets.append(("local_std_mean_5x5", controls.local_std_mean_reduce_pct))

    if not targets:
        return float(np.clip(controls.strength_pct, 0.0, 100.0))

    base = _measure_noise_pack(src_rgb)
    # Coarse search over strength 0–100
    best_s, best_err = float(controls.strength_pct), float("inf")
    for s in np.linspace(5, 100, 20):
        params = _strength_to_params(float(s))
        trial = _apply_algorithm(
            np.clip(src_rgb, 0, 255).astype(np.uint8),
            controls,
            params,
        ).astype(np.float64)
        m = _measure_noise_pack(trial)
        err = 0.0
        for key, reduce_pct in targets:
            desired = base[key] * (1.0 - reduce_pct / 100.0)
            actual = m[key]
            # relative error
            err += abs(actual - desired) / (base[key] + 1e-6)
        if err < best_err:
            best_err, best_s = err, float(s)
    return best_s


def apply_photometric(rgb: np.ndarray, controls: DenoiseControls) -> np.ndarray:
    out = rgb.copy()
    if controls.luminance_offset:
        out = out + controls.luminance_offset
    out[:, :, 0] = out[:, :, 0] + controls.r_offset
    out[:, :, 1] = out[:, :, 1] + controls.g_offset
    out[:, :, 2] = out[:, :, 2] + controls.b_offset
    return _clamp_u8_float(out)


def apply_scale(rgb: np.ndarray, controls: DenoiseControls) -> np.ndarray:
    if controls.preserve_resolution or abs(controls.scale - 1.0) < 1e-6:
        return rgb
    scale = float(np.clip(controls.scale, 0.1, 4.0))
    h, w = rgb.shape[:2]
    nh, nw = max(1, int(round(h * scale))), max(1, int(round(w * scale)))
    u8 = np.clip(rgb, 0, 255).astype(np.uint8)
    resized = cv2.resize(u8, (nw, nh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LANCZOS4)
    return resized.astype(np.float64)


def denoise_image(
    rgb: np.ndarray,
    controls: DenoiseControls | dict[str, Any],
    src_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run denoise pipeline and return image array + full analysis report."""
    if isinstance(controls, dict):
        controls = DenoiseControls.from_dict(controls)

    src = _clamp_u8_float(rgb)
    src_u8 = src.astype(np.uint8)

    effective_strength = _strength_for_targets(src, controls)
    params = _strength_to_params(effective_strength)

    # If strength is effectively 0 and no photometric offsets, return copy
    if effective_strength < 0.5 and not any(
        [
            controls.luminance_offset,
            controls.r_offset,
            controls.g_offset,
            controls.b_offset,
        ]
    ):
        out = src.copy()
        algo_note = "bypass (strength ≈ 0)"
    else:
        denoised_u8 = _apply_algorithm(src_u8, controls, params)
        out = denoised_u8.astype(np.float64)
        algo_note = f"{controls.algorithm} @ strength {effective_strength:.1f}%"

    out = apply_photometric(out, controls)
    out = apply_scale(out, controls)
    out = _clamp_u8_float(out)

    jpeg_bytes = encode_jpeg(out, controls.jpeg_quality)
    out_meta = {
        "file_bytes": len(jpeg_bytes),
        "format": "JPEG",
        "bit_depth": 8,
        "has_icc": False,
        "dpi": [72.0, 72.0],
    }
    src_meta = src_meta or {
        "file_bytes": None,
        "format": "unknown",
        "bit_depth": 8,
        "has_icc": False,
        "dpi": [72.0, 72.0],
    }

    report = compare(src, out, src_meta, out_meta)
    report["pipeline"] = {
        "algorithm": controls.algorithm,
        "effective_strength_pct": effective_strength,
        "requested_strength_pct": controls.strength_pct,
        "params": params,
        "controls": {
            "strength_pct": controls.strength_pct,
            "algorithm": controls.algorithm,
            "laplacian_variance_reduce_pct": controls.laplacian_variance_reduce_pct,
            "residual_std_reduce_pct": controls.residual_std_reduce_pct,
            "local_std_mean_reduce_pct": controls.local_std_mean_reduce_pct,
            "luminance_offset": controls.luminance_offset,
            "r_offset": controls.r_offset,
            "g_offset": controls.g_offset,
            "b_offset": controls.b_offset,
            "scale": controls.scale,
            "preserve_resolution": controls.preserve_resolution,
            "jpeg_quality": controls.jpeg_quality,
            "bilateral_d": controls.bilateral_d,
            "bilateral_sigma_color": controls.bilateral_sigma_color,
            "bilateral_sigma_space": controls.bilateral_sigma_space,
            "nlm_h": controls.nlm_h,
            "gaussian_sigma": controls.gaussian_sigma,
            "median_ksize": controls.median_ksize,
        },
        "note": algo_note,
        "method": (
            "Classical OpenCV denoise (bilateral / NLM / gaussian / median / hybrid). "
            "Not a generative re-synthesis — resolution preserved by default."
        ),
    }
    report["source_single"] = analyze_single(src, src_meta)
    report["output_single"] = analyze_single(out, out_meta)

    return {
        "rgb": out,
        "jpeg_bytes": jpeg_bytes,
        "report": report,
    }
