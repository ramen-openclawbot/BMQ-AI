-- Phase 7: canonical OCR cost reporting and dry-run backfill preview.
-- Reporting now prefers approved standard-cost metadata from invoice/PR lines,
-- uses invoice rows as final accounting source, and keeps pending review visible.

create or replace view public.cost_classification_line_details
with (security_invoker = true)
as
select
  clc.id as classification_id,
  clc.source_type,
  clc.source_line_id,
  clc.payment_request_id,
  clc.invoice_id,
  coalesce(pr.request_number, inv.invoice_number) as source_number,
  coalesce(pr.paid_at::date, pr.created_at::date, inv.invoice_date) as source_date,
  coalesce(pr.status::text, 'invoice') as source_status,
  coalesce(pr.payment_status::text, null) as payment_status,
  clc.supplier_id,
  s.name as supplier_name,
  coalesce(pri.canonical_cost_item_name, pri.raw_product_name, pri.product_name) as product_name,
  coalesce(pri.confirmed_standard_cost_code, pri.suggested_standard_cost_code, pri.product_code) as product_code,
  pri.unit,
  pri.quantity,
  pri.unit_price,
  coalesce(pri.line_total, pri.quantity * pri.unit_price, 0)::numeric as line_amount,
  coalesce(pri.cost_category_code, clc.category_code) as category_code,
  cc.label as category_label,
  cc.cost_group,
  coalesce(pri.cost_product_line, clc.product_line) as product_line,
  clc.revenue_channel,
  coalesce(pri.cost_allocation_rule, clc.allocation_rule) as allocation_rule,
  clc.confidence,
  coalesce(pri.canonical_cost_item_source, clc.classification_source) as classification_source,
  clc.rule_id,
  case
    when pri.cost_review_routing = 'needs_review' or coalesce(pri.cost_category_code, clc.category_code) = 'UNMAPPED_REVIEW' then 'needs_review'
    when clc.review_status = 'approved' then 'approved'
    else clc.review_status
  end as review_status,
  clc.updated_at
from public.cost_line_classifications clc
join public.payment_request_items pri
  on clc.source_type = 'payment_request_item'
  and clc.source_line_id = pri.id
left join public.payment_requests pr
  on pri.payment_request_id = pr.id
left join public.invoices inv
  on false
left join public.suppliers s
  on coalesce(clc.supplier_id, pr.supplier_id) = s.id
join public.cost_categories cc
  on coalesce(pri.cost_category_code, clc.category_code) = cc.code
where coalesce(pr.invoice_created, false) = false
  and pr.invoice_id is null
union all
select
  clc.id as classification_id,
  clc.source_type,
  clc.source_line_id,
  clc.payment_request_id,
  clc.invoice_id,
  coalesce(inv.invoice_number, pr.request_number) as source_number,
  coalesce(inv.invoice_date, pr.paid_at::date, pr.created_at::date) as source_date,
  'invoice' as source_status,
  coalesce(pr.payment_status::text, null) as payment_status,
  clc.supplier_id,
  s.name as supplier_name,
  coalesce(ii.canonical_cost_item_name, ii.raw_product_name, ii.product_name) as product_name,
  coalesce(ii.confirmed_standard_cost_code, ii.suggested_standard_cost_code, ii.product_code) as product_code,
  ii.unit,
  ii.quantity,
  ii.unit_price,
  coalesce(ii.line_total, ii.quantity * ii.unit_price, 0)::numeric as line_amount,
  coalesce(ii.cost_category_code, clc.category_code) as category_code,
  cc.label as category_label,
  cc.cost_group,
  coalesce(ii.cost_product_line, clc.product_line) as product_line,
  clc.revenue_channel,
  coalesce(ii.cost_allocation_rule, clc.allocation_rule) as allocation_rule,
  clc.confidence,
  coalesce(ii.canonical_cost_item_source, clc.classification_source) as classification_source,
  clc.rule_id,
  case
    when ii.cost_review_routing = 'needs_review' or coalesce(ii.cost_category_code, clc.category_code) = 'UNMAPPED_REVIEW' then 'needs_review'
    when clc.review_status = 'approved' then 'approved'
    else clc.review_status
  end as review_status,
  clc.updated_at
from public.cost_line_classifications clc
join public.invoice_items ii
  on clc.source_type = 'invoice_item'
  and clc.source_line_id = ii.id
left join public.invoices inv
  on ii.invoice_id = inv.id
left join public.payment_requests pr
  on inv.payment_request_id = pr.id
left join public.suppliers s
  on coalesce(clc.supplier_id, inv.supplier_id, pr.supplier_id) = s.id
join public.cost_categories cc
  on coalesce(ii.cost_category_code, clc.category_code) = cc.code
