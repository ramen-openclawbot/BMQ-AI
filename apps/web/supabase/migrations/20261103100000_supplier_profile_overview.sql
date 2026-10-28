-- Hồ sơ nhà cung cấp — the read-only data behind the Nhà cung cấp page.
--
-- 2026-11-03. This migration only adds reviewed source; it is not applied live
-- by the Harness. It:
--   * adds suppliers.contact_name (nullable, at most 120 trimmed characters)
--     without touching any other column or any existing row;
--   * adds supplier_profile_overview(), a stable SECURITY DEFINER read RPC that
--     returns, per supplier, the profile fields plus completeness and activity
--     facts used by the Nhà cung cấp page.
--
-- It writes nothing, sends nothing and does not touch Mini CRM tables.

-- ===========================================================================
-- 1. suppliers.contact_name
-- ===========================================================================

alter table public.suppliers add column if not exists contact_name text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.suppliers'::regclass
      and conname = 'suppliers_contact_name_length_check'
  ) then
    alter table public.suppliers
      add constraint suppliers_contact_name_length_check
      check (
        contact_name is null
        or length(btrim(contact_name)) <= 120
      );
  end if;
end $$;

-- ===========================================================================
-- 2. supplier_profile_overview(): one jsonb array row per supplier
-- ===========================================================================

create or replace function public.supplier_profile_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_result jsonb;
begin
  -- Read gate: service_role bypasses, otherwise the same view permission the
  -- suppliers page is reached with. The suppliers RLS select policy is
  -- effectively "any authenticated", so require an explicit module view here.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'suppliers', 'view')
      or public.has_module_permission(v_actor, 'supplier_orders', 'view')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  with order_items as (
    select
      c.supplier_id,
      count(*)::integer as order_item_count
    from public.supplier_order_catalog_items c
    where c.active
    group by c.supplier_id
  ),
  activity as (
    select
      a.supplier_id,
      max(a.occurred_at) as last_purchase_at,
      bool_or(a.occurred_at >= v_today - 60) as active_60d
    from (
      select
        gr.supplier_id,
        gr.receipt_date as occurred_at
      from public.goods_receipts gr
      where gr.supplier_id is not null
      union all
      select
        po.supplier_id,
        po.order_date as occurred_at
      from public.purchase_orders po
      where po.supplier_id is not null
        and po.status <> 'cancelled'::public.purchase_order_status
    ) a
    group by a.supplier_id
  ),
  unpaid as (
    select
      pr.supplier_id,
      count(*)::integer as unpaid_count,
      coalesce(sum(
        greatest(
          round(
            coalesce(pr.total_amount, 0) - coalesce((
              select sum(pa.amount)
              from public.payment_allocations pa
              where pa.payment_request_id = pr.id
            ), 0),
            0
          ),
          0
        )
      ), 0)::numeric as unpaid_amount
    from public.payment_requests pr
    where pr.supplier_id is not null
      and pr.status::text in ('pending', 'approved')
      and pr.payment_status::text in ('unpaid', 'partial')
    group by pr.supplier_id
  )
  select coalesce(
    jsonb_agg(
      to_jsonb(x)
      order by x.active_60d desc, cardinality(x.missing) desc, x.name, x.id
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      su.id,
      btrim(su.name) as name,
      nullif(btrim(coalesce(su.email, '')), '') as email,
      nullif(btrim(coalesce(su.phone, '')), '') as phone,
      nullif(btrim(coalesce(su.contact_name, '')), '') as contact_name,
      nullif(btrim(coalesce(su.address, '')), '') as address,
      nullif(btrim(coalesce(su.default_receiving_location, '')), '') as default_receiving_location,
      su.payment_terms_days,
      su.default_payment_method,
      coalesce(oi.order_item_count, 0) as order_item_count,
      act.last_purchase_at,
      coalesce(act.active_60d, false) as active_60d,
      coalesce(u.unpaid_count, 0) as unpaid_count,
      coalesce(u.unpaid_amount, 0) as unpaid_amount,
      array_remove(
        array[
          case
            when nullif(btrim(coalesce(su.email, '')), '') is null
              then 'email'
          end,
          case
            when nullif(btrim(coalesce(su.phone, '')), '') is null
              then 'phone'
          end,
          case
            when nullif(btrim(coalesce(su.contact_name, '')), '') is null
              then 'contact_name'
          end,
          case
            when nullif(btrim(coalesce(su.default_receiving_location, '')), '') is null
              then 'receiving_location'
          end
        ],
        null
      ) as missing
    from public.suppliers su
    left join order_items oi on oi.supplier_id = su.id
    left join activity act on act.supplier_id = su.id
    left join unpaid u on u.supplier_id = su.id
  ) x;

  return v_result;
end;
$$;

revoke all on function public.supplier_profile_overview() from public, anon;
grant execute on function public.supplier_profile_overview()
  to authenticated, service_role;
