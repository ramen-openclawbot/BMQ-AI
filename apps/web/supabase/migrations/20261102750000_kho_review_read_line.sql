-- 2026-10-23 — Rà soát nhập kho: đọc dòng phiếu bằng OCR, sửa đơn vị bị đọc
-- sai trên dòng chưa ghi sổ, và gợi ý hệ số quy đổi có bằng chứng.
--
-- Additive migration. It does not change kho_review_list(),
-- kho_review_link_line(), kho_review_create_item_from_line() or the
-- kho-review-jev function behaviour.
--
-- * public.kho_review_line_reads — the OCR answer cache, one row per
--   (receipt item, image-set sha, prompt version).  Only the service role may
--   read or write it.
-- * public.kho_review_line_context(uuid) — the line + receipt image paths +
--   posted/link state, gated by the same permission check kho_review_list uses.
-- * public.kho_review_fix_line_unit(uuid, text, uuid) — corrects only the unit
--   of an unposted, unlinked line, with an audit row and request_id replay.
-- * public.kho_review_undo_unit_fix(uuid) — restores the old unit while the
--   line is still unposted/unlinked.
-- * public.kho_review_factor_hint(uuid, uuid, text) — a prefilled factor from
--   an approved conversion, a confirmed alias, printed pack content or the
--   standard weight/volume table.  It never invents a factor.
--
-- The document-line unit trigger (public.stock_document_line_normalize_unit)
-- stays in charge of the stored spelling: this file only writes
-- goods_receipt_items.unit and lets that trigger map a known unit to its
-- stock_units label.  Quantity, unit_price and line_total are never written.
--
-- Additive and idempotent; the Maestro applies it.

-- ===========================================================================
-- 1. OCR read cache
-- ===========================================================================

create table if not exists public.kho_review_line_reads (
  receipt_item_id uuid not null references public.goods_receipt_items(id) on delete cascade,
  images_sha text not null,
  prompt_version text not null,
  result jsonb not null default '{}'::jsonb,
  ocr_engine text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint kho_review_line_reads_pkey
    primary key (receipt_item_id, images_sha, prompt_version)
);

alter table public.kho_review_line_reads enable row level security;

-- Service role only: no browser policy and no direct client grant.
revoke all on table public.kho_review_line_reads from public, anon, authenticated;
grant all on table public.kho_review_line_reads to service_role;

-- ===========================================================================
-- 2. Unit-fix audit trail
-- ===========================================================================

create table if not exists public.kho_review_unit_fixes (
  id uuid primary key default gen_random_uuid(),
  receipt_item_id uuid not null references public.goods_receipt_items(id) on delete cascade,
  old_unit text,
  new_unit text not null,
  request_id uuid unique,
  actor uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);

alter table public.kho_review_unit_fixes enable row level security;

revoke all on table public.kho_review_unit_fixes from public, anon, authenticated;
grant all on table public.kho_review_unit_fixes to service_role;

create index if not exists idx_kho_review_unit_fixes_line
  on public.kho_review_unit_fixes(receipt_item_id, created_at desc);

-- ===========================================================================
-- 3. Shared gate + line context
-- ===========================================================================

