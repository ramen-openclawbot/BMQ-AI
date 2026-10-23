-- Supplier ordering closed loop: receipt queue, delivery evidence, history chain.
--
-- 2026-11-02. An order sent from the Đặt hàng page now gets the same receipt
-- queue as a manual purchase order (one goods receipt in status confirmed
-- waiting for the warehouse, one pending/unpaid "Duyệt chi PO …" payment
-- request with the PO total and VAT), the supplier's uploaded delivery document
-- becomes the evidence image of the PO / goods receipt / payment request when
-- they have none, PO-000865 is backfilled the same way, and the page and its
-- RPCs are gated by a dedicated supplier_orders (view/edit) module permission
-- copied once from the current purchase_orders editors.
--
-- Nothing is applied live by this file: it is the reviewed migration only.

-- ---------------------------------------------------------------------------
-- 1. Dedicated supplier_orders module permission, copied from PO editors
-- ---------------------------------------------------------------------------

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
select
  p.user_id,
  'supplier_orders' as module_key,
  true as can_view,
  true as can_edit
from public.user_module_permissions p
where p.module_key = 'purchase_orders'
  and p.can_edit = true
on conflict (user_id, module_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Request columns used by the receipt queue, the evidence and the history
-- ---------------------------------------------------------------------------

alter table public.supplier_order_requests
  add column if not exists goods_receipt_id uuid,
  add column if not exists payment_request_id uuid,
  add column if not exists receipt_queue_error text;

-- ---------------------------------------------------------------------------
-- 3. Every supplier ordering RPC now gates on supplier_orders.
--    Read paths: owner or supplier_orders view/edit.
--    Write paths: owner or supplier_orders edit.
--    Every other line (service-role bypass, error codes) is identical to the
--    latest body in the migrations below.
-- ---------------------------------------------------------------------------

-- supplier_order_suppliers (from 20261102910000_supplier_order_page.sql)
create or replace function public.supplier_order_suppliers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', su.id,
    'name', btrim(su.name),
    'email', nullif(btrim(su.email), ''),
    'item_count', (
      select count(*)
      from public.supplier_order_catalog_items c
      where c.supplier_id = su.id and c.active
    ),
    'last_order', (
      select jsonb_build_object(
        'po_number', po.po_number,
        'sent_at', r.sent_at
      )
      from public.supplier_order_requests r
      left join public.purchase_orders po on po.id = r.purchase_order_id
      where r.supplier_id = su.id
        and r.status = 'sent'
      order by r.sent_at desc nulls last, r.created_at desc
      limit 1
    ),
    'unpaid_count', (
      select count(*)
      from public.payment_requests pr
      where pr.supplier_id = su.id
        and pr.status::text in ('pending', 'approved')
        and pr.payment_status::text in ('unpaid', 'partial')
    )
  ) order by btrim(su.name), su.id), '[]'::jsonb)
  into v_result
  from public.suppliers su
  where exists (
    select 1
    from public.supplier_order_catalog_items c
    where c.supplier_id = su.id and c.active
  );

  return v_result;
end;
$$;

-- supplier_order_catalog (from 20261102930000_supplier_order_list_price.sql)
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
  v_on_hand numeric;
  v_daily numeric;
  v_days_left numeric;
  v_last_count_date date;
  v_reorder_date date;
  v_suggested numeric;
  v_proposal numeric;
  v_price numeric;
  v_history_price numeric;
  v_unit_price numeric;
  v_unit_price_gross numeric;
  v_vat_rate numeric;
  v_product_name text;
  v_open_order jsonb;
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
    select c.id as catalog_id, c.kitchen_inventory_item_id, c.product_name,
           c.po_unit, c.po_unit_factor, c.pack_size_po, c.vat_rate,
           c.list_price, c.list_price_includes_vat, c.list_price_source,
           c.list_price_updated_at,
           kii.name as item_name, kii.item_code, kii.unit as item_unit
    from public.supplier_order_catalog_items c
    join public.kitchen_inventory_items kii
      on kii.id = c.kitchen_inventory_item_id
    where c.supplier_id = p_supplier_id
      and c.active
    order by c.sort_order, c.created_at, c.id
  loop
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
      'stock', jsonb_build_object(
        'on_hand', v_on_hand,
        'daily_usage', v_daily,
        'days_left', v_days_left,
        'reorder_date', v_reorder_date,
        'last_count_date', v_last_count_date
      ),
      'proposal_qty', v_proposal,
      'history_price', v_history_price,
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
    end
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
  order by pr.created_at asc, pr.id asc
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

