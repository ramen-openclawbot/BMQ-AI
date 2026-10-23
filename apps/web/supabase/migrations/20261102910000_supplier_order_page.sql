-- Trang Đặt hàng theo NCC — backend for the supplier order page.
--
-- Adds a per-supplier catalog, multi-line request lines, the catalog / preview
-- read RPCs, a service-role multi-line PO creator, the optional "gối đầu"
-- urgent-payment record and the supplier history read RPC.
--
-- Nothing here sends email or creates a payment submission by itself. The
-- existing single-item order flow (prepare_supplier_order /
-- create_supplier_order_po / mark_supplier_order_sent) keeps working.

-- ---------------------------------------------------------------------------
-- 1. Per-supplier catalog
-- ---------------------------------------------------------------------------

create table if not exists public.supplier_order_catalog_items (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  kitchen_inventory_item_id uuid not null
    references public.kitchen_inventory_items(id),
  product_name text,
  po_unit text not null,
  po_unit_factor numeric(18, 4) not null,
  pack_size_po numeric(18, 3),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint supplier_order_catalog_items_supplier_item_key
    unique (supplier_id, kitchen_inventory_item_id),
  constraint supplier_order_catalog_items_po_unit_factor_check
    check (
      po_unit_factor > 0
      and po_unit_factor::text not in ('NaN', 'Infinity', '-Infinity')
    ),
  constraint supplier_order_catalog_items_pack_size_po_check
    check (
      pack_size_po is null
      or (
        pack_size_po > 0
        and pack_size_po::text not in ('NaN', 'Infinity', '-Infinity')
      )
    )
);

create index if not exists idx_supplier_order_catalog_items_supplier
  on public.supplier_order_catalog_items(supplier_id, active, sort_order);

alter table public.supplier_order_catalog_items enable row level security;

revoke all on table public.supplier_order_catalog_items from public, anon, authenticated;
grant all on table public.supplier_order_catalog_items to service_role;

insert into public.supplier_order_catalog_items (
  supplier_id, kitchen_inventory_item_id, po_unit, po_unit_factor,
  pack_size_po, sort_order
)
values
  ('bc39ded3-755c-4b31-9e4c-d7729e009608',
   '1039f461-8f9f-45a1-b05c-b96cb736812e', 'kg', 1000, 25, 1),
  ('bc39ded3-755c-4b31-9e4c-d7729e009608',
   '64952d75-2351-43f8-886f-de5282c96ed2', 'kg', 1000, 25, 2),
  ('bc39ded3-755c-4b31-9e4c-d7729e009608',
   '6ba549f7-d3b6-4971-a742-2fb4091800bb', 'kg', 1000, 25, 3),
  ('9546bd80-18d7-4ec7-b0e5-de50798ea718',
   '3c16ed3f-54c7-427f-a316-5aa4fcadda5a', 'kg', 1000, 25, 1)
on conflict (supplier_id, kitchen_inventory_item_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Multi-line request lines + nullable single-item columns
-- ---------------------------------------------------------------------------

create table if not exists public.supplier_order_request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.supplier_order_requests(id) on delete cascade,
  position integer not null,
  kitchen_inventory_item_id uuid not null,
  product_name text not null,
  quantity numeric not null,
  unit text not null,
  unit_price numeric,
  line_total numeric,
  purchase_order_item_id uuid,
  constraint supplier_order_request_lines_request_position_key
    unique (request_id, position),
  constraint supplier_order_request_lines_quantity_positive
    check (quantity > 0)
);

create index if not exists idx_supplier_order_request_lines_request
  on public.supplier_order_request_lines(request_id, position);

create index if not exists idx_supplier_order_request_lines_item
  on public.supplier_order_request_lines(kitchen_inventory_item_id);

alter table public.supplier_order_request_lines enable row level security;

drop policy if exists supplier_order_request_lines_select
  on public.supplier_order_request_lines;
create policy supplier_order_request_lines_select
  on public.supplier_order_request_lines
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit')
  );

revoke all on table public.supplier_order_request_lines from public, anon, authenticated;
grant select on table public.supplier_order_request_lines to authenticated;
grant all on table public.supplier_order_request_lines to service_role;

alter table public.supplier_order_requests
  alter column kitchen_inventory_item_id drop not null;
alter table public.supplier_order_requests
  alter column quantity drop not null;
alter table public.supplier_order_requests
  alter column unit drop not null;

