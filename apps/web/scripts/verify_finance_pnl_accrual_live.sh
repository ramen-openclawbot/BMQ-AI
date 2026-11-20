#!/usr/bin/env bash
# Rollback-only live verification for public.finance_pnl_accrual(date) and the
# manual-adjustment / net-profit extension.
#
# It concatenates:
#   begin;
#   <the existing accrual P&L migration>
#   <the new manual-adjustment migration>
#   <body-only finance_pnl_accrual_dryrun.sql>
#   rollback;
# into one temporary SQL file and runs it through the linked Supabase project.
# Both migrations are therefore created only inside a transaction that is always
# rolled back. After the rollback it asserts that the new table and the new
# functions are gone. The old finance_pnl_accrual* functions already exist on
# the live database, so they are deliberately not counted here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_OLD="$ROOT/supabase/migrations/20261119085657_finance_pnl_accrual.sql"
MIGRATION_NEW="$ROOT/supabase/migrations/20261120180758_finance_net_profit_adjustments.sql"
CHECK="$ROOT/supabase/tests/finance_pnl_accrual_dryrun.sql"
PROJECT_REF="cxntbdvfsikwmitapony"

for file in "$MIGRATION_OLD" "$MIGRATION_NEW" "$CHECK"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: missing $file" >&2
    exit 1
  fi
done

# The migrations and the check must never carry their own transaction control.
for migration in "$MIGRATION_OLD" "$MIGRATION_NEW"; do
  if grep -Eq '^[[:space:]]*(begin|commit|rollback)[[:space:]]*;' "$migration"; then
    echo "ERROR: migration $migration must not contain BEGIN/COMMIT/ROLLBACK" >&2
    exit 1
  fi
done
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
  cat "$MIGRATION_OLD"
  printf '\n'
  cat "$MIGRATION_NEW"
  printf '\n'
  cat "$CHECK"
  printf '\n%s\n' 'rollback;'
} > "$TMP_FILE"

cd "$ROOT"

echo "Running rollback-only accrual P&L / net-profit verification on project $PROJECT_REF..."
set +e
DO_NOT_TRACK=1 supabase db query \
  --linked \
  --project-ref "$PROJECT_REF" \
  -f "$TMP_FILE"
QUERY_STATUS=$?
set -e

LEFTOVER_JSON="$(DO_NOT_TRACK=1 supabase db query \
  --linked \
  --project-ref "$PROJECT_REF" \
  --output-format json \
  "select case
     when to_regclass('public.finance_manual_adjustments') is null
      and not exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'finance_manual_adjustment_save',
            'finance_manual_adjustment_void',
            'finance_manual_adjustment_month_lines',
            'finance_can_view_self'
          )
      )
     then 'ok'
     else 'leftover'
   end as status")"

LEFTOVER="$(printf '%s' "$LEFTOVER_JSON" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data[0]["status"])')"

if [[ "$LEFTOVER" != "ok" ]]; then
  echo "ERROR: finance_manual_adjustments table or manual-adjustment functions remain after rollback" >&2
  exit 1
fi

if [[ "$QUERY_STATUS" -ne 0 ]]; then
  echo "ERROR: rollback-only verification failed (exit $QUERY_STATUS); no new objects remain." >&2
  exit "$QUERY_STATUS"
fi

echo "Rollback verified: no finance_manual_adjustments table or manual-adjustment functions remain."
