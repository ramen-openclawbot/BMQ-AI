-- Dealer cart assistant daily usage quota.
--
-- One row per dealer customer per Vietnam calendar day. The assistant consumes
-- one turn before calling DeepSeek; increment_dealer_cart_assistant_usage locks
-- the row so concurrent requests cannot both slip past the daily limit.
--
-- Security:
--   * RLS is enabled with no policy, so anon/authenticated cannot read or write.
--   * Table privileges are revoked from public, anon and authenticated; only
--     service_role keeps access for the Edge Function.
--   * The SECURITY DEFINER RPC is also service_role only.
-- This migration does not touch dealer_orders, dealer_order_items, product_skus
-- or any price table.

create table if not exists public.dealer_cart_assistant_usage (
  dealer_customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  usage_date date not null,
  count integer not null default 0,
  constraint dealer_cart_assistant_usage_count_check check (count >= 0),
  primary key (dealer_customer_id, usage_date)
);

alter table public.dealer_cart_assistant_usage enable row level security;

revoke all on table public.dealer_cart_assistant_usage from public, anon, authenticated;
grant select, insert, update, delete on table public.dealer_cart_assistant_usage to service_role;

create or replace function public.increment_dealer_cart_assistant_usage(
  p_customer_id uuid,
  p_limit integer
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usage_date date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_count integer;
begin
  if p_customer_id is null then
    raise exception 'invalid_customer_id' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  -- Ensure the row exists, then lock it for the read-modify-write below. A
  -- concurrent first call blocks on the conflict until this transaction ends.
  insert into public.dealer_cart_assistant_usage (dealer_customer_id, usage_date, count)
  values (p_customer_id, v_usage_date, 0)
  on conflict (dealer_customer_id, usage_date) do nothing;

  select count into v_count
  from public.dealer_cart_assistant_usage
  where dealer_customer_id = p_customer_id
    and usage_date = v_usage_date
  for update;

  if v_count >= p_limit then
    return jsonb_build_object('allowed', false, 'count', v_count);
  end if;

  update public.dealer_cart_assistant_usage
     set count = count + 1
   where dealer_customer_id = p_customer_id
     and usage_date = v_usage_date
  returning count into v_count;

  return jsonb_build_object('allowed', true, 'count', v_count);
end;
$$;

revoke all on function public.increment_dealer_cart_assistant_usage(uuid, integer) from public, anon, authenticated;
grant execute on function public.increment_dealer_cart_assistant_usage(uuid, integer) to service_role;

-- Rollback:
--   drop function if exists public.increment_dealer_cart_assistant_usage(uuid, integer);
--   drop table if exists public.dealer_cart_assistant_usage;