-- Keep the exact permission check from kho_review_list().  SECURITY DEFINER
-- reads the line and its receipt image paths only after the caller passes the
-- gate, so a random receipt_item_id cannot be probed by a denied account.
create or replace function public.kho_review_line_context(p_receipt_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_supplier_name text;
  v_location text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_posted boolean := false;
  v_paths text[] := array[]::text[];
  v_path text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.q7_material_inventory_can_edit(v_actor)
         or public.has_module_permission(v_actor, 'inventory', 'edit')
       ) then
      raise exception 'kho_review_forbidden' using errcode = '42501';
    end if;
  end if;

  select * into v_line
  from public.goods_receipt_items gri
  where gri.id = p_receipt_item_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  select * into v_receipt
  from public.goods_receipts gr
  where gr.id = v_line.goods_receipt_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  v_location := coalesce(v_receipt.receiving_location, 'tan_tao');
  if v_location not in ('q7', 'tan_tao') then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  select s.name into v_supplier_name
  from public.suppliers s
  where s.id = v_receipt.supplier_id;

  v_norm := public.normalize_stock_item_name(
    coalesce(nullif(btrim(v_line.raw_product_name), ''), v_line.product_name)
  );
  if v_norm is null or v_norm = '' then
    v_norm := lower(btrim(coalesce(v_line.product_name, '')));
  end if;

  select * into v_alias
  from public.stock_material_aliases a
  where a.location = v_location
    and a.normalized_name = v_norm
    and a.supplier_id is not distinct from v_receipt.supplier_id
    and a.status is distinct from 'disabled'
  order by (a.kitchen_inventory_item_id is not null) desc,
           a.last_confirmed_at desc nulls last,
           a.updated_at desc,
           a.id desc
  limit 1;

  select exists (
    select 1
    from public.q7_inventory_movements m
    where m.source = 'goods_receipt'
      and m.source_ref_key = 'gr-item:' || p_receipt_item_id::text
    union all
    select 1
    from public.tan_tao_material_movements m
    where m.source = 'goods_receipt'
      and m.source_ref_key = 'gr-item:' || p_receipt_item_id::text
  ) into v_posted;

  if btrim(coalesce(v_receipt.image_url, '')) <> '' then
    v_paths := array_append(v_paths, btrim(v_receipt.image_url));
  end if;
  if v_receipt.product_photos is not null then
    foreach v_path in array v_receipt.product_photos loop
      if btrim(coalesce(v_path, '')) <> '' then
        v_paths := array_append(v_paths, btrim(v_path));
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'receipt_item_id', v_line.id,
    'goods_receipt_id', v_line.goods_receipt_id,
    'receipt_number', v_receipt.receipt_number,
    'receipt_date', v_receipt.receipt_date,
    'location', v_location,
    'supplier_id', v_receipt.supplier_id,
    'supplier_name', v_supplier_name,
    'product_name', coalesce(nullif(btrim(v_line.raw_product_name), ''), v_line.product_name),
    'unit', nullif(btrim(v_line.unit), ''),
    'actual_quantity', coalesce(v_line.actual_quantity, nullif(v_line.ordered_quantity, 0), nullif(v_line.quantity, 0)),
    'unit_price', v_line.unit_price,
    'image_url', nullif(btrim(v_receipt.image_url), ''),
    'product_photos', to_jsonb(coalesce(v_receipt.product_photos, '{}'::text[])),
    'image_paths', to_jsonb(v_paths),
    'posted', coalesce(v_posted, false),
    'alias_id', v_alias.id,
    'alias_status', v_alias.status,
    'linked_item_id', v_alias.kitchen_inventory_item_id,
    'linked_sku_id', v_alias.tan_tao_sku_id,
    'linked_factor', v_alias.conversion_factor
  );
end;
$$;

revoke all on function public.kho_review_line_context(uuid) from public, anon;
grant execute on function public.kho_review_line_context(uuid) to authenticated, service_role;

-- ===========================================================================
-- 4. Correct the document unit on an unposted, unlinked line
-- ===========================================================================

