#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export DJANGO_SETTINGS_MODULE=config.settings.development
export PYTHONUNBUFFERED=1
exec python -m gunicorn config.wsgi:application --bind 0.0.0.0:8081 --workers 2 --timeout 120