union all
select
  pri.id as classification_id,
  'payment_request_item'::text as source_type,
  pri.id as source_line_id,
  pri.payment_request_id,
  null::uuid as invoice_id,
  pr.request_number as source_number,
  coalesce(pr.paid_at::date, pr.created_at::date) as source_date,
  pr.status::text as source_status,
  pr.payment_status::text as payment_status,
  pr.supplier_id,
  s.name as supplier_name,
  coalesce(pri.canonical_cost_item_name, pri.raw_product_name, pri.product_name) as product_name,
  coalesce(pri.confirmed_standard_cost_code, pri.suggested_standard_cost_code, pri.product_code) as product_code,
  pri.unit,
  pri.quantity,
  pri.unit_price,
  coalesce(pri.line_total, pri.quantity * pri.unit_price, 0)::numeric as line_amount,
  coalesce(pri.cost_category_code, 'UNMAPPED_REVIEW') as category_code,
  cc.label as category_label,
  cc.cost_group,
  coalesce(pri.cost_product_line, 'general') as product_line,
  null::text as revenue_channel,
  coalesce(pri.cost_allocation_rule, 'none') as allocation_rule,
  case when pri.cost_review_routing = 'needs_review' then 0::numeric else 1::numeric end as confidence,
  coalesce(pri.canonical_cost_item_source, 'ocr_standard_cost') as classification_source,
  null::uuid as rule_id,
  case
    when pri.cost_review_routing = 'needs_review' or coalesce(pri.cost_category_code, 'UNMAPPED_REVIEW') = 'UNMAPPED_REVIEW' then 'needs_review'
    else 'approved'
  end as review_status,
  pri.created_at as updated_at
from public.payment_request_items pri
join public.payment_requests pr
  on pri.payment_request_id = pr.id
left join public.suppliers s
  on pr.supplier_id = s.id
join public.cost_categories cc
  on coalesce(pri.cost_category_code, 'UNMAPPED_REVIEW') = cc.code
where (
    pri.cost_category_code is not null
    or pri.cost_review_routing = 'needs_review'
    or pri.confirmed_standard_cost_code is not null
    or pri.suggested_standard_cost_code is not null
  )
  and coalesce(pr.invoice_created, false) = false
  and pr.invoice_id is null
  and not exists (
    select 1
    from public.cost_line_classifications clc
    where clc.source_type = 'payment_request_item'
      and clc.source_line_id = pri.id
  )
union all
select
  ii.id as classification_id,
  'invoice_item'::text as source_type,
  ii.id as source_line_id,
  inv.payment_request_id,
  ii.invoice_id,
  inv.invoice_number as source_number,
  inv.invoice_date as source_date,
  'invoice'::text as source_status,
  pr.payment_status::text as payment_status,
  coalesce(inv.supplier_id, pr.supplier_id) as supplier_id,
  s.name as supplier_name,
  coalesce(ii.canonical_cost_item_name, ii.raw_product_name, ii.product_name) as product_name,
  coalesce(ii.confirmed_standard_cost_code, ii.suggested_standard_cost_code, ii.product_code) as product_code,
  ii.unit,
  ii.quantity,
  ii.unit_price,
  coalesce(ii.line_total, ii.quantity * ii.unit_price, 0)::numeric as line_amount,
  coalesce(ii.cost_category_code, 'UNMAPPED_REVIEW') as category_code,
  cc.label as category_label,
  cc.cost_group,
  coalesce(ii.cost_product_line, 'general') as product_line,
  null::text as revenue_channel,
  coalesce(ii.cost_allocation_rule, 'none') as allocation_rule,
  case when ii.cost_review_routing = 'needs_review' then 0::numeric else 1::numeric end as confidence,
  coalesce(ii.canonical_cost_item_source, 'ocr_standard_cost') as classification_source,
  null::uuid as rule_id,
  case
    when ii.cost_review_routing = 'needs_review' or coalesce(ii.cost_category_code, 'UNMAPPED_REVIEW') = 'UNMAPPED_REVIEW' then 'needs_review'
    else 'approved'
  end as review_status,
  ii.created_at as updated_at
from public.invoice_items ii
join public.invoices inv
  on ii.invoice_id = inv.id
left join public.payment_requests pr
  on inv.payment_request_id = pr.id
left join public.suppliers s
  on coalesce(inv.supplier_id, pr.supplier_id) = s.id
join public.cost_categories cc
  on coalesce(ii.cost_category_code, 'UNMAPPED_REVIEW') = cc.code
where (
    ii.cost_category_code is not null
    or ii.cost_review_routing = 'needs_review'
    or ii.confirmed_standard_cost_code is not null
    or ii.suggested_standard_cost_code is not null
  )
  and not exists (
    select 1
    from public.cost_line_classifications clc
    where clc.source_type = 'invoice_item'
      and clc.source_line_id = ii.id
  );

