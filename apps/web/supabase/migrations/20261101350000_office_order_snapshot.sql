-- Kho văn phòng — phần dữ liệu: snapshot hàng theo nhóm + chi tiết PR/PO.
--
-- Additive only. This migration adds two READ-ONLY Postgres functions that the
-- Maestro page uses to build Kho văn phòng on live data:
--
--   1. public.get_office_order_snapshot(text) — the stock items of one warehouse
--      (Tân Tạo / Q7) with their material group, the last 120 days of confirmed
--      receipts (per-day aggregation, purchase cycle, median gap, last purchase
--      facts) and, for Q7, the pastry forecast suggestion.
--   2. public.get_payment_doc_detail(text, uuid) — one payment request or one
--      purchase order in full. SECURITY INVOKER: the caller's own row-level
--      security decides whether the row is visible; invisible rows return null.
--
-- Dependencies reused (never rewritten here):
--   * public.material_master_jwt_role() and public.normalize_stock_item_name.
--   * public.get_q7_purchase_forecast(date, integer) for the Q7 forecast.
--   * public.kitchen_inventory_items / stock_material_aliases /
--     goods_receipts / goods_receipt_items / stock_material_categories /
--     sku_cogs_materials.
--
-- This migration never writes a business row. It never changes an existing RPC,
-- page, hook or table. The Maestro applies it after a rollback-only smoke; the
-- Harness does not run it against any database.

-- ===========================================================================
-- 1. get_office_order_snapshot — one warehouse's stock items + purchase facts
-- ===========================================================================

