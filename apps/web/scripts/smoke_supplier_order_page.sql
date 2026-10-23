-- Rollback-only smoke for the supplier order page backend.
--
-- Load 20261102910000_supplier_order_page.sql and
-- 20261102920000_supplier_order_vat.sql first, then this file, in one
-- transaction. Never run this outside the surrounding transaction.
--
-- The read RPCs run as the owner under `set local role authenticated`; the
-- write RPCs run as service_role. Everything rolls back.

begin;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '27dbc34e-75ee-4973-8f9a-d1b125c90483',
  true
);
set local role authenticated;

do $read$
declare
  v_phuc constant uuid := 'bc39ded3-755c-4b31-9e4c-d7729e009608';
  v_tvfood constant uuid := '9546bd80-18d7-4ec7-b0e5-de50798ea718';
  v_mi999 constant uuid := '1039f461-8f9f-45a1-b05c-b96cb736812e';
  v_mi888 constant uuid := '64952d75-2351-43f8-886f-de5282c96ed2';
  v_bo constant uuid := '3c16ed3f-54c7-427f-a316-5aa4fcadda5a';
  v_suppliers jsonb;
  v_catalog jsonb;
  v_candidates jsonb;
  v_set jsonb;
  v_count integer;
  v_price numeric;
  v_vat numeric;
begin
  if not public.has_role(
    '27dbc34e-75ee-4973-8f9a-d1b125c90483'::uuid, 'owner'
  ) then
    raise exception 'smoke owner 27dbc34e-75ee-4973-8f9a-d1b125c90483 is missing';
  end if;

  ------------------------------------------------------------------
  -- supplier list: Phúc Thịnh 3 items, TV Food 1 item
  ------------------------------------------------------------------
  v_suppliers := public.supplier_order_suppliers();
  if jsonb_typeof(v_suppliers) <> 'array' then
    raise exception 'supplier_order_suppliers must return an array: %', v_suppliers;
  end if;

  select (e.value ->> 'item_count')::integer
  into v_count
  from jsonb_array_elements(v_suppliers) e
  where e.value ->> 'id' = v_phuc::text;

  if v_count is distinct from 3 then
    raise exception 'Phúc Thịnh must list 3 catalog items, got %', v_count;
  end if;

  select (e.value ->> 'item_count')::integer
  into v_count
  from jsonb_array_elements(v_suppliers) e
  where e.value ->> 'id' = v_tvfood::text;

  if v_count is distinct from 1 then
    raise exception 'TV Food must list 1 catalog item, got %', v_count;
  end if;

  if not exists (
    select 1 from jsonb_array_elements(v_suppliers) e
    where e.value ->> 'id' = v_phuc::text
      and e.value ->> 'name' = 'Phúc Thịnh'
  ) then
    raise exception 'Phúc Thịnh is missing from the supplier list: %', v_suppliers;
  end if;

  ------------------------------------------------------------------
  -- catalog prices per supplier unit + VAT rates
  ------------------------------------------------------------------
  v_catalog := public.supplier_order_catalog(v_phuc);
  if v_catalog -> 'supplier' ->> 'id' <> v_phuc::text then
    raise exception 'catalog supplier mismatch: %', v_catalog -> 'supplier';
  end if;

  select (e.value ->> 'unit_price')::numeric
  into v_price
  from jsonb_array_elements(v_catalog -> 'items') e
  where e.value -> 'item' ->> 'id' = v_mi999::text;

  if v_price is distinct from 19300 then
    raise exception 'Bột mì 999 price must be 19300/kg, got %', v_price;
  end if;

  select (e.value ->> 'unit_price')::numeric
  into v_price
  from jsonb_array_elements(v_catalog -> 'items') e
  where e.value -> 'item' ->> 'id' = v_mi888::text;

  if v_price is distinct from 18900 then
    raise exception 'Bột mì 888 price must be 18900/kg, got %', v_price;
  end if;

  select (e.value ->> 'vat_rate')::numeric
  into v_vat
  from jsonb_array_elements(v_catalog -> 'items') e
  where e.value -> 'item' ->> 'id' = v_mi999::text;

  if v_vat is distinct from 8 then
    raise exception 'Phúc Thịnh catalog VAT must be 8, got %', v_vat;
  end if;

  v_catalog := public.supplier_order_catalog(v_tvfood);
  select (e.value ->> 'unit_price')::numeric
  into v_price
  from jsonb_array_elements(v_catalog -> 'items') e
  where e.value -> 'item' ->> 'id' = v_bo::text;

  if v_price is distinct from 90000 then
    raise exception 'Bơ Peerless price must be 90000/kg, got %', v_price;
  end if;

  select (e.value ->> 'vat_rate')::numeric
  into v_vat
  from jsonb_array_elements(v_catalog -> 'items') e
  where e.value -> 'item' ->> 'id' = v_bo::text;

  if v_vat is distinct from 0 then
    raise exception 'TV Food catalog VAT must be 0, got %', v_vat;
  end if;

  ------------------------------------------------------------------
  -- candidates + catalog add/remove
  ------------------------------------------------------------------
  v_candidates := public.supplier_order_catalog_candidates(v_phuc);
  if jsonb_typeof(v_candidates) <> 'array' then
    raise exception 'candidates must return an array: %', v_candidates;
  end if;

  v_set := public.supplier_order_catalog_set(
    v_phuc, v_mi999, true, 'kg', 25, null
  );
  if v_set is null or (v_set ->> 'active')::boolean is not true then
    raise exception 'catalog set add failed: %', v_set;
  end if;

  v_set := public.supplier_order_catalog_set(v_phuc, v_mi999, false);
  if v_set is null or (v_set ->> 'active')::boolean is not false then
    raise exception 'catalog set remove failed: %', v_set;
  end if;

  v_set := public.supplier_order_catalog_set(
    v_phuc, v_mi999, true, 'kg', 25, null
  );
  if v_set is null or (v_set ->> 'active')::boolean is not true then
    raise exception 'catalog set reactivate failed: %', v_set;
  end if;

  raise notice 'supplier order page read smoke passed';
