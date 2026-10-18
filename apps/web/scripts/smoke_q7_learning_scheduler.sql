-- Smoke test for the Q7 daily learning scheduler. Rollback-only: nothing is
-- persisted. Run this after applying 20261102210000_q7_learning_scheduler_fix.sql.
begin;

do $$
declare
  v_pack jsonb;
  v_result jsonb;
  v_count integer;
  v_bare integer;
begin
  -- A2 pack examples.
  v_pack := public.q7_pack_from_name('Bột mì 888 Cam', 'g');
  if v_pack is not null then
    raise exception 'bare number must not become a pack, got %', v_pack;
  end if;

  v_pack := public.q7_pack_from_name('BỘT NGỌT VEYU 25KG F30', 'g');
  if v_pack is null or (v_pack ->> 'pack_size')::numeric <> 25000 then
    raise exception '25KG in g must be 25000, got %', v_pack;
  end if;

  v_pack := public.q7_pack_from_name('Muối 1kg x 10', 'g');
  if v_pack is null or (v_pack ->> 'pack_size')::numeric <> 10000 then
    raise exception '1kg x 10 in g must be 10000, got %', v_pack;
  end if;

  -- The scheduled wrapper must work without a JWT.
  v_result := public.run_q7_purchase_learning_scheduled();
  if coalesce(v_result ->> 'status', '') <> 'learned' then
    raise exception 'scheduled learning did not return learned: %', v_result;
  end if;
  if coalesce((v_result ->> 'items_updated')::integer, 0) <= 0 then
    raise exception 'scheduled learning updated no items: %', v_result;
  end if;

  select count(*) into v_bare
  from public.q7_purchase_item_settings
  where learned_pack_label ~ '^[[:space:]]*[0-9]+([.,][0-9]+)?[[:space:]]*$';
  if v_bare > 0 then
    raise exception '% learned_pack_label values are bare numbers', v_bare;
  end if;

  select count(*) into v_count
  from cron.job
  where jobname = 'q7-auto-purchase-learn-daily';
  if v_count <> 1 then
    raise exception 'expected exactly one q7-auto-purchase-learn-daily, got %', v_count;
  end if;

  select count(*) into v_count
  from cron.job
  where jobname = 'q7-auto-purchase-learn-daily'
    and schedule = '30 22 * * *';
  if v_count <> 1 then
    raise exception 'q7-auto-purchase-learn-daily schedule is not 30 22 * * *';
  end if;

  select count(*) into v_count
  from cron.job
  where jobname = 'q7-auto-purchase-learn-weekly';
  if v_count <> 0 then
    raise exception 'q7-auto-purchase-learn-weekly still exists (% rows)', v_count;
  end if;

  raise notice 'Q7 learning scheduler smoke passed: %', v_result;
end;
$$;

select jsonb_build_object(
  'pack_bare_number', public.q7_pack_from_name('Bột mì 888 Cam', 'g'),
  'pack_25kg', public.q7_pack_from_name('BỘT NGỌT VEYU 25KG F30', 'g'),
  'pack_multiplier', public.q7_pack_from_name('Muối 1kg x 10', 'g'),
  'learn_daily_jobs',
    (select count(*) from cron.job
     where jobname = 'q7-auto-purchase-learn-daily'
       and schedule = '30 22 * * *'),
  'learn_weekly_jobs',
    (select count(*) from cron.job
     where jobname = 'q7-auto-purchase-learn-weekly')
) as smoke_summary;

rollback;
