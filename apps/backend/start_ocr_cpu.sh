#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export DJANGO_SETTINGS_MODULE="${DJANGO_SETTINGS_MODULE:-config.settings.development}"
export PYTHONUNBUFFERED=1

LOG_DIR="${OCR_LOG_DIR:-$(pwd)/logs}"
mkdir -p "$LOG_DIR"

BIND="${OCR_BIND:-0.0.0.0:8081}"
WORKERS="${OCR_GUNICORN_WORKERS:-1}"
TIMEOUT="${OCR_GUNICORN_TIMEOUT:-180}"
LOG_LEVEL="${OCR_GUNICORN_LOG_LEVEL:-info}"
PYTHON_BIN="${PYTHON_BIN:-/home/ubuntu/.hermes/hermes-agent/venv/bin/python}"

exec "$PYTHON_BIN" -m gunicorn config.wsgi:application \
  --bind "$BIND" \
  --workers "$WORKERS" \
  --timeout "$TIMEOUT" \
  --worker-tmp-dir /dev/shm \
  --access-logfile "$LOG_DIR/ocr-access.log" \
  --error-logfile "$LOG_DIR/ocr-error.log" \
  --capture-output \
  --log-level "$LOG_LEVEL"
