-- 2026-10-23 — Kho: NSX/HSD/mã lô/nhà sản xuất, hạn dùng và tổng quan hết hạn.
--
-- Data layer only.  This migration:
--   * adds a shared food manufacturer catalogue and the four lot fields on a
--     goods receipt line, its inventory batches and the linked kho item;
--   * stores the shelf life (days) on a finished-goods SKU;
--   * adds kho_set_receipt_line_lot / kho_manufacturer_suggest /
--     sku_set_shelf_life / kho_expiry_overview;
--   * redefines only the receipt-finalize function that inserts
--     inventory_batches, so a finalize copies the lot fields from the line.
--
-- Nothing here changes ledger posting: the finalize body is the same as its
-- latest definition, with only the four extra copied columns.

-- ===========================================================================
-- 1. Food manufacturers
-- ===========================================================================

create table if not exists public.food_manufacturers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text generated always as (public.normalize_stock_item_name(name)) stored,
  address text,
  tax_code text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint food_manufacturers_name_check check (btrim(name) <> ''),
  constraint food_manufacturers_normalized_name_check check (normalized_name is not null),
  constraint food_manufacturers_normalized_name_key unique (normalized_name)
);

alter table public.food_manufacturers enable row level security;

drop policy if exists food_manufacturers_select on public.food_manufacturers;
create policy food_manufacturers_select
  on public.food_manufacturers
  for select
  to authenticated
  using (true);

revoke all on table public.food_manufacturers from public, anon, authenticated;
grant select on table public.food_manufacturers to authenticated;
grant all on table public.food_manufacturers to service_role;

create index if not exists idx_food_manufacturers_name
  on public.food_manufacturers (name);

-- ===========================================================================
-- 2. Lot fields
-- ===========================================================================

alter table public.goods_receipt_items
  add column if not exists manufacture_date date,
  add column if not exists manufacturer_lot text,
  add column if not exists manufacturer_id uuid references public.food_manufacturers(id) on delete set null;

alter table public.goods_receipt_items
  add constraint goods_receipt_items_manufacturer_lot_check
  check (manufacturer_lot is null or char_length(manufacturer_lot) <= 60);

create index if not exists idx_goods_receipt_items_manufacturer
  on public.goods_receipt_items (manufacturer_id);

alter table public.inventory_batches
  add column if not exists manufacturer_lot text,
  add column if not exists manufacturer_id uuid references public.food_manufacturers(id) on delete set null;

create index if not exists idx_inventory_batches_manufacturer
  on public.inventory_batches (manufacturer_id);

alter table public.kitchen_inventory_items
  add column if not exists default_manufacturer_id uuid references public.food_manufacturers(id) on delete set null;

create index if not exists idx_kitchen_inventory_items_default_manufacturer
  on public.kitchen_inventory_items (default_manufacturer_id);

alter table public.product_skus
  add column if not exists shelf_life_days integer;

alter table public.product_skus
  add constraint product_skus_shelf_life_days_check
  check (shelf_life_days is null or shelf_life_days between 0 and 3650);

-- ===========================================================================
-- 3. Idempotency / audit ledgers (server-only)
-- ===========================================================================

