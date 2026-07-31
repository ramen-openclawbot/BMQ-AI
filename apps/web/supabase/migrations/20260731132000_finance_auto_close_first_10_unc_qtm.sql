-- User-approved first enforced batch under the corrected UNC/QTM-only contract.
-- Process unlocked declarations chronologically and stop at the first blocker or missing Drive snapshot.

insert into public.app_settings (key, value, updated_at)
values ('finance_auto_close_enabled', 'true', now())
on conflict (key) do update
set value = excluded.value,
    updated_at = excluded.updated_at;

do $$
declare
  v_day record;
  v_snapshot jsonb;
  v_result jsonb;
  v_processed integer := 0;
begin
  for v_day in
    select distinct d.closing_date
    from public.ceo_daily_closing_declarations d
    where coalesce(d.extraction_meta->>'close_approval_locked', 'false') <> 'true'
      and d.closing_date < (now() at time zone 'Asia/Ho_Chi_Minh')::date
    order by d.closing_date asc
  loop
    exit when v_processed >= 10;

    select r.snapshot
    into v_snapshot
    from public.finance_daily_close_runs r
    where r.closing_date = v_day.closing_date
      and r.snapshot <> '{}'::jsonb
    order by r.created_at desc
    limit 1;

    if v_snapshot is null then
      raise notice 'FINANCE_UNC_QTM_ENFORCED date=% result=no_snapshot stop=true', v_day.closing_date;
      exit;
    end if;

    -- Legacy declaration decision flags are informational only. The corrected
    -- contract is gated exclusively by Drive/OCR evidence and QTM chronology.
    select jsonb_set(
      v_snapshot,
      '{blockers}',
      coalesce(
        (
          select jsonb_agg(blocker)
          from jsonb_array_elements(coalesce(v_snapshot->'blockers', '[]'::jsonb)) as blocker
          where blocker->>'code' <> 'existing_declaration_reconciliation_mismatch'
        ),
        '[]'::jsonb
      ),
      true
    )
    into v_snapshot;

    v_result := public.finance_auto_close_day(
      v_day.closing_date,
      'enforced',
      v_snapshot,
      'system_finance_cron'
    );

    raise notice 'FINANCE_UNC_QTM_ENFORCED date=% result=%', v_day.closing_date, v_result;

    if coalesce((v_result->>'ok')::boolean, false) is not true then
      exit;
    end if;

    v_processed := v_processed + 1;
  end loop;
end
$$;
