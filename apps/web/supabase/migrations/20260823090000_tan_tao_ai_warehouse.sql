-- Chat-first, location-scoped finished-goods ledger for Kho Tân Tạo.
-- MVP scope is intentionally limited to BMQ-001. Stock is derived from immutable
-- movements; supplier orders and outbound orders affect incoming/reserved only.

create table if not exists public.tan_tao_warehouse_documents (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  location_code text not null default 'warehouse_tan_tao',
  sku_id uuid not null references public.product_skus(id) on delete restrict,
  sku_code_snapshot text not null default 'BMQ-001',
  document_type text not null,
  status text not null,
  quantity numeric not null default 0,
  ordered_quantity numeric not null default 0,
  exchange_quantity numeric not null default 0,
  makeup_quantity numeric not null default 0,
  physical_quantity numeric not null default 0,
  source_authority text not null,
  source_document_id uuid references public.tan_tao_warehouse_documents(id) on delete restrict,
  reference_type text,
  reference_id uuid,
  reference_label text,
  idempotency_key text not null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tan_tao_warehouse_documents_location_check check (location_code = 'warehouse_tan_tao'),
  constraint tan_tao_warehouse_documents_sku_check check (sku_code_snapshot = 'BMQ-001'),
  constraint tan_tao_warehouse_documents_type_check check (
    document_type in ('opening', 'supplier_order', 'receipt', 'outbound_order', 'dispatch', 'stock_count', 'adjustment', 'cancellation')
  ),
  constraint tan_tao_warehouse_documents_status_check check (status in ('expected', 'reserved', 'posted', 'cancelled')),
  constraint tan_tao_warehouse_documents_quantities_check check (
    quantity >= 0 and ordered_quantity >= 0 and exchange_quantity >= 0 and makeup_quantity >= 0 and physical_quantity >= 0
  ),
  unique (idempotency_key)
);

create table if not exists public.tan_tao_warehouse_movements (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique references public.tan_tao_warehouse_documents(id) on delete restrict,
  location_code text not null default 'warehouse_tan_tao',
  sku_id uuid not null references public.product_skus(id) on delete restrict,
  sku_code_snapshot text not null default 'BMQ-001',
  movement_type text not null,
  quantity numeric not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tan_tao_warehouse_movements_location_check check (location_code = 'warehouse_tan_tao'),
  constraint tan_tao_warehouse_movements_sku_check check (sku_code_snapshot = 'BMQ-001'),
  constraint tan_tao_warehouse_movements_type_check check (movement_type in ('opening', 'receipt', 'dispatch', 'adjustment')),
  constraint tan_tao_warehouse_movements_quantity_check check (quantity <> 0)
);

create table if not exists public.tan_tao_warehouse_reservations (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique references public.tan_tao_warehouse_documents(id) on delete restrict,
  location_code text not null default 'warehouse_tan_tao',
  sku_id uuid not null references public.product_skus(id) on delete restrict,
  sku_code_snapshot text not null default 'BMQ-001',
  quantity numeric not null,
  status text not null default 'active',
  source_type text,
  source_id uuid,
  released_at timestamptz,
  dispatched_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tan_tao_warehouse_reservations_location_check check (location_code = 'warehouse_tan_tao'),
  constraint tan_tao_warehouse_reservations_sku_check check (sku_code_snapshot = 'BMQ-001'),
  constraint tan_tao_warehouse_reservations_quantity_check check (quantity > 0),
  constraint tan_tao_warehouse_reservations_status_check check (status in ('active', 'released', 'dispatched', 'cancelled'))
);

create index if not exists tan_tao_warehouse_documents_created_idx
  on public.tan_tao_warehouse_documents(created_at desc);
create index if not exists tan_tao_warehouse_documents_open_incoming_idx
  on public.tan_tao_warehouse_documents(document_type, status, created_at)
  where document_type = 'supplier_order' and status = 'expected';
create index if not exists tan_tao_warehouse_reservations_active_idx
  on public.tan_tao_warehouse_reservations(status, created_at)
  where status = 'active';
create index if not exists tan_tao_warehouse_movements_created_idx
  on public.tan_tao_warehouse_movements(created_at desc);

alter table public.tan_tao_warehouse_documents enable row level security;
alter table public.tan_tao_warehouse_movements enable row level security;
alter table public.tan_tao_warehouse_reservations enable row level security;

