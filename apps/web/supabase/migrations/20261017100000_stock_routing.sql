-- Giai đoạn 3: tự chọn kho nhận theo nhà cung cấp, bỏ hàng không tồn kho, nhóm mã NVL.
--
-- Additive migration for the stock routing flow (data layer only). It adds:
--   * suppliers.stock_exempt plus the source/timestamp of the assigned warehouse;
--   * supplier_routing_suggestions (Jev proposes q7 / tan_tao / non_stock);
--   * stock_material_categories + material_category_suggestions for the
--     sku_cogs_materials.category group;
--   * stock_material_aliases.line_class stock / non_stock;
--   * material_alias_events.previous_line_class / new_line_class for undo;
--   * redefined post_stock_goods_receipt_item / post_goods_receipt_to_stock /
--     get_stock_ledger_overview (same signatures, non_stock + stock_exempt are
--     skipped, every idempotency key kept);
--   * redefined confirm_material_alias (new 13-argument overload + the old
--     12-argument wrapper), suggest_material_aliases, get_material_alias_review and
--     undo_material_alias_event so a non_stock alias needs no item / SKU;
--   * supplier_routing_evidence, apply / revert / decide supplier routing and
--     decide / revert material category RPCs, plus get_stock_routing_review.
--
-- It never applies a migration by itself, never deploys and never calls Jev.
-- No UPDATE or DELETE on purchase_orders, purchase_order_items, payment_requests,
-- payment_request_items or goods_receipt_items. The only UPDATE on goods_receipts
-- is the receiving_location fill inside apply_supplier_routing.

-- ---------------------------------------------------------------------------
-- 1. suppliers: stock-exempt flag and where the receiving warehouse came from
-- ---------------------------------------------------------------------------

alter table public.suppliers
  add column if not exists stock_exempt boolean not null default false,
  add column if not exists receiving_location_source text,
  add column if not exists receiving_location_set_at timestamptz;

alter table public.suppliers
  drop constraint if exists suppliers_receiving_location_source_check;
alter table public.suppliers
  add constraint suppliers_receiving_location_source_check
  check (receiving_location_source is null or receiving_location_source in ('manual', 'jev', 'rule'));

-- ---------------------------------------------------------------------------
-- 2. Fixed material category catalog (seed shared with the TS layer / edge)
-- ---------------------------------------------------------------------------

create table if not exists public.stock_material_categories (
  code text primary key,
  label_vi text not null,
  sort_order integer not null default 0
);

insert into public.stock_material_categories (code, label_vi, sort_order) values
  ('flour', 'Bột và ngũ cốc', 10),
  ('dairy_fat', 'Sữa, bơ, chất béo', 20),
  ('eggs', 'Trứng', 30),
  ('sugar_additives', 'Đường và phụ gia', 40),
  ('meat_filling', 'Nhân thịt, chả, pate', 50),
  ('cheese', 'Phô mai', 60),
  ('vegetables', 'Rau củ, gia vị', 70),
  ('packaging', 'Bao bì', 80),
  ('supplies', 'Vật tư, dụng cụ', 90),
  ('service', 'Dịch vụ, phí', 100),
  ('other', 'Khác', 110)
on conflict (code) do update
  set label_vi = excluded.label_vi,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 3. Supplier routing suggestions (one row per supplier + prompt version)
-- ---------------------------------------------------------------------------

create table if not exists public.supplier_routing_suggestions (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  proposed_location text not null check (proposed_location in ('q7', 'tan_tao', 'non_stock')),
  probability numeric(5, 4) not null check (probability >= 0 and probability <= 1),
  jev_answer jsonb,
  evidence jsonb,
  prompt_version text not null,
  cost numeric(18, 8),
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'rejected', 'reverted', 'superseded')),
  applied_by uuid references auth.users(id) on delete set null,
  applied_at timestamptz,
  previous_location text,
  previous_exempt boolean,
  created_at timestamptz not null default now(),
  constraint supplier_routing_suggestions_cost_check check (
    cost is null or (cost >= 0 and cost::text not in ('NaN', 'Infinity', '-Infinity'))
  ),
  constraint supplier_routing_suggestions_unique_prompt unique (supplier_id, prompt_version)
);

create index if not exists idx_supplier_routing_suggestions_status
  on public.supplier_routing_suggestions(status, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Material category suggestions (one row per material + prompt version)
-- ---------------------------------------------------------------------------

create table if not exists public.material_category_suggestions (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.sku_cogs_materials(id) on delete cascade,
  proposed_category text not null references public.stock_material_categories(code),
  probability numeric(5, 4) not null check (probability >= 0 and probability <= 1),
  jev_answer jsonb,
  prompt_version text not null,
  cost numeric(18, 8),
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'rejected', 'reverted', 'superseded')),
  previous_category text,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint material_category_suggestions_cost_check check (
    cost is null or (cost >= 0 and cost::text not in ('NaN', 'Infinity', '-Infinity'))
  ),
  constraint material_category_suggestions_unique_prompt unique (material_id, prompt_version)
);