-- supplier_order_catalog_candidates (from 20261102910000_supplier_order_page.sql)
create or replace function public.supplier_order_catalog_candidates(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
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

  with po_lines as materialized (
    select
      poi.id as line_id,
      poi.product_name,
      poi.created_at as line_created_at,
      po.order_date::timestamptz as occurred_at,
      po.supplier_id,
      public.normalize_stock_item_name(poi.product_name) as normalized_name
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    where po.supplier_id = p_supplier_id
  ),
  po_matches as materialized (
    select distinct on (pl.line_id)
      pl.line_id,
      pl.product_name,
      pl.line_created_at,
      pl.occurred_at,
      a.kitchen_inventory_item_id
    from po_lines pl
    join public.stock_material_aliases a
      on a.kitchen_inventory_item_id is not null
     and a.normalized_name = pl.normalized_name
     and (a.supplier_id = pl.supplier_id or a.supplier_id is null)
    order by pl.line_id,
             (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  pr_lines as materialized (
    select
      pri.id as line_id,
      pri.product_name,
      pri.created_at as line_created_at,
      pr.created_at as occurred_at,
      pr.supplier_id,
      public.normalize_stock_item_name(pri.product_name) as normalized_name
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pr.supplier_id = p_supplier_id
  ),
  pr_matches as materialized (
    select distinct on (pl.line_id)
      pl.line_id,
      pl.product_name,
      pl.line_created_at,
      pl.occurred_at,
      a.kitchen_inventory_item_id
    from pr_lines pl
    join public.stock_material_aliases a
      on a.kitchen_inventory_item_id is not null
     and a.normalized_name = pl.normalized_name
     and (a.supplier_id = pl.supplier_id or a.supplier_id is null)
    order by pl.line_id,
             (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  matches as (
    select line_id, product_name, line_created_at, occurred_at, kitchen_inventory_item_id
    from po_matches
    union all
    select line_id, product_name, line_created_at, occurred_at, kitchen_inventory_item_id
    from pr_matches
  ),
  aggregated as (
    select
      m.kitchen_inventory_item_id,
      max(m.occurred_at) as last_order_at,
      count(distinct m.line_id) as line_count,
      (array_agg(
        m.product_name
        order by m.occurred_at desc nulls last, m.line_created_at desc
      ))[1] as latest_product_name
    from matches m
    group by m.kitchen_inventory_item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'item_id', k.id,
    'name', k.name,
    'unit', k.unit,
    'latest_product_name', a.latest_product_name,
    'last_order_date', a.last_order_at::date,
    'line_count', a.line_count
  ) order by a.last_order_at desc nulls last, k.name), '[]'::jsonb)
  into v_result
  from (
    select a.*
    from aggregated a
    join public.kitchen_inventory_items k on k.id = a.kitchen_inventory_item_id
    where k.active = true
      and not exists (
        select 1
        from public.supplier_order_catalog_items c
        where c.supplier_id = p_supplier_id
          and c.kitchen_inventory_item_id = a.kitchen_inventory_item_id
          and c.active
      )
    order by a.last_order_at desc nulls last, k.name
    limit 50
  ) a
  join public.kitchen_inventory_items k on k.id = a.kitchen_inventory_item_id;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- supplier_order_history (from 20261102910000_supplier_order_page.sql)
create or replace function public.supplier_order_history(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_items jsonb;
begin
  if p_item_id is null then
    raise exception 'item_required' using errcode = '22023';
  end if;

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

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'request_id', r.request_id,
    'po_number', r.po_number,
    'quantity', r.quantity,
    'unit', r.unit,
    'total', r.line_total,
    'line_total', r.line_total,
    'status', r.status,
    'sent_at', r.sent_at,
    'to_email', r.to_email,
    'created_at', r.created_at,
    'uploads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'file_name', u.file_name,
        'mime_type', u.mime_type,
        'size_bytes', u.size_bytes,
        'created_at', u.created_at,
        'storage_path', u.storage_path
      ) order by u.created_at desc)
      from public.supplier_order_uploads u
      where u.order_request_id = r.id
    ), '[]'::jsonb)
  ) order by r.created_at desc), '[]'::jsonb)
  into v_items
  from (
    select req.id, req.request_id, po.po_number,
           case
             when l.id is not null then l.quantity
             else req.quantity
           end as quantity,
           case
             when l.id is not null then l.unit
             else req.unit
           end as unit,
           case
             when l.id is not null then l.line_total
             else req.line_total
           end as line_total,
           req.status, req.sent_at, req.to_email, req.created_at
    from public.supplier_order_requests req
    left join public.purchase_orders po on po.id = req.purchase_order_id
    left join public.supplier_order_request_lines l
      on l.request_id = req.id
     and l.kitchen_inventory_item_id = p_item_id
    where req.kitchen_inventory_item_id = p_item_id
       or l.id is not null
    order by req.created_at desc
    limit 10
  ) r;

  return jsonb_build_object('items', v_items);
end;
$$;

