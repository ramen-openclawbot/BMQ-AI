-- 2026-10-23 — Kho: truy xuất nguồn gốc theo mẫu KFM + nhắc giấy ATTP.
--
-- Data layer only.  This migration:
--   * resolves a goods receipt line to the real kitchen item (kho item) via
--     the append-only ledgers first and the learned alias second, then fixes
--     kho_expiry_overview to return that item id/name;
--   * makes product_label_specs.shelf_life_days the only shelf-life source by
--     dropping sku_set_shelf_life and the empty product_skus.shelf_life_days;
--   * adds kho_trace_candidates / kho_trace_report for the KFM trace sheet;
--   * adds the daily food-certificate reminder outbox rows (30/7/0 days) and
--     the 08:00 ICT pg_cron schedule.
--
-- Nothing here writes stock, stock ledgers or existing business rows.

-- ===========================================================================
-- A. Resolve a receipt line to its live kitchen item
-- ===========================================================================
-- inventory_batches.inventory_item_id still references the legacy
-- inventory_items table, so it is not the kitchen item.  The posted ledgers
-- already carry the kitchen item for a receipt line; the alias table is the
-- fallback used by the kho review read path.  Follow merged_into_id so callers
-- always receive the live item.

create or replace function public.kho_receipt_line_item(p_goods_receipt_item_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_item_id uuid;
  v_next_id uuid;
  v_seen uuid[];
  v_hops integer := 0;
begin
  if p_goods_receipt_item_id is null then
    return null;
  end if;

  -- 1. Append-only ledgers written when the receipt is posted.
  select m.kitchen_inventory_item_id
    into v_item_id
    from public.q7_inventory_movements m
   where m.source = 'goods_receipt'
     and m.source_ref_key = 'gr-item:' || p_goods_receipt_item_id::text
   order by m.created_at desc, m.id desc
   limit 1;

  if v_item_id is null then
    select m.kitchen_inventory_item_id
      into v_item_id
      from public.tan_tao_material_movements m
     where m.source = 'goods_receipt'
       and m.source_ref_key = 'gr-item:' || p_goods_receipt_item_id::text
     order by m.created_at desc, m.id desc
     limit 1;
  end if;

  -- 2. Learned alias for the same supplier / location / normalized name.
  if v_item_id is null then
    select a.kitchen_inventory_item_id
      into v_item_id
      from public.stock_material_aliases a
      join public.goods_receipt_items gri on gri.id = p_goods_receipt_item_id
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
     where a.location = coalesce(nullif(btrim(gr.receiving_location), ''), 'tan_tao')
       and a.normalized_name = public.normalize_stock_item_name(
             coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
           )
       and a.supplier_id is not distinct from gr.supplier_id
       and a.status is distinct from 'disabled'
       and a.kitchen_inventory_item_id is not null
     order by a.last_confirmed_at desc nulls last,
              a.updated_at desc,
              a.id desc
     limit 1;
  end if;

  if v_item_id is null then
    return null;
  end if;

  -- 3. Follow a merge chain to the live item (bounded, cycle-safe).
  v_seen := array[v_item_id];

  loop
    select kii.merged_into_id
      into v_next_id
      from public.kitchen_inventory_items kii
     where kii.id = v_item_id;

    exit when v_next_id is null;
    exit when v_next_id = any (v_seen);
    exit when v_hops >= 10;

    v_seen := v_seen || v_next_id;
    v_item_id := v_next_id;
    v_hops := v_hops + 1;
  end loop;

  return v_item_id;
end;
$$;

revoke all on function public.kho_receipt_line_item(uuid) from public, anon;
grant execute on function public.kho_receipt_line_item(uuid) to service_role;

-- Same gate and JSON keys as 20261102850000, but item_id/name now come from
-- the real kitchen item resolved above.
create or replace function public.kho_expiry_overview(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_days integer := coalesce(p_days, 30);
  v_result jsonb;
begin
  if v_days < 0 or v_days > 3650 then
    raise exception 'invalid_days' using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not (
      public.q7_material_inventory_can_view(v_actor)
      or public.stock_count_can_view('tan_tao')
      or public.stock_count_can_view('q7')
      or public.kho_item_can_edit(v_actor)
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'batch_id', x.batch_id,
           'item_id', x.item_id,
           'sku_id', x.sku_id,
           'name', x.name,
           'kho', x.kho,
           'receipt_number', x.receipt_number,
           'received_date', x.received_date,
           'quantity', x.quantity,
           'unit', x.unit,
           'manufacture_date', x.manufacture_date,
           'expiry_date', x.expiry_date,
           'days_left', x.days_left,
           'manufacturer_lot', x.manufacturer_lot,
           'manufacturer_name', x.manufacturer_name
         ) order by x.expiry_date, x.received_date, x.batch_id), '[]'::jsonb)
    into v_result
    from (
      select b.id as batch_id,
             kii.id as item_id,
             b.sku_id,
             coalesce(kii.name, ps.product_name, b.batch_number) as name,
             coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') as kho,
             gr.receipt_number,
             b.received_date,
             b.quantity,
             b.unit,
             b.manufacture_date,
             b.expiry_date,
             (b.expiry_date - current_date)::integer as days_left,
             b.manufacturer_lot,
             fm.name as manufacturer_name
        from public.inventory_batches b
        join public.goods_receipts gr on gr.id = b.goods_receipt_id
        left join public.suppliers s on s.id = gr.supplier_id
        left join lateral (
          select kii2.id, kii2.name
            from public.kitchen_inventory_items kii2
           where kii2.id = public.kho_receipt_line_item(b.goods_receipt_item_id)
        ) kii on true
        left join public.product_skus ps on ps.id = b.sku_id
        left join public.food_manufacturers fm on fm.id = b.manufacturer_id
       where b.expiry_date is not null
         and b.expiry_date <= current_date + v_days
         and b.received_date >= current_date - 365
    ) x;

  return v_result;
