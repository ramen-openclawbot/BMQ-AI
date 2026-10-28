-- Trang Đặt hàng theo NCC — every supplier that bought in the last 60 days.
--
-- 2026-11-03. This migration only adds reviewed source; it is not applied live
-- by the Harness. It:
--   * seeds supplier_order_catalog_items from the last 60 days of goods
--     receipt / purchase-order lines, reusing the existing unit conversion
--     rules, never touching an existing row and never guessing a unit;
--   * makes supplier_order_suppliers() cover every supplier with active
--     catalog items or recent receipt / PO activity and adds urgency counts;
--   * teaches supplier_order_catalog() the warehouse location of each item and
--     uses warehouse_item_learning for Tân Tạo estimates;
--   * adds supplier_order_set_supplier_email for the order-email column used by
--     the existing catalog / prepare RPCs.
--
-- Nothing here sends email, creates a PO, writes a document/ledger row or
-- changes an existing Phúc Thịnh / TV Food catalog row.

-- ===========================================================================
-- 1. Seed the per-supplier catalog from recent receipts and POs
-- ===========================================================================

create or replace function public.supplier_order_seed_recent_catalog(
  p_days integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_days integer;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_suppliers integer := 0;
begin
  if p_days is null or p_days < 0 then
    raise exception 'invalid_days' using errcode = '22023';
  end if;
  v_days := p_days;

  with receipt_lines as (
    select
      gi.id as line_id,
      'receipt'::text as source,
      gr.supplier_id,
      gr.receipt_date::timestamptz as occurred_at,
      gi.created_at as line_created_at,
      coalesce(gi.raw_product_name, gi.product_name) as product_name,
      gi.unit,
      public.normalize_stock_item_name(
        coalesce(gi.raw_product_name, gi.product_name)
      ) as normalized_name
    from public.goods_receipt_items gi
    join public.goods_receipts gr on gr.id = gi.goods_receipt_id
    where gr.supplier_id is not null
      and gr.status in ('confirmed', 'received')
      and gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - v_days
      and gr.receipt_date <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
      and coalesce(gi.raw_product_name, gi.product_name) is not null
  ),
  po_lines as (
    select
      poi.id as line_id,
      'po'::text as source,
      po.supplier_id,
      po.order_date::timestamptz as occurred_at,
      poi.created_at as line_created_at,
      poi.product_name,
      poi.unit,
      public.normalize_stock_item_name(poi.product_name) as normalized_name
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    where po.supplier_id is not null
      and po.order_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - v_days
      and po.order_date <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
      and po.status <> 'cancelled'::public.purchase_order_status
      and poi.product_name is not null
  ),
  candidate_lines as (
    select * from receipt_lines
    union all
    select * from po_lines
  ),
  -- One alias per line, exactly like supplier_order_catalog_candidates and
  -- get_office_order_snapshot: a supplier-specific alias wins, then the oldest.
  matched as (
    select distinct on (l.source, l.line_id)
      l.source,
      l.line_id,
      l.supplier_id,
      l.occurred_at,
      l.line_created_at,
      l.product_name,
      l.unit,
      a.kitchen_inventory_item_id,
      a.conversion_factor
    from candidate_lines l
    join public.stock_material_aliases a
      on a.normalized_name = l.normalized_name
     and a.line_class = 'stock'
     and a.kitchen_inventory_item_id is not null
     and (a.supplier_id = l.supplier_id or a.supplier_id is null)
    order by l.source, l.line_id,
             (a.supplier_id is not null) desc,
             a.created_at asc,
             a.id asc
  ),
  -- The same chain as post_stock_goods_receipt_item / supplier_order_line_price:
  -- line unit -> pack name -> alias factor. A missing factor is skipped below;
  -- it is never replaced with 1.
  converted as (
    select
      m.source,
      m.line_id,
      m.supplier_id,
      m.occurred_at,
      m.line_created_at,
      m.product_name,
      m.unit,
      m.kitchen_inventory_item_id,
      kii.unit as item_unit,
      coalesce(
        nullif(public.stock_unit_line_factor(m.unit, kii.unit), 0),
        nullif(public.stock_unit_pack_factor(m.product_name, m.unit, kii.unit), 0),
        nullif(m.conversion_factor, 0)
      ) as factor
    from matched m
    join public.kitchen_inventory_items kii
      on kii.id = m.kitchen_inventory_item_id
  ),
  pair_counts as (
    select
      supplier_id,
      kitchen_inventory_item_id,
      count(*)::integer as line_count
    from converted
    group by supplier_id, kitchen_inventory_item_id
  ),
  last_lines as (
    select distinct on (supplier_id, kitchen_inventory_item_id)
      supplier_id,
      kitchen_inventory_item_id,
      product_name,
      unit as po_unit,
      factor,
      occurred_at
    from converted
    order by supplier_id, kitchen_inventory_item_id,
             occurred_at desc, line_created_at desc, line_id desc
  ),
  pair_stats as (
    select
      ll.supplier_id,
      ll.kitchen_inventory_item_id,
      ll.product_name,
      ll.po_unit,
      ll.factor,
      ll.occurred_at,
      pc.line_count
    from last_lines ll
    join pair_counts pc
      on pc.supplier_id = ll.supplier_id
     and pc.kitchen_inventory_item_id = ll.kitchen_inventory_item_id
  ),
  existing_pairs as (
    select supplier_id, kitchen_inventory_item_id
    from public.supplier_order_catalog_items
  ),
  new_pairs as (
    select ps.*
    from pair_stats ps
    where not exists (
      select 1
      from existing_pairs e
      where e.supplier_id = ps.supplier_id
        and e.kitchen_inventory_item_id = ps.kitchen_inventory_item_id
    )
  ),
  max_sort as (
    select supplier_id, coalesce(max(sort_order), 0) as max_sort_order
    from public.supplier_order_catalog_items
    group by supplier_id
  ),
  -- Only convert pairs whose most recent line unit is usable. A pair whose
  -- latest line cannot be converted is counted as skipped, not guessed from an
  -- older line.
  ranked as (
    select
      np.supplier_id,
      np.kitchen_inventory_item_id,
      np.product_name,
      np.po_unit,
      np.factor,
      np.occurred_at,
      np.line_count,
      coalesce(ms.max_sort_order, 0) + (
        row_number() over (
          partition by np.supplier_id
          order by np.line_count desc, np.occurred_at desc, np.kitchen_inventory_item_id
        )
      )::integer as sort_order
    from new_pairs np
    left join max_sort ms on ms.supplier_id = np.supplier_id
    where np.factor is not null
      and np.factor > 0
      and np.factor::text not in ('NaN', 'Infinity', '-Infinity')
      and nullif(btrim(coalesce(np.po_unit, '')), '') is not null
  ),
  inserted as (
    insert into public.supplier_order_catalog_items (
      supplier_id,
      kitchen_inventory_item_id,
      product_name,
      po_unit,
      po_unit_factor,
      pack_size_po,
      sort_order,
      active,
      created_by
    )
    select
      r.supplier_id,
      r.kitchen_inventory_item_id,
      nullif(btrim(coalesce(r.product_name, '')), ''),
      r.po_unit,
      r.factor,
      case
        when wl.learned_pack_size is not null
         and wl.learned_pack_size > 0
         and wl.learned_pack_size::text not in ('NaN', 'Infinity', '-Infinity')
          then nullif(round(wl.learned_pack_size / r.factor, 3), 0)
        else null
      end,
      r.sort_order,
      true,
      v_actor
    from ranked r
    left join public.warehouse_item_learning wl
      on wl.location = 'tan_tao'
     and wl.kitchen_inventory_item_id = r.kitchen_inventory_item_id
    on conflict (supplier_id, kitchen_inventory_item_id) do nothing
    returning supplier_id
  )
  select
    (select count(*)::integer from inserted),
    (select count(*)::integer
       from new_pairs np
      where np.factor is null
         or np.factor <= 0
         or np.factor::text in ('NaN', 'Infinity', '-Infinity')
         or nullif(btrim(coalesce(np.po_unit, '')), '') is null),
    (select count(distinct supplier_id)::integer from pair_stats)
  into v_inserted, v_skipped, v_suppliers;

  return jsonb_build_object(
    'inserted', v_inserted,
    'skipped_no_conversion', v_skipped,
    'suppliers', v_suppliers
  );
end;
$$;

revoke all on function public.supplier_order_seed_recent_catalog(integer)
  from public, anon, authenticated;
grant execute on function public.supplier_order_seed_recent_catalog(integer)
  to service_role;

-- ===========================================================================
-- 2. Supplier list: every supplier with active items or recent activity
-- ===========================================================================

create or replace function public.supplier_order_suppliers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_role_before text;
  v_forecast jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'supplier_orders', 'view')
      or public.has_module_permission(v_actor, 'supplier_orders', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  -- The forecast has its own Q7 permission gate; the supplier page already
  -- authorizes the caller, so evaluate it with service-role claims like
  -- supplier_order_catalog does.
  v_role_before := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_forecast := public.get_q7_purchase_forecast(v_today, 14);
  perform set_config('request.jwt.claim.role', coalesce(v_role_before, ''), true);

  with scope as (
    select su.id, su.name, su.email, su.default_receiving_location
    from public.suppliers su
    where exists (
      select 1
      from public.supplier_order_catalog_items c
      where c.supplier_id = su.id and c.active
    )
    or exists (
      select 1
      from public.goods_receipts gr
      where gr.supplier_id = su.id
        and gr.receipt_date >= v_today - 60
    )
    or exists (
      select 1
      from public.purchase_orders po
      where po.supplier_id = su.id
        and po.order_date >= v_today - 60
        and po.status <> 'cancelled'::public.purchase_order_status
    )
  ),
  forecast_items as (
    select
      (e.value ->> 'item_id')::uuid as item_id,
      nullif(e.value ->> 'suggested_qty', '')::numeric as suggested_qty,
      nullif(e.value ->> 'on_hand', '')::numeric as on_hand,
      nullif(e.value ->> 'daily_usage', '')::numeric as daily_usage,
      nullif(e.value ->> 'lead_time_days', '')::numeric as lead_time_days
    from jsonb_array_elements(
      coalesce(v_forecast -> 'items', '[]'::jsonb)
    ) e
  ),
  item_base as (
    select
      c.supplier_id,
      c.kitchen_inventory_item_id,
      case
        when coalesce(kii.pastry_q7, false) then 'q7'
        when wl.kitchen_inventory_item_id is not null then 'tan_tao'
        when coalesce(kii.in_tan_tao, false) then 'tan_tao'
        else 'q7'
      end as location,
      fc.suggested_qty as q7_suggested_qty,
      fc.on_hand as q7_on_hand,
      fc.daily_usage as q7_daily_usage,
      fc.lead_time_days as q7_lead_time_days,
      wl.learned_daily_usage,
      wl.learned_order_qty,
      wl.learned_lead_time_days,
      wl.learned_cycle_days
    from public.supplier_order_catalog_items c
    join public.kitchen_inventory_items kii
      on kii.id = c.kitchen_inventory_item_id
    left join public.warehouse_item_learning wl
      on wl.location = 'tan_tao'
     and wl.kitchen_inventory_item_id = c.kitchen_inventory_item_id
    left join forecast_items fc
      on fc.item_id = c.kitchen_inventory_item_id
    where c.active
      and c.supplier_id in (select id from scope)
  ),
  item_stocked as (
    select
      b.*,
      case
        when b.location = 'tan_tao' then (
          -- No Tân Tạo movement at all means stock is unknown, not zero.
          select case when count(*) = 0 then null else sum(case m.movement_type
                       when 'receipt' then m.quantity
                       when 'opening' then m.quantity
                       when 'production_usage' then -m.quantity
                       when 'adjustment' then m.quantity
                       when 'transfer_out' then -m.quantity
                       else 0
                     end) end
          from public.tan_tao_material_movements m
          where m.kitchen_inventory_item_id = b.kitchen_inventory_item_id
            and m.movement_date <= v_today
        )
        else b.q7_on_hand
      end as on_hand
    from item_base b
  ),
  item_states as (
    select
      s.*,
      case
        when s.location = 'tan_tao' then s.learned_daily_usage
        else s.q7_daily_usage
      end as daily_usage,
      case
        when s.location = 'tan_tao' then s.learned_lead_time_days
        else s.q7_lead_time_days
      end as lead_time_days,
      case
        when s.location = 'tan_tao' then
          case
            when coalesce(s.learned_daily_usage, 0) > 0
              then round(s.on_hand / s.learned_daily_usage, 1)
            else null
          end
        when coalesce(s.q7_daily_usage, 0) > 0 then
          round(s.on_hand / s.q7_daily_usage, 1)
        else null
      end as days_left,
      case
        when s.location = 'tan_tao' then
          case
            when s.on_hand <= 0
              or (
                coalesce(s.learned_daily_usage, 0) > 0
                and s.on_hand / s.learned_daily_usage
                  <= coalesce(s.learned_lead_time_days, 7)
              )
              then coalesce(s.learned_order_qty, 0)
            else 0
          end
        else coalesce(s.q7_suggested_qty, 0)
      end as suggested_qty
    from item_stocked s
  ),
  item_flags as (
    select
      s.*,
      (s.on_hand is not null and s.on_hand <= 0) as out_of_stock,
      (
        coalesce(s.suggested_qty, 0) > 0
        or (s.on_hand is not null and s.on_hand <= 0)
      ) as need_order,
      (
        s.days_left is not null
        and s.days_left <= coalesce(s.lead_time_days, 7)
      ) as low_stock
    from item_states s
  ),
  supplier_stats as (
    select
      f.supplier_id,
      count(*)::integer as active_item_count,
      count(*) filter (where f.need_order)::integer as need_order_count,
      count(*) filter (where f.low_stock)::integer as low_stock_count,
      count(*) filter (where f.out_of_stock)::integer as out_of_stock_count,
      array_agg(distinct f.location order by f.location) as item_locations
    from item_flags f
    group by f.supplier_id
  ),
  activity as (
    select
      a.supplier_id,
      max(a.occurred_at) as last_activity_at,
      array_agg(distinct a.location)
        filter (where a.location is not null) as activity_locations
    from (
      select
        gr.supplier_id,
        gr.receipt_date::timestamptz as occurred_at,
        gr.receiving_location as location
      from public.goods_receipts gr
      where gr.supplier_id is not null
        and gr.receipt_date >= v_today - 60
      union all
      select
        po.supplier_id,
        po.order_date::timestamptz as occurred_at,
        null::text as location
      from public.purchase_orders po
      where po.supplier_id is not null
        and po.order_date >= v_today - 60
        and po.status <> 'cancelled'::public.purchase_order_status
    ) a
    group by a.supplier_id
  )
  select coalesce(
    jsonb_agg(
      to_jsonb(x)
      order by x.urgency_rank, x.name, x.id
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      sc.id,
      btrim(sc.name) as name,
      nullif(btrim(sc.email), '') as email,
      (nullif(btrim(sc.email), '') is not null) as has_email,
      coalesce(ss.active_item_count, 0) as item_count,
      coalesce(ss.active_item_count, 0) as active_item_count,
      coalesce(ss.need_order_count, 0) as need_order_count,
      coalesce(ss.low_stock_count, 0) as low_stock_count,
      coalesce(ss.out_of_stock_count, 0) as out_of_stock_count,
      act.last_activity_at,
      coalesce((
        select jsonb_agg(distinct l order by l)
        from unnest(
          coalesce(ss.item_locations, '{}'::text[])
          || coalesce(act.activity_locations, '{}'::text[])
          || case
               when sc.default_receiving_location is not null
                 then array[sc.default_receiving_location]::text[]
               else '{}'::text[]
             end
        ) l
      ), '[]'::jsonb) as locations,
      case
        when coalesce(ss.out_of_stock_count, 0) > 0 then 1
        when coalesce(ss.need_order_count, 0) > 0 then 2
        when coalesce(ss.low_stock_count, 0) > 0 then 3
        else 4
      end as urgency_rank,
      (
        select jsonb_build_object(
          'po_number', po.po_number,
          'sent_at', r.sent_at
        )
        from public.supplier_order_requests r
        left join public.purchase_orders po on po.id = r.purchase_order_id
        where r.supplier_id = sc.id
          and r.status = 'sent'
        order by r.sent_at desc nulls last, r.created_at desc
        limit 1
      ) as last_order,
      (
        select count(*)
        from public.payment_requests pr
        where pr.supplier_id = sc.id
          and pr.status::text in ('pending', 'approved')
          and pr.payment_status::text in ('unpaid', 'partial')
      ) as unpaid_count
    from scope sc
    left join supplier_stats ss on ss.supplier_id = sc.id
    left join activity act on act.supplier_id = sc.id
  ) x;

  return v_result;
end;
$$;

-- ===========================================================================
-- 3. Catalog: location-aware Q7 / Tân Tạo item rows
-- ===========================================================================

create or replace function public.supplier_order_catalog(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_role_before text;
  v_supplier public.suppliers%rowtype;
  v_forecast jsonb;
  v_mailbox text;
  v_delivery jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_prepay jsonb;
  v_item record;
  v_fc jsonb;
  v_location text;
  v_estimated boolean;
  v_on_hand numeric;
  v_daily numeric;
  v_days_left numeric;
  v_last_count_date date;
  v_reorder_date date;
  v_suggested numeric;
  v_proposal numeric;
  v_price numeric;
  v_history_price numeric;
  v_unit_price numeric;
  v_unit_price_gross numeric;
  v_vat_rate numeric;
  v_product_name text;
  v_open_order jsonb;
  v_tan_tao_daily numeric;
  v_tan_tao_order_qty numeric;
  v_tan_tao_cycle_days numeric;
  v_tan_tao_lead_time_days integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'supplier_orders', 'view')
      or public.has_module_permission(v_actor, 'supplier_orders', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

  select * into v_supplier
  from public.suppliers
  where id = p_supplier_id;
  if not found then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;

  v_role_before := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_forecast := public.get_q7_purchase_forecast(v_today, 14);
  perform set_config('request.jwt.claim.role', coalesce(v_role_before, ''), true);

  select jsonb_build_object(
    'address', coalesce(max(value) filter (where key = 'order_email_delivery_address'), ''),
    'contact_name', coalesce(max(value) filter (where key = 'order_email_contact_name'), ''),
    'contact_phone', coalesce(max(value) filter (where key = 'order_email_contact_phone'), ''),
    'note', coalesce(max(value) filter (where key = 'order_email_note'), '')
  )
  into v_delivery
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

  if nullif(btrim(coalesce(v_supplier.email, '')), '') is null then
    v_blockers := v_blockers || jsonb_build_array('no_supplier_email');
  end if;
  if lower(btrim(coalesce(v_mailbox, ''))) <> 'order@bmq.vn' then
    v_blockers := v_blockers || jsonb_build_array('mailbox_not_connected');
  end if;

  for v_item in
    select
      c.id as catalog_id,
      c.kitchen_inventory_item_id,
      c.product_name,
      c.po_unit,
      c.po_unit_factor,
      c.pack_size_po,
      c.vat_rate,
      c.list_price,
      c.list_price_includes_vat,
      c.list_price_source,
      c.list_price_updated_at,
      kii.name as item_name,
      kii.item_code,
      kii.unit as item_unit,
      case
        when coalesce(kii.pastry_q7, false) then 'q7'
        when wl.kitchen_inventory_item_id is not null then 'tan_tao'
        when coalesce(kii.in_tan_tao, false) then 'tan_tao'
        else 'q7'
      end as location,
      wl.learned_daily_usage,
      wl.learned_order_qty,
      wl.learned_cycle_days,
      wl.learned_lead_time_days
    from public.supplier_order_catalog_items c
    join public.kitchen_inventory_items kii
      on kii.id = c.kitchen_inventory_item_id
    left join public.warehouse_item_learning wl
      on wl.location = 'tan_tao'
     and wl.kitchen_inventory_item_id = c.kitchen_inventory_item_id
    where c.supplier_id = p_supplier_id
      and c.active
    order by c.sort_order, c.created_at, c.id
  loop
    v_location := v_item.location;
    v_estimated := v_location = 'tan_tao';

    if v_estimated then
      -- Tân Tạo stock source: the same movement sum used by the Tân Tạo
      -- warehouse snapshot / stock-count sheet (tan_tao_material_movements).
      -- No Tân Tạo movement at all means stock is unknown, not zero.
      select case when count(*) = 0 then null else sum(case m.movement_type
                            when 'receipt' then m.quantity
                            when 'opening' then m.quantity
                            when 'production_usage' then -m.quantity
                            when 'adjustment' then m.quantity
                            when 'transfer_out' then -m.quantity
                            else 0
                          end) end
      into v_on_hand
      from public.tan_tao_material_movements m
      where m.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
        and m.movement_date <= v_today;

      v_tan_tao_daily := coalesce(v_item.learned_daily_usage, 0);
      v_tan_tao_order_qty := v_item.learned_order_qty;
      v_tan_tao_cycle_days := v_item.learned_cycle_days;
      v_tan_tao_lead_time_days := v_item.learned_lead_time_days;
      v_daily := v_tan_tao_daily;

      if v_on_hand is not null and v_daily > 0 then
        v_days_left := round(v_on_hand / v_daily, 1);
      else
        v_days_left := null;
      end if;

      if v_on_hand is not null
         and (
           v_on_hand <= 0
           or (
             v_days_left is not null
             and v_days_left <= coalesce(v_tan_tao_lead_time_days, 7)
           )
         ) then
        v_suggested := coalesce(v_tan_tao_order_qty, 0);
      else
        v_suggested := 0;
      end if;

      v_last_count_date := null;
      v_reorder_date := case
        when v_days_left is not null and v_tan_tao_lead_time_days is not null
          then v_today + greatest(
            0,
            floor(v_days_left - v_tan_tao_lead_time_days)
          )::integer
        else null
      end;
    else
      -- Q7 branch: byte-for-byte the previous read path.
      select e.value into v_fc
      from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
      where e.value ->> 'item_id' = v_item.kitchen_inventory_item_id::text
      limit 1;

      v_on_hand := nullif(v_fc ->> 'on_hand', '')::numeric;
      v_daily := coalesce(nullif(v_fc ->> 'daily_usage', '')::numeric, 0);
      v_suggested := coalesce(nullif(v_fc ->> 'suggested_qty', '')::numeric, 0);
      v_last_count_date := nullif(v_fc ->> 'last_count_date', '')::date;
      v_reorder_date := nullif(v_fc ->> 'reorder_date', '')::date;

      if v_on_hand is not null and v_daily > 0 then
        v_days_left := round(v_on_hand / v_daily, 1);
      else
        v_days_left := null;
      end if;

      v_tan_tao_daily := null;
      v_tan_tao_order_qty := null;
      v_tan_tao_cycle_days := null;
      v_tan_tao_lead_time_days := null;
    end if;

    if v_suggested > 0 and v_item.po_unit_factor > 0 then
      v_proposal := v_suggested / v_item.po_unit_factor;
      if v_item.pack_size_po is not null and v_item.pack_size_po > 0 then
        v_proposal := ceil(v_proposal / v_item.pack_size_po) * v_item.pack_size_po;
      else
        v_proposal := ceil(v_proposal);
      end if;
      v_proposal := round(v_proposal, 3);
    else
      v_proposal := 0;
    end if;

    v_price := public.supplier_order_line_price(
      p_supplier_id, v_item.kitchen_inventory_item_id
    );
    v_history_price := case
      when v_price is not null then round(v_price * v_item.po_unit_factor, 2)
      else null
    end;
    v_vat_rate := coalesce(v_item.vat_rate, 0);

    if v_item.list_price is not null then
      if coalesce(v_item.list_price_includes_vat, false) then
        v_unit_price := round(
          v_item.list_price / (1 + v_vat_rate / 100), 2
        );
        v_unit_price_gross := v_item.list_price;
      else
        v_unit_price := v_item.list_price;
        v_unit_price_gross := round(
          v_unit_price * (1 + v_vat_rate / 100), 2
        );
      end if;
    else
      v_unit_price := v_history_price;
      v_unit_price_gross := case
        when v_unit_price is not null then round(
          v_unit_price * (1 + v_vat_rate / 100), 2
        )
        else null
      end;
    end if;

    v_product_name := nullif(btrim(coalesce(v_item.product_name, '')), '');
    if v_product_name is null then
      select poi.product_name
      into v_product_name
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      join lateral (
        select a.*
        from public.stock_material_aliases a
        where a.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
          and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
          and (a.supplier_id = p_supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a on true
      where po.supplier_id = p_supplier_id
      order by po.order_date desc, poi.created_at desc
      limit 1;
    end if;
    if nullif(btrim(coalesce(v_product_name, '')), '') is null then
      v_product_name := v_item.item_name;
    end if;

    select jsonb_build_object(
      'po_number', po.po_number,
      'quantity', coalesce(l.quantity, r.quantity),
      'unit', coalesce(l.unit, r.unit),
      'sent_at', r.sent_at
    )
    into v_open_order
    from public.supplier_order_requests r
    join public.purchase_orders po on po.id = r.purchase_order_id
    left join public.supplier_order_request_lines l
      on l.request_id = r.id
     and l.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
    where r.status = 'sent'
      and (
        r.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
        or l.id is not null
      )
      and not exists (
        select 1 from public.goods_receipts gr
        where gr.purchase_order_id = po.id
          and gr.status in ('confirmed', 'received')
      )
    order by r.sent_at desc nulls last, r.created_at desc, l.position nulls last
    limit 1;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'catalog_id', v_item.catalog_id,
      'item', jsonb_build_object(
        'id', v_item.kitchen_inventory_item_id,
        'name', v_item.item_name,
        'code', v_item.item_code,
        'unit', v_item.item_unit
      ),
      'product_name', v_product_name,
      'po_unit', v_item.po_unit,
      'po_unit_factor', v_item.po_unit_factor,
      'pack_size_po', v_item.pack_size_po,
      'vat_rate', v_item.vat_rate,
      'location', v_location,
      'estimated', v_estimated,
      'stock', jsonb_build_object(
        'on_hand', v_on_hand,
        'daily_usage', v_daily,
        'days_left', v_days_left,
        'reorder_date', v_reorder_date,
        'last_count_date', v_last_count_date,
        'lead_time_days', case when v_estimated then v_tan_tao_lead_time_days else null end,
        'order_cycle_days', case when v_estimated then v_tan_tao_cycle_days else null end,
        'order_size', case when v_estimated then v_tan_tao_order_qty else null end
      ),
      'proposal_qty', v_proposal,
      'history_price', v_history_price,
      'list_price', v_item.list_price,
      'list_price_includes_vat', coalesce(v_item.list_price_includes_vat, false),
      'list_price_source', v_item.list_price_source,
      'list_price_updated_at', v_item.list_price_updated_at,
      'unit_price', v_unit_price,
      'unit_price_gross', v_unit_price_gross,
      'open_order', v_open_order
    ));
  end loop;

  select jsonb_build_object(
    'id', pr.id,
    'request_number', pr.request_number,
    'created_at', pr.created_at,
    'total_amount', pr.total_amount,
    'remaining', round(
      coalesce(pr.total_amount, 0) - coalesce((
        select sum(pa.amount)
        from public.payment_allocations pa
        where pa.payment_request_id = pr.id
      ), 0), 2),
    'po_number', po.po_number,
    'recent_submission', case
      when ps.id is null then null
      else jsonb_build_object(
        'submission_number', ps.submission_number,
        'created_at', ps.created_at
      )
    end
  )
  into v_prepay
  from public.payment_requests pr
  left join public.purchase_orders po on po.id = pr.purchase_order_id
  left join lateral (
    select s.id, s.submission_number, s.created_at
    from public.payment_submission_items psi
    join public.payment_submissions s on s.id = psi.submission_id
    where psi.payment_request_id = pr.id
      and s.created_at >= now() - interval '3 days'
    order by s.created_at desc
    limit 1
  ) ps on true
  where pr.supplier_id = p_supplier_id
    and pr.status::text in ('pending', 'approved')
    and pr.payment_status::text in ('unpaid', 'partial')
  order by pr.created_at asc, pr.id asc
  limit 1;

  return jsonb_build_object(
    'supplier', jsonb_build_object(
      'id', v_supplier.id,
      'name', btrim(v_supplier.name),
      'email', nullif(btrim(v_supplier.email), '')
    ),
    'delivery', v_delivery,
    'mailbox_connected', lower(btrim(coalesce(v_mailbox, ''))) = 'order@bmq.vn',
    'blockers', v_blockers,
    'items', v_items,
    'prepay', v_prepay
  );
end;
$$;

-- ===========================================================================
-- 4. Set the supplier order email (the suppliers.email column read by
--    supplier_order_catalog / prepare_supplier_order)
-- ===========================================================================

create or replace function public.supplier_order_set_supplier_email(
  p_supplier_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_supplier public.suppliers%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'supplier_orders', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));
  if v_email = ''
     or length(v_email) > 254
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  update public.suppliers
  set email = v_email
  where id = p_supplier_id
  returning * into v_supplier;

  if not found then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;

  return to_jsonb(v_supplier);
end;
$$;

revoke all on function public.supplier_order_set_supplier_email(uuid, text)
  from public, anon;
grant execute on function public.supplier_order_set_supplier_email(uuid, text)
  to authenticated, service_role;

-- ===========================================================================
-- 5. Grants for the recreated read RPCs (same as their latest definitions)
-- ===========================================================================

revoke all on function public.supplier_order_suppliers() from public, anon;
grant execute on function public.supplier_order_suppliers()
  to authenticated, service_role;

revoke all on function public.supplier_order_catalog(uuid) from public, anon;
grant execute on function public.supplier_order_catalog(uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 6. Run the idempotent seed once; existing rows are never updated
-- ===========================================================================

select public.supplier_order_seed_recent_catalog(60);