-- supplier_order_quote (from 20261102930000_supplier_order_list_price.sql)
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

    v_max_qty := greatest(3 * coalesce(v_proposal, 0), 10 * coalesce(v_catalog.pack_size_po, 0));
    if v_max_qty <= 0 then
      v_max_qty := 3 * coalesce(v_proposal, 0);
    end if;
    if v_quantity > v_max_qty then
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
create or replace function public.supplier_order_setting(p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if p_item_id is null then
    return null;
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.has_role(v_actor, 'owner')
         or public.has_module_permission(v_actor, 'supplier_orders', 'view')
         or public.has_module_permission(v_actor, 'supplier_orders', 'edit')
       ) then
      return null;
    end if;
  end if;

  select jsonb_build_object(
    'supplier_id', s.supplier_id,
    'supplier_name', btrim(su.name),
    'po_unit', s.po_unit
  )
  into v_result
  from public.q7_purchase_item_settings s
  join public.suppliers su on su.id = s.supplier_id
  where s.kitchen_inventory_item_id = p_item_id
    and s.po_unit is not null
    and s.po_unit_factor is not null;

  return v_result;
end;
$$;

-- supplier_order_catalog_set (from 20261102930000_supplier_order_list_price.sql)
create or replace function public.supplier_order_catalog_set(
  p_supplier_id uuid,
  p_item_id uuid,
  p_active boolean,
  p_po_unit text default 'kg',
  p_pack_size_po numeric default null,
  p_product_name text default null,
  p_vat_rate numeric default null,
  p_list_price numeric default null,
  p_list_price_includes_vat boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  v_factor := public.stock_unit_line_factor(p_po_unit, v_item_unit);
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
$$;

-- prepare_supplier_order (from 20261102910000_supplier_order_page.sql)
create or replace function public.prepare_supplier_order(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_role_before text;
  v_item public.kitchen_inventory_items%rowtype;
  v_setting_supplier uuid;
  v_learned_supplier uuid;
  v_setting_pack numeric;
  v_setting_pack_label text;
  v_po_unit text;
  v_po_factor numeric;
  v_supplier_id uuid;
  v_supplier_name text;
  v_supplier_email text;
  v_forecast jsonb;
  v_fc jsonb;
  v_pack_size numeric;
  v_pack_label text;
  v_on_hand numeric;
  v_daily numeric := 0;
  v_days_left numeric;
  v_last_count_date date;
  v_reorder_date date;
  v_suggested numeric := 0;
  v_last_price numeric;
  v_product_name text;
  v_product_price numeric;
  v_qty numeric;
  v_unit text;
  v_price numeric;
  v_line_total numeric;
  v_pack_po numeric;
  v_mailbox text;
  v_addr text := '';
  v_contact_name text := '';
  v_contact_phone text := '';
  v_note text := '';
  v_blockers jsonb := '[]'::jsonb;
  v_open_order jsonb;
begin
  if p_item_id is null then
    raise exception 'item_required' using errcode = '22023';
  end if;

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

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  select s.supplier_id, s.learned_supplier_id, s.pack_size, s.pack_label,
         s.po_unit, s.po_unit_factor
  into v_setting_supplier, v_learned_supplier, v_setting_pack,
       v_setting_pack_label, v_po_unit, v_po_factor
  from public.q7_purchase_item_settings s
  where s.kitchen_inventory_item_id = p_item_id;

  v_supplier_id := coalesce(v_setting_supplier, v_learned_supplier);

  if v_supplier_id is not null then
    select btrim(su.name), btrim(su.email)
    into v_supplier_name, v_supplier_email
    from public.suppliers su
    where su.id = v_supplier_id;
    if not found then
      v_supplier_id := null;
    end if;
  end if;

  -- The forecast's own permission gate does not know the purchase_orders module,
  -- so evaluate it with service-role claims exactly like run_q7_auto_purchase.
  v_role_before := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_forecast := public.get_q7_purchase_forecast(v_today, 14);
  perform set_config('request.jwt.claim.role', coalesce(v_role_before, ''), true);

  select e.value into v_fc
  from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
  where e.value ->> 'item_id' = p_item_id::text
  limit 1;

  v_pack_size := coalesce(v_setting_pack, nullif(v_fc ->> 'pack_size', '')::numeric);
  v_pack_label := coalesce(v_setting_pack_label, v_fc ->> 'pack_label');
  v_on_hand := nullif(v_fc ->> 'on_hand', '')::numeric;
  v_daily := coalesce(nullif(v_fc ->> 'daily_usage', '')::numeric, 0);
  v_suggested := coalesce(nullif(v_fc ->> 'suggested_qty', '')::numeric, 0);
  v_last_count_date := nullif(v_fc ->> 'last_count_date', '')::date;
  v_reorder_date := nullif(v_fc ->> 'reorder_date', '')::date;
  v_last_price := nullif(v_fc ->> 'last_unit_price', '')::numeric;

  if v_on_hand is not null and v_daily > 0 then
    v_days_left := round(v_on_hand / v_daily, 1);
  else
    v_days_left := null;
  end if;

  v_product_name := v_item.name;

  if v_supplier_id is not null then
    -- Supplier's own wording: latest PO line whose normalized name maps to this
    -- item for this supplier, any location.
    select poi.product_name
    into v_product_name
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    join lateral (
      select a.*
      from public.stock_material_aliases a
      where a.kitchen_inventory_item_id = p_item_id
        and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
        and (a.supplier_id = v_supplier_id or a.supplier_id is null)
      order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
      limit 1
    ) a on true
    where po.supplier_id = v_supplier_id
    order by po.order_date desc, poi.created_at desc
    limit 1;

    if nullif(btrim(coalesce(v_product_name, '')), '') is null then
      v_product_name := v_item.name;
    end if;

    -- Latest supplier-line price in the item's book unit. The unit-aware
    -- conversion lives in supplier_order_line_price.
    select public.supplier_order_line_price(v_supplier_id, p_item_id)
    into v_product_price;

    if v_product_price is not null then
      v_last_price := v_product_price;
    end if;
  end if;

  -- Express the book quantity in the supplier unit. When no supplier unit is
  -- configured, mirror run_q7_auto_purchase's pack fallback for display.
  if v_po_factor is not null and v_po_factor > 0 then
    v_qty := round(v_suggested / v_po_factor, 3);
    v_unit := v_po_unit;
    v_pack_po := case
      when v_pack_size is not null and v_pack_size > 0
        then round(v_pack_size / v_po_factor, 3)
      else null
    end;
    v_price := case
      when v_last_price is not null then round(v_last_price * v_po_factor, 2)
      else null
    end;
    v_line_total := case
      when v_price is not null then round(v_qty * v_price, 2)
      else null
    end;
  elsif v_pack_size is not null and v_pack_size > 0 then
    v_qty := round(v_suggested / v_pack_size, 3);
    v_unit := coalesce(v_pack_label, v_item.unit);
    v_pack_po := 1;
    v_price := case
      when v_last_price is not null then round(v_last_price * v_pack_size, 2)
      else null
    end;
    v_line_total := case
      when v_price is not null then round(v_qty * v_price, 2)
      else null
    end;
  else
    v_qty := v_suggested;
    v_unit := v_item.unit;
    v_pack_po := null;
    v_price := v_last_price;
    v_line_total := case
      when v_price is not null then round(v_qty * v_price, 2)
      else null
    end;
  end if;

  select coalesce(max(value) filter (where key = 'order_email_delivery_address'), ''),
         coalesce(max(value) filter (where key = 'order_email_contact_name'), ''),
         coalesce(max(value) filter (where key = 'order_email_contact_phone'), ''),
         coalesce(max(value) filter (where key = 'order_email_note'), '')
  into v_addr, v_contact_name, v_contact_phone, v_note
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

  select jsonb_build_object(
    'po_number', po.po_number,
    'quantity', r.quantity,
    'unit', r.unit,
    'status', po.status::text,
    'created_at', r.created_at
  )
  into v_open_order
  from public.supplier_order_requests r
  join public.purchase_orders po on po.id = r.purchase_order_id
  where r.kitchen_inventory_item_id = p_item_id
    and r.status = 'sent'
    and not exists (
      select 1 from public.goods_receipts gr
      where gr.purchase_order_id = po.id
        and gr.status in ('confirmed', 'received')
    )
  order by r.sent_at desc nulls last, r.created_at desc
  limit 1;

  if v_supplier_id is null then
    v_blockers := v_blockers || jsonb_build_array('no_supplier');
  elsif nullif(btrim(coalesce(v_supplier_email, '')), '') is null then
    v_blockers := v_blockers || jsonb_build_array('no_supplier_email');
  end if;
  if v_last_price is null then
    v_blockers := v_blockers || jsonb_build_array('no_price');
  end if;
  if v_po_unit is null or v_po_factor is null or v_po_factor <= 0 then
    v_blockers := v_blockers || jsonb_build_array('no_po_unit');
  end if;
  if lower(btrim(coalesce(v_mailbox, ''))) <> 'order@bmq.vn' then
    v_blockers := v_blockers || jsonb_build_array('mailbox_not_connected');
  end if;

  return jsonb_build_object(
    'item', jsonb_build_object(
      'id', v_item.id,
      'name', v_item.name,
      'unit', v_item.unit
    ),
    'supplier', case
      when v_supplier_id is null then null
      else jsonb_build_object(
        'id', v_supplier_id,
        'name', v_supplier_name,
        'email', v_supplier_email
      )
    end,
    'stock', jsonb_build_object(
      'on_hand', v_on_hand,
      'daily_usage', v_daily,
      'days_left', v_days_left,
      'last_count_date', v_last_count_date,
      'reorder_date', v_reorder_date
    ),
    'proposal', jsonb_build_object(
      'quantity', v_qty,
      'unit', v_unit,
      'unit_price', v_price,
      'line_total', v_line_total,
      'product_name', v_product_name,
      'pack_size_po_units', v_pack_po,
      'suggested_book_qty', v_suggested
    ),
    'open_order', v_open_order,
    'delivery', jsonb_build_object(
      'address', v_addr,
      'contact_name', v_contact_name,
      'contact_phone', v_contact_phone,
      'note', v_note
    ),
    'blockers', v_blockers
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Storage and RLS read gates follow supplier_orders (PO editors keep access)
-- ---------------------------------------------------------------------------

drop policy if exists supplier_delivery_docs_read on storage.objects;
create policy supplier_delivery_docs_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'supplier-delivery-docs'
    and (
      public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'supplier_orders', 'view')
      or public.has_module_permission((select auth.uid()), 'supplier_orders', 'edit')
      or public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit')
    )
  );

drop policy if exists supplier_order_requests_select on public.supplier_order_requests;
create policy supplier_order_requests_select on public.supplier_order_requests
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'supplier_orders', 'view')
    or public.has_module_permission((select auth.uid()), 'supplier_orders', 'edit')
    or public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit')
  );