create index if not exists idx_material_category_suggestions_status
  on public.material_category_suggestions(status, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. stock_material_aliases: line_class stock / non_stock
-- ---------------------------------------------------------------------------

alter table public.stock_material_aliases
  add column if not exists line_class text not null default 'stock';

alter table public.stock_material_aliases
  drop constraint if exists stock_material_aliases_line_class_check;
alter table public.stock_material_aliases
  add constraint stock_material_aliases_line_class_check
  check (line_class in ('stock', 'non_stock'));

-- A non_stock alias needs neither a kitchen item nor a Tân Tạo SKU.
alter table public.stock_material_aliases
  drop constraint if exists stock_material_aliases_location_item_check;
alter table public.stock_material_aliases
  add constraint stock_material_aliases_location_item_check check (
    (line_class = 'non_stock' and kitchen_inventory_item_id is null and tan_tao_sku_id is null)
    or (
      line_class = 'stock'
      and (
        (location = 'q7' and kitchen_inventory_item_id is not null and tan_tao_sku_id is null)
        or (location = 'tan_tao' and tan_tao_sku_id is not null and kitchen_inventory_item_id is null)
      )
    )
  );

-- Undo needs the line class each event moved away from / to.
alter table public.material_alias_events
  add column if not exists previous_line_class text,
  add column if not exists new_line_class text;

-- ---------------------------------------------------------------------------
-- 6. post_stock_goods_receipt_item: skip a non_stock alias (same signature)
-- ---------------------------------------------------------------------------

create or replace function public.post_stock_goods_receipt_item(
  p_item_id uuid,
  p_alias public.stock_material_aliases
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_qty numeric;
  v_inserted integer := 0;
  v_sku_code text;
  v_doc_id uuid;
  v_doc_number text;
begin
  -- [Giai đoạn 3] A non_stock alias never moves stock.
  if p_alias.line_class = 'non_stock' then
    return false;
  end if;

  select * into v_item from public.goods_receipt_items where id = p_item_id;
  if not found then
    return false;
  end if;
  select * into v_receipt from public.goods_receipts where id = v_item.goods_receipt_id;
  if not found then
    return false;
  end if;

  v_qty := round(greatest(0, coalesce(v_item.actual_quantity, v_item.quantity, 0)) * p_alias.conversion_factor, 3);
  if v_qty is null or v_qty <= 0 then
    return false;
  end if;

  if p_alias.location = 'q7' then
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_alias.kitchen_inventory_item_id, v_receipt.receipt_date, 'receipt', v_qty,
      p_alias.unit, 'goods_receipt', 'gr-item:' || p_item_id::text,
      'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
    get diagnostics v_inserted = row_count;
    return v_inserted > 0;
  end if;

  if p_alias.location = 'tan_tao' then
    if public.stock_goods_receipt_item_is_posted(p_item_id) then
      return false;
    end if;
    select upper(sku_code) into v_sku_code
    from public.product_skus
    where id = p_alias.tan_tao_sku_id;
    if v_sku_code is null
       or v_sku_code not in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G') then
      return false;
    end if;

    v_doc_number := 'TT-GR-' || to_char(coalesce(v_receipt.receipt_date, current_date), 'YYYYMMDD')
      || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

    insert into public.tan_tao_warehouse_documents(
      document_number, location_code, sku_id, sku_code_snapshot, document_type, status,
      quantity, physical_quantity, source_authority, reference_type, reference_id,
      reference_label, idempotency_key, note, metadata, created_by
    ) values (
      v_doc_number, 'warehouse_tan_tao', p_alias.tan_tao_sku_id, v_sku_code, 'receipt', 'posted',
      v_qty, v_qty, 'confirmed_goods_receipt', 'goods_receipt', v_receipt.id,
      v_receipt.receipt_number, 'gr-item:' || p_item_id::text,
      'Phiếu nhập kho ' || v_receipt.receipt_number,
      jsonb_build_object('goods_receipt_id', v_receipt.id, 'goods_receipt_item_id', p_item_id, 'stock_effect', 'receipt'),
      auth.uid()
    )
    on conflict (idempotency_key) do nothing
    returning id into v_doc_id;

    if v_doc_id is null then
      return false;
    end if;

    insert into public.tan_tao_warehouse_movements(
      document_id, location_code, sku_id, sku_code_snapshot, movement_type, quantity, note, created_by
    ) values (
      v_doc_id, 'warehouse_tan_tao', p_alias.tan_tao_sku_id, v_sku_code, 'receipt', v_qty,
      'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
    );
    return true;
  end if;

  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. post_goods_receipt_to_stock: skip a stock_exempt supplier / non_stock line
-- ---------------------------------------------------------------------------

create or replace function public.post_goods_receipt_to_stock(p_receipt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.goods_receipts%rowtype;
  v_cutover date;
  v_item record;
  v_name text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_posted integer := 0;
  v_pending integer := 0;
  v_supplier_exempt boolean := false; -- [Giai đoạn 3]
begin
  select * into v_receipt from public.goods_receipts where id = p_receipt_id;
  if not found then
    return jsonb_build_object('status', 'receipt_not_found');
  end if;

  -- [Giai đoạn 3] A stock_exempt supplier (dịch vụ, phí, vận chuyển) never posts.
  if v_receipt.supplier_id is not null then
    select s.stock_exempt into v_supplier_exempt
    from public.suppliers s
    where s.id = v_receipt.supplier_id;
  end if;
  if coalesce(v_supplier_exempt, false) then
    return jsonb_build_object(
      'status', 'supplier_exempt',
      'receipt_id', p_receipt_id,
      'supplier_id', v_receipt.supplier_id
    );
  end if;

  if v_receipt.status not in ('confirmed', 'received') then
    return jsonb_build_object('status', 'not_confirmed');
  end if;
  if v_receipt.receiving_location is null then
    return jsonb_build_object('status', 'missing_receiving_location');
  end if;

  v_cutover := public.stock_ledger_cutover_date(v_receipt.receiving_location);
  if v_cutover is null then
    return jsonb_build_object('status', 'cutover_not_set');
  end if;
  if v_receipt.receipt_date < v_cutover then
    return jsonb_build_object('status', 'before_cutover');
  end if;

  for v_item in
    select gri.id,
           coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as item_name
    from public.goods_receipt_items gri
    where gri.goods_receipt_id = p_receipt_id
    order by gri.created_at asc, gri.id asc
  loop
    v_norm := public.normalize_stock_item_name(v_item.item_name);
    if v_norm is null then
      v_pending := v_pending + 1;
      continue;
    end if;

    v_alias := null;
    select * into v_alias
    from public.resolve_stock_material_alias(v_receipt.supplier_id, v_norm, v_receipt.receiving_location);
    if v_alias.id is null then
      v_pending := v_pending + 1;
      continue;
    end if;

    -- [Giai đoạn 3] A non_stock alias is intentionally skipped and is not pending.
    if v_alias.line_class = 'non_stock' then
      continue;
    end if;

    if public.post_stock_goods_receipt_item(v_item.id, v_alias) then
      v_posted := v_posted + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'posted',
    'receipt_id', p_receipt_id,
    'location', v_receipt.receiving_location,
    'posted_count', v_posted,
    'pending_alias_count', v_pending
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. get_stock_ledger_overview: pending excludes non_stock aliases + exempt suppliers
-- ---------------------------------------------------------------------------

create or replace function public.get_stock_ledger_overview(
  p_location text,
  p_as_of date default current_date
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
  v_cutover date;
  v_location_name text;
  v_items jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
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

  if p_location = 'q7' then
    v_location_name := 'Kho NVL Q7';
    select coalesce(jsonb_agg(jsonb_build_object(
             'item_id', x.item_id,
             'item_code', x.item_code,
             'item_name', x.item_name,
             'unit', x.unit,
             'current_qty', x.balance_qty,
             'in_qty_7d', x.in_qty_7d,
             'out_qty_7d', x.out_qty_7d,
             'last_count_date', x.last_count_date,
             'last_count_difference', x.last_count_difference,
             'is_low_stock', (x.out_qty_7d > 0 and x.balance_qty < (x.out_qty_7d / 7.0) * 3)
           ) order by x.item_name), '[]'::jsonb)
    into v_items
    from (
      select s.kitchen_inventory_item_id as item_id,
             kii.item_code,
             s.item_name,
             s.unit,
             s.balance_qty,
             coalesce((
               select sum(m.quantity)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = s.kitchen_inventory_item_id
                 and m.movement_type = 'receipt'
                 and m.movement_date between v_as_of - 6 and v_as_of
             ), 0)::numeric as in_qty_7d,
             coalesce((
               select sum(m.quantity)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = s.kitchen_inventory_item_id
                 and m.movement_type = 'production_usage'
                 and m.movement_date between v_as_of - 6 and v_as_of
             ), 0)::numeric as out_qty_7d,
             (
               select max(m.movement_date)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = s.kitchen_inventory_item_id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'q7-stock-count:%'
                 and m.movement_date <= v_as_of
             ) as last_count_date,
             (
               select m.quantity
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = s.kitchen_inventory_item_id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'q7-stock-count:%'
                 and m.movement_date <= v_as_of
               order by m.movement_date desc, m.created_at desc, m.id desc
               limit 1
             ) as last_count_difference
      from public.get_q7_inventory_snapshot(v_as_of) s
      join public.kitchen_inventory_items kii on kii.id = s.kitchen_inventory_item_id
    ) x;
  else
    v_location_name := 'Kho Tân Tạo';
    select coalesce(jsonb_agg(jsonb_build_object(
             'item_id', x.item_id,
             'item_code', x.item_code,
             'item_name', x.item_name,
             'unit', x.unit,
             'current_qty', x.balance_qty,
             'in_qty_7d', x.in_qty_7d,
             'out_qty_7d', x.out_qty_7d,
             'last_count_date', x.last_count_date,
             'last_count_difference', x.last_count_difference,
             'is_low_stock', (x.out_qty_7d > 0 and x.balance_qty < (x.out_qty_7d / 7.0) * 3)
           ) order by x.item_name), '[]'::jsonb)
    into v_items
    from (
      select (it ->> 'sku_id') as item_id,
             (it ->> 'sku_code') as item_code,
             (it ->> 'product_name') as item_name,
             (it ->> 'unit') as unit,
             coalesce((it ->> 'on_hand_quantity')::numeric, 0) as balance_qty,
             coalesce((
               select sum(m.quantity)
               from public.tan_tao_warehouse_movements m
               where m.sku_id = (it ->> 'sku_id')::uuid
                 and m.movement_type in ('receipt', 'opening')
                 and m.created_at >= (v_as_of - 6)::timestamptz
                 and m.created_at < (v_as_of + 1)::timestamptz
             ), 0)::numeric as in_qty_7d,
             coalesce((
               select sum(-m.quantity)
               from public.tan_tao_warehouse_movements m
               where m.sku_id = (it ->> 'sku_id')::uuid
                 and m.movement_type = 'dispatch'
                 and m.created_at >= (v_as_of - 6)::timestamptz
                 and m.created_at < (v_as_of + 1)::timestamptz
             ), 0)::numeric as out_qty_7d,
             (
               select (d.created_at at time zone 'Asia/Ho_Chi_Minh')::date
               from public.tan_tao_warehouse_documents d
               where d.sku_id = (it ->> 'sku_id')::uuid
                 and d.document_type = 'stock_count'
               order by d.created_at desc
               limit 1
             ) as last_count_date,
             (
               select coalesce(nullif(d.metadata ->> 'adjustment_quantity', '')::numeric, 0)
               from public.tan_tao_warehouse_documents d
               where d.sku_id = (it ->> 'sku_id')::uuid
                 and d.document_type = 'stock_count'
               order by d.created_at desc
               limit 1
             ) as last_count_difference
      from jsonb_array_elements(public.get_tan_tao_warehouse_snapshot() -> 'items') it
      where it ->> 'sku_id' is not null
    ) x;
  end if;

  if v_cutover is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'goods_receipt_item_id', p.goods_receipt_item_id,
             'receipt_number', p.receipt_number,
             'supplier', p.supplier_name,
             'product_name', p.product_name,
             'normalized_name', p.normalized_name,
             'quantity', p.quantity,
             'receipt_date', p.receipt_date
           ) order by p.receipt_date, p.receipt_number), '[]'::jsonb)
    into v_pending
    from (
      select gri.id as goods_receipt_item_id,
             gr.receipt_number,
             sup.name as supplier_name,
             gri.product_name,
             ra.normalized_name,
             greatest(0, coalesce(gri.actual_quantity, gri.quantity, 0))::numeric as quantity,
             gr.receipt_date
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      left join public.suppliers sup on sup.id = gr.supplier_id
      -- [Giai đoạn 3] resolved alias (if any), kept from resolve_stock_material_alias.
      left join lateral (
        select
          public.normalize_stock_item_name(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) as normalized_name,
          a.id as alias_id,
          a.line_class as line_class
        from public.resolve_stock_material_alias(
               gr.supplier_id,
               public.normalize_stock_item_name(
                 coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
               ),
               p_location
             ) a
      ) ra on true
      where gr.receiving_location = p_location
        and gr.status in ('confirmed', 'received')
        and gr.receipt_date >= v_cutover
        -- [Giai đoạn 3] a stock_exempt supplier is not waiting for an alias.
        and coalesce(sup.stock_exempt, false) = false
        and ra.alias_id is null
        -- [Giai đoạn 3] a non_stock alias never shows as pending.
        and coalesce(ra.line_class, 'stock') <> 'non_stock'
        and not public.stock_goods_receipt_item_is_posted(gri.id)
    ) p;
  end if;

  return jsonb_build_object(
    'location', p_location,
    'location_name', v_location_name,
    'as_of', v_as_of,
    'cutover_date', v_cutover,
    'items', v_items,
    'pending_aliases', v_pending
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. confirm_material_alias: new 13-arg overload, old 12-arg wrapper
-- ---------------------------------------------------------------------------

create or replace function public.confirm_material_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric,
  p_source_table text,
  p_source_id uuid,
  p_line_class text default 'stock'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_array uuid[];
  v_norm text;
  v_unit text;
  v_factor numeric;
  v_pack_label text;
  v_alias public.stock_material_aliases%rowtype;
  v_same boolean;
  v_action text;
  v_jev_disagreed boolean;
  v_new_item uuid;
  v_new_sku uuid;
  v_chosen uuid;
  v_confirmers uuid[];
  v_distinct integer;
  v_cutover date;
  v_target record;
  v_applied integer := 0;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  -- [Giai đoạn 3] line_class is stock or non_stock.
  if p_line_class not in ('stock', 'non_stock') then
    raise exception 'line_class_invalid' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_actor_array := case when v_actor is null then '{}'::uuid[] else array[v_actor] end;
  v_norm := public.normalize_stock_item_name(p_raw_name);
  if v_norm is null then raise exception 'item_name_required' using errcode = '22023'; end if;

  if p_line_class = 'non_stock' then
    -- No item / SKU is required and the unit falls back to the raw label.
    v_new_item := null;
    v_new_sku := null;
    v_factor := 1;
    v_unit := coalesce(nullif(btrim(p_raw_unit), ''), '-');
  else
    if p_conversion_factor is null or p_conversion_factor <= 0
       or p_conversion_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_conversion_factor' using errcode = '22023';
    end if;
    v_factor := p_conversion_factor;

    if p_location = 'q7' then
      if p_kitchen_inventory_item_id is null then
        raise exception 'kitchen_inventory_item_required' using errcode = '22023';
      end if;
      select kii.unit into v_unit
      from public.kitchen_inventory_items kii
      where kii.id = p_kitchen_inventory_item_id
        and kii.active = true
        and kii.merged_into_id is null;
      if v_unit is null then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;
      v_new_item := p_kitchen_inventory_item_id;
      v_new_sku := null;
    else
      if p_tan_tao_sku_id is null then
        raise exception 'tan_tao_sku_required' using errcode = '22023';
      end if;
      select ps.unit into v_unit
      from public.product_skus ps
      where ps.id = p_tan_tao_sku_id
        and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');
      if v_unit is null then raise exception 'tan_tao_sku_not_found' using errcode = 'P0002'; end if;
      v_new_item := null;
      v_new_sku := p_tan_tao_sku_id;
    end if;
  end if;

  v_pack_label := nullif(btrim(coalesce(p_entered_unit_label, '')), '');
  if v_pack_label is null then
    v_pack_label := public.q7_pack_from_name(p_raw_name, p_raw_unit) ->> 'pack_label';
  end if;

  v_chosen := coalesce(v_new_item, v_new_sku);
  v_jev_disagreed := p_jev_item_id is not null
    and p_jev_item_id is distinct from v_chosen
    and coalesce(p_jev_probability, 0) >= 0.9;

  select * into v_alias
  from public.stock_material_aliases a
  where a.location = p_location
    and a.normalized_name = v_norm
    and a.supplier_id is not distinct from p_supplier_id
  for update;

  if not found then
    insert into public.stock_material_aliases(
      supplier_id, normalized_name, location, kitchen_inventory_item_id,
      tan_tao_sku_id, conversion_factor, unit, created_by,
      confirm_count, confirmers, status, pack_label, last_confirmed_at,
      jev_item_id, jev_probability, jev_disagreed, line_class
    ) values (
      p_supplier_id, v_norm, p_location, v_new_item,
      v_new_sku, v_factor, v_unit, v_actor,
      1, v_actor_array, 'learning', v_pack_label, now(),
      p_jev_item_id, p_jev_probability, v_jev_disagreed, p_line_class
    )
    returning * into v_alias;
    v_action := 'confirm';
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
    ) values (
      v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
    );
  else
    -- [Giai đoạn 3] switching stock <-> non_stock counts as a correction.
    v_same := (v_alias.line_class is not distinct from p_line_class)
      and (v_alias.kitchen_inventory_item_id is not distinct from v_new_item)
      and (v_alias.tan_tao_sku_id is not distinct from v_new_sku)
      and (v_alias.conversion_factor = v_factor);

    if v_same then
      v_confirmers := coalesce(v_alias.confirmers, '{}'::uuid[]);
      if v_actor is not null and not (v_actor = any (v_confirmers)) then
        v_confirmers := v_confirmers || v_actor;
      end if;
      update public.stock_material_aliases
        set confirm_count = v_alias.confirm_count + 1,
            confirmers = v_confirmers,
            last_confirmed_at = now(),
            pack_label = coalesce(v_pack_label, pack_label),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
      v_action := 'confirm';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
      );
    else
      v_action := 'correct';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        previous_item_id, previous_sku_id, previous_factor, previous_line_class,
        new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'correct', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
        v_alias.line_class,
        v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
      );
      update public.stock_material_aliases
        set kitchen_inventory_item_id = v_new_item,
            tan_tao_sku_id = v_new_sku,
            conversion_factor = v_factor,
            unit = v_unit,
            line_class = p_line_class,
            pack_label = v_pack_label,
            confirm_count = 1,
            confirmers = v_actor_array,
            status = 'learning',
            last_confirmed_at = now(),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
    end if;
  end if;

  -- Auto-promote only when the state actually changes.
  select count(distinct c) into v_distinct
  from unnest(coalesce(v_alias.confirmers, '{}'::uuid[])) c;
  if (v_alias.confirm_count >= 3 or v_distinct >= 2) and v_alias.status <> 'auto' then
    update public.stock_material_aliases
      set status = 'auto', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class
    ) values (
      v_alias.id, 'auto_promoted', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
      v_alias.line_class
    );
  end if;

  -- Apply the confirmed alias to the already-confirmed receipt lines of the same
  -- supplier, exactly like resolve_stock_alias does. [Giai đoạn 3] a non_stock
  -- alias never posts anything.
  if p_line_class = 'stock' then
    v_cutover := public.stock_ledger_cutover_date(p_location);
    for v_target in
      select gri.id
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      where gr.supplier_id is not distinct from p_supplier_id
        and gr.receiving_location = p_location
        and gr.status in ('confirmed', 'received')
        and (v_cutover is null or gr.receipt_date >= v_cutover)
        and public.normalize_stock_item_name(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            ) = v_norm
      order by gr.receipt_date asc, gri.created_at asc, gri.id asc
    loop
      if not public.stock_goods_receipt_item_is_posted(v_target.id) then
        if public.post_stock_goods_receipt_item(v_target.id, v_alias) then
          v_applied := v_applied + 1;
        end if;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'status', v_action,
    'alias', to_jsonb(v_alias),
    'applied_lines', v_applied,
    'promoted', v_alias.status = 'auto'
  );