alter table public.supplier_order_requests
  add column if not exists total_amount numeric,
  add column if not exists prepay_request_id uuid
    references public.payment_requests(id),
  add column if not exists prepay_submission_id uuid
    references public.payment_submissions(id),
  add column if not exists prepay_status text;

alter table public.supplier_order_requests
  drop constraint if exists supplier_order_requests_prepay_status_check;
alter table public.supplier_order_requests
  add constraint supplier_order_requests_prepay_status_check
  check (
    prepay_status is null
    or prepay_status in (
      'created', 'skipped_none', 'skipped_recent', 'declined', 'forbidden', 'failed'
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Unit-aware latest supplier price in the item's book unit
-- ---------------------------------------------------------------------------

create or replace function public.supplier_order_line_price(
  p_supplier_id uuid,
  p_item_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select round(
           poi.unit_price / greatest(coalesce(
             public.stock_unit_line_factor(poi.unit, kii.unit),
             public.stock_unit_pack_factor(poi.product_name, poi.unit, kii.unit),
             a.conversion_factor
           ), 0.00000001),
           6)
  from public.purchase_order_items poi
  join public.purchase_orders po on po.id = poi.purchase_order_id
  join public.kitchen_inventory_items kii on kii.id = p_item_id
  join lateral (
    select a.*
    from public.stock_material_aliases a
    where a.kitchen_inventory_item_id = p_item_id
      and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
      and (a.supplier_id = p_supplier_id or a.supplier_id is null)
    order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
    limit 1
  ) a on true
  where po.supplier_id = p_supplier_id
    and poi.unit_price is not null
    and poi.unit_price > 0
  order by (public.stock_unit_line_factor(poi.unit, kii.unit) is not null
            and po.order_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90) desc,
           po.order_date desc, poi.created_at desc
  limit 1;
$$;

revoke all on function public.supplier_order_line_price(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_order_line_price(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. prepare_supplier_order from the live 20261102900000 body: only the price
--    block moves into supplier_order_line_price.
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

    -- Latest supplier-line price in the item's book unit. The unit-aware
    -- conversion lives in supplier_order_line_price.
    select public.supplier_order_line_price(v_supplier_id, p_item_id)
    into v_product_price;

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

-- ---------------------------------------------------------------------------
-- 5. Supplier list + catalog reads
-- ---------------------------------------------------------------------------

create or replace function public.supplier_order_suppliers()
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
    'id', su.id,
    'name', btrim(su.name),
    'email', nullif(btrim(su.email), ''),
    'item_count', (
      select count(*)
      from public.supplier_order_catalog_items c
      where c.supplier_id = su.id and c.active
    ),
    'last_order', (
      select jsonb_build_object(
        'po_number', po.po_number,
        'sent_at', r.sent_at
      )
      from public.supplier_order_requests r
      left join public.purchase_orders po on po.id = r.purchase_order_id
      where r.supplier_id = su.id
        and r.status = 'sent'
      order by r.sent_at desc nulls last, r.created_at desc
      limit 1
    ),
    'unpaid_count', (
      select count(*)
      from public.payment_requests pr
      where pr.supplier_id = su.id
        and pr.status::text in ('pending', 'approved')
        and pr.payment_status::text in ('unpaid', 'partial')
    )
  ) order by btrim(su.name), su.id), '[]'::jsonb)
  into v_result
  from public.suppliers su
  where exists (
    select 1
    from public.supplier_order_catalog_items c
    where c.supplier_id = su.id and c.active
  );

  return v_result;
end;
$$;

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
  v_on_hand numeric;
  v_daily numeric;
  v_days_left numeric;
  v_last_count_date date;
  v_reorder_date date;
  v_suggested numeric;
  v_proposal numeric;
  v_price numeric;
  v_unit_price numeric;
  v_product_name text;
  v_open_order jsonb;
begin
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
    select c.id as catalog_id, c.kitchen_inventory_item_id, c.product_name,
           c.po_unit, c.po_unit_factor, c.pack_size_po,
           kii.name as item_name, kii.item_code, kii.unit as item_unit
    from public.supplier_order_catalog_items c
    join public.kitchen_inventory_items kii
      on kii.id = c.kitchen_inventory_item_id
    where c.supplier_id = p_supplier_id
      and c.active
    order by c.sort_order, c.created_at, c.id
  loop
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
    v_unit_price := case
      when v_price is not null then round(v_price * v_item.po_unit_factor, 2)
      else null
    end;

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
      'stock', jsonb_build_object(
        'on_hand', v_on_hand,
        'daily_usage', v_daily,
        'days_left', v_days_left,
        'reorder_date', v_reorder_date,
        'last_count_date', v_last_count_date
      ),
      'proposal_qty', v_proposal,
      'unit_price', v_unit_price,
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

-- ---------------------------------------------------------------------------
-- 6. Candidate items from this supplier's PO / PR history
-- ---------------------------------------------------------------------------

create or replace function public.supplier_order_catalog_candidates(p_supplier_id uuid)
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

  if p_supplier_id is null then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

  with po_lines as materialized (
    select
      poi.id as line_id,
      poi.product_name,
      poi.created_at as line_created_at,
      po.order_date::timestamptz as occurred_at,
      po.supplier_id,
      public.normalize_stock_item_name(poi.product_name) as normalized_name
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    where po.supplier_id = p_supplier_id
  ),
  po_matches as materialized (
    select distinct on (pl.line_id)
      pl.line_id,
      pl.product_name,
      pl.line_created_at,
      pl.occurred_at,
      a.kitchen_inventory_item_id
    from po_lines pl
    join public.stock_material_aliases a
      on a.kitchen_inventory_item_id is not null
     and a.normalized_name = pl.normalized_name
     and (a.supplier_id = pl.supplier_id or a.supplier_id is null)
    order by pl.line_id,
             (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  pr_lines as materialized (
    select
      pri.id as line_id,
      pri.product_name,
      pri.created_at as line_created_at,
      pr.created_at as occurred_at,
      pr.supplier_id,
      public.normalize_stock_item_name(pri.product_name) as normalized_name
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pr.supplier_id = p_supplier_id
  ),
  pr_matches as materialized (
    select distinct on (pl.line_id)
      pl.line_id,
      pl.product_name,
      pl.line_created_at,
      pl.occurred_at,
      a.kitchen_inventory_item_id
    from pr_lines pl
    join public.stock_material_aliases a
      on a.kitchen_inventory_item_id is not null
     and a.normalized_name = pl.normalized_name
     and (a.supplier_id = pl.supplier_id or a.supplier_id is null)
    order by pl.line_id,
             (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  matches as (
    select line_id, product_name, line_created_at, occurred_at, kitchen_inventory_item_id
    from po_matches
    union all
    select line_id, product_name, line_created_at, occurred_at, kitchen_inventory_item_id
    from pr_matches
  ),
  aggregated as (
    select
      m.kitchen_inventory_item_id,
      max(m.occurred_at) as last_order_at,
      count(distinct m.line_id) as line_count,
      (array_agg(
        m.product_name
        order by m.occurred_at desc nulls last, m.line_created_at desc
      ))[1] as latest_product_name
    from matches m
    group by m.kitchen_inventory_item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'item_id', k.id,
    'name', k.name,
    'unit', k.unit,
    'latest_product_name', a.latest_product_name,
    'last_order_date', a.last_order_at::date,
    'line_count', a.line_count
  ) order by a.last_order_at desc nulls last, k.name), '[]'::jsonb)
  into v_result
  from (
    select a.*
    from aggregated a
    join public.kitchen_inventory_items k on k.id = a.kitchen_inventory_item_id
    where k.active = true
      and not exists (
        select 1
        from public.supplier_order_catalog_items c
        where c.supplier_id = p_supplier_id
          and c.kitchen_inventory_item_id = a.kitchen_inventory_item_id
          and c.active
      )
    order by a.last_order_at desc nulls last, k.name
    limit 50
  ) a
  join public.kitchen_inventory_items k on k.id = a.kitchen_inventory_item_id;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

create or replace function public.supplier_order_catalog_set(
  p_supplier_id uuid,
  p_item_id uuid,
  p_active boolean,
  p_po_unit text default 'kg',
  p_pack_size_po numeric default null,
  p_product_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item_unit text;
  v_factor numeric;
  v_row public.supplier_order_catalog_items%rowtype;
begin
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

  if p_supplier_id is null or p_item_id is null then
    raise exception 'invalid_catalog_item' using errcode = '22023';
  end if;

  if not exists (select 1 from public.suppliers where id = p_supplier_id) then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;

  select kii.unit into v_item_unit
  from public.kitchen_inventory_items kii
  where kii.id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  if coalesce(p_active, false) is false then
    update public.supplier_order_catalog_items
    set active = false,
        updated_at = now()
    where supplier_id = p_supplier_id
      and kitchen_inventory_item_id = p_item_id
    returning * into v_row;

    if not found then
      return null;
    end if;
    return to_jsonb(v_row);
  end if;

  v_factor := public.stock_unit_line_factor(p_po_unit, v_item_unit);
  if v_factor is null or v_factor <= 0 then
    raise exception 'unit_not_convertible' using errcode = '22023';
  end if;

  if p_pack_size_po is not null
     and (p_pack_size_po <= 0
          or p_pack_size_po::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_pack_size' using errcode = '22023';
  end if;

  -- A newly added item goes to the end of the supplier's list; a re-added
  -- item keeps its old place (sort_order is not updated on conflict).
  insert into public.supplier_order_catalog_items (
    supplier_id, kitchen_inventory_item_id, product_name, po_unit,
    po_unit_factor, pack_size_po, sort_order, active, created_by
  ) values (
    p_supplier_id, p_item_id,
    nullif(btrim(coalesce(p_product_name, '')), ''),
    p_po_unit, v_factor, p_pack_size_po,
    coalesce((
      select max(c.sort_order) + 1
      from public.supplier_order_catalog_items c
      where c.supplier_id = p_supplier_id
    ), 1),
    true, v_actor
  )
  on conflict (supplier_id, kitchen_inventory_item_id) do update
  set product_name = excluded.product_name,
      po_unit = excluded.po_unit,
      po_unit_factor = excluded.po_unit_factor,
      pack_size_po = excluded.pack_size_po,
      active = true,
      updated_at = now()
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Multi-line create (service role only)
-- ---------------------------------------------------------------------------

create or replace function public.create_supplier_order_multi(
  p_request_id uuid,
  p_supplier_id uuid,
  p_lines jsonb,
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
  v_role_before text;
  v_existing record;
  v_supplier public.suppliers%rowtype;
  v_forecast jsonb;
  v_max_amount numeric := 30000000;
  v_max_text text;
  v_line_count integer;
  v_distinct_count integer;
  v_line record;
  v_item_id uuid;
  v_quantity numeric;
  v_catalog record;
  v_fc jsonb;
  v_suggested numeric;
  v_proposal numeric;
  v_max_qty numeric;
  v_price numeric;
  v_unit_price numeric;
  v_product_name text;
  v_line_total numeric;
  v_total numeric := 0;
  v_lines jsonb := '[]'::jsonb;
  v_po_id uuid;
  v_po_number text;
  v_subject text;
  v_order_request_id uuid;
  v_po_item_id uuid;
  v_prepay jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_request_id is null or p_supplier_id is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;

  v_line_count := jsonb_array_length(p_lines);
  if v_line_count < 1 or v_line_count > 20 then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where jsonb_typeof(e) <> 'object'
  ) then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where not (e ? 'item_id')
       or not (e ? 'quantity')
       or coalesce(e ->> 'item_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'invalid_item_id' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where jsonb_typeof(e -> 'quantity') <> 'number'
  ) then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where (e ->> 'quantity')::numeric <= 0
       or (e ->> 'quantity')::numeric::text in ('NaN', 'Infinity', '-Infinity')
  ) then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;

  select count(distinct (e ->> 'item_id'))
  into v_distinct_count
  from jsonb_array_elements(p_lines) e;
  if v_distinct_count <> v_line_count then
    raise exception 'duplicate_items' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));

  select r.*, po.po_number as existing_po_number,
         pr.request_number as prepay_request_number,
         ps.submission_number as prepay_submission_number
  into v_existing
  from public.supplier_order_requests r
  left join public.purchase_orders po on po.id = r.purchase_order_id
  left join public.payment_requests pr on pr.id = r.prepay_request_id
  left join public.payment_submissions ps on ps.id = r.prepay_submission_id
  where r.request_id = p_request_id;

  if found then
    return jsonb_build_object(
      'in_progress', v_existing.status = 'preparing'
        and v_existing.created_at > now() - interval '2 minutes',
      'request_id', v_existing.request_id,
      'order_request_id', v_existing.id,
      'purchase_order_id', v_existing.purchase_order_id,
      'po_number', v_existing.existing_po_number,
      'to_email', v_existing.to_email,
      'subject', v_existing.subject,
      'status', v_existing.status,
      'total', v_existing.total_amount,
      'note', v_existing.note,
      'sent_at', v_existing.sent_at,
      'supplier_name', (
        select btrim(s.name) from public.suppliers s where s.id = v_existing.supplier_id
      ),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
          'position', l.position,
          'item_id', l.kitchen_inventory_item_id,
          'product_name', l.product_name,
          'quantity', l.quantity,
          'unit', l.unit,
          'unit_price', l.unit_price,
          'line_total', l.line_total
        ) order by l.position)
        from public.supplier_order_request_lines l
        where l.request_id = v_existing.id
      ), '[]'::jsonb),
      'prepay', case
        when v_existing.prepay_status is null then null
        else jsonb_build_object(
          'status', v_existing.prepay_status,
          'request_number', v_existing.prepay_request_number,
          'submission_number', v_existing.prepay_submission_number
        )
      end,
      'replayed', true
    );
  end if;

  select * into v_supplier
  from public.suppliers
  where id = p_supplier_id;
  if not found then
    raise exception 'no_supplier' using errcode = 'P0001';
  end if;

  if nullif(btrim(coalesce(v_supplier.email, '')), '') is null then
    raise exception 'no_supplier_email' using errcode = 'P0001';
  end if;

  v_role_before := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_forecast := public.get_q7_purchase_forecast(v_today, 14);
  perform set_config('request.jwt.claim.role', coalesce(v_role_before, ''), true);

  select value into v_max_text
  from public.app_settings
  where key = 'order_email_max_amount';
  if nullif(btrim(coalesce(v_max_text, '')), '') is not null then
    v_max_amount := v_max_text::numeric;
  end if;
  if v_max_amount is null or v_max_amount <= 0 then
    v_max_amount := 30000000;
  end if;

  for v_line in
    select value as line, ordinality::integer as position
    from jsonb_array_elements(p_lines) with ordinality
  loop
    v_item_id := (v_line.line ->> 'item_id')::uuid;
    v_quantity := (v_line.line ->> 'quantity')::numeric;

    select c.id as catalog_id, c.product_name, c.po_unit, c.po_unit_factor,
           c.pack_size_po, kii.name as item_name, kii.unit as item_unit
    into v_catalog
    from public.supplier_order_catalog_items c
    join public.kitchen_inventory_items kii
      on kii.id = c.kitchen_inventory_item_id
    where c.supplier_id = p_supplier_id
      and c.kitchen_inventory_item_id = v_item_id
      and c.active;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;

    select e.value into v_fc
    from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
    where e.value ->> 'item_id' = v_item_id::text
    limit 1;

    v_suggested := coalesce(nullif(v_fc ->> 'suggested_qty', '')::numeric, 0);
    if v_suggested > 0 and v_catalog.po_unit_factor > 0 then
      v_proposal := v_suggested / v_catalog.po_unit_factor;
      if v_catalog.pack_size_po is not null and v_catalog.pack_size_po > 0 then
        v_proposal := ceil(v_proposal / v_catalog.pack_size_po) * v_catalog.pack_size_po;
      else
        v_proposal := ceil(v_proposal);
      end if;
      v_proposal := round(v_proposal, 3);
    else
      v_proposal := 0;
    end if;

    v_max_qty := greatest(3 * coalesce(v_proposal, 0), 10 * coalesce(v_catalog.pack_size_po, 0));
    if v_max_qty <= 0 then
      v_max_qty := 3 * coalesce(v_proposal, 0);
    end if;
    if v_quantity > v_max_qty then
      raise exception 'over_quantity_limit' using errcode = 'P0001';
    end if;

    v_price := public.supplier_order_line_price(p_supplier_id, v_item_id);
    if v_price is null then
      raise exception 'no_price' using errcode = 'P0001';
    end if;

    v_unit_price := round(v_price * v_catalog.po_unit_factor, 2);
    if v_unit_price is null then
      raise exception 'no_price' using errcode = 'P0001';
    end if;

    v_product_name := nullif(btrim(coalesce(v_catalog.product_name, '')), '');
    if v_product_name is null then
      select poi.product_name
      into v_product_name
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      join lateral (
        select a.*
        from public.stock_material_aliases a
        where a.kitchen_inventory_item_id = v_item_id
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
      v_product_name := v_catalog.item_name;
    end if;

    v_line_total := round(v_quantity * v_unit_price, 2);
    v_total := v_total + v_line_total;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'position', v_line.position,
      'item_id', v_item_id,
      'product_name', v_product_name,
      'quantity', v_quantity,
      'unit', v_catalog.po_unit,
      'unit_price', v_unit_price,
      'line_total', v_line_total
    ));
  end loop;

  v_total := round(v_total, 2);
  if v_total > v_max_amount then
    raise exception 'over_amount_limit' using errcode = 'P0001';
  end if;

  v_po_id := gen_random_uuid();
  v_po_number := public.generate_po_number();
  v_subject := 'BMQ đặt hàng ' || v_po_number || ' – ' || btrim(v_supplier.name);

  insert into public.purchase_orders (
    id, po_number, supplier_id, status, order_date, notes,
    created_by, total_amount
  ) values (
    v_po_id, v_po_number, p_supplier_id, 'draft'::public.purchase_order_status,
    v_today, 'Đặt hàng qua email order@bmq.vn', p_actor, v_total
  );

  v_order_request_id := gen_random_uuid();
  insert into public.supplier_order_requests (
    id, request_id, kitchen_inventory_item_id, supplier_id, purchase_order_id,
    to_email, subject, quantity, unit, unit_price, line_total, total_amount,
    note, status, created_by
  ) values (
    v_order_request_id, p_request_id, null, p_supplier_id, v_po_id,
    btrim(v_supplier.email), v_subject, null, null, null, v_total, v_total,
    nullif(btrim(coalesce(p_note, '')), ''), 'preparing', p_actor
  );

  for v_line in
    select value as line, ordinality::integer as position
    from jsonb_array_elements(v_lines) with ordinality
  loop
    insert into public.purchase_order_items (
      purchase_order_id, product_name, quantity, unit, unit_price, line_total
    ) values (
      v_po_id,
      v_line.line ->> 'product_name',
      (v_line.line ->> 'quantity')::numeric,
      v_line.line ->> 'unit',
      (v_line.line ->> 'unit_price')::numeric,
      (v_line.line ->> 'line_total')::numeric
    )
    returning id into v_po_item_id;

    insert into public.supplier_order_request_lines (
      request_id, position, kitchen_inventory_item_id, product_name,
      quantity, unit, unit_price, line_total, purchase_order_item_id
    ) values (
      v_order_request_id,
      (v_line.line ->> 'position')::integer,
      (v_line.line ->> 'item_id')::uuid,
      v_line.line ->> 'product_name',
      (v_line.line ->> 'quantity')::numeric,
      v_line.line ->> 'unit',
      (v_line.line ->> 'unit_price')::numeric,
      (v_line.line ->> 'line_total')::numeric,
      v_po_item_id
    );
  end loop;

  return jsonb_build_object(
    'request_id', p_request_id,
    'order_request_id', v_order_request_id,
    'purchase_order_id', v_po_id,
    'po_number', v_po_number,
    'to_email', btrim(v_supplier.email),
    'subject', v_subject,
    'status', 'preparing',
    'in_progress', false,
    'supplier_name', btrim(v_supplier.name),
    'lines', v_lines,
    'total', v_total,
    'note', nullif(btrim(coalesce(p_note, '')), ''),
    'prepay', null,
    'replayed', false
  );
