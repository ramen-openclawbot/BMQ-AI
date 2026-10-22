-- Smoke test for 20261102660000_cogs_production_location.sql.
--
-- Run with:  supabase db query --linked -f scripts/smoke_cogs_production_location.sql
-- Maestro pastes the migration before this file.  The whole file is one
-- transaction and the final RAISE aborts it, so nothing is committed.
--
-- It copies the approved 2026-10-22 40000294 lines (banh mi, seeded tan_tao)
-- and one Q7 banh ngot line whose mapped SKU uses Muoi say, then prints the
-- exploded COGS rows (sku_code, depth, material, summed stock qty, location,
-- status).  The Q7 line gets a q7 production-location row inside this
-- transaction to exercise the override; the base lines use the migration seed.

begin;

do $$
declare
  v_base_copied integer;
  v_q7_line_id uuid;
  v_q7_sku_id uuid;
  v_q7_sku_code text;
  v_result text;
begin
  insert into public.revenue_ledger_lines (
    id, source_document_id, source_row_number, period, revenue_date, channel,
    source_tab, branch, invoice_no, customer_id, parent_customer_id,
    customer_code, customer_name, product_code, product_name, item_note,
    quantity, unit_price, gross_revenue, order_gross, order_discount,
    customer_payable, source_type, approval_status, audit_status,
    confidence_status, review_status, reconciliation_status, source_ref,
    raw_payload
  )
  select
    gen_random_uuid(), l.source_document_id, l.source_row_number + 900000,
    to_char(date '2026-10-26', 'YYYY-MM'), date '2026-10-26', l.channel,
    l.source_tab, l.branch, 'SMOKE-PRODLOC', l.customer_id,
    l.parent_customer_id, l.customer_code, l.customer_name, l.product_code,
    l.product_name, l.item_note, l.quantity, l.unit_price, l.gross_revenue,
    l.order_gross, l.order_discount, l.customer_payable, l.source_type,
    l.approval_status, l.audit_status, l.confidence_status, l.review_status,
    l.reconciliation_status, l.source_ref, l.raw_payload
  from public.revenue_ledger_lines l
  where l.approval_status = 'approved'
    and l.revenue_date = date '2026-10-22'
    and l.product_code ilike '%40000294%';
  get diagnostics v_base_copied = row_count;
  if v_base_copied = 0 then
    raise exception 'smoke: no approved 2026-10-22 revenue line for 40000294';
  end if;

  select l.id, m.sku_id, ps.sku_code
    into v_q7_line_id, v_q7_sku_id, v_q7_sku_code
  from public.revenue_ledger_lines l
  join lateral (
    select m.sku_id
    from public.revenue_product_sku_map m
    where m.status in ('auto', 'confirmed')
      and m.sku_id is not null
      and (
        (l.product_code is not null and btrim(l.product_code) <> ''
         and m.product_code is not null
         and lower(m.product_code) = lower(l.product_code)
         and lower(coalesce(m.channel, '')) = lower(coalesce(l.channel, '')))
        or (l.product_code is not null and btrim(l.product_code) <> ''
            and m.product_code is not null
            and lower(m.product_code) = lower(l.product_code))
        or (coalesce(btrim(l.product_code), '') = ''
            and m.name_key = regexp_replace(
              coalesce(public.normalize_stock_item_name(l.product_name), ''),
              '^bmq\s*-\s*', '', 'i'
            ))
      )
    order by (m.status = 'confirmed') desc, m.updated_at desc, m.id::text
    limit 1
  ) m on true
  join public.product_skus ps on ps.id = m.sku_id
  where l.approval_status = 'approved'
    and l.revenue_date = date '2026-10-22'
    and l.quantity > 0
    and public.normalize_stock_item_name(l.channel) like '%banh ngot%'
    and (l.product_code is null or l.product_code not ilike '%40000294%')
    and exists (
      select 1
      from public.sku_cogs_versions v
      join public.sku_cogs_version_formulations f on f.version_id = v.id
      left join public.sku_cogs_materials mat on mat.id = f.canonical_material_id
      where v.sku_id = m.sku_id
        and (
          public.normalize_stock_item_name(f.ingredient_name) like '%muoi say%'
          or public.normalize_stock_item_name(mat.canonical_name) like '%muoi say%'
        )
    )
  order by l.id
  limit 1;

  if v_q7_line_id is null then
    raise exception 'smoke: no approved 2026-10-22 Q7 banh ngot line mapped to a SKU using Muoi say';
  end if;

  insert into public.revenue_ledger_lines (
    id, source_document_id, source_row_number, period, revenue_date, channel,
    source_tab, branch, invoice_no, customer_id, parent_customer_id,
    customer_code, customer_name, product_code, product_name, item_note,
    quantity, unit_price, gross_revenue, order_gross, order_discount,
    customer_payable, source_type, approval_status, audit_status,
    confidence_status, review_status, reconciliation_status, source_ref,
    raw_payload
  )
  select
    gen_random_uuid(), l.source_document_id, l.source_row_number + 900000,
    to_char(date '2026-10-26', 'YYYY-MM'), date '2026-10-26', l.channel,
    l.source_tab, l.branch, 'SMOKE-PRODLOC', l.customer_id,
    l.parent_customer_id, l.customer_code, l.customer_name, l.product_code,
    l.product_name, l.item_note, l.quantity, l.unit_price, l.gross_revenue,
    l.order_gross, l.order_discount, l.customer_payable, l.source_type,
    l.approval_status, l.audit_status, l.confidence_status, l.review_status,
    l.reconciliation_status, l.source_ref, l.raw_payload
  from public.revenue_ledger_lines l
  where l.id = v_q7_line_id;

  insert into public.cogs_sku_production_location (sku_id, location)
  values (v_q7_sku_id, 'q7')
  on conflict (sku_id) do update
    set location = excluded.location,
        updated_at = now();

  select coalesce(string_agg(
           format(
             'sku_code=%s | depth=%s | material_name=%s | location=%s | sum_stock_qty=%s | status=%s',
             x.sku_code, x.depth, x.material_name, x.location,
             coalesce(x.stock_qty::text, 'null'), x.status
           ),
           ' || ' order by x.sku_code, x.depth, x.material_name, x.location, x.status
         ), '(none)')
    into v_result
  from (
    select e.sku_code, e.depth, e.material_name, sum(e.stock_qty) as stock_qty,
           e.location, e.status
    from public.cogs_explode_revenue(date '2026-10-26', date '2026-10-26') e
    join public.revenue_ledger_lines l on l.id = e.revenue_line_id
    where l.invoice_no = 'SMOKE-PRODLOC'
      and l.revenue_date = date '2026-10-26'
      and l.source_row_number >= 900000
    group by e.sku_code, e.depth, e.material_name, e.location, e.status
  ) x;

  raise exception 'SMOKE_RESULT base_copied=% q7_sku=% rows=%',
    v_base_copied, v_q7_sku_code, v_result;
end;
$$;

rollback;
