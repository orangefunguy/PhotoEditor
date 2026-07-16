#!/usr/bin/env bash
# Start PhotoEditor locally on http://127.0.0.1:8000
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d .venv ]]; then
  echo "Creating venv…"
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

# shellcheck disable=SC1091
source .venv/bin/activate

export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
echo "PhotoEditor → http://127.0.0.1:8000"
exec uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