end;
$$;

-- The old 12-argument signature keeps working for the current hook.
create or replace function public.confirm_material_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric,
  p_source_table text,
  p_source_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.confirm_material_alias(
    p_supplier_id,
    p_location,
    p_raw_name,
    p_raw_unit,
    p_kitchen_inventory_item_id,
    p_tan_tao_sku_id,
    p_entered_unit_label,
    p_conversion_factor,
    p_jev_item_id,
    p_jev_probability,
    p_source_table,
    p_source_id,
    'stock'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. suggest_material_aliases: expose line_class
-- ---------------------------------------------------------------------------

create or replace function public.suggest_material_aliases(
  p_supplier_id uuid,
  p_location text,
  p_lines jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line jsonb;
  v_line_key text;
  v_raw_name text;
  v_raw_unit text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_item_name text;
  v_candidates jsonb;
  v_candidate_ids text[];
  v_candidates_hash text;
  v_cache public.material_alias_jev_cache%rowtype;
  v_alias_json jsonb;
  v_jev jsonb;
  v_pack jsonb;
  v_needs_prompt boolean;
  v_result jsonb := '[]'::jsonb;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines_required' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'too_many_lines' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_line_key := nullif(btrim(coalesce(v_line ->> 'line_key', '')), '');
    v_raw_name := coalesce(nullif(btrim(v_line ->> 'raw_name'), ''), '');
    v_raw_unit := nullif(btrim(v_line ->> 'raw_unit'), '');
    if v_line_key is null or v_raw_name = '' then
      continue;
    end if;

    v_norm := public.normalize_stock_item_name(v_raw_name);
    v_alias := null;

    -- Prefer the supplier-specific alias, otherwise show the generic suggestion.
    select * into v_alias
    from public.stock_material_aliases a
    where a.location = p_location
      and a.normalized_name = v_norm
      and a.supplier_id is not distinct from p_supplier_id
    order by a.created_at asc, a.id asc
    limit 1;
    if v_alias.id is null then
      select * into v_alias
      from public.stock_material_aliases a
      where a.location = p_location
        and a.normalized_name = v_norm
        and a.supplier_id is null
      order by a.created_at asc, a.id asc
      limit 1;
    end if;

    v_item_name := null;
    if v_alias.id is not null and v_alias.line_class = 'stock' then
      if p_location = 'q7' then
        select kii.name into v_item_name
        from public.kitchen_inventory_items kii
        where kii.id = v_alias.kitchen_inventory_item_id;
      else
        select ps.product_name into v_item_name
        from public.product_skus ps
        where ps.id = v_alias.tan_tao_sku_id;
      end if;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
             'id', coalesce(c.item_id, c.sku_id),
             'item_id', c.item_id,
             'sku_id', c.sku_id,
             'name', c.name,
             'unit', c.unit,
             'score', c.score,
             'reason', c.reason
           ) order by c.score desc, c.name asc, c.item_id asc nulls last, c.sku_id asc nulls last), '[]'::jsonb)
    into v_candidates
    from public.material_alias_candidates(v_raw_name, p_location, 5) c;

    select coalesce(array_agg(elem ->> 'id'), '{}'::text[])
    into v_candidate_ids
    from jsonb_array_elements(v_candidates) elem
    where elem ->> 'id' is not null;
    v_candidates_hash := public.material_alias_candidates_hash(v_candidate_ids);

    v_cache := null;
    select * into v_cache
    from public.material_alias_jev_cache z
    where z.location = p_location
      and z.normalized_name = v_norm
      and z.supplier_id is not distinct from p_supplier_id
      and z.candidates_hash = v_candidates_hash
    order by z.created_at desc, z.id desc
    limit 1;

    if v_alias.id is null then
      v_alias_json := null;
      v_needs_prompt := true;
    else
      v_alias_json := jsonb_build_object(
        'alias_id', v_alias.id,
        'status', v_alias.status,
        'line_class', v_alias.line_class,
        'item_id', v_alias.kitchen_inventory_item_id,
        'sku_id', v_alias.tan_tao_sku_id,
        'item_name', v_item_name,
        'unit', v_alias.unit,
        'conversion_factor', v_alias.conversion_factor,
        'pack_label', v_alias.pack_label,
        'confirm_count', v_alias.confirm_count,
        'confirmers_count', cardinality(coalesce(v_alias.confirmers, '{}'::uuid[])),
        'jev_disagreed', v_alias.jev_disagreed
      );
      -- [Giai đoạn 3] an auto non_stock alias needs no prompt.
      v_needs_prompt := v_alias.status <> 'auto';
    end if;

    v_pack := public.q7_pack_from_name(v_raw_name, v_raw_unit);

    v_result := v_result || jsonb_build_object(
      'line_key', v_line_key,
      'normalized_name', v_norm,
      'alias', v_alias_json,
      'needs_prompt', v_needs_prompt,
      'candidates', v_candidates,
      'candidates_hash', v_candidates_hash,
      'jev', case when v_cache.id is null then null else v_cache.answer end,
      'pack_guess', v_pack
    );
  end loop;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. undo_material_alias_event: restore line_class from the event
