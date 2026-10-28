-- Đặt hàng: the per-line quantity guard refused every quantity for items with no Q7
-- forecast and no bag size (owner 28/10: Giấy decal PVC, Nam Nguyễn, "Số lượng một món quá
-- lớn so với mức dùng" at 15 cuộn). The cap now also allows 3x the largest quantity bought
-- from this supplier in 180 days (same order unit) and 3x the Tân Tạo learned order size.
-- With no basis at all there is no per-line cap. The amount cap (order_email_max_amount,
-- default 30.000.000 đ) is unchanged.
--
-- supplier_order_line_price: lines in the catalog's own order unit now win, converted with
-- the catalog factor. Mixed units made the median pick a wrong line (Hasu chà bông: PO lines
-- in "con" with alias factor 1 gave 145.000 đ/g, shown as 145.000.000 đ/kg).

create or replace function public.supplier_order_quote(
  p_supplier_id uuid,
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
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_role_before text;
  v_supplier public.suppliers%rowtype;
  v_forecast jsonb;
  v_max_amount numeric := 30000000;
  v_max_text text;
  v_line_count integer;
  v_distinct_count integer;
  v_line record;
  v_item_id uuid;
  v_quantity numeric;
  v_catalog record;
  v_fc jsonb;
  v_suggested numeric;
  v_proposal numeric;
  v_max_qty numeric;
  v_hist_qty numeric;
  v_learned_qty numeric;
  v_history_price numeric;
  v_unit_price numeric;
  v_product_name text;
  v_list_price numeric;
  v_list_price_includes_vat boolean;
  v_vat_rate numeric;
  v_line_total numeric;
  v_line_vat numeric;
  v_line_vat_raw numeric;
  v_gross_amount numeric;
  v_gross_vat numeric := 0;
  v_net_vat_raw numeric := 0;
  v_subtotal numeric := 0;
  v_vat_amount numeric := 0;
  v_total numeric := 0;
  v_lines jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'supplier_orders', 'view')
      or public.has_module_permission(v_actor, 'supplier_orders', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

  select * into v_supplier
  from public.suppliers
  where id = p_supplier_id;
  if not found then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;

  v_line_count := jsonb_array_length(p_lines);
  if v_line_count < 1 or v_line_count > 20 then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where jsonb_typeof(e) <> 'object'
  ) then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where not (e ? 'item_id')
       or not (e ? 'quantity')
       or coalesce(e ->> 'item_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'invalid_item_id' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where jsonb_typeof(e -> 'quantity') <> 'number'
  ) then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) e
    where (e ->> 'quantity')::numeric <= 0
       or (e ->> 'quantity')::numeric::text in ('NaN', 'Infinity', '-Infinity')
  ) then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;

  select count(distinct (e ->> 'item_id'))
  into v_distinct_count
  from jsonb_array_elements(p_lines) e;
  if v_distinct_count <> v_line_count then
    raise exception 'duplicate_items' using errcode = '22023';
  end if;

  v_role_before := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_forecast := public.get_q7_purchase_forecast(v_today, 14);
  perform set_config('request.jwt.claim.role', coalesce(v_role_before, ''), true);

  select value into v_max_text
  from public.app_settings
  where key = 'order_email_max_amount';
  if nullif(btrim(coalesce(v_max_text, '')), '') is not null then
    v_max_amount := v_max_text::numeric;
  end if;
  if v_max_amount is null or v_max_amount <= 0 then
    v_max_amount := 30000000;
  end if;

  for v_line in
    select value as line, ordinality::integer as position
    from jsonb_array_elements(p_lines) with ordinality
  loop
    v_item_id := (v_line.line ->> 'item_id')::uuid;
    v_quantity := (v_line.line ->> 'quantity')::numeric;

    select c.id as catalog_id, c.product_name, c.po_unit, c.po_unit_factor,
           c.pack_size_po, c.vat_rate, c.list_price,
           c.list_price_includes_vat,
           kii.name as item_name
    into v_catalog
    from public.supplier_order_catalog_items c
    join public.kitchen_inventory_items kii
      on kii.id = c.kitchen_inventory_item_id
    where c.supplier_id = p_supplier_id
      and c.kitchen_inventory_item_id = v_item_id
      and c.active;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;

    select e.value into v_fc
    from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
    where e.value ->> 'item_id' = v_item_id::text
    limit 1;

    v_suggested := coalesce(nullif(v_fc ->> 'suggested_qty', '')::numeric, 0);
    if v_suggested > 0 and v_catalog.po_unit_factor > 0 then
      v_proposal := v_suggested / v_catalog.po_unit_factor;
      if v_catalog.pack_size_po is not null and v_catalog.pack_size_po > 0 then
        v_proposal := ceil(v_proposal / v_catalog.pack_size_po) * v_catalog.pack_size_po;
      else
        v_proposal := ceil(v_proposal);
      end if;
      v_proposal := round(v_proposal, 3);
    else
      v_proposal := 0;
    end if;

    -- Largest quantity bought from this supplier for this item in 180 days, in the
    -- catalog's order unit (lines in another unit are not converted here, so not counted).
    -- Items with no Q7 forecast (Tân Tạo, packaging, new suppliers) had a cap of 0
    -- before, which refused every quantity.
    select max(x.quantity)
    into v_hist_qty
    from (
      select gi.quantity, gi.unit, coalesce(gi.raw_product_name, gi.product_name) as product_name
      from public.goods_receipt_items gi
      join public.goods_receipts gr on gr.id = gi.goods_receipt_id
      where gr.supplier_id = p_supplier_id
        and gr.receipt_date >= v_today - 180
      union all
      select poi.quantity, poi.unit, poi.product_name
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      where po.supplier_id = p_supplier_id
        and po.order_date >= v_today - 180
        and po.status <> 'cancelled'::public.purchase_order_status
    ) x
    where x.quantity > 0
      and lower(btrim(coalesce(x.unit, ''))) = lower(btrim(coalesce(v_catalog.po_unit, '')))
      and exists (
        select 1
        from public.stock_material_aliases a
        where a.kitchen_inventory_item_id = v_item_id
          and a.normalized_name = public.normalize_stock_item_name(x.product_name)
          and (a.supplier_id = p_supplier_id or a.supplier_id is null)
      );

    -- Tân Tạo learned order size (base unit) in order units.
    select case when v_catalog.po_unit_factor > 0 then wl.learned_order_qty / v_catalog.po_unit_factor end
    into v_learned_qty
    from public.warehouse_item_learning wl
    where wl.location = 'tan_tao'
      and wl.kitchen_inventory_item_id = v_item_id;

    v_max_qty := greatest(
      3 * coalesce(v_proposal, 0),
      10 * coalesce(v_catalog.pack_size_po, 0),
      3 * coalesce(v_hist_qty, 0),
      3 * coalesce(v_learned_qty, 0)
    );
    -- No basis at all (no forecast, bag, same-unit history or learning): no per-line
    -- quantity cap; the order amount cap below still applies.
    if v_max_qty <= 0 then
      v_max_qty := null;
    end if;
    if v_max_qty is not null and v_quantity > v_max_qty then
      raise exception 'over_quantity_limit' using errcode = 'P0001';
    end if;

    v_vat_rate := coalesce(v_catalog.vat_rate, 0);
    v_list_price := v_catalog.list_price;
    v_list_price_includes_vat := coalesce(
      v_catalog.list_price_includes_vat, false
    );

    if v_list_price is not null then
      if v_list_price_includes_vat then
        v_gross_amount := round(v_quantity * v_list_price, 0);
        v_line_total := round(
          v_gross_amount / (1 + v_vat_rate / 100), 0
        );
        v_line_vat := v_gross_amount - v_line_total;
        v_line_vat_raw := null;
        v_unit_price := round(
          v_list_price / (1 + v_vat_rate / 100), 2
        );
      else
        v_unit_price := v_list_price;
        v_line_total := round(v_quantity * v_unit_price, 2);
        v_line_vat_raw := v_line_total * v_vat_rate / 100;
        v_line_vat := round(v_line_vat_raw, 2);
        v_gross_amount := round(v_line_total + v_line_vat_raw, 2);
      end if;
    else
      v_history_price := public.supplier_order_line_price(
        p_supplier_id, v_item_id
      );
      if v_history_price is null then
        raise exception 'no_price' using errcode = 'P0001';
      end if;
      v_unit_price := round(
        v_history_price * v_catalog.po_unit_factor, 2
      );
      if v_unit_price is null then
        raise exception 'no_price' using errcode = 'P0001';
      end if;
      v_line_total := round(v_quantity * v_unit_price, 2);
      v_line_vat_raw := v_line_total * v_vat_rate / 100;
      v_line_vat := round(v_line_vat_raw, 2);
      v_gross_amount := round(v_line_total + v_line_vat_raw, 2);
    end if;

    v_product_name := nullif(btrim(coalesce(v_catalog.product_name, '')), '');
    if v_product_name is null then
      select poi.product_name
      into v_product_name
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      join lateral (
        select a.*
        from public.stock_material_aliases a
        where a.kitchen_inventory_item_id = v_item_id
          and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
          and (a.supplier_id = p_supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a on true
      where po.supplier_id = p_supplier_id
      order by po.order_date desc, poi.created_at desc
      limit 1;
    end if;
    if nullif(btrim(coalesce(v_product_name, '')), '') is null then
      v_product_name := v_catalog.item_name;
    end if;

    v_subtotal := v_subtotal + v_line_total;
    if v_list_price is not null and v_list_price_includes_vat then
      v_gross_vat := v_gross_vat + v_line_vat;
    else
      v_net_vat_raw := v_net_vat_raw + v_line_vat_raw;
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'position', v_line.position,
      'item_id', v_item_id,
      'product_name', v_product_name,
      'quantity', v_quantity,
      'unit', v_catalog.po_unit,
      'unit_price', v_unit_price,
      'line_total', v_line_total,
      'vat_rate', v_vat_rate,
      'vat_amount', v_line_vat,
      'gross_amount', v_gross_amount,
      'list_price', v_list_price,
      'list_price_includes_vat', v_list_price_includes_vat
    ));
  end loop;

  v_vat_amount := v_gross_vat + round(v_net_vat_raw, 0);
  v_total := v_subtotal + v_vat_amount;
  if v_total > v_max_amount then
    raise exception 'over_amount_limit' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'lines', v_lines,
    'subtotal', v_subtotal,
    'vat_amount', v_vat_amount,
    'total', v_total
  );
