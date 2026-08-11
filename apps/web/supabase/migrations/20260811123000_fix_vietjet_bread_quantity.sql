-- Repair numeric extraction in the deployed VietJet helper. The original
-- regular expression escaped \d as a literal backslash under PostgreSQL's
-- standard-conforming strings and returned zero for valid JSON numbers.

create or replace function public.get_latest_vietjet_bread_quantity(p_order_date date)
returns table (
  quantity numeric,
  inbox_id uuid,
  received_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select
    case
      when coalesce(item.value->>'qty', item.value->>'ordered_qty', item.value->>'revenue_qty', '')
        ~ '^[0-9]+([.][0-9]+)?$'
      then coalesce(item.value->>'qty', item.value->>'ordered_qty', item.value->>'revenue_qty')::numeric
      else 0::numeric
    end as quantity,
    inbox.id as inbox_id,
    inbox.received_at
  from public.customer_po_inbox inbox
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(inbox.production_items) = 'array' then inbox.production_items
      else '[]'::jsonb
    end
  ) item(value)
  where lower(coalesce(inbox.from_email, '')) like '%vietjetair.com%'
    and coalesce(item.value->>'service_date', item.value->>'date') = p_order_date::text
    and coalesce(item.value->>'product_code', item.value->>'sku_code', item.value->>'sku') = '40000294'
  order by inbox.received_at desc, inbox.id desc
  limit 1;
end;
$$;

revoke all on function public.get_latest_vietjet_bread_quantity(date) from public;
revoke all on function public.get_latest_vietjet_bread_quantity(date) from anon;
revoke all on function public.get_latest_vietjet_bread_quantity(date) from authenticated;
grant execute on function public.get_latest_vietjet_bread_quantity(date) to service_role;
