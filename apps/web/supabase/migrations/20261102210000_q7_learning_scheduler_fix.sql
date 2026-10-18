-- Q7 purchase-parameter learning: daily scheduler wrapper + pack parsing fix.
--
-- The old weekly cron job passed no JWT, so learn_q7_purchase_parameters()
-- raised actor_required in production. The wrapper below sets the service-role
-- claim exactly like run_q7_auto_purchase() already does, and the job is moved
-- to 22:30 UTC (05:30 Asia/Ho_Chi_Minh), 30 minutes before the existing 06:00
-- auto-purchase run.
--
-- q7_pack_from_name now requires a real unit token after the number, so a bare
-- number in a product name is never mistaken for a pack size. When the name
-- states no pack, nothing is learned for it (no fallback from order sizes), and
-- learned lead times ignore receipts more than 30 days after their PO.

-- ---------------------------------------------------------------------------
-- 1. Scheduler-safe entry point (same service-role technique as the daily run).
-- ---------------------------------------------------------------------------
create or replace function public.run_q7_purchase_learning_scheduled()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  return public.learn_q7_purchase_parameters();
end;
$$;

revoke all on function public.run_q7_purchase_learning_scheduled() from public, anon, authenticated;
grant execute on function public.run_q7_purchase_learning_scheduled() to service_role;

-- ---------------------------------------------------------------------------
-- 2. Pack parsing: only a number followed by a known unit token is a pack.
-- ---------------------------------------------------------------------------
create or replace function public.q7_pack_from_name(p_name text, p_book_unit text)
returns jsonb
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $$
declare
  v_match text[];
  v_text text := lower(coalesce(p_name, ''));
  v_book text := lower(btrim(coalesce(p_book_unit, '')));
  v_base numeric;
  v_unit text;
  v_mult integer;
  v_factor numeric;
  v_size numeric;
begin
  for v_match in
    select regexp_matches(
      v_text,
      '([0-9]+([.,][0-9]+)?)[[:space:]]*(kg|g|gr|gram|l|lit|ml|chai|thùng|thung|hộp|hop|gói|goi|bao|can|bịch|bich|cái|cai|vỉ|vi)(?![[:alpha:]])[[:space:]]*(x[[:space:]]*([0-9]+))?',
      'g'
    )
  loop
    v_base := nullif(replace(v_match[1], ',', '.'), '')::numeric;
    v_unit := v_match[3];
    v_mult := coalesce(nullif(v_match[5], '')::integer, 1);
    if v_base is not null and v_base > 0 then
      exit;
    end if;
  end loop;

  if v_base is null or v_base <= 0 then
    return null;
  end if;

  if v_unit is null or v_book = '' then
    v_factor := 1;
  elsif v_unit in ('kg', 'g', 'gr', 'gram') and v_book in ('kg', 'g', 'gr', 'gram') then
    v_factor := (case when v_unit = 'kg' then 1000 else 1 end)::numeric
      / (case when v_book = 'kg' then 1000 else 1 end)::numeric;
  elsif v_unit in ('l', 'lit', 'ml') and v_book in ('l', 'lit', 'ml') then
    v_factor := (case when v_unit in ('l', 'lit') then 1000 else 1 end)::numeric
      / (case when v_book in ('l', 'lit') then 1000 else 1 end)::numeric;
  elsif v_unit = v_book then
    v_factor := 1;
  else
    return null;
  end if;

  v_size := round(v_base * v_factor * v_mult, 6);
  if v_size <= 0 then
    return null;
  end if;

  return jsonb_build_object(
    'pack_size', v_size,
    'pack_label', v_match[1] || coalesce(v_unit, '')
      || case when v_match[5] is not null then ' x ' || v_match[5] else '' end,
    'base_qty', v_base,
    'base_unit', v_unit,
    'multiplier', v_mult
  );
end;
$$;