end;
$$;

create or replace function public.record_supplier_order_prepay(
  p_request_id uuid,
  p_status text,
  p_pr_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_request_number text;
  v_submission_number text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_status is null or p_status not in (
    'created', 'skipped_none', 'skipped_recent', 'declined', 'forbidden', 'failed'
  ) then
    raise exception 'invalid_prepay_status' using errcode = '22023';
  end if;

  select * into v_request
  from public.supplier_order_requests
  where request_id = p_request_id or id = p_request_id
  for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  update public.supplier_order_requests
  set prepay_status = p_status,
      prepay_request_id = p_pr_id,
      prepay_submission_id = p_submission_id
  where id = v_request.id;

  select pr.request_number into v_request_number
  from public.payment_requests pr
  where pr.id = p_pr_id;

  select ps.submission_number into v_submission_number
  from public.payment_submissions ps
  where ps.id = p_submission_id;

  return jsonb_build_object(
    'request_id', v_request.request_id,
    'order_request_id', v_request.id,
    'prepay_status', p_status,
    'request_number', v_request_number,
    'submission_number', v_submission_number
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. History reads
-- ---------------------------------------------------------------------------

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
    select req.id, req.request_id, po.po_number,
           case
             when l.id is not null then l.quantity
             else req.quantity
           end as quantity,
           case
             when l.id is not null then l.unit
             else req.unit
           end as unit,
           case
             when l.id is not null then l.line_total
             else req.line_total
           end as line_total,
           req.status, req.sent_at, req.to_email, req.created_at
    from public.supplier_order_requests req
    left join public.purchase_orders po on po.id = req.purchase_order_id
    left join public.supplier_order_request_lines l
      on l.request_id = req.id
     and l.kitchen_inventory_item_id = p_item_id
    where req.kitchen_inventory_item_id = p_item_id
       or l.id is not null
    order by req.created_at desc
    limit 10
  ) r;

  return jsonb_build_object('items', v_items);
end;
$$;

create or replace function public.supplier_order_history_by_supplier(p_supplier_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_items jsonb;
begin
  if p_supplier_id is null then
    raise exception 'supplier_required' using errcode = '22023';
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
    'total', coalesce(r.total_amount, r.line_total),
    'status', r.status,
    'sent_at', r.sent_at,
    'to_email', r.to_email,
    'created_at', r.created_at,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'position', l.position,
        'item_id', l.kitchen_inventory_item_id,
        'product_name', l.product_name,
        'quantity', l.quantity,
        'unit', l.unit,
        'unit_price', l.unit_price,
        'line_total', l.line_total
      ) order by l.position)
      from public.supplier_order_request_lines l
      where l.request_id = r.id
    ), case
      -- A single-item order from the kho item card has no line rows.
      when r.kitchen_inventory_item_id is not null then jsonb_build_array(jsonb_build_object(
        'position', 1,
        'item_id', r.kitchen_inventory_item_id,
        'product_name', coalesce((
          select poi.product_name
          from public.purchase_order_items poi
          where poi.purchase_order_id = r.purchase_order_id
          order by poi.created_at
          limit 1
        ), (
          select k.name from public.kitchen_inventory_items k
          where k.id = r.kitchen_inventory_item_id
        )),
        'quantity', r.quantity,
        'unit', r.unit,
        'unit_price', r.unit_price,
        'line_total', r.line_total
      ))
      else '[]'::jsonb
    end),
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
    ), '[]'::jsonb),
    'prepay', case
      when r.prepay_status is null then null
      else jsonb_build_object(
        'status', r.prepay_status,
        'request_number', pr.request_number,
        'submission_number', ps.submission_number
      )
    end
  ) order by r.created_at desc), '[]'::jsonb)
  into v_items
  from (
    select req.*, po.po_number as po_number
    from public.supplier_order_requests req
    left join public.purchase_orders po on po.id = req.purchase_order_id
    where req.supplier_id = p_supplier_id
    order by req.created_at desc
    limit 20
  ) r
  left join public.payment_requests pr on pr.id = r.prepay_request_id
  left join public.payment_submissions ps on ps.id = r.prepay_submission_id;

  return jsonb_build_object('items', v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.prepare_supplier_order(uuid) from public, anon;
grant execute on function public.prepare_supplier_order(uuid)
  to authenticated, service_role;

revoke all on function public.supplier_order_suppliers() from public, anon;
grant execute on function public.supplier_order_suppliers()
  to authenticated, service_role;

revoke all on function public.supplier_order_catalog(uuid) from public, anon;
grant execute on function public.supplier_order_catalog(uuid)
  to authenticated, service_role;

revoke all on function public.supplier_order_catalog_candidates(uuid) from public, anon;
grant execute on function public.supplier_order_catalog_candidates(uuid)
  to authenticated, service_role;

revoke all on function public.supplier_order_catalog_set(uuid, uuid, boolean, text, numeric, text)
  from public, anon;
grant execute on function public.supplier_order_catalog_set(uuid, uuid, boolean, text, numeric, text)
  to authenticated, service_role;

revoke all on function public.create_supplier_order_multi(uuid, uuid, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_supplier_order_multi(uuid, uuid, jsonb, text, uuid)
  to service_role;

revoke all on function public.record_supplier_order_prepay(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.record_supplier_order_prepay(uuid, text, uuid, uuid)
  to service_role;

revoke all on function public.supplier_order_history(uuid) from public, anon;
grant execute on function public.supplier_order_history(uuid)
  to authenticated, service_role;

revoke all on function public.supplier_order_history_by_supplier(uuid) from public, anon;
grant execute on function public.supplier_order_history_by_supplier(uuid)
  to authenticated, service_role;
