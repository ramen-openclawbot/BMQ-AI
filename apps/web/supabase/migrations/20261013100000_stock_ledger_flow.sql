-- Stock ledger flow for Q7 and Tân Tạo (data layer only).
-- Derives stock from the documents actually in use: confirmed goods receipts
-- (phiếu nhập kho) and production material issues (phiếu xuất NVL sản xuất).
-- Supplier-scoped material name aliases, weekly stock counts and a read RPC.
-- All ledger writes are idempotent. No historical backfill, no payable/payment
-- logic change and no touched legacy inventory_items/kitchen_inventory_*/tan_tao_* rows.

-- ---------------------------------------------------------------------------
-- 1. Location columns
-- ---------------------------------------------------------------------------

alter table public.goods_receipts
  add column if not exists receiving_location text;

alter table public.goods_receipts
  drop constraint if exists goods_receipts_receiving_location_check;
alter table public.goods_receipts
  add constraint goods_receipts_receiving_location_check
  check (receiving_location is null or receiving_location in ('q7', 'tan_tao'));

alter table public.suppliers
  add column if not exists default_receiving_location text;

alter table public.suppliers
  drop constraint if exists suppliers_default_receiving_location_check;
alter table public.suppliers
  add constraint suppliers_default_receiving_location_check
  check (default_receiving_location is null or default_receiving_location in ('q7', 'tan_tao'));

create index if not exists idx_goods_receipts_receiving_location_status_date
  on public.goods_receipts(receiving_location, status, receipt_date);

-- ---------------------------------------------------------------------------
-- 2. Cutover settings (single row; null means the location has not started)
-- ---------------------------------------------------------------------------

create table if not exists public.stock_ledger_settings (
  id integer primary key default 1,
  q7_cutover_date date,
  tan_tao_cutover_date date,
  updated_at timestamptz not null default now(),
  constraint stock_ledger_settings_single_row_check check (id = 1)
);

insert into public.stock_ledger_settings (id)
values (1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Supplier-scoped material aliases
-- ---------------------------------------------------------------------------

create table if not exists public.stock_material_aliases (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers(id) on delete cascade,
  normalized_name text not null,
  location text not null check (location in ('q7', 'tan_tao')),
  kitchen_inventory_item_id uuid references public.kitchen_inventory_items(id) on delete restrict,
  tan_tao_sku_id uuid references public.product_skus(id) on delete restrict,
  conversion_factor numeric(18, 8) not null default 1,
  unit text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_material_aliases_name_check check (btrim(normalized_name) <> ''),
  constraint stock_material_aliases_conversion_check check (
    conversion_factor > 0 and conversion_factor::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint stock_material_aliases_location_item_check check (
    (location = 'q7' and kitchen_inventory_item_id is not null and tan_tao_sku_id is null)
    or (location = 'tan_tao' and tan_tao_sku_id is not null and kitchen_inventory_item_id is null)
  ),
  constraint stock_material_aliases_supplier_name_location_key
    unique (supplier_id, normalized_name, location)
);

-- Null supplier means "applies to every supplier"; treat null as a real key.
create unique index if not exists stock_material_aliases_unique_null_supplier_idx
  on public.stock_material_aliases (
    coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
    normalized_name,
    location
  );

create index if not exists idx_stock_material_aliases_lookup
  on public.stock_material_aliases(location, normalized_name, supplier_id);

-- ---------------------------------------------------------------------------
-- 4. Immutable normalization used by both the SQL and the TS layers
-- ---------------------------------------------------------------------------

create or replace function public.normalize_stock_item_name(p_name text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            translate(
              lower(coalesce(p_name, '')),
              'aáàảãạăắằẳẵặâấầẩẫậeéèẻẽẹêếềểễệiíìỉĩịoóòỏõọôốồổỗộơớờởỡợuúùủũụưứừửữựyýỳỷỹỵdđ',
              'aaaaaaaaaaaaaaaaaaeeeeeeeeeeeeiiiiiioooooooooooooooooouuuuuuuuuuuuyyyyyydd'
            ),
            '\s+', ' ', 'g'
          ),
          '\s*\([^()]*\)\s*$', ''
        ),
        '\s*(ngay\s*[0-9]+|[0-9]+)\s*$', ''
      )
    ),
    ''
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Small read helpers
-- ---------------------------------------------------------------------------

create or replace function public.stock_ledger_cutover_date(p_location text)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case p_location
    when 'q7' then (select s.q7_cutover_date from public.stock_ledger_settings s where s.id = 1)
    when 'tan_tao' then (select s.tan_tao_cutover_date from public.stock_ledger_settings s where s.id = 1)
    else null::date
  end;
