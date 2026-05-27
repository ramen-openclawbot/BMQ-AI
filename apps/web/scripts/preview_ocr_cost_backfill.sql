-- Dry-run only: summarize OCR standard-cost rows that would enter canonical cost reporting.
-- Run after the Phase 7 reporting migration is available. This script does not write data.
-- Usage:
--   psql "$DATABASE_URL" \
--     -v month_start=2026-05-01 \
--     -v month_end=2026-05-31 \
--     -f scripts/preview_ocr_cost_backfill.sql

select
  preview_status,
  category_code,
  standard_cost_code_type,
  count(*)::integer as line_count,
  coalesce(sum(line_amount), 0)::numeric as total_amount
from public.cost_classification_ocr_backfill_preview
where source_date >= :'month_start'::date
  and source_date <= :'month_end'::date
group by preview_status, category_code, standard_cost_code_type
order by
  case preview_status
    when 'pending_review' then 1
    when 'canonical_ready' then 2
    else 3
  end,
  total_amount desc;

select
  source_type,
  source_number,
  source_date,
  supplier_name,
  coalesce(canonical_cost_item_name, raw_product_name, product_name) as display_name,
  standard_cost_code_type,
  standard_cost_code,
  category_code,
  cost_review_routing,
  line_amount,
  preview_status
from public.cost_classification_ocr_backfill_preview
where source_date >= :'month_start'::date
  and source_date <= :'month_end'::date
order by
  case preview_status
    when 'pending_review' then 1
    when 'canonical_ready' then 2
    else 3
  end,
  line_amount desc
limit 200;