end;
$read$;

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claim.sub',
  '27dbc34e-75ee-4973-8f9a-d1b125c90483',
  true
);
set local role service_role;

do $write$
declare
  v_actor constant uuid := '27dbc34e-75ee-4973-8f9a-d1b125c90483';
  v_phuc constant uuid := 'bc39ded3-755c-4b31-9e4c-d7729e009608';
  v_mi999 constant uuid := '1039f461-8f9f-45a1-b05c-b96cb736812e';
  v_mi888 constant uuid := '64952d75-2351-43f8-886f-de5282c96ed2';
  v_new_item uuid := gen_random_uuid();
  v_request_id uuid;
  v_create jsonb;
  v_replay jsonb;
  v_set jsonb;
  v_po_id uuid;
  v_history jsonb;
  v_item_history jsonb;
  v_count integer;
  v_subtotal numeric;
  v_vat_amount numeric;
  v_total numeric;
begin
  v_request_id := gen_random_uuid();
  v_create := public.create_supplier_order_multi(
    v_request_id,
    v_phuc,
    jsonb_build_array(
      jsonb_build_object('item_id', v_mi999, 'quantity', 25),
      jsonb_build_object('item_id', v_mi888, 'quantity', 25)
    ),
    'Smoke đặt hàng nhiều món',
    v_actor
  );

  if v_create ->> 'status' <> 'preparing' then
    raise exception 'multi create status mismatch: %', v_create;
  end if;

  v_po_id := (v_create ->> 'purchase_order_id')::uuid;
  v_subtotal := (v_create ->> 'subtotal')::numeric;
  v_vat_amount := (v_create ->> 'vat_amount')::numeric;
  v_total := (v_create ->> 'total')::numeric;

  if v_subtotal is distinct from 955000 then
    raise exception 'multi create subtotal must be 955000, got %', v_subtotal;
  end if;
  if v_vat_amount is distinct from 76400 then
    raise exception 'multi create VAT must be 76400, got %', v_vat_amount;
  end if;
  if v_total is distinct from 1031400 then
    raise exception 'multi create total must be 1031400, got %', v_total;
  end if;

  if not exists (
    select 1
    from public.purchase_orders
    where id = v_po_id
      and vat_amount = 76400
      and total_amount = 1031400
  ) then
    raise exception 'PO row must store vat_amount 76400 and total_amount 1031400';
  end if;

  select count(*) into v_count
  from public.purchase_orders
  where id = v_po_id;
  if v_count <> 1 then
    raise exception 'expected exactly one PO, got %', v_count;
  end if;

  select count(*) into v_count
  from public.purchase_order_items
  where purchase_order_id = v_po_id;
  if v_count <> 2 then
    raise exception 'expected two PO lines, got %', v_count;
  end if;

  select count(*) into v_count
  from public.supplier_order_request_lines
  where request_id = (
    select id from public.supplier_order_requests where request_id = v_request_id
  );
  if v_count <> 2 then
    raise exception 'expected two request lines, got %', v_count;
  end if;

  if not exists (
    select 1
    from public.supplier_order_requests
    where request_id = v_request_id
      and kitchen_inventory_item_id is null
      and quantity is null
      and line_total = 955000
      and subtotal_amount = 955000
      and vat_amount = 76400
      and total_amount = 1031400
  ) then
    raise exception 'multi request row is missing its nullable item fields, VAT or total';
  end if;

  if not exists (
    select 1
    from public.supplier_order_request_lines l
    join public.supplier_order_requests r on r.id = l.request_id
    where r.request_id = v_request_id
      and l.vat_rate = 8
      and l.vat_amount > 0
  ) then
    raise exception 'request lines must carry the 8%% VAT rate and amount';
  end if;

  v_replay := public.create_supplier_order_multi(
    v_request_id,
    v_phuc,
    jsonb_build_array(
      jsonb_build_object('item_id', v_mi999, 'quantity', 25),
      jsonb_build_object('item_id', v_mi888, 'quantity', 25)
    ),
    'Smoke đặt hàng nhiều món',
    v_actor
  );

  if v_replay ->> 'replayed' <> 'true' then
    raise exception 'replay must return replayed true: %', v_replay;
  end if;
  if (v_replay ->> 'purchase_order_id')::uuid <> v_po_id then
    raise exception 'replay created a different PO: %', v_replay;
  end if;
  if (v_replay ->> 'subtotal')::numeric is distinct from 955000
     or (v_replay ->> 'vat_amount')::numeric is distinct from 76400
     or (v_replay ->> 'total')::numeric is distinct from 1031400 then
    raise exception 'replay must return subtotal / VAT / total: %', v_replay;
  end if;

  -- A new Phúc Thịnh item with a null vat_rate defaults to 8 from the newest
  -- PO (the one created above).
  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit
  ) values (
    v_new_item,
    'SMOKE-' || upper(substr(replace(v_new_item::text, '-', ''), 1, 12)),
    'smoke-vat-' || v_new_item::text,
    'ingredient',
    'Smoke VAT default ' || substr(v_new_item::text, 1, 8),
    'kg'
  );

  v_set := public.supplier_order_catalog_set(
    v_phuc, v_new_item, true, 'kg', null, null, null
  );
  if v_set is null or (v_set ->> 'vat_rate')::numeric is distinct from 8 then
    raise exception 'catalog set must default the new item VAT to 8: %', v_set;
  end if;

  -- over-limit quantity is refused
  begin
    perform public.create_supplier_order_multi(
      gen_random_uuid(),
      v_phuc,
      jsonb_build_array(
        jsonb_build_object('item_id', v_mi999, 'quantity', 100000)
      ),
      'Smoke over limit',
      v_actor
    );
    raise exception 'over-limit quantity was accepted';
  exception when others then
    if sqlerrm not like '%over_quantity_limit%' then
      raise;
    end if;
  end;

  -- history by supplier and by item both show the multi-line request
  v_history := public.supplier_order_history_by_supplier(v_phuc);
  if not exists (
    select 1 from jsonb_array_elements(v_history -> 'items') e
    where e.value ->> 'request_id' = v_request_id::text
      and (e.value ->> 'subtotal')::numeric = 955000
      and (e.value ->> 'vat_amount')::numeric = 76400
      and exists (
        select 1
        from jsonb_array_elements(e.value -> 'lines') l
        where (l ->> 'vat_rate')::numeric = 8
      )
  ) then
    raise exception 'supplier history is missing the VAT fields: %', v_history;
  end if;

  v_item_history := public.supplier_order_history(v_mi999);
  if not exists (
    select 1 from jsonb_array_elements(v_item_history -> 'items') e
    where e.value ->> 'request_id' = v_request_id::text
      and (e.value ->> 'quantity')::numeric = 25
      and e.value ->> 'unit' = 'kg'
  ) then
    raise exception 'item history is missing the multi-line quantity/unit: %', v_item_history;
  end if;

  raise notice 'supplier order page write smoke passed';
end;
$write$;

rollback;
