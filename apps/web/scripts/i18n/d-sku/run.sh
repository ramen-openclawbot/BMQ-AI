#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
export NODE_OPTIONS=--max-old-space-size=1024
lane_artifacts=/tmp/bmq-i18n-lanes/d-sku
mkdir -p "$lane_artifacts"
node --test scripts/i18n/d-sku/contracts.test.mjs > "$lane_artifacts/contracts.log" 2>&1
node scripts/i18n/d-sku/literal-guard.mjs > "$lane_artifacts/literal-guard.log" 2>&1
./node_modules/.bin/vite --config scripts/i18n/d-sku/fixture/vite.config.mjs > "$lane_artifacts/server.log" 2>&1 &
lane_server_pid=$!
trap 'kill "$lane_server_pid" 2>/dev/null || true' EXIT
for lane_attempt in {1..30}; do
  if curl --silent --fail http://127.0.0.1:4307/index > /dev/null; then break; fi
  sleep 1
done
node scripts/i18n/d-sku/browser.mjs > "$lane_artifacts/browser.log" 2>&1
node scripts/i18n/d-sku/dialogs.browser.mjs > "$lane_artifacts/dialogs.log" 2>&1
kill "$lane_server_pid"
wait "$lane_server_pid" 2>/dev/null || true
trap - EXIT
node scripts/i18n/d-sku/lint.mjs > "$lane_artifacts/lint.log" 2>&1
node scripts/i18n/d-sku/typecheck.mjs --base > "$lane_artifacts/types-base.json" || test "$?" -eq 1
node scripts/i18n/d-sku/typecheck.mjs > "$lane_artifacts/types-current.json" || test "$?" -eq 1
python3 scripts/i18n/d-sku/diagnostic-parity.py > "$lane_artifacts/diagnostic-parity.log"
