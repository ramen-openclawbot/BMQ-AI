-- 2026-11-03 — Ghim vị trí đại lý trong CRM (phần máy chủ).
--
-- Additive only. No production data is changed and no migration is applied by
-- this checkout. CRM users pin/clear a dealer location through one security
-- definer RPC; every successful write appends one dealer_location_events row
-- (old and new coordinates, actor, time). Repeating the same p_request_id
-- returns the current location without writing a second event.

-- ===========================================================================
-- A. Verified-by column on mini_crm_customers
-- ===========================================================================
alter table public.mini_crm_customers
  add column if not exists location_verified_by uuid;

comment on column public.mini_crm_customers.location_verified_by is
  'CRM user who last pinned or cleared the dealer location.';

-- ===========================================================================
-- B. dealer_location_events — append-only audit log
-- ===========================================================================
create table if not exists public.dealer_location_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  old_lat numeric(9, 6),
  old_lng numeric(9, 6),
  new_lat numeric(9, 6),
  new_lng numeric(9, 6),
  source text not null,
  note text,
  actor_id uuid,
  request_id text,
  created_at timestamptz not null default now()
);

-- Keep the log shape safe even if an early draft of this table already exists.
alter table public.dealer_location_events
  add column if not exists request_id text;

alter table public.dealer_location_events
  drop constraint if exists dealer_location_events_source_check;
alter table public.dealer_location_events
  add constraint dealer_location_events_source_check
  check (source in ('manual_pin', 'pasted_coordinates', 'maps_link', 'manual_clear'));

alter table public.dealer_location_events
  drop constraint if exists dealer_location_events_lat_range_check;
alter table public.dealer_location_events
  add constraint dealer_location_events_lat_range_check
  check (
    (old_lat is null or (old_lat >= -90 and old_lat <= 90))
    and (new_lat is null or (new_lat >= -90 and new_lat <= 90))
  );

alter table public.dealer_location_events
  drop constraint if exists dealer_location_events_lng_range_check;
alter table public.dealer_location_events
  add constraint dealer_location_events_lng_range_check
  check (
    (old_lng is null or (old_lng >= -180 and old_lng <= 180))
    and (new_lng is null or (new_lng >= -180 and new_lng <= 180))
  );

create index if not exists idx_dealer_location_events_customer_created
  on public.dealer_location_events (customer_id, created_at desc);
create unique index if not exists dealer_location_events_request_id_key
  on public.dealer_location_events (request_id)
  where request_id is not null;

comment on table public.dealer_location_events is
  'Append-only audit log of dealer location pins and clears.';
comment on column public.dealer_location_events.old_lat is
  'Latitude before the change; null when the dealer had no location.';
comment on column public.dealer_location_events.new_lat is
  'Latitude after the change; null when the location was cleared.';
comment on column public.dealer_location_events.source is
  'manual_pin/pasted_coordinates/maps_link for a pin, manual_clear for a clear.';
comment on column public.dealer_location_events.request_id is
  'Client retry key; a partial unique index makes repeated clicks idempotent.';

alter table public.dealer_location_events enable row level security;

revoke all on table public.dealer_location_events from public, anon, authenticated;
grant select on table public.dealer_location_events to authenticated;
grant select, insert, update, delete on table public.dealer_location_events to service_role;

drop policy if exists dealer_location_events_crm_read
  on public.dealer_location_events;
create policy dealer_location_events_crm_read
  on public.dealer_location_events
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'crm', 'view')
    or public.has_module_permission((select auth.uid()), 'crm', 'edit')
  );

drop policy if exists dealer_location_events_service_role_all
  on public.dealer_location_events;
create policy dealer_location_events_service_role_all
  on public.dealer_location_events
  for all
  to service_role
  using (true)
  with check (true);

-- ===========================================================================
-- C. crm_list_dealer_locations — active agencies/points for the pin screen
-- ===========================================================================
-- phone is read through to_jsonb so the function works whether or not
-- mini_crm_customers has a phone column on the target database.
create or replace function public.crm_list_dealer_locations()
returns table (
  id uuid,
  customer_name text,
  customer_group text,
  address text,
  phone text,
  location_lat numeric,
  location_lng numeric,
  location_source text,
  location_verified_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if not (
      public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'crm', 'view')
      or public.has_module_permission((select auth.uid()), 'crm', 'edit')
    ) then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
  end if;

  return query
  select
    c.id,
    c.customer_name,
    c.customer_group,
    c.address,
    (to_jsonb(c) ->> 'phone')::text,
    c.location_lat,
    c.location_lng,
    c.location_source,
    c.location_verified_at
  from public.mini_crm_customers c
  where c.is_active is true
    and c.customer_group in ('banhmi_agency', 'banhmi_point')
  order by
    case
      when c.location_lat is null or c.location_lng is null then 0
      else 1
    end,
    c.customer_name asc,
    c.id asc;
