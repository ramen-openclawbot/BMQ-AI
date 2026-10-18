-- Smoke test for the Q7 purchase-vs-usage report.
-- Runs entirely inside BEGIN ... ROLLBACK and only reads data.
-- Prerequisites: Q7 material issues / receipts already exist for the range.
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_q7_purchase_usage.sql
-- The agent never runs this against a live database.

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

-- Item counts per status for 2026-08-01 .. 2026-10-19.
with report as (
  select public.get_q7_purchase_usage_report(
    '2026-08-01'::date,
    '2026-10-19'::date
  ) as body
),
items as (
  select value as item
  from report
  cross join jsonb_array_elements(report.body -> 'items') as value
)
select
  item ->> 'status' as status,
  count(*) as item_count
from items
group by item ->> 'status'
order by status;

-- The three materials the owner asked about.
with report as (
  select public.get_q7_purchase_usage_report(
    '2026-08-01'::date,
    '2026-10-19'::date
  ) as body
),
items as (
  select value as item
  from report
  cross join jsonb_array_elements(report.body -> 'items') as value
)
select
  item ->> 'name' as name,
  item ->> 'unit' as unit,
  item ->> 'status' as status,
  item ->> 'ratio' as ratio,
  item -> 'total' as total
from items
where item ->> 'name' ilike 'Bột mì 888%'
   or item ->> 'name' ilike 'Peerless%'
   or item ->> 'name' ilike 'Trứng gà%'
order by item ->> 'name';

-- Detail for the first item returned by the report.
select d.detail
from (
  select (value ->> 'kitchen_inventory_item_id')::uuid as item_id
  from jsonb_array_elements(
    public.get_q7_purchase_usage_report(
      '2026-08-01'::date,
      '2026-10-19'::date
    ) -> 'items'
  ) as value
  limit 1
) first_item
cross join lateral public.get_q7_purchase_usage_item_detail(
  first_item.item_id,
  '2026-08-01'::date,
  '2026-10-19'::date
) as d(detail);

rollback;
