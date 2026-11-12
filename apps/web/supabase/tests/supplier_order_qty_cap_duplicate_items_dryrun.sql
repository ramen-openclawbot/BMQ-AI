-- Rollback-only dry run for
-- 20261112170000_supplier_order_qty_cap_duplicate_items.sql.
--
-- Run after the migration is present in the database, as one file. Every fixture
-- row is created inside this transaction and the final rollback discards it.
--
-- It covers the 180-day history term of public.supplier_order_quote(uuid, jsonb):
--   (a) catalog item A, duplicate item B with the same normalized name, alias and
--       history only on B: a quantity equal to that history must pass. The old
--       lookup ignored B, so the cap was only 10 * pack_size_po = 100 and 900
--       was refused; the fixed lookup adds 3 * 900 = 2700.
--   (b) 20x that history (18.000) must still raise over_quantity_limit.
--   (c) an item without a duplicate keeps the old behavior: 3x history (300)
--       passes, 20x history (2.000) is refused.
--
-- The amount cap is raised inside this transaction only, so it cannot hide a
-- quantity result; the final rollback restores the real setting.

begin;

-- ---------------------------------------------------------------------------
-- 1. Fixtures.
-- ---------------------------------------------------------------------------

-- kitchen_inventory_items refuses a second active item with the same
-- normalized name. The migration-only setting is the documented bypass used by
-- the catalog migrations; it is switched off before any quote call.
select set_config('stock_catalog.unit_migration', 'on', true);

insert into public.suppliers (id, name)
values (
  '00000000-0000-0000-0000-000000000101',
  'NCC Dry Run Giới Hạn SL Trùng Tên'
);

insert into public.kitchen_inventory_items (
  id, item_code, normalized_key, item_type, name, unit, active, item_class,
  in_tan_tao, pastry_q7
) values
  (
    '00000000-0000-0000-0000-000000000102',
    'DRYRUN-QTY-OLD',
    'dryrun:qty:old',
    'ingredient',
    'Trứng gà 60gr Dry Run',
    'quả',
    true,
    'raw_material',
    true,
    false
  ),
  (
    '00000000-0000-0000-0000-000000000103',
    'DRYRUN-QTY-NEW',
    'dryrun:qty:new',
    'ingredient',
    'Trứng gà 60gr Dry Run',
    'quả',
    true,
    'raw_material',
    true,
    false
  ),
  (
    '00000000-0000-0000-0000-000000000104',
    'DRYRUN-QTY-SOLO',
    'dryrun:qty:solo',
    'ingredient',
    'Hộp giấy Dry Run Giới Hạn SL',
    'hộp',
    true,
    'raw_material',
    true,
    false
  );

select set_config('stock_catalog.unit_migration', 'off', true);

-- Catalog points at the newer duplicate (…103); the alias below points at the
-- older row (…102), exactly like the production pair.
insert into public.supplier_order_catalog_items (
  supplier_id, kitchen_inventory_item_id, product_name, po_unit, po_unit_factor,
  pack_size_po, vat_rate, list_price, list_price_includes_vat, active
) values
  (
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000103',
    'Trứng gà 60gr Dry Run',
    'quả',
    1,
    10,
    0,
    100,
    false,
    true
  ),
  (
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000104',
    'Hộp giấy Dry Run Giới Hạn SL',
    'hộp',
    1,
    10,
    0,
    100,
    false,
    true
  );

-- All aliases live on the older duplicate; the catalog item has none.
insert into public.stock_material_aliases (
  supplier_id, normalized_name, location, kitchen_inventory_item_id,
  conversion_factor, unit
) values
  (
    '00000000-0000-0000-0000-000000000101',
    public.normalize_stock_item_name('Trứng gà 60gr Dry Run'),
    'q7',
    '00000000-0000-0000-0000-000000000102',
    1,
    'quả'
  ),
  (
    '00000000-0000-0000-0000-000000000101',
    public.normalize_stock_item_name('Hộp giấy Dry Run Giới Hạn SL'),
    'q7',
    '00000000-0000-0000-0000-000000000104',
    1,
    'hộp'
  );

-- 180-day history: 900 quả for the duplicate, 100 hộp for the solo item.
insert into public.purchase_orders (
  id, po_number, supplier_id, status, order_date, total_amount
) values
  (
    '00000000-0000-0000-0000-000000000111',
    'PO-DRYRUN-QTY-DUP',
    '00000000-0000-0000-0000-000000000101',
    'sent',
    current_date,
    90000
  ),
  (
    '00000000-0000-0000-0000-000000000112',
    'PO-DRYRUN-QTY-SOLO',
    '00000000-0000-0000-0000-000000000101',
    'sent',
    current_date,
    10000
  );

insert into public.purchase_order_items (
  purchase_order_id, product_name, quantity, unit, unit_price, line_total
) values
  (
    '00000000-0000-0000-0000-000000000111',
    'Trứng gà 60gr Dry Run',
    900,
    'quả',
    100,
    90000
  ),
  (
    '00000000-0000-0000-0000-000000000112',
    'Hộp giấy Dry Run Giới Hạn SL',
    100,
    'hộp',
    100,
    10000
  );

