-- Dealer-facing order history summary. Browser clients never execute this RPC directly.

create index if not exists dealer_orders_customer_submitted_idx
  on public.dealer_orders (customer_id, submitted_at desc);

create or replace function public.dealer_order_history_summary(
  p_customer_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns table (
  order_count bigint,
  total_physical_quantity numeric,
  total_amount_vnd numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with filtered_orders as (
    select o.id, o.total_amount_vnd
    from public.dealer_orders o
    where o.customer_id = p_customer_id
      and o.submitted_at >= p_start
      and o.submitted_at < p_end
  ),
  physical_by_order as (
    select
      i.order_id,
      sum(
        coalesce(
          i.physical_quantity,
          coalesce(i.ordered_quantity, i.quantity)
            + i.exchange_quantity
            + i.makeup_quantity
        )
      ) as physical_quantity
    from public.dealer_order_items i
    join filtered_orders o on o.id = i.order_id
    group by i.order_id
  )
  select
    count(*)::bigint as order_count,
    coalesce(sum(coalesce(p.physical_quantity, 0)), 0)::numeric as total_physical_quantity,
    coalesce(sum(o.total_amount_vnd), 0)::numeric as total_amount_vnd
  from filtered_orders o
  left join physical_by_order p on p.order_id = o.id;
$$;

revoke all on function public.dealer_order_history_summary(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.dealer_order_history_summary(uuid, timestamptz, timestamptz)
  to service_role;
