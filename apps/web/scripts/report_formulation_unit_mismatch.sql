-- Read-only report: formulation lines whose dosage unit probably mismatches unit_price.
--
-- Run from the repo root, no transaction and no writes:
--   supabase db query --linked -f scripts/report_formulation_unit_mismatch.sql
--
-- It only reads the current sku_cogs_versions row of each active finished-goods
-- SKU (latest effective_from <= current_date) and prints suspicious lines.

-- 1. unit is g/ml, unit_price is per kg/l, but dosage_qty is under 1: the
--    dosage was probably typed in kg/l while unit is the material default.
with current_version as (
  select distinct on (v.sku_id)
    v.id as version_id,
    v.sku_id,
    v.version_no,
    v.product_snapshot
  from public.sku_cogs_versions v
  where v.effective_from <= current_date
  order by v.sku_id, v.effective_from desc, v.version_no desc, v.id::text desc
)
select
  ps.sku_code,
  ps.product_name,
  cv.version_no,
  f.ingredient_name,
  f.unit,
  f.dosage_qty,
  f.unit_price,
  f.dosage_qty * f.unit_price as line_cost
from current_version cv
join public.product_skus ps on ps.id = cv.sku_id
join public.sku_cogs_version_formulations f on f.version_id = cv.version_id
where ps.discontinued_at is null
  and ps.sku_type::text = 'finished_good'
  and f.dosage_unit is null
  and public.normalize_document_unit(f.unit) in ('g', 'ml')
  and f.unit_price >= 1000
  and f.dosage_qty < 1
order by ps.sku_code, f.sort_order, f.ingredient_name;

-- 2. unit is kg/l and dosage_qty is at least 10 on a 1-unit output: possible
--    grams typed on a kg line (e.g. BMQ-001 Pate heo 25 Kg).
with current_version as (
  select distinct on (v.sku_id)
    v.id as version_id,
    v.sku_id,
    v.version_no,
    v.product_snapshot
  from public.sku_cogs_versions v
  where v.effective_from <= current_date
  order by v.sku_id, v.effective_from desc, v.version_no desc, v.id::text desc
)
select
  ps.sku_code,
  ps.product_name,
  cv.version_no,
  f.ingredient_name,
  f.unit,
  f.dosage_qty,
  f.unit_price,
  f.dosage_qty * f.unit_price as line_cost
from current_version cv
join public.product_skus ps on ps.id = cv.sku_id
join public.sku_cogs_version_formulations f on f.version_id = cv.version_id
where ps.discontinued_at is null
  and ps.sku_type::text = 'finished_good'
  and public.normalize_document_unit(f.unit) in ('kg', 'l')
  and f.dosage_qty >= 10
  and coalesce(
    case
      when coalesce(cv.product_snapshot ->> 'finished_output_qty', '') ~ '^[0-9]+(\.[0-9]+)?$'
        then (cv.product_snapshot ->> 'finished_output_qty')::numeric
    end,
    ps.finished_output_qty
  ) = 1
order by ps.sku_code, f.sort_order, f.ingredient_name;