end;
$$;

revoke all on function public.kho_expiry_overview(integer) from public, anon;
grant execute on function public.kho_expiry_overview(integer) to authenticated, service_role;

-- ===========================================================================
-- B. One shelf-life source: product_label_specs.shelf_life_days
-- ===========================================================================

drop function if exists public.sku_set_shelf_life(uuid, integer, uuid);

-- The column was added on 23/10 and is still empty.  Refuse to drop it if a
-- row already carries a value, so no shelf life is silently lost.
do $shelf_life_guard$
begin
  if exists (
    select 1
      from public.product_skus ps
     where ps.shelf_life_days is not null
  ) then
    raise exception 'product_skus_shelf_life_days_not_empty'
      using errcode = '23514',
            hint = 'Move the values to product_label_specs.shelf_life_days before dropping the legacy column.';
  end if;
end;
$shelf_life_guard$;

alter table public.product_skus
  drop constraint if exists product_skus_shelf_life_days_check;

alter table public.product_skus
  drop column if exists shelf_life_days;

-- ===========================================================================
-- C. KFM trace candidates + report
-- ===========================================================================

create or replace function public.kho_trace_candidates(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not (
      public.q7_material_inventory_can_view(v_actor)
      or public.stock_count_can_view('tan_tao')
      or public.stock_count_can_view('q7')
      or public.kho_item_can_edit(v_actor)
      or public.has_module_permission(v_actor, 'production', 'view')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'production_order_item_id', x.production_order_item_id,
           'production_number', x.production_number,
           'production_date', x.production_date,
           'sku_id', x.sku_id,
           'sku_code', x.sku_code,
           'product_name', x.product_name,
           'qty', x.qty,
           'unit', x.unit,
           'location_code', x.location_code,
           'has_issue', x.has_issue
         ) order by x.production_date desc nulls last, x.created_at desc, x.production_order_item_id desc),
         '[]'::jsonb)
    into v_result
    from (
      select poi.id as production_order_item_id,
             po.production_number,
             coalesce(po.planned_start_date, po.completed_at::date) as production_date,
             poi.sku_id,
             ps.sku_code,
             coalesce(nullif(btrim(poi.product_name), ''), ps.product_name) as product_name,
             coalesce(nullif(poi.actual_qty, 0), poi.planned_qty, poi.ordered_qty) as qty,
             poi.unit,
             po.location_code,
             exists (
               select 1
                 from public.production_material_issues pmi
                where pmi.production_order_id = po.id
                  and (pmi.is_current is true or pmi.superseded_by_issue_id is null)
             ) as has_issue,
             poi.created_at
        from public.production_order_items poi
        join public.production_orders po on po.id = poi.production_order_id
        left join public.product_skus ps on ps.id = poi.sku_id
       where (p_from is null or coalesce(po.planned_start_date, po.completed_at::date) >= p_from)
         and (p_to is null or coalesce(po.planned_start_date, po.completed_at::date) <= p_to)
       order by production_date desc nulls last, poi.created_at desc, poi.id desc
       limit 200
    ) x;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.kho_trace_candidates(date, date) from public, anon;
