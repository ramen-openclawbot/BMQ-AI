-- Q7 purchase forecast without per-item alias lookups.
--
-- Replaces public.get_q7_purchase_forecast (20261014100000) with the same
-- signature, JSON shape/order, SECURITY DEFINER, search_path and grants.
-- Open-PO quantities and latest book-unit prices are now derived once before
-- the item loop from two maps keyed by kitchen_inventory_item_id. Product-name
-- normalization happens once per PO/PR row inside a materialized CTE instead of
-- once per item (a lateral scan over every PO line).

create or replace function public.get_q7_purchase_forecast(
  p_as_of date default null,
  p_horizon_days integer default 14
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_horizon integer := greatest(1, least(coalesce(p_horizon_days, 14), 90));
  v_cutover date;
  v_settings public.q7_auto_purchase_settings%rowtype;
  v_item record;
  v_setting public.q7_purchase_item_settings%rowtype;
  v_usage record;
  v_items jsonb := '[]'::jsonb;
  v_daily numeric;
  v_scheduled_map jsonb := '{}'::jsonb;
  v_scheduled_total numeric := 0;
  v_open_po_map jsonb := '{}'::jsonb;
  v_price_map jsonb := '{}'::jsonb;
  v_on_hand numeric;
  v_last_count date;
  v_open_po numeric := 0;
  v_supplier uuid;
  v_pack_size numeric;
  v_pack_label text;
  v_lead integer;
  v_safety numeric;
  v_cycle integer;
  v_mode text;
  v_max_order numeric;
  v_reorder date;
  v_projected numeric;
  v_threshold numeric;
  v_use numeric;
  v_day date;
  v_offset integer;
  v_need numeric;
  v_raw numeric;
  v_suggested numeric;
  v_price numeric;
  v_amount numeric;
  v_no_stock boolean;
  v_stale boolean;
  v_short boolean;
  v_no_supplier boolean;
  v_no_pack boolean;
  v_no_price boolean;
  v_duplicate boolean;
  v_high_backtest boolean;
  v_flags jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_cutover := public.stock_ledger_cutover_date('q7');
  select * into v_settings from public.q7_auto_purchase_settings where id = 1;

  -- Open PO quantities and latest prices, keyed by kitchen_inventory_item_id.
  -- Normalize each PO/PR product name exactly once, then choose the same alias
  -- the per-item lateral used to choose (supplier-specific first, then created_at, id).
  with po_lines as materialized (
    select
      poi.id as line_id,
      poi.quantity,
      poi.unit_price,
      poi.created_at as line_created_at,
      po.id as po_id,
      po.supplier_id,
      po.status,
      po.order_date,
      public.normalize_stock_item_name(poi.product_name) as normalized_name
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
  ),
  po_matches as materialized (
    select distinct on (pl.line_id, a.kitchen_inventory_item_id)
      pl.line_id,
      pl.quantity,
      pl.unit_price,
      pl.line_created_at,
      pl.po_id,
      pl.status,
      pl.order_date,
      a.kitchen_inventory_item_id,
      a.conversion_factor,
      (a.supplier_id is not null) as alias_supplier_specific,
      a.created_at as alias_created_at,
      a.id as alias_id
    from po_lines pl
    join public.stock_material_aliases a
      on a.location = 'q7'
     and a.kitchen_inventory_item_id is not null
     and a.normalized_name = pl.normalized_name
     and (a.supplier_id = pl.supplier_id or a.supplier_id is null)
    order by pl.line_id, a.kitchen_inventory_item_id,
             (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  po_qty as (
    select m.kitchen_inventory_item_id,
           sum(m.quantity * m.conversion_factor) as qty
    from po_matches m
    where m.status in ('draft', 'sent', 'in_transit')
      and not exists (
        select 1 from public.goods_receipts gr
        where gr.purchase_order_id = m.po_id
          and gr.status in ('confirmed', 'received')
      )
    group by m.kitchen_inventory_item_id
  ),
  po_price as (
    select distinct on (m.kitchen_inventory_item_id)
      m.kitchen_inventory_item_id,
      round(m.unit_price / greatest(m.conversion_factor, 0.00000001), 2) as price
    from po_matches m
    where m.unit_price is not null and m.unit_price > 0
    order by m.kitchen_inventory_item_id, m.order_date desc, m.line_created_at desc
  ),
  pr_lines as materialized (
    select
      pri.id as line_id,
      pri.unit_price,
      pr.created_at as pr_created_at,
      pr.supplier_id,
      public.normalize_stock_item_name(pri.product_name) as normalized_name
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
  ),
  pr_matches as materialized (
    select distinct on (pl.line_id, a.kitchen_inventory_item_id)
      pl.line_id,
      pl.unit_price,
      pl.pr_created_at,
      a.kitchen_inventory_item_id,
      a.conversion_factor,
      (a.supplier_id is not null) as alias_supplier_specific,
      a.created_at as alias_created_at,
      a.id as alias_id
    from pr_lines pl
    join public.stock_material_aliases a
      on a.location = 'q7'
     and a.kitchen_inventory_item_id is not null
     and a.normalized_name = pl.normalized_name
     and (a.supplier_id = pl.supplier_id or a.supplier_id is null)
    order by pl.line_id, a.kitchen_inventory_item_id,
             (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  pr_price as (
    select distinct on (m.kitchen_inventory_item_id)
      m.kitchen_inventory_item_id,
      round(m.unit_price / greatest(m.conversion_factor, 0.00000001), 2) as price
    from pr_matches m
    where m.unit_price is not null and m.unit_price > 0
    order by m.kitchen_inventory_item_id, m.pr_created_at desc
  )
  select
    coalesce((
      select jsonb_object_agg(q.kitchen_inventory_item_id::text, q.qty)
      from po_qty q
    ), '{}'::jsonb),
    coalesce((
      select jsonb_object_agg(p.kitchen_inventory_item_id::text, p.price)
      from pr_price p
    ), '{}'::jsonb)
    || coalesce((
      select jsonb_object_agg(p.kitchen_inventory_item_id::text, p.price)
      from po_price p
    ), '{}'::jsonb)
  into v_open_po_map, v_price_map;

  for v_item in
    select kii.id, kii.item_code, kii.name, kii.unit, kii.normalized_key
    from public.kitchen_inventory_items kii
    where kii.active = true
      and (
        exists (
          select 1 from public.q7_material_issue_material_mappings m
          where m.kitchen_inventory_item_id = kii.id and m.approval_status = 'approved'
        )
        or exists (
          select 1 from public.q7_purchase_item_settings s
          where s.kitchen_inventory_item_id = kii.id
        )
        or exists (
          select 1 from public.q7_inventory_movements mv
          where mv.kitchen_inventory_item_id = kii.id
        )
      )
    order by kii.name, kii.id
  loop
    select * into v_setting
    from public.q7_purchase_item_settings s
    where s.kitchen_inventory_item_id = v_item.id;

    v_mode := coalesce(v_setting.mode, 'suggest');
    v_supplier := coalesce(v_setting.supplier_id, v_setting.learned_supplier_id);
    v_pack_size := coalesce(v_setting.pack_size, v_setting.learned_pack_size);
    v_pack_label := coalesce(v_setting.pack_label, v_setting.learned_pack_label);
    v_lead := coalesce(v_setting.lead_time_days, v_setting.learned_lead_time_days, 2);
    v_safety := coalesce(v_setting.safety_days, v_setting.learned_safety_days, 2);
    v_cycle := coalesce(v_setting.order_cycle_days, 7);
    v_max_order := v_setting.max_order_qty;

    select * into v_usage from public.q7_purchase_daily_usage(v_item.id, v_as_of);
    v_daily := round(0.6 * coalesce(v_usage.avg_14d, 0) + 0.4 * coalesce(v_usage.avg_28d, 0), 3);

    -- Scheduled issues after the run day replace the baseline average on those days.
    select
      coalesce(jsonb_object_agg(mv.day_key, mv.qty), '{}'::jsonb),
      coalesce(sum(mv.qty), 0)
    into v_scheduled_map, v_scheduled_total
    from (
      select i.issue_date as d, to_char(i.issue_date, 'YYYY-MM-DD') as day_key,
             sum(coalesce(ii.required_qty, 0)) as qty
      from public.production_material_issues i
      join public.production_material_issue_items ii on ii.material_issue_id = i.id
      where ii.kitchen_inventory_item_id = v_item.id
        and i.location_code = 'q7'
        and i.is_current is true
        and i.issue_date > v_as_of
        and i.issue_date <= v_as_of + v_horizon
      group by i.issue_date
    ) mv;

    v_on_hand := null;
    if v_cutover is not null then
      select s.balance_qty into v_on_hand
      from public.get_q7_inventory_snapshot(v_as_of) s
      where s.kitchen_inventory_item_id = v_item.id;
    end if;

    select max(m.movement_date) into v_last_count
    from public.q7_inventory_movements m
    where m.kitchen_inventory_item_id = v_item.id
      and m.source = 'manual_adjustment'
      and m.source_ref_key like 'q7-stock-count:%'
      and m.movement_date <= v_as_of;

    v_open_po := coalesce((v_open_po_map ->> v_item.id::text)::numeric, 0);

    -- Reorder date: walk the horizon and shift back by the lead time on breach.
    v_reorder := null;
    if v_on_hand is null then
      v_reorder := v_as_of;
    elsif v_daily > 0 then
      v_projected := v_on_hand;
      v_threshold := v_daily * v_safety;
      v_offset := 1;
      while v_offset <= v_horizon loop
        v_day := v_as_of + v_offset;
        v_use := coalesce((v_scheduled_map ->> to_char(v_day, 'YYYY-MM-DD'))::numeric, v_daily);
        v_projected := v_projected - v_use;
        if v_projected < v_threshold then
          v_reorder := v_day - v_lead;
          exit;
        end if;
        v_offset := v_offset + 1;
      end loop;
    end if;

    v_need := v_daily * (v_lead + v_safety + v_cycle);
    v_raw := greatest(0, v_need - coalesce(v_on_hand, 0) - v_open_po);
    if v_pack_size is not null and v_pack_size > 0 then
      v_suggested := ceil(v_raw / v_pack_size) * v_pack_size;
    else
      v_suggested := ceil(v_raw);
    end if;
    if v_max_order is not null and v_max_order > 0 then
      v_suggested := least(v_suggested, v_max_order);
    end if;
    v_suggested := round(coalesce(v_suggested, 0), 3);

    -- Latest price per book unit, from a PO line or a payment-request line.
    v_price := (v_price_map ->> v_item.id::text)::numeric;

    v_amount := case when v_price is not null then round(v_suggested * v_price, 2) else null end;

    v_no_stock := v_on_hand is null or v_last_count is null;
    v_stale := v_last_count is not null
      and (v_as_of - v_last_count) > coalesce(v_settings.max_stock_count_age_days, 10);
    v_short := coalesce(v_usage.days_with_data, 0) < 28;
    v_no_supplier := v_supplier is null;
    v_no_pack := v_pack_size is null or v_pack_size <= 0;
    v_no_price := v_price is null;
    v_duplicate := exists (
      select 1 from public.kitchen_inventory_items k2
      where k2.active = true
        and k2.id <> v_item.id
        and k2.normalized_key = v_item.normalized_key
    );
    v_high_backtest := v_setting.learned_backtest_error is not null
      and v_setting.learned_backtest_error > coalesce(v_settings.max_backtest_error, 0.25);

    v_flags := jsonb_build_object(
      'no_stock_count', v_no_stock,
      'stale_stock_count', v_stale,
      'short_history', v_short,
      'no_supplier', v_no_supplier,
      'no_pack_size', v_no_pack,
      'no_price', v_no_price,
      'duplicate_material', v_duplicate,
      'high_backtest_error', v_high_backtest
    );

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
      'item_code', v_item.item_code,
      'item_name', v_item.name,
      'unit', v_item.unit,
      'mode', v_mode,
      'daily_usage', v_daily,
      'avg_14d', coalesce(v_usage.avg_14d, 0),
      'avg_28d', coalesce(v_usage.avg_28d, 0),
      'stddev_28d', coalesce(v_usage.stddev_28d, 0),
      'days_with_data', coalesce(v_usage.days_with_data, 0),
      'weekday_factor', coalesce(v_usage.weekday_factor, 1),
      'scheduled_usage', v_scheduled_total,
      'on_hand', v_on_hand,
      'last_count_date', v_last_count,
      'open_po_qty', v_open_po,
      'supplier_id', v_supplier,
      'pack_size', v_pack_size,
      'pack_label', v_pack_label,
      'lead_time_days', v_lead,
      'safety_days', v_safety,
      'order_cycle_days', v_cycle,
      'reorder_date', v_reorder,
      'suggested_qty', v_suggested,
      'last_unit_price', v_price,
      'estimated_amount', v_amount,
      'flags', v_flags
    ));
  end loop;

  return jsonb_build_object(
    'as_of', v_as_of,
    'horizon_days', v_horizon,
    'items', coalesce((
      select jsonb_agg(e order by (e ->> 'reorder_date') nulls last, e ->> 'item_name')
      from jsonb_array_elements(v_items) e
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_q7_purchase_forecast(date, integer) from public, anon;
grant execute on function public.get_q7_purchase_forecast(date, integer) to authenticated, service_role;