revoke all on table public.tan_tao_warehouse_documents from public, anon, authenticated;
revoke all on table public.tan_tao_warehouse_movements from public, anon, authenticated;
revoke all on table public.tan_tao_warehouse_reservations from public, anon, authenticated;
grant select on table public.tan_tao_warehouse_documents to authenticated;
grant select on table public.tan_tao_warehouse_movements to authenticated;
grant select on table public.tan_tao_warehouse_reservations to authenticated;

create or replace function public.can_view_tan_tao_warehouse()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.role() = 'service_role'
    or public.has_role((select auth.uid()), 'owner'::public.app_role)
    or public.has_role((select auth.uid()), 'staff'::public.app_role)
    or public.has_role((select auth.uid()), 'warehouse'::public.app_role)
    or public.has_module_permission((select auth.uid()), 'inventory', 'view');
$$;

create or replace function public.can_manage_tan_tao_warehouse()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.role() = 'service_role'
    or public.has_role((select auth.uid()), 'owner'::public.app_role)
    or public.has_role((select auth.uid()), 'warehouse'::public.app_role)
    or public.has_module_permission((select auth.uid()), 'inventory', 'edit');
$$;

revoke all on function public.can_view_tan_tao_warehouse() from public, anon;
revoke all on function public.can_manage_tan_tao_warehouse() from public, anon;
grant execute on function public.can_view_tan_tao_warehouse() to authenticated, service_role;
grant execute on function public.can_manage_tan_tao_warehouse() to authenticated, service_role;

drop policy if exists tan_tao_warehouse_documents_select on public.tan_tao_warehouse_documents;
create policy tan_tao_warehouse_documents_select on public.tan_tao_warehouse_documents for select to authenticated using (public.can_view_tan_tao_warehouse());
drop policy if exists tan_tao_warehouse_movements_select on public.tan_tao_warehouse_movements;
create policy tan_tao_warehouse_movements_select on public.tan_tao_warehouse_movements for select to authenticated using (public.can_view_tan_tao_warehouse());
drop policy if exists tan_tao_warehouse_reservations_select on public.tan_tao_warehouse_reservations;
create policy tan_tao_warehouse_reservations_select on public.tan_tao_warehouse_reservations for select to authenticated using (public.can_view_tan_tao_warehouse());

create or replace function public.get_tan_tao_warehouse_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sku_id uuid;
  on_hand_quantity numeric := 0;
  reserved_quantity numeric := 0;
  incoming_quantity numeric := 0;
  atp_quantity numeric := 0;
  v_recent_documents jsonb := '[]'::jsonb;
begin
  if not public.can_view_tan_tao_warehouse() then raise exception 'forbidden' using errcode = '42501'; end if;
  select id into v_sku_id from public.product_skus where upper(sku_code) = 'BMQ-001' order by created_at asc limit 1;
  if v_sku_id is null then raise exception 'BMQ-001 is not configured' using errcode = 'P0002'; end if;

  select coalesce(sum(m.quantity), 0) into on_hand_quantity
  from public.tan_tao_warehouse_movements m where m.location_code = 'warehouse_tan_tao' and m.sku_id = v_sku_id;
  select coalesce(sum(r.quantity), 0) into reserved_quantity
  from public.tan_tao_warehouse_reservations r where r.location_code = 'warehouse_tan_tao' and r.sku_id = v_sku_id and r.status = 'active';
  select coalesce(sum(greatest(d.quantity - coalesce(received.received_quantity, 0), 0)), 0) into incoming_quantity
  from public.tan_tao_warehouse_documents d
  left join lateral (
    select sum(rd.quantity) as received_quantity from public.tan_tao_warehouse_documents rd
    where rd.source_document_id = d.id and rd.document_type = 'receipt' and rd.status = 'posted'
  ) received on true
  where d.location_code = 'warehouse_tan_tao' and d.sku_id = v_sku_id and d.document_type = 'supplier_order' and d.status = 'expected';
  atp_quantity := on_hand_quantity - reserved_quantity;

  select coalesce(jsonb_agg(to_jsonb(recent_row) order by recent_row.created_at desc), '[]'::jsonb) into v_recent_documents
  from (
    select d.id, d.document_number, d.document_type, d.status, d.quantity, d.ordered_quantity,
           d.exchange_quantity, d.makeup_quantity, d.physical_quantity, d.reference_label, d.note, d.created_at
    from public.tan_tao_warehouse_documents d
    where d.location_code = 'warehouse_tan_tao' and d.sku_id = v_sku_id order by d.created_at desc limit 30
  ) recent_row;

  return jsonb_build_object(
    'location_code', 'warehouse_tan_tao', 'location_name', 'Kho Tân Tạo', 'sku_id', v_sku_id,
    'sku_code', 'BMQ-001', 'unit', 'que', 'on_hand_quantity', on_hand_quantity,
    'reserved_quantity', reserved_quantity, 'atp_quantity', atp_quantity, 'incoming_quantity', incoming_quantity,
    'projected_quantity', on_hand_quantity + incoming_quantity - reserved_quantity,
    'needs_attention', atp_quantity < 0, 'recent_documents', v_recent_documents
  );
