-- 2026-11-02 — Ngưng kinh doanh SKU (phần nền).
--
-- Owner request: a finished-goods SKU can be marked discontinued without
-- deleting it. Discontinued SKUs disappear from the Q7 finished-goods shelf,
-- the Tân Tạo finished-goods items and the dealer catalog / dealer order
-- validation, while every ledger row and all history stay untouched.
--
-- The Maestro applies this migration; it is not applied by this change.

-- ===========================================================================
-- 1. product_skus.discontinued_at / discontinued_by
-- ===========================================================================

alter table public.product_skus
  add column if not exists discontinued_at timestamptz,
  add column if not exists discontinued_by uuid;

-- ===========================================================================
-- 2. Idempotency ledger: one row per client request id
-- ===========================================================================

create table if not exists public.sku_discontinue_requests (
  request_id uuid primary key,
  sku_id uuid not null references public.product_skus(id),
  value boolean not null,
  created_at timestamptz default now(),
  created_by uuid
);

alter table public.sku_discontinue_requests enable row level security;

-- No client policies: only the SECURITY DEFINER RPC below writes/reads this table.
revoke all on table public.sku_discontinue_requests from public, anon, authenticated;

-- ===========================================================================
-- 3. set_sku_discontinued — same permission gate as public.save_sku_cogs
-- ===========================================================================