create table if not exists public.kho_lot_edits (
  request_id uuid primary key,
  receipt_item_id uuid not null references public.goods_receipt_items(id) on delete cascade,
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.kho_lot_edits enable row level security;
revoke all on table public.kho_lot_edits from public, anon, authenticated;
grant all on table public.kho_lot_edits to service_role;

create index if not exists idx_kho_lot_edits_receipt_item
  on public.kho_lot_edits (receipt_item_id);

create table if not exists public.sku_shelf_life_edits (
  request_id uuid primary key,
  sku_id uuid not null references public.product_skus(id) on delete cascade,
  days integer,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.sku_shelf_life_edits enable row level security;
revoke all on table public.sku_shelf_life_edits from public, anon, authenticated;
grant all on table public.sku_shelf_life_edits to service_role;

create index if not exists idx_sku_shelf_life_edits_sku
  on public.sku_shelf_life_edits (sku_id);

-- ===========================================================================
-- 4. Shared read gate
-- ===========================================================================
-- Same reader gate as kho_get_items(), wrapped so table/storage policies can
-- call it as the authenticated role without exposing the low-level helpers.
-- q7_material_inventory_can_view is itself SECURITY DEFINER and already returns
-- true for service_role.

create or replace function public.kho_lot_can_view(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.q7_material_inventory_can_view(p_actor)
    or public.stock_count_can_view('tan_tao')
    or public.stock_count_can_view('q7')
    or public.kho_item_can_edit(p_actor);
$$;

revoke all on function public.kho_lot_can_view(uuid) from public, anon;
grant execute on function public.kho_lot_can_view(uuid) to authenticated, service_role;

-- ===========================================================================
-- 5. kho_set_receipt_line_lot
-- ===========================================================================

create or replace function public.kho_set_receipt_line_lot(
  p_receipt_item_id uuid,
  p_manufacture_date date,
  p_expiry_date date,
  p_lot text,
  p_manufacturer_name text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.goods_receipt_items%rowtype;
  v_old_values jsonb;
  v_new_values jsonb;
  v_lot text := nullif(btrim(coalesce(p_lot, '')), '');
  v_manufacturer_name text := nullif(btrim(coalesce(p_manufacturer_name, '')), '');
  v_normalized_name text;
  v_manufacturer_id uuid;
  v_item_id uuid;
  v_request_item_id uuid;
  v_batches_updated integer := 0;
  v_default_rows integer := 0;
  v_default_set boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not (
      public.q7_material_inventory_can_edit(v_actor)
      or public.has_module_permission(v_actor, 'inventory', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_manufacture_date is not null
     and p_expiry_date is not null
     and p_expiry_date < p_manufacture_date then
    raise exception 'invalid_expiry_date' using errcode = '22023';
  end if;

  if v_lot is not null and char_length(v_lot) > 60 then
    raise exception 'invalid_manufacturer_lot' using errcode = '22023';
  end if;

  if v_manufacturer_name is not null and char_length(v_manufacturer_name) > 200 then
    raise exception 'invalid_manufacturer_name' using errcode = '22023';
  end if;

  -- Serialize retries carrying the same request id.
  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('kho_lot_edit:' || p_request_id::text));

    select e.receipt_item_id
      into v_request_item_id
      from public.kho_lot_edits e
     where e.request_id = p_request_id;

    if v_request_item_id is not null then
      if v_request_item_id <> p_receipt_item_id then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;

      select *
        into v_item
        from public.goods_receipt_items
       where id = p_receipt_item_id;

      if not found then
        raise exception 'receipt_item_not_found' using errcode = 'P0002';
      end if;

      select fm.name
        into v_manufacturer_name
        from public.food_manufacturers fm
       where fm.id = v_item.manufacturer_id;

      return jsonb_build_object(
        'receipt_item_id', v_item.id,
        'manufacture_date', v_item.manufacture_date,
        'expiry_date', v_item.expiry_date,
        'manufacturer_lot', v_item.manufacturer_lot,
        'manufacturer_id', v_item.manufacturer_id,
        'manufacturer_name', v_manufacturer_name,
        'batches_updated', 0,
        'item_default_set', false,
        'replayed', true
      );
    end if;
  end if;

  select *
    into v_item
    from public.goods_receipt_items
   where id = p_receipt_item_id
   for update;

  if not found then
    raise exception 'receipt_item_not_found' using errcode = 'P0002';
  end if;

  v_old_values := jsonb_build_object(
    'manufacture_date', v_item.manufacture_date,
    'expiry_date', v_item.expiry_date,
    'manufacturer_lot', v_item.manufacturer_lot,
    'manufacturer_id', v_item.manufacturer_id
  );

  v_manufacturer_id := v_item.manufacturer_id;

  -- A null/blank name deliberately keeps the current manufacturer.
  if v_manufacturer_name is not null then
    v_normalized_name := public.normalize_stock_item_name(v_manufacturer_name);

    if v_normalized_name is null then
      raise exception 'invalid_manufacturer_name' using errcode = '22023';
    end if;

    insert into public.food_manufacturers (name, created_by)
    values (v_manufacturer_name, v_actor)
    on conflict (normalized_name) do update
      set name = excluded.name,
          updated_at = now()
    returning id into v_manufacturer_id;
  end if;

  update public.goods_receipt_items
     set manufacture_date = p_manufacture_date,
         expiry_date = p_expiry_date,
         manufacturer_lot = v_lot,
         manufacturer_id = v_manufacturer_id
   where id = p_receipt_item_id;

  update public.inventory_batches b
     set manufacture_date = p_manufacture_date,
         expiry_date = p_expiry_date,
         manufacturer_lot = v_lot,
         manufacturer_id = v_manufacturer_id
   where b.goods_receipt_item_id = p_receipt_item_id;

  get diagnostics v_batches_updated = row_count;

  -- The line's linked kho item is either stored on the line or resolved by the
  -- same supplier + normalized-name alias match kho_get_items() documents.
  v_item_id := v_item.inventory_item_id;

  if v_item_id is null then
    select a.kitchen_inventory_item_id
      into v_item_id
      from public.stock_material_aliases a
      join public.goods_receipts gr
        on gr.supplier_id is not distinct from a.supplier_id
      left join public.suppliers s on s.id = gr.supplier_id
      join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
     where gri.id = p_receipt_item_id
       and a.kitchen_inventory_item_id is not null
       and a.location in ('tan_tao', 'q7')
       and a.location = coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao')
       and gr.status in ('confirmed', 'received')
       and coalesce(s.stock_exempt, false) = false
       and public.stock_line_auto_non_stock(
             coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
           ) is null
       and a.normalized_name = public.normalize_stock_item_name(
             coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
           )
     limit 1;
  end if;

  if v_item_id is not null and v_manufacturer_id is not null then
    update public.kitchen_inventory_items
       set default_manufacturer_id = v_manufacturer_id
     where id = v_item_id
       and default_manufacturer_id is null;

    get diagnostics v_default_rows = row_count;
    v_default_set := v_default_rows > 0;
  end if;

  v_new_values := jsonb_build_object(
    'manufacture_date', p_manufacture_date,
    'expiry_date', p_expiry_date,
    'manufacturer_lot', v_lot,
    'manufacturer_id', v_manufacturer_id
  );

  if p_request_id is not null then
    insert into public.kho_lot_edits (
      request_id, receipt_item_id, old_values, new_values, actor_id
    ) values (
      p_request_id, p_receipt_item_id, v_old_values, v_new_values, v_actor
    )
    on conflict (request_id) do nothing;
  end if;

  select fm.name
    into v_manufacturer_name
    from public.food_manufacturers fm
   where fm.id = v_manufacturer_id;

  return jsonb_build_object(
    'receipt_item_id', p_receipt_item_id,
    'manufacture_date', p_manufacture_date,
    'expiry_date', p_expiry_date,
    'manufacturer_lot', v_lot,
    'manufacturer_id', v_manufacturer_id,
    'manufacturer_name', v_manufacturer_name,
    'batches_updated', v_batches_updated,
    'item_default_set', v_default_set,
    'replayed', false
  );
end;
$$;

revoke all on function public.kho_set_receipt_line_lot(uuid, date, date, text, text, uuid) from public, anon;
grant execute on function public.kho_set_receipt_line_lot(uuid, date, date, text, text, uuid) to authenticated, service_role;

-- ===========================================================================
-- 6. kho_manufacturer_suggest (read-only)
-- ===========================================================================

create or replace function public.kho_manufacturer_suggest(p_receipt_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.goods_receipt_items%rowtype;
  v_normalized_name text;
  v_item_id uuid;
  v_manufacturer_id uuid;
  v_manufacturer_name text;
begin
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

  select *
    into v_item
    from public.goods_receipt_items
   where id = p_receipt_item_id;

  if not found then
    raise exception 'receipt_item_not_found' using errcode = 'P0002';
  end if;

  v_normalized_name := public.normalize_stock_item_name(
    coalesce(nullif(btrim(v_item.raw_product_name), ''), v_item.product_name)
  );

  v_item_id := v_item.inventory_item_id;

  if v_item_id is null then
    select a.kitchen_inventory_item_id
      into v_item_id
      from public.stock_material_aliases a
      join public.goods_receipts gr
        on gr.supplier_id is not distinct from a.supplier_id
      left join public.suppliers s on s.id = gr.supplier_id
      join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
     where gri.id = p_receipt_item_id
       and a.kitchen_inventory_item_id is not null
       and a.location in ('tan_tao', 'q7')
       and a.location = coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao')
       and gr.status in ('confirmed', 'received')
       and coalesce(s.stock_exempt, false) = false
       and public.stock_line_auto_non_stock(
             coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
           ) is null
       and a.normalized_name = public.normalize_stock_item_name(
             coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
           )
     limit 1;
  end if;

  if v_item_id is not null then
    select kii.default_manufacturer_id
      into v_manufacturer_id
      from public.kitchen_inventory_items kii
     where kii.id = v_item_id;
  end if;

  if v_manufacturer_id is null and v_normalized_name is not null then
    select gri.manufacturer_id
      into v_manufacturer_id
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
     where gri.id <> p_receipt_item_id
       and gr.supplier_id is not distinct from (
         select gr2.supplier_id
         from public.goods_receipts gr2
         where gr2.id = v_item.goods_receipt_id
       )
       and gri.manufacturer_id is not null
       and public.normalize_stock_item_name(
             coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
           ) = v_normalized_name
     order by gr.receipt_date desc nulls last, gri.created_at desc, gri.id desc
     limit 1;
  end if;

  if v_manufacturer_id is not null then
    select fm.name
      into v_manufacturer_name
      from public.food_manufacturers fm
     where fm.id = v_manufacturer_id;
  end if;

  return jsonb_build_object(
    'manufacturer_id', v_manufacturer_id,
    'name', v_manufacturer_name
  );
end;
$$;

revoke all on function public.kho_manufacturer_suggest(uuid) from public, anon;
grant execute on function public.kho_manufacturer_suggest(uuid) to authenticated, service_role;

-- ===========================================================================
-- 7. sku_set_shelf_life — same permission gate as public.save_sku_cogs
-- ===========================================================================

create or replace function public.sku_set_shelf_life(
  p_sku_id uuid,
  p_days integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_current integer;
  v_request_sku_id uuid;
begin
  if v_actor is null or not (
    public.has_role(v_actor, 'owner')
    or public.has_role(v_actor, 'staff')
    or public.has_role(v_actor, 'warehouse')
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_days is not null and p_days not between 0 and 3650 then
    raise exception 'invalid_shelf_life_days' using errcode = '22023';
  end if;

  if not exists (select 1 from public.product_skus ps where ps.id = p_sku_id) then
    raise exception 'sku_not_found' using errcode = 'P0002';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('sku_shelf_life:' || p_request_id::text));

    select e.sku_id
      into v_request_sku_id
      from public.sku_shelf_life_edits e
     where e.request_id = p_request_id;

    if v_request_sku_id is not null then
      if v_request_sku_id <> p_sku_id then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;

      select ps.shelf_life_days
        into v_current
        from public.product_skus ps
       where ps.id = p_sku_id;

      return jsonb_build_object(
        'sku_id', p_sku_id,
        'shelf_life_days', v_current,
        'replayed', true
      );
    end if;
  end if;

  update public.product_skus
     set shelf_life_days = p_days
   where id = p_sku_id
  returning shelf_life_days into v_current;

  if p_request_id is not null then
    insert into public.sku_shelf_life_edits (
      request_id, sku_id, days, created_by
    ) values (
      p_request_id, p_sku_id, p_days, v_actor
    )
    on conflict (request_id) do nothing;
  end if;

  return jsonb_build_object(
    'sku_id', p_sku_id,
    'shelf_life_days', v_current,
    'replayed', false
  );
end;
$$;

revoke all on function public.sku_set_shelf_life(uuid, integer, uuid) from public, anon;
grant execute on function public.sku_set_shelf_life(uuid, integer, uuid) to authenticated, service_role;

-- ===========================================================================
-- 8. kho_expiry_overview
-- ===========================================================================

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
             b.inventory_item_id as item_id,
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
        left join public.kitchen_inventory_items kii on kii.id = b.inventory_item_id
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
-- 9. Receipt finalize: copy the lot fields from the line to its batch
-- ===========================================================================
-- Body copied from 20260730013000_historical_paid_goods_receipt_flow.sql, the
-- latest definition before 20260817150000 renamed it to
-- finalize_goods_receipt_stock_payable_unchecked_20260817.  The only change is
-- the four extra batch columns; stock/payable logic is untouched.

CREATE OR REPLACE FUNCTION public.finalize_goods_receipt_stock_payable_unchecked_20260817(
  p_receipt_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt public.goods_receipts%ROWTYPE;
  v_purchase_order public.purchase_orders%ROWTYPE;
  v_item public.goods_receipt_items%ROWTYPE;
  v_inventory_item_id uuid;
  v_actual_quantity numeric;
  v_ordered_quantity numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_subtotal numeric := 0;
  v_planned_subtotal numeric := 0;
  v_vat_amount numeric := 0;
  v_total_amount numeric := 0;
  v_total_quantity numeric := 0;
  v_payable_id uuid;
  v_request_number text;
  v_variance_summary jsonb := '{}'::jsonb;
  v_has_shortage boolean := false;
  v_historical_paid boolean := false;
BEGIN
  SELECT *
  INTO v_receipt
  FROM public.goods_receipts
  WHERE id = p_receipt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods receipt % not found', p_receipt_id;
  END IF;

  IF v_receipt.status = 'received' OR v_receipt.payable_status = 'generated' THEN
    RAISE EXCEPTION 'Goods receipt already finalized or already received';
  END IF;

  IF v_receipt.payable_status <> 'not_generated' THEN
    RAISE EXCEPTION 'Goods receipt payable is already in progress';
  END IF;

  IF v_receipt.purchase_order_id IS NULL AND v_receipt.payment_request_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.payment_requests pr
      WHERE pr.id = v_receipt.payment_request_id
        AND pr.supplier_id = v_receipt.supplier_id
        AND pr.status::text IN ('approved', 'completed')
        AND pr.payment_status::text = 'paid'
        AND pr.goods_receipt_id = p_receipt_id
    ) INTO v_historical_paid;
  END IF;

  UPDATE public.goods_receipts
  SET payable_status = 'generating', updated_at = now()
  WHERE id = p_receipt_id;

  IF v_receipt.purchase_order_id IS NOT NULL THEN
    SELECT *
    INTO v_purchase_order
    FROM public.purchase_orders
    WHERE id = v_receipt.purchase_order_id
    FOR UPDATE;

    IF NULLIF(COALESCE(v_receipt.image_url, v_purchase_order.image_url), '') IS NULL THEN
      RAISE EXCEPTION 'PO goods receipt requires an uploaded receipt/delivery-note image before finalizing';
    END IF;

    IF NULLIF(v_receipt.image_url, '') IS NULL AND NULLIF(v_purchase_order.image_url, '') IS NOT NULL THEN
      UPDATE public.goods_receipts
      SET image_url = v_purchase_order.image_url,
          updated_at = now()
      WHERE id = p_receipt_id;
      v_receipt.image_url := v_purchase_order.image_url;
    END IF;
  END IF;

  FOR v_item IN
    SELECT *
    FROM public.goods_receipt_items
    WHERE goods_receipt_id = p_receipt_id
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  LOOP
    v_actual_quantity := GREATEST(0, COALESCE(v_item.actual_quantity, v_item.quantity, 0));
    v_ordered_quantity := GREATEST(0, COALESCE(v_item.ordered_quantity, v_item.quantity, 0));
    v_unit_price := GREATEST(
      0,
      COALESCE(
        NULLIF(v_item.unit_price, 0),
        (
          SELECT NULLIF(poi.unit_price, 0)
          FROM public.purchase_order_items poi
          WHERE poi.id = v_item.purchase_order_item_id
        ),
        0
      )
    );
    v_line_total := v_actual_quantity * v_unit_price;

    v_planned_subtotal := v_planned_subtotal + (v_ordered_quantity * v_unit_price);

    IF NOT (v_actual_quantity > 0) THEN
      CONTINUE;
    END IF;

    v_subtotal := v_subtotal + v_line_total;
    v_total_quantity := v_total_quantity + v_actual_quantity;
    v_inventory_item_id := v_item.inventory_item_id;

    IF v_item.line_status = 'thieu' OR v_actual_quantity < v_ordered_quantity THEN
      v_has_shortage := true;
    END IF;

    IF v_inventory_item_id IS NOT NULL THEN
      UPDATE public.inventory_items
      SET quantity = quantity + ROUND(v_actual_quantity)::integer,
          updated_at = now()
      WHERE id = v_inventory_item_id;

      IF NOT FOUND THEN
        v_inventory_item_id := NULL;
      END IF;
    END IF;

    IF v_inventory_item_id IS NULL THEN
      SELECT id
      INTO v_inventory_item_id
      FROM public.inventory_items
      WHERE name ILIKE v_item.product_name
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE;

      IF v_inventory_item_id IS NOT NULL THEN
        UPDATE public.inventory_items
        SET quantity = quantity + ROUND(v_actual_quantity)::integer,
            updated_at = now()
        WHERE id = v_inventory_item_id;
      ELSE
        INSERT INTO public.inventory_items (
          name,
          quantity,
          unit,
          category,
          supplier_id,
          created_by
        ) VALUES (
          v_item.product_name,
          ROUND(v_actual_quantity)::integer,
          v_item.unit,
          'Từ phiếu nhập',
          v_receipt.supplier_id,
          p_user_id
        )
        RETURNING id INTO v_inventory_item_id;
      END IF;

      UPDATE public.goods_receipt_items
      SET inventory_item_id = v_inventory_item_id
      WHERE id = v_item.id;
    END IF;

    INSERT INTO public.inventory_batches (
      inventory_item_id,
      sku_id,
      goods_receipt_id,
      goods_receipt_item_id,
      batch_number,
      quantity,
      unit,
      received_date,
      manufacture_date,
      expiry_date,
      manufacturer_lot,
      manufacturer_id,
      notes
    ) VALUES (
      v_inventory_item_id,
      v_item.sku_id,
      p_receipt_id,
      v_item.id,
      v_receipt.receipt_number || '-' || lpad((SELECT count(*) + 1 FROM public.inventory_batches WHERE goods_receipt_id = p_receipt_id)::text, 3, '0'),
      v_actual_quantity,
      v_item.unit,
      -- Historical stock must preserve the business receipt date: received_date = receipt_date.
      COALESCE(v_receipt.receipt_date, CURRENT_DATE),
      v_item.manufacture_date,
      v_item.expiry_date,
      v_item.manufacturer_lot,
      v_item.manufacturer_id,
      NULLIF(concat_ws('; ', v_item.variance_reason, v_item.notes), '')
    );
  END LOOP;

  IF v_total_quantity <= 0 THEN
    RAISE EXCEPTION 'Cannot finalize receipt without positive actual received quantities';
  END IF;

  SELECT COALESCE(jsonb_object_agg(line_status_key, item_count), '{}'::jsonb)
  INTO v_variance_summary
  FROM (
    SELECT
      COALESCE(
        line_status,
        CASE
          WHEN COALESCE(actual_quantity, quantity, 0) < COALESCE(ordered_quantity, quantity, 0) THEN 'thieu'
          WHEN COALESCE(actual_quantity, quantity, 0) > COALESCE(ordered_quantity, quantity, 0) THEN 'du_thua'
          ELSE 'du'
        END
      ) AS line_status_key,
      count(*) AS item_count
    FROM public.goods_receipt_items
    WHERE goods_receipt_id = p_receipt_id
    GROUP BY 1
  ) status_counts;

  IF v_planned_subtotal > 0 AND COALESCE(v_purchase_order.vat_amount, 0) > 0 THEN
    v_vat_amount := ROUND((v_purchase_order.vat_amount * v_subtotal / v_planned_subtotal) * 100) / 100;
  ELSE
    v_vat_amount := 0;
  END IF;

  v_total_amount := v_subtotal + v_vat_amount;

  IF v_total_amount <= 0 THEN
    RAISE EXCEPTION 'Cannot create payable with zero amount. Add PO unit prices or receipt item prices before finalizing.';
  END IF;

  v_payable_id := NULL;

  -- A historical paid receipt must not create a new payable or reset the settled request.
  IF v_historical_paid THEN
    v_payable_id := v_receipt.payment_request_id;
  -- PO-linked receipt finalization never creates a new Duyệt chi / payment request.
  -- Correct flow: PO mua hàng -> Duyệt chi PO -> Phiếu nhập kho -> Nhập kho.
  -- The warehouse action posts inventory and reconciles against the existing PO-time request only.
  ELSIF v_receipt.purchase_order_id IS NOT NULL THEN
    IF v_receipt.payment_request_id IS NOT NULL THEN
      SELECT id
      INTO v_payable_id
      FROM public.payment_requests
      WHERE id = v_receipt.payment_request_id
        AND purchase_order_id = v_receipt.purchase_order_id
      LIMIT 1
      FOR UPDATE;
    END IF;

    IF v_payable_id IS NULL THEN
      SELECT id
      INTO v_payable_id
      FROM public.payment_requests
      WHERE purchase_order_id = v_receipt.purchase_order_id
        AND goods_receipt_id = p_receipt_id
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE;
    END IF;

    -- If historical data is missing the PO-time request link, do not create a duplicate
    -- Công nợ nhập kho row on the receipt date. The receipt is still allowed to post stock;
    -- accounting can repair/link the missing PO Duyệt chi separately with audit.
  ELSE
    -- Non-PO/manual receipts may still create or update an unpaid receipt-payable row.
    IF v_receipt.payment_request_id IS NOT NULL THEN
      SELECT id
      INTO v_payable_id
      FROM public.payment_requests
      WHERE id = v_receipt.payment_request_id
        AND public.is_receipt_payable_request(payment_requests)
      LIMIT 1
      FOR UPDATE;
    END IF;

    IF v_payable_id IS NULL THEN
      SELECT id
      INTO v_payable_id
      FROM public.payment_requests
      WHERE goods_receipt_id = p_receipt_id
        AND public.is_receipt_payable_request(payment_requests)
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE;
    END IF;

    IF v_payable_id IS NULL THEN
      v_request_number := 'PR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

      INSERT INTO public.payment_requests (
        request_number,
        supplier_id,
        purchase_order_id,
        goods_receipt_id,
        title,
        description,
        total_amount,
        vat_amount,
        status,
        delivery_status,
        payment_status,
        payment_type,
        payment_method,
        image_url,
        created_by,
        notes
      ) VALUES (
        v_request_number,
        v_receipt.supplier_id,
        NULL,
        p_receipt_id,
        'Công nợ nhập kho ' || v_receipt.receipt_number,
        'Tạo từ phiếu nhập kho ' || v_receipt.receipt_number,
        v_total_amount,
        v_vat_amount,
        'pending',
        'delivered',
        'unpaid',
        'old_order',
        'bank_transfer',
        v_receipt.image_url,
        p_user_id,
        'Tự động tạo từ phiếu nhập kho không liên kết PO. Chênh lệch: ' || v_variance_summary::text
      )
      RETURNING id INTO v_payable_id;
    ELSE
      UPDATE public.payment_requests
      SET supplier_id = v_receipt.supplier_id,
          purchase_order_id = NULL,
          goods_receipt_id = p_receipt_id,
          title = 'Công nợ nhập kho ' || v_receipt.receipt_number,
          description = 'Tạo từ phiếu nhập kho ' || v_receipt.receipt_number,
          total_amount = v_total_amount,
          vat_amount = v_vat_amount,
          status = 'pending',
          delivery_status = 'delivered',
          payment_status = 'unpaid',
          payment_type = 'old_order',
          image_url = COALESCE(v_receipt.image_url, image_url),
          updated_at = now(),
          notes = 'Tự động tạo/cập nhật từ phiếu nhập kho không liên kết PO. Chênh lệch: ' || v_variance_summary::text
      WHERE id = v_payable_id;

      DELETE FROM public.payment_request_items
      WHERE payment_request_id = v_payable_id;
    END IF;

    INSERT INTO public.payment_request_items (
      payment_request_id,
      product_name,
      quantity,
      unit,
      unit_price,
      line_total,
      inventory_item_id,
      sku_id,
      notes
    )
    SELECT
      v_payable_id,
      gri.product_name,
      GREATEST(0, COALESCE(gri.actual_quantity, gri.quantity, 0)),
      gri.unit,
      GREATEST(0, COALESCE(gri.unit_price, 0)),
      GREATEST(0, COALESCE(gri.actual_quantity, gri.quantity, 0)) * GREATEST(0, COALESCE(gri.unit_price, 0)),
      gri.inventory_item_id,
      gri.sku_id,
      NULLIF(concat_ws('; ',
        CASE WHEN gri.line_status IS NOT NULL THEN 'Tình trạng: ' || gri.line_status END,
        CASE WHEN gri.variance_reason IS NOT NULL THEN 'Lý do lệch: ' || gri.variance_reason END
      ), '')
    FROM public.goods_receipt_items gri
    WHERE gri.goods_receipt_id = p_receipt_id
      AND GREATEST(0, COALESCE(gri.actual_quantity, gri.quantity, 0)) > 0
    ORDER BY gri.created_at ASC, gri.id ASC;
  END IF;

  UPDATE public.goods_receipts
  SET status = 'received',
      payable_status = CASE WHEN v_payable_id IS NULL THEN 'not_generated' ELSE 'generated' END,
      payment_request_id = COALESCE(v_payable_id, payment_request_id),
      finalized_at = now(),
      finalized_by = p_user_id,
      variance_summary = v_variance_summary,
      total_quantity = v_total_quantity,
      updated_at = now()
  WHERE id = p_receipt_id;

  IF v_receipt.purchase_order_id IS NOT NULL THEN
    UPDATE public.purchase_orders
    SET status = CASE WHEN v_has_shortage THEN 'in_transit'::purchase_order_status ELSE 'completed'::purchase_order_status END,
        updated_at = now()
    WHERE id = v_receipt.purchase_order_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'receiptId', p_receipt_id,
    'payableId', v_payable_id,
    'totalAmount', v_total_amount,
    'vatAmount', v_vat_amount,
    'varianceSummary', v_variance_summary
  );
EXCEPTION
  WHEN OTHERS THEN
    -- Any exception aborts this RPC transaction and rolls back inventory, batch, payable, and receipt updates.
    RAISE;
END;
$$;

revoke all on function public.finalize_goods_receipt_stock_payable_unchecked_20260817(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_goods_receipt_stock_payable_unchecked_20260817(uuid, uuid) to service_role;
