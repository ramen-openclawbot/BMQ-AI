-- Owner 23/10: email ordering for Bột mì 888 / 999 Cam (Phúc Thịnh).
-- Phúc Thịnh PO lines write kg ("Bột mì 999 Cam (25kg)", 250 kg @19.300),
-- but the q7 aliases carry 25.000 g per bag. The forecast multiplied every
-- line by the alias factor, so 250 kg read as 6,25 t on order and the price
-- as 0,77 đ/g; nine Jan–Mar POs never closed also counted as on their way.
--
-- get_q7_purchase_forecast and prepare_supplier_order now convert a line the
-- way post_stock_goods_receipt_item already does (own kg / g unit first, then
-- the "(BAO 25 KG)" bracket, then the alias factor), prefer a recent kg / g
-- line for the price, and ignore POs still open after 30 days.

CREATE OR REPLACE FUNCTION public.get_q7_purchase_forecast(p_as_of date DEFAULT NULL::date, p_horizon_days integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      poi.unit as line_unit,
      poi.product_name,
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
      pl.line_unit,
      pl.product_name,
      k.unit as item_unit,
      a.kitchen_inventory_item_id,
      a.conversion_factor as alias_factor,
      (a.supplier_id is not null) as alias_supplier_specific,
      a.created_at as alias_created_at,
      a.id as alias_id
    from po_lines pl
    join public.stock_material_aliases a
      on a.location = 'q7'
     and a.kitchen_inventory_item_id is not null
     and a.normalized_name = pl.normalized_name
     and (a.supplier_id = pl.supplier_id or a.supplier_id is null)
    join public.kitchen_inventory_items k on k.id = a.kitchen_inventory_item_id
    order by pl.line_id, a.kitchen_inventory_item_id,
             (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  po_unit_f as materialized (
    select u.line_unit, u.item_unit,
           public.stock_unit_line_factor(u.line_unit, u.item_unit) as lf
    from (select distinct m.line_unit, m.item_unit from po_matches m) u
  ),
  po_pack_f as materialized (
    select u.product_name, u.line_unit, u.item_unit,
           public.stock_unit_pack_factor(u.product_name, u.line_unit, u.item_unit) as pf
    from (
      select distinct m.product_name, m.line_unit, m.item_unit
      from po_matches m
      join po_unit_f f
        on f.line_unit is not distinct from m.line_unit
       and f.item_unit is not distinct from m.item_unit
      where f.lf is null
    ) u
  ),
  -- Same rule as post_stock_goods_receipt_item: a kg / g / l / ml line converts
  -- by its own unit; packs use the "(BAO 25 KG)" bracket, then the alias factor.
  po_conv as materialized (
    select m.*,
           coalesce(f.lf, pk.pf, m.alias_factor) as conversion_factor,
           (f.lf is not null) as measured
    from po_matches m
    left join po_unit_f f
      on f.line_unit is not distinct from m.line_unit
     and f.item_unit is not distinct from m.item_unit
    left join po_pack_f pk
      on pk.product_name is not distinct from m.product_name
     and pk.line_unit is not distinct from m.line_unit
     and pk.item_unit is not distinct from m.item_unit
  ),
  po_qty as (
    select m.kitchen_inventory_item_id,
           sum(m.quantity * m.conversion_factor) as qty
    from po_conv m
    where m.status in ('draft', 'sent', 'in_transit')
      -- A PO still open after 30 days is not on its way (old drafts, never closed).
      and m.order_date >= v_as_of - 30
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
    from po_conv m
    where m.unit_price is not null and m.unit_price > 0
    -- Prefer a recent kg / g line: a pack line can carry a per-kg price.
    order by m.kitchen_inventory_item_id,
             (m.measured and m.order_date >= v_as_of - 90) desc,
             m.order_date desc, m.line_created_at desc
  ),
  pr_lines as materialized (
    select
      pri.id as line_id,
      pri.unit_price,
      pri.unit as line_unit,
      pri.product_name,
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
      pl.line_unit,
      pl.product_name,
      k.unit as item_unit,
      a.kitchen_inventory_item_id,
      a.conversion_factor as alias_factor,
      (a.supplier_id is not null) as alias_supplier_specific,
      a.created_at as alias_created_at,
      a.id as alias_id
    from pr_lines pl
    join public.stock_material_aliases a
      on a.location = 'q7'
     and a.kitchen_inventory_item_id is not null
     and a.normalized_name = pl.normalized_name
     and (a.supplier_id = pl.supplier_id or a.supplier_id is null)
    join public.kitchen_inventory_items k on k.id = a.kitchen_inventory_item_id
    order by pl.line_id, a.kitchen_inventory_item_id,
             (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  pr_unit_f as materialized (
    select u.line_unit, u.item_unit,
           public.stock_unit_line_factor(u.line_unit, u.item_unit) as lf
    from (select distinct m.line_unit, m.item_unit from pr_matches m) u
  ),
  pr_pack_f as materialized (
    select u.product_name, u.line_unit, u.item_unit,
           public.stock_unit_pack_factor(u.product_name, u.line_unit, u.item_unit) as pf
    from (
      select distinct m.product_name, m.line_unit, m.item_unit
      from pr_matches m
      join pr_unit_f f
        on f.line_unit is not distinct from m.line_unit
       and f.item_unit is not distinct from m.item_unit
      where f.lf is null
    ) u
  ),
  -- Same rule as post_stock_goods_receipt_item: a kg / g / l / ml line converts
  -- by its own unit; packs use the "(BAO 25 KG)" bracket, then the alias factor.
  pr_conv as materialized (
    select m.*,
           coalesce(f.lf, pk.pf, m.alias_factor) as conversion_factor,
           (f.lf is not null) as measured
    from pr_matches m
    left join pr_unit_f f
      on f.line_unit is not distinct from m.line_unit
     and f.item_unit is not distinct from m.item_unit
    left join pr_pack_f pk
      on pk.product_name is not distinct from m.product_name
     and pk.line_unit is not distinct from m.line_unit
     and pk.item_unit is not distinct from m.item_unit
  ),
  pr_price as (
    select distinct on (m.kitchen_inventory_item_id)
      m.kitchen_inventory_item_id,
      round(m.unit_price / greatest(m.conversion_factor, 0.00000001), 2) as price
    from pr_conv m
    where m.unit_price is not null and m.unit_price > 0
    order by m.kitchen_inventory_item_id,
             (m.measured and m.pr_created_at >= v_as_of - 90) desc,
             m.pr_created_at desc
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
$function$;

CREATE OR REPLACE FUNCTION public.prepare_supplier_order(p_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_role_before text;
  v_item public.kitchen_inventory_items%rowtype;
  v_setting_supplier uuid;
  v_learned_supplier uuid;
  v_setting_pack numeric;
  v_setting_pack_label text;
  v_po_unit text;
  v_po_factor numeric;
  v_supplier_id uuid;
  v_supplier_name text;
  v_supplier_email text;
  v_forecast jsonb;
  v_fc jsonb;
  v_pack_size numeric;
  v_pack_label text;
  v_on_hand numeric;
  v_daily numeric := 0;
  v_days_left numeric;
  v_last_count_date date;
  v_reorder_date date;
  v_suggested numeric := 0;
  v_last_price numeric;
  v_product_name text;
  v_product_price numeric;
  v_qty numeric;
  v_unit text;
  v_price numeric;
  v_line_total numeric;
  v_pack_po numeric;
  v_mailbox text;
  v_addr text := '';
  v_contact_name text := '';
  v_contact_phone text := '';
  v_note text := '';
  v_blockers jsonb := '[]'::jsonb;
  v_open_order jsonb;
begin
  if p_item_id is null then
    raise exception 'item_required' using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'purchase_orders', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  select s.supplier_id, s.learned_supplier_id, s.pack_size, s.pack_label,
         s.po_unit, s.po_unit_factor
  into v_setting_supplier, v_learned_supplier, v_setting_pack,
       v_setting_pack_label, v_po_unit, v_po_factor
  from public.q7_purchase_item_settings s
  where s.kitchen_inventory_item_id = p_item_id;

  v_supplier_id := coalesce(v_setting_supplier, v_learned_supplier);

  if v_supplier_id is not null then
    select btrim(su.name), btrim(su.email)
    into v_supplier_name, v_supplier_email
    from public.suppliers su
    where su.id = v_supplier_id;
    if not found then
      v_supplier_id := null;
    end if;
  end if;

  -- The forecast's own permission gate does not know the purchase_orders module,
  -- so evaluate it with service-role claims exactly like run_q7_auto_purchase.
  v_role_before := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_forecast := public.get_q7_purchase_forecast(v_today, 14);
  perform set_config('request.jwt.claim.role', coalesce(v_role_before, ''), true);

  select e.value into v_fc
  from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
  where e.value ->> 'item_id' = p_item_id::text
  limit 1;

  v_pack_size := coalesce(v_setting_pack, nullif(v_fc ->> 'pack_size', '')::numeric);
  v_pack_label := coalesce(v_setting_pack_label, v_fc ->> 'pack_label');
  v_on_hand := nullif(v_fc ->> 'on_hand', '')::numeric;
  v_daily := coalesce(nullif(v_fc ->> 'daily_usage', '')::numeric, 0);
  v_suggested := coalesce(nullif(v_fc ->> 'suggested_qty', '')::numeric, 0);
  v_last_count_date := nullif(v_fc ->> 'last_count_date', '')::date;
  v_reorder_date := nullif(v_fc ->> 'reorder_date', '')::date;
  v_last_price := nullif(v_fc ->> 'last_unit_price', '')::numeric;

  if v_on_hand is not null and v_daily > 0 then
    v_days_left := round(v_on_hand / v_daily, 1);
  else
    v_days_left := null;
  end if;

  v_product_name := v_item.name;

  if v_supplier_id is not null then
    -- Supplier's own wording: latest PO line whose normalized name maps to this
    -- item for this supplier, any location.
    select poi.product_name
    into v_product_name
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    join lateral (
      select a.*
      from public.stock_material_aliases a
      where a.kitchen_inventory_item_id = p_item_id
        and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
        and (a.supplier_id = v_supplier_id or a.supplier_id is null)
      order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
      limit 1
    ) a on true
    where po.supplier_id = v_supplier_id
    order by po.order_date desc, poi.created_at desc
    limit 1;

    if nullif(btrim(coalesce(v_product_name, '')), '') is null then
      v_product_name := v_item.name;
    end if;

    -- Latest supplier-line price in the item's book unit.
    -- Latest supplier-line price in the item's book unit. A kg / g line
    -- converts by its own unit (Phúc Thịnh writes 250 kg on a "(25kg)" bag
    -- line), packs by the bracket or the alias; recent kg / g lines win.
    select round(
             poi.unit_price / greatest(coalesce(
               public.stock_unit_line_factor(poi.unit, v_item.unit),
               public.stock_unit_pack_factor(poi.product_name, poi.unit, v_item.unit),
               a.conversion_factor
             ), 0.00000001),
             6)
    into v_product_price
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    join lateral (
      select a.*
      from public.stock_material_aliases a
      where a.kitchen_inventory_item_id = p_item_id
        and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
        and (a.supplier_id = v_supplier_id or a.supplier_id is null)
      order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
      limit 1
    ) a on true
    where po.supplier_id = v_supplier_id
      and poi.unit_price is not null
      and poi.unit_price > 0
    order by (public.stock_unit_line_factor(poi.unit, v_item.unit) is not null
              and po.order_date >= v_today - 90) desc,
             po.order_date desc, poi.created_at desc
    limit 1;

    if v_product_price is not null then
      v_last_price := v_product_price;
    end if;
  end if;

  -- Express the book quantity in the supplier unit. When no supplier unit is
  -- configured, mirror run_q7_auto_purchase's pack fallback for display.
  if v_po_factor is not null and v_po_factor > 0 then
    v_qty := round(v_suggested / v_po_factor, 3);
    v_unit := v_po_unit;
    v_pack_po := case
      when v_pack_size is not null and v_pack_size > 0
        then round(v_pack_size / v_po_factor, 3)
      else null
    end;
    v_price := case
      when v_last_price is not null then round(v_last_price * v_po_factor, 2)
      else null
    end;
    v_line_total := case
      when v_price is not null then round(v_qty * v_price, 2)
      else null
    end;
  elsif v_pack_size is not null and v_pack_size > 0 then
    v_qty := round(v_suggested / v_pack_size, 3);
    v_unit := coalesce(v_pack_label, v_item.unit);
    v_pack_po := 1;
    v_price := case
      when v_last_price is not null then round(v_last_price * v_pack_size, 2)
      else null
    end;
    v_line_total := case
      when v_price is not null then round(v_qty * v_price, 2)
      else null
    end;
  else
    v_qty := v_suggested;
    v_unit := v_item.unit;
    v_pack_po := null;
    v_price := v_last_price;
    v_line_total := case
      when v_price is not null then round(v_qty * v_price, 2)
      else null
    end;
  end if;

  select coalesce(max(value) filter (where key = 'order_email_delivery_address'), ''),
         coalesce(max(value) filter (where key = 'order_email_contact_name'), ''),
         coalesce(max(value) filter (where key = 'order_email_contact_phone'), ''),
         coalesce(max(value) filter (where key = 'order_email_note'), '')
  into v_addr, v_contact_name, v_contact_phone, v_note
  from public.app_settings
  where key in (
    'order_email_delivery_address',
    'order_email_contact_name',
    'order_email_contact_phone',
    'order_email_note'
  );

  select value into v_mailbox
  from public.app_settings
  where key = 'order_gmail_connected_email';

  select jsonb_build_object(
    'po_number', po.po_number,
    'quantity', r.quantity,
    'unit', r.unit,
    'status', po.status::text,
    'created_at', r.created_at
  )
  into v_open_order
  from public.supplier_order_requests r
  join public.purchase_orders po on po.id = r.purchase_order_id
  where r.kitchen_inventory_item_id = p_item_id
    and r.status = 'sent'
    and not exists (
      select 1 from public.goods_receipts gr
      where gr.purchase_order_id = po.id
        and gr.status in ('confirmed', 'received')
    )
  order by r.sent_at desc nulls last, r.created_at desc
  limit 1;

  if v_supplier_id is null then
    v_blockers := v_blockers || jsonb_build_array('no_supplier');
  elsif nullif(btrim(coalesce(v_supplier_email, '')), '') is null then
    v_blockers := v_blockers || jsonb_build_array('no_supplier_email');
  end if;
  if v_last_price is null then
    v_blockers := v_blockers || jsonb_build_array('no_price');
  end if;
  if v_po_unit is null or v_po_factor is null or v_po_factor <= 0 then
    v_blockers := v_blockers || jsonb_build_array('no_po_unit');
  end if;
  if lower(btrim(coalesce(v_mailbox, ''))) <> 'order@bmq.vn' then
    v_blockers := v_blockers || jsonb_build_array('mailbox_not_connected');
  end if;

  return jsonb_build_object(
    'item', jsonb_build_object(
      'id', v_item.id,
      'name', v_item.name,
      'unit', v_item.unit
    ),
    'supplier', case
      when v_supplier_id is null then null
      else jsonb_build_object(
        'id', v_supplier_id,
        'name', v_supplier_name,
        'email', v_supplier_email
      )
    end,
    'stock', jsonb_build_object(
      'on_hand', v_on_hand,
      'daily_usage', v_daily,
      'days_left', v_days_left,
      'last_count_date', v_last_count_date,
      'reorder_date', v_reorder_date
    ),
    'proposal', jsonb_build_object(
      'quantity', v_qty,
      'unit', v_unit,
      'unit_price', v_price,
      'line_total', v_line_total,
      'product_name', v_product_name,
      'pack_size_po_units', v_pack_po,
      'suggested_book_qty', v_suggested
    ),
    'open_order', v_open_order,
    'delivery', jsonb_build_object(
      'address', v_addr,
      'contact_name', v_contact_name,
      'contact_phone', v_contact_phone,
      'note', v_note
    ),
    'blockers', v_blockers
  );
end;
$function$;

revoke all on function public.get_q7_purchase_forecast(date, integer) from public, anon;
grant execute on function public.get_q7_purchase_forecast(date, integer) to authenticated, service_role;
revoke all on function public.prepare_supplier_order(uuid) from public, anon;
grant execute on function public.prepare_supplier_order(uuid) to authenticated, service_role;
