-- Supplier ordering by email — phase 1 backend (Bơ Peerless / TV Food).
--
-- Adds the supplier PO unit to the Q7 item settings, the request/upload ledger,
-- the prepare/history read RPCs used by the UI, and the service-role-only RPCs
-- used by the supplier-order-send / supplier-order-upload Edge Functions.
--
-- No cron job is scheduled here and nothing sends email by itself.

-- ---------------------------------------------------------------------------
-- 1. PO unit on the item settings
-- ---------------------------------------------------------------------------

alter table public.q7_purchase_item_settings
  add column if not exists po_unit text,
  add column if not exists po_unit_factor numeric(18, 4);

alter table public.q7_purchase_item_settings
  drop constraint if exists q7_purchase_item_settings_po_unit_check;
alter table public.q7_purchase_item_settings
  add constraint q7_purchase_item_settings_po_unit_check check (
    (po_unit is null and po_unit_factor is null)
    or (
      nullif(btrim(po_unit), '') is not null
      and po_unit_factor is not null
      and po_unit_factor > 0
      and po_unit_factor::text not in ('NaN', 'Infinity', '-Infinity')
    )
  );

comment on column public.q7_purchase_item_settings.po_unit is
  'Supplier purchase-order unit (e.g. kg) for email ordering; both po_unit and po_unit_factor are null or both set.';
comment on column public.q7_purchase_item_settings.po_unit_factor is
  'How many Q7 book units make one po_unit (e.g. 1000 for kg when the item is tracked in g).';

-- ---------------------------------------------------------------------------
-- 2. Request + upload ledger
-- ---------------------------------------------------------------------------

create table if not exists public.supplier_order_requests (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  kitchen_inventory_item_id uuid not null
    references public.kitchen_inventory_items(id),
  supplier_id uuid not null references public.suppliers(id),
  purchase_order_id uuid references public.purchase_orders(id),
  to_email text not null,
  subject text,
  quantity numeric not null check (quantity > 0),
  unit text not null,
  unit_price numeric,
  line_total numeric,
  note text,
  status text not null check (status in ('preparing', 'sent', 'failed')),
  error text,
  gmail_message_id text,
  upload_token_hash text unique,
  upload_expires_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_supplier_order_requests_item
  on public.supplier_order_requests(kitchen_inventory_item_id, created_at desc);

create index if not exists idx_supplier_order_requests_po
  on public.supplier_order_requests(purchase_order_id);

create table if not exists public.supplier_order_uploads (
  id uuid primary key default gen_random_uuid(),
  order_request_id uuid not null
    references public.supplier_order_requests(id) on delete restrict,
  storage_path text not null unique,
  file_name text,
  mime_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  created_at timestamptz not null default now(),
  unique (order_request_id, sha256)
);

create index if not exists idx_supplier_order_uploads_request
  on public.supplier_order_uploads(order_request_id, created_at desc);

alter table public.supplier_order_requests enable row level security;
alter table public.supplier_order_uploads enable row level security;

drop policy if exists supplier_order_requests_select on public.supplier_order_requests;
create policy supplier_order_requests_select on public.supplier_order_requests
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit')
  );

drop policy if exists supplier_order_uploads_select on public.supplier_order_uploads;
create policy supplier_order_uploads_select on public.supplier_order_uploads
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit')
  );

revoke all on table public.supplier_order_requests from public, anon, authenticated;
revoke all on table public.supplier_order_uploads from public, anon, authenticated;
grant select on table public.supplier_order_requests to authenticated;
grant select on table public.supplier_order_uploads to authenticated;
grant all on table public.supplier_order_requests to service_role;
grant all on table public.supplier_order_uploads to service_role;

-- Private bucket for delivery invoice photos/PDFs. No anon/authenticated object
-- policies: the public upload function writes through the service role only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'supplier-delivery-docs',
  'supplier-delivery-docs',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Read-only object access so owners / purchase editors can open the supplier's
