#!/usr/bin/env bash
# Sequential, local-only gate. Requires the supplied baseline and Playwright browser.
set -euo pipefail
cd "$(dirname "$0")/../../.."
lane_output=/tmp/bmq-i18n-lanes/b-purchasing
mkdir -p "$lane_output"
node apps/web/node_modules/vite/bin/vite.js --config scripts/i18n/b-purchasing/fixture/vite.config.mjs > "$lane_output/server.log" 2>&1 &
lane_server_pid=$!
trap 'kill "$lane_server_pid" 2>/dev/null || true' EXIT
for attempt in $(seq 1 60); do
  kill -0 "$lane_server_pid" 2>/dev/null || { cat "$lane_output/server.log"; exit 1; }
  if curl --silent --fail http://127.0.0.1:4300/ > /dev/null; then break; fi
  sleep 1
done
for suite in browser invoice-baseline.browser dialogs.browser states.browser workflows.browser secondary.browser; do
  node --test "scripts/i18n/b-purchasing/$suite.mjs" > "$lane_output/$suite-run.txt" 2>&1
done
kill "$lane_server_pid"
wait "$lane_server_pid" 2>/dev/null || true
trap - EXIT
node --test scripts/i18n/b-purchasing/contracts.test.mjs scripts/i18n/b-purchasing/dictionaries.test.mjs > "$lane_output/static-final.txt"
node scripts/i18n/b-purchasing/check-literals.mjs > "$lane_output/literal-final.txt"
node scripts/i18n/b-purchasing/lint.mjs > "$lane_output/lint-summary.json"
python3 scripts/i18n/b-purchasing/typecheck-parity.py > "$lane_output/typecheck-summary.txt"
git diff --check
