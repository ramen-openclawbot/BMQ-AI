-- Lưu giá NCC báo lỗi "Chưa lưu được giá" (anh Tâm 31/10, Bao giấy Ông Bầu).
-- supplier_order_catalog_set chỉ quy đổi đơn vị cân/thể tích, nên mọi món tính
-- theo cái/gói/cuộn... (59 dòng đang hoạt động) báo unit_not_convertible khi lưu
-- giá. Cùng đơn vị thì hệ số 1; dòng đã có giữ hệ số hiện tại.

CREATE OR REPLACE FUNCTION public.supplier_order_catalog_set(p_supplier_id uuid, p_item_id uuid, p_active boolean, p_po_unit text DEFAULT 'kg'::text, p_pack_size_po numeric DEFAULT NULL::numeric, p_product_name text DEFAULT NULL::text, p_vat_rate numeric DEFAULT NULL::numeric, p_list_price numeric DEFAULT NULL::numeric, p_list_price_includes_vat boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_item_unit text;
  v_factor numeric;
  v_default_rate numeric;
  v_row public.supplier_order_catalog_items%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'supplier_orders', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_supplier_id is null or p_item_id is null then
    raise exception 'invalid_catalog_item' using errcode = '22023';
  end if;

  if p_vat_rate is not null
     and (p_vat_rate < 0 or p_vat_rate > 100) then
    raise exception 'invalid_vat_rate' using errcode = '22023';
  end if;

  if p_list_price is not null
     and (
       p_list_price < 0
       or p_list_price::text in ('NaN', 'Infinity', '-Infinity')
     ) then
    raise exception 'invalid_list_price' using errcode = '22023';
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

  -- Count units (cái, gói, cuộn...) have no weight/volume conversion: the same
  -- unit is 1:1, and an existing row keeps the factor it already has, so a
  -- price edit never fails on its unit.
  v_factor := coalesce(
    case when public.stock_unit_code(p_po_unit) = public.stock_unit_code(v_item_unit) then 1 end,
    public.stock_unit_line_factor(p_po_unit, v_item_unit),
    (select c.po_unit_factor
       from public.supplier_order_catalog_items c
      where c.supplier_id = p_supplier_id
        and c.kitchen_inventory_item_id = p_item_id
        and public.stock_unit_code(c.po_unit) = public.stock_unit_code(p_po_unit)
        and c.po_unit_factor > 0)
  );
  if v_factor is null or v_factor <= 0 then
    raise exception 'unit_not_convertible' using errcode = '22023';
  end if;

  if p_pack_size_po is not null
     and (p_pack_size_po <= 0
          or p_pack_size_po::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_pack_size' using errcode = '22023';
  end if;

  if p_vat_rate is null then
    select coalesce(
      (
        select v.c
        from (values (0::numeric), (5::numeric), (8::numeric), (10::numeric)) v(c)
        order by abs(v.c - t.vat_ratio) asc, v.c asc
        limit 1
      ),
      0
    )
    into v_default_rate
    from (
      select case
        when sum(poi.line_total) > 0
          then po.vat_amount / sum(poi.line_total) * 100
        else 0
      end as vat_ratio
      from public.purchase_orders po
      join public.purchase_order_items poi on poi.purchase_order_id = po.id
      where po.supplier_id = p_supplier_id
      group by po.id, po.vat_amount, po.order_date
      having sum(poi.line_total) > 0
      order by po.order_date desc, po.id desc
      limit 1
    ) t;

    v_default_rate := coalesce(v_default_rate, 0);
  end if;

  -- A newly added item goes to the end of the supplier's list; a re-added
  -- item keeps its old place (sort_order is not updated on conflict).
  insert into public.supplier_order_catalog_items (
    supplier_id, kitchen_inventory_item_id, product_name, po_unit,
    po_unit_factor, pack_size_po, vat_rate, sort_order, active, created_by,
    list_price, list_price_includes_vat, list_price_source,
    list_price_updated_at, list_price_updated_by
  ) values (
    p_supplier_id, p_item_id,
    nullif(btrim(coalesce(p_product_name, '')), ''),
    p_po_unit, v_factor, p_pack_size_po,
    coalesce(p_vat_rate, v_default_rate, 0),
    coalesce((
      select max(c.sort_order) + 1
      from public.supplier_order_catalog_items c
      where c.supplier_id = p_supplier_id
    ), 1),
    true, v_actor,
    case when p_list_price > 0 then p_list_price else null end,
    coalesce(p_list_price_includes_vat, false),
    case
      when p_list_price > 0 then 'Sửa trong trang Đặt hàng'
      else null
    end,
    case when p_list_price > 0 then now() else null end,
    case when p_list_price > 0 then v_actor else null end
  )
  on conflict (supplier_id, kitchen_inventory_item_id) do update
  set product_name = excluded.product_name,
      po_unit = excluded.po_unit,
      po_unit_factor = excluded.po_unit_factor,
      pack_size_po = excluded.pack_size_po,
      vat_rate = case
        when p_vat_rate is null then supplier_order_catalog_items.vat_rate
        else excluded.vat_rate
      end,
      list_price = case
        when p_list_price is null then supplier_order_catalog_items.list_price
        when p_list_price = 0 then null
        else p_list_price
      end,
      list_price_includes_vat = coalesce(
        p_list_price_includes_vat,
        supplier_order_catalog_items.list_price_includes_vat
      ),
      list_price_source = case
        when p_list_price is null then supplier_order_catalog_items.list_price_source
        when p_list_price = 0 then null
        else 'Sửa trong trang Đặt hàng'
      end,
      list_price_updated_at = case
        when p_list_price is null then supplier_order_catalog_items.list_price_updated_at
        when p_list_price = 0 then null
        else now()
      end,
      list_price_updated_by = case
        when p_list_price is null then supplier_order_catalog_items.list_price_updated_by
        when p_list_price = 0 then null
        else v_actor
      end,
      active = true,
      updated_at = now()
  returning * into v_row;

  return to_jsonb(v_row);
end;
$function$;
