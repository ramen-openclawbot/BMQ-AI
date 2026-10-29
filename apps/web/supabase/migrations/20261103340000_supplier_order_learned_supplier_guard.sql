-- Đặt hàng: chỉ đề xuất ở đúng NCC đã học, cảnh báo giá lệch xa.
--
-- Additive only. Định nghĩa lại public.supplier_order_catalog(uuid) đúng như
-- bản cuối trong 20261103170000_invoice_auto_link_payment_request.sql, giữ
-- nguyên chữ ký, security definer, search_path, quyền và mọi nhánh cũ; chỉ
-- thêm hai chốt chặn cho phần đề xuất:
--   (a) warehouse_item_learning.learned_supplier_id có giá trị và khác NCC
--       đang xem -> proposal_qty = 0, kèm learned_supplier_mismatch và
--       learned_supplier {id, name};
--   (b) giá dòng của NCC hiện tại lệch hơn 3 lần (lớn hơn hoặc nhỏ hơn 1/3)
--       so với giá gần nhất của cùng món ở NCC khác -> proposal_qty = 0, kèm
--       price_outlier và reference_price {supplier_id, supplier_name,
--       unit_price}.
-- Không chặn gửi đơn, chỉ ảnh hưởng đề xuất. Không chạy migration này lên DB
-- thật trong task này.

