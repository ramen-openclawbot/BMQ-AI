-- 2026-11-02 — Bảng "Mua so với Dùng" theo đơn cho Kho Q7.
--
-- Read-only report. It compares Q7 recipe usage from customer orders (the same
-- production material issue rows that public.post_material_issue_usage posts)
-- with purchases:
--   A. goods receipt lines at any receiving location, and
--   B. approved payment request lines that have no receipt and no purchase order.
-- A payment request tied to a receipt or a PO is excluded from B, so one purchase
-- is never counted twice.
--
-- Unit conversion follows public.post_stock_goods_receipt_item exactly:
--   stock_unit_line_factor -> stock_unit_pack_factor -> alias conversion_factor.
-- When no factor is known the line stays in the report with book_qty = null and
-- is counted as unknown_lines.
--
-- The ledger cutover is intentionally ignored: this report covers history.

-- ===========================================================================
-- 1. Shared purchase lines (internal; service_role only)
-- ===========================================================================

create or replace function public.q7_purchase_usage_purchase_lines(
  p_from date,
  p_to date
)
returns table (
  source text,
  document_id uuid,
  document_number text,
  doc_date date,
  month text,
  receiving_location text,
  supplier_id uuid,
  supplier_name text,
  product_name text,
  quantity numeric,
  unit text,
  factor numeric,
  factor_source text,
  book_qty numeric,
  kitchen_inventory_item_id uuid,
  image_url text,
  photo_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with receipt_raw as (
  select
    gr.id as document_id,
    gr.receipt_number as document_number,
    gr.receipt_date as doc_date,
    gr.supplier_id,
    gr.receiving_location,
    gr.image_url,
    coalesce(array_length(gr.product_photos, 1), 0) as photo_count,
    coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as line_name,
    gri.unit as line_unit,
    public.goods_receipt_effective_quantity(
      gri.actual_quantity,
      gri.quantity,
      gri.ordered_quantity,
      gr.status::text
    ) as quantity
  from public.goods_receipt_items gri
  join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  where gr.status::text in ('confirmed', 'received')
    and gr.receipt_date between p_from and p_to
),
request_raw as (
  select
    pr.id as document_id,
    pr.request_number as document_number,
    (pr.created_at at time zone 'Asia/Ho_Chi_Minh')::date as doc_date,
    pr.supplier_id,
    pr.image_url,
    coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name) as line_name,
    pri.unit as line_unit,
    pri.quantity as quantity
  from public.payment_request_items pri
  join public.payment_requests pr on pr.id = pri.payment_request_id
  where pr.status::text = 'approved'
    and pr.goods_receipt_id is null
    and pr.purchase_order_id is null
    and (pr.created_at at time zone 'Asia/Ho_Chi_Minh')::date between p_from and p_to
),
-- Normalise and classify each distinct line name once: the non-stock rule
-- costs ~1.4 ms per call and the same names repeat across receipts.
line_names as (
  select r.line_name from receipt_raw r
  union
  select q.line_name from request_raw q
),
name_info as (
  select
    n.line_name,
    public.normalize_stock_item_name(n.line_name) as norm
  from line_names n
  where public.stock_line_auto_non_stock(n.line_name) is null
),
receipt_named as (
  select r.*, ni.norm
  from receipt_raw r
  join name_info ni on ni.line_name = r.line_name
),
receipt_alias as (
  select
    n.*,
    -- A receipt with an explicit receiving location resolves that location.
    -- A receipt without one falls back to the Q7 alias and then to Tân Tạo.
    case
      when n.receiving_location is not null then ar.kitchen_inventory_item_id
      else coalesce(a7.kitchen_inventory_item_id, at.kitchen_inventory_item_id)
    end as alias_item_id,
    case
      when n.receiving_location is not null then ar.line_class
      else coalesce(a7.line_class, at.line_class)
    end as alias_line_class,
    case
      when n.receiving_location is not null then ar.conversion_factor
      else coalesce(a7.conversion_factor, at.conversion_factor)
    end as alias_conversion_factor,
    case
      when n.receiving_location is not null then ar.location
      else coalesce(a7.location, at.location)
    end as alias_location
  from receipt_named n
  left join lateral (
    select a.*
    from public.resolve_stock_material_alias(
      n.supplier_id, n.norm, n.receiving_location
    ) a
  ) ar on n.receiving_location is not null
  left join lateral (
    select a.*
    from public.resolve_stock_material_alias(n.supplier_id, n.norm, 'q7') a
  ) a7 on n.receiving_location is null
  left join lateral (
    select a.*
    from public.resolve_stock_material_alias(n.supplier_id, n.norm, 'tan_tao') a
  ) at on n.receiving_location is null
),
receipt_scoped as (
  select a.*, kii.unit as book_unit
  from receipt_alias a
  join public.kitchen_inventory_items kii on kii.id = a.alias_item_id
  where a.norm is not null
    and a.alias_item_id is not null
    and coalesce(a.alias_line_class, '') <> 'non_stock'
),
request_named as (
  select r.*, ni.norm
  from request_raw r
  join name_info ni on ni.line_name = r.line_name
),
request_alias as (
  select
    n.*,
    coalesce(a7.kitchen_inventory_item_id, at.kitchen_inventory_item_id) as alias_item_id,
    coalesce(a7.line_class, at.line_class) as alias_line_class,
    coalesce(a7.conversion_factor, at.conversion_factor) as alias_conversion_factor,
    coalesce(a7.location, at.location) as alias_location
  from request_named n
  left join lateral (
    select a.*
    from public.resolve_stock_material_alias(n.supplier_id, n.norm, 'q7') a
  ) a7 on true
  left join lateral (
    select a.*
    from public.resolve_stock_material_alias(n.supplier_id, n.norm, 'tan_tao') a
  ) at on true
),
request_scoped as (
  select a.*, kii.unit as book_unit
  from request_alias a
  join public.kitchen_inventory_items kii on kii.id = a.alias_item_id
  where a.norm is not null
    and a.alias_item_id is not null
    and coalesce(a.alias_line_class, '') <> 'non_stock'
),
-- One unit-factor lookup per distinct (line unit, book unit) pair.
unit_pairs as (
  select distinct s.line_unit, s.book_unit from receipt_scoped s
  union
  select distinct s.line_unit, s.book_unit from request_scoped s
),
unit_factors as (
  select u.line_unit, u.book_unit, public.stock_unit_line_factor(u.line_unit, u.book_unit) as line_factor
  from unit_pairs u
),
receipt_lines as (
  select
    'goods_receipt'::text as source,
    s.document_id,
    s.document_number,
    s.doc_date,
    to_char(s.doc_date, 'YYYY-MM') as month,
    coalesce(s.receiving_location, s.alias_location) as receiving_location,
    s.supplier_id,
    sup.name as supplier_name,
    s.line_name as product_name,
    s.quantity,
    s.line_unit as unit,
    fx.factor,
    case
      when fx.line_factor is not null then 'line_unit'
      when fx.pack_factor is not null then 'pack_name'
      when fx.alias_factor is not null then 'alias'
      else null
    end as factor_source,
    case
      when fx.factor is not null
        then round(greatest(coalesce(s.quantity, 0), 0) * fx.factor, 3)
      else null
    end as book_qty,
    s.alias_item_id as kitchen_inventory_item_id,
    s.image_url,
    s.photo_count
  from receipt_scoped s
  left join public.suppliers sup on sup.id = s.supplier_id
  cross join lateral (
    select
      coalesce(lf.line_factor, pf.pack_factor, af.alias_factor) as factor,
      lf.line_factor,
      pf.pack_factor,
      af.alias_factor
    from (
      select uf.line_factor
      from unit_factors uf
      where uf.line_unit is not distinct from s.line_unit
        and uf.book_unit is not distinct from s.book_unit
    ) lf
    cross join (
      select public.stock_unit_pack_factor(s.line_name, s.line_unit, s.book_unit) as pack_factor
    ) pf
    cross join (
      select
        case
          when s.alias_conversion_factor <> 1
            or lower(btrim(coalesce(s.line_unit, ''))) = lower(btrim(s.book_unit))
            then s.alias_conversion_factor
        end as alias_factor
    ) af
  ) fx
),
request_lines as (
  select
    'payment_request'::text as source,
    s.document_id,
    s.document_number,
    s.doc_date,
    to_char(s.doc_date, 'YYYY-MM') as month,
    s.alias_location as receiving_location,
    s.supplier_id,
    sup.name as supplier_name,
    s.line_name as product_name,
    s.quantity,
    s.line_unit as unit,
    fx.factor,
    case
      when fx.line_factor is not null then 'line_unit'
      when fx.pack_factor is not null then 'pack_name'
      when fx.alias_factor is not null then 'alias'
      else null
    end as factor_source,
    case
      when fx.factor is not null
        then round(greatest(coalesce(s.quantity, 0), 0) * fx.factor, 3)
      else null
    end as book_qty,
    s.alias_item_id as kitchen_inventory_item_id,
    s.image_url,
    0 as photo_count
  from request_scoped s
  left join public.suppliers sup on sup.id = s.supplier_id
  cross join lateral (
    select
      coalesce(lf.line_factor, pf.pack_factor, af.alias_factor) as factor,
      lf.line_factor,
      pf.pack_factor,
      af.alias_factor
    from (
      select uf.line_factor
      from unit_factors uf
      where uf.line_unit is not distinct from s.line_unit
        and uf.book_unit is not distinct from s.book_unit
    ) lf
    cross join (
      select public.stock_unit_pack_factor(s.line_name, s.line_unit, s.book_unit) as pack_factor
    ) pf
    cross join (
      select
        case
          when s.alias_conversion_factor <> 1
            or lower(btrim(coalesce(s.line_unit, ''))) = lower(btrim(s.book_unit))
            then s.alias_conversion_factor
        end as alias_factor
    ) af
  ) fx
)
select * from receipt_lines
union all
select * from request_lines;