create or replace function public.kho_review_fix_line_unit(
  p_receipt_item_id uuid,
  p_new_unit text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_location text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_posted boolean := false;
  v_old_unit text;
  v_new_unit text;
  v_code text;
  v_label text;
  v_applied_unit text;
  v_existing public.kho_review_unit_fixes%rowtype;
  v_fix_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.q7_material_inventory_can_edit(v_actor)
         or public.has_module_permission(v_actor, 'inventory', 'edit')
       ) then
      raise exception 'kho_review_forbidden' using errcode = '42501';
    end if;
  end if;

  -- Replay first: a completed request stays completed even if the line is
  -- posted/linked after the original fix.
  if p_request_id is not null then
    select * into v_existing
    from public.kho_review_unit_fixes f
    where f.request_id = p_request_id;
    if found then
      return jsonb_build_object(
        'status', 'fixed',
        'fix_id', v_existing.id,
        'receipt_item_id', v_existing.receipt_item_id,
        'old_unit', v_existing.old_unit,
        'new_unit', v_existing.new_unit,
        'request_id', v_existing.request_id,
        'replayed', true
      );
    end if;
  end if;

  select * into v_line
  from public.goods_receipt_items gri
  where gri.id = p_receipt_item_id
  for update;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  select * into v_receipt
  from public.goods_receipts gr
  where gr.id = v_line.goods_receipt_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  v_location := coalesce(v_receipt.receiving_location, 'tan_tao');
  if v_location not in ('q7', 'tan_tao') then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  select exists (
    select 1
    from public.q7_inventory_movements m
    where m.source = 'goods_receipt'
      and m.source_ref_key = 'gr-item:' || p_receipt_item_id::text
    union all
    select 1
    from public.tan_tao_material_movements m
    where m.source = 'goods_receipt'
      and m.source_ref_key = 'gr-item:' || p_receipt_item_id::text
  ) into v_posted;
  if v_posted then
    raise exception 'line_posted' using errcode = '22023';
  end if;

  v_norm := public.normalize_stock_item_name(
    coalesce(nullif(btrim(v_line.raw_product_name), ''), v_line.product_name)
  );
  if v_norm is null or v_norm = '' then
    v_norm := lower(btrim(coalesce(v_line.product_name, '')));
  end if;

  select * into v_alias
  from public.stock_material_aliases a
  where a.location = v_location
    and a.normalized_name = v_norm
    and a.supplier_id is not distinct from v_receipt.supplier_id
    and a.status is distinct from 'disabled'
    and (a.kitchen_inventory_item_id is not null or a.tan_tao_sku_id is not null)
    and a.conversion_factor is not null
    and a.conversion_factor > 0
  order by (a.kitchen_inventory_item_id is not null) desc,
           a.last_confirmed_at desc nulls last,
           a.updated_at desc,
           a.id desc
  limit 1;
  if found then
    raise exception 'line_linked' using errcode = '22023';
  end if;

  v_new_unit := public.normalize_document_unit(p_new_unit);
  if v_new_unit is null then
    raise exception 'unknown_unit' using errcode = '22023';
  end if;

  -- The existing BEFORE UPDATE trigger maps a known spelling to its
  -- stock_units label (KG -> kg, Cuôn -> cuộn).  Unknown labels are refused
  -- here instead of being written as a free-text unit.
  v_code := public.stock_unit_code(v_new_unit);
  if v_code is null then
    raise exception 'unknown_unit' using errcode = '22023';
  end if;
  select u.label into v_label
  from public.stock_units u
  where u.code = v_code;
  if v_label is not null then
    v_new_unit := v_label;
  end if;

  v_old_unit := nullif(btrim(v_line.unit), '');
  if v_old_unit is not distinct from v_new_unit then
    return jsonb_build_object(
      'status', 'unchanged',
      'receipt_item_id', p_receipt_item_id,
      'old_unit', v_old_unit,
      'new_unit', v_new_unit,
      'request_id', p_request_id
    );
  end if;

  -- Only the unit column is written.  Quantity, unit_price and line_total
  -- stay byte-for-byte unchanged.
  update public.goods_receipt_items
    set unit = v_new_unit
  where id = p_receipt_item_id
  returning unit into v_applied_unit;
  v_applied_unit := coalesce(v_applied_unit, v_new_unit);

  insert into public.kho_review_unit_fixes (
    receipt_item_id, old_unit, new_unit, request_id, actor
  ) values (
    p_receipt_item_id, v_old_unit, v_applied_unit, p_request_id, v_actor
  ) returning id into v_fix_id;

  return jsonb_build_object(
    'status', 'fixed',
    'fix_id', v_fix_id,
    'receipt_item_id', p_receipt_item_id,
    'old_unit', v_old_unit,
    'new_unit', v_applied_unit,
    'request_id', p_request_id,
    'replayed', false
  );
end;
$$;