-- files from the item detail (signed URLs). Writes stay service-role only.
drop policy if exists supplier_delivery_docs_read on storage.objects;
create policy supplier_delivery_docs_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'supplier-delivery-docs'
    and (
      public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit')
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Prepare a proposal (UI read path)
-- ---------------------------------------------------------------------------

create or replace function public.prepare_supplier_order(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    select round(poi.unit_price / greatest(a.conversion_factor, 0.00000001), 2)
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
    order by po.order_date desc, poi.created_at desc
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
$$;

revoke all on function public.prepare_supplier_order(uuid) from public, anon;
grant execute on function public.prepare_supplier_order(uuid) to authenticated, service_role;

create or replace function public.supplier_order_history(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_items jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'request_id', r.request_id,
    'po_number', r.po_number,
    'quantity', r.quantity,
    'unit', r.unit,
    'total', r.line_total,
    'line_total', r.line_total,
    'status', r.status,
    'sent_at', r.sent_at,
    'to_email', r.to_email,
    'created_at', r.created_at,
    'uploads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'file_name', u.file_name,
        'mime_type', u.mime_type,
        'size_bytes', u.size_bytes,
        'created_at', u.created_at,
        'storage_path', u.storage_path
      ) order by u.created_at desc)
      from public.supplier_order_uploads u
      where u.order_request_id = r.id
    ), '[]'::jsonb)
  ) order by r.created_at desc), '[]'::jsonb)
  into v_items
  from (
    select req.*, po.po_number as po_number
    from public.supplier_order_requests req
    left join public.purchase_orders po on po.id = req.purchase_order_id
    where req.kitchen_inventory_item_id = p_item_id
    order by req.created_at desc
    limit 10
  ) r;

  return jsonb_build_object('items', v_items);
end;
$$;

revoke all on function public.supplier_order_history(uuid) from public, anon;
grant execute on function public.supplier_order_history(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Service-role RPCs for the Edge Functions
-- ---------------------------------------------------------------------------

create or replace function public.create_supplier_order_po(
  p_request_id uuid,
  p_item_id uuid,
  p_quantity numeric,
  p_note text,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_proposal jsonb;
  v_blockers jsonb;
  v_supplier_id uuid;
  v_supplier_name text;
  v_to_email text;
  v_product_name text;
  v_unit text;
  v_unit_price numeric;
  v_line_total numeric;
  v_pack_po numeric;
  v_suggested_po numeric;
  v_max_qty numeric;
  v_max_amount numeric := 30000000;
  v_max_text text;
  v_po_id uuid;
  v_po_number text;
  v_order_request_id uuid;
  v_subject text;
  v_existing record;
  v_result jsonb;
begin
  if p_request_id is null or p_item_id is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if p_quantity is null
     or p_quantity <= 0
     or p_quantity::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));

  select r.*, po.po_number as existing_po_number
  into v_existing
  from public.supplier_order_requests r
  left join public.purchase_orders po on po.id = r.purchase_order_id
  where r.request_id = p_request_id;

  if found then
    return jsonb_build_object(
      -- A replay of a request still being sent (double click, second tab) must
      -- not send a second email; after 2 minutes a stuck request may be retried.
      'in_progress', v_existing.status = 'preparing'
        and v_existing.created_at > now() - interval '2 minutes',
      'request_id', v_existing.request_id,
      'order_request_id', v_existing.id,
      'purchase_order_id', v_existing.purchase_order_id,
      'po_number', v_existing.existing_po_number,
      'to_email', v_existing.to_email,
      'subject', v_existing.subject,
      'status', v_existing.status,
      'quantity', v_existing.quantity,
      'unit', v_existing.unit,
      'unit_price', v_existing.unit_price,
      'line_total', v_existing.line_total,
      'note', v_existing.note,
      'sent_at', v_existing.sent_at,
      'replayed', true
    );
  end if;

  v_proposal := public.prepare_supplier_order(p_item_id);
  v_blockers := coalesce(v_proposal -> 'blockers', '[]'::jsonb);

  if v_blockers ? 'no_supplier' then
    raise exception 'no_supplier' using errcode = 'P0001';
  end if;
  if v_blockers ? 'no_supplier_email' then
    raise exception 'no_supplier_email' using errcode = 'P0001';
  end if;
  if v_blockers ? 'no_price' then
    raise exception 'no_price' using errcode = 'P0001';
  end if;
  if v_blockers ? 'no_po_unit' then
    raise exception 'no_po_unit' using errcode = 'P0001';
  end if;

  v_supplier_id := nullif(v_proposal -> 'supplier' ->> 'id', '')::uuid;
  v_supplier_name := v_proposal -> 'supplier' ->> 'name';
  v_to_email := btrim(coalesce(v_proposal -> 'supplier' ->> 'email', ''));
  v_product_name := coalesce(nullif(v_proposal -> 'proposal' ->> 'product_name', ''),
                             v_proposal -> 'item' ->> 'name');
  v_unit := v_proposal -> 'proposal' ->> 'unit';
  v_unit_price := nullif(v_proposal -> 'proposal' ->> 'unit_price', '')::numeric;
  v_pack_po := nullif(v_proposal -> 'proposal' ->> 'pack_size_po_units', '')::numeric;
  v_suggested_po := nullif(v_proposal -> 'proposal' ->> 'quantity', '')::numeric;

  if v_supplier_id is null then
    raise exception 'no_supplier' using errcode = 'P0001';
  end if;
  if v_to_email = '' then
    raise exception 'no_supplier_email' using errcode = 'P0001';
  end if;
  if v_unit_price is null then
    raise exception 'no_price' using errcode = 'P0001';
  end if;
  if v_unit is null or nullif(btrim(v_unit), '') is null then
    raise exception 'no_po_unit' using errcode = 'P0001';
  end if;

  v_max_qty := greatest(3 * coalesce(v_suggested_po, 0), 10 * coalesce(v_pack_po, 0));
  if v_max_qty <= 0 then
    v_max_qty := 3 * coalesce(v_suggested_po, 0);
  end if;
  if p_quantity > v_max_qty then
    raise exception 'over_quantity_limit' using errcode = 'P0001';
  end if;

  select value into v_max_text
  from public.app_settings
  where key = 'order_email_max_amount';
  if nullif(btrim(coalesce(v_max_text, '')), '') is not null then
    v_max_amount := v_max_text::numeric;
  end if;
  if v_max_amount is null or v_max_amount <= 0 then
    v_max_amount := 30000000;
  end if;

  v_line_total := round(p_quantity * v_unit_price, 2);
  if v_line_total > v_max_amount then
    raise exception 'over_amount_limit' using errcode = 'P0001';
  end if;

  v_po_id := gen_random_uuid();
  v_po_number := public.generate_po_number();
  v_subject := 'BMQ đặt hàng ' || v_po_number || ' – ' || v_product_name;

  insert into public.purchase_orders (
    id, po_number, supplier_id, status, order_date, notes,
    created_by, total_amount
  ) values (
    v_po_id, v_po_number, v_supplier_id, 'draft'::public.purchase_order_status,
    v_today, 'Đặt hàng qua email order@bmq.vn', p_actor, v_line_total
  );

  insert into public.purchase_order_items (
    purchase_order_id, product_name, quantity, unit, unit_price, line_total
  ) values (
    v_po_id, v_product_name, p_quantity, v_unit, v_unit_price, v_line_total
  );

  v_order_request_id := gen_random_uuid();
  insert into public.supplier_order_requests (
    id, request_id, kitchen_inventory_item_id, supplier_id, purchase_order_id,
    to_email, subject, quantity, unit, unit_price, line_total, note,
    status, created_by
  ) values (
    v_order_request_id, p_request_id, p_item_id, v_supplier_id, v_po_id,
    v_to_email, v_subject, p_quantity, v_unit, v_unit_price, v_line_total,
    nullif(btrim(coalesce(p_note, '')), ''), 'preparing', p_actor
  );

  v_result := jsonb_build_object(
    'request_id', p_request_id,
    'order_request_id', v_order_request_id,
    'purchase_order_id', v_po_id,
    'po_number', v_po_number,
    'to_email', v_to_email,
    'subject', v_subject,
    'status', 'preparing',
    'quantity', p_quantity,
    'unit', v_unit,
    'unit_price', v_unit_price,
    'line_total', v_line_total,
    'note', nullif(btrim(coalesce(p_note, '')), ''),
    'product_name', v_product_name,
    'supplier_name', v_supplier_name,
    'replayed', false
  );
  return v_result;