end;
$$;

-- supplier_order_setting (from 20261102890000_supplier_order_setting.sql)


revoke all on function public.supplier_order_quote(uuid, jsonb) from public, anon;
grant execute on function public.supplier_order_quote(uuid, jsonb)
  to authenticated, service_role;

create or replace function public.supplier_order_line_price(
  p_supplier_id uuid,
  p_item_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with catalog as (
    select c.po_unit, c.po_unit_factor
    from public.supplier_order_catalog_items c
    where c.supplier_id = p_supplier_id
      and c.kitchen_inventory_item_id = p_item_id
    limit 1
  ),
  lines as (
    select
      poi.unit_price,
      poi.unit,
      poi.product_name,
      po.order_date,
      poi.created_at,
      kii.unit as item_unit,
      a.conversion_factor,
      (cat.po_unit is not null
        and cat.po_unit_factor > 0
        and lower(btrim(coalesce(poi.unit, ''))) = lower(btrim(cat.po_unit))) as same_unit,
      cat.po_unit_factor
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    join public.kitchen_inventory_items kii on kii.id = p_item_id
    left join catalog cat on true
    join lateral (
      select a.*
      from public.stock_material_aliases a
      where a.kitchen_inventory_item_id = p_item_id
        and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
        and (a.supplier_id = p_supplier_id or a.supplier_id is null)
      order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
      limit 1
    ) a on true
    where po.supplier_id = p_supplier_id
      and poi.unit_price is not null
      and poi.unit_price > 0
  ),
  candidates as (
    select
      case
        when l.same_unit then l.unit_price / l.po_unit_factor
        else l.unit_price / greatest(coalesce(
          public.stock_unit_line_factor(l.unit, l.item_unit),
          public.stock_unit_pack_factor(l.product_name, l.unit, l.item_unit),
          l.conversion_factor
        ), 0.00000001)
      end as book_price,
      l.order_date,
      l.created_at
    from lines l
    -- When the order unit appears on any line, only those lines count.
    where l.same_unit or not exists (select 1 from lines x where x.same_unit)
  ),
  newest as (
    select book_price, order_date, created_at
    from candidates
    order by order_date desc, created_at desc
    limit 6
  ),
  ranked as (
    select book_price,
           row_number() over (order by book_price) as rn,
           count(*) over () as cnt
    from newest
  ),
  median as (
    select avg(book_price) as value
    from ranked
    where rn in ((cnt + 1) / 2, (cnt + 2) / 2)
  )
  select round(coalesce(
    (
      select n.book_price
      from newest n
      cross join median m
      where n.book_price between m.value / 3 and m.value * 3
      order by n.order_date desc, n.created_at desc
      limit 1
    ),
    (
      select n.book_price
      from newest n
      order by n.order_date desc, n.created_at desc
      limit 1
    )
  ), 6);
$$;
revoke all on function public.supplier_order_line_price(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_order_line_price(uuid, uuid)
  to service_role;
