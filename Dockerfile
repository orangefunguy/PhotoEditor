# PhotoEditor — production image for editor.herooflegend.com
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_ENV=production \
    AUTH_ENABLED=true \
    PORT=8000

WORKDIR /app

# OpenCV / Pillow system libs
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 \
      libglib2.0-0 \
      curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY backend ./backend
COPY static ./static
COPY scripts ./scripts

# Runtime data dirs (mount a volume over /app/data in production)
RUN mkdir -p /app/data /app/uploads /app/outputs /app/library \
    && chmod +x /app/scripts/run_prod.sh

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["/app/scripts/run_prod.sh"]