-- ---------------------------------------------------------------------------

create or replace function public.undo_material_alias_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event public.material_alias_events%rowtype;
  v_alias public.stock_material_aliases%rowtype;
  v_restored_item uuid;
  v_restored_sku uuid;
  v_restored_factor numeric;
  v_restored_unit text;
  v_restored_line_class text;
  v_count integer;
  v_confirmers uuid[];
  v_distinct integer;
  v_applied integer := 0;
  v_warning text := null;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_event
  from public.material_alias_events
  where id = p_event_id
  for update;
  if not found then raise exception 'event_not_found' using errcode = 'P0002'; end if;
  if v_event.action = 'undo' then
    raise exception 'cannot_undo_undo' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.material_alias_events u
    where u.action = 'undo' and u.undo_of_event_id = p_event_id
  ) then
    raise exception 'event_already_undone' using errcode = '23514';
  end if;
  if v_event.alias_id is null then
    raise exception 'event_without_alias' using errcode = '22023';
  end if;

  select * into v_alias
  from public.stock_material_aliases
  where id = v_event.alias_id
  for update;
  if not found then raise exception 'alias_not_found' using errcode = 'P0002'; end if;

  if v_event.action = 'correct' then
    -- [Giai đoạn 3] restore the line class the correction moved away from.
    v_restored_line_class := coalesce(v_event.previous_line_class, 'stock');
    v_restored_item := v_event.previous_item_id;
    v_restored_sku := v_event.previous_sku_id;
    v_restored_factor := coalesce(v_event.previous_factor, 1);
    v_restored_unit := v_alias.unit;
    if v_restored_line_class = 'non_stock' then
      v_restored_item := null;
      v_restored_sku := null;
      v_restored_factor := 1;
      v_restored_unit := coalesce(v_alias.unit, '-');
    elsif v_alias.location = 'q7' and v_restored_item is not null then
      select kii.unit into v_restored_unit
      from public.kitchen_inventory_items kii
      where kii.id = v_restored_item;
    elsif v_alias.location = 'tan_tao' and v_restored_sku is not null then
      select ps.unit into v_restored_unit
      from public.product_skus ps
      where ps.id = v_restored_sku;
    end if;

    select count(*), count(distinct e.actor_id)
      into v_count, v_distinct
    from public.material_alias_events e
    where e.alias_id = v_alias.id
      and e.action = 'confirm'
      and e.id <> p_event_id
      and not exists (
        select 1 from public.material_alias_events u
        where u.action = 'undo' and u.undo_of_event_id = e.id
      )
      and (e.new_item_id is not distinct from v_restored_item)
      and (e.new_sku_id is not distinct from v_restored_sku)
      and (e.new_factor = v_restored_factor);
    if v_count = 0 then v_count := 1; end if;

    select coalesce(array_agg(distinct e.actor_id) filter (where e.actor_id is not null), '{}'::uuid[])
      into v_confirmers
    from public.material_alias_events e
    where e.alias_id = v_alias.id
      and e.action = 'confirm'
      and e.id <> p_event_id
      and not exists (
        select 1 from public.material_alias_events u
        where u.action = 'undo' and u.undo_of_event_id = e.id
      )
      and (e.new_item_id is not distinct from v_restored_item)
      and (e.new_sku_id is not distinct from v_restored_sku)
      and (e.new_factor = v_restored_factor);

    update public.stock_material_aliases
      set kitchen_inventory_item_id = v_restored_item,
          tan_tao_sku_id = v_restored_sku,
          conversion_factor = v_restored_factor,
          unit = coalesce(v_restored_unit, unit),
          line_class = v_restored_line_class,
          confirm_count = v_count,
          confirmers = v_confirmers,
          status = case when v_count >= 3 or v_distinct >= 2 then 'auto' else 'learning' end,
          updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
  elsif v_event.action = 'confirm' then
    if exists (
      select 1 from public.material_alias_events e
      where e.alias_id = v_alias.id
        and e.action = 'confirm'
        and e.id <> p_event_id
        and not exists (
          select 1 from public.material_alias_events u
          where u.action = 'undo' and u.undo_of_event_id = e.id
        )
        and (e.created_at, e.id) > (v_event.created_at, v_event.id)
    ) then
      raise exception 'not_latest_confirm' using errcode = '23514';
    end if;

    v_count := greatest(0, v_alias.confirm_count - 1);
    v_confirmers := coalesce(v_alias.confirmers, '{}'::uuid[]);
    if v_event.actor_id is not null and not exists (
      select 1 from public.material_alias_events e
      where e.alias_id = v_alias.id
        and e.action = 'confirm'
        and e.id <> p_event_id
        and e.actor_id = v_event.actor_id
        and not exists (
          select 1 from public.material_alias_events u
          where u.action = 'undo' and u.undo_of_event_id = e.id
        )
    ) then
      v_confirmers := array_remove(v_confirmers, v_event.actor_id);
    end if;
    select count(distinct c) into v_distinct from unnest(v_confirmers) c;

    update public.stock_material_aliases
      set confirm_count = v_count,
          confirmers = v_confirmers,
          status = case when v_count >= 3 or v_distinct >= 2 then 'auto' else 'learning' end,
          updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
  else
    -- auto_promoted / disabled: fall back to learning.
    update public.stock_material_aliases
      set status = 'learning', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
  end if;

  -- The ledger is append-only; warn instead of deleting posted movements.
  select count(*) into v_applied
  from public.goods_receipt_items gri
  join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  where gr.supplier_id is not distinct from v_alias.supplier_id
    and gr.receiving_location = v_alias.location
    and gr.status in ('confirmed', 'received')
    and public.normalize_stock_item_name(
          coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
        ) = v_alias.normalized_name
    and public.stock_goods_receipt_item_is_posted(gri.id);
  if v_applied > 0 then
    v_warning := 'Bí danh đã áp lên ' || v_applied::text
      || ' dòng phiếu nhập kho. Không xoá bút toán sổ tồn đã ghi; kế toán xử lý ở Sổ tồn NVL.';
  end if;

  insert into public.material_alias_events(
    alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
    undo_of_event_id, previous_line_class, new_item_id, new_sku_id, new_factor, new_line_class
  ) values (
    v_alias.id, 'undo', v_actor, 'material_alias_events', p_event_id,
    v_event.raw_name, v_event.raw_unit,
    p_event_id, v_event.previous_line_class,
    v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
    v_alias.line_class
  );

  return jsonb_build_object(
    'status', 'undone',
    'alias', to_jsonb(v_alias),
    'warning', v_warning,
    'applied_lines', v_applied
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. get_material_alias_review: expose line_class per alias
-- ---------------------------------------------------------------------------

create or replace function public.get_material_alias_review(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_days integer := greatest(1, coalesce(p_days, 7));
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_aliases jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_pending integer := 0;
  v_loc text;
  v_cutover date;
  v_cnt integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(x.row order by x.jev_disagreed desc, x.last_event_at desc nulls last, x.normalized_name asc), '[]'::jsonb)
  into v_aliases
  from (
    select
      a.jev_disagreed,
      a.normalized_name,
      le.created_at as last_event_at,
      jsonb_build_object(
        'alias_id', a.id,
        'normalized_name', a.normalized_name,
        'supplier_id', a.supplier_id,
        'supplier_name', sup.name,
        'location', a.location,
        'line_class', a.line_class,
        'item_id', a.kitchen_inventory_item_id,
        'sku_id', a.tan_tao_sku_id,
        'item_name', coalesce(kii.name, ps.product_name),
        'unit', a.unit,
        'conversion_factor', a.conversion_factor,
        'pack_label', a.pack_label,
        'status', a.status,
        'confirm_count', a.confirm_count,
        'confirmers_count', cardinality(coalesce(a.confirmers, '{}'::uuid[])),
        'jev_disagreed', a.jev_disagreed,
        'last_confirmed_at', a.last_confirmed_at,
        'last_event', case when le.id is null then null else jsonb_build_object(
          'id', le.id,
          'action', le.action,
          'actor_id', le.actor_id,
          'created_at', le.created_at
        ) end,
        'applied_lines', (
          select count(*)
          from public.goods_receipt_items gri
          join public.goods_receipts gr on gr.id = gri.goods_receipt_id
          where gr.supplier_id is not distinct from a.supplier_id
            and gr.receiving_location = a.location
            and gr.status in ('confirmed', 'received')
            and public.normalize_stock_item_name(
                  coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
                ) = a.normalized_name
            and public.stock_goods_receipt_item_is_posted(gri.id)
        )
      ) as row
    from public.stock_material_aliases a
    left join public.suppliers sup on sup.id = a.supplier_id
    left join public.kitchen_inventory_items kii on kii.id = a.kitchen_inventory_item_id
    left join public.product_skus ps on ps.id = a.tan_tao_sku_id
    join lateral (
      select e.* from public.material_alias_events e
      where e.alias_id = a.id
      order by e.created_at desc, e.id desc
      limit 1
    ) le on true
    where exists (
      select 1 from public.material_alias_events e2
      where e2.alias_id = a.id
        and e2.created_at >= now() - make_interval(days => v_days)
    )
  ) x;

  -- Reuse the pending-alias count of get_stock_ledger_overview for both stores.
  foreach v_loc in array array['q7', 'tan_tao'] loop
    v_cutover := public.stock_ledger_cutover_date(v_loc);
    if v_cutover is not null then
      select count(*) into v_cnt
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      left join public.suppliers sup on sup.id = gr.supplier_id
      where gr.receiving_location = v_loc
        and gr.status in ('confirmed', 'received')
        and gr.receipt_date >= v_cutover
        and coalesce(sup.stock_exempt, false) = false
        and public.resolve_stock_material_alias(
              gr.supplier_id,
              public.normalize_stock_item_name(
                coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
              ),
              v_loc
            ) is null
        and not public.stock_goods_receipt_item_is_posted(gri.id);
      v_pending := v_pending + v_cnt;
    end if;
  end loop;

  select jsonb_build_object(
    'auto_count', count(*) filter (where status = 'auto'),
    'learning_count', count(*) filter (where status = 'learning'),
    'disabled_count', count(*) filter (where status = 'disabled'),
    'pending_lines', v_pending,
    'jev_usage', jsonb_build_object(
      'usage_date', v_today,
      'calls', coalesce(u.calls, 0),
      'cost', coalesce(u.cost, 0),
      'call_limit', coalesce(u.call_limit, 600)
    )
  )
  into v_summary
  from public.stock_material_aliases a
  left join public.stock_catalog_jev_usage u on u.usage_date = v_today
  group by u.calls, u.cost, u.call_limit;

  return jsonb_build_object(
    'days', v_days,
    'aliases', v_aliases,
    'summary', coalesce(v_summary, jsonb_build_object(
      'auto_count', 0, 'learning_count', 0, 'disabled_count', 0, 'pending_lines', v_pending,
      'jev_usage', jsonb_build_object('usage_date', v_today, 'calls', 0, 'cost', 0, 'call_limit', 600)
    ))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Supplier routing evidence (deterministic, never calls Jev)
-- ---------------------------------------------------------------------------

create or replace function public.supplier_routing_evidence(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_supplier public.suppliers%rowtype;
  v_cutoff date := (now() at time zone 'Asia/Ho_Chi_Minh')::date - 180;
  v_total integer := 0;
  v_bread integer := 0;
  v_non_stock integer := 0;
  v_receipt_count integer := 0;
  v_top_items jsonb := '[]'::jsonb;
  v_has_q7 boolean := false;
  v_rule_hint text;
begin
  select * into v_supplier from public.suppliers where id = p_supplier_id;
  if not found then
    return jsonb_build_object(
      'supplier_id', p_supplier_id,
      'supplier_name', null,
      'category', null,
      'receipt_count', 0,
      'top_items', '[]'::jsonb,
      'rule_hint', null
    );
  end if;

  select count(*),
         count(*) filter (where n ~ '\m(banh mi|pate)\M'),
         count(*) filter (where n ~ '\m(phi|van chuyen|dich vu|xu ly|phan tich|thue)\M')
    into v_total, v_bread, v_non_stock
  from (
    select public.normalize_stock_item_name(
             coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
           ) as n
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gr.supplier_id = p_supplier_id
      and gr.status in ('confirmed', 'received')
      and gr.receipt_date >= v_cutoff
  ) x;

  select count(*) into v_receipt_count
  from public.goods_receipts gr
  where gr.supplier_id = p_supplier_id
    and gr.status in ('confirmed', 'received')
    and gr.receipt_date >= v_cutoff;

  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'line_count', t.line_count) order by t.line_count desc, t.name asc), '[]'::jsonb)
    into v_top_items
  from (
    select coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as name,
           count(*)::integer as line_count
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gr.supplier_id = p_supplier_id
      and gr.status in ('confirmed', 'received')
      and gr.receipt_date >= v_cutoff
    group by 1
    order by count(*) desc, 1 asc
    limit 10
  ) t;

  select exists (
    select 1
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    cross join lateral (
      select a.kitchen_inventory_item_id
      from public.resolve_stock_material_alias(
        gr.supplier_id,
        public.normalize_stock_item_name(coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)),
        'q7'
      ) a
    ) ra
    where gr.supplier_id = p_supplier_id
      and gr.status in ('confirmed', 'received')
      and gr.receipt_date >= v_cutoff
      and ra.kitchen_inventory_item_id is not null
  ) into v_has_q7;

  v_rule_hint := case
    when v_total > 0 and v_bread::numeric / v_total >= 0.6 then 'tan_tao'
    when v_total > 0 and v_non_stock::numeric / v_total >= 0.6 then 'non_stock'
    when v_has_q7 then 'q7'
    else null
  end;

  return jsonb_build_object(
    'supplier_id', v_supplier.id,
    'supplier_name', v_supplier.name,
    'category', v_supplier.category,
    'receipt_count', v_receipt_count,
    'top_items', v_top_items,
    'rule_hint', v_rule_hint
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. apply / revert / decide supplier routing
-- ---------------------------------------------------------------------------

create or replace function public.apply_supplier_routing(
  p_supplier_id uuid,
  p_location text,
  p_source text,
  p_suggestion uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_supplier public.suppliers%rowtype;
  v_prev_location text;
  v_prev_exempt boolean;
  v_cutover date;
  v_filled integer := 0;
begin
  if p_location not in ('q7', 'tan_tao', 'non_stock') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if p_source not in ('manual', 'jev', 'rule') then
    raise exception 'unsupported_source' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_supplier from public.suppliers where id = p_supplier_id for update;
  if not found then raise exception 'supplier_not_found' using errcode = 'P0002'; end if;
  v_prev_location := v_supplier.default_receiving_location;
  v_prev_exempt := v_supplier.stock_exempt;

  if p_suggestion is not null then
    update public.supplier_routing_suggestions s
    set previous_location = coalesce(s.previous_location, v_prev_location),
        previous_exempt = coalesce(s.previous_exempt, v_prev_exempt),
        proposed_location = p_location,
        status = 'applied',
        applied_by = v_actor,
        applied_at = now()
    where s.id = p_suggestion;
  end if;

  if p_location = 'non_stock' then
    update public.suppliers
    set stock_exempt = true,
        default_receiving_location = null,
        receiving_location_source = p_source,
        receiving_location_set_at = now(),
        updated_at = now()
    where id = p_supplier_id;
    return jsonb_build_object(
      'status', 'applied',
      'supplier_id', p_supplier_id,
      'location', 'non_stock',
      'receipts_filled', 0,
      'previous_location', v_prev_location,
      'previous_exempt', v_prev_exempt
    );
  end if;

  update public.suppliers
  set default_receiving_location = p_location,
      stock_exempt = false,
      receiving_location_source = p_source,
      receiving_location_set_at = now(),
      updated_at = now()
  where id = p_supplier_id;

  v_cutover := public.stock_ledger_cutover_date(p_location);

  -- The goods_receipts update trigger then calls post_goods_receipt_to_stock.
  update public.goods_receipts gr
  set receiving_location = p_location
  where gr.supplier_id = p_supplier_id
    and gr.status in ('confirmed', 'received')
    and gr.receiving_location is null
    and (v_cutover is null or gr.receipt_date >= v_cutover);
  get diagnostics v_filled = row_count;

  return jsonb_build_object(
    'status', 'applied',
    'supplier_id', p_supplier_id,
    'location', p_location,
    'receipts_filled', v_filled,
    'previous_location', v_prev_location,
    'previous_exempt', v_prev_exempt
  );
end;
$$;

create or replace function public.revert_supplier_routing(p_suggestion uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_suggestion public.supplier_routing_suggestions%rowtype;
  v_filled integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_suggestion
  from public.supplier_routing_suggestions
  where id = p_suggestion
  for update;
  if not found then raise exception 'suggestion_not_found' using errcode = 'P0002'; end if;
  if v_suggestion.status = 'reverted' then
    return jsonb_build_object('status', 'already_reverted', 'suggestion_id', p_suggestion);
  end if;
  if v_suggestion.status <> 'applied' then
    raise exception 'suggestion_not_applied' using errcode = '23514';
  end if;

  update public.suppliers
  set default_receiving_location = v_suggestion.previous_location,
      stock_exempt = coalesce(v_suggestion.previous_exempt, false),
      receiving_location_source = case
        when v_suggestion.previous_location is null
             and coalesce(v_suggestion.previous_exempt, false) = false then null
        else 'manual'
      end,
      receiving_location_set_at = now(),
      updated_at = now()
  where id = v_suggestion.supplier_id;

  -- The receipt receiving_location is never removed; warn for the stock ledger.
  select count(*) into v_filled
  from public.goods_receipts gr
  where gr.supplier_id = v_suggestion.supplier_id
    and gr.receiving_location = v_suggestion.proposed_location
    and gr.status in ('confirmed', 'received');

  update public.supplier_routing_suggestions
  set status = 'reverted'
  where id = p_suggestion;

  return jsonb_build_object(
    'status', 'reverted',
    'suggestion_id', p_suggestion,
    'supplier_id', v_suggestion.supplier_id,
    'default_receiving_location', v_suggestion.previous_location,
    'stock_exempt', coalesce(v_suggestion.previous_exempt, false),
    'receipts_filled', v_filled,
    'warning', case when v_filled > 0
      then 'Còn ' || v_filled::text || ' phiếu nhập đã điền kho; không tự gỡ receiving_location. Kế toán xử lý ở Sổ tồn NVL.'
      else null end
  );
end;
$$;

create or replace function public.decide_supplier_routing(
  p_id uuid,
  p_action text,
  p_location text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_suggestion public.supplier_routing_suggestions%rowtype;
  v_location text;
  v_source text;
  v_result jsonb;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'suggestion_action_invalid' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_suggestion
  from public.supplier_routing_suggestions
  where id = p_id
  for update;
  if not found then raise exception 'suggestion_not_found' using errcode = 'P0002'; end if;

  if p_action = 'reject' then
    if v_suggestion.status = 'rejected' then
      return jsonb_build_object('status', 'already_rejected', 'suggestion_id', p_id);
    end if;
    if v_suggestion.status <> 'pending' then
      raise exception 'suggestion_not_pending' using errcode = '23514';
    end if;
    update public.supplier_routing_suggestions
    set status = 'rejected', applied_by = v_actor, applied_at = now()
    where id = p_id;
    return jsonb_build_object('status', 'rejected', 'suggestion_id', p_id);
  end if;

  if v_suggestion.status = 'applied' then
    return jsonb_build_object('status', 'already_applied', 'suggestion_id', p_id);
  end if;
  if v_suggestion.status <> 'pending' then
    raise exception 'suggestion_not_pending' using errcode = '23514';
  end if;

  if p_location is not null then
    if p_location not in ('q7', 'tan_tao', 'non_stock') then
      raise exception 'unsupported_location' using errcode = '22023';
    end if;
    v_location := p_location;
    v_source := 'manual';
  else
    v_location := v_suggestion.proposed_location;
    v_source := 'jev';
  end if;

  v_result := public.apply_supplier_routing(v_suggestion.supplier_id, v_location, v_source, p_id);
  return v_result || jsonb_build_object('suggestion_id', p_id, 'source', v_source);
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. decide / revert material category
-- ---------------------------------------------------------------------------

create or replace function public.decide_material_category(
  p_id uuid,
  p_action text,
  p_category text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_suggestion public.material_category_suggestions%rowtype;
  v_material public.sku_cogs_materials%rowtype;
  v_category text;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'suggestion_action_invalid' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_suggestion
  from public.material_category_suggestions
  where id = p_id
  for update;
  if not found then raise exception 'suggestion_not_found' using errcode = 'P0002'; end if;

  if p_action = 'reject' then
    if v_suggestion.status = 'rejected' then
      return jsonb_build_object('status', 'already_rejected', 'suggestion_id', p_id);
    end if;
    if v_suggestion.status <> 'pending' then
      raise exception 'suggestion_not_pending' using errcode = '23514';
    end if;
    update public.material_category_suggestions
    set status = 'rejected', decided_by = v_actor, decided_at = now()
    where id = p_id;
    return jsonb_build_object('status', 'rejected', 'suggestion_id', p_id);
  end if;

  if v_suggestion.status = 'applied' then
    return jsonb_build_object('status', 'already_applied', 'suggestion_id', p_id);
  end if;
  if v_suggestion.status <> 'pending' then
    raise exception 'suggestion_not_pending' using errcode = '23514';
  end if;

  v_category := coalesce(p_category, v_suggestion.proposed_category);
  if v_category is null
     or not exists (select 1 from public.stock_material_categories c where c.code = v_category) then
    raise exception 'suggestion_category_invalid' using errcode = '22023';
  end if;

  select * into v_material
  from public.sku_cogs_materials
  where id = v_suggestion.material_id
  for update;
  if not found then raise exception 'material_not_found' using errcode = 'P0002'; end if;

  -- sku_cogs_materials is guarded (trg_guard_canonical_material_identity): every
  -- stable-field change must go through the audited Material Master controller.
  perform public.update_canonical_material(
    v_material.id,
    coalesce(v_material.version, 0),
    jsonb_build_object('category', v_category),
    'Phân nhóm NVL theo đề xuất Jev (' || v_suggestion.id::text || ')',
    null
  );

  update public.material_category_suggestions
  set status = 'applied',
      proposed_category = v_category,
      previous_category = v_material.category,
      decided_by = v_actor,
      decided_at = now()
  where id = p_id;

  return jsonb_build_object(
    'status', 'applied',
    'suggestion_id', p_id,
    'material_id', v_material.id,
    'category', v_category,
    'previous_category', v_material.category
  );
end;
$$;

create or replace function public.revert_material_category(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_suggestion public.material_category_suggestions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_suggestion
  from public.material_category_suggestions
  where id = p_id
  for update;
  if not found then raise exception 'suggestion_not_found' using errcode = 'P0002'; end if;
  if v_suggestion.status = 'reverted' then
    return jsonb_build_object('status', 'already_reverted', 'suggestion_id', p_id);
  end if;
  if v_suggestion.status <> 'applied' then
    raise exception 'suggestion_not_applied' using errcode = '23514';
  end if;

  -- Same audited controller on the way back (previous_category may be null).
  perform public.update_canonical_material(
    v_suggestion.material_id,
    coalesce((select m.version from public.sku_cogs_materials m where m.id = v_suggestion.material_id), 0),
    jsonb_build_object('category', v_suggestion.previous_category),
    'Hoàn tác phân nhóm NVL (' || v_suggestion.id::text || ')',
    null
  );

  update public.material_category_suggestions
  set status = 'reverted', decided_by = v_actor, decided_at = now()
  where id = p_id;

  return jsonb_build_object(
    'status', 'reverted',
    'suggestion_id', p_id,
    'material_id', v_suggestion.material_id,
    'category', v_suggestion.previous_category
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. Edge candidate readers (service role only)
-- ---------------------------------------------------------------------------

create or replace function public.get_stock_routing_supplier_candidates(
  p_prompt_version text,
  p_limit integer default 50,
  p_days integer default 180
)
returns table (supplier_id uuid, receipt_count bigint, receiving_location_source text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select gr.supplier_id, count(distinct gr.id)::bigint, s.receiving_location_source
  from public.goods_receipts gr
  join public.suppliers s on s.id = gr.supplier_id
  where gr.status in ('confirmed', 'received')
    and gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - greatest(1, coalesce(p_days, 180))
    and s.default_receiving_location is null
    and s.stock_exempt = false
    and s.receiving_location_source is distinct from 'manual'
    and not exists (
      select 1 from public.supplier_routing_suggestions x
      where x.supplier_id = s.id and x.prompt_version = p_prompt_version
    )
  group by gr.supplier_id, s.receiving_location_source
  order by count(distinct gr.id) desc, gr.supplier_id asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function public.get_stock_routing_material_candidates(
  p_prompt_version text,
  p_limit integer default 50
)
returns table (
  material_id uuid,
  material_code text,
  canonical_name text,
  default_unit text,
  alias_names text[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id,
         m.material_code,
         m.canonical_name,
         m.default_unit,
         (
           select coalesce(array_agg(x.alias_name order by x.created_at asc, x.id asc), '{}'::text[])
           from (
             select a.alias_name, a.created_at, a.id
             from public.sku_cogs_material_aliases a
             where a.material_id = m.id and a.active = true
             order by a.created_at asc, a.id asc
             limit 3
           ) x
         )
  from public.sku_cogs_materials m
  where m.active = true
    and m.category is null
    and not exists (
      select 1 from public.material_category_suggestions s
      where s.material_id = m.id and s.prompt_version = p_prompt_version
    )
  order by m.canonical_name asc, m.id asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- ---------------------------------------------------------------------------
-- 17. One review payload for the routing page
-- ---------------------------------------------------------------------------

create or replace function public.get_stock_routing_review()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_supplier_pending jsonb := '[]'::jsonb;
  v_supplier_recent jsonb := '[]'::jsonb;
  v_supplier_counts jsonb := '{}'::jsonb;
  v_material_pending jsonb := '[]'::jsonb;
  v_material_counts jsonb := '{}'::jsonb;
  v_categories jsonb := '[]'::jsonb;
  v_usage jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'supplier_id', s.supplier_id,
           'supplier_name', sup.name,
           'category', sup.category,
           'proposed_location', s.proposed_location,
           'probability', s.probability,
           'evidence', s.evidence,
           'rule_hint', s.evidence ->> 'rule_hint',
           'conflict', coalesce((s.evidence ->> 'conflict')::boolean, false),
           'prompt_version', s.prompt_version,
           'cost', s.cost,
           'created_at', s.created_at
         ) order by s.created_at desc, s.id), '[]'::jsonb)
    into v_supplier_pending
  from public.supplier_routing_suggestions s
  left join public.suppliers sup on sup.id = s.supplier_id
  where s.status = 'pending';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'supplier_id', s.supplier_id,
           'supplier_name', sup.name,
           'proposed_location', s.proposed_location,
           'probability', s.probability,
           'status', s.status,
           'applied_at', s.applied_at,
           'created_at', s.created_at,
           'previous_location', s.previous_location,
           'previous_exempt', s.previous_exempt
         ) order by coalesce(s.applied_at, s.created_at) desc, s.id), '[]'::jsonb)
    into v_supplier_recent
  from (
    select * from public.supplier_routing_suggestions
    where status in ('applied', 'reverted')
    order by coalesce(applied_at, created_at) desc, id
    limit 30
  ) s
  left join public.suppliers sup on sup.id = s.supplier_id;

  select jsonb_build_object(
           'q7', count(*) filter (where stock_exempt = false and default_receiving_location = 'q7'),
           'tan_tao', count(*) filter (where stock_exempt = false and default_receiving_location = 'tan_tao'),
           'non_stock', count(*) filter (where stock_exempt = true),
           'none', count(*) filter (where stock_exempt = false and default_receiving_location is null)
         )
    into v_supplier_counts
  from public.suppliers;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'material_id', s.material_id,
           'material_code', m.material_code,
           'canonical_name', m.canonical_name,
           'current_category', m.category,
           'proposed_category', s.proposed_category,
           'proposed_label', c.label_vi,
           'probability', s.probability,
           'prompt_version', s.prompt_version,
           'cost', s.cost,
           'created_at', s.created_at
         ) order by s.created_at desc, s.id), '[]'::jsonb)
    into v_material_pending
  from public.material_category_suggestions s
  join public.sku_cogs_materials m on m.id = s.material_id
  left join public.stock_material_categories c on c.code = s.proposed_category
  where s.status = 'pending';

  select coalesce(jsonb_object_agg(category_key, category_count), '{}'::jsonb)
    into v_material_counts
  from (
    select coalesce(category, 'unclassified') as category_key,
           count(*)::integer as category_count
    from public.sku_cogs_materials
    where active = true
    group by coalesce(category, 'unclassified')
  ) c;

  select coalesce(jsonb_agg(jsonb_build_object(
           'code', c.code,
           'label_vi', c.label_vi,
           'sort_order', c.sort_order
         ) order by c.sort_order asc, c.code asc), '[]'::jsonb)
    into v_categories
  from public.stock_material_categories c;

  select jsonb_build_object(
           'usage_date', v_today,
           'calls', coalesce(u.calls, 0),
           'cost', coalesce(u.cost, 0),
           'call_limit', coalesce(u.call_limit, 600)
         )
    into v_usage
  from (select 1) one
  left join public.stock_catalog_jev_usage u on u.usage_date = v_today;

  return jsonb_build_object(
    'supplier_pending', v_supplier_pending,
    'supplier_recent', v_supplier_recent,
    'supplier_counts', coalesce(v_supplier_counts, '{}'::jsonb),
    'material_pending', v_material_pending,
    'material_category_counts', coalesce(v_material_counts, '{}'::jsonb),
    'categories', v_categories,
    'jev_usage', v_usage
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 18. RLS and explicit grants on the new tables
-- ---------------------------------------------------------------------------

alter table public.stock_material_categories enable row level security;
alter table public.supplier_routing_suggestions enable row level security;
alter table public.material_category_suggestions enable row level security;

drop policy if exists stock_material_categories_select on public.stock_material_categories;
create policy stock_material_categories_select on public.stock_material_categories
  for select to authenticated
  using (public.material_alias_can_view((select auth.uid())));

drop policy if exists supplier_routing_suggestions_select on public.supplier_routing_suggestions;
create policy supplier_routing_suggestions_select on public.supplier_routing_suggestions
  for select to authenticated
  using (public.material_alias_can_view((select auth.uid())));

drop policy if exists material_category_suggestions_select on public.material_category_suggestions;
create policy material_category_suggestions_select on public.material_category_suggestions
  for select to authenticated
  using (public.material_alias_can_view((select auth.uid())));

-- Read-only for signed-in users; every write goes through a security definer RPC
-- (or the service role used by the edge function).
revoke all on table public.stock_material_categories from public, anon, authenticated;
grant select on table public.stock_material_categories to authenticated, service_role;
grant insert, update, delete on table public.stock_material_categories to service_role;

revoke all on table public.supplier_routing_suggestions from public, anon, authenticated;
grant select on table public.supplier_routing_suggestions to authenticated, service_role;
grant insert, update, delete on table public.supplier_routing_suggestions to service_role;

revoke all on table public.material_category_suggestions from public, anon, authenticated;
grant select on table public.material_category_suggestions to authenticated, service_role;
grant insert, update, delete on table public.material_category_suggestions to service_role;

-- ---------------------------------------------------------------------------
-- 19. Function grants
-- ---------------------------------------------------------------------------

-- Redefined ledger helpers keep their original service-role-only grants.
revoke all on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) from public, anon, authenticated;
grant execute on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) to service_role;