-- Keep the order amount cap out of the way; rolled back with everything else.
insert into public.app_settings (key, value, updated_at)
values ('order_email_max_amount', '1000000000', now())
on conflict (key) do update
  set value = excluded.value,
      updated_at = excluded.updated_at;

-- ---------------------------------------------------------------------------
-- 2. Call the quote as service_role and check the three cases.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $checks$
declare
  v_supplier constant uuid := '00000000-0000-0000-0000-000000000101';
  v_old_dup constant uuid := '00000000-0000-0000-0000-000000000102';
  v_new_dup constant uuid := '00000000-0000-0000-0000-000000000103';
  v_solo constant uuid := '00000000-0000-0000-0000-000000000104';
  v_quote jsonb;
  v_error text;
  v_ok boolean;
begin
  -- Fixture sanity: the catalog is on the new row, the only alias is on the old.
  if not exists (
    select 1
    from public.supplier_order_catalog_items c
    where c.supplier_id = v_supplier
      and c.kitchen_inventory_item_id = v_new_dup
      and c.active
  ) then
    raise exception 'CHECK FAIL: duplicate catalog row is missing';
  end if;
  if not exists (
    select 1
    from public.stock_material_aliases a
    where a.kitchen_inventory_item_id = v_old_dup
      and a.supplier_id = v_supplier
      and a.normalized_name = public.normalize_stock_item_name('Trứng gà 60gr Dry Run')
  ) then
    raise exception 'CHECK FAIL: duplicate alias is not on the older item';
  end if;
  if exists (
    select 1
    from public.stock_material_aliases a
    where a.kitchen_inventory_item_id = v_new_dup
  ) then
    raise exception 'CHECK FAIL: catalog item must not own the duplicate alias';
  end if;

  -- (a) 900 = the history quantity. Old cap was 10 * 10 = 100, so this is the
  -- regression check; the fixed cap is max(100, 3 * 900) = 2700.
  v_quote := public.supplier_order_quote(
    v_supplier,
    jsonb_build_array(
      jsonb_build_object('item_id', v_new_dup, 'quantity', 900)
    )
  );
  if jsonb_array_length(coalesce(v_quote -> 'lines', '[]'::jsonb)) <> 1 then
    raise exception 'CHECK FAIL: duplicate quote returned % lines',
      jsonb_array_length(coalesce(v_quote -> 'lines', '[]'::jsonb));
  end if;
  if ((v_quote -> 'lines' -> 0 ->> 'quantity')::numeric) is distinct from 900 then
    raise exception 'CHECK FAIL: duplicate quote quantity is %',
      v_quote -> 'lines' -> 0 ->> 'quantity';
  end if;

  -- (b) 20x history must still be refused by the unchanged 3x-history cap.
  v_ok := false;
  begin
    perform public.supplier_order_quote(
      v_supplier,
      jsonb_build_array(
        jsonb_build_object('item_id', v_new_dup, 'quantity', 18000)
      )
    );
  exception when others then
    v_error := sqlerrm;
    v_ok := position('over_quantity_limit' in v_error) > 0;
    if not v_ok then
      raise exception 'CHECK FAIL: expected over_quantity_limit, got %', v_error;
    end if;
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: 20x history was accepted for the duplicate';
  end if;

  -- (c) No duplicate: the alias is on the catalog item itself, so the old
  -- behavior is unchanged (cap max(10 * 10, 3 * 100) = 300).
  v_quote := public.supplier_order_quote(
    v_supplier,
    jsonb_build_array(
      jsonb_build_object('item_id', v_solo, 'quantity', 300)
    )
  );
  if ((v_quote -> 'lines' -> 0 ->> 'quantity')::numeric) is distinct from 300 then
    raise exception 'CHECK FAIL: solo quote quantity is %',
      v_quote -> 'lines' -> 0 ->> 'quantity';
  end if;

  v_ok := false;
  begin
    perform public.supplier_order_quote(
      v_supplier,
      jsonb_build_array(
        jsonb_build_object('item_id', v_solo, 'quantity', 2000)
      )
    );
  exception when others then
    v_error := sqlerrm;
    v_ok := position('over_quantity_limit' in v_error) > 0;
    if not v_ok then
      raise exception 'CHECK FAIL: expected over_quantity_limit, got %', v_error;
    end if;
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: 20x history was accepted for the solo item';
  end if;
end;
$checks$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. One summary row, then discard every fixture.
-- ---------------------------------------------------------------------------

select 'SUMMARY'
  || ' | duplicate_history=' || (
       select max(quantity)::text
       from public.purchase_order_items
       where purchase_order_id = '00000000-0000-0000-0000-000000000111'
     )
  || ' | duplicate_900=passed'
  || ' | duplicate_18000=over_quantity_limit'
  || ' | solo_history=' || (
       select max(quantity)::text
       from public.purchase_order_items
       where purchase_order_id = '00000000-0000-0000-0000-000000000112'
     )
  || ' | solo_300=passed'
  || ' | solo_2000=over_quantity_limit'
  as summary;

rollback;