create or replace function public.get_office_order_snapshot(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_forecast jsonb;
  v_result jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'not_authenticated' using errcode = '42501';
    end if;
  end if;

  if p_location is null or p_location not in ('tan_tao', 'q7') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;

  -- The forecast only feeds the Q7 suggestion columns. A denied / failed
  -- forecast call must never fail the whole read.
  if p_location = 'q7' then
    begin
      v_forecast := public.get_q7_purchase_forecast(null, 14);
    exception when others then
      v_forecast := null;
    end;
  end if;

  -- One set-based pass (a per-item loop normalised every receipt line once per
  -- item and took ~6 s on live data).
  with fc as (
    select (e ->> 'item_id')::uuid as item_id,
           (e ->> 'suggested_qty')::numeric as suggested,
           (e ->> 'daily_usage')::numeric as daily
    from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
  ),
  items as (
    select kii.id, kii.item_code, kii.name, kii.unit, kii.item_class,
           coalesce(kii.pastry_q7, false) as pastry_q7, m.category
    from public.kitchen_inventory_items kii
    left join public.sku_cogs_materials m on m.id = kii.canonical_material_id
    where kii.active = true
      and kii.merged_into_id is null
      and coalesce(kii.item_class, 'raw_material') in ('raw_material', 'packaging_supply')
      and (p_location <> 'q7' or coalesce(kii.pastry_q7, false) = true or exists (select 1 from fc where fc.item_id = kii.id))
  ),
  receipt_lines as (
    select gi.id as line_id, gi.created_at, gr.receipt_date, gr.supplier_id, gi.unit, gi.unit_price,
           greatest(0, coalesce(gi.actual_quantity, gi.quantity, 0)) as raw_qty,
           public.normalize_stock_item_name(coalesce(gi.raw_product_name, gi.product_name)) as norm
    from public.goods_receipt_items gi
    join public.goods_receipts gr on gr.id = gi.goods_receipt_id
    where gr.status in ('confirmed', 'received')
      and gr.receipt_date >= current_date - 120
      and gr.receipt_date <= current_date
  ),
  -- Purchase history is per item, whichever warehouse classified the line;
  -- one alias per receipt line (this warehouse's first) so nothing counts twice.
  matched as (
    select distinct on (rl.line_id)
           rl.line_id, rl.created_at, rl.receipt_date, rl.supplier_id, rl.unit, rl.unit_price, rl.raw_qty,
           a.kitchen_inventory_item_id as item_id,
           rl.raw_qty * coalesce(a.conversion_factor, 1) as stock_qty
    from receipt_lines rl
    join public.stock_material_aliases a
      on a.normalized_name = rl.norm
     and a.line_class = 'stock'
     and (a.supplier_id = rl.supplier_id or a.supplier_id is null)
    join items i on i.id = a.kitchen_inventory_item_id
    order by rl.line_id, (a.location = p_location) desc, (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  days as (
    select item_id, receipt_date, sum(stock_qty) as day_qty
    from matched
    group by item_id, receipt_date
  ),
  gaps as (
    select item_id, receipt_date - lag(receipt_date) over (partition by item_id order by receipt_date) as gap_days
    from days
  ),
  stats as (
    select d.item_id, count(*)::integer as receipts, min(d.receipt_date) as first_date, max(d.receipt_date) as last_date,
           avg(d.day_qty) as avg_qty, sum(d.day_qty) as total_qty,
           (select percentile_cont(0.5) within group (order by g.gap_days)
              from gaps g where g.item_id = d.item_id and g.gap_days is not null) as median_gap_days
    from days d
    group by d.item_id
  ),
  last_line as (
    select distinct on (item_id) item_id, supplier_id, unit, unit_price, receipt_date
    from matched
    order by item_id, receipt_date desc, created_at desc, line_id desc
  ),
  last_raw as (
    select ll.item_id, sum(m.raw_qty) as raw_qty
    from last_line ll
    join matched m on m.item_id = ll.item_id and m.receipt_date = ll.receipt_date and coalesce(m.unit, '') = coalesce(ll.unit, '')
    group by ll.item_id
  )
  select jsonb_build_object(
    'as_of', current_date,
    'location', p_location,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('code', c.code, 'label_vi', c.label_vi, 'sort_order', c.sort_order) order by c.sort_order, c.code)
      from public.stock_material_categories c
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'item_code', i.item_code, 'name', i.name, 'unit', i.unit, 'item_class', i.item_class,
        'pastry_q7', i.pastry_q7, 'category', i.category,
        'receipts', coalesce(st.receipts, 0), 'first_date', st.first_date, 'last_date', st.last_date,
        'avg_qty', st.avg_qty, 'total_qty', st.total_qty, 'median_gap_days', st.median_gap_days,
        'supplier_id', ll.supplier_id, 'supplier_name', s.name,
        'last_unit', ll.unit, 'last_unit_price', ll.unit_price, 'last_raw_qty', lr.raw_qty,
        'forecast_suggested_qty', fc.suggested, 'forecast_daily_usage', fc.daily
      ) order by i.name, i.id)
      from items i
      left join stats st on st.item_id = i.id
      left join last_line ll on ll.item_id = i.id
      left join last_raw lr on lr.item_id = i.id
      left join public.suppliers s on s.id = ll.supplier_id
      left join fc on fc.item_id = i.id
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_office_order_snapshot(text) from public, anon;
grant execute on function public.get_office_order_snapshot(text) to authenticated, service_role;

-- ===========================================================================
-- 2. get_payment_doc_detail — one PR or one PO in full, caller's RLS
-- ===========================================================================

create or replace function public.get_payment_doc_detail(p_kind text, p_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pr public.payment_requests%rowtype;
  v_po public.purchase_orders%rowtype;
  v_supplier jsonb;
  v_po_json jsonb;
  v_gr jsonb;
  v_prs jsonb;
  v_lines jsonb;
begin
  if p_kind = 'pr' then
    select *
      into v_pr
    from public.payment_requests pr
    where pr.id = p_id;

    if not found then
      return null;
    end if;

    v_supplier := null;
    if v_pr.supplier_id is not null then
      select jsonb_build_object('id', s.id, 'name', s.name)
        into v_supplier
      from public.suppliers s
      where s.id = v_pr.supplier_id;
    end if;

    v_po_json := null;
    if v_pr.purchase_order_id is not null then
      select jsonb_build_object(
        'id', po.id,
        'number', po.po_number,
        'date', po.order_date,
        'status', po.status,
        'amount', po.total_amount
      )
      into v_po_json
      from public.purchase_orders po
      where po.id = v_pr.purchase_order_id;
    end if;

    v_gr := null;
    select jsonb_build_object(
      'id', gr.id,
      'number', gr.receipt_number,
      'date', gr.receipt_date,
      'status', gr.status,
      'has_image', gr.image_url is not null
    )
    into v_gr
    from public.goods_receipts gr
    where (
        v_pr.goods_receipt_id is not null
        and gr.id = v_pr.goods_receipt_id
      )
      or (
        v_pr.goods_receipt_id is null
        and gr.payment_request_id = v_pr.id
      )
    order by gr.receipt_date desc nulls last, gr.created_at desc
    limit 1;

    v_lines := coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', pri.product_name,
          'qty', pri.quantity,
          'unit', pri.unit,
          'price', pri.unit_price,
          'total', pri.line_total,
          'change', pri.price_change_percent
        )
        order by pri.created_at, pri.product_name
      )
      from public.payment_request_items pri
      where pri.payment_request_id = v_pr.id
    ), '[]'::jsonb);

    return jsonb_build_object(
      'kind', 'pr',
      'id', v_pr.id,
      'number', v_pr.request_number,
      'title', v_pr.title,
      'description', v_pr.description,
      'notes', v_pr.notes,
      'status', v_pr.status,
      'payment_status', v_pr.payment_status,
      'delivery_status', v_pr.delivery_status,
      'payment_type', v_pr.payment_type,
      'payment_method', v_pr.payment_method,
      'amount', v_pr.total_amount,
      'vat', v_pr.vat_amount,
      'created_at', v_pr.created_at::date,
      'invoice_created', v_pr.invoice_created,
      'has_image', v_pr.image_url is not null,
      'supplier', v_supplier,
      'po', v_po_json,
      'gr', v_gr,
      'lines', v_lines
    );
  elsif p_kind = 'po' then
    select *
      into v_po
    from public.purchase_orders po
    where po.id = p_id;

    if not found then
      return null;
    end if;

    v_supplier := null;
    if v_po.supplier_id is not null then
      select jsonb_build_object('id', s.id, 'name', s.name)
        into v_supplier
      from public.suppliers s
      where s.id = v_po.supplier_id;
    end if;

    select jsonb_build_object(
      'id', gr.id,
      'number', gr.receipt_number,
      'date', gr.receipt_date,
      'status', gr.status,
      'has_image', gr.image_url is not null
    )
    into v_gr
    from public.goods_receipts gr
    where gr.purchase_order_id = v_po.id
    order by gr.receipt_date desc nulls last, gr.created_at desc
    limit 1;

    v_prs := coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', pr.id,
          'number', pr.request_number,
          'status', pr.status,
          'payment_status', pr.payment_status,
          'amount', pr.total_amount
        )
        order by pr.created_at
      )
      from public.payment_requests pr
      where pr.purchase_order_id = v_po.id
    ), '[]'::jsonb);

    v_lines := coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', poi.product_name,
          'qty', poi.quantity,
          'unit', poi.unit,
          'price', poi.unit_price,
          'total', poi.line_total,
          'change', null
        )
        order by poi.created_at, poi.product_name
      )
      from public.purchase_order_items poi
      where poi.purchase_order_id = v_po.id
    ), '[]'::jsonb);

    return jsonb_build_object(
      'kind', 'po',
      'id', v_po.id,
      'number', v_po.po_number,
      'date', v_po.order_date,
      'expected', v_po.expected_date,
      'status', v_po.status,
      'amount', v_po.total_amount,
      'vat', v_po.vat_amount,
      'notes', v_po.notes,
      'has_image', v_po.image_url is not null,
      'supplier', v_supplier,
      'gr', v_gr,
      'prs', v_prs,
      'lines', v_lines
    );
  else
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.get_payment_doc_detail(text, uuid) from public, anon;
grant execute on function public.get_payment_doc_detail(text, uuid) to authenticated, service_role;