grant execute on function public.kho_trace_candidates(date, date) to authenticated, service_role;

create or replace function public.kho_trace_report(p_production_order_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.production_order_items%rowtype;
  v_order public.production_orders%rowtype;
  v_issue_id uuid;
  v_issue_date date;
  v_sku_code text;
  v_production_date date;
  v_qty numeric;
  v_shelf_life integer;
  v_expiry date;
  v_missing jsonb := '[]'::jsonb;
  v_materials jsonb := '[]'::jsonb;
  v_item_ids uuid[] := array[]::uuid[];
  v_manufacturer_ids uuid[] := array[]::uuid[];
  v_lots jsonb;
  v_row_missing jsonb;
  v_mat record;
  v_lot record;
  v_default_manufacturer uuid;
  v_manufacturer_id uuid;
  v_section text;
  v_item_id uuid;
  v_required numeric;
  v_unit text;
  v_lot_prefix text;
  v_semi jsonb;
  v_certificates jsonb;
  v_company_certificates jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not (
      public.q7_material_inventory_can_view(v_actor)
      or public.stock_count_can_view('tan_tao')
      or public.stock_count_can_view('q7')
      or public.kho_item_can_edit(v_actor)
      or public.has_module_permission(v_actor, 'production', 'view')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select *
    into v_item
    from public.production_order_items poi
   where poi.id = p_production_order_item_id;

  if not found then
    raise exception 'production_order_item_not_found' using errcode = 'P0002';
  end if;

  select *
    into v_order
    from public.production_orders po
   where po.id = v_item.production_order_id;

  if not found then
    raise exception 'production_order_not_found' using errcode = 'P0002';
  end if;

  v_production_date := coalesce(v_order.planned_start_date, v_order.completed_at::date);
  -- actual_qty is 0 until the batch is made; fall back to the plan.
  v_qty := coalesce(nullif(v_item.actual_qty, 0), v_item.planned_qty, v_item.ordered_qty);

  select ps.sku_code
    into v_sku_code
    from public.product_skus ps
   where ps.id = v_item.sku_id;

  select pls.shelf_life_days
    into v_shelf_life
    from public.product_label_specs pls
   where pls.sku_id = v_item.sku_id
   order by pls.updated_at desc, pls.id desc
   limit 1;

  if v_shelf_life is null or v_production_date is null then
    v_expiry := null;
    v_missing := v_missing || '["hsd"]'::jsonb;
  else
    v_expiry := v_production_date + v_shelf_life;
  end if;

  -- Current material issue of the order (is_current / not superseded).
  select pmi.id, pmi.issue_date
    into v_issue_id, v_issue_date
    from public.production_material_issues pmi
   where pmi.production_order_id = v_order.id
     and (pmi.is_current is true or pmi.superseded_by_issue_id is null)
   order by pmi.revision desc, pmi.created_at desc, pmi.id desc
   limit 1;

  if v_issue_id is not null then
    for v_mat in
      select pii.kitchen_inventory_item_id as item_id,
             sum(pii.required_qty) as required_qty,
             max(kii.name) as name,
             max(kii.item_code) as item_code,
             case
               when max(coalesce(kii.item_class, '')) = 'raw_material' then 'raw'
               else 'packaging'
             end as section,
             max(coalesce(nullif(btrim(pii.unit), ''), kii.unit)) as unit,
             min(kii.default_manufacturer_id::text)::uuid as default_manufacturer_id
        from public.production_material_issue_items pii
        join public.kitchen_inventory_items kii on kii.id = pii.kitchen_inventory_item_id
       where pii.material_issue_id = v_issue_id
         and (
           (v_item.sku_id is not null and pii.finished_sku_id = v_item.sku_id)
           or (
             pii.production_order_item_id = v_item.id
             and not exists (
               select 1
                 from public.production_material_issue_items x
                where x.material_issue_id = v_issue_id
                  and v_item.sku_id is not null
                  and x.finished_sku_id = v_item.sku_id
             )
           )
         )
       group by pii.kitchen_inventory_item_id
       order by
         (case when max(coalesce(kii.item_class, '')) = 'raw_material' then 0 else 1 end),
         max(kii.name),
         pii.kitchen_inventory_item_id
    loop
      v_item_id := v_mat.item_id;
      v_required := v_mat.required_qty;
      v_section := v_mat.section;
      v_unit := v_mat.unit;
      v_default_manufacturer := v_mat.default_manufacturer_id;

      v_item_ids := array_append(v_item_ids, v_item_id);

      if v_default_manufacturer is not null
         and not (v_default_manufacturer = any (v_manufacturer_ids)) then
        v_manufacturer_ids := array_append(v_manufacturer_ids, v_default_manufacturer);
      end if;

      -- Receipt lots that resolve to this kitchen item, newest receipt first.
      -- Stop as soon as the running quantity covers the required quantity
      -- (max 3 lots).  goods_receipt_status only has draft/confirmed/received;
      -- draft lines never carry posted stock, so confirmed/received are the
      -- real non-cancelled receipts.
      select coalesce(jsonb_agg(jsonb_build_object(
               'receipt_number', l.receipt_number,
               'received_date', l.received_date,
               'quantity', l.quantity,
               'unit', l.unit,
               'manufacture_date', l.manufacture_date,
               'expiry_date', l.expiry_date,
               'manufacturer_lot', l.manufacturer_lot,
               'lot_code', coalesce(l.manufacturer_lot, l.batch_number),
               'lot_code_internal', (l.manufacturer_lot is null and l.batch_number is not null),
               'manufacturer_id', l.manufacturer_id,
               'manufacturer_name', l.manufacturer_name,
               'supplier_name', l.supplier_name
             ) order by l.received_date desc, l.created_at desc, l.id desc), '[]'::jsonb)
        into v_lots
        from (
          select *
            from (
              select gri.id,
                     gr.receipt_number,
                     gr.receipt_date as received_date,
                     coalesce(gri.actual_quantity, gri.quantity, 0) as quantity,
                     gri.unit,
                     gri.manufacture_date,
                     gri.expiry_date,
                     nullif(btrim(gri.manufacturer_lot), '') as manufacturer_lot,
                     (
                       select b.batch_number
                         from public.inventory_batches b
                        where b.goods_receipt_item_id = gri.id
                        order by b.created_at, b.id
                        limit 1
                     ) as batch_number,
                     coalesce(gri.manufacturer_id, v_default_manufacturer) as manufacturer_id,
                     fm.name as manufacturer_name,
                     s.name as supplier_name,
                     gri.created_at,
                     sum(coalesce(gri.actual_quantity, gri.quantity, 0)) over (
                       order by gr.receipt_date desc, gri.created_at desc, gri.id desc
                     ) as running_qty,
                     row_number() over (
                       order by gr.receipt_date desc, gri.created_at desc, gri.id desc
                     ) as rn
                from public.goods_receipt_items gri
                join public.goods_receipts gr on gr.id = gri.goods_receipt_id
                left join public.suppliers s on s.id = gr.supplier_id
                left join public.food_manufacturers fm
                  on fm.id = coalesce(gri.manufacturer_id, v_default_manufacturer)
               where public.kho_receipt_line_item(gri.id) = v_item_id
                 and v_issue_date is not null
                 and gr.receipt_date <= v_issue_date
                 and gr.status in ('confirmed', 'received')
            ) running
           -- Receipt and issue units often differ (gói vs g); only sum lots
           -- toward the required quantity when the units match, otherwise
           -- show the newest lot alone.
           where (coalesce(v_required, 0) > 0
                  and lower(coalesce(running.unit, '')) = lower(coalesce(v_unit, ''))
                  and running.running_qty - running.quantity < v_required)
              or ((coalesce(v_required, 0) <= 0
                   or lower(coalesce(running.unit, '')) <> lower(coalesce(v_unit, '')))
                  and running.rn = 1)
           order by running.received_date desc, running.created_at desc, running.id desc
           limit 3
        ) l;

      -- Collect the line manufacturers used by these lots for certificates.
      for v_lot in
        select value
          from jsonb_array_elements(v_lots) e(value)
      loop
        v_manufacturer_id := nullif(v_lot.value->>'manufacturer_id', '')::uuid;
        if v_manufacturer_id is not null
           and not (v_manufacturer_id = any (v_manufacturer_ids)) then
          v_manufacturer_ids := array_append(v_manufacturer_ids, v_manufacturer_id);
        end if;
      end loop;

      v_row_missing := '[]'::jsonb;

      if jsonb_array_length(v_lots) = 0 then
        v_row_missing := v_row_missing || '["lot", "receipt"]'::jsonb;
        if v_section = 'raw' then
          v_row_missing := v_row_missing || '["nsx", "hsd"]'::jsonb;
        end if;
        if v_default_manufacturer is null then
          v_row_missing := v_row_missing || '["manufacturer"]'::jsonb;
        end if;
      else
        if not exists (
          select 1
            from jsonb_array_elements(v_lots) e
           where nullif(e.value->>'lot_code', '') is not null
        ) then
          v_row_missing := v_row_missing || '["lot"]'::jsonb;
        end if;

        if not exists (
          select 1
            from jsonb_array_elements(v_lots) e
           where nullif(e.value->>'manufacturer_name', '') is not null
        ) then
          v_row_missing := v_row_missing || '["manufacturer"]'::jsonb;
        end if;

        if v_section = 'raw' and not exists (
          select 1
            from jsonb_array_elements(v_lots) e
           where nullif(e.value->>'manufacture_date', '') is not null
        ) then
          v_row_missing := v_row_missing || '["nsx"]'::jsonb;
        end if;

        if v_section = 'raw' and not exists (
          select 1
            from jsonb_array_elements(v_lots) e
           where nullif(e.value->>'expiry_date', '') is not null
        ) then
          v_row_missing := v_row_missing || '["hsd"]'::jsonb;
        end if;

        if not exists (
          select 1
            from jsonb_array_elements(v_lots) e
           where nullif(e.value->>'receipt_number', '') is not null
        ) then
          v_row_missing := v_row_missing || '["receipt"]'::jsonb;
        end if;
      end if;

      v_materials := v_materials || jsonb_build_array(jsonb_build_object(
        'item_id', v_item_id,
        'item_code', v_mat.item_code,
        'name', v_mat.name,
        'section', v_section,
        'required_qty', v_required,
        'unit', v_unit,
        'lots', v_lots,
        'missing', v_row_missing
      ));
    end loop;
  end if;

  -- Non-archived certificates for the materials used by this report.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'cert_type', c.cert_type,
           'cert_no', c.cert_no,
           'issuer', c.issuer,
           'expires_on', c.expires_on,
           'file_path', c.file_path,
           'file_name', c.file_name,
           'mime_type', c.mime_type
         ) order by c.expires_on nulls last, c.created_at desc, c.id), '[]'::jsonb)
    into v_certificates
    from public.food_safety_certificates c
   where c.archived_at is null
     and c.owner_kind <> 'company'
     and (v_production_date is null or c.expires_on is null or c.expires_on >= v_production_date)
     and (
       (c.item_id is not null and c.item_id = any (v_item_ids))
       or (c.manufacturer_id is not null and c.manufacturer_id = any (v_manufacturer_ids))
     );

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'cert_type', c.cert_type,
           'cert_no', c.cert_no,
           'issuer', c.issuer,
           'expires_on', c.expires_on,
           'file_path', c.file_path,
           'file_name', c.file_name,
           'mime_type', c.mime_type
         ) order by c.expires_on nulls last, c.created_at desc, c.id), '[]'::jsonb)
    into v_company_certificates
    from public.food_safety_certificates c
   where c.archived_at is null
     and c.owner_kind = 'company'
     and (v_production_date is null or c.expires_on is null or c.expires_on >= v_production_date);

  v_lot_prefix := case
    when v_sku_code is not null and v_production_date is not null
      then upper(split_part(v_sku_code, '-', 1)) || to_char(v_production_date, 'DDMMYYYY')
    else null
  end;

  v_semi := jsonb_build_array(
    jsonb_build_object(
      'name', 'Lô bánh ủ',
      'production_date', v_production_date,
      'qty', v_qty,
      'remaining', case
        when coalesce(v_item.actual_qty, 0) > 0 and v_item.ordered_qty is not null
          then greatest(v_item.actual_qty - v_item.ordered_qty, 0)
        else null
      end,
      'lot_code', case when v_lot_prefix is null then null else v_lot_prefix || ' Ủ' end
    ),
    jsonb_build_object(
      'name', 'Vỏ bánh',
      'production_date', v_production_date,
      'qty', v_qty,
      'remaining', case
        when coalesce(v_item.actual_qty, 0) > 0 and v_item.ordered_qty is not null
          then greatest(v_item.actual_qty - v_item.ordered_qty, 0)
        else null
      end,
      'lot_code', v_lot_prefix
    )
  );

  return jsonb_build_object(
    'production_order_item_id', v_item.id,
    'product_name', coalesce(nullif(btrim(v_item.product_name), ''), v_sku_code),
    'sku_code', v_sku_code,
    'production_number', v_order.production_number,
    'production_date', v_production_date,
    'qty', v_qty,
    'unit', v_item.unit,
    'shelf_life_days', v_shelf_life,
    'expiry_date', v_expiry,
    'missing', v_missing,
    'materials', v_materials,
    'certificates', v_certificates,
    'company_certificates', v_company_certificates,
    'semi_finished', v_semi
  );