create or replace function public.set_sku_discontinued(
  p_sku_id uuid,
  p_value boolean,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  v_discontinued_at timestamptz;
begin
  if actor_id is null or not (public.has_role(actor_id, 'owner') or public.has_role(actor_id, 'staff') or public.has_role(actor_id, 'warehouse')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (select 1 from public.product_skus ps where ps.id = p_sku_id) then
    raise exception 'sku_not_found' using errcode = 'P0002';
  end if;

  -- Serialize concurrent retries carrying the same request id.
  perform pg_advisory_xact_lock(hashtextextended('sku_discontinue:' || p_request_id::text, 0));

  -- Same request id: return the current state without a second change.
  if exists (select 1 from public.sku_discontinue_requests r where r.request_id = p_request_id) then
    select ps.discontinued_at into v_discontinued_at
    from public.product_skus ps
    where ps.id = p_sku_id;
    return jsonb_build_object('sku_id', p_sku_id, 'discontinued_at', v_discontinued_at);
  end if;

  insert into public.sku_discontinue_requests (request_id, sku_id, value, created_by)
  values (p_request_id, p_sku_id, p_value, actor_id);

  update public.product_skus ps
  set discontinued_at = case when p_value then coalesce(ps.discontinued_at, now()) else null end,
      discontinued_by = case when p_value then actor_id else null end
  where ps.id = p_sku_id
  returning ps.discontinued_at into v_discontinued_at;

  return jsonb_build_object('sku_id', p_sku_id, 'discontinued_at', v_discontinued_at);
end;
$$;

revoke all on function public.set_sku_discontinued(uuid, boolean, uuid) from public, anon;
grant execute on function public.set_sku_discontinued(uuid, boolean, uuid) to authenticated;

-- ===========================================================================
-- 4. get_warehouse_game_snapshot — hide discontinued finished-goods SKUs
--    (copy of 20261101340000 with one filter per finished-goods SKU list)
-- ===========================================================================

create or replace function public.get_warehouse_game_snapshot(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_cutover date;
  v_items jsonb := '[]'::jsonb;
  v_skus jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_transfers jsonb := '[]'::jsonb;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;

  -- Same reader gate as public.get_stock_ledger_overview(p_location).
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if p_location = 'q7' then
      if not public.q7_material_inventory_can_view(v_actor) then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    else
      if not public.can_view_tan_tao_warehouse() then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    end if;
  end if;

  v_cutover := public.stock_ledger_cutover_date(p_location);

  -- The shared catalog: every live item, for both warehouses.
  if p_location = 'q7' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id,
             'code', x.item_code,
             'name', x.name,
             'unit', x.unit,
             'item_class', x.item_class,
             'on_hand', x.on_hand,
             'last_count_date', x.last_count_date,
             'aliases', x.aliases,
             'pastry_q7', x.pastry_q7
           ) order by x.name), '[]'::jsonb)
    into v_items
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
             coalesce(kii.item_class, 'unclassified') as item_class,
             kii.pastry_q7,
             (
               coalesce(o.opening_qty, 0)
               + coalesce(mt.receipt_qty, 0)
               - coalesce(mt.usage_qty, 0)
               + coalesce(mt.adjustment_qty, 0)
             ) as on_hand,
             (
               select max(m.movement_date)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'q7-stock-count:%'
                 and m.movement_date <= v_as_of
             ) as last_count_date,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'normalized_name', a.normalized_name,
                        'status', a.status,
                        'line_class', a.line_class,
                        'supplier_name', sup.name
                      ) order by a.normalized_name)
               from public.stock_material_aliases a
               left join public.suppliers sup on sup.id = a.supplier_id
               where a.kitchen_inventory_item_id = kii.id
                 and a.location = p_location
             ), '[]'::jsonb) as aliases
      from public.kitchen_inventory_items kii
      left join lateral (
        select o2.opening_qty, o2.effective_date
        from public.q7_inventory_openings o2
        where o2.kitchen_inventory_item_id = kii.id
          and o2.effective_date <= v_as_of
        order by o2.effective_date desc, o2.updated_at desc, o2.id desc
        limit 1
      ) o on true
      left join lateral (
        select coalesce(sum(m.quantity) filter (where m.movement_type in ('receipt', 'transfer_in')), 0) as receipt_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0) as usage_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0) as adjustment_qty
        from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = kii.id
          and m.movement_date <= v_as_of
          and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
      ) mt on true
      where kii.active = true
        and kii.merged_into_id is null
        and (kii.pastry_q7 = true or exists (select 1 from public.q7_inventory_movements qm where qm.kitchen_inventory_item_id = kii.id))
    ) x;

    -- Finished-goods SKUs at Q7: a ledger row already exists, or the SKU sits on
    -- a Q7 production order line planned within the last 30 days. on_hand is the
    -- sum of the SKU's finished-goods ledger rows.
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', ps.id,
             'sku_code', ps.sku_code,
             'product_name', ps.product_name,
             'unit', ps.unit,
             'on_hand', coalesce((
               select sum(m.quantity)
               from public.q7_finished_goods_movements m
               where m.sku_id = ps.id
             ), 0)
           ) order by ps.sku_code), '[]'::jsonb)
    into v_skus
    from public.product_skus ps
    where (
        exists (
          select 1
          from public.q7_finished_goods_movements m
          where m.sku_id = ps.id
        )
        or exists (
          select 1
          from public.production_order_items poi
          join public.production_orders po on po.id = poi.production_order_id
          where poi.sku_id = ps.id
            and po.location_code = 'q7'
            and po.status::text <> 'cancelled'
            and coalesce(po.planned_start_date, po.planned_end_date)
                between v_as_of - 30 and v_as_of
        )
      )
      and ps.discontinued_at is null;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id,
             'code', x.item_code,
             'name', x.name,
             'unit', x.unit,
             'item_class', x.item_class,
             'on_hand', x.on_hand,
             'last_count_date', x.last_count_date,
             'aliases', x.aliases,
             'pastry_q7', x.pastry_q7
           ) order by x.name), '[]'::jsonb)
    into v_items
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
             coalesce(kii.item_class, 'unclassified') as item_class,
             kii.pastry_q7,
             coalesce((
               select sum(case m.movement_type
                            when 'receipt' then m.quantity
                            when 'opening' then m.quantity
                            when 'production_usage' then -m.quantity
                            when 'adjustment' then m.quantity
                            when 'transfer_out' then -m.quantity
                            else 0 end)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.movement_date <= v_as_of
             ), 0) as on_hand,
             (
               select max(m.movement_date)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'tt-material-count:%'
                 and m.movement_date <= v_as_of
             ) as last_count_date,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'normalized_name', a.normalized_name,
                        'status', a.status,
                        'line_class', a.line_class,
                        'supplier_name', sup.name
                      ) order by a.normalized_name)
               from public.stock_material_aliases a
               left join public.suppliers sup on sup.id = a.supplier_id
               where a.kitchen_inventory_item_id = kii.id
                 and a.location = p_location
             ), '[]'::jsonb) as aliases
      from public.kitchen_inventory_items kii
      where kii.active = true
        and kii.merged_into_id is null
    ) x;

    -- Finished-goods SKUs at Tân Tạo (the Q7 branch above builds its own list).
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', ps.id,
             'sku_code', ps.sku_code,
             'product_name', ps.product_name,
             'unit', ps.unit,
             'on_hand', coalesce((
               select sum(m.quantity)
               from public.tan_tao_warehouse_movements m
               where m.sku_id = ps.id
                 and m.location_code = 'warehouse_tan_tao'
             ), 0)
           ) order by ps.sku_code), '[]'::jsonb)
    into v_skus
    from public.product_skus ps
    where ps.sku_type::text = 'finished_good'
      and ps.discontinued_at is null;
  end if;

  -- The backlog review is owner / Q7-admin only. A plain warehouse viewer still
  -- gets the whole snapshot, just with an empty pending list.
  begin
    select coalesce(jsonb_agg(to_jsonb(p) order by p.line_count desc, p.normalized_name, p.supplier_id), '[]'::jsonb)
    into v_pending
    from public.get_material_alias_backlog_review(p_location, 200) p;
  exception when insufficient_privilege then
    v_pending := '[]'::jsonb;
  end;

  select coalesce(jsonb_object_agg(g.cls, g.n), '{}'::jsonb)
  into v_counts
  from (
    select coalesce(kii.item_class, 'unclassified') as cls, count(*)::numeric as n
    from public.kitchen_inventory_items kii
    where kii.active = true
      and kii.merged_into_id is null
    group by 1
  ) g;

  select coalesce(jsonb_agg(jsonb_build_object(
           'transfer_number', t.transfer_number,
           'transfer_date', t.transfer_date,
           'item_id', t.kitchen_inventory_item_id,
           'item_name', kii.name,
           'quantity', t.quantity,
           'unit', t.unit,
           'receipt_number', gr.receipt_number
         ) order by t.created_at desc, t.id desc), '[]'::jsonb)
  into v_transfers
  from (
    select st.*
    from public.stock_transfers st
    order by st.created_at desc, st.id desc
    limit 20
  ) t
  join public.kitchen_inventory_items kii on kii.id = t.kitchen_inventory_item_id
  left join public.goods_receipt_items gri on gri.id = t.goods_receipt_item_id
  left join public.goods_receipts gr on gr.id = gri.goods_receipt_id;

  return jsonb_build_object(
    'location', p_location,
    'cutover_date', v_cutover,
    'items', v_items,
    'skus', v_skus,
    'pending', v_pending,
    'counts', v_counts,
    'transfers', v_transfers,
    'can_edit', public.q7_material_inventory_can_edit(v_actor)
  );
