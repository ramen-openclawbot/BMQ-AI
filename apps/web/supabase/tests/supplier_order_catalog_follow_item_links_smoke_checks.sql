-- 2026-10-30 — Rollback-only smoke checks for
-- 20261103480000_supplier_order_catalog_follow_item_links.sql.
--
-- Run against a linked/staging database with the migration inside the same
-- transaction:
--   begin;
--   \i supabase/migrations/20261103480000_supplier_order_catalog_follow_item_links.sql
--   \i supabase/tests/supplier_order_catalog_follow_item_links_smoke_checks.sql
--   rollback;
--
-- The file opens its own BEGIN and ends with ROLLBACK, so the live database
-- keeps no supplier link, catalog row, PO or item created here.
-- It assumes the migration's backfill has already produced the 12 catalog rows
-- that have no link (hand-added items, which must stay untouched).

begin;

-- The RPCs accept service_role without a JWT; set both the role and the JWT
-- claim so auth.role() also answers service_role on hosted Supabase.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

create temp table smoke_checks (
  ord integer primary key,
  check_name text not null,
  status text not null,
  detail text
);

do $$
declare
  v_supplier_1 uuid := gen_random_uuid();
  v_supplier_2 uuid := gen_random_uuid();
  v_item_active uuid := gen_random_uuid();
  v_item_inactive uuid := gen_random_uuid();
  v_item_merged uuid := gen_random_uuid();
  v_po uuid := gen_random_uuid();
  v_req_1 uuid := gen_random_uuid();
  v_req_2 uuid := gen_random_uuid();
  v_req_3 uuid := gen_random_uuid();
  v_catalog_id uuid;
  v_row public.supplier_order_catalog_items%rowtype;
  v_catalog jsonb;
  v_count integer;
  v_orphan_ids uuid[];
  v_orphan_after uuid[];
  v_ok boolean;
  v_item_name text;
  v_item_unit text;
  v_supplier_backfill uuid;
