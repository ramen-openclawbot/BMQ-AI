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
