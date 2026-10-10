-- Backtest for the Q7 purchase forecast. SELECT only; never writes anything.
--
-- For each of the 28 forecast origins in [current_date - 34, current_date - 7]
-- (so every origin has a full 7-day actual window) and each Q7 item that already
-- has at least 14 days of issue history before that origin:
--   * forecast the next 7 days with data strictly before the origin using the
--     same blend as get_q7_purchase_forecast:
--        daily_usage = 0.6 * avg_14d + 0.4 * avg_28d;
--   * compare with the actual issues in [origin, origin + 6].
--
-- Output: one row per item (average relative absolute error), the cross-item
-- median error, and the share of items whose average error is <= 25%.

with origins as (
  select gs::date as origin
  from generate_series(
    (current_date - 34)::timestamp,
    (current_date - 7)::timestamp,
    interval '1 day'
  ) gs
),
items as (
  select kii.id as item_id, kii.name as item_name, kii.unit
  from public.kitchen_inventory_items kii
  where kii.active = true
    and exists (
      select 1
      from public.production_material_issues i
      join public.production_material_issue_items ii on ii.material_issue_id = i.id
      where ii.kitchen_inventory_item_id = kii.id
        and i.location_code = 'q7'
        and i.is_current is true
    )
),
daily as (
  select
    ii.kitchen_inventory_item_id as item_id,
    i.issue_date,
    sum(coalesce(ii.required_qty, 0)) as qty
  from public.production_material_issues i
  join public.production_material_issue_items ii on ii.material_issue_id = i.id
  where i.location_code = 'q7'
    and i.is_current is true
    and i.issue_date >= current_date - 62
  group by ii.kitchen_inventory_item_id, i.issue_date
),
pairs as (
  select
    it.item_id,
    it.item_name,
    o.origin,
    -- Data strictly before the origin.
    coalesce((
      select avg(coalesce(d.qty, 0))
      from generate_series((o.origin - 14)::timestamp, (o.origin - 1)::timestamp, interval '1 day') g
      left join daily d
        on d.item_id = it.item_id and d.issue_date = g::date
    ), 0) as avg_14d,
    coalesce((
      select avg(coalesce(d.qty, 0))
      from generate_series((o.origin - 28)::timestamp, (o.origin - 1)::timestamp, interval '1 day') g
      left join daily d
        on d.item_id = it.item_id and d.issue_date = g::date
    ), 0) as avg_28d,
    (select count(distinct d.issue_date)
       from daily d
      where d.item_id = it.item_id and d.issue_date < o.origin) as history_days,
    coalesce((
      select sum(coalesce(d.qty, 0))
      from generate_series(o.origin::timestamp, (o.origin + 6)::timestamp, interval '1 day') g
      left join daily d
        on d.item_id = it.item_id and d.issue_date = g::date
    ), 0) as actual_7d
  from items it
  cross join origins o
),
errors as (
  select
    item_id,
    item_name,
    abs((0.6 * avg_14d + 0.4 * avg_28d) * 7 - actual_7d) / greatest(actual_7d, 1) as rel_error
  from pairs
  where history_days >= 14
),
item_summary as (
  select item_id, item_name, avg(rel_error) as rel_error
  from errors
  group by item_id, item_name
)
select
  'item' as metric,
  item_name,
  round(rel_error::numeric, 4) as rel_error,
  null::numeric as extra
from item_summary

union all

select
  'median_error' as metric,
  null as item_name,
  round(percentile_cont(0.5) within group (order by rel_error)::numeric, 4) as rel_error,
  null::numeric as extra
from item_summary

union all

select
  'share_within_25pct' as metric,
  null as item_name,
  round(avg(case when rel_error <= 0.25 then 1 else 0 end)::numeric, 4) as rel_error,
  count(*)::numeric as extra
from item_summary

order by metric, rel_error desc nulls last;
