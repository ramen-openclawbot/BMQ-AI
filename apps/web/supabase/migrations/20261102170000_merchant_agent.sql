-- BMQ merchant agent — GĐ1 (staging table, read-only analysis views, apply RPCs).
-- This migration is intentionally NOT applied by the coding agent.

-- ---------------------------------------------------------------------------
-- 1. Staged changes: the only table the merchant agent may write.
-- ---------------------------------------------------------------------------
create table if not exists public.merchant_staged_changes (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  summary text not null,
  payload jsonb not null,
  before jsonb,
  status text not null default 'staged',
  operator text,
  session_id text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  applied_at timestamptz,
  error text,
  constraint merchant_staged_changes_kind_check
    check (kind in ('listing', 'price', 'inventory', 'promotion', 'campaign')),
  constraint merchant_staged_changes_status_check
    check (status in ('staged', 'approved', 'applied', 'discarded', 'failed'))
);

create index if not exists merchant_staged_changes_status_created_idx
  on public.merchant_staged_changes (status, created_at desc);

alter table public.merchant_staged_changes enable row level security;

drop policy if exists merchant_staged_changes_owner_select
  on public.merchant_staged_changes;
create policy merchant_staged_changes_owner_select
  on public.merchant_staged_changes
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'owner'));

revoke all on table public.merchant_staged_changes from anon, authenticated;
grant select on table public.merchant_staged_changes to authenticated;
grant all on table public.merchant_staged_changes to service_role;

comment on table public.merchant_staged_changes is
  'Owner-approved proposals from the BMQ merchant agent; only service_role writes live systems through the apply RPCs.';

-- ---------------------------------------------------------------------------
-- 2. Read-only analysis surface. Views are owned by postgres and expose only
--    non-test, non-cancelled business data. merchant_analyst gets the views and
--    nothing in schema public.
-- ---------------------------------------------------------------------------
create schema if not exists merchant_analysis;

create or replace view merchant_analysis.dealer_orders_v as
select
  d.order_number,
  d.customer_id,
  c.customer_name,
  coalesce(c.is_npp, false) as is_npp,
  d.status,
  d.requested_delivery_date,
  d.submitted_at,
  d.total_amount_vnd
from public.dealer_orders d
join public.mini_crm_customers c on c.id = d.customer_id
where d.is_test = false
  and d.status <> 'cancelled';

create or replace view merchant_analysis.dealer_order_lines_v as
select
  d.order_number,
  d.requested_delivery_date,
  c.customer_name,
  coalesce(i.route_customer_name, rc.customer_name) as route_customer_name,
  i.sku_code,
  i.product_name,
  i.quantity,
  i.exchange_quantity,
  i.makeup_quantity,
  i.line_total_vnd
from public.dealer_order_items i
join public.dealer_orders d on d.id = i.order_id
join public.mini_crm_customers c on c.id = d.customer_id
left join public.mini_crm_customers rc on rc.id = i.route_customer_id
where d.is_test = false
  and d.status <> 'cancelled';

create or replace view merchant_analysis.revenue_lines_v as
select
  r.revenue_date,
  r.channel,
  r.customer_name,
  r.product_name,
  r.quantity,
  r.gross_revenue,
  r.customer_payable
from public.revenue_ledger_lines r
where r.approval_status = 'approved';

create or replace view merchant_analysis.skus_v as
select
  s.id,
  s.sku_code,
  s.product_name,
  s.category,
  s.unit,
  coalesce((s.cost_values ->> 'selling_price')::numeric, 0) as selling_price,
  coalesce(s.hide_from_dealer_portal, false) as hidden,
  (
    coalesce(nullif(btrim(s.image_url), ''), null) is not null
    or coalesce(nullif(btrim(s.image_path), ''), null) is not null
  ) as has_image
from public.product_skus s
where (
    coalesce(s.sku_type::text, '') = 'finished_good'
    or (
      s.sku_type is null
      and (
        s.category ilike '%thành phẩm%'
        or s.category ilike '%thanh pham%'
        or s.category ilike '%finished%'
      )
    )
  );

create or replace view merchant_analysis.dealer_prices_v as
select
  p.id,
  p.customer_id,
  c.customer_name,
  p.sku_id,
  s.sku_code,
  p.price_vnd_per_unit,
  p.updated_at
from public.mini_crm_customer_price_list p
join public.mini_crm_customers c on c.id = p.customer_id
join public.product_skus s on s.id = p.sku_id
where p.is_active = true;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'merchant_analyst') then
    create role merchant_analyst nologin;
  end if;
end
$$;

alter role merchant_analyst nologin;

