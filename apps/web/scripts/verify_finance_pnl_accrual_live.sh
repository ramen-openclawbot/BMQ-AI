#!/usr/bin/env bash
# Rollback-only live verification for public.finance_pnl_accrual(date) and the
# manual-adjustment / net-profit extension.
#
# It concatenates:
#   begin;
#   <the existing accrual P&L migration>
#   <the manual-adjustment migration>
#   <the per-person payroll migration>
#   <body-only finance_pnl_accrual_dryrun.sql>
#   rollback;
# into one temporary SQL file and runs it through the linked Supabase project.
# The migrations are therefore created only inside a transaction that is always
# rolled back. After the rollback it asserts that the new tables and functions
# are gone and that the live finance_pnl_accrual definition is byte-identical.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_OLD="$ROOT/supabase/migrations/20261119085657_finance_pnl_accrual.sql"
MIGRATION_NEW="$ROOT/supabase/migrations/20261120180758_finance_net_profit_adjustments.sql"
MIGRATION_PAYROLL="$ROOT/supabase/migrations/20261125120000_finance_pnl_payroll_per_person.sql"
CHECK="$ROOT/supabase/tests/finance_pnl_accrual_dryrun.sql"
PROJECT_REF="cxntbdvfsikwmitapony"

for file in "$MIGRATION_OLD" "$MIGRATION_NEW" "$MIGRATION_PAYROLL" "$CHECK"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: missing $file" >&2
    exit 1
  fi
done

# The migrations and the check must never carry their own transaction control.
for migration in "$MIGRATION_OLD" "$MIGRATION_NEW" "$MIGRATION_PAYROLL"; do
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
  cat <<'SQL'
do $$
declare
  v_owner uuid;
begin
  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;

  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user_roles row for the baseline';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;

-- Make the BHXH row exist before the baseline so the old and new functions are
-- compared on identical data, including on a database where it was not entered.
do $$
declare
  v_existing uuid;
  v_saved jsonb;
begin
  select a.id
  into v_existing
  from public.finance_manual_adjustments a
  where a.kind = 'opex'
    and a.category_code = 'C7_SOCIAL_INSURANCE'
    and a.period_from = '2026-04-01'
    and a.period_to = '2026-10-01'
    and a.status = 'active'
  order by a.created_at
  limit 1;

  if v_existing is null then
    v_saved := public.finance_manual_adjustment_save(
      p_id => null,
      p_kind => 'opex',
      p_category_code => 'C7_SOCIAL_INSURANCE',
      p_label => 'BHXH T4–T10/2026 (dry run)',
      p_period_from => '2026-04-01',
      p_period_to => '2026-10-01',
      p_total_amount => 96955830,
      p_source_ref => 'DRYRUN-BHXH-2026',
      p_note => 'Rollback-only dry run adjustment'
    );

    if v_saved is null or (v_saved->>'id') is null then
      raise exception 'CHECK FAIL: finance_manual_adjustment_save did not return an id';
    end if;
  end if;
end $$;

create temp table _finance_pnl_baseline as
select public.finance_pnl_accrual('2026-10-01') as pnl;
SQL
  cat "$MIGRATION_OLD"
  printf '\n'
  cat "$MIGRATION_NEW"
  printf '\n'
  cat "$MIGRATION_PAYROLL"
  printf '\n'
  cat "$CHECK"
  cat <<'SQL'

-- The replacement may change payroll lines and anything derived from them, but
-- every revenue and non-payroll expense line must stay byte-identical on the
-- real October data.
do $$
declare
  v_old jsonb;
  v_new jsonb;
  v_old_nonpayroll jsonb;
  v_new_nonpayroll jsonb;
  v_old_payroll numeric;
  v_new_payroll numeric;
  v_key text;