revoke all on function public.q7_pack_from_name(text, text) from public, anon;
grant execute on function public.q7_pack_from_name(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Learning: pack size only from the name, lead time capped at 30 days.
-- ---------------------------------------------------------------------------
create or replace function public.learn_q7_purchase_parameters()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item record;
  v_usage record;
  v_supplier uuid;
  v_pack jsonb;
  v_pack_size numeric;
  v_pack_label text;
  v_lead numeric;
  v_safety numeric;
  v_backtest numeric;
  v_daily numeric;
  v_stddev numeric;
  v_updated integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  for v_item in
    select kii.id, kii.name, kii.unit
    from public.kitchen_inventory_items kii
    where kii.active = true
      and exists (
        select 1
        from public.production_material_issues i
        join public.production_material_issue_items ii on ii.material_issue_id = i.id
        where ii.kitchen_inventory_item_id = kii.id
          and i.location_code = 'q7'
          and i.is_current is true
      )
    order by kii.name, kii.id
  loop
    select * into v_usage from public.q7_purchase_daily_usage(v_item.id, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
    v_daily := round(0.6 * coalesce(v_usage.avg_14d, 0) + 0.4 * coalesce(v_usage.avg_28d, 0), 3);
    v_stddev := coalesce(v_usage.stddev_28d, 0);

    -- Supplier with the largest purchased book quantity in the last 90 days,
    -- from PO lines or payment-request lines mapped through the aliases.
    select x.supplier_id into v_supplier
    from (
      select po.supplier_id, sum(poi.quantity * a.conversion_factor) as qty
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      cross join lateral (
        select a.* from public.stock_material_aliases a
        where a.location = 'q7'
          and a.kitchen_inventory_item_id = v_item.id
          and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
          and (a.supplier_id = po.supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a
      where po.supplier_id is not null
        and po.order_date >= current_date - 90
      group by po.supplier_id
      union all
      select pr.supplier_id, sum(pri.quantity * a.conversion_factor) as qty
      from public.payment_request_items pri
      join public.payment_requests pr on pr.id = pri.payment_request_id
      cross join lateral (
        select a.* from public.stock_material_aliases a
        where a.location = 'q7'
          and a.kitchen_inventory_item_id = v_item.id
          and a.normalized_name = public.normalize_stock_item_name(pri.product_name)
          and (a.supplier_id = pr.supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a
      where pr.supplier_id is not null
        and pr.created_at >= now() - interval '90 days'
      group by pr.supplier_id
    ) x
    group by x.supplier_id
    order by sum(x.qty) desc
    limit 1;

    -- Package spec only from the item name. The old fallback (most frequent
    -- ordered quantity) learned order lots, not packs: 6,250 kg for Bột mì and
    -- 25 g for Chà bông in a rollback run on 19/10. Without a pack the forecast
    -- does not round; staff can still set pack_size by hand.
    v_pack := public.q7_pack_from_name(v_item.name, v_item.unit);
    if v_pack is not null then
      v_pack_size := (v_pack ->> 'pack_size')::numeric;
      v_pack_label := v_pack ->> 'pack_label';
    else
      v_pack_size := null;
      v_pack_label := null;
    end if;

    -- Lead time ignores receipts more than 30 days after the PO (a 550-day
    -- median came from mis-dated POs); without data the forecast uses 2 days.
    v_lead := null;
    if v_supplier is not null then
      select percentile_cont(0.5) within group (order by (gr.receipt_date - po.order_date))
      into v_lead
      from public.purchase_orders po
      join public.goods_receipts gr on gr.purchase_order_id = po.id
      where po.supplier_id = v_supplier
        and gr.receipt_date is not null
        and gr.receipt_date >= po.order_date
        and gr.receipt_date <= po.order_date + 30
        and gr.receipt_date >= current_date - 120;
      v_lead := round(coalesce(v_lead, 2));
    end if;

    if v_daily > 0 then
      v_safety := least(round(greatest(1, 1.65 * v_stddev * sqrt(coalesce(v_lead, 2)) / v_daily), 1), 7);
    else
      v_safety := null;
    end if;

    v_backtest := public.q7_backtest_relative_error(v_item.id, (now() at time zone 'Asia/Ho_Chi_Minh')::date);

    insert into public.q7_purchase_item_settings as s (
      kitchen_inventory_item_id, mode, learned_supplier_id, learned_pack_size,
      learned_pack_label, learned_lead_time_days, learned_safety_days,
      learned_backtest_error, learned_at
    ) values (
      v_item.id, 'suggest', v_supplier, v_pack_size,
      v_pack_label, v_lead, v_safety,
      v_backtest, now()
    )
    on conflict (kitchen_inventory_item_id) do update set
      learned_supplier_id = excluded.learned_supplier_id,
      learned_pack_size = excluded.learned_pack_size,
      learned_pack_label = excluded.learned_pack_label,
      learned_lead_time_days = excluded.learned_lead_time_days,
      learned_safety_days = excluded.learned_safety_days,
      learned_backtest_error = excluded.learned_backtest_error,
      learned_at = excluded.learned_at,
      updated_at = now();

    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object('status', 'learned', 'items_updated', v_updated);
end;
$$;

revoke all on function public.learn_q7_purchase_parameters() from public, anon;
grant execute on function public.learn_q7_purchase_parameters() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Schedule: replace the weekly learning run with a daily one at 05:30 VN.
-- ---------------------------------------------------------------------------
do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'q7-auto-purchase-learn-weekly'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;
  for existing_job_id in
    select jobid from cron.job where jobname = 'q7-auto-purchase-learn-daily'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'q7-auto-purchase-learn-daily',
    '30 22 * * *',
    $job$ select public.run_q7_purchase_learning_scheduled(); $job$
  );
end;
$$;
