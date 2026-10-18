-- Smoke test for the Tân Tạo + Q7 daily warehouse learning (rollback-only).
--
-- Run only after applying 20261102240000_warehouse_learning_tan_tao.sql, in a
-- transaction that is rolled back. Nothing is persisted: the learner upserts are
-- rolled back together with the cron check. Do not run this against the live
-- database from the Harness; the Maestro applies and smoke-tests.
begin;

-- The cron job calls the wrapper without a JWT, so the smoke does the same.
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_result jsonb;
  v_count integer;
begin
  v_result := public.run_warehouse_learning_scheduled();

  if coalesce(v_result -> 'q7' ->> 'status', '') <> 'learned' then
    raise exception 'Q7 learning did not return learned: %', v_result -> 'q7';
  end if;

  if coalesce(v_result -> 'tan_tao' ->> 'status', '') <> 'learned' then
    raise exception 'Tân Tạo learning did not return learned: %', v_result -> 'tan_tao';
  end if;

  if coalesce(v_result -> 'tan_tao' ->> 'location', '') <> 'tan_tao' then
    raise exception 'Tân Tạo learning returned the wrong location: %', v_result -> 'tan_tao';
  end if;

  select count(*) into v_count
  from cron.job
  where jobname = 'warehouse-learn-daily'
    and schedule = '30 22 * * *';
  if v_count <> 1 then
    raise exception 'expected exactly one warehouse-learn-daily at 30 22 * * *, got %', v_count;
  end if;

  select count(*) into v_count
  from cron.job
  where jobname = 'q7-auto-purchase-learn-daily';
  if v_count <> 0 then
    raise exception 'q7-auto-purchase-learn-daily still exists (% rows)', v_count;
  end if;

  raise notice 'warehouse learning smoke passed: %', v_result;
end;
$$;

-- Learned Tân Tạo rows for the three reference items.
select w.location,
       kii.name,
       sup.name as supplier_name,
       w.learned_pack_size,
       w.learned_pack_label,
       w.learned_lead_time_days,
       w.learned_cycle_days,
       w.learned_order_qty,
       w.learned_daily_usage,
       w.receipt_days,
       w.last_receipt_date,
       w.learned_at
from public.warehouse_item_learning w
join public.kitchen_inventory_items kii on kii.id = w.kitchen_inventory_item_id
left join public.suppliers sup on sup.id = w.learned_supplier_id
where w.location = 'tan_tao'
  and (
    kii.name like 'Bánh mì que%'
    or kii.name like 'Chả lụa%'
    or kii.name like 'Túi bánh mì%'
  )
order by kii.name, kii.id;

-- Tân Tạo snapshot item for 'Bánh mì que%'.
select x.item ->> 'name' as name,
       (x.item ->> 'avg_qty')::numeric as avg_qty,
       (x.item ->> 'total_qty')::numeric as total_qty,
       (x.item ->> 'median_gap_days')::numeric as median_gap_days,
       x.item -> 'learned' as learned
from jsonb_array_elements(
  public.get_office_order_snapshot('tan_tao') -> 'items'
) x(item)
where x.item ->> 'name' like 'Bánh mì que%'
order by x.item ->> 'name';

-- Q7 snapshot item for 'Bột mì 888%'.
select x.item ->> 'name' as name,
       (x.item ->> 'avg_qty')::numeric as avg_qty,
       (x.item ->> 'total_qty')::numeric as total_qty,
       (x.item ->> 'median_gap_days')::numeric as median_gap_days,
       x.item -> 'learned' as learned
from jsonb_array_elements(
  public.get_office_order_snapshot('q7') -> 'items'
) x(item)
where x.item ->> 'name' like 'Bột mì 888%'
order by x.item ->> 'name';

rollback;