create or replace view public.cost_classification_category_summary
with (security_invoker = true)
as
select
  category_code,
  category_label,
  cost_group,
  product_line,
  allocation_rule,
  review_status,
  count(*)::integer as line_count,
  coalesce(sum(line_amount), 0)::numeric as total_amount,
  min(source_date) as first_source_date,
  max(source_date) as last_source_date
from public.cost_classification_line_details
group by category_code, category_label, cost_group, product_line, allocation_rule, review_status;

create or replace view public.cost_classification_monthly_summary
with (security_invoker = true)
as
select
  date_trunc('month', source_date)::date as month,
  category_code,
  category_label,
  cost_group,
  product_line,
  allocation_rule,
  review_status,
  count(*)::integer as line_count,
  coalesce(sum(line_amount), 0)::numeric as total_amount
from public.cost_classification_line_details
group by date_trunc('month', source_date)::date, category_code, category_label, cost_group, product_line, allocation_rule, review_status;

create or replace view public.cost_classification_ocr_backfill_preview
with (security_invoker = true)
as
select
  'payment_request_item'::text as source_type,
  pri.id as source_line_id,
  pri.payment_request_id,
  null::uuid as invoice_id,
  pr.request_number as source_number,
  coalesce(pr.paid_at::date, pr.created_at::date) as source_date,
  pr.supplier_id,
  s.name as supplier_name,
  pri.product_name,
  pri.raw_product_name,
  pri.standard_cost_code_type,
  coalesce(pri.confirmed_standard_cost_code, pri.suggested_standard_cost_code) as standard_cost_code,
  pri.canonical_cost_item_name,
  coalesce(pri.cost_category_code, 'UNMAPPED_REVIEW') as category_code,
  pri.cost_review_routing,
  coalesce(pri.line_total, pri.quantity * pri.unit_price, 0)::numeric as line_amount,
  case
    when pri.cost_review_routing = 'needs_review' or pri.cost_category_code is null then 'pending_review'
    when pri.confirmed_standard_cost_code is not null or pri.suggested_standard_cost_code is not null then 'canonical_ready'
    else 'category_only'
  end as preview_status
from public.payment_request_items pri
join public.payment_requests pr
  on pri.payment_request_id = pr.id
left join public.suppliers s
  on pr.supplier_id = s.id
where coalesce(pr.invoice_created, false) = false
  and pr.invoice_id is null
  and not exists (
    select 1
    from public.cost_line_classifications clc
    where clc.source_type = 'payment_request_item'
      and clc.source_line_id = pri.id
  )
  and (
    pri.cost_category_code is not null
    or pri.cost_review_routing = 'needs_review'
    or pri.confirmed_standard_cost_code is not null
    or pri.suggested_standard_cost_code is not null
  )
union all
select
  'invoice_item'::text as source_type,
  ii.id as source_line_id,
  inv.payment_request_id,
  ii.invoice_id,
  inv.invoice_number as source_number,
  inv.invoice_date as source_date,
  coalesce(inv.supplier_id, pr.supplier_id) as supplier_id,
  s.name as supplier_name,
  ii.product_name,
  ii.raw_product_name,
  ii.standard_cost_code_type,
  coalesce(ii.confirmed_standard_cost_code, ii.suggested_standard_cost_code) as standard_cost_code,
  ii.canonical_cost_item_name,
  coalesce(ii.cost_category_code, 'UNMAPPED_REVIEW') as category_code,
  ii.cost_review_routing,
  coalesce(ii.line_total, ii.quantity * ii.unit_price, 0)::numeric as line_amount,
  case
    when ii.cost_review_routing = 'needs_review' or ii.cost_category_code is null then 'pending_review'
    when ii.confirmed_standard_cost_code is not null or ii.suggested_standard_cost_code is not null then 'canonical_ready'
    else 'category_only'
  end as preview_status
from public.invoice_items ii
join public.invoices inv
  on ii.invoice_id = inv.id
left join public.payment_requests pr
  on inv.payment_request_id = pr.id
left join public.suppliers s
  on coalesce(inv.supplier_id, pr.supplier_id) = s.id
where not exists (
    select 1
    from public.cost_line_classifications clc
    where clc.source_type = 'invoice_item'
      and clc.source_line_id = ii.id
  )
  and (
    ii.cost_category_code is not null
    or ii.cost_review_routing = 'needs_review'
    or ii.confirmed_standard_cost_code is not null
    or ii.suggested_standard_cost_code is not null
  );

grant select on public.cost_classification_line_details to authenticated;
grant select on public.cost_classification_category_summary to authenticated;
grant select on public.cost_classification_monthly_summary to authenticated;
grant select on public.cost_classification_ocr_backfill_preview to authenticated;