$$;

-- ===========================================================================
-- 2. Report RPC
-- ===========================================================================

create or replace function public.get_q7_purchase_usage_report(
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_to date;
  v_months jsonb;
  v_result jsonb;
begin
  -- Owner, inventory viewer, Q7 material inventory viewer or service_role only.
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or (
      auth.uid() is not null
      and (
        public.has_role(auth.uid(), 'owner'::app_role)
        or public.has_module_permission(auth.uid(), 'inventory', 'view')
        or public.has_module_permission(auth.uid(), 'q7_material_inventory', 'view')
      )
    )
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_to := coalesce(p_to, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_from := coalesce(
    p_from,
    (date_trunc('month', v_to::timestamp) - interval '2 months')::date
  );

  if v_from > v_to or (v_to - v_from + 1) > 366 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_char(m, 'YYYY-MM') order by m), '[]'::jsonb)
  into v_months
  from generate_series(
    date_trunc('month', v_from::timestamp),
    date_trunc('month', v_to::timestamp),
    interval '1 month'
  ) m;

  with usage as (
    select
      i.kitchen_inventory_item_id as item_id,
      to_char(pmi.issue_date, 'YYYY-MM') as month,
      sum(i.required_qty) as used_qty
    from public.production_material_issues pmi
    join public.production_material_issue_items i on i.material_issue_id = pmi.id
    join public.kitchen_inventory_items kii on kii.id = i.kitchen_inventory_item_id
    where pmi.location_code = 'q7'
      and pmi.is_current is true
      and pmi.status in ('pdf_ready', 'posted')
      and pmi.issue_date between v_from and v_to
      and i.kitchen_inventory_item_id is not null
      and coalesce(i.required_qty, 0) > 0
      and i.required_qty::text not in ('NaN', 'Infinity', '-Infinity')
      and coalesce(kii.item_class, '') <> 'non_stock'
      and exists (
        select 1
        from public.q7_material_issue_material_mappings m
        where m.approval_status = 'approved'
          and (
            m.id = i.q7_mapping_id
            or (
              i.q7_mapping_id is null
              and i.canonical_material_id is not null
              and m.canonical_material_id = i.canonical_material_id
            )
          )
      )
      and not exists (
        select 1
        from public.q7_bom_line_decisions d
        where d.active = true
          and d.action in ('not_tracked', 'bom_error')
          and d.canonical_material_id = i.canonical_material_id
          and lower(btrim(d.source_unit)) = lower(btrim(coalesce(i.source_unit, '')))
      )
    group by i.kitchen_inventory_item_id, to_char(pmi.issue_date, 'YYYY-MM')
  ),
  purchases as (
    select *
    from public.q7_purchase_usage_purchase_lines(v_from, v_to)
  ),
  purchase_month as (
    select
      p.kitchen_inventory_item_id as item_id,
      p.month,
      coalesce(sum(p.book_qty) filter (where p.book_qty is not null), 0) as bought_qty,
      count(*) filter (where p.book_qty is null) as unknown_lines,
      count(*) as purchase_lines
    from purchases p
    group by p.kitchen_inventory_item_id, p.month
  ),
  used_items as (
    select u.item_id, sum(u.used_qty) as used_total
    from usage u
    group by u.item_id
    having sum(u.used_qty) > 0
  ),
  item_meta as (
    select u.item_id, kii.name, kii.unit
    from used_items u
    join public.kitchen_inventory_items kii on kii.id = u.item_id
  ),
  grid as (
    select it.item_id, it.name, it.unit, m.month
    from item_meta it
    cross join (
      select jsonb_array_elements_text(v_months) as month
    ) m
  ),
  cells as (
    select
      g.item_id,
      g.name,
      g.unit,
      g.month,
      coalesce(us.used_qty, 0) as used_qty,
      coalesce(pm.bought_qty, 0) as bought_qty,
      coalesce(pm.unknown_lines, 0) as unknown_lines,
      coalesce(pm.purchase_lines, 0) as purchase_lines
    from grid g
    left join usage us on us.item_id = g.item_id and us.month = g.month
    left join purchase_month pm on pm.item_id = g.item_id and pm.month = g.month
  ),
  item_cells as (
    select
      c.item_id,
      c.name,
      c.unit,
      jsonb_object_agg(
        c.month,
        jsonb_build_object(
          'used_qty', round(c.used_qty, 3),
          'bought_qty', round(c.bought_qty, 3),
          'unknown_lines', c.unknown_lines,
          'purchase_lines', c.purchase_lines
        )
      ) as months_json,
      sum(c.used_qty) as used_total,
      sum(c.bought_qty) as bought_total,
      sum(c.unknown_lines) as unknown_total,
      sum(c.purchase_lines) as lines_total
    from cells c
    group by c.item_id, c.name, c.unit
  ),
  item_rows as (
    select
      ic.*,
      case
        when ic.unknown_total > 0 then 'needs_conversion'
        when ic.used_total > 0 and ic.bought_total = 0 then 'no_purchase_link'
        -- big_gap: bought / used > 3 or < 1/3
        when ic.used_total > 0
          and (
            ic.bought_total / ic.used_total > 3
            or ic.bought_total / ic.used_total < 1.0 / 3.0
          ) then 'big_gap'
        else 'ok'
      end as status,
      case
        when ic.used_total > 0 and ic.bought_total > 0
          then round(ic.bought_total / ic.used_total, 2)
        else null
      end as ratio
    from item_cells ic
  ),
  report_items as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'kitchen_inventory_item_id', ir.item_id,
          'name', ir.name,
          'unit', ir.unit,
          'status', ir.status,
          'ratio', ir.ratio,
          'total', jsonb_build_object(
            'used_qty', round(ir.used_total, 3),
            'bought_qty', round(ir.bought_total, 3),
            'unknown_lines', ir.unknown_total,
            'purchase_lines', ir.lines_total
          ),
          'months', ir.months_json
        )
        order by
          case ir.status
            when 'big_gap' then 1
            when 'needs_conversion' then 2
            when 'no_purchase_link' then 3
            when 'ok' then 4
            else 5
          end,
          ir.used_total desc,
          ir.name
      ),
      '[]'::jsonb
    ) as items
    from item_rows ir
  ),
  extra as (
    select
      p.kitchen_inventory_item_id as item_id,
      coalesce(sum(p.book_qty) filter (where p.book_qty is not null), 0) as bought_qty,
      count(*) filter (where p.book_qty is null) as unknown_lines,
      count(*) as purchase_lines
    from purchases p
    where (p.receiving_location = 'q7' or p.source = 'payment_request')
      and not exists (
        select 1 from used_items ui where ui.item_id = p.kitchen_inventory_item_id
      )
    group by p.kitchen_inventory_item_id
  ),
  extra_rows as (
    select e.*, kii.name, kii.unit
    from extra e
    join public.kitchen_inventory_items kii on kii.id = e.item_id
  ),
  report_extra as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'kitchen_inventory_item_id', er.item_id,
          'name', er.name,
          'unit', er.unit,
          'bought_qty', round(er.bought_qty, 3),
          'unknown_lines', er.unknown_lines,
          'purchase_lines', er.purchase_lines,
          'status', 'not_in_recipe'
        )
        order by er.bought_qty desc, er.name
      ),
      '[]'::jsonb
    ) as extra
    from extra_rows er
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'months', v_months,
    'generated_at', now(),
    'items', ri.items,
    'q7_extra_purchases', re.extra
  )
  into v_result
  from report_items ri
  cross join report_extra re;

  return v_result;
