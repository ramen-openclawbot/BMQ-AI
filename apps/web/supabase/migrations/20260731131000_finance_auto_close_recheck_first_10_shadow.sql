-- One-time post-correction shadow recheck for the first 10 unlocked declarations.
-- Reuses the latest Drive evidence snapshot captured by the Edge function; shadow mode cannot close or mutate declarations.

do $$
declare
  v_day record;
  v_snapshot jsonb;
  v_result jsonb;
begin
  for v_day in
    select distinct d.closing_date
    from public.ceo_daily_closing_declarations d
    where coalesce(d.extraction_meta->>'close_approval_locked', 'false') <> 'true'
      and d.closing_date < (now() at time zone 'Asia/Ho_Chi_Minh')::date
    order by d.closing_date asc
    limit 10
  loop
    select r.snapshot
    into v_snapshot
    from public.finance_daily_close_runs r
    where r.closing_date = v_day.closing_date
      and r.snapshot <> '{}'::jsonb
    order by r.created_at desc
    limit 1;

    if v_snapshot is null then
      raise notice 'FINANCE_UNC_QTM_SHADOW date=% result=no_snapshot', v_day.closing_date;
      continue;
    end if;

    v_result := public.finance_auto_close_day(
      v_day.closing_date,
      'shadow',
      v_snapshot,
      'migration_20260731131000'
    );

    raise notice 'FINANCE_UNC_QTM_SHADOW date=% result=%', v_day.closing_date, v_result;
  end loop;
end
$$;