revoke all on function public.post_goods_receipt_to_stock(uuid) from public, anon, authenticated;
grant execute on function public.post_goods_receipt_to_stock(uuid) to service_role;

revoke all on function public.get_stock_ledger_overview(text, date) from public, anon;
grant execute on function public.get_stock_ledger_overview(text, date) to authenticated, service_role;

revoke all on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid, text) from public, anon;
grant execute on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid, text) to authenticated, service_role;

revoke all on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid) from public, anon;
grant execute on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid) to authenticated, service_role;

revoke all on function public.suggest_material_aliases(uuid, text, jsonb) from public, anon;
grant execute on function public.suggest_material_aliases(uuid, text, jsonb) to authenticated, service_role;

revoke all on function public.undo_material_alias_event(uuid) from public, anon;
grant execute on function public.undo_material_alias_event(uuid) to authenticated, service_role;

revoke all on function public.get_material_alias_review(integer) from public, anon;
grant execute on function public.get_material_alias_review(integer) to authenticated, service_role;

revoke all on function public.supplier_routing_evidence(uuid) from public, anon;
grant execute on function public.supplier_routing_evidence(uuid) to authenticated, service_role;

revoke all on function public.apply_supplier_routing(uuid, text, text, uuid) from public, anon;
grant execute on function public.apply_supplier_routing(uuid, text, text, uuid) to authenticated, service_role;

revoke all on function public.revert_supplier_routing(uuid) from public, anon;
grant execute on function public.revert_supplier_routing(uuid) to authenticated, service_role;

revoke all on function public.decide_supplier_routing(uuid, text, text) from public, anon;
grant execute on function public.decide_supplier_routing(uuid, text, text) to authenticated, service_role;

revoke all on function public.decide_material_category(uuid, text, text) from public, anon;
grant execute on function public.decide_material_category(uuid, text, text) to authenticated, service_role;

revoke all on function public.revert_material_category(uuid) from public, anon;
grant execute on function public.revert_material_category(uuid) to authenticated, service_role;

revoke all on function public.get_stock_routing_review() from public, anon;
grant execute on function public.get_stock_routing_review() to authenticated, service_role;

-- Edge-only candidate readers.
revoke all on function public.get_stock_routing_supplier_candidates(text, integer, integer) from public, anon, authenticated;
grant execute on function public.get_stock_routing_supplier_candidates(text, integer, integer) to service_role;

revoke all on function public.get_stock_routing_material_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.get_stock_routing_material_candidates(text, integer) to service_role;
