#!/usr/bin/env bash
set -euo pipefail
cd /opt/bmq-otp-relay
if ! grep -q '^CLOUDFLARED_TOKEN=' .env 2>/dev/null; then
  echo "Missing CLOUDFLARED_TOKEN in /opt/bmq-otp-relay/.env" >&2
  echo "Add it without printing the value, then rerun:" >&2
  echo "  sudoedit /opt/bmq-otp-relay/.env" >&2
  exit 1
fi
chmod 600 .env
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d relay cloudflared
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml ps