end;
$$;

comment on function public.crm_list_dealer_locations() is
  'Active banhmi_agency/banhmi_point customers for the CRM dealer pin screen.';

-- ===========================================================================
-- D. crm_set_dealer_location — pin or clear one dealer location
-- ===========================================================================
create or replace function public.crm_set_dealer_location(
  p_customer_id uuid,
  p_lat numeric,
  p_lng numeric,
  p_source text,
  p_note text default null,
  p_request_id text default null,
  p_clear boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_customer public.mini_crm_customers%rowtype;
  v_lat numeric;
  v_lng numeric;
  v_source text;
  v_event_source text;
  v_note text := nullif(btrim(p_note), '');
  v_request_id text := nullif(btrim(p_request_id), '');
  v_verified_at timestamptz;
  v_existing public.dealer_location_events%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
    if not (
      public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'crm', 'edit')
    ) then
      raise exception 'permission_denied' using errcode = '42501';
    end if;
  end if;

  if p_customer_id is null then
    raise exception 'customer_not_found' using errcode = 'P0002';
  end if;

  select *
  into v_customer
  from public.mini_crm_customers c
  where c.id = p_customer_id
  for update;

  if not found then
    raise exception 'customer_not_found' using errcode = 'P0002';
  end if;

  if v_customer.is_active is not true then
    raise exception 'customer_inactive' using errcode = '22023';
  end if;

  if v_customer.customer_group is null
     or v_customer.customer_group not in ('banhmi_agency', 'banhmi_point') then
    raise exception 'not_a_dealer' using errcode = '22023';
  end if;

  -- Serialize retries of the same client request before looking the event up.
  if v_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('dealer_location:' || v_request_id, 0));

    select *
    into v_existing
    from public.dealer_location_events e
    where e.request_id = v_request_id;

    if found then
      if v_existing.customer_id <> p_customer_id then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return jsonb_build_object(
        'success', true,
        'customer_id', v_customer.id,
        'location_lat', v_customer.location_lat,
        'location_lng', v_customer.location_lng,
        'location_verified_at', v_customer.location_verified_at
      );
    end if;
  end if;

  if coalesce(p_clear, false) then
    v_lat := null;
    v_lng := null;
    v_source := null;
    v_event_source := 'manual_clear';
  else
    v_source := nullif(btrim(p_source), '');
    if v_source is null
       or v_source not in ('manual_pin', 'pasted_coordinates', 'maps_link') then
      raise exception 'invalid_source' using errcode = '22023';
    end if;

    if p_lat is null or p_lng is null then
      raise exception 'invalid_coordinate' using errcode = '22023';
    end if;

    v_lat := round(p_lat, 6);
    v_lng := round(p_lng, 6);

    if v_lat < 8 or v_lat > 24 or v_lng < 102 or v_lng > 110 then
      raise exception 'outside_vietnam' using errcode = '22023';
    end if;

    v_event_source := v_source;
  end if;

  v_verified_at := now();

  update public.mini_crm_customers c
  set
    location_lat = v_lat,
    location_lng = v_lng,
    location_source = v_source,
    location_verified_at = v_verified_at,
    location_verified_by = v_actor
  where c.id = p_customer_id;

  insert into public.dealer_location_events (
    customer_id,
    old_lat,
    old_lng,
    new_lat,
    new_lng,
    source,
    note,
    actor_id,
    request_id
  ) values (
    p_customer_id,
    v_customer.location_lat,
    v_customer.location_lng,
    v_lat,
    v_lng,
    v_event_source,
    v_note,
    v_actor,
    v_request_id
  );

  return jsonb_build_object(
    'success', true,
    'customer_id', p_customer_id,
    'location_lat', v_lat,
    'location_lng', v_lng,
    'location_verified_at', v_verified_at
  );
end;
$$;

comment on function public.crm_set_dealer_location(uuid, numeric, numeric, text, text, text, boolean) is
  'Pin (or clear with p_clear) one dealer location and append one audit event.';

-- Only signed-in CRM users may call the RPCs. anon and PUBLIC get nothing.
revoke all on function public.crm_list_dealer_locations()
  from public, anon, authenticated;
grant execute on function public.crm_list_dealer_locations()
  to authenticated;

revoke all on function public.crm_set_dealer_location(uuid, numeric, numeric, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.crm_set_dealer_location(uuid, numeric, numeric, text, text, text, boolean)
  to authenticated;