end;
$$;

-- ===========================================================================
-- 3. Item detail RPC
-- ===========================================================================

create or replace function public.get_q7_purchase_usage_item_detail(
  p_item_id uuid,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_to date;
  v_item public.kitchen_inventory_items%rowtype;
  v_result jsonb;
begin
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or (
      auth.uid() is not null
      and (
        public.has_role(auth.uid(), 'owner'::app_role)
        or public.has_module_permission(auth.uid(), 'inventory', 'view')
        or public.has_module_permission(auth.uid(), 'q7_material_inventory', 'view')
      )
    )
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_to := coalesce(p_to, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_from := coalesce(
    p_from,
    (date_trunc('month', v_to::timestamp) - interval '2 months')::date
  );

  if v_from > v_to or (v_to - v_from + 1) > 366 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id;

  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  with purchases as (
    select *
    from public.q7_purchase_usage_purchase_lines(v_from, v_to)
    where kitchen_inventory_item_id = p_item_id
  ),
  usage_rows as (
    select i.finished_sku_id, i.required_qty
    from public.production_material_issues pmi
    join public.production_material_issue_items i on i.material_issue_id = pmi.id
    join public.kitchen_inventory_items kii on kii.id = i.kitchen_inventory_item_id
    where pmi.location_code = 'q7'
      and pmi.is_current is true
      and pmi.status in ('pdf_ready', 'posted')
      and pmi.issue_date between v_from and v_to
      and i.kitchen_inventory_item_id = p_item_id
      and i.kitchen_inventory_item_id is not null
      and coalesce(i.required_qty, 0) > 0
      and i.required_qty::text not in ('NaN', 'Infinity', '-Infinity')
      and coalesce(kii.item_class, '') <> 'non_stock'
      and exists (
        select 1
        from public.q7_material_issue_material_mappings m
        where m.approval_status = 'approved'
          and (
            m.id = i.q7_mapping_id
            or (
              i.q7_mapping_id is null
              and i.canonical_material_id is not null
              and m.canonical_material_id = i.canonical_material_id
            )
          )
      )
      and not exists (
        select 1
        from public.q7_bom_line_decisions d
        where d.active = true
          and d.action in ('not_tracked', 'bom_error')
          and d.canonical_material_id = i.canonical_material_id
          and lower(btrim(d.source_unit)) = lower(btrim(coalesce(i.source_unit, '')))
      )
  ),
  by_product as (
    select
      u.finished_sku_id,
      ps.sku_code,
      ps.product_name,
      sum(u.required_qty) as used_qty,
      count(*) as issue_count
    from usage_rows u
    left join public.product_skus ps on ps.id = u.finished_sku_id
    group by u.finished_sku_id, ps.sku_code, ps.product_name
    order by sum(u.required_qty) desc, ps.product_name nulls last
    limit 10
  )
  select jsonb_build_object(
    'kitchen_inventory_item_id', v_item.id,
    'name', v_item.name,
    'unit', v_item.unit,
    'from', v_from,
    'to', v_to,
    'purchases', coalesce(
      (
        select jsonb_agg(
          to_jsonb(p)
          order by p.doc_date desc, p.document_number desc, p.document_id
        )
        from purchases p
      ),
      '[]'::jsonb
    ),
    'usage_by_product', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'finished_sku_id', bp.finished_sku_id,
            'sku_code', bp.sku_code,
            'product_name', bp.product_name,
            'used_qty', round(bp.used_qty, 3),
            'issue_count', bp.issue_count
          )
          order by bp.used_qty desc, bp.product_name nulls last
        )
        from by_product bp
      ),
      '[]'::jsonb
    ),
    'used_qty', round(coalesce((select sum(u.required_qty) from usage_rows u), 0), 3),
    'bought_qty', round(coalesce((select sum(p.book_qty) from purchases p where p.book_qty is not null), 0), 3),
    'unknown_lines', (select count(*) from purchases p where p.book_qty is null)
  )
  into v_result;

  return v_result;
end;
$$;

-- ===========================================================================
-- 4. Grants
-- ===========================================================================

revoke all on function public.q7_purchase_usage_purchase_lines(date, date)
  from public, anon, authenticated;
grant execute on function public.q7_purchase_usage_purchase_lines(date, date)
  to service_role;

revoke all on function public.get_q7_purchase_usage_report(date, date)
  from public, anon;
grant execute on function public.get_q7_purchase_usage_report(date, date)
  to authenticated, service_role;

revoke all on function public.get_q7_purchase_usage_item_detail(uuid, date, date)
  from public, anon;
grant execute on function public.get_q7_purchase_usage_item_detail(uuid, date, date)
  to authenticated, service_role;