end;
$$;
revoke all on function public.get_tan_tao_warehouse_snapshot() from public, anon;
grant execute on function public.get_tan_tao_warehouse_snapshot() to authenticated, service_role;

create or replace function public.execute_tan_tao_warehouse_command(
  p_command_type text, p_idempotency_key text, p_quantity numeric default null,
  p_ordered_quantity numeric default 0, p_exchange_quantity numeric default 0, p_makeup_quantity numeric default 0,
  p_reference_label text default null, p_reference_type text default 'chat', p_reference_id uuid default null,
  p_source_document_number text default null, p_note text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_sku_id uuid; v_document public.tan_tao_warehouse_documents;
  v_existing public.tan_tao_warehouse_documents; v_source public.tan_tao_warehouse_documents;
  v_reservation public.tan_tao_warehouse_reservations; v_document_number text; v_source_count integer := 0;
  v_on_hand numeric := 0; v_adjustment numeric := 0; v_received numeric := 0; v_remaining numeric := 0;
  ordered_quantity numeric := greatest(coalesce(p_ordered_quantity, 0), 0);
  exchange_quantity numeric := greatest(coalesce(p_exchange_quantity, 0), 0);
  makeup_quantity numeric := greatest(coalesce(p_makeup_quantity, 0), 0);
  physical_quantity numeric := 0;
begin
  if not public.can_manage_tan_tao_warehouse() then raise exception 'forbidden' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('warehouse_tan_tao:BMQ-001', 0));
  select * into v_existing from public.tan_tao_warehouse_documents where idempotency_key = trim(p_idempotency_key);
  if found then return jsonb_build_object('status', 'existing', 'document', to_jsonb(v_existing), 'snapshot', public.get_tan_tao_warehouse_snapshot()); end if;
  select id into v_sku_id from public.product_skus where upper(sku_code) = 'BMQ-001' order by created_at asc limit 1;
  if v_sku_id is null then raise exception 'BMQ-001 is not configured' using errcode = 'P0002'; end if;
  v_document_number := 'TT-' || upper(substr(trim(p_command_type), 1, 3)) || '-' || to_char((now() at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  if p_command_type = 'opening' then
    if auth.role() <> 'service_role' and not public.has_role((select auth.uid()), 'owner'::public.app_role) then raise exception 'owner_trusted_source_required' using errcode = '42501'; end if;
    if coalesce(p_quantity, 0) <= 0 then raise exception 'positive_quantity_required' using errcode = '22023'; end if;
    if exists (select 1 from public.tan_tao_warehouse_documents where location_code = 'warehouse_tan_tao' and sku_id = v_sku_id and document_type = 'opening' and status = 'posted') then raise exception 'opening_already_exists_use_stock_count' using errcode = '23505'; end if;
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,physical_quantity,source_authority,reference_type,reference_id,reference_label,idempotency_key,note,metadata,created_by)
    values (v_document_number,v_sku_id,'opening','posted',p_quantity,p_quantity,'owner_trusted_chat',p_reference_type,p_reference_id,p_reference_label,trim(p_idempotency_key),p_note,jsonb_build_object('trusted_source',true),v_actor) returning * into v_document;
    insert into public.tan_tao_warehouse_movements (document_id,sku_id,movement_type,quantity,note,created_by) values (v_document.id,v_sku_id,'opening',p_quantity,p_note,v_actor);

  elsif p_command_type = 'supplier_order' then
    if coalesce(p_quantity, 0) <= 0 then raise exception 'positive_quantity_required' using errcode = '22023'; end if;
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,physical_quantity,source_authority,reference_type,reference_id,reference_label,idempotency_key,note,metadata,created_by)
    values (v_document_number,v_sku_id,'supplier_order','expected',p_quantity,p_quantity,'system_or_owner_order',p_reference_type,p_reference_id,coalesce(p_reference_label,'BMQ - HKD Tuyết Anh'),trim(p_idempotency_key),p_note,jsonb_build_object('stock_effect','incoming_only'),v_actor) returning * into v_document;

  elsif p_command_type = 'receipt' then
    if coalesce(p_quantity, 0) <= 0 then raise exception 'positive_quantity_required' using errcode = '22023'; end if;
    if nullif(trim(coalesce(p_source_document_number, '')), '') is not null then
      select * into v_source from public.tan_tao_warehouse_documents where document_number=trim(p_source_document_number) and document_type='supplier_order' for update;
      if not found then raise exception 'open_supplier_order_not_found' using errcode = 'P0002'; end if;
    else
      select count(*),min(id::text)::uuid into v_source_count,v_source.id from public.tan_tao_warehouse_documents
      where document_type='supplier_order' and status='expected' and quantity > coalesce((select sum(rd.quantity) from public.tan_tao_warehouse_documents rd where rd.source_document_id=tan_tao_warehouse_documents.id and rd.document_type='receipt' and rd.status='posted'),0);
      if v_source_count<>1 then raise exception 'receipt_requires_exactly_one_open_supplier_order' using errcode = '22023'; end if;
      select * into v_source from public.tan_tao_warehouse_documents where id=v_source.id for update;
    end if;
    select coalesce(sum(rd.quantity),0) into v_received
    from public.tan_tao_warehouse_documents rd
    where rd.source_document_id=v_source.id and rd.document_type='receipt' and rd.status='posted';
    v_remaining:=v_source.quantity-v_received;
    if v_remaining<=0 then raise exception 'fully_received_supplier_order' using errcode = '22023'; end if;
    if p_quantity>v_remaining then raise exception 'receipt_exceeds_remaining' using errcode = '22023'; end if;
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,physical_quantity,source_authority,source_document_id,reference_type,reference_id,reference_label,idempotency_key,note,metadata,created_by)
    values (v_document_number,v_sku_id,'receipt','posted',p_quantity,p_quantity,'confirmed_physical_receipt',v_source.id,p_reference_type,p_reference_id,coalesce(p_reference_label,v_source.reference_label),trim(p_idempotency_key),p_note,jsonb_build_object('ordered_quantity',v_source.quantity,'actual_quantity',p_quantity),v_actor) returning * into v_document;
    insert into public.tan_tao_warehouse_movements (document_id,sku_id,movement_type,quantity,note,created_by) values (v_document.id,v_sku_id,'receipt',p_quantity,p_note,v_actor);
    if p_quantity = v_remaining then
      update public.tan_tao_warehouse_documents set status='posted' where id=v_source.id and status='expected';
    end if;

  elsif p_command_type = 'outbound_order' then
    physical_quantity := ordered_quantity + exchange_quantity + makeup_quantity;
    if physical_quantity <= 0 then raise exception 'positive_physical_quantity_required' using errcode = '22023'; end if;
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,ordered_quantity,exchange_quantity,makeup_quantity,physical_quantity,source_authority,reference_type,reference_id,reference_label,idempotency_key,note,metadata,created_by)
    values (v_document_number,v_sku_id,'outbound_order','reserved',physical_quantity,ordered_quantity,exchange_quantity,makeup_quantity,physical_quantity,'authenticated_order_source',p_reference_type,p_reference_id,p_reference_label,trim(p_idempotency_key),p_note,jsonb_build_object('billable_quantity',ordered_quantity,'stock_effect','reservation_only'),v_actor) returning * into v_document;
    insert into public.tan_tao_warehouse_reservations (document_id,sku_id,quantity,status,source_type,source_id,created_by) values (v_document.id,v_sku_id,physical_quantity,'active',p_reference_type,p_reference_id,v_actor);

  elsif p_command_type = 'dispatch' then
    if nullif(trim(coalesce(p_source_document_number, '')), '') is not null then
      select r.* into v_reservation from public.tan_tao_warehouse_reservations r join public.tan_tao_warehouse_documents d on d.id=r.document_id where d.document_number=trim(p_source_document_number) and r.status='active' for update of r;
      if not found then raise exception 'active_reservation_not_found' using errcode = 'P0002'; end if;
    else
      select count(*),min(r.id::text)::uuid into v_source_count,v_reservation.id from public.tan_tao_warehouse_reservations r where r.status='active';
      if v_source_count<>1 then raise exception 'dispatch_requires_exactly_one_active_reservation' using errcode = '22023'; end if;
      select * into v_reservation from public.tan_tao_warehouse_reservations where id=v_reservation.id for update;
    end if;
    select * into v_source from public.tan_tao_warehouse_documents where id=v_reservation.document_id;
    select coalesce(sum(quantity),0) into v_on_hand from public.tan_tao_warehouse_movements where sku_id=v_sku_id;
    if v_on_hand<v_reservation.quantity then raise exception 'insufficient_on_hand_stock' using errcode = '22023'; end if;
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,ordered_quantity,exchange_quantity,makeup_quantity,physical_quantity,source_authority,source_document_id,reference_type,reference_id,reference_label,idempotency_key,note,metadata,created_by)
    values (v_document_number,v_sku_id,'dispatch','posted',v_reservation.quantity,v_source.ordered_quantity,v_source.exchange_quantity,v_source.makeup_quantity,v_reservation.quantity,'confirmed_physical_dispatch',v_source.id,p_reference_type,p_reference_id,v_source.reference_label,trim(p_idempotency_key),p_note,jsonb_build_object('billable_quantity',v_source.ordered_quantity),v_actor) returning * into v_document;
    insert into public.tan_tao_warehouse_movements (document_id,sku_id,movement_type,quantity,note,created_by) values (v_document.id,v_sku_id,'dispatch',-v_reservation.quantity,p_note,v_actor);
    update public.tan_tao_warehouse_reservations set status='dispatched',dispatched_at=now() where id=v_reservation.id;

  elsif p_command_type = 'cancel_outbound' then
    if nullif(trim(coalesce(p_source_document_number, '')), '') is null then raise exception 'source_document_required' using errcode = '22023'; end if;
    select r.* into v_reservation from public.tan_tao_warehouse_reservations r join public.tan_tao_warehouse_documents d on d.id=r.document_id where d.document_number=trim(p_source_document_number) and r.status='active' for update of r;
    if not found then raise exception 'active_reservation_not_found' using errcode = 'P0002'; end if;
    select * into v_source from public.tan_tao_warehouse_documents where id=v_reservation.document_id;
    update public.tan_tao_warehouse_reservations set status='cancelled',released_at=now() where id=v_reservation.id;
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,physical_quantity,source_authority,source_document_id,reference_label,idempotency_key,note,metadata,created_by)
    values (v_document_number,v_sku_id,'cancellation','posted',v_reservation.quantity,v_reservation.quantity,'owner_or_operator_cancellation',v_source.id,v_source.reference_label,trim(p_idempotency_key),p_note,jsonb_build_object('stock_effect','release_reservation'),v_actor) returning * into v_document;

  elsif p_command_type = 'stock_count' then
    if p_quantity is null or p_quantity<0 then raise exception 'nonnegative_count_required' using errcode = '22023'; end if;
    select coalesce(sum(quantity),0) into v_on_hand from public.tan_tao_warehouse_movements where sku_id=v_sku_id;
    v_adjustment := p_quantity-v_on_hand;
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,physical_quantity,source_authority,reference_type,reference_id,reference_label,idempotency_key,note,metadata,created_by)
    values (v_document_number,v_sku_id,'stock_count','posted',p_quantity,p_quantity,'confirmed_physical_count',p_reference_type,p_reference_id,p_reference_label,trim(p_idempotency_key),p_note,jsonb_build_object('system_quantity_before',v_on_hand,'counted_quantity',p_quantity,'adjustment_quantity',v_adjustment),v_actor) returning * into v_document;
    if v_adjustment<>0 then insert into public.tan_tao_warehouse_movements (document_id,sku_id,movement_type,quantity,note,created_by) values (v_document.id,v_sku_id,'adjustment',v_adjustment,coalesce(p_note,'Điều chỉnh theo kiểm kê vật lý'),v_actor); end if;
  else raise exception 'unsupported_command_type' using errcode = '22023'; end if;
  return jsonb_build_object('status','created','document',to_jsonb(v_document),'snapshot',public.get_tan_tao_warehouse_snapshot());