end;
$$;

revoke all on function public.kho_trace_report(uuid) from public, anon;
grant execute on function public.kho_trace_report(uuid) to authenticated, service_role;

-- ===========================================================================
-- D. Food-certificate reminders (30 / 7 / 0 days) into the Zalo outbox
-- ===========================================================================
-- Pending mission notifications are claimed every 2 minutes by the existing
-- 'mission-zalo-notify-every-2-min' pg_cron job, which calls the
-- mission-zalo-notify Edge Function.  That worker sends message_body for every
-- event type, so a food_cert_expiry row needs no extra dispatch plumbing.

alter table public.mission_zalo_notifications
  drop constraint if exists mission_zalo_notifications_event_type_check;

alter table public.mission_zalo_notifications
  add constraint mission_zalo_notifications_event_type_check
  check (event_type in (
    'assigned',
    'submitted',
    'approved',
    'returned',
    'due_soon',
    'overdue',
    'food_cert_expiry'
  ));

create or replace function public.enqueue_food_cert_expiry_reminders(
  p_today date default (now() at time zone 'Asia/Ho_Chi_Minh')::date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cert record;
  v_threshold integer;
  v_days_left integer;
  v_type_label text;
  v_body text;
  v_rows integer := 0;
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is not null and not public.has_role(v_actor, 'owner') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_today is null then
    raise exception 'invalid_today' using errcode = '22023';
  end if;

  for v_cert in
    select c.id,
           c.cert_type,
           c.cert_no,
           c.expires_on,
           (c.expires_on - p_today)::integer as days_left,
           case c.owner_kind
             when 'manufacturer' then fm.name
             when 'item' then kii.name
             when 'supplier' then s.name
             when 'company' then 'Công ty'
             else null
           end as owner_name
      from public.food_safety_certificates c
      left join public.food_manufacturers fm on fm.id = c.manufacturer_id
      left join public.kitchen_inventory_items kii on kii.id = c.item_id
      left join public.suppliers s on s.id = c.supplier_id
     where c.archived_at is null
       and c.expires_on is not null
     order by c.expires_on, c.created_at, c.id
  loop
    v_days_left := v_cert.days_left;

    -- Remind at 30, 7 and 0 days, plus one day of grace so an expired
    -- certificate still produces its single 0-day notice.
    if v_days_left > 30 or v_days_left < -1 then
      continue;
    end if;

    v_threshold := case
      when v_days_left <= 0 then 0
      when v_days_left <= 7 then 7
      else 30
    end;

    v_type_label := case v_cert.cert_type
      when 'attp_facility' then 'Giấy chứng nhận cơ sở đủ điều kiện ATTP'
      when 'coa' then 'Phiếu kiểm nghiệm (COA)'
      when 'product_declaration' then 'Bản công bố sản phẩm'
      else 'Giấy tờ khác'
    end;

    v_body := (case
        when v_days_left <= 0 then 'Giấy ATTP hết hạn hôm nay'
        else 'Giấy ATTP sắp hết hạn'
      end)
      || ': ' || v_type_label
      || E'\n' || 'Đơn vị: ' || left(coalesce(v_cert.owner_name, 'Công ty'), 200)
      || E'\n' || 'Số giấy: ' || left(coalesce(nullif(btrim(v_cert.cert_no), ''), 'chưa có'), 120)
      || E'\n' || 'Ngày hết hạn: ' || to_char(v_cert.expires_on, 'DD/MM/YYYY')
      || E'\n' || 'Xem: https://ai.banhmique.vn/warehouse/ho-so-attp';

    insert into public.mission_zalo_notifications (
      event_type,
      mission_id,
      batch_id,
      dedupe_key,
      message_body,
      status,
      next_attempt_at
    ) values (
      'food_cert_expiry',
      null,
      null,
      'food-cert:' || v_cert.id::text || ':' || v_threshold::text || ':' || v_cert.expires_on::text,
      left(v_body, 4000),
      'pending',
      now()
    )
    on conflict (dedupe_key) do nothing;

    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.enqueue_food_cert_expiry_reminders(date) from public, anon;
grant execute on function public.enqueue_food_cert_expiry_reminders(date) to authenticated, service_role;

do $food_cert_cron$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'food-cert-expiry-reminders-daily'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'food-cert-expiry-reminders-daily',
    '0 1 * * *',
    $job$ select public.enqueue_food_cert_expiry_reminders(); $job$
  );
end;
$food_cert_cron$;