drop policy if exists supplier_order_request_lines_select on public.supplier_order_request_lines;
create policy supplier_order_request_lines_select on public.supplier_order_request_lines
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'supplier_orders', 'view')
    or public.has_module_permission((select auth.uid()), 'supplier_orders', 'edit')
    or public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit')
  );

drop policy if exists supplier_order_uploads_select on public.supplier_order_uploads;
create policy supplier_order_uploads_select on public.supplier_order_uploads
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'supplier_orders', 'view')
    or public.has_module_permission((select auth.uid()), 'supplier_orders', 'edit')
    or public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit')
  );

-- ---------------------------------------------------------------------------
-- 5. Service-role-only receipt queue opener for a sent supplier order.
--
-- Finds the sent request by request_id or id, and if the PO has no goods
-- receipt and no payment request yet it runs the manual-PO controller with the
-- ordering user as auth.uid(). The controller is idempotent and takes the PO
-- row lock, so a second call can never create a second queue. Failures are
-- stored in receipt_queue_error and returned, never raised to the Edge caller.
-- ---------------------------------------------------------------------------

create or replace function public.supplier_order_open_receipt_queue(
  p_request_id uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_po public.purchase_orders%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_payment public.payment_requests%rowtype;
  v_receipt_id uuid;
  v_actor uuid;
  v_claim_sub text;
  v_claims text;
  v_claims_json jsonb;
begin
  select * into v_request
  from public.supplier_order_requests r
  where (r.request_id = p_request_id or r.id = p_request_id)
    and r.status = 'sent'
  order by r.created_at desc
  limit 1;

  if not found or v_request.purchase_order_id is null then
    return jsonb_build_object(
      'purchase_order_id', null,
      'goods_receipt_id', null,
      'receipt_number', null,
      'payment_request_id', null,
      'request_number', null
    );
  end if;

  select * into v_po
  from public.purchase_orders
  where id = v_request.purchase_order_id;

  if not found then
    return jsonb_build_object(
      'purchase_order_id', v_request.purchase_order_id,
      'goods_receipt_id', null,
      'receipt_number', null,
      'payment_request_id', null,
      'request_number', null
    );
  end if;

  -- Any existing receipt/payment request for this PO wins: never create a
  -- second queue for the same PO.
  select * into v_receipt
  from public.goods_receipts gr
  where gr.purchase_order_id = v_po.id
  order by gr.created_at asc, gr.id asc
  limit 1;

  select * into v_payment
  from public.payment_requests pr
  where pr.purchase_order_id = v_po.id
  order by pr.created_at asc, pr.id asc
  limit 1;

  if v_receipt.id is not null or v_payment.id is not null then
    update public.supplier_order_requests
    set goods_receipt_id = coalesce(goods_receipt_id, v_receipt.id),
        payment_request_id = coalesce(payment_request_id, v_payment.id)
    where id = v_request.id;

    return jsonb_build_object(
      'purchase_order_id', v_po.id,
      'goods_receipt_id', v_receipt.id,
      'receipt_number', v_receipt.receipt_number,
      'payment_request_id', v_payment.id,
      'request_number', v_payment.request_number
    );
  end if;

  begin
    -- The controller reads auth.uid() for its material-readiness assertion, so
    -- evaluate it as the ordering user while the service role does the writes.
    v_actor := coalesce(p_actor, v_request.created_by);
    v_claim_sub := current_setting('request.jwt.claim.sub', true);
    v_claims := current_setting('request.jwt.claims', true);
    v_claims_json := coalesce(nullif(v_claims, '')::jsonb, '{}'::jsonb);
    perform set_config('request.jwt.claim.sub', coalesce(v_actor::text, ''), true);
    perform set_config(
      'request.jwt.claims',
      jsonb_set(v_claims_json, '{sub}', to_jsonb(coalesce(v_actor::text, '')), true)::text,
      true
    );

    v_receipt_id := public.ensure_purchase_order_receipt_queue(v_po.id);

    perform set_config('request.jwt.claim.sub', coalesce(v_claim_sub, ''), true);
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  exception
    when others then
      update public.supplier_order_requests
      set receipt_queue_error = left(sqlerrm, 2000)
      where id = v_request.id;
      return jsonb_build_object(
        'purchase_order_id', v_po.id,
        'goods_receipt_id', v_request.goods_receipt_id,
        'receipt_number', null,
        'payment_request_id', v_request.payment_request_id,
        'request_number', null,
        'error', sqlerrm
      );
  end;

  select * into v_receipt
  from public.goods_receipts
  where id = v_receipt_id;

  select * into v_payment
  from public.payment_requests pr
  where pr.purchase_order_id = v_po.id
  order by pr.created_at asc, pr.id asc
  limit 1;

  update public.supplier_order_requests
  set goods_receipt_id = v_receipt.id,
      payment_request_id = v_payment.id,
      receipt_queue_error = null
  where id = v_request.id;

  return jsonb_build_object(
    'purchase_order_id', v_po.id,
    'goods_receipt_id', v_receipt.id,
    'receipt_number', v_receipt.receipt_number,
    'payment_request_id', v_payment.id,
    'request_number', v_payment.request_number
  );
end;
$$;

revoke all on function public.supplier_order_open_receipt_queue(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_order_open_receipt_queue(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. Upload evidence: record returns the PO id; attach copies the path onto the
--    PO, its goods receipt and its payment request only where they are empty.
-- ---------------------------------------------------------------------------

create or replace function public.record_supplier_order_upload(
  p_token_hash text,
  p_storage_path text,
  p_file_name text,
  p_mime text,
  p_size integer,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_count integer := 0;
  v_inserted integer := 0;
begin
  if p_storage_path is null or btrim(p_storage_path) = '' then
    raise exception 'storage_path_required' using errcode = '22023';
  end if;
  if p_mime is null or p_mime not in (
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
  ) then
    raise exception 'unsupported_type' using errcode = '22023';
  end if;
  if p_size is null or p_size <= 0 or p_size > 10485760 then
    raise exception 'invalid_file_size' using errcode = '22023';
  end if;
  if p_sha256 is null or lower(p_sha256) !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_sha256' using errcode = '22023';
  end if;

  select * into v_request
  from public.supplier_order_requests
  where upload_token_hash = p_token_hash
    and status = 'sent'
    and upload_expires_at is not null
    and upload_expires_at > now()
  for update;

  if not found then
    raise exception 'link_invalid' using errcode = '22023';
  end if;

  select count(*) into v_count
  from public.supplier_order_uploads u
  where u.order_request_id = v_request.id;

  if v_count >= 10 then
    raise exception 'upload_limit_reached' using errcode = 'P0001';
  end if;

  insert into public.supplier_order_uploads (
    order_request_id, storage_path, file_name, mime_type, size_bytes, sha256
  ) values (
    v_request.id, p_storage_path, left(p_file_name, 255), p_mime, p_size,
    lower(p_sha256)
  )
  on conflict (order_request_id, sha256) do nothing;
  get diagnostics v_inserted = row_count;

  -- purchase_orders.image_url is not touched: the PO screens resolve image_url
  -- only in the invoices/purchase-orders buckets, so a supplier-delivery-docs
  -- path would show as a broken image. Uploads are read from this table.

  select count(*) into v_count
  from public.supplier_order_uploads u
  where u.order_request_id = v_request.id;

  return jsonb_build_object(
    'uploaded', true,
    'count', v_count,
    'idempotent', v_inserted = 0,
    'purchase_order_id', v_request.purchase_order_id,
    'created_by', v_request.created_by
  );
end;
$$;

create or replace function public.supplier_order_attach_evidence(
  p_request_id uuid,
  p_object_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_receipt_id uuid;
  v_payment_id uuid;
  v_po_set boolean := false;
  v_gr_set boolean := false;
  v_pr_set boolean := false;
begin
  if nullif(btrim(coalesce(p_object_path, '')), '') is null then
    raise exception 'object_path_required' using errcode = '22023';
  end if;

  select * into v_request
  from public.supplier_order_requests r
  where (r.request_id = p_request_id or r.id = p_request_id)
  order by r.created_at desc
  limit 1;

  if not found then
    raise exception 'supplier_order_request_not_found' using errcode = 'P0002';
  end if;

  if v_request.purchase_order_id is not null then
    update public.purchase_orders
    set image_url = p_object_path,
        updated_at = now()
    where id = v_request.purchase_order_id
      and (image_url is null or btrim(image_url) = '');
    v_po_set := found;

    v_receipt_id := v_request.goods_receipt_id;
    if v_receipt_id is null then
      select gr.id into v_receipt_id
      from public.goods_receipts gr
      where gr.purchase_order_id = v_request.purchase_order_id
      order by gr.created_at asc, gr.id asc
      limit 1;
    end if;

    if v_receipt_id is not null then
      update public.goods_receipts
      set image_url = p_object_path,
          updated_at = now()
      where id = v_receipt_id
        and (image_url is null or btrim(image_url) = '');
      v_gr_set := found;
    end if;

    v_payment_id := v_request.payment_request_id;
    if v_payment_id is null then
      select pr.id into v_payment_id
      from public.payment_requests pr
      where pr.purchase_order_id = v_request.purchase_order_id
      order by pr.created_at asc, pr.id asc
      limit 1;
    end if;

    if v_payment_id is not null then
      update public.payment_requests
      set image_url = p_object_path,
          updated_at = now()
      where id = v_payment_id
        and (image_url is null or btrim(image_url) = '');
      v_pr_set := found;
    end if;
  end if;

  return jsonb_build_object(
    'purchase_order_id', v_request.purchase_order_id,
    'goods_receipt_id', v_receipt_id,
    'payment_request_id', v_payment_id,
    'purchase_order_image_set', v_po_set,
    'goods_receipt_image_set', v_gr_set,
    'payment_request_image_set', v_pr_set
  );
end;
$$;

revoke all on function public.record_supplier_order_upload(text, text, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.record_supplier_order_upload(text, text, text, text, integer, text)
  to service_role;

revoke all on function public.supplier_order_attach_evidence(uuid, text)
  from public, anon, authenticated;
grant execute on function public.supplier_order_attach_evidence(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. Supplier history carries the PO -> GR -> PR chain
-- ---------------------------------------------------------------------------

create or replace function public.supplier_order_history_by_supplier(p_supplier_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_items jsonb;
begin
  if p_supplier_id is null then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

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

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'request_id', r.request_id,
    'po_number', r.po_number,
    'po_status', r.po_status,
    'subtotal', r.subtotal_amount,
    'vat_amount', r.vat_amount,
    'total', coalesce(r.total_amount, r.line_total),
    'status', r.status,
    'sent_at', r.sent_at,
    'to_email', r.to_email,
    'created_at', r.created_at,
    'receipt', case
      when gr.id is null then null
      else jsonb_build_object(
        'id', gr.id,
        'receipt_number', gr.receipt_number,
        'status', gr.status,
        'finalized_at', gr.finalized_at
      )
    end,
    'payment', case
      when pay.id is null then null
      else jsonb_build_object(
        'request_number', pay.request_number,
        'status', pay.status,
        'payment_status', pay.payment_status,
        'total_amount', pay.total_amount
      )
    end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'position', l.position,
        'item_id', l.kitchen_inventory_item_id,
        'product_name', l.product_name,
        'quantity', l.quantity,
        'unit', l.unit,
        'unit_price', l.unit_price,
        'line_total', l.line_total,
        'vat_rate', l.vat_rate,
        'gross_amount', l.gross_amount
      ) order by l.position)
      from public.supplier_order_request_lines l
      where l.request_id = r.id
    ), case
      -- A single-item order from the kho item card has no line rows.
      when r.kitchen_inventory_item_id is not null then jsonb_build_array(jsonb_build_object(
        'position', 1,
        'item_id', r.kitchen_inventory_item_id,
        'product_name', coalesce((
          select poi.product_name
          from public.purchase_order_items poi
          where poi.purchase_order_id = r.purchase_order_id
          order by poi.created_at
          limit 1
        ), (
          select k.name from public.kitchen_inventory_items k
          where k.id = r.kitchen_inventory_item_id
        )),
        'quantity', r.quantity,
        'unit', r.unit,
        'unit_price', r.unit_price,
        'line_total', r.line_total,
        'vat_rate', null
      ))
      else '[]'::jsonb
    end),
    'uploads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'file_name', u.file_name,
        'mime_type', u.mime_type,
        'size_bytes', u.size_bytes,
        'created_at', u.created_at,
        'storage_path', u.storage_path
      ) order by u.created_at desc)
      from public.supplier_order_uploads u
      where u.order_request_id = r.id
    ), '[]'::jsonb),
    'prepay', case
      when r.prepay_status is null then null
      else jsonb_build_object(
        'status', r.prepay_status,
        'request_number', pr.request_number,
        'submission_number', ps.submission_number
      )
    end
  ) order by r.created_at desc), '[]'::jsonb)
  into v_items
  from (
    select req.*, po.po_number as po_number, po.status::text as po_status
    from public.supplier_order_requests req
    left join public.purchase_orders po on po.id = req.purchase_order_id
    where req.supplier_id = p_supplier_id
    order by req.created_at desc
    limit 20
  ) r
  left join public.payment_requests pr on pr.id = r.prepay_request_id
  left join public.payment_submissions ps on ps.id = r.prepay_submission_id
  left join public.goods_receipts gr on gr.id = coalesce(
    r.goods_receipt_id,
    (
      select g.id
      from public.goods_receipts g
      where g.purchase_order_id = r.purchase_order_id
      order by g.created_at asc, g.id asc
      limit 1
    )
  )
  left join public.payment_requests pay on pay.id = coalesce(
    r.payment_request_id,
    (
      select p.id
      from public.payment_requests p
      where p.purchase_order_id = r.purchase_order_id
      order by p.created_at asc, p.id asc
      limit 1
    )
  );

  return jsonb_build_object('items', v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Grants for every recreated RPC (identical to their latest migration)
-- ---------------------------------------------------------------------------

revoke all on function public.supplier_order_suppliers() from public, anon;
grant execute on function public.supplier_order_suppliers()
  to authenticated, service_role;

revoke all on function public.supplier_order_catalog(uuid) from public, anon;
grant execute on function public.supplier_order_catalog(uuid)
  to authenticated, service_role;

revoke all on function public.supplier_order_catalog_candidates(uuid) from public, anon;
grant execute on function public.supplier_order_catalog_candidates(uuid)
  to authenticated, service_role;

revoke all on function public.supplier_order_history(uuid) from public, anon;
grant execute on function public.supplier_order_history(uuid)
  to authenticated, service_role;

revoke all on function public.supplier_order_history_by_supplier(uuid) from public, anon;
grant execute on function public.supplier_order_history_by_supplier(uuid)
  to authenticated, service_role;

revoke all on function public.supplier_order_quote(uuid, jsonb) from public, anon;
grant execute on function public.supplier_order_quote(uuid, jsonb)
  to authenticated, service_role;

revoke all on function public.supplier_order_setting(uuid) from public, anon;
grant execute on function public.supplier_order_setting(uuid)
  to authenticated, service_role;

revoke all on function public.supplier_order_catalog_set(
  uuid, uuid, boolean, text, numeric, text, numeric, numeric, boolean
) from public, anon;
grant execute on function public.supplier_order_catalog_set(
  uuid, uuid, boolean, text, numeric, text, numeric, numeric, boolean
) to authenticated, service_role;

revoke all on function public.prepare_supplier_order(uuid) from public, anon;
grant execute on function public.prepare_supplier_order(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Backfill PO-000865: one confirmed receipt and one pending/unpaid payment
--    request (total 13.078.000, VAT 968.741) when neither exists yet.
-- ---------------------------------------------------------------------------

do $backfill$
declare
  v_request public.supplier_order_requests%rowtype;
  v_has_receipt boolean := false;
  v_has_payment boolean := false;
  v_queue jsonb;
begin
  select r.* into v_request
  from public.supplier_order_requests r
  join public.purchase_orders po on po.id = r.purchase_order_id
  where po.po_number = 'PO-000865'
    and r.status = 'sent'
  order by r.created_at desc
  limit 1;

  if not found then
    raise notice 'supplier_order_loop: sent request for PO-000865 not found; backfill skipped';
    return;
  end if;

  select
    exists (
      select 1 from public.goods_receipts gr
      where gr.purchase_order_id = v_request.purchase_order_id
    ),
    exists (
      select 1 from public.payment_requests pr
      where pr.purchase_order_id = v_request.purchase_order_id
    )
  into v_has_receipt, v_has_payment;

  if v_has_receipt or v_has_payment then
    raise notice 'supplier_order_loop: PO-000865 already has a receipt or payment request; backfill skipped';
    return;
  end if;

  v_queue := public.supplier_order_open_receipt_queue(
    v_request.request_id,
    v_request.created_by
  );
  if (v_queue ->> 'goods_receipt_id') is null
     or (v_queue ->> 'payment_request_id') is null then
    raise exception 'supplier_order_loop: PO-000865 receipt queue failed: %', v_queue;
  end if;
end;
$backfill$;