end;
$$;
revoke all on function public.execute_tan_tao_warehouse_command(text,text,numeric,numeric,numeric,numeric,text,text,uuid,text,text) from public,anon;
grant execute on function public.execute_tan_tao_warehouse_command(text,text,numeric,numeric,numeric,numeric,text,text,uuid,text,text) to authenticated,service_role;

-- Natural dealer-order source: the guarded submit RPC inserts items before this outbox row.
create or replace function public.sync_tan_tao_dealer_order_reservation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_sku_id uuid; v_order public.dealer_orders; v_doc_id uuid; v_number text;
  v_ordered numeric:=0; v_exchange numeric:=0; v_makeup numeric:=0; v_physical numeric:=0;
begin
  if new.notification_type<>'order' or new.order_id is null then return new; end if;
  select * into v_order from public.dealer_orders where id=new.order_id;
  if not found or v_order.status='cancelled' then return new; end if;
  select id into v_sku_id from public.product_skus where upper(sku_code)='BMQ-001' order by created_at asc limit 1;
  if v_sku_id is null then return new; end if;
  select coalesce(sum(coalesce(i.ordered_quantity,i.quantity,0)),0),coalesce(sum(i.exchange_quantity),0),coalesce(sum(i.makeup_quantity),0)
    into v_ordered,v_exchange,v_makeup from public.dealer_order_items i where i.order_id=new.order_id and upper(i.sku_code)='BMQ-001';
  v_physical:=v_ordered+v_exchange+v_makeup; if v_physical<=0 then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('warehouse_tan_tao:BMQ-001',0));
  v_number:='TT-OUT-'||to_char((now() at time zone 'Asia/Ho_Chi_Minh')::date,'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,ordered_quantity,exchange_quantity,makeup_quantity,physical_quantity,source_authority,reference_type,reference_id,reference_label,idempotency_key,metadata)
  values (v_number,v_sku_id,'outbound_order','reserved',v_physical,v_ordered,v_exchange,v_makeup,v_physical,'dealer_order_submit_outbox','dealer_order',new.order_id,coalesce(v_order.customer_snapshot->>'name',v_order.order_number),'dealer-order:'||new.order_id::text,jsonb_build_object('notification_id',new.id,'billable_quantity',v_ordered,'stock_effect','reservation_only'))
  on conflict (idempotency_key) do nothing returning id into v_doc_id;
  if v_doc_id is not null then insert into public.tan_tao_warehouse_reservations (document_id,sku_id,quantity,status,source_type,source_id) values (v_doc_id,v_sku_id,v_physical,'active','dealer_order',new.order_id); end if;
  return new;
end;
$$;

create or replace function public.sync_tan_tao_sent_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_sku_id uuid; v_doc_id uuid; v_number text; v_qty numeric:=0;
  v_ordered numeric:=0; v_exchange numeric:=0; v_makeup numeric:=0; v_physical numeric:=0;
begin
  if new.status<>'sent' or (tg_op='UPDATE' and old.status='sent') then return new; end if;
  if new.notification_type not in ('production_bread_order','warehouse_kiosk_bread_dispatch') then return new; end if;
  select id into v_sku_id from public.product_skus where upper(sku_code)='BMQ-001' order by created_at asc limit 1;
  if v_sku_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('warehouse_tan_tao:BMQ-001',0));
  if new.notification_type='production_bread_order' then
    v_qty:=coalesce(nullif(new.source_snapshot #>> '{rounding,total_bmq,sent_quantity}','')::numeric,0);
    if v_qty<=0 then return new; end if;
    v_number:='TT-SUP-'||to_char(coalesce(new.digest_date,(now() at time zone 'Asia/Ho_Chi_Minh')::date),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,physical_quantity,source_authority,reference_type,reference_id,reference_label,idempotency_key,metadata)
    values (v_number,v_sku_id,'supplier_order','expected',v_qty,v_qty,'sent_supplier_notification','production_bread_order',new.id,'BMQ - HKD Tuyết Anh','supplier-notification:'||new.id::text,jsonb_build_object('digest_date',new.digest_date,'stock_effect','incoming_only'))
    on conflict (idempotency_key) do nothing;
  else
    select coalesce(sum(coalesce(nullif(x->>'orderQuantity','')::numeric,0))),coalesce(sum(coalesce(nullif(x->>'shortageQuantity','')::numeric,0))),coalesce(sum(coalesce(nullif(x->>'returnsQuantity','')::numeric,0)+coalesce(nullif(x->>'wasteQuantity','')::numeric,0)))
      into v_ordered,v_makeup,v_exchange from jsonb_array_elements(coalesce(new.source_snapshot->'locations','[]'::jsonb)) x;
    v_physical:=v_ordered+v_exchange+v_makeup; if v_physical<=0 then return new; end if;
    v_number:='TT-OUT-'||to_char(coalesce(new.digest_date,(now() at time zone 'Asia/Ho_Chi_Minh')::date),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,ordered_quantity,exchange_quantity,makeup_quantity,physical_quantity,source_authority,reference_type,reference_id,reference_label,idempotency_key,metadata)
    values (v_number,v_sku_id,'outbound_order','reserved',v_physical,v_ordered,v_exchange,v_makeup,v_physical,'sent_kiosk_dispatch_notification','warehouse_kiosk_bread_dispatch',new.id,'Điểm bán BMQ','kiosk-dispatch-notification:'||new.id::text,jsonb_build_object('digest_date',new.digest_date,'stock_effect','reservation_only'))
    on conflict (idempotency_key) do nothing returning id into v_doc_id;
    if v_doc_id is not null then insert into public.tan_tao_warehouse_reservations (document_id,sku_id,quantity,status,source_type,source_id) values (v_doc_id,v_sku_id,v_physical,'active','warehouse_kiosk_bread_dispatch',new.id); end if;
  end if;
  return new;
end;
$$;

create or replace function public.release_tan_tao_cancelled_dealer_order_reservation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_source public.tan_tao_warehouse_documents; v_qty numeric; v_number text;
begin
  if new.status<>'cancelled' or old.status='cancelled' then return new; end if;
  select * into v_source from public.tan_tao_warehouse_documents where idempotency_key='dealer-order:'||new.id::text;
  if not found then return new; end if;
  update public.tan_tao_warehouse_reservations set status='cancelled',released_at=now() where document_id=v_source.id and status='active' returning quantity into v_qty;
  if v_qty is null then return new; end if;
  v_number:='TT-CAN-'||to_char((now() at time zone 'Asia/Ho_Chi_Minh')::date,'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,physical_quantity,source_authority,source_document_id,reference_type,reference_id,reference_label,idempotency_key,metadata)
  values (v_number,v_source.sku_id,'cancellation','posted',v_qty,v_qty,'cancelled_dealer_order',v_source.id,'dealer_order',new.id,v_source.reference_label,'dealer-order-cancellation:'||new.id::text,jsonb_build_object('stock_effect','release_reservation')) on conflict (idempotency_key) do nothing;
  return new;
end;
$$;

revoke all on function public.sync_tan_tao_dealer_order_reservation() from public,anon,authenticated;
revoke all on function public.sync_tan_tao_sent_notification() from public,anon,authenticated;
revoke all on function public.release_tan_tao_cancelled_dealer_order_reservation() from public,anon,authenticated;

drop trigger if exists tan_tao_dealer_order_reservation_trigger on public.dealer_order_notifications;
create trigger tan_tao_dealer_order_reservation_trigger after insert on public.dealer_order_notifications
for each row execute function public.sync_tan_tao_dealer_order_reservation();
drop trigger if exists tan_tao_sent_notification_trigger on public.dealer_order_notifications;
create trigger tan_tao_sent_notification_trigger after insert or update on public.dealer_order_notifications
for each row execute function public.sync_tan_tao_sent_notification();
drop trigger if exists tan_tao_cancelled_dealer_order_trigger on public.dealer_orders;
create trigger tan_tao_cancelled_dealer_order_trigger after update of status on public.dealer_orders
for each row execute function public.release_tan_tao_cancelled_dealer_order_reservation();