revoke all on schema public from merchant_analyst;
revoke all on all tables in schema public from merchant_analyst;
revoke all on all sequences in schema public from merchant_analyst;
revoke all on schema merchant_analysis from public, anon, authenticated;
grant usage on schema merchant_analysis to merchant_analyst;
grant select on merchant_analysis.dealer_orders_v to merchant_analyst;
grant select on merchant_analysis.dealer_order_lines_v to merchant_analyst;
grant select on merchant_analysis.revenue_lines_v to merchant_analyst;
grant select on merchant_analysis.skus_v to merchant_analyst;
grant select on merchant_analysis.dealer_prices_v to merchant_analyst;
grant merchant_analyst to postgres;
grant merchant_analyst to service_role;

comment on role merchant_analyst is
  'Nologin role limited to SELECT on merchant_analysis views; used by merchant_analysis_query.';

-- ---------------------------------------------------------------------------
-- 3. Read-only SQL RPC. The dynamic query runs as merchant_analyst inside a
--    read-only transaction with a 5s timeout and a 1000-row hard cap.
-- ---------------------------------------------------------------------------
create or replace function public.merchant_analysis_query(
  p_sql text,
  p_max_rows integer default 200
)
returns jsonb
language plpgsql
-- SECURITY INVOKER on purpose: Postgres refuses SET ROLE inside a security
-- definer function. The caller (service_role) is a member of merchant_analyst.
security invoker
set search_path = ''
as $$
declare
  v_sql text := btrim(coalesce(p_sql, ''));
  v_body text;
  v_result jsonb;
  v_limit integer := least(greatest(coalesce(p_max_rows, 200), 1), 1000);
  v_comment_end integer;
begin
  if v_sql = '' then
    raise exception 'empty_query' using errcode = '22023';
  end if;

  -- Strip leading SQL comments so the first keyword check sees the statement.
  loop
    if v_sql ~* '^--' then
      v_sql := btrim(regexp_replace(v_sql, '^--[^\n]*(\n|$)', ''));
    elsif v_sql ~* '^/\*' then
      v_comment_end := strpos(v_sql, '*/');
      if v_comment_end = 0 then
        raise exception 'invalid_query' using errcode = '22023';
      end if;
      v_sql := btrim(substr(v_sql, v_comment_end + 2));
    else
      exit;
    end if;
  end loop;

  v_body := regexp_replace(v_sql, ';\s*$', '');
  if position(';' in v_body) > 0 then
    raise exception 'only_a_single_statement_is_allowed' using errcode = '22023';
  end if;
  if v_body !~* '^(select|with)([^[:alnum:]_]|$)' then
    raise exception 'only_select_is_allowed' using errcode = '22023';
  end if;
  if lower(v_body) like '%pg_%'
     or lower(v_body) like '%information_schema%' then
    raise exception 'system_catalog_is_not_allowed' using errcode = '22023';
  end if;

  -- Run inside a sub-transaction that is always rolled back after the result is
  -- captured, so the role, timeout and read-only settings never outlive the call.
  begin
    set local statement_timeout = '5s';
    set local transaction_read_only = on;
    set local role merchant_analyst;
    set local search_path = merchant_analysis;

    execute format(
      'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) q limit %s) t',
      v_body,
      v_limit
    )
    into v_result;

    raise exception 'merchant_analysis_done' using errcode = 'P0001';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'merchant_analysis_done' then
        raise;
      end if;
  end;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.merchant_analysis_query(text, integer)
  from public, anon, authenticated;
grant execute on function public.merchant_analysis_query(text, integer)
  to service_role;

comment on function public.merchant_analysis_query(text, integer) is
  'Service-role-only read query over merchant_analysis; enforces SELECT/WITH, one statement, 5s timeout, read-only transaction and at most 1000 rows.';

-- ---------------------------------------------------------------------------
-- 4. Apply a price change. The payload is a JSON array of
--    {customer_id, sku_id, price_vnd_per_unit}; the row is locked and the
--    active per-customer price is updated or inserted.
-- ---------------------------------------------------------------------------
create or replace function public.merchant_apply_price_change(p_change_id uuid)
returns public.merchant_staged_changes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change public.merchant_staged_changes%rowtype;
  v_item jsonb;
  v_customer_id uuid;
  v_sku_id uuid;
  v_price numeric;
