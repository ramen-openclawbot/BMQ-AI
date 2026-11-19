#!/usr/bin/env bash
# Rollback-only live verification for public.finance_pnl_accrual(date).
#
# It concatenates:
#   begin;
#   <the existing migration>
#   <body-only finance_pnl_accrual_dryrun.sql>
#   rollback;
# into one temporary SQL file and runs it through the linked Supabase project.
# The migration is therefore created only inside a transaction that is always
# rolled back. After the rollback it asserts that no finance_pnl_accrual*
# function remains.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261119085657_finance_pnl_accrual.sql"
CHECK="$ROOT/supabase/tests/finance_pnl_accrual_dryrun.sql"
PROJECT_REF="cxntbdvfsikwmitapony"

if [[ ! -f "$MIGRATION" ]]; then
  echo "ERROR: missing migration $MIGRATION" >&2
  exit 1
fi
if [[ ! -f "$CHECK" ]]; then
  echo "ERROR: missing check file $CHECK" >&2
  exit 1
fi

# The migration and the check must never carry their own transaction control.
if grep -Eq '^[[:space:]]*(begin|commit|rollback)[[:space:]]*;' "$MIGRATION"; then
  echo "ERROR: migration must not contain BEGIN/COMMIT/ROLLBACK" >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*(begin|commit|rollback)[[:space:]]*;' "$CHECK"; then
  echo "ERROR: check file must not contain BEGIN/COMMIT/ROLLBACK" >&2
  exit 1
fi

TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/finance_pnl_accrual.XXXXXX.sql")"
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

{
  printf '%s\n' 'begin;'
  cat "$MIGRATION"
  printf '\n'
  cat "$CHECK"
  printf '\n%s\n' 'rollback;'
} > "$TMP_FILE"

cd "$ROOT"

echo "Running rollback-only accrual P&L verification on project $PROJECT_REF..."
set +e
DO_NOT_TRACK=1 supabase db query \
  --linked \
  --project-ref "$PROJECT_REF" \
  -f "$TMP_FILE"
QUERY_STATUS=$?
set -e

COUNT_JSON="$(DO_NOT_TRACK=1 supabase db query \
  --linked \
  --project-ref "$PROJECT_REF" \
  --output-format json \
  "select count(*)::integer as n from pg_proc where proname like 'finance_pnl_accrual%'")"

COUNT="$(printf '%s' "$COUNT_JSON" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data[0]["n"])')"

if [[ "$COUNT" != "0" ]]; then
  echo "ERROR: $COUNT finance_pnl_accrual* function(s) remain after rollback" >&2
  exit 1
fi

if [[ "$QUERY_STATUS" -ne 0 ]]; then
  echo "ERROR: rollback-only verification failed (exit $QUERY_STATUS); no functions remain." >&2
  exit "$QUERY_STATUS"
fi

echo "Rollback verified: 0 finance_pnl_accrual* functions remain."