$$;

create or replace function public.resolve_stock_material_alias(
  p_supplier_id uuid,
  p_normalized_name text,
  p_location text
)
returns public.stock_material_aliases
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.*
  from public.stock_material_aliases a
  where a.location = p_location
    and a.normalized_name = p_normalized_name
    and (a.supplier_id = p_supplier_id or a.supplier_id is null)
  order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  limit 1;
$$;

-- True when a goods receipt item already produced a ledger row in any location.
create or replace function public.stock_goods_receipt_item_is_posted(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.q7_inventory_movements m
    where m.source = 'goods_receipt' and m.source_ref_key = 'gr-item:' || p_item_id::text
    union all
    select 1 from public.tan_tao_warehouse_documents d
    where d.idempotency_key = 'gr-item:' || p_item_id::text
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. Goods receipt -> stock ledger
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
begin
  select * into v_receipt from public.goods_receipts where id = p_receipt_id;
  if not found then
    return jsonb_build_object('status', 'receipt_not_found');
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

-- Default location is copied from the supplier when the receipt is inserted.
create or replace function public.stock_ledger_default_goods_receipt_location()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.receiving_location is null and new.supplier_id is not null then
    select s.default_receiving_location
    into new.receiving_location
    from public.suppliers s
    where s.id = new.supplier_id;
  end if;
  return new;
end;
$$;

drop trigger if exists goods_receipts_stock_ledger_default_location on public.goods_receipts;
create trigger goods_receipts_stock_ledger_default_location
  before insert on public.goods_receipts
  for each row execute function public.stock_ledger_default_goods_receipt_location();

create or replace function public.trg_stock_ledger_goods_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('confirmed', 'received')
     and (
       old.status is distinct from new.status
       or old.receiving_location is distinct from new.receiving_location
       or old.receipt_date is distinct from new.receipt_date
     ) then
    perform public.post_goods_receipt_to_stock(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists goods_receipts_stock_ledger_post on public.goods_receipts;
create trigger goods_receipts_stock_ledger_post
  after update on public.goods_receipts
  for each row execute function public.trg_stock_ledger_goods_receipt();

-- ---------------------------------------------------------------------------
-- 7. Alias assignment RPCs
-- ---------------------------------------------------------------------------

create or replace function public.resolve_stock_alias(
  p_goods_receipt_item_id uuid,
  p_location text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_conversion_factor numeric,
  p_apply_to_supplier boolean default true
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_name text;
  v_norm text;
  v_supplier_id uuid;
  v_alias public.stock_material_aliases%rowtype;
  v_unit text;
  v_cutover date;
  v_target record;
  v_count integer := 0;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if p_conversion_factor is null or p_conversion_factor <= 0
     or p_conversion_factor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_conversion_factor' using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if p_location = 'q7' then
      if not public.q7_material_inventory_can_edit(v_actor) then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
      if p_kitchen_inventory_item_id is null then
        raise exception 'kitchen_inventory_item_required' using errcode = '22023';
      end if;
    else
      if not public.can_manage_tan_tao_warehouse() then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
      if p_tan_tao_sku_id is null then
        raise exception 'tan_tao_sku_required' using errcode = '22023';
      end if;
    end if;
  end if;

  select * into v_item from public.goods_receipt_items where id = p_goods_receipt_item_id;
  if not found then raise exception 'goods_receipt_item_not_found' using errcode = 'P0002'; end if;
  select * into v_receipt from public.goods_receipts where id = v_item.goods_receipt_id;
  if not found then raise exception 'goods_receipt_not_found' using errcode = 'P0002'; end if;

  v_name := coalesce(nullif(btrim(v_item.raw_product_name), ''), v_item.product_name);
  v_norm := public.normalize_stock_item_name(v_name);
  if v_norm is null then raise exception 'item_name_required' using errcode = '22023'; end if;

  if p_location = 'q7' then
    select kii.unit into v_unit from public.kitchen_inventory_items kii
    where kii.id = p_kitchen_inventory_item_id and kii.active = true;
    if v_unit is null then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;
  else
    select ps.unit into v_unit from public.product_skus ps where ps.id = p_tan_tao_sku_id;
    if v_unit is null then raise exception 'tan_tao_sku_not_found' using errcode = 'P0002'; end if;
  end if;

  v_supplier_id := case when p_apply_to_supplier then v_receipt.supplier_id else null end;

  select * into v_alias
  from public.stock_material_aliases a
  where a.location = p_location
    and a.normalized_name = v_norm
    and a.supplier_id is not distinct from v_supplier_id
  for update;

  if found then
    update public.stock_material_aliases
    set kitchen_inventory_item_id = p_kitchen_inventory_item_id,
        tan_tao_sku_id = p_tan_tao_sku_id,
        conversion_factor = p_conversion_factor,
        unit = v_unit,
        updated_at = now()
    where id = v_alias.id
    returning * into v_alias;
  else
    insert into public.stock_material_aliases(
      supplier_id, normalized_name, location, kitchen_inventory_item_id,
      tan_tao_sku_id, conversion_factor, unit, created_by
    ) values (
      v_supplier_id, v_norm, p_location, p_kitchen_inventory_item_id,
      p_tan_tao_sku_id, p_conversion_factor, v_unit, v_actor
    )
    returning * into v_alias;
  end if;

  v_cutover := public.stock_ledger_cutover_date(p_location);

  for v_target in
    select gri.id
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gr.supplier_id is not distinct from v_receipt.supplier_id
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
        v_count := v_count + 1;
      end if;
    end if;
  end loop;

  return v_count;
end;
$$;

create or replace function public.set_supplier_receiving_location(
  p_supplier_id uuid,
  p_location text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if p_location is not null and p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if p_location = 'tan_tao' then
      if not public.can_manage_tan_tao_warehouse() then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    else
      if not public.q7_material_inventory_can_edit(v_actor) then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    end if;
  end if;
  if p_supplier_id is null then raise exception 'supplier_required' using errcode = '22023'; end if;

  update public.suppliers
  set default_receiving_location = p_location,
      updated_at = now()
  where id = p_supplier_id;
  if not found then raise exception 'supplier_not_found' using errcode = 'P0002'; end if;

  return jsonb_build_object(
    'status', 'updated',
    'supplier_id', p_supplier_id,
    'default_receiving_location', p_location
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Production material issue -> usage ledger
-- Set the receiving warehouse on one receipt (and, optionally, as the supplier default).
-- The goods_receipts update trigger then posts the receipt when it is confirmed.
create or replace function public.set_goods_receipt_receiving_location(
  p_receipt_id uuid,
  p_location text,
  p_remember_for_supplier boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_supplier_id uuid;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if p_location = 'tan_tao' then
      if not public.can_manage_tan_tao_warehouse() then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    elsif not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  update public.goods_receipts
  set receiving_location = p_location
  where id = p_receipt_id
  returning supplier_id into v_supplier_id;
  if not found then raise exception 'goods_receipt_not_found' using errcode = 'P0002'; end if;

  if p_remember_for_supplier and v_supplier_id is not null then
    update public.suppliers
    set default_receiving_location = p_location
    where id = v_supplier_id;
  end if;

  return jsonb_build_object('status', 'updated', 'receipt_id', p_receipt_id, 'receiving_location', p_location);
end;
$$;

revoke all on function public.set_goods_receipt_receiving_location(uuid, text, boolean) from public, anon;
grant execute on function public.set_goods_receipt_receiving_location(uuid, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------

alter table public.q7_inventory_movements
  drop constraint if exists q7_inventory_movements_source_check;
alter table public.q7_inventory_movements
  add constraint q7_inventory_movements_source_check
  check (source in (
    'manual_receipt', 'signed_q7_issue', 'manual_adjustment',
    'goods_receipt', 'production_material_issue', 'production_material_issue_reversal'
  ));

create or replace function public.post_material_issue_usage(p_issue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue public.production_material_issues%rowtype;
  v_cutover date;
  v_row record;
  v_inserted integer := 0;
begin
  select * into v_issue from public.production_material_issues where id = p_issue_id;
  if not found then
    return jsonb_build_object('status', 'issue_not_found');
  end if;
  if v_issue.location_code is distinct from 'q7' then
    return jsonb_build_object('status', 'unsupported_location');
  end if;
  if v_issue.is_current is not true then
    return jsonb_build_object('status', 'not_current');
  end if;
  if v_issue.status not in ('pdf_ready', 'posted') then
    return jsonb_build_object('status', 'not_postable');
  end if;

  v_cutover := public.stock_ledger_cutover_date('q7');
  if v_cutover is null or v_issue.issue_date < v_cutover then
    return jsonb_build_object('status', 'before_cutover');
  end if;

  for v_row in
    select i.id as item_id,
           i.kitchen_inventory_item_id,
           i.unit,
           i.required_qty,
           i.q7_mapping_id,
           i.canonical_material_id
    from public.production_material_issue_items i
    where i.material_issue_id = p_issue_id
      and i.kitchen_inventory_item_id is not null
      and coalesce(i.required_qty, 0) > 0
      and i.required_qty::text not in ('NaN', 'Infinity', '-Infinity')
      and exists (
        select 1
        from public.q7_material_issue_material_mappings m
        where m.approval_status = 'approved'
          and (
            m.id = i.q7_mapping_id
            or (
              i.q7_mapping_id is null
              and i.canonical_material_id is not null
              and m.canonical_material_id = i.canonical_material_id
            )
          )
      )
  loop
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, source_issue_id, source_issue_item_id,
      q7_mapping_id, canonical_material_id, note, created_by
    ) values (
      v_row.kitchen_inventory_item_id, v_issue.issue_date, 'production_usage', v_row.required_qty,
      v_row.unit, 'production_material_issue', 'pmi-item:' || v_row.item_id::text,
      v_issue.id, v_row.item_id, v_row.q7_mapping_id, v_row.canonical_material_id,
      'Xuất NVL cho sản xuất ' || v_issue.issue_number, auth.uid()
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
    get diagnostics v_inserted = row_count;
  end loop;

  return jsonb_build_object('status', 'posted', 'issue_id', p_issue_id);
end;
$$;

create or replace function public.reverse_material_issue_usage(p_issue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_key, source_issue_id, source_issue_item_id,
    q7_mapping_id, canonical_material_id, note, created_by
  )
  select m.kitchen_inventory_item_id,
         (now() at time zone 'Asia/Ho_Chi_Minh')::date,
         'adjustment',
         -m.quantity,
         m.unit,
         'production_material_issue_reversal',
         'pmi-item-reverse:' || m.source_issue_item_id::text,
         m.source_issue_id,
         m.source_issue_item_id,
         m.q7_mapping_id,
         m.canonical_material_id,
         'Đảo bút toán phiếu xuất NVL bị thay thế',
         auth.uid()
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.source_issue_id = p_issue_id
    and m.source_issue_item_id is not null
  on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

  get diagnostics v_count = row_count;
  return jsonb_build_object('status', 'reversed', 'issue_id', p_issue_id, 'movement_count', v_count);
end;
$$;

create or replace function public.trg_stock_ledger_material_issue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('pdf_ready', 'posted')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform public.post_material_issue_usage(new.id);
  end if;
  if new.superseded_by_issue_id is not null
     and (tg_op = 'INSERT' or old.superseded_by_issue_id is distinct from new.superseded_by_issue_id) then
    perform public.reverse_material_issue_usage(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists production_material_issues_stock_ledger on public.production_material_issues;
create trigger production_material_issues_stock_ledger
  after insert or update on public.production_material_issues
  for each row execute function public.trg_stock_ledger_material_issue();

-- ---------------------------------------------------------------------------
-- 9. confirm_q7_material_issue — keep signature, avoid double posting
-- ---------------------------------------------------------------------------

create or replace function public.confirm_q7_material_issue(
  p_issue_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_issue public.production_material_issues%rowtype;
  v_check public.production_material_issue_checks%rowtype;
  v_generator_result jsonb;
  v_generator_status text;
  v_issue_item_count integer := 0;
  v_positive_actual_count integer := 0;
  v_passed_check_count integer := 0;
  v_movement_count integer := 0;
  v_updated_count integer := 0;
  v_negative_count integer := 0;
  v_now timestamptz;
begin
  if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users u where u.id = v_actor_id) then raise exception 'actor_not_found' using errcode = '42501'; end if;
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  elsif not public.q7_material_issue_can_edit(v_actor_id) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_issue from public.production_material_issues where id = p_issue_id;
  if not found then raise exception 'material_issue_not_found' using errcode = 'P0002'; end if;

  v_generator_result := public.generate_q7_production_material_issue(v_issue.production_order_id, v_issue.issue_date);
  v_generator_status := v_generator_result ->> 'status';

  select * into v_issue from public.production_material_issues where id = p_issue_id for update;

  create temp table if not exists q7_confirm_issue_items (
    issue_item_id uuid primary key,
    kitchen_inventory_item_id uuid not null,
    planned_qty numeric(15, 3) not null,
    actual_qty numeric(15, 3) not null,
    unit text not null,
    q7_mapping_id uuid not null,
    canonical_material_id uuid not null,
    source_unit text not null,
    conversion_factor numeric(18, 8) not null
  ) on commit drop;
  truncate table q7_confirm_issue_items;

  if v_issue.status = 'posted' then
    if v_generator_status <> 'posted_unchanged'
       or (v_generator_result ->> 'issue_id')::uuid is distinct from v_issue.id
       or (v_generator_result ->> 'source_hash') is distinct from v_issue.source_hash then
      raise exception 'q7_confirmation_source_changed' using errcode = '22023';
    end if;

    insert into q7_confirm_issue_items(
      issue_item_id, kitchen_inventory_item_id, planned_qty, actual_qty, unit,
      q7_mapping_id, canonical_material_id, source_unit, conversion_factor
    )
    select i.id, i.kitchen_inventory_item_id, i.required_qty, a.actual_qty, i.unit,
           i.q7_mapping_id, i.canonical_material_id, i.source_unit, i.conversion_factor
    from public.production_material_issue_items i
    left join public.production_material_issue_check_actuals a on a.issue_item_id = i.id
    join public.q7_material_issue_material_mappings m on m.id = i.q7_mapping_id
    where i.material_issue_id = v_issue.id
      and m.approval_status = 'approved'
      and a.actual_qty is not null;

    select count(*) into v_issue_item_count from public.production_material_issue_items where material_issue_id = v_issue.id;
    select count(*) into v_positive_actual_count from q7_confirm_issue_items i where i.actual_qty > 0;
    if (select count(*) from q7_confirm_issue_items) <> v_issue_item_count then raise exception 'actuals_required' using errcode = '22023'; end if;

    select count(*) into v_movement_count
    from q7_confirm_issue_items i
    where i.actual_qty > 0
      and exists (
        select 1
        from public.q7_inventory_movements m
        where (m.source = 'production_material_issue'
               and m.source_ref_key = 'pmi-item:' || i.issue_item_id::text)
           or (m.source = 'signed_q7_issue'
               and m.source_issue_item_id = i.issue_item_id)
      );
    if v_movement_count <> v_positive_actual_count then raise exception 'q7_confirm_movement_mismatch' using errcode = '22023'; end if;

    select count(*) into v_negative_count from public.get_q7_inventory_snapshot(v_issue.issue_date) s where s.is_negative;
    return jsonb_build_object('status', 'posted_unchanged', 'issue_id', v_issue.id, 'issue_number', v_issue.issue_number, 'movement_count', v_movement_count, 'negative_count', v_negative_count);
  end if;

  if v_generator_status <> 'ready_to_confirm_unchanged'
     or (v_generator_result ->> 'issue_id')::uuid is distinct from v_issue.id
     or (v_generator_result ->> 'source_hash') is distinct from v_issue.source_hash then
    raise exception 'q7_confirmation_source_changed' using errcode = '22023';
  end if;

  if v_issue.status <> 'ready_to_confirm' then raise exception 'blocked_issue_status' using errcode = '22023'; end if;
  if v_issue.location_code is distinct from 'q7' or v_issue.is_current is not true or v_issue.superseded_by_issue_id is not null then
    raise exception 'blocked_non_current_issue' using errcode = '22023';
  end if;
  if v_issue.issue_date > (now() at time zone 'Asia/Ho_Chi_Minh')::date then raise exception 'blocked_future_issue_date' using errcode = '22023'; end if;
  if v_issue.pdf_path is null or v_issue.pdf_sha256 is null or v_issue.signed_file_path is null or v_issue.signed_file_sha256 is null or v_issue.signed_uploaded_by is null or v_issue.signed_uploaded_at is null then
    raise exception 'signed_metadata_required' using errcode = '22023';
  end if;
  if v_issue.check_status is distinct from 'passed' or v_issue.checked_at is null then raise exception 'passed_check_required' using errcode = '22023'; end if;

  select count(*) into v_passed_check_count
  from public.production_material_issue_checks c
  where c.issue_id = v_issue.id and c.signed_file_sha256 = lower(v_issue.signed_file_sha256) and c.status = 'passed';
  if v_passed_check_count <> 1 then raise exception 'passed_check_required' using errcode = '22023'; end if;

  select * into v_check
  from public.production_material_issue_checks c
  where c.issue_id = v_issue.id and c.signed_file_sha256 = lower(v_issue.signed_file_sha256) and c.status = 'passed'
  for update;
  if v_check.signed_file_sha256 is distinct from lower(v_issue.signed_file_sha256)
     or not (v_check.result @> '{"identity_exact":true,"rows_exact":true,"document_legible":true,"pages_complete":true,"preparer_signed":true,"warehouse_keeper_signed":true,"receiver_signed":true}'::jsonb)
     or not (jsonb_typeof(v_check.result -> 'confidence') = 'number' and (v_check.result ->> 'confidence')::numeric >= 0.8) then
    raise exception 'passed_check_required' using errcode = '22023';
  end if;

  select count(*) into v_issue_item_count from public.production_material_issue_items where material_issue_id = v_issue.id;
  if v_issue_item_count = 0 then raise exception 'issue_items_required' using errcode = '22023'; end if;

  insert into q7_confirm_issue_items(
    issue_item_id, kitchen_inventory_item_id, planned_qty, actual_qty, unit,
    q7_mapping_id, canonical_material_id, source_unit, conversion_factor
  )
  select i.id, i.kitchen_inventory_item_id, i.required_qty, a.actual_qty, i.unit,
         i.q7_mapping_id, i.canonical_material_id, i.source_unit, i.conversion_factor
  from public.production_material_issue_items i
  left join public.production_material_issue_check_actuals a on a.issue_item_id = i.id and a.check_id = v_check.id
  join public.q7_material_issue_material_mappings m on m.id = i.q7_mapping_id
  where i.material_issue_id = v_issue.id
    and m.approval_status = 'approved'
    and m.kitchen_inventory_item_id is not distinct from i.kitchen_inventory_item_id
    and lower(btrim(m.kitchen_unit)) is not distinct from lower(btrim(i.unit))
    and m.conversion_factor is not distinct from i.conversion_factor
    and m.canonical_material_id is not distinct from i.canonical_material_id
    and lower(btrim(m.source_unit)) is not distinct from lower(btrim(i.source_unit))
    and i.required_qty > 0
    and i.required_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and a.actual_qty is not null
    and a.actual_qty >= 0
    and a.actual_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and a.planned_qty is not distinct from i.required_qty
    and lower(btrim(a.unit)) is not distinct from lower(btrim(i.unit));

  if (select count(*) from q7_confirm_issue_items) <> v_issue_item_count then
    raise exception 'issue_item_actual_snapshot_mismatch' using errcode = '22023';
  end if;

  -- The stock ledger already wrote pmi-item rows when the issue became pdf_ready.
  -- Re-run the idempotent writer so cutover-enabled issues are still ledgered even
  -- when the confirmation path is reached directly.
  perform public.post_material_issue_usage(v_issue.id);

  v_now := clock_timestamp();

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_id, source_ref_key, source_issue_id, source_issue_item_id,
    note, created_by, created_at
  )
  select i.kitchen_inventory_item_id,
         v_issue.issue_date,
         'production_usage',
         i.actual_qty,
         i.unit,
         'signed_q7_issue',
         i.issue_item_id,
         'q7-material-issue:' || i.issue_item_id::text,
         v_issue.id,
         i.issue_item_id,
         'Q7 confirmed signed material issue actual quantity',
         v_actor_id,
         v_now
  from q7_confirm_issue_items i
  where i.actual_qty > 0
    and not exists (
      select 1
      from public.q7_inventory_movements pm
      where pm.source = 'production_material_issue'
        and pm.source_ref_key = 'pmi-item:' || i.issue_item_id::text
    )
  order by i.kitchen_inventory_item_id, i.issue_item_id
  on conflict (source, source_issue_item_id) where source = 'signed_q7_issue' and source_issue_item_id is not null do nothing;

  select count(*) into v_positive_actual_count from q7_confirm_issue_items i where i.actual_qty > 0;
  select count(*) into v_movement_count
  from q7_confirm_issue_items i
  where i.actual_qty > 0
    and exists (
      select 1
      from public.q7_inventory_movements m
      where (m.source = 'production_material_issue'
             and m.source_ref_key = 'pmi-item:' || i.issue_item_id::text)
         or (m.source = 'signed_q7_issue'
             and m.source_issue_item_id = i.issue_item_id)
    );
  if v_movement_count <> v_positive_actual_count then raise exception 'q7_confirm_movement_mismatch' using errcode = '22023'; end if;

  update public.production_material_issues
  set status = 'posted', confirmed_by = v_actor_id, confirmed_at = v_now, posted_at = v_now, updated_at = v_now
  where id = v_issue.id and status = 'ready_to_confirm';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then raise exception 'q7_confirm_issue_update_mismatch' using errcode = '22023'; end if;

  select count(*) into v_negative_count from public.get_q7_inventory_snapshot(v_issue.issue_date) s where s.is_negative;

  insert into public.production_material_issue_events(
    issue_id, event_type, from_status, to_status, actor, metadata
  ) values (
    v_issue.id, 'material_issue_confirmed_and_posted', 'ready_to_confirm', 'posted', v_actor_id,
    jsonb_build_object('movement_count', v_movement_count, 'negative_count', v_negative_count)
  );

  return jsonb_build_object('status', 'posted', 'issue_id', v_issue.id, 'issue_number', v_issue.issue_number, 'movement_count', v_movement_count, 'negative_count', v_negative_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Weekly stock count RPC for Q7 (Tân Tạo reuses record_tan_tao_stock_count)
-- ---------------------------------------------------------------------------

create or replace function public.record_q7_stock_count(
  p_kitchen_inventory_item_id uuid,
  p_counted_qty numeric,
  p_count_date date,
  p_note text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_count_date date := coalesce(p_count_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_book numeric := 0;
  v_diff numeric := 0;
  v_adjustment jsonb := '{}'::jsonb;
  v_source_key text;
begin
  if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not public.q7_material_inventory_can_edit(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_counted_qty is null or p_counted_qty < 0
     or p_counted_qty::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_counted_qty' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_kitchen_inventory_item_id and active = true;
  if not found then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;

  -- The first count of a location that has no cutover yet starts the ledger.
  update public.stock_ledger_settings
  set q7_cutover_date = coalesce(q7_cutover_date, v_count_date),
      updated_at = now()
  where id = 1 and q7_cutover_date is null;

  select s.balance_qty into v_book
  from public.get_q7_inventory_snapshot(v_count_date) s
  where s.kitchen_inventory_item_id = v_item.id;
  v_book := coalesce(v_book, 0);
  v_diff := p_counted_qty - v_book;

  if v_diff <> 0 then
    v_source_key := 'q7-stock-count:' || btrim(p_idempotency_key);
    v_adjustment := public.record_q7_inventory_adjustment(
      v_count_date,
      v_item.id,
      v_diff,
      v_item.unit,
      coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Kiểm kê NVL Q7'),
      v_source_key
    );
  else
    v_adjustment := jsonb_build_object('status', 'no_adjustment');
  end if;

  return jsonb_build_object(
    'status', 'recorded',
    'location', 'q7',
    'kitchen_inventory_item_id', v_item.id,
    'count_date', v_count_date,
    'system_qty', v_book,
    'counted_qty', p_counted_qty,
    'difference_qty', v_diff,
    'idempotency_key', btrim(p_idempotency_key),
    'adjustment', v_adjustment
  );
end;
$$;

-- Tân Tạo cutover is started by the first physical stock count document.
create or replace function public.stock_ledger_tan_tao_stock_count_cutover()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.document_type = 'stock_count' then
    update public.stock_ledger_settings
    set tan_tao_cutover_date = coalesce(
          tan_tao_cutover_date,
          (new.created_at at time zone 'Asia/Ho_Chi_Minh')::date
        ),
        updated_at = now()
    where id = 1 and tan_tao_cutover_date is null;
  end if;
  return new;
end;
$$;

drop trigger if exists tan_tao_warehouse_documents_stock_ledger_cutover on public.tan_tao_warehouse_documents;
create trigger tan_tao_warehouse_documents_stock_ledger_cutover
  after insert on public.tan_tao_warehouse_documents
  for each row execute function public.stock_ledger_tan_tao_stock_count_cutover();

-- ---------------------------------------------------------------------------
-- 11. Read RPC for the new stock ledger page
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
             public.normalize_stock_item_name(
               coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
             ) as normalized_name,
             greatest(0, coalesce(gri.actual_quantity, gri.quantity, 0))::numeric as quantity,
             gr.receipt_date
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      left join public.suppliers sup on sup.id = gr.supplier_id
      where gr.receiving_location = p_location
        and gr.status in ('confirmed', 'received')
        and gr.receipt_date >= v_cutover
        and public.resolve_stock_material_alias(
              gr.supplier_id,
              public.normalize_stock_item_name(
                coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
              ),
              p_location
            ) is null
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
-- 12. RLS and grants
-- ---------------------------------------------------------------------------

alter table public.stock_ledger_settings enable row level security;
alter table public.stock_material_aliases enable row level security;

drop policy if exists stock_ledger_settings_select on public.stock_ledger_settings;
create policy stock_ledger_settings_select on public.stock_ledger_settings
  for select to authenticated
  using (
    public.q7_material_inventory_can_view((select auth.uid()))
    or public.can_view_tan_tao_warehouse()
  );

drop policy if exists stock_material_aliases_select on public.stock_material_aliases;
create policy stock_material_aliases_select on public.stock_material_aliases
  for select to authenticated
  using (
    (location = 'q7' and public.q7_material_inventory_can_view((select auth.uid())))
    or (location = 'tan_tao' and public.can_view_tan_tao_warehouse())
  );

drop policy if exists stock_material_aliases_insert on public.stock_material_aliases;
create policy stock_material_aliases_insert on public.stock_material_aliases
  for insert to authenticated
  with check (
    (location = 'q7' and public.q7_material_inventory_can_edit((select auth.uid())))
    or (location = 'tan_tao' and public.can_manage_tan_tao_warehouse())
  );

drop policy if exists stock_material_aliases_update on public.stock_material_aliases;
create policy stock_material_aliases_update on public.stock_material_aliases
  for update to authenticated
  using (
    (location = 'q7' and public.q7_material_inventory_can_edit((select auth.uid())))
    or (location = 'tan_tao' and public.can_manage_tan_tao_warehouse())
  )
  with check (
    (location = 'q7' and public.q7_material_inventory_can_edit((select auth.uid())))
    or (location = 'tan_tao' and public.can_manage_tan_tao_warehouse())
  );

drop policy if exists stock_material_aliases_delete on public.stock_material_aliases;
create policy stock_material_aliases_delete on public.stock_material_aliases
  for delete to authenticated
  using (
    (location = 'q7' and public.q7_material_inventory_can_edit((select auth.uid())))
    or (location = 'tan_tao' and public.can_manage_tan_tao_warehouse())
  );

revoke all on table public.stock_ledger_settings from public, anon, authenticated;
grant select on table public.stock_ledger_settings to authenticated;

revoke all on table public.stock_material_aliases from public, anon, authenticated;
grant select, insert, update, delete on table public.stock_material_aliases to authenticated;

revoke all on function public.normalize_stock_item_name(text) from public, anon;
grant execute on function public.normalize_stock_item_name(text) to authenticated, service_role;

revoke all on function public.stock_ledger_cutover_date(text) from public, anon, authenticated;
grant execute on function public.stock_ledger_cutover_date(text) to service_role;

revoke all on function public.resolve_stock_material_alias(uuid, text, text) from public, anon, authenticated;
grant execute on function public.resolve_stock_material_alias(uuid, text, text) to service_role;

revoke all on function public.stock_goods_receipt_item_is_posted(uuid) from public, anon, authenticated;
grant execute on function public.stock_goods_receipt_item_is_posted(uuid) to service_role;

revoke all on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) from public, anon, authenticated;
grant execute on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) to service_role;

revoke all on function public.post_goods_receipt_to_stock(uuid) from public, anon, authenticated;
grant execute on function public.post_goods_receipt_to_stock(uuid) to service_role;

revoke all on function public.stock_ledger_default_goods_receipt_location() from public, anon, authenticated;
revoke all on function public.trg_stock_ledger_goods_receipt() from public, anon, authenticated;

revoke all on function public.resolve_stock_alias(uuid, text, uuid, uuid, numeric, boolean) from public, anon;
grant execute on function public.resolve_stock_alias(uuid, text, uuid, uuid, numeric, boolean) to authenticated, service_role;

revoke all on function public.set_supplier_receiving_location(uuid, text) from public, anon;
grant execute on function public.set_supplier_receiving_location(uuid, text) to authenticated, service_role;

revoke all on function public.post_material_issue_usage(uuid) from public, anon, authenticated;
grant execute on function public.post_material_issue_usage(uuid) to service_role;

revoke all on function public.reverse_material_issue_usage(uuid) from public, anon, authenticated;
grant execute on function public.reverse_material_issue_usage(uuid) to service_role;

revoke all on function public.trg_stock_ledger_material_issue() from public, anon, authenticated;

revoke all on function public.record_q7_stock_count(uuid, numeric, date, text, text) from public, anon;
grant execute on function public.record_q7_stock_count(uuid, numeric, date, text, text) to authenticated, service_role;

revoke all on function public.stock_ledger_tan_tao_stock_count_cutover() from public, anon, authenticated;

revoke all on function public.get_stock_ledger_overview(text, date) from public, anon;
grant execute on function public.get_stock_ledger_overview(text, date) to authenticated, service_role;

-- confirm_q7_material_issue keeps its original grants (CREATE OR REPLACE preserves them).
revoke all on function public.confirm_q7_material_issue(uuid) from public, anon;
grant execute on function public.confirm_q7_material_issue(uuid) to authenticated, service_role;
