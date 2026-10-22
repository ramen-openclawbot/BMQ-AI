-- Smoke test for 20261102650000_cogs_subrecipe_autolink.sql.
--
-- Run with:  supabase db query --linked -f scripts/smoke_cogs_subrecipe_autolink.sql
-- Maestro pastes the migration before this file.  The whole file is one
-- transaction and the final RAISE aborts it, so nothing is committed.
--
-- It clears the live ingredient_sku_id link on the latest BMQ-003 "Đồ chua"
-- sub-recipe row, copies the approved 2026-10-22 revenue lines for product
-- code 40000294 to 2026-10-26, then prints the exploded COGS rows for the
-- copied lines (depth, material, summed recipe quantity, location, status).

begin;

do $$
declare
  v_sku_id uuid;
  v_version_id uuid;
  v_cleared integer;
  v_copied integer;
  v_result text;
begin
  select ps.id into v_sku_id
  from public.product_skus ps
  where upper(btrim(ps.sku_code)) = 'BMQ-003'
  order by ps.id::text
  limit 1;
  if v_sku_id is null then
    raise exception 'smoke: BMQ-003 SKU not found';
  end if;

  select v.id into v_version_id
  from public.sku_cogs_versions v
  where v.sku_id = v_sku_id
  order by v.effective_from desc, v.version_no desc, v.id::text desc
  limit 1;
  if v_version_id is null then
    raise exception 'smoke: BMQ-003 has no COGS version';
  end if;

  update public.sku_cogs_version_formulations f
  set ingredient_sku_id = null
  where f.version_id = v_version_id
    and public.normalize_ocr_cost_key(f.ingredient_name) = 'do chua';
  get diagnostics v_cleared = row_count;
  if v_cleared <> 1 then
    raise exception 'smoke: expected one BMQ-003 Đồ chua row in version %, cleared %',
      v_version_id, v_cleared;
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
    l.source_tab, l.branch, 'SMOKE-AUTOLINK', l.customer_id,
    l.parent_customer_id, l.customer_code, l.customer_name, l.product_code,
    l.product_name, l.item_note, l.quantity, l.unit_price, l.gross_revenue,
    l.order_gross, l.order_discount, l.customer_payable, l.source_type,
    l.approval_status, l.audit_status, l.confidence_status, l.review_status,
    l.reconciliation_status, l.source_ref, l.raw_payload
  from public.revenue_ledger_lines l
  where l.approval_status = 'approved'
    and l.revenue_date = date '2026-10-22'
    and l.product_code ilike '%40000294%';
  get diagnostics v_copied = row_count;
  if v_copied = 0 then
    raise exception 'smoke: no approved 2026-10-22 revenue line for 40000294';
  end if;

  select coalesce(string_agg(
           format(
             'depth=%s | material_name=%s | sum_recipe_qty=%s | location=%s | status=%s',
             x.depth, x.material_name, x.recipe_qty, x.location, x.status
           ),
           ' || ' order by x.depth, x.material_name, x.location, x.status
         ), '(none)')
    into v_result
  from (
    select e.depth, e.material_name, sum(e.recipe_qty) as recipe_qty,
           e.location, e.status
    from public.cogs_explode_revenue(date '2026-10-26', date '2026-10-26') e
    join public.revenue_ledger_lines l on l.id = e.revenue_line_id
    where l.invoice_no = 'SMOKE-AUTOLINK'
      and l.revenue_date = date '2026-10-26'
      and l.source_row_number >= 900000
    group by e.depth, e.material_name, e.location, e.status
  ) x;

  raise exception 'SMOKE_RESULT copied=% cleared_version=% rows=%',
    v_copied, v_version_id, v_result;
end;
$$;

rollback;