end;
$$;

create or replace function public.mark_supplier_order_sent(
  p_request_id uuid,
  p_gmail_message_id text,
  p_upload_token_hash text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_role_before text;
begin
  select * into v_request
  from public.supplier_order_requests
  where request_id = p_request_id or id = p_request_id
  for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  update public.supplier_order_requests
  set status = 'sent',
      error = null,
      sent_at = now(),
      gmail_message_id = p_gmail_message_id,
      upload_token_hash = p_upload_token_hash,
      upload_expires_at = p_expires_at
  where id = v_request.id;

  if v_request.purchase_order_id is not null then
    v_role_before := current_setting('request.jwt.claim.role', true);
    perform set_config('request.jwt.claim.role', 'service_role', true);
    perform public.update_purchase_order_status_with_material_controller(
      v_request.purchase_order_id, 'sent', v_request.created_by
    );
    perform set_config('request.jwt.claim.role', coalesce(v_role_before, ''), true);
  end if;

  return jsonb_build_object(
    'request_id', v_request.request_id,
    'order_request_id', v_request.id,
    'purchase_order_id', v_request.purchase_order_id,
    'status', 'sent',
    'sent_at', now()
  );
end;
$$;

create or replace function public.mark_supplier_order_failed(
  p_request_id uuid,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.supplier_order_requests%rowtype;
begin
  select * into v_request
  from public.supplier_order_requests
  where request_id = p_request_id or id = p_request_id
  for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  update public.supplier_order_requests
  set status = 'failed',
      error = left(coalesce(p_error, 'unknown_error'), 2000)
  where id = v_request.id;

  return jsonb_build_object(
    'request_id', v_request.request_id,
    'order_request_id', v_request.id,
    'status', 'failed'
  );
end;
$$;

create or replace function public.resolve_supplier_order_upload_token(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_po_number text;
  v_supplier_name text;
  v_product_name text;
  v_upload_count integer := 0;
begin
  if nullif(btrim(coalesce(p_token_hash, '')), '') is null then
    return null;
  end if;

  select * into v_request
  from public.supplier_order_requests
  where upload_token_hash = p_token_hash
    and status = 'sent'
    and upload_expires_at is not null
    and upload_expires_at > now();

  if not found then
    return null;
  end if;

  select po.po_number into v_po_number
  from public.purchase_orders po
  where po.id = v_request.purchase_order_id;

  select s.name into v_supplier_name
  from public.suppliers s
  where s.id = v_request.supplier_id;

  select poi.product_name into v_product_name
  from public.purchase_order_items poi
  where poi.purchase_order_id = v_request.purchase_order_id
  order by poi.created_at asc
  limit 1;

  select count(*) into v_upload_count
  from public.supplier_order_uploads u
  where u.order_request_id = v_request.id;

  return jsonb_build_object(
    'order_request_id', v_request.id,
    'po_number', v_po_number,
    'supplier_name', v_supplier_name,
    'product_name', coalesce(v_product_name, ''),
    'quantity', v_request.quantity,
    'unit', v_request.unit,
    'sent_at', v_request.sent_at,
    'upload_count', v_upload_count
  );
end;
$$;

create or replace function public.record_supplier_order_upload(
  p_token_hash text,
  p_storage_path text,
  p_file_name text,
  p_mime text,
  p_size integer,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_count integer := 0;
  v_inserted integer := 0;
begin
  if p_storage_path is null or btrim(p_storage_path) = '' then
    raise exception 'storage_path_required' using errcode = '22023';
  end if;
  if p_mime is null or p_mime not in (
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
  ) then
    raise exception 'unsupported_type' using errcode = '22023';
  end if;
  if p_size is null or p_size <= 0 or p_size > 10485760 then
    raise exception 'invalid_file_size' using errcode = '22023';
  end if;
  if p_sha256 is null or lower(p_sha256) !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_sha256' using errcode = '22023';
  end if;

  select * into v_request
  from public.supplier_order_requests
  where upload_token_hash = p_token_hash
    and status = 'sent'
    and upload_expires_at is not null
    and upload_expires_at > now()
  for update;

  if not found then
    raise exception 'link_invalid' using errcode = '22023';
  end if;

  select count(*) into v_count
  from public.supplier_order_uploads u
  where u.order_request_id = v_request.id;

  if v_count >= 10 then
    raise exception 'upload_limit_reached' using errcode = 'P0001';
  end if;

  insert into public.supplier_order_uploads (
    order_request_id, storage_path, file_name, mime_type, size_bytes, sha256
  ) values (
    v_request.id, p_storage_path, left(p_file_name, 255), p_mime, p_size,
    lower(p_sha256)
  )
  on conflict (order_request_id, sha256) do nothing;
  get diagnostics v_inserted = row_count;

  -- purchase_orders.image_url is not touched: the PO screens resolve image_url
  -- only in the invoices/purchase-orders buckets, so a supplier-delivery-docs
  -- path would show as a broken image. Uploads are read from this table.

  select count(*) into v_count
  from public.supplier_order_uploads u
  where u.order_request_id = v_request.id;

  return jsonb_build_object(
    'uploaded', true,
    'count', v_count,
    'idempotent', v_inserted = 0
  );
end;
$$;

revoke all on function public.create_supplier_order_po(uuid, uuid, numeric, text, uuid)
  from public, anon, authenticated;
revoke all on function public.mark_supplier_order_sent(uuid, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_supplier_order_failed(uuid, text)
  from public, anon, authenticated;
revoke all on function public.resolve_supplier_order_upload_token(text)
  from public, anon, authenticated;
revoke all on function public.record_supplier_order_upload(text, text, text, text, integer, text)
  from public, anon, authenticated;

grant execute on function public.create_supplier_order_po(uuid, uuid, numeric, text, uuid)
  to service_role;
grant execute on function public.mark_supplier_order_sent(uuid, text, text, timestamptz)
  to service_role;
grant execute on function public.mark_supplier_order_failed(uuid, text)
  to service_role;
grant execute on function public.resolve_supplier_order_upload_token(text)
  to service_role;
grant execute on function public.record_supplier_order_upload(text, text, text, text, integer, text)
  to service_role;
