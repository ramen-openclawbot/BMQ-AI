-- Read-only smoke test for the purchase-pattern reconciliation flags.
-- Rollback-only: nothing is persisted. Run after applying
-- 20261102220000_purchase_pattern_flags.sql.
begin;

-- The pattern rows need the payment_requests read permission; run as service role.
select set_config('request.jwt.claim.role', 'service_role', true);

select label, count(*) as flag_count
from public.finance_reconciliation_flags
group by label
order by label;

do $$
declare
  v_duplicates integer;
begin
  select count(*) into v_duplicates
  from (
    select flag_key
    from public.finance_reconciliation_flags
    group by flag_key
    having count(*) > 1
  ) d;

  if v_duplicates > 0 then
    raise exception 'finance_reconciliation_flags has % duplicate flag_key values', v_duplicates;
  end if;

  raise notice 'flag_key is unique across finance_reconciliation_flags';
end;
$$;

explain (analyze, buffers)
select count(*) from public.finance_reconciliation_flags;

rollback;
