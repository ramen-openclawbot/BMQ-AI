#!/usr/bin/env bash
# Rollback-only live verification for the delivery tasks (Giao hàng) migration.
#
# Concatenates:
#   begin;
#   <the delivery_tasks migration>
#   <body-only supabase/tests/delivery_tasks_dryrun.sql>
#   rollback;
# into one temporary SQL file and runs it through the linked Supabase project.
# Every object is created inside a transaction that is always rolled back. After
# the rollback it asserts that no new table/column/cron/bucket remains, that
# mini_crm_customers is byte-identical and that the payroll-month opener still
# has its live definition.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261125170000_delivery_tasks.sql"
MIGRATION_NOTE="$ROOT/supabase/migrations/20261127120000_delivery_task_driver_note.sql"
CHECK="$ROOT/supabase/tests/delivery_tasks_dryrun.sql"
PROJECT_REF="cxntbdvfsikwmitapony"

for file in "$MIGRATION" "$MIGRATION_NOTE" "$CHECK"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: missing $file" >&2
    exit 1
  fi
done

if grep -Eq '^[[:space:]]*(begin|commit|rollback)[[:space:]]*;' "$MIGRATION"; then
  echo "ERROR: migration $MIGRATION must not contain BEGIN/COMMIT/ROLLBACK" >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*(begin|commit|rollback)[[:space:]]*;' "$CHECK"; then
  echo "ERROR: check file must not contain BEGIN/COMMIT/ROLLBACK" >&2
  exit 1
fi

TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/delivery_tasks.XXXXXX.sql")"
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

{
  printf '%s\n' 'begin;'
  cat "$MIGRATION"
  echo
  cat "$MIGRATION_NOTE"
  printf '\n'
  cat "$CHECK"
  printf '\n%s\n' 'rollback;'
} > "$TMP_FILE"

cd "$ROOT"

state_query=$(cat <<'SQL'
select
  coalesce(to_regclass('public.delivery_driver_settings')::text, '') as driver_settings_table,
  coalesce(to_regclass('public.delivery_driver_setting_history')::text, '') as setting_history_table,
  coalesce(to_regclass('public.delivery_destination_assignments')::text, '') as assignments_table,
  coalesce(to_regclass('public.delivery_tasks')::text, '') as tasks_table,
  coalesce(to_regclass('public.payroll_bn_delivery_extras')::text, '') as extras_table,
  (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payroll_bn_period_employees'
      and column_name = 'delivery_unit_base'
  ) as delivery_unit_base_column,
  coalesce(md5(pg_get_functiondef(
    'public.payroll_bn_open_period_internal(date,uuid)'::regprocedure
  )), '') as open_period_internal_hash,
  coalesce(md5(pg_get_functiondef(
    'public.payroll_bn_open_period(date)'::regprocedure
  )), '') as open_period_hash,
  (
    select count(*)
    from cron.job
    where jobname in (
      'delivery-tasks-generate-daily',
      'delivery-tasks-refresh',
      'delivery-proofs-retention-daily'
    )
  ) as delivery_cron_jobs,
  coalesce((select id from storage.buckets where id = 'delivery-proofs'), '') as proof_bucket,
  (
    select count(*)
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'delivery_proofs_select'
  ) as proof_policy,
  (
    select count(*)
    from pg_proc
    where proname in (
      'generate_delivery_tasks',
      'upsert_delivery_assignment',
      'upsert_delivery_driver_setting',
      'list_delivery_tasks',
      'list_delivery_assignments',
      'delivery_units_by_day',
      'reopen_delivery_task',
      'complete_delivery_task',
      'payroll_bn_guard_delivery_extra',
      'payroll_bn_is_delivery_employee',
      'payroll_bn_set_delivery_extra_author'
    )
  ) as delivery_functions,
  (select count(*) from public.mini_crm_customers) as customer_count,
  coalesce((
    select md5(string_agg(md5(c::text), '' order by c.id))
    from public.mini_crm_customers c
  ), '') as customer_hash
SQL
)

database_state() {
  DO_NOT_TRACK=1 supabase db query \
    --linked \
    --project-ref "$PROJECT_REF" \
    --output-format json \
    "$state_query" \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); print(json.dumps(data[0], sort_keys=True))'
}

STATE_BEFORE="$(database_state)"

echo "Running rollback-only delivery tasks verification on project $PROJECT_REF..."
set +e
DO_NOT_TRACK=1 supabase db query \
  --linked \
  --project-ref "$PROJECT_REF" \
  -f "$TMP_FILE"
QUERY_STATUS=$?
set -e

STATE_AFTER="$(database_state)"

if [[ "$STATE_BEFORE" != "$STATE_AFTER" ]]; then
  echo "ERROR: database objects or rows changed after rollback" >&2
  echo "before: $STATE_BEFORE" >&2
  echo "after:  $STATE_AFTER" >&2
  exit 1
fi

if [[ "$QUERY_STATUS" -ne 0 ]]; then
  echo "ERROR: rollback-only verification failed (exit $QUERY_STATUS); no changes remain." >&2
  exit "$QUERY_STATUS"
fi

echo "Rollback verified: no delivery table/column/cron/bucket/policy remains; mini_crm_customers and payroll_bn_open_period_internal are unchanged."