create or replace function public.supplier_order_catalog(p_supplier_id uuid)
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
  v_mailbox text;
  v_delivery jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_prepay jsonb;
  v_item record;
  v_fc jsonb;
  v_location text;
  v_estimated boolean;
  v_on_hand numeric;
  v_daily numeric;
  v_days_left numeric;
  v_last_count_date date;
  v_reorder_date date;
  v_suggested numeric;
  v_proposal numeric;
  v_price numeric;
  v_history_price numeric;
  v_learned_supplier_id uuid;
  v_learned_supplier_name text;
  v_learned_supplier_mismatch boolean;
  v_learned_supplier jsonb;
  v_reference_unit_price numeric;
  v_reference_supplier_id uuid;
  v_reference_supplier_name text;
  v_reference_price jsonb;
  v_price_outlier boolean;
  v_unit_price numeric;
  v_unit_price_gross numeric;
  v_vat_rate numeric;
  v_product_name text;
  v_open_order jsonb;
  v_tan_tao_daily numeric;
  v_tan_tao_order_qty numeric;
  v_tan_tao_cycle_days numeric;
  v_tan_tao_lead_time_days integer;
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

  v_role_before := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_forecast := public.get_q7_purchase_forecast(v_today, 14);
  perform set_config('request.jwt.claim.role', coalesce(v_role_before, ''), true);

  select jsonb_build_object(
    'address', coalesce(max(value) filter (where key = 'order_email_delivery_address'), ''),
    'contact_name', coalesce(max(value) filter (where key = 'order_email_contact_name'), ''),
    'contact_phone', coalesce(max(value) filter (where key = 'order_email_contact_phone'), ''),
    'note', coalesce(max(value) filter (where key = 'order_email_note'), '')
  )
  into v_delivery
  from public.app_settings
  where key in (
    'order_email_delivery_address',
    'order_email_contact_name',
    'order_email_contact_phone',
    'order_email_note'
  );

  select value into v_mailbox
  from public.app_settings
  where key = 'order_gmail_connected_email';

  if nullif(btrim(coalesce(v_supplier.email, '')), '') is null then
    v_blockers := v_blockers || jsonb_build_array('no_supplier_email');
  end if;
  if lower(btrim(coalesce(v_mailbox, ''))) <> 'order@bmq.vn' then
    v_blockers := v_blockers || jsonb_build_array('mailbox_not_connected');
  end if;

  for v_item in
    select
      c.id as catalog_id,
      c.kitchen_inventory_item_id,
      c.product_name,
      c.po_unit,
      c.po_unit_factor,
      c.pack_size_po,
      c.vat_rate,
      c.list_price,
      c.list_price_includes_vat,
      c.list_price_source,
      c.list_price_updated_at,
      kii.name as item_name,
      kii.item_code,
      kii.unit as item_unit,
      case
        when coalesce(kii.pastry_q7, false) then 'q7'
        when wl.kitchen_inventory_item_id is not null then 'tan_tao'
        when coalesce(kii.in_tan_tao, false) then 'tan_tao'
        else 'q7'
      end as location,
      wl.learned_daily_usage,
      wl.learned_order_qty,
      wl.learned_cycle_days,
      wl.learned_lead_time_days,
      wl.learned_supplier_id,
      ls.name as learned_supplier_name
    from public.supplier_order_catalog_items c
    join public.kitchen_inventory_items kii
      on kii.id = c.kitchen_inventory_item_id
    left join public.warehouse_item_learning wl
      on wl.location = 'tan_tao'
     and wl.kitchen_inventory_item_id = c.kitchen_inventory_item_id
    left join public.suppliers ls
      on ls.id = wl.learned_supplier_id
    where c.supplier_id = p_supplier_id
      and c.active
    order by c.sort_order, c.created_at, c.id
  loop
    v_location := v_item.location;
    v_estimated := v_location = 'tan_tao';
    v_learned_supplier_id := v_item.learned_supplier_id;
    v_learned_supplier_name := v_item.learned_supplier_name;
    v_learned_supplier_mismatch := v_learned_supplier_id is not null
      and v_learned_supplier_id <> p_supplier_id;
    v_learned_supplier := case
      when v_learned_supplier_id is null then null
      else jsonb_build_object(
        'id', v_learned_supplier_id,
        'name', v_learned_supplier_name
      )
    end;
    v_price_outlier := false;
    v_reference_price := null;

    if v_estimated then
      -- Tân Tạo stock source: the same movement sum used by the Tân Tạo
      -- warehouse snapshot / stock-count sheet (tan_tao_material_movements).
      -- No Tân Tạo movement at all means stock is unknown, not zero.
      select case when count(*) = 0 then null else sum(case m.movement_type
                            when 'receipt' then m.quantity
                            when 'opening' then m.quantity
                            when 'production_usage' then -m.quantity
                            when 'adjustment' then m.quantity
                            when 'transfer_out' then -m.quantity
                            else 0
                          end) end
      into v_on_hand
      from public.tan_tao_material_movements m
      where m.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
        and m.movement_date <= v_today;

      v_tan_tao_daily := coalesce(v_item.learned_daily_usage, 0);
      v_tan_tao_order_qty := v_item.learned_order_qty;
      v_tan_tao_cycle_days := v_item.learned_cycle_days;
      v_tan_tao_lead_time_days := v_item.learned_lead_time_days;
      v_daily := v_tan_tao_daily;

      if v_on_hand is not null and v_daily > 0 then
        v_days_left := round(v_on_hand / v_daily, 1);
      else
        v_days_left := null;
      end if;

      if v_on_hand is not null
         and (
           v_on_hand <= 0
           or (
             v_days_left is not null
             and v_days_left <= coalesce(v_tan_tao_lead_time_days, 7)
           )
         ) then
        v_suggested := coalesce(v_tan_tao_order_qty, 0);
      else
        v_suggested := 0;
      end if;

      -- The learned supplier is the only supplier this item should be
      -- proposed from; a different supplier on screen gets no suggestion.
      if v_learned_supplier_mismatch then
        v_suggested := 0;
      end if;

      v_last_count_date := null;
      v_reorder_date := case
        when v_days_left is not null and v_tan_tao_lead_time_days is not null
          then v_today + greatest(
            0,
            floor(v_days_left - v_tan_tao_lead_time_days)
          )::integer
        else null
      end;
    else
      -- Q7 branch: byte-for-byte the previous read path.
      select e.value into v_fc
      from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
      where e.value ->> 'item_id' = v_item.kitchen_inventory_item_id::text
      limit 1;

      v_on_hand := nullif(v_fc ->> 'on_hand', '')::numeric;
      v_daily := coalesce(nullif(v_fc ->> 'daily_usage', '')::numeric, 0);
      v_suggested := coalesce(nullif(v_fc ->> 'suggested_qty', '')::numeric, 0);
      v_last_count_date := nullif(v_fc ->> 'last_count_date', '')::date;
      v_reorder_date := nullif(v_fc ->> 'reorder_date', '')::date;

      if v_on_hand is not null and v_daily > 0 then
        v_days_left := round(v_on_hand / v_daily, 1);
      else
        v_days_left := null;
      end if;

      v_tan_tao_daily := null;
      v_tan_tao_order_qty := null;
      v_tan_tao_cycle_days := null;
      v_tan_tao_lead_time_days := null;
    end if;

    if v_suggested > 0 and v_item.po_unit_factor > 0 then
      v_proposal := v_suggested / v_item.po_unit_factor;
      if v_item.pack_size_po is not null and v_item.pack_size_po > 0 then
        v_proposal := ceil(v_proposal / v_item.pack_size_po) * v_item.pack_size_po;
      else
        v_proposal := ceil(v_proposal);
      end if;
      v_proposal := round(v_proposal, 3);
    else
      v_proposal := 0;
    end if;

    v_price := public.supplier_order_line_price(
      p_supplier_id, v_item.kitchen_inventory_item_id
    );
    v_history_price := case
      when v_price is not null then round(v_price * v_item.po_unit_factor, 2)
      else null
    end;

    v_reference_unit_price := null;
    v_reference_supplier_id := null;
    v_reference_supplier_name := null;

    -- Another supplier's newest line for the same item sets the reference.
    -- Prefer the learned supplier when it is not the supplier on screen;
    -- otherwise use the newest non-null line among the other suppliers that
    -- have an active catalog row for this item.
    if v_learned_supplier_mismatch then
      select s.name,
             public.supplier_order_line_price(
               s.id, v_item.kitchen_inventory_item_id
             )
        into v_reference_supplier_name, v_reference_unit_price
      from public.suppliers s
      where s.id = v_learned_supplier_id;

      if v_reference_unit_price is null or v_reference_unit_price <= 0 then
        v_reference_unit_price := null;
        v_reference_supplier_name := null;
      else
        v_reference_supplier_id := v_learned_supplier_id;
      end if;
    end if;

    -- The learned supplier itself is the trusted price: never compare it with
    -- another supplier's line, which may be the wrong one.
    if v_reference_unit_price is null
       and v_learned_supplier_id is distinct from p_supplier_id then
      select cand.supplier_id, cand.supplier_name, cand.unit_price
        into v_reference_supplier_id,
             v_reference_supplier_name,
             v_reference_unit_price
      from (
        select
          s.id as supplier_id,
          s.name as supplier_name,
          public.supplier_order_line_price(
            s.id, v_item.kitchen_inventory_item_id
          ) as unit_price,
          last_line.order_date as last_order_date,
          last_line.created_at as last_created_at
        from public.suppliers s
        left join lateral (
          select po.order_date, poi.created_at
          from public.purchase_order_items poi
          join public.purchase_orders po on po.id = poi.purchase_order_id
          join lateral (
            select a.id
            from public.stock_material_aliases a
            where a.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
              and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
              and (a.supplier_id = s.id or a.supplier_id is null)
            order by (a.supplier_id is not null) desc,
                     a.created_at asc,
                     a.id asc
            limit 1
          ) a on true
          where po.supplier_id = s.id
            and poi.unit_price is not null
            and poi.unit_price > 0
          order by po.order_date desc nulls last, poi.created_at desc nulls last
          limit 1
        ) last_line on true
        where s.id <> p_supplier_id
          and exists (
            select 1
            from public.supplier_order_catalog_items c2
            where c2.supplier_id = s.id
              and c2.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
              and c2.active
          )
      ) cand
      where cand.unit_price is not null
        and cand.unit_price > 0
      order by cand.last_order_date desc nulls last,
               cand.last_created_at desc nulls last,
               cand.supplier_id
      limit 1;
    end if;

    if v_reference_unit_price is not null then
      v_reference_unit_price := round(
        v_reference_unit_price * v_item.po_unit_factor, 2
      );
      v_reference_price := jsonb_build_object(
        'supplier_id', v_reference_supplier_id,
        'supplier_name', v_reference_supplier_name,
        'unit_price', v_reference_unit_price
      );
    else
      v_reference_price := null;
    end if;

    if v_history_price is not null
       and v_history_price > 0
       and v_reference_unit_price is not null
       and v_reference_unit_price > 0
       and (
         v_history_price / v_reference_unit_price > 3
         or v_history_price / v_reference_unit_price < 1.0 / 3
       ) then
      v_price_outlier := true;
    end if;

    -- Both guards only affect the suggestion; sending the order stays open.
    if v_price_outlier or v_learned_supplier_mismatch then
      v_proposal := 0;
    end if;

    v_vat_rate := coalesce(v_item.vat_rate, 0);

    if v_item.list_price is not null then
      if coalesce(v_item.list_price_includes_vat, false) then
        v_unit_price := round(
          v_item.list_price / (1 + v_vat_rate / 100), 2
        );
        v_unit_price_gross := v_item.list_price;
      else
        v_unit_price := v_item.list_price;
        v_unit_price_gross := round(
          v_unit_price * (1 + v_vat_rate / 100), 2
        );
      end if;
    else
      v_unit_price := v_history_price;
      v_unit_price_gross := case
        when v_unit_price is not null then round(
          v_unit_price * (1 + v_vat_rate / 100), 2
        )
        else null
      end;
    end if;

    v_product_name := nullif(btrim(coalesce(v_item.product_name, '')), '');
    if v_product_name is null then
      select poi.product_name
      into v_product_name
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      join lateral (
        select a.*
        from public.stock_material_aliases a
        where a.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
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
      v_product_name := v_item.item_name;
    end if;

    select jsonb_build_object(
      'po_number', po.po_number,
      'quantity', coalesce(l.quantity, r.quantity),
      'unit', coalesce(l.unit, r.unit),
      'sent_at', r.sent_at
    )
    into v_open_order
    from public.supplier_order_requests r
    join public.purchase_orders po on po.id = r.purchase_order_id
    left join public.supplier_order_request_lines l
      on l.request_id = r.id
     and l.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
    where r.status = 'sent'
      and (
        r.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
        or l.id is not null
      )
      and not exists (
        select 1 from public.goods_receipts gr
        where gr.purchase_order_id = po.id
          and gr.status in ('confirmed', 'received')
      )
    order by r.sent_at desc nulls last, r.created_at desc, l.position nulls last
    limit 1;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'catalog_id', v_item.catalog_id,
      'item', jsonb_build_object(
        'id', v_item.kitchen_inventory_item_id,
        'name', v_item.item_name,
        'code', v_item.item_code,
        'unit', v_item.item_unit
      ),
      'product_name', v_product_name,
      'po_unit', v_item.po_unit,
      'po_unit_factor', v_item.po_unit_factor,
      'pack_size_po', v_item.pack_size_po,
      'vat_rate', v_item.vat_rate,
      'location', v_location,
      'estimated', v_estimated,
      'stock', jsonb_build_object(
        'on_hand', v_on_hand,
        'daily_usage', v_daily,
        'days_left', v_days_left,
        'reorder_date', v_reorder_date,
        'last_count_date', v_last_count_date,
        'lead_time_days', case when v_estimated then v_tan_tao_lead_time_days else null end,
        'order_cycle_days', case when v_estimated then v_tan_tao_cycle_days else null end,
        'order_size', case when v_estimated then v_tan_tao_order_qty else null end
      ),
      'proposal_qty', v_proposal,
      'history_price', v_history_price,
      'learned_supplier_mismatch', v_learned_supplier_mismatch,
      'learned_supplier', v_learned_supplier,
      'price_outlier', v_price_outlier,
      'reference_price', v_reference_price,
      'list_price', v_item.list_price,
      'list_price_includes_vat', coalesce(v_item.list_price_includes_vat, false),
      'list_price_source', v_item.list_price_source,
      'list_price_updated_at', v_item.list_price_updated_at,
      'unit_price', v_unit_price,
      'unit_price_gross', v_unit_price_gross,
      'open_order', v_open_order
    ));
  end loop;

  select jsonb_build_object(
    'id', pr.id,
    'request_number', pr.request_number,
    'created_at', pr.created_at,
    'total_amount', pr.total_amount,
    'remaining', round(
      coalesce(pr.total_amount, 0) - coalesce((
        select sum(pa.amount)
        from public.payment_allocations pa
        where pa.payment_request_id = pr.id
      ), 0), 2),
    'po_number', po.po_number,
    'recent_submission', case
      when ps.id is null then null
      else jsonb_build_object(
        'submission_number', ps.submission_number,
        'created_at', ps.created_at
      )
    end,
    'official_invoice', (
      select jsonb_build_object(
        'invoice_number', i.invoice_number,
        'invoice_series', i.invoice_series,
        'invoice_date', i.invoice_date
      )
      from public.incoming_invoices i
      where i.linked_payment_request_id = pr.id
      order by i.created_at desc, i.id desc
      limit 1
    )
  )
  into v_prepay
  from public.payment_requests pr
  left join public.purchase_orders po on po.id = pr.purchase_order_id
  left join lateral (
    select s.id, s.submission_number, s.created_at
    from public.payment_submission_items psi
    join public.payment_submissions s on s.id = psi.submission_id
    where psi.payment_request_id = pr.id
      and s.created_at >= now() - interval '3 days'
    order by s.created_at desc
    limit 1
  ) ps on true
  where pr.supplier_id = p_supplier_id
    and pr.status::text in ('pending', 'approved')
    and pr.payment_status::text in ('unpaid', 'partial')
  -- Gối đầu pays the latest delivered order (owner 28/10: a new Nam Nguyễn order pays the
  -- 20/10 delivery, not a July request): newest unpaid request whose PO has a goods
  -- receipt first, then the newest unpaid request.
  order by exists (
             select 1 from public.goods_receipts gr
             where gr.purchase_order_id = pr.purchase_order_id
               and gr.status in ('confirmed', 'received')
           ) desc,
           pr.created_at desc, pr.id desc
  limit 1;

  return jsonb_build_object(
    'supplier', jsonb_build_object(
      'id', v_supplier.id,
      'name', btrim(v_supplier.name),
      'email', nullif(btrim(v_supplier.email), '')
    ),
    'delivery', v_delivery,
    'mailbox_connected', lower(btrim(coalesce(v_mailbox, ''))) = 'order@bmq.vn',
    'blockers', v_blockers,
    'items', v_items,
    'prepay', v_prepay
  );
end;
$$;


revoke all on function public.supplier_order_catalog(uuid) from public, anon;
grant execute on function public.supplier_order_catalog(uuid)
  to authenticated, service_role;
