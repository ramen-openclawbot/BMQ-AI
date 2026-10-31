-- Tin Zalo báo đơn: kết thúc bằng 'BMQ xin cảm ơn!' (anh Tâm 31/10).

create or replace function public.supplier_order_zalo_message(p_order_request_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_supplier_name text;
  v_po_number text;
  v_message text;
  v_line record;
  v_quantity_text text;
  v_digits text;
  v_grouped text;
  v_index integer;
begin
  select *
    into v_request
  from public.supplier_order_requests
  where id = p_order_request_id;

  if not found then
    return '';
  end if;

  select name
    into v_supplier_name
  from public.suppliers
  where id = v_request.supplier_id;

  if v_request.purchase_order_id is not null then
    select po_number
      into v_po_number
    from public.purchase_orders
    where id = v_request.purchase_order_id;
  end if;

  v_message := '🧾 BMQ đặt hàng — '
    || coalesce(nullif(btrim(v_supplier_name), ''), 'Nhà cung cấp');
  v_message := v_message || E'\nPO: '
    || coalesce(nullif(btrim(v_po_number), ''), '—')
    || ' · Ngày: '
    || to_char(
         coalesce(v_request.sent_at, v_request.created_at, now())
           at time zone 'Asia/Ho_Chi_Minh',
         'DD/MM/YYYY'
       );

  -- Blank line between the PO header and the item list.
  v_message := v_message || E'\n';

  -- Supplier request lines first, then the draft PO items, then the single
  -- kitchen item carried by older requests. The first non-empty source wins.
  for v_line in
    select source.product_name, source.quantity, source.unit
    from (
      select 1 as source_order, l.position as position,
             l.product_name, l.quantity, l.unit
      from public.supplier_order_request_lines l
      where l.request_id = v_request.id

      union all

      select 2 as source_order, 0 as position,
             poi.product_name, poi.quantity, coalesce(poi.unit, v_request.unit)
      from public.purchase_order_items poi
      where v_request.purchase_order_id is not null
        and poi.purchase_order_id = v_request.purchase_order_id
        and not exists (
          select 1
          from public.supplier_order_request_lines l
          where l.request_id = v_request.id
        )

      union all

      select 3 as source_order, 0 as position,
             ki.name, v_request.quantity, v_request.unit
      from public.kitchen_inventory_items ki
      where ki.id = v_request.kitchen_inventory_item_id
        and not exists (
          select 1
          from public.supplier_order_request_lines l
          where l.request_id = v_request.id
        )
        and not exists (
          select 1
          from public.purchase_order_items poi
          where v_request.purchase_order_id is not null
            and poi.purchase_order_id = v_request.purchase_order_id
        )
    ) source
    order by source.source_order, source.position, source.product_name
  loop
    v_quantity_text := round(coalesce(v_line.quantity, 0), 3)::text;
    v_quantity_text := regexp_replace(v_quantity_text, '(\.\d*?)0+$', '\1');
    v_quantity_text := trim(trailing '.' from v_quantity_text);
    -- Vietnamese decimal comma: 1.5 -> 1,5.
    v_quantity_text := replace(v_quantity_text, '.', ',');

    v_message := v_message || E'\n• '
      || coalesce(nullif(btrim(v_line.product_name), ''), 'Hàng đặt')
      || ': ' || v_quantity_text;
    if nullif(btrim(coalesce(v_line.unit, '')), '') is not null then
      v_message := v_message || ' ' || btrim(v_line.unit);
    end if;
  end loop;

  -- Blank line between the item list and the summary block.
  v_message := v_message || E'\n';

  if v_request.total_amount is not null then
    v_digits := round(abs(v_request.total_amount))::bigint::text;
    v_grouped := '';
    for v_index in 1..length(v_digits) loop
      if v_index > 1
         and ((length(v_digits) - v_index + 1) % 3) = 0 then
        v_grouped := v_grouped || '.';
      end if;
      v_grouped := v_grouped || substr(v_digits, v_index, 1);
    end loop;
    if v_request.total_amount < 0 then
      v_grouped := '-' || v_grouped;
    end if;

    v_message := v_message || E'\nTổng: ' || v_grouped || ' đ (đã gồm VAT)';
  end if;

  if nullif(btrim(coalesce(v_request.note, '')), '') is not null then
    v_message := v_message || E'\nGhi chú: ' || btrim(v_request.note);
  end if;

  v_message := v_message || E'\nEmail đơn đã gửi tới: '
    || coalesce(v_request.to_email, '');
  v_message := v_message || E'\nBMQ xin cảm ơn!';

  return coalesce(v_message, '');
end;
$$;
