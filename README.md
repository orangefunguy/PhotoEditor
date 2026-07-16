# PhotoEditor

Technical image analysis and **controllable denoise** for the web.

PhotoEditor is a local web workbench that:

1. **Analyzes** an image with the same metric categories used in denoise evaluation reports (geometry, pixel difference, luminance, RGB means, Laplacian high-frequency energy, residual / local-std noise proxies, global SSIM-like scores).
2. **Applies classical denoise** (OpenCV hybrid NLM + bilateral, or single algorithms) with controls by **percentage** or **absolute numbers** per category.
3. **Compares** source vs output with full technical deltas (MAE, RMSE, PSNR, % HF reduction, etc.).
4. **Preserves resolution by default** (unlike generative downscale pipelines).

Repository: [github.com/orangefunguy/PhotoEditor](https://github.com/orangefunguy/PhotoEditor)

---

## Features

| Area | What you get |
|------|----------------|
| **Upload** | Drag-and-drop or file picker (JPEG, PNG, WebP, …) |
| **Source metrics** | Width/height, file size, aspect, luminance mean/std, RGB means, Laplacian variance / mean\|L\|, residual std, local std mean/median |
| **Denoise strength** | 0–100% master control mapped to algorithm parameters |
| **Category targets** | Optional % reduction targets for Laplacian variance, residual std, local std mean (auto-searches strength) |
| **Photometric offsets** | Luminance and R/G/B absolute level deltas after denoise |
| **Algorithms** | Hybrid (default), Non-local means, Bilateral, Gaussian, Median |
| **Advanced** | JPEG quality, optional scale, NLM `h`, bilateral σ, Gaussian σ |
| **Preview** | Source / output / interactive before–after slider |
| **Zoom** | Preview zoom with **size %** (native pixels), Fit, 1:1, scroll-wheel zoom, drag pan |
| **Session cache** | Auto-saves work to browser IndexedDB (survives reload / brief offline) |
| **Undo history** | Per-project edit stack with Undo/Redo and clickable history timeline |
| **Image library** | Repository of edited images + change log (browser + local server disk) |
| **Clear cache** | Clear session, history, library, or everything for a fresh start |
| **Export** | Download denoised JPEG |

---

## Quick start (local host)

### Requirements

- Python **3.10+** (3.11–3.14 tested)
- macOS, Linux, or Windows

### Install

```bash
git clone https://github.com/orangefunguy/PhotoEditor.git
cd PhotoEditor
python3 -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows
# .venv\Scripts\activate

pip install -r requirements.txt
```

### Run

```bash
# From the repo root, with venv activated:
uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
```

Or use the helper script:

```bash
./scripts/run.sh
```

Open **[http://127.0.0.1:8000](http://127.0.0.1:8000)** in your browser.

- **Editor:** [http://127.0.0.1:8000](http://127.0.0.1:8000)
- **Documentation (tools & metrics):** [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
- **OpenAPI / Swagger:** [http://127.0.0.1:8000/api/docs](http://127.0.0.1:8000/api/docs)

Hover any control’s **?** for an ELI5 tip. The header badge shows **local** when the API is healthy.

---

## Usage

### 1. Load an image

- Drop a photo on the left panel, or click to browse.
- PhotoEditor runs **analyze** automatically and fills the **Technical metrics** column (geometry, luminance, color, HF energy, noise proxies).

### 2. Set denoise controls

**Master denoise**

- **Strength (0–100%)** — overall filter intensity. Uses hybrid NLM + bilateral by default.
- **Algorithm** — switch to pure NLM, bilateral, Gaussian, or median.

**Category targets (%)** — optional; `0` means “use master strength only”:

| Control | Metric affected |
|---------|-----------------|
| Laplacian variance reduce | High-frequency energy (noise + fine detail) |
| Residual std reduce (5×5) | Std of residual after box blur |
| Local std mean reduce | Mean local texture/noise energy |

When any target is &gt; 0, the backend **searches strength** to approximate that reduction.

**Photometric offsets** — applied after denoise, in 8-bit levels:

- Luminance offset (−40 … +40)
- R / G / B offsets (−40 … +40)

**Advanced**

- JPEG export quality
- Scale (only applied if “Preserve resolution” is unchecked)
- Manual NLM `h`, bilateral σ color/space, Gaussian σ (`0` = auto from strength)

### 3. Zoom the preview

The center panel shows **display size as a percentage of native image pixels** (`100%` = 1 screen pixel per image pixel).

| Control | Action |
|---------|--------|
| **− / +** | Zoom out / in by 10% |
| **% field** | Type an exact size (5–800%) and press Enter |
| **Fit** | Largest size that fits the preview window |
| **1:1** | 100% native resolution |
| **Scroll wheel** | Zoom toward cursor |
| **Drag** | Pan when the image is larger than the stage |
| **Double-click** | Toggle Fit ↔ 1:1 |

The toolbar also shows `nativeW×nativeH px → displayW×displayH px · fit|1:1|N%`.

### 4. Apply denoise

- Click **Apply denoise**.
- Preview switches to **Compare** (drag the slider).
- Metrics panel shows the full **comparison report**:
  - Geometry delta (resolution preserved?)
  - MAE / RMSE / PSNR / max \|Δ\| / % pixels over thresholds
  - Luminance &amp; color deltas
  - HF and noise proxy % changes
  - Global SSIM-like scores
  - Source and output metric cards

### 5. Download

- **Download** saves `photoeditor_<job>_denoised.jpg`.

### 6. Reset

- **Reset controls** restores default sliders without clearing the image.

### 7. Session cache, history & library

PhotoEditor keeps your work so reloads and short disconnects do not lose progress.

| Storage | Where | What |
|---------|--------|------|
| **Session** | Browser IndexedDB | Current image, controls, zoom, last report |
| **History** | Browser IndexedDB | Undo stack (source/output blobs + labels) |
| **Library** | Browser IndexedDB **+** `library/` on the server | Repository of edited images and change logs |

**Automatic behavior**

- On upload / denoise → session save + history step + library update  
- Every ~30s and on tab close → session autosave  
- On page load → previous session is restored when present  

**Header**

- **Undo** / **Redo** (also `⌘Z` / `⌘⇧Z` or `Ctrl+Z` / `Ctrl+Y`)  
- Cache badge shows `cached` / `restored`

**Side panel tabs**

- **Metrics** — technical report  
- **History** — click any step to restore that state  
- **Library** — open or delete past edited images; shows a brief change log  

**Cache controls** (left panel)

| Button | Effect |
|--------|--------|
| **Save now** | Force-write session + library |
| **Clear session** | Drop WIP session cache only |
| **Clear history** | Empty undo stack for this project |
| **Clear library** | Delete all repository entries (browser + server) |
| **Clear all cache** | Wipe session, history, and library — start fresh |

---

## API (for maintainers / automation)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/analyze` | `multipart/form-data` field `file` → metrics + `job_id` |
| `POST` | `/api/denoise` | `file` and/or `job_id` + `controls_json` → report + image URLs |
| `GET` | `/api/jobs/{id}` | Job metadata / report |
| `GET` | `/api/jobs/{id}/source` | Original upload |
| `GET` | `/api/jobs/{id}/output` | Denoised JPEG |
| `GET` | `/api/jobs/{id}/download` | Attachment download |
| `GET` | `/api/library` | List repository entries |
| `GET` | `/api/library/{id}` | Entry metadata + history |
| `POST` | `/api/library` | Save entry (`source`/`output` files + history JSON) |
| `DELETE` | `/api/library/{id}` | Delete one entry |
| `DELETE` | `/api/library` | Clear entire server library |
| `GET` | `/api/library/{id}/source` | Source image bytes |
| `GET` | `/api/library/{id}/output` | Output image bytes |

Example `controls_json`:

```json
{
  "strength_pct": 55,
  "algorithm": "hybrid",
  "laplacian_variance_reduce_pct": 40,
  "residual_std_reduce_pct": 25,
  "local_std_mean_reduce_pct": 0,
  "luminance_offset": 0,
  "r_offset": 0,
  "g_offset": 0,
  "b_offset": 0,
  "preserve_resolution": true,
  "jpeg_quality": 95
}
```

Interactive OpenAPI docs (when server is running): [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

---

## Project layout

```
PhotoEditor/
├── README.md
├── requirements.txt
├── scripts/
│   └── run.sh
├── backend/
│   ├── app.py          # FastAPI routes
│   ├── analysis.py     # Metrics (MAE, PSNR, Laplacian, residual std, …)
│   ├── denoise.py      # Controllable classical denoise pipeline
│   └── library.py      # Server image repository + change logs
├── static/
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── store.js    # IndexedDB session / history / library
│       └── app.js
├── uploads/            # runtime (gitignored)
├── outputs/            # runtime (gitignored)
└── library/            # runtime repository (gitignored)
```

---

## Metrics reference

Aligned with the technical denoise report:

| Category | Metrics |
|----------|---------|
| **Geometry** | width, height, aspect, file bytes, format, bit depth, ICC, DPI |
| **Pixel difference** | MAE, MAE RGB, RMSE, PSNR dB, max \|Δ\|, mean signed Δ RGB, % pixels over thresholds 1/5/10/20/40 |
| **Luminance** | Rec.709 mean &amp; std, mean Δ |
| **Color** | RGB means, mean Δ RGB |
| **High-frequency** | Laplacian variance, mean \|Laplacian\|, % change |
| **Noise proxies** | residual std after 5×5 box blur; local std mean/median in 5×5 windows |
| **Structure** | Global SSIM-like on luma and R/G/B |

**Method note:** Denoise is **classical** (OpenCV), not generative re-synthesis. Strength and category targets approximate the report’s “HF energy / residual std reduction” knobs without silently downscaling the image.

---

## Development

```bash
source .venv/bin/activate
uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
```

- Frontend is static files under `static/` (no build step).
- Backend is pure Python; tests can call `analysis.compare` and `denoise.denoise_image` directly.
- Runtime images land in `uploads/` and `outputs/` (ignored by git).

### Suggested future work

- Tile-based processing for very large images
- Side-by-side histogram / residual map visualization
- Preset profiles (“mild wedding ISO”, “aggressive phone night”)
- Optional RAW (DNG) path
- Persist jobs in SQLite for multi-session history

---

## License

MIT — see [LICENSE](LICENSE) if present; otherwise free to use and maintain in this repository.

---

## Maintainer

Updates land on [github.com/orangefunguy/PhotoEditor](https://github.com/orangefunguy/PhotoEditor). Run locally for development; deploy (e.g. container + reverse proxy) when you need a shared host.
