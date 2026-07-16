#!/usr/bin/env bash
set -euo pipefail
cd /app
export PYTHONPATH=/app
export APP_ENV="${APP_ENV:-production}"
export AUTH_ENABLED="${AUTH_ENABLED:-true}"
export FRONTEND_URL="${FRONTEND_URL:-https://editor.herooflegend.com}"

# Optional local .env (not used on Render if secrets are injected)
if [[ -f /app/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /app/.env
  set +a
fi

# Prefer a single persistent mount at /app/data (Render disk)
mkdir -p /app/data /app/data/uploads /app/data/outputs /app/data/library
# Symlink app paths → data volume when not already mounted separately
link_dir() {
  local src="$1" dest="$2"
  if [[ -L "$src" ]]; then
    return 0
  fi
  if [[ -d "$src" ]] && [[ ! -d "$dest" ]]; then
    mv "$src" "$dest" 2>/dev/null || true
  fi
  mkdir -p "$dest"
  if [[ -d "$src" ]] && [[ ! -L "$src" ]]; then
    # keep existing non-empty dir if volume already has content
    if [[ -z "$(ls -A "$src" 2>/dev/null || true)" ]]; then
      rm -rf "$src"
      ln -sfn "$dest" "$src"
    fi
  else
    ln -sfn "$dest" "$src"
  fi
}
link_dir /app/uploads /app/data/uploads
link_dir /app/outputs /app/data/outputs
link_dir /app/library /app/data/library
mkdir -p /app/data /app/uploads /app/outputs /app/library

WORKERS="${UVICORN_WORKERS:-2}"
PORT="${PORT:-8000}"

exec uvicorn backend.app:app \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --workers "${WORKERS}" \
  --proxy-headers \
  --forwarded-allow-ips='*'
