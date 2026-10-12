-- Rollback-only production smoke for migration
-- 20261031110000_po_scan_price_check.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_po_scan_price_check.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_po_scan_price_check.sql).
--
-- The file opens one transaction, impersonates an owner from public.user_roles
-- through request.jwt.claims, applies the migration SQL inline, asserts the
-- supplier of PO-000744 returns one of the real historical prices for
-- 'Giấy gói thảm đầu tròn 14x18cm (40/50gsm)', that an unknown name returns no
-- row, and that a random authenticated user without permission is refused with
-- 42501 / insufficient_privilege. The final RAISE aborts the transaction, so
-- the function and every change roll back.
begin;

-- (0) The owner is taken from public.user_roles and impersonated through
-- request.jwt.claims.
do $ownercheck$
declare
  v_owner uuid;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;
end;
$ownercheck$;

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (
      select ur.user_id
      from public.user_roles ur
      where ur.role::text = 'owner'
      order by ur.created_at, ur.user_id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  true
);

-- (1) Apply the migration SQL inline, byte-for-byte.
-- Cảnh báo PO quét ảnh lệch giá/đơn vị so với lần mua trước (phần dữ liệu).
--
-- Additive, read-only RPC. It returns the most recent previous purchase line of
-- one supplier (up to 5 per scanned product name), so the client can compare a scan
-- against what was actually bought before. It never writes.
--
-- Normalization reuses public.normalize_stock_item_name (latest definition in
-- 20261013100000_stock_ledger_flow.sql), the same function the stock ledger and
-- receipt flows use. The purchase_order_status enum has exactly five values
-- (draft, sent, in_transit, completed, cancelled); only 'cancelled' is a
-- cancelled/rejected-like line that must be ignored.
--
-- The gate mirrors the material-master read helpers: service_role, owner, or a
-- user holding purchase_orders view/edit. Everything else raises 42501.

create or replace function public.get_supplier_last_line_prices(
  p_supplier_id uuid,
  p_names text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_names text[];
  v_result jsonb;
begin
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'purchase_orders', 'view')
    or public.has_module_permission(v_actor, 'purchase_orders', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_id required' using errcode = '22023';
  end if;
  if coalesce(array_length(p_names, 1), 0) > 60 then
    raise exception 'too_many_names' using errcode = '22023';
  end if;

  v_names := array(
    select distinct btrim(n)
    from unnest(coalesce(p_names, array[]::text[])) as n
    where n is not null and btrim(n) <> ''
  );

  if coalesce(array_length(v_names, 1), 0) = 0 then
    return '[]'::jsonb;
  end if;

  with inputs as (
    select
      n.input_name,
      public.normalize_stock_item_name(n.input_name) as normalized_name
    from unnest(v_names) as n(input_name)
    where public.normalize_stock_item_name(n.input_name) is not null
  ),
  ranked as (
    select
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name)
      ) as normalized_name,
      coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name) as product_name,
      poi.unit,
      poi.quantity,
      poi.unit_price,
      po.po_number,
      po.created_at,
      poi.id as item_id
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    where po.supplier_id = p_supplier_id
      and po.status is distinct from 'cancelled'::public.purchase_order_status
      and poi.unit_price > 0
      and poi.quantity > 0
  ),
  last_lines as (
    -- Up to the 5 most recent lines per name: one misread PO in the history
    -- (owner 12/10: PO-000775 stored 185 gói × 5.000đ) must not become the only
    -- reference for the next scan.
    select r.*, row_number() over (partition by r.normalized_name order by r.created_at desc, r.item_id desc) as rn
    from ranked r
    where r.normalized_name = any (select i.normalized_name from inputs i)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'input_name', i.input_name,
        'normalized_name', i.normalized_name,
        'product_name', l.product_name,
        'unit', l.unit,
        'quantity', l.quantity,
        'unit_price', l.unit_price,
        'po_number', l.po_number,
        'created_at', l.created_at
      )
      order by i.input_name, l.rn
    ),
    '[]'::jsonb
  )
  into v_result
  from inputs i
  join last_lines l on l.normalized_name = i.normalized_name and l.rn <= 5;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.get_supplier_last_line_prices(uuid, text[]) from public, anon;
grant execute on function public.get_supplier_last_line_prices(uuid, text[]) to authenticated, service_role;

-- (2) Owner assertions: PO-000744 history present and one real historical price.
do $smoke$
declare
  v_name text := 'Giấy gói thảm đầu tròn 14x18cm (40/50gsm)';
  v_supplier_id uuid;
  v_result jsonb;
  v_unknown jsonb;
  v_price numeric;
  v_prices numeric[];
  v_found boolean;
begin
  -- The supplier is looked up by po_number, never hard-coded.
  select po.supplier_id into v_supplier_id
  from public.purchase_orders po
  where po.po_number = 'PO-000744'
  order by po.created_at desc, po.id desc
  limit 1;
  if v_supplier_id is null then
    raise exception 'SMOKE_RESULT FAIL po_000744_supplier_missing';
  end if;

  -- Every real historical price of that supplier line, using the same rules
  -- as the RPC (cancelled excluded, positive quantity/unit_price, normalized
  -- coalesce(raw_product_name, product_name)).
  select array_agg(distinct poi.unit_price) into v_prices
  from public.purchase_order_items poi
  join public.purchase_orders po on po.id = poi.purchase_order_id
  where po.supplier_id = v_supplier_id
    and po.status is distinct from 'cancelled'::public.purchase_order_status
    and poi.unit_price > 0
    and poi.quantity > 0
    and public.normalize_stock_item_name(
          coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name)
        ) = public.normalize_stock_item_name(v_name);
  if coalesce(array_length(v_prices, 1), 0) = 0 then
    raise exception 'SMOKE_RESULT FAIL no_historical_prices';
  end if;

  v_result := public.get_supplier_last_line_prices(v_supplier_id, array[v_name]);
  if v_result is null
     or jsonb_typeof(v_result) <> 'array'
     or jsonb_array_length(v_result) = 0 then
    raise exception 'SMOKE_RESULT FAIL empty_result';
  end if;

  v_price := nullif(v_result -> 0 ->> 'unit_price', '')::numeric;
  if v_price is null then
    raise exception 'SMOKE_RESULT FAIL missing_unit_price';
  end if;
  select exists (select 1 from unnest(v_prices) p where p = v_price) into v_found;
  if not v_found then
    raise exception 'SMOKE_RESULT FAIL price_not_historical price=% prices=%',
      v_price, v_prices;
  end if;

  -- An unknown name is omitted from the result.
  v_unknown := public.get_supplier_last_line_prices(
    v_supplier_id,
    array['Tên hàng không tồn tại ' || gen_random_uuid()::text]
  );
  if coalesce(jsonb_array_length(v_unknown), 0) <> 0 then
    raise exception 'SMOKE_RESULT FAIL unknown_name_returned_rows';
  end if;
end;
$smoke$;

-- (3) A random authenticated user without purchase_orders permission is refused.
do $forbidden$
declare
  v_sqlstate text;
  v_message text;
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text,
    true
  );
  begin
    perform public.get_supplier_last_line_prices(gen_random_uuid(), array['x']);
  exception when others then
    v_sqlstate := sqlstate;
    v_message := sqlerrm;
  end;
  if v_sqlstate is distinct from '42501'
     or v_message is distinct from 'insufficient_privilege' then
    raise exception 'SMOKE_RESULT FAIL forbidden sqlstate=% message=%',
      v_sqlstate, v_message;
  end if;

  raise exception 'SMOKE_RESULT PASS: po scan price check';
end;
$forbidden$;
