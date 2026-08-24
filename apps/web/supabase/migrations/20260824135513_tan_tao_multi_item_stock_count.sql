-- Multi-item physical stock counts for Kho Tân Tạo.
-- Local implementation only: no warehouse document/movement/reservation backfill.
-- Pate SKUs are created only by exact sku_code; không fuzzy map nhãn/tem pate.

alter table public.tan_tao_warehouse_documents
  drop constraint if exists tan_tao_warehouse_documents_sku_check;
alter table public.tan_tao_warehouse_documents
  add constraint tan_tao_warehouse_documents_sku_check
  check (upper(sku_code_snapshot) in ('BMQ-001','BMQ-002','PATE-500G','PATE-200G'));

alter table public.tan_tao_warehouse_movements
  drop constraint if exists tan_tao_warehouse_movements_sku_check;
alter table public.tan_tao_warehouse_movements
  add constraint tan_tao_warehouse_movements_sku_check
  check (upper(sku_code_snapshot) in ('BMQ-001','BMQ-002','PATE-500G','PATE-200G'));

alter table public.tan_tao_warehouse_reservations
  drop constraint if exists tan_tao_warehouse_reservations_sku_check;
alter table public.tan_tao_warehouse_reservations
  add constraint tan_tao_warehouse_reservations_sku_check
  check (upper(sku_code_snapshot) in ('BMQ-001','BMQ-002','PATE-500G','PATE-200G'));

create index if not exists tan_tao_warehouse_documents_location_sku_created_idx
  on public.tan_tao_warehouse_documents(location_code, sku_id, created_at desc);
create index if not exists tan_tao_warehouse_movements_location_sku_idx
  on public.tan_tao_warehouse_movements(location_code, sku_id);
create index if not exists tan_tao_warehouse_reservations_location_sku_status_idx
  on public.tan_tao_warehouse_reservations(location_code, sku_id, status);

select set_config('material_master.sku_cogs_save', 'save_sku_cogs', true);

insert into public.product_skus (
  sku_code,
  product_name,
  unit,
  category,
  base_unit,
  finished_output_qty,
  finished_output_unit,
  cost_values,
  cost_widgets,
  hide_from_dealer_portal,
  sku_type,
  notes
)
values
  ('PATE-500G', 'Pate 500g', 'hộp', 'Thành phẩm', 'hộp', 1, 'hộp', '{}'::jsonb, '{}'::jsonb, true, 'finished_good', 'Kho Tân Tạo quantity-tracked Pate 500g SKU'),
  ('PATE-200G', 'Pate 200g', 'hộp', 'Thành phẩm', 'hộp', 1, 'hộp', '{}'::jsonb, '{}'::jsonb, true, 'finished_good', 'Kho Tân Tạo quantity-tracked Pate 200g SKU')
on conflict (sku_code) do nothing;

do $$
declare
  v_bad text;
begin
  select string_agg(sku_code, ', ' order by sku_code) into v_bad
  from public.product_skus
  where sku_code in ('PATE-500G','PATE-200G')
    and not (
      (sku_code = 'PATE-500G' and product_name = 'Pate 500g' and unit = 'hộp' and sku_type::text = 'finished_good' and hide_from_dealer_portal is true)
      or (sku_code = 'PATE-200G' and product_name = 'Pate 200g' and unit = 'hộp' and sku_type::text = 'finished_good' and hide_from_dealer_portal is true)
    );
  if v_bad is not null then
    raise exception 'existing exact-code Pate SKU has unexpected semantics: %', v_bad using errcode = '23514';
  end if;
end $$;

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

create or replace function public.record_tan_tao_stock_count(
  p_sku_code text,
  p_count numeric,
  p_reason text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_sku_code text := upper(btrim(p_sku_code));
  v_sku_id uuid;
  v_document public.tan_tao_warehouse_documents;
  v_existing public.tan_tao_warehouse_documents;
  v_document_number text;
  v_on_hand numeric := 0;
  v_adjustment numeric := 0;
begin
  if not public.can_manage_tan_tao_warehouse() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_sku_code not in ('BMQ-001','BMQ-002','PATE-500G','PATE-200G') then raise exception 'unsupported_tan_tao_sku' using errcode = '22023'; end if;
  if p_count is null or lower(p_count::text) in ('nan','infinity','-infinity') or p_count < 0 then raise exception 'nonnegative_count_required' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'stock_count_reason_required' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null then raise exception 'idempotency_key_required' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('warehouse_tan_tao:' || v_sku_code, 0));

  select * into v_existing
  from public.tan_tao_warehouse_documents
  where idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.document_type is distinct from 'stock_count'
       or v_existing.sku_code_snapshot is distinct from v_sku_code
       or v_existing.physical_quantity is distinct from p_count
       or v_existing.note is distinct from btrim(p_reason) then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('status', 'existing', 'document', to_jsonb(v_existing), 'snapshot', public.get_tan_tao_warehouse_snapshot());
  end if;

  select id into v_sku_id from public.product_skus where sku_code = v_sku_code order by created_at asc limit 1;
  if v_sku_id is null then raise exception 'tan_tao_sku_not_configured' using errcode = 'P0002'; end if;

  select coalesce(sum(quantity), 0) into v_on_hand
  from public.tan_tao_warehouse_movements
  where location_code = 'warehouse_tan_tao' and sku_id = v_sku_id;
  v_adjustment := p_count - v_on_hand;
  v_document_number := 'TT-STK-' || to_char((now() at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into public.tan_tao_warehouse_documents (
    document_number, location_code, sku_id, sku_code_snapshot, document_type, status,
    quantity, physical_quantity, source_authority, reference_type, reference_label,
    idempotency_key, note, metadata, created_by
  )
  values (
    v_document_number, 'warehouse_tan_tao', v_sku_id, v_sku_code, 'stock_count', 'posted',
    p_count, p_count, 'confirmed_physical_count', 'owner_physical_count', 'Kiểm kê vật lý Kho Tân Tạo',
    btrim(p_idempotency_key), btrim(p_reason),
    jsonb_build_object('system_quantity_before', v_on_hand, 'counted_quantity', p_count, 'adjustment_quantity', v_adjustment),
    v_actor
  )
  returning * into v_document;

  if v_adjustment <> 0 then
    insert into public.tan_tao_warehouse_movements (document_id, location_code, sku_id, sku_code_snapshot, movement_type, quantity, note, created_by)
    values (v_document.id, 'warehouse_tan_tao', v_sku_id, v_sku_code, 'adjustment', v_adjustment, btrim(p_reason), v_actor);
  end if;

  return jsonb_build_object('status', 'created', 'document', to_jsonb(v_document), 'snapshot', public.get_tan_tao_warehouse_snapshot());
end;
$$;
revoke all on function public.record_tan_tao_stock_count(text,numeric,text,text) from public, anon;
grant execute on function public.record_tan_tao_stock_count(text,numeric,text,text) to authenticated, service_role;