end;
$$;

revoke all on function public.get_warehouse_game_snapshot(text) from public, anon;
grant execute on function public.get_warehouse_game_snapshot(text) to authenticated, service_role;

-- ===========================================================================
-- 5. get_tan_tao_warehouse_snapshot — hide discontinued finished-goods items
--    (copy of 20260824135513 with one filter in the item_rows list)
-- ===========================================================================

create or replace function public.get_tan_tao_warehouse_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_allowed_skus text[] := array['bmq-001','bmq-002','pate-500g','pate-200g'];
  v_items jsonb := '[]'::jsonb;
  v_bmq jsonb := '{}'::jsonb;
begin
  if not public.can_view_tan_tao_warehouse() then raise exception 'forbidden' using errcode = '42501'; end if;

  with sku_order(sku_code, sort_order, operational_name, operational_unit) as (
    values
      ('BMQ-001', 1, 'Bánh mì tươi', 'que'),
      ('BMQ-002', 2, 'Bánh mì đông lạnh', 'que'),
      ('PATE-500G', 3, 'Pate 500g', 'hộp'),
      ('PATE-200G', 4, 'Pate 200g', 'hộp')
  ), item_rows as (
    select
      s.sort_order,
      s.sku_code,
      ps.id as sku_id,
      s.operational_name as product_name,
      s.operational_unit as unit,
      coalesce(m.on_hand_quantity, 0) as on_hand_quantity,
      coalesce(r.reserved_quantity, 0) as reserved_quantity,
      coalesce(i.incoming_quantity, 0) as incoming_quantity,
      coalesce(docs.recent_documents, '[]'::jsonb) as recent_documents
    from sku_order s
    left join public.product_skus ps on ps.sku_code = s.sku_code
    left join lateral (
      select coalesce(sum(m.quantity), 0) as on_hand_quantity
      from public.tan_tao_warehouse_movements m
      where m.location_code = 'warehouse_tan_tao' and m.sku_id = ps.id
    ) m on true
    left join lateral (
      select coalesce(sum(r.quantity), 0) as reserved_quantity
      from public.tan_tao_warehouse_reservations r
      where r.location_code = 'warehouse_tan_tao' and r.sku_id = ps.id and r.status = 'active'
    ) r on true
    left join lateral (
      select coalesce(sum(greatest(d.quantity - coalesce(received.received_quantity, 0), 0)), 0) as incoming_quantity
      from public.tan_tao_warehouse_documents d
      left join lateral (
        select sum(rd.quantity) as received_quantity
        from public.tan_tao_warehouse_documents rd
        where rd.source_document_id = d.id and rd.document_type = 'receipt' and rd.status = 'posted'
      ) received on true
      where d.location_code = 'warehouse_tan_tao' and d.sku_id = ps.id and d.document_type = 'supplier_order' and d.status = 'expected'
    ) i on true
    left join lateral (
      select coalesce(jsonb_agg(to_jsonb(recent_row) order by recent_row.created_at desc), '[]'::jsonb) as recent_documents
      from (
        select d.id, d.document_number, d.document_type, d.status, d.quantity, d.ordered_quantity,
               d.exchange_quantity, d.makeup_quantity, d.physical_quantity,
               d.supplier_billable_quantity, d.supplier_credit_quantity,
               d.supplier_exchange_quantity, d.supplier_makeup_quantity,
               d.reference_label, d.note, d.created_at,
               d.sku_code_snapshot as sku_code
        from public.tan_tao_warehouse_documents d
        where d.location_code = 'warehouse_tan_tao' and d.sku_id = ps.id
        order by d.created_at desc
        limit 10
      ) recent_row
    ) docs on true
    where ps.id is null or ps.discontinued_at is null
  ), shaped as (
    select
      item_row.sort_order,
      jsonb_build_object(
        'sku_id', item_row.sku_id,
        'sku_code', item_row.sku_code,
        'product_name', item_row.product_name,
        'unit', item_row.unit,
        'on_hand_quantity', item_row.on_hand_quantity,
        'reserved_quantity', item_row.reserved_quantity,
        'atp_quantity', item_row.on_hand_quantity - item_row.reserved_quantity,
        'incoming_quantity', item_row.incoming_quantity,
        'projected_quantity', item_row.on_hand_quantity + item_row.incoming_quantity - item_row.reserved_quantity,
        'needs_attention', (item_row.on_hand_quantity - item_row.reserved_quantity) < 0,
        'recent_documents', item_row.recent_documents
      ) as item_row
    from item_rows item_row
  )
  select coalesce(jsonb_agg(item_row order by sort_order), '[]'::jsonb),
         coalesce((jsonb_agg(item_row order by sort_order) filter (where item_row->>'sku_code' = 'BMQ-001'))->0, '{}'::jsonb)
  into v_items, v_bmq
  from shaped;

  return jsonb_build_object(
    'location_code', 'warehouse_tan_tao',
    'location_name', 'Kho Tân Tạo',
    'sku_id', v_bmq->>'sku_id',
    'sku_code', 'BMQ-001',
    'unit', 'que',
    'on_hand_quantity', coalesce((v_bmq->>'on_hand_quantity')::numeric, 0),
    'reserved_quantity', coalesce((v_bmq->>'reserved_quantity')::numeric, 0),
    'atp_quantity', coalesce((v_bmq->>'atp_quantity')::numeric, 0),
    'incoming_quantity', coalesce((v_bmq->>'incoming_quantity')::numeric, 0),
    'projected_quantity', coalesce((v_bmq->>'projected_quantity')::numeric, 0),
    'needs_attention', coalesce((v_bmq->>'needs_attention')::boolean, false),
    'recent_documents', coalesce(v_bmq->'recent_documents', '[]'::jsonb),
    'can_manage', public.can_manage_tan_tao_warehouse(),
    'items', v_items
  );
end;
$$;
revoke all on function public.get_tan_tao_warehouse_snapshot() from public, anon;
grant execute on function public.get_tan_tao_warehouse_snapshot() to authenticated, service_role;
