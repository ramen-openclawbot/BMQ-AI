-- Heo Đất Tết — one-query reads for dealer-heo (replaces paging orders and items through the API).
-- Additive and re-runnable. Service role only.

-- Average BMQ-001 que per day for the 30 days of November 2026 (real, non-cancelled orders).
create or replace function public.dealer_heo_baseline_nov(p_customer_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(i.quantity), 0)::numeric / 30.0
  from public.dealer_orders o
  join public.dealer_order_items i on i.order_id = o.id and i.sku_code = 'BMQ-001'
  where o.customer_id = p_customer_id
    and o.is_test = false
    and o.status <> 'cancelled'
    and coalesce(o.requested_delivery_date, (o.submitted_at at time zone 'Asia/Ho_Chi_Minh')::date)
        between date '2026-11-01' and date '2026-11-30';
$$;

-- BMQ-001 que per delivery day for a dealer (real, non-cancelled orders), at most one row per day.
create or replace function public.dealer_heo_daily_quantities(p_customer_id uuid, p_start date, p_end date)
returns table (day date, quantity numeric)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(o.requested_delivery_date, (o.submitted_at at time zone 'Asia/Ho_Chi_Minh')::date) as day,
         sum(i.quantity)::numeric as quantity
  from public.dealer_orders o
  join public.dealer_order_items i on i.order_id = o.id and i.sku_code = 'BMQ-001'
  where o.customer_id = p_customer_id
    and o.is_test = false
    and o.status <> 'cancelled'
    and coalesce(o.requested_delivery_date, (o.submitted_at at time zone 'Asia/Ho_Chi_Minh')::date)
        between p_start and p_end
  group by 1
  order by 1;
$$;

revoke all on function public.dealer_heo_baseline_nov(uuid) from public, anon, authenticated;
grant execute on function public.dealer_heo_baseline_nov(uuid) to service_role;
revoke all on function public.dealer_heo_daily_quantities(uuid, date, date) from public, anon, authenticated;
grant execute on function public.dealer_heo_daily_quantities(uuid, date, date) to service_role;