begin
  select pnl into v_old from _finance_pnl_baseline;
  v_new := public.finance_pnl_accrual('2026-10-01');

  select coalesce(jsonb_agg(x order by x::text), '[]'::jsonb)
  into v_old_nonpayroll
  from jsonb_array_elements(v_old->'lines') x
  where x->>'line_code' <> 'C6_PAYROLL';

  select coalesce(jsonb_agg(x order by x::text), '[]'::jsonb)
  into v_new_nonpayroll
  from jsonb_array_elements(v_new->'lines') x
  where x->>'line_code' <> 'C6_PAYROLL';

  if v_old_nonpayroll <> v_new_nonpayroll then
    raise exception 'CHECK FAIL: non-payroll P&L lines changed';
  end if;

  foreach v_key in array array[
    'revenue', 'cogs', 'gross_profit', 'selling', 'unclassified', 'capex',
    'depreciation', 'interest', 'other_below_ebitda'
  ] loop
    if coalesce((v_old->'totals'->>v_key)::numeric, 0)
       <> coalesce((v_new->'totals'->>v_key)::numeric, 0) then
      raise exception 'CHECK FAIL: non-payroll total % changed from % to %',
        v_key, v_old->'totals'->>v_key, v_new->'totals'->>v_key;
    end if;
  end loop;

  select coalesce(sum((x->>'amount')::numeric), 0)
  into v_old_payroll
  from jsonb_array_elements(v_old->'lines') x
  where x->>'line_code' = 'C6_PAYROLL';

  select coalesce(sum((x->>'amount')::numeric), 0)
  into v_new_payroll
  from jsonb_array_elements(v_new->'lines') x
  where x->>'line_code' = 'C6_PAYROLL';

  if coalesce((v_old->'totals'->>'operating')::numeric, 0) - v_old_payroll
     <> coalesce((v_new->'totals'->>'operating')::numeric, 0) - v_new_payroll then
    raise exception 'CHECK FAIL: operating expense excluding payroll changed from % to %',
      coalesce((v_old->'totals'->>'operating')::numeric, 0) - v_old_payroll,
      coalesce((v_new->'totals'->>'operating')::numeric, 0) - v_new_payroll;
  end if;
end $$;
SQL
  printf '\n%s\n' 'rollback;'
} > "$TMP_FILE"

cd "$ROOT"

database_state() {
  DO_NOT_TRACK=1 supabase db query \
    --linked \
    --project-ref "$PROJECT_REF" \
    --output-format json \
    "select md5(pg_get_functiondef('public.finance_pnl_accrual(date)'::regprocedure)) as pnl_hash,
            coalesce(md5(pg_get_functiondef(to_regprocedure(
              'public.finance_manual_adjustment_save(uuid,text,text,text,date,date,numeric,text,text)'
            ))), '') as manual_save_hash,
            coalesce(md5(pg_get_functiondef(to_regprocedure(
              'public.finance_manual_adjustment_void(uuid)'
            ))), '') as manual_void_hash,
            coalesce(md5(pg_get_functiondef(to_regprocedure(
              'public.finance_manual_adjustment_month_lines(date)'
            ))), '') as manual_month_hash,
            coalesce(md5(pg_get_functiondef(to_regprocedure(
              'public.finance_can_view_self()'
            ))), '') as manual_view_hash,
            coalesce(md5(pg_get_functiondef(to_regprocedure(
              'public.finance_pnl_accrual_person_key(text)'
            ))), '') as person_key_hash,
            coalesce(md5(pg_get_functiondef(to_regprocedure(
              'public.finance_pnl_accrual_payout_month(text,timestamptz,timestamptz,timestamptz)'
            ))), '') as payout_month_hash,
            coalesce(to_regclass('public.finance_manual_adjustments')::text, '') as manual_table,
            coalesce(to_regclass('public.finance_payroll_carry_exclusions')::text, '') as exclusion_table,
            (select count(*) from public.finance_manual_adjustments) as manual_rows" \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); print(json.dumps(data[0], sort_keys=True))'
}

STATE_BEFORE="$(database_state)"

echo "Running rollback-only accrual P&L / net-profit / payroll verification on project $PROJECT_REF..."
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

echo "Rollback verified: no new table/rows remain; finance_pnl_accrual and its payroll/manual helpers are unchanged."