revoke all on function public.kho_review_fix_line_unit(uuid, text, uuid) from public, anon;
grant execute on function public.kho_review_fix_line_unit(uuid, text, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 5. Undo one unit fix while the line is still unposted/unlinked
-- ===========================================================================

create or replace function public.kho_review_undo_unit_fix(p_fix_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_fix public.kho_review_unit_fixes%rowtype;
  v_line public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_location text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_posted boolean := false;
  v_applied_unit text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.q7_material_inventory_can_edit(v_actor)
         or public.has_module_permission(v_actor, 'inventory', 'edit')
       ) then
      raise exception 'kho_review_forbidden' using errcode = '42501';
    end if;
  end if;

  select * into v_fix
  from public.kho_review_unit_fixes f
  where f.id = p_fix_id
  for update;
  if not found then
    raise exception 'fix_not_found' using errcode = 'P0002';
  end if;
  if v_fix.undone_at is not null then
    return jsonb_build_object(
      'status', 'already_undone',
      'fix_id', v_fix.id,
      'receipt_item_id', v_fix.receipt_item_id,
      'unit', v_fix.old_unit
    );
  end if;

  select * into v_line
  from public.goods_receipt_items gri
  where gri.id = v_fix.receipt_item_id
  for update;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  select * into v_receipt
  from public.goods_receipts gr
  where gr.id = v_line.goods_receipt_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  v_location := coalesce(v_receipt.receiving_location, 'tan_tao');

  select exists (
    select 1
    from public.q7_inventory_movements m
    where m.source = 'goods_receipt'
      and m.source_ref_key = 'gr-item:' || v_fix.receipt_item_id::text
    union all
    select 1
    from public.tan_tao_material_movements m
    where m.source = 'goods_receipt'
      and m.source_ref_key = 'gr-item:' || v_fix.receipt_item_id::text
  ) into v_posted;
  if v_posted then
    raise exception 'line_posted' using errcode = '22023';
  end if;

  v_norm := public.normalize_stock_item_name(
    coalesce(nullif(btrim(v_line.raw_product_name), ''), v_line.product_name)
  );
  if v_norm is null or v_norm = '' then
    v_norm := lower(btrim(coalesce(v_line.product_name, '')));
  end if;

  select * into v_alias
  from public.stock_material_aliases a
  where a.location = v_location
    and a.normalized_name = v_norm
    and a.supplier_id is not distinct from v_receipt.supplier_id
    and a.status is distinct from 'disabled'
    and (a.kitchen_inventory_item_id is not null or a.tan_tao_sku_id is not null)
    and a.conversion_factor is not null
    and a.conversion_factor > 0
  order by (a.kitchen_inventory_item_id is not null) desc,
           a.last_confirmed_at desc nulls last,
           a.updated_at desc,
           a.id desc
  limit 1;
  if found then
    raise exception 'line_linked' using errcode = '22023';
  end if;

  update public.goods_receipt_items
    set unit = v_fix.old_unit
  where id = v_fix.receipt_item_id
  returning unit into v_applied_unit;
  v_applied_unit := coalesce(v_applied_unit, v_fix.old_unit);

  update public.kho_review_unit_fixes
    set undone_at = now()
  where id = v_fix.id;

  return jsonb_build_object(
    'status', 'undone',
    'fix_id', v_fix.id,
    'receipt_item_id', v_fix.receipt_item_id,
    'unit', v_applied_unit
  );
end;
$$;

revoke all on function public.kho_review_undo_unit_fix(uuid) from public, anon;
grant execute on function public.kho_review_undo_unit_fix(uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 6. A prefilled factor only when an approved source proves it
-- ===========================================================================

create or replace function public.kho_review_factor_hint(
  p_receipt_item_id uuid,
  p_item_id uuid,
  p_doc_unit text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_location text;
  v_product_name text;
  v_norm text;
  v_doc_unit text;
  v_item_unit text;
  v_factor numeric;
  v_standard numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.q7_material_inventory_can_edit(v_actor)
         or public.has_module_permission(v_actor, 'inventory', 'edit')
       ) then
      raise exception 'kho_review_forbidden' using errcode = '42501';
    end if;
  end if;

  select * into v_line
  from public.goods_receipt_items gri
  where gri.id = p_receipt_item_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  select * into v_receipt
  from public.goods_receipts gr
  where gr.id = v_line.goods_receipt_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  v_location := coalesce(v_receipt.receiving_location, 'tan_tao');
  v_product_name := coalesce(nullif(btrim(v_line.raw_product_name), ''), v_line.product_name);
  v_norm := public.normalize_stock_item_name(v_product_name);
  if v_norm is null or v_norm = '' then
    v_norm := lower(btrim(coalesce(v_line.product_name, '')));
  end if;

  v_doc_unit := public.normalize_document_unit(coalesce(nullif(btrim(p_doc_unit), ''), v_line.unit));
  if v_doc_unit is null then
    return jsonb_build_object('factor', null, 'source', null);
  end if;

  if p_item_id is not null then
    select k.unit into v_item_unit
    from public.kitchen_inventory_items k
    where k.id = p_item_id
      and k.merged_into_id is null;
  end if;

  -- (1a) A factor the warehouse already saved for this item + receipt unit.
  if p_item_id is not null then
    select f.factor into v_factor
    from public.stock_item_unit_factors f
    where f.kitchen_inventory_item_id = p_item_id
      and (
        public.normalize_document_unit(f.unit) = v_doc_unit
        or (
          public.stock_unit_code(f.unit) is not null
          and public.stock_unit_code(f.unit) = public.stock_unit_code(v_doc_unit)
        )
      )
      and f.factor > 0
    order by f.updated_at desc, f.id desc
    limit 1;
    if v_factor is not null and v_factor > 0 then
      return jsonb_build_object('factor', v_factor, 'source', 'approved_conversion');
    end if;

    -- (1b) An owner-approved material conversion for the material mapped to
    -- this item, when it lands exactly on the item unit.
    if v_item_unit is not null then
      select c.factor into v_factor
      from public.material_unit_conversions c
      join public.cogs_ingredient_stock_map sm
        on sm.canonical_material_id = c.material_id
      where sm.kitchen_inventory_item_id = p_item_id
        and sm.status in ('auto', 'confirmed')
        and c.active = true
        and c.approved = true
        and c.effective_from <= current_date
        and (c.effective_to is null or c.effective_to >= current_date)
        and (
          public.normalize_document_unit(c.from_unit) = v_doc_unit
          or (
            public.stock_unit_code(c.from_unit) is not null
            and public.stock_unit_code(c.from_unit) = public.stock_unit_code(v_doc_unit)
          )
        )
        and (
          public.normalize_document_unit(c.to_unit) = public.normalize_document_unit(v_item_unit)
          or (
            public.stock_unit_code(c.to_unit) is not null
            and public.stock_unit_code(c.to_unit) = public.stock_unit_code(v_item_unit)
          )
        )
        and c.factor > 0
      order by c.effective_from desc, c.id desc
      limit 1;
      if v_factor is not null and v_factor > 0 then
        return jsonb_build_object('factor', v_factor, 'source', 'approved_conversion');
      end if;
    end if;
  end if;

  -- (2) A confirmed alias for the same supplier/location/name.  The alias
  -- stores the receipt-unit -> item-unit factor; a trusted alias is 'auto'.
  select a.conversion_factor into v_factor
  from public.stock_material_aliases a
  where a.supplier_id is not distinct from v_receipt.supplier_id
    and a.location = v_location
    and a.normalized_name = v_norm
    and a.status = 'auto'
    and a.conversion_factor is not null
    and a.conversion_factor > 0
    and (p_item_id is null or a.kitchen_inventory_item_id = p_item_id)
    and (
      v_item_unit is null
      or public.normalize_document_unit(a.unit) = public.normalize_document_unit(v_item_unit)
      or public.stock_unit_code(a.unit) = public.stock_unit_code(v_item_unit)
    )
  order by a.last_confirmed_at desc nulls last, a.updated_at desc, a.id desc
  limit 1;
  if v_factor is not null and v_factor > 0 then
    return jsonb_build_object('factor', v_factor, 'source', 'alias');
  end if;

  -- (3) Pack content printed in the product name, e.g. "(Hộp 100 cái)".
  if p_item_id is not null and v_item_unit is not null then
    v_factor := public.stock_unit_pack_factor(v_product_name, v_doc_unit, v_item_unit);
    if v_factor is not null and v_factor > 0 then
      return jsonb_build_object('factor', v_factor, 'source', 'name_pack');
    end if;

    -- (4) The shared standard weight/volume table, same base unit.
    select du.to_base / iu.to_base into v_standard
    from public.stock_units du
    join public.stock_units iu
      on iu.code = public.stock_unit_code(v_item_unit)
    where du.code = public.stock_unit_code(v_doc_unit)
      and du.base_code = iu.base_code
    limit 1;
    if v_standard is not null and v_standard > 0 then
      return jsonb_build_object('factor', v_standard, 'source', 'standard');
    end if;
  end if;

  return jsonb_build_object('factor', null, 'source', null);
end;
$$;

revoke all on function public.kho_review_factor_hint(uuid, uuid, text) from public, anon;
grant execute on function public.kho_review_factor_hint(uuid, uuid, text)
  to authenticated, service_role;