begin
  select *
    into v_change
    from public.merchant_staged_changes
   where id = p_change_id
   for update;

  if not found then
    raise exception 'change_not_found' using errcode = 'P0002';
  end if;
  if v_change.status = 'applied' then
    return v_change;
  end if;
  if v_change.kind <> 'price' then
    raise exception 'change_is_not_price' using errcode = '22023';
  end if;
  if v_change.status <> 'approved' then
    raise exception 'change_is_not_approved' using errcode = '22023';
  end if;
  if jsonb_typeof(v_change.payload) <> 'array' then
    raise exception 'invalid_price_payload' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(v_change.payload)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'invalid_price_payload' using errcode = '22023';
    end if;
    begin
      v_customer_id := (v_item ->> 'customer_id')::uuid;
      v_sku_id := (v_item ->> 'sku_id')::uuid;
      v_price := (v_item ->> 'price_vnd_per_unit')::numeric;
    exception
      when others then
        raise exception 'invalid_price_payload' using errcode = '22023';
    end;

    if v_customer_id is null or v_sku_id is null or v_price is null or v_price <= 0 then
      raise exception 'invalid_price_payload' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.mini_crm_customers where id = v_customer_id
    ) then
      raise exception 'customer_not_found' using errcode = 'P0002';
    end if;
    if not exists (
      select 1 from public.product_skus where id = v_sku_id
    ) then
      raise exception 'sku_not_found' using errcode = 'P0002';
    end if;

    update public.mini_crm_customer_price_list
       set price_vnd_per_unit = v_price,
           updated_at = now()
     where customer_id = v_customer_id
       and sku_id = v_sku_id
       and is_active = true;

    if not found then
      insert into public.mini_crm_customer_price_list (
        customer_id,
        sku_id,
        price_vnd_per_unit,
        currency,
        is_active
      )
      values (
        v_customer_id,
        v_sku_id,
        v_price,
        'VND',
        true
      );
    end if;
  end loop;

  update public.merchant_staged_changes
     set status = 'applied',
         applied_at = now(),
         error = null
   where id = p_change_id
   returning * into v_change;

  return v_change;
end;
$$;

revoke all on function public.merchant_apply_price_change(uuid)
  from public, anon, authenticated;
grant execute on function public.merchant_apply_price_change(uuid)
  to service_role;

comment on function public.merchant_apply_price_change(uuid) is
  'Service-role-only idempotent apply for approved price changes; updates or inserts active mini_crm_customer_price_list rows.';

-- ---------------------------------------------------------------------------
-- 5. Apply a promotion/campaign announcement. The payload becomes one active
--    dealer_announcements row.
-- ---------------------------------------------------------------------------
create or replace function public.merchant_apply_announcement(p_change_id uuid)
returns public.merchant_staged_changes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change public.merchant_staged_changes%rowtype;
  v_title text;
  v_body text;
  v_severity text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
begin
  select *
    into v_change
    from public.merchant_staged_changes
   where id = p_change_id
   for update;

  if not found then
    raise exception 'change_not_found' using errcode = 'P0002';
  end if;
  if v_change.status = 'applied' then
    return v_change;
  end if;
  if v_change.kind not in ('promotion', 'campaign') then
    raise exception 'change_is_not_announcement' using errcode = '22023';
  end if;
  if v_change.status <> 'approved' then
    raise exception 'change_is_not_approved' using errcode = '22023';
  end if;
  if jsonb_typeof(v_change.payload) <> 'object' then
    raise exception 'invalid_announcement_payload' using errcode = '22023';
  end if;

  v_title := btrim(coalesce(v_change.payload ->> 'title', ''));
  v_body := btrim(coalesce(v_change.payload ->> 'body', ''));
  v_severity := coalesce(nullif(btrim(v_change.payload ->> 'severity'), ''), 'info');
  if v_title = '' or char_length(v_title) > 120 then
    raise exception 'invalid_announcement_title' using errcode = '22023';
  end if;
  if v_body = '' or char_length(v_body) > 1000 then
    raise exception 'invalid_announcement_body' using errcode = '22023';
  end if;
  if v_severity not in ('info', 'success', 'warning', 'critical') then
    raise exception 'invalid_announcement_severity' using errcode = '22023';
  end if;

  if nullif(v_change.payload ->> 'starts_at', '') is not null then
    v_starts_at := (v_change.payload ->> 'starts_at')::timestamptz;
  end if;
  if nullif(v_change.payload ->> 'ends_at', '') is not null then
    v_ends_at := (v_change.payload ->> 'ends_at')::timestamptz;
  end if;

  insert into public.dealer_announcements (
    title,
    body,
    severity,
    starts_at,
    ends_at,
    is_active
  )
  values (
    v_title,
    v_body,
    v_severity,
    v_starts_at,
    v_ends_at,
    true
  );

  update public.merchant_staged_changes
     set status = 'applied',
         applied_at = now(),
         error = null
   where id = p_change_id
   returning * into v_change;

  return v_change;
end;
$$;

revoke all on function public.merchant_apply_announcement(uuid)
  from public, anon, authenticated;
grant execute on function public.merchant_apply_announcement(uuid)
  to service_role;

comment on function public.merchant_apply_announcement(uuid) is
  'Service-role-only idempotent apply for approved promotion/campaign changes; inserts one active dealer_announcements row.';