begin
  -- -------------------------------------------------------------------------
  -- Snapshot the hand-added catalog rows before touching anything.
  -- -------------------------------------------------------------------------
  select array_agg(c.id order by c.id)
    into v_orphan_ids
  from public.supplier_order_catalog_items c
  where c.active
    and not exists (
      select 1
      from public.kitchen_item_suppliers kis
      where kis.supplier_id = c.supplier_id
        and kis.item_id = c.kitchen_inventory_item_id
    );

  if coalesce(array_length(v_orphan_ids, 1), 0) <> 12 then
    raise exception 'SMOKE_RESULT FAIL orphan_catalog_before expected 12 got %',
      coalesce(array_length(v_orphan_ids, 1), 0);
  end if;

  -- -------------------------------------------------------------------------
  -- Fixtures
  -- -------------------------------------------------------------------------
  insert into public.suppliers (id, name)
  values
    (v_supplier_1, 'SMOKE NCC 1 ' || substr(v_supplier_1::text, 1, 8)),
    (v_supplier_2, 'SMOKE NCC 2 ' || substr(v_supplier_2::text, 1, 8));

  -- Latest PO for supplier 1 has VAT 7/100 = 7%, so the default rounds to 8.
  insert into public.purchase_orders (
    id, po_number, supplier_id, order_date, vat_amount
  ) values (
    v_po, 'SMOKE-PO-' || substr(v_po::text, 1, 8), v_supplier_1, current_date, 7
  );
  insert into public.purchase_order_items (
    purchase_order_id, product_name, quantity, unit, unit_price, line_total
  ) values (
    v_po, 'SMOKE PO line', 1, 'kg', 100, 100
  );

  v_item_name := 'SMOKE món active ' || substr(v_item_active::text, 1, 8);
  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit, active, item_class,
    in_tan_tao, pastry_q7
  ) values
    (v_item_active,
     'SMOKE-' || substr(v_item_active::text, 1, 8),
     'smoke:' || v_item_active::text,
     'ingredient', v_item_name, 'kg', true, 'raw_material', false, true),
    (v_item_inactive,
     'SMOKE-' || substr(v_item_inactive::text, 1, 8),
     'smoke:' || v_item_inactive::text,
     'ingredient', 'SMOKE món inactive ' || substr(v_item_inactive::text, 1, 8),
     'kg', false, 'raw_material', false, true),
    (v_item_merged,
     'SMOKE-' || substr(v_item_merged::text, 1, 8),
     'smoke:' || v_item_merged::text,
     'ingredient', 'SMOKE món merged ' || substr(v_item_merged::text, 1, 8),
     'kg', true, 'raw_material', false, true);

  update public.kitchen_inventory_items
     set merged_into_id = v_item_active,
         merged_factor = 1,
         merged_at = now()
   where id = v_item_merged;

  -- The item insert may normalize kg to the base stock unit (g), so read the
  -- stored unit back and expect the catalog to use exactly that.
  select unit into v_item_unit
  from public.kitchen_inventory_items
  where id = v_item_active;

  -- -------------------------------------------------------------------------
  -- (1) Attach a supplier through the item form RPC: the catalog row exists
  -- immediately, with kho unit / 1:1 factor / rounded VAT / kho name.
  -- -------------------------------------------------------------------------
  perform public.kho_set_item_suppliers(
    v_item_active, array[v_supplier_1], v_req_1
  );

  select * into v_row
  from public.supplier_order_catalog_items
  where supplier_id = v_supplier_1
    and kitchen_inventory_item_id = v_item_active;

  if not found then
    raise exception 'SMOKE_RESULT FAIL attach_catalog_row missing';
  end if;
  v_catalog_id := v_row.id;
  if v_row.active is not true
     or v_row.po_unit <> v_item_unit
     or v_row.po_unit_factor <> 1
     or v_row.vat_rate <> 8
     or v_row.sort_order <> 1
     or v_row.product_name is distinct from v_item_name then
    raise exception 'SMOKE_RESULT FAIL attach_defaults unit=% factor=% vat=% sort=% name=%',
      v_row.po_unit, v_row.po_unit_factor, v_row.vat_rate,
      v_row.sort_order, v_row.product_name;
  end if;

  v_catalog := public.supplier_order_catalog(v_supplier_1);
  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_catalog->'items', '[]'::jsonb)) e
    where (e->>'catalog_id')::uuid = v_catalog_id
      and (e->'item'->>'id')::uuid = v_item_active
  ) then
    raise exception 'SMOKE_RESULT FAIL attach_catalog_visible %', v_catalog;
  end if;

  insert into smoke_checks values (
    1, 'gắn NCC -> catalog trả món ngay', 'PASS',
    'row=' || v_catalog_id || '; vat=' || v_row.vat_rate
  );

  -- Cài đặt cũ để kiểm tra lần gắn lại.
  update public.supplier_order_catalog_items
     set po_unit = 'bao',
         po_unit_factor = 25,
         pack_size_po = 2,
         vat_rate = 10,
         list_price = 12345,
         list_price_includes_vat = false,
         list_price_source = 'Sửa trong trang Đặt hàng',
         list_price_updated_at = now()
   where id = v_catalog_id;

  -- -------------------------------------------------------------------------
  -- (2) Un-link (replace supplier 1 with supplier 2 through the form RPC):
  -- the catalog row is kept but switched off, and the catalog no longer
  -- returns the item.
  -- -------------------------------------------------------------------------
  perform public.kho_set_item_suppliers(
    v_item_active, array[v_supplier_2], v_req_2
  );

  select * into v_row
  from public.supplier_order_catalog_items
  where id = v_catalog_id;
  if not found then
    raise exception 'SMOKE_RESULT FAIL unlink_row_deleted';
  end if;
  if v_row.active is not false then
    raise exception 'SMOKE_RESULT FAIL unlink_row_still_active';
  end if;
  if v_row.po_unit <> 'bao'
     or v_row.po_unit_factor <> 25
     or v_row.pack_size_po <> 2
     or v_row.vat_rate <> 10
     or v_row.list_price <> 12345 then
    raise exception 'SMOKE_RESULT FAIL unlink_settings_lost unit=% vat=% price=%',
      v_row.po_unit, v_row.vat_rate, v_row.list_price;
  end if;

  v_catalog := public.supplier_order_catalog(v_supplier_1);
  if exists (
    select 1
    from jsonb_array_elements(coalesce(v_catalog->'items', '[]'::jsonb)) e
    where (e->'item'->>'id')::uuid = v_item_active
  ) then
    raise exception 'SMOKE_RESULT FAIL unlink_still_in_catalog %', v_catalog;
  end if;

  insert into smoke_checks values (
    2, 'gỡ NCC -> rút khỏi catalog, giữ cài đặt', 'PASS',
    'row=' || v_catalog_id || '; active=false'
  );

  -- -------------------------------------------------------------------------
  -- (3) Re-link in the same transaction: the old row is switched back on with
  -- its old po_unit / pack / VAT / price, and is visible again.
  -- -------------------------------------------------------------------------
  perform public.kho_set_item_suppliers(
    v_item_active, array[v_supplier_1], v_req_3
  );

  select * into v_row
  from public.supplier_order_catalog_items
  where supplier_id = v_supplier_1
    and kitchen_inventory_item_id = v_item_active;
  if not found then
    raise exception 'SMOKE_RESULT FAIL relink_row_missing';
  end if;
  if v_row.id <> v_catalog_id then
    raise exception 'SMOKE_RESULT FAIL relink_created_new_row old=% new=%',
      v_catalog_id, v_row.id;
  end if;
  if v_row.active is not true
     or v_row.po_unit <> 'bao'
     or v_row.po_unit_factor <> 25
     or v_row.pack_size_po <> 2
     or v_row.vat_rate <> 10
     or v_row.list_price <> 12345 then
    raise exception 'SMOKE_RESULT FAIL relink_settings unit=% factor=% pack=% vat=% price=%',
      v_row.po_unit, v_row.po_unit_factor, v_row.pack_size_po,
      v_row.vat_rate, v_row.list_price;
  end if;

  v_catalog := public.supplier_order_catalog(v_supplier_1);
  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_catalog->'items', '[]'::jsonb)) e
    where (e->>'catalog_id')::uuid = v_catalog_id
  ) then
    raise exception 'SMOKE_RESULT FAIL relink_not_in_catalog %', v_catalog;
  end if;

  select count(*) into v_count
  from public.supplier_order_catalog_items
  where supplier_id = v_supplier_2
    and kitchen_inventory_item_id = v_item_active
    and active;
  if v_count <> 0 then
    raise exception 'SMOKE_RESULT FAIL relink_old_supplier_still_active';
  end if;

  insert into smoke_checks values (
    3, 'gắn lại -> bật dòng cũ, giữ po_unit/VAT/giá', 'PASS',
    'row=' || v_catalog_id || '; unit=bao; vat=10; price=12345'
  );

  -- -------------------------------------------------------------------------
  -- (4) An inactive or merged item never enters the catalog.
  -- -------------------------------------------------------------------------
  insert into public.kitchen_item_suppliers (item_id, supplier_id)
  values
    (v_item_inactive, v_supplier_1),
    (v_item_merged, v_supplier_1);

  select count(*) into v_count
  from public.supplier_order_catalog_items
  where supplier_id = v_supplier_1
    and kitchen_inventory_item_id in (v_item_inactive, v_item_merged);
  if v_count <> 0 then
    raise exception 'SMOKE_RESULT FAIL retired_or_merged_cataloged %', v_count;
  end if;

  v_catalog := public.supplier_order_catalog(v_supplier_1);
  if exists (
    select 1
    from jsonb_array_elements(coalesce(v_catalog->'items', '[]'::jsonb)) e
    where (e->'item'->>'id')::uuid in (v_item_inactive, v_item_merged)
  ) then
    raise exception 'SMOKE_RESULT FAIL retired_or_merged_visible %', v_catalog;
  end if;

  insert into smoke_checks values (
    4, 'món inactive / đã gộp không vào catalog', 'PASS',
    'inactive=' || v_item_inactive || '; merged=' || v_item_merged
  );

  -- -------------------------------------------------------------------------
  -- (5) After backfill no live link is missing an active catalog row, and the
  -- three named pairs are present.
  -- -------------------------------------------------------------------------
  select count(*) into v_count
  from public.kitchen_item_suppliers kis
  join public.kitchen_inventory_items kii on kii.id = kis.item_id
  where kii.active is true
    and kii.merged_into_id is null
    and not exists (
      select 1
      from public.supplier_order_catalog_items c
      where c.supplier_id = kis.supplier_id
        and c.kitchen_inventory_item_id = kis.item_id
        and c.active
    );
  if v_count <> 0 then
    raise exception 'SMOKE_RESULT FAIL backfill_missing % links', v_count;
  end if;

  select count(*) into v_count
  from public.kitchen_item_suppliers kis
  join public.kitchen_inventory_items kii on kii.id = kis.item_id
  join public.suppliers s on s.id = kis.supplier_id
  where btrim(s.name) = 'Bao bì Minh Tuấn'
    and btrim(kii.name) in ('Bao giấy Ông Bầu', 'Tăm VJ', 'Bánh mì lớn')
    and exists (
      select 1
      from public.supplier_order_catalog_items c
      where c.supplier_id = kis.supplier_id
        and c.kitchen_inventory_item_id = kis.item_id
        and c.active
    );
  if v_count <> 3 then
    raise exception 'SMOKE_RESULT FAIL backfill_named_pairs expected 3 got %', v_count;
  end if;

  -- The same three pairs must already be visible through the order-page RPC.
  select s.id into v_supplier_backfill
  from public.suppliers s
  where btrim(s.name) = 'Bao bì Minh Tuấn'
  order by s.id
  limit 1;
  if v_supplier_backfill is null then
    raise exception 'SMOKE_RESULT FAIL backfill_supplier_missing';
  end if;

  v_catalog := public.supplier_order_catalog(v_supplier_backfill);
  select count(*) into v_count
  from jsonb_array_elements(coalesce(v_catalog->'items', '[]'::jsonb)) e
  where e->'item'->>'name' in ('Bao giấy Ông Bầu', 'Tăm VJ', 'Bánh mì lớn');
  if v_count <> 3 then
    raise exception 'SMOKE_RESULT FAIL backfill_named_pairs_not_visible got %', v_catalog;
  end if;

  insert into smoke_checks values (
    5, 'backfill: 0 liên kết thiếu; 3 cặp Bao bì Minh Tuấn có catalog', 'PASS',
    'Bao giấy Ông Bầu / Tăm VJ / Bánh mì lớn'
  );

  -- -------------------------------------------------------------------------
  -- (6) The 12 hand-added catalog rows stay untouched and active.
  -- -------------------------------------------------------------------------
  select array_agg(c.id order by c.id)
    into v_orphan_after
  from public.supplier_order_catalog_items c
  where c.active
    and not exists (
      select 1
      from public.kitchen_item_suppliers kis
      where kis.supplier_id = c.supplier_id
        and kis.item_id = c.kitchen_inventory_item_id
    );

  if v_orphan_after is distinct from v_orphan_ids then
    raise exception 'SMOKE_RESULT FAIL orphan_catalog_changed before=% after=%',
      v_orphan_ids, v_orphan_after;
  end if;

  insert into smoke_checks values (
    6, '12 dòng catalog thêm tay giữ nguyên + active', 'PASS',
    'ids=' || array_length(v_orphan_after, 1)
  );

  -- -------------------------------------------------------------------------
  -- (7) The internal sync helper is not executable by anon/authenticated.
  -- -------------------------------------------------------------------------
  if has_function_privilege(
       'anon', 'public.supplier_order_catalog_sync_link(uuid, uuid)', 'execute'
     )
     or has_function_privilege(
       'authenticated',
       'public.supplier_order_catalog_sync_link(uuid, uuid)', 'execute'
     ) then
    raise exception 'SMOKE_RESULT FAIL internal_function_granted';
  end if;

  perform set_config('role', 'authenticated', true);
  v_ok := false;
  begin
    perform public.supplier_order_catalog_sync_link(
      v_supplier_1, v_item_active
    );
  exception when insufficient_privilege then
    v_ok := true;
  end;
  perform set_config('role', 'postgres', true);
  if not v_ok then
    raise exception 'SMOKE_RESULT FAIL authenticated_executed_internal_function';
  end if;

  insert into smoke_checks values (
    7, 'anon/authenticated không execute hàm nội bộ', 'PASS',
    '42501 permission denied'
  );

  raise notice 'SMOKE_RESULT PASS supplier_order_catalog_follow_item_links';
end $$;

select ord, check_name, status, detail
from smoke_checks
order by ord;

rollback;
