-- Rollback-only smoke for 20261103640000_dealer_location_pin.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_dealer_location_pin.sql
--
-- The file opens one transaction, applies the migration SQL inline, impersonates
-- the first real owner from public.user_roles through request.jwt.claims, then
-- exercises list / pin / replay / outside-Vietnam / clear / permission-denied.
-- A final rollback leaves no customer, location or audit row behind.

\set ON_ERROR_STOP on

begin;

-- ===========================================================================
-- Inline migration content (keep in sync with
-- 20261103640000_dealer_location_pin.sql)
-- ===========================================================================
alter table public.mini_crm_customers
  add column if not exists location_verified_by uuid;

comment on column public.mini_crm_customers.location_verified_by is
  'CRM user who last pinned or cleared the dealer location.';

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

revoke all on function public.crm_list_dealer_locations()
  from public, anon, authenticated;
grant execute on function public.crm_list_dealer_locations()
  to authenticated;

revoke all on function public.crm_set_dealer_location(uuid, numeric, numeric, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.crm_set_dealer_location(uuid, numeric, numeric, text, text, text, boolean)
  to authenticated;

-- ===========================================================================
-- Smoke assertions
-- ===========================================================================
do $smoke$
begin
  if not has_function_privilege(
    'authenticated', 'public.crm_list_dealer_locations()', 'execute') then
    raise exception 'SMOKE_RESULT FAIL authenticated_cannot_list';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.crm_set_dealer_location(uuid,numeric,numeric,text,text,text,boolean)',
    'execute') then
    raise exception 'SMOKE_RESULT FAIL authenticated_cannot_set';
  end if;
  if has_function_privilege(
    'anon', 'public.crm_list_dealer_locations()', 'execute') then
    raise exception 'SMOKE_RESULT FAIL anon_can_list';
  end if;
  if has_function_privilege(
    'anon',
    'public.crm_set_dealer_location(uuid,numeric,numeric,text,text,text,boolean)',
    'execute') then
    raise exception 'SMOKE_RESULT FAIL anon_can_set';
  end if;
end;
$smoke$;

-- Disposable dealers. IDs travel through custom GUCs so the DO blocks can read
-- them after SET ROLE authenticated without relying on temp-table privileges.
select
  set_config('smoke.dealer_located', gen_random_uuid()::text, true),
  set_config('smoke.dealer_unlocated', gen_random_uuid()::text, true),
  set_config('smoke.dealer_inactive', gen_random_uuid()::text, true),
  set_config('smoke.dealer_nondealer', gen_random_uuid()::text, true);

insert into public.mini_crm_customers (id, customer_name, customer_group, is_active, address)
values
  (current_setting('smoke.dealer_located')::uuid,
   'AAA SMOKE Dealer Pin', 'banhmi_agency', true, 'SMOKE only'),
  (current_setting('smoke.dealer_unlocated')::uuid,
   'ZZZ SMOKE Dealer Unpinned', 'banhmi_point', true, 'SMOKE only'),
  (current_setting('smoke.dealer_inactive')::uuid,
   'SMOKE Dealer Inactive', 'banhmi_agency', false, 'SMOKE only'),
  (current_setting('smoke.dealer_nondealer')::uuid,
   'SMOKE Non Dealer', 'b2b', true, 'SMOKE only');

do $smoke$
declare
  v_owner uuid;
begin
  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end;
$smoke$;

set local role authenticated;

do $smoke$
declare
  v_owner uuid := auth.uid();
  v_a uuid := current_setting('smoke.dealer_located')::uuid;
  v_b uuid := current_setting('smoke.dealer_unlocated')::uuid;
  v_c uuid := current_setting('smoke.dealer_inactive')::uuid;
  v_d uuid := current_setting('smoke.dealer_nondealer')::uuid;
  v_req_set text := 'smoke-dl-set-' || gen_random_uuid()::text;
  v_req_clear text := 'smoke-dl-clear-' || gen_random_uuid()::text;
  v_result jsonb;
  v_event public.dealer_location_events%rowtype;
  v_count integer;
  v_pos_a integer := 0;
  v_pos_b integer := 0;
  v_seen integer := 0;
  v_row record;
  v_error_ok boolean;
begin
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL owner_claim_missing';
  end if;

  select count(*) into v_count
  from public.crm_list_dealer_locations() l
  where l.id in (v_a, v_b);
  if v_count <> 2 then
    raise exception 'SMOKE_RESULT FAIL list_missing_dealers:%', v_count;
  end if;

  select count(*) into v_count
  from public.crm_list_dealer_locations() l
  where l.id in (v_c, v_d);
  if v_count <> 0 then
    raise exception 'SMOKE_RESULT FAIL list_includes_ineligible';
  end if;

  v_result := public.crm_set_dealer_location(
    v_a, 10.7769123, 106.7009123, 'manual_pin', 'smoke pin', v_req_set);
  if (v_result->>'success')::boolean is not true then
    raise exception 'SMOKE_RESULT FAIL set_not_success';
  end if;
  if (v_result->>'location_lat')::numeric <> 10.776912 then
    raise exception 'SMOKE_RESULT FAIL lat_not_rounded:%', v_result->>'location_lat';
  end if;
  if (v_result->>'location_lng')::numeric <> 106.700912 then
    raise exception 'SMOKE_RESULT FAIL lng_not_rounded:%', v_result->>'location_lng';
  end if;
  if (v_result->>'location_verified_at') is null then
    raise exception 'SMOKE_RESULT FAIL verified_at_missing';
  end if;

  for v_row in select * from public.crm_list_dealer_locations() loop
    v_seen := v_seen + 1;
    if v_row.id = v_a then v_pos_a := v_seen; end if;
    if v_row.id = v_b then v_pos_b := v_seen; end if;
  end loop;
  if v_pos_a = 0 or v_pos_b = 0 then
    raise exception 'SMOKE_RESULT FAIL list_positions';
  end if;
  if v_pos_b >= v_pos_a then
    raise exception 'SMOKE_RESULT FAIL unlocated_not_first';
  end if;

  v_result := public.crm_set_dealer_location(
    v_a, 10.7769123, 106.7009123, 'manual_pin', 'retry', v_req_set);
  if (v_result->>'location_lat')::numeric <> 10.776912 then
    raise exception 'SMOKE_RESULT FAIL replay_lat';
  end if;
  select count(*) into v_count
  from public.dealer_location_events e
  where e.request_id = v_req_set;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL replay_wrote:%', v_count;
  end if;

  select * into v_event
  from public.dealer_location_events e
  where e.request_id = v_req_set;
  if v_event.actor_id is distinct from v_owner then
    raise exception 'SMOKE_RESULT FAIL pin_actor';
  end if;
  if v_event.created_at is null then
    raise exception 'SMOKE_RESULT FAIL pin_created_at';
  end if;
  if v_event.old_lat is not null or v_event.old_lng is not null then
    raise exception 'SMOKE_RESULT FAIL pin_old_not_null';
  end if;
  if v_event.new_lat <> 10.776912 or v_event.new_lng <> 106.700912 then
    raise exception 'SMOKE_RESULT FAIL pin_new';
  end if;
  if v_event.source <> 'manual_pin' then
    raise exception 'SMOKE_RESULT FAIL pin_source';
  end if;

  v_error_ok := false;
  begin
    perform public.crm_set_dealer_location(
      v_a, 48.8566, 2.3522, 'pasted_coordinates', 'paris',
      'smoke-dl-outside-' || gen_random_uuid()::text);
  exception when others then
    if sqlerrm like '%outside_vietnam%' then
      v_error_ok := true;
    else
      raise;
    end if;
  end;
  if not v_error_ok then
    raise exception 'SMOKE_RESULT FAIL outside_vietnam_accepted';
  end if;
  select count(*) into v_count
  from public.dealer_location_events e
  where e.customer_id = v_a;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL outside_wrote:%', v_count;
  end if;

  v_error_ok := false;
  begin
    perform public.crm_set_dealer_location(v_c, 10.7, 106.7, 'manual_pin', null, null);
  exception when others then
    if sqlerrm like '%customer_inactive%' then
      v_error_ok := true;
    else
      raise;
    end if;
  end;
  if not v_error_ok then
    raise exception 'SMOKE_RESULT FAIL inactive_accepted';
  end if;

  v_error_ok := false;
  begin
    perform public.crm_set_dealer_location(v_d, 10.7, 106.7, 'manual_pin', null, null);
  exception when others then
    if sqlerrm like '%not_a_dealer%' then
      v_error_ok := true;
    else
      raise;
    end if;
  end;
  if not v_error_ok then
    raise exception 'SMOKE_RESULT FAIL nondealer_accepted';
  end if;

  v_result := public.crm_set_dealer_location(
    v_a, null, null, null, 'cleared', v_req_clear, true);
  if (v_result->>'location_lat') is not null
     or (v_result->>'location_lng') is not null then
    raise exception 'SMOKE_RESULT FAIL clear_result';
  end if;

  select * into v_event
  from public.dealer_location_events e
  where e.request_id = v_req_clear;
  if v_event.source <> 'manual_clear' then
    raise exception 'SMOKE_RESULT FAIL clear_source';
  end if;
  if v_event.old_lat is distinct from 10.776912
     or v_event.old_lng is distinct from 106.700912 then
    raise exception 'SMOKE_RESULT FAIL clear_old';
  end if;
  if v_event.new_lat is not null or v_event.new_lng is not null then
    raise exception 'SMOKE_RESULT FAIL clear_new';
  end if;
  if v_event.actor_id is distinct from v_owner then
    raise exception 'SMOKE_RESULT FAIL clear_actor';
  end if;

  v_result := public.crm_set_dealer_location(
    v_a, null, null, null, 'retry-clear', v_req_clear, true);
  select count(*) into v_count
  from public.dealer_location_events e
  where e.request_id = v_req_clear;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL clear_replay_wrote:%', v_count;
  end if;

  select count(*) into v_count
  from public.crm_list_dealer_locations() l
  where l.id = v_a
    and l.location_lat is null
    and l.location_lng is null
    and l.location_source is null;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL clear_not_reflected';
  end if;

  select count(*) into v_count
  from public.dealer_location_events e
  where e.customer_id = v_a;
  if v_count <> 2 then
    raise exception 'SMOKE_RESULT FAIL event_count:%', v_count;
  end if;
end;
$smoke$;

reset role;

do $smoke$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', '00000000-0000-4000-8000-000000000000'::uuid,
      'role', 'authenticated'
    )::text,
    true
  );
end;
$smoke$;

set local role authenticated;

do $smoke$
declare
  v_a uuid := current_setting('smoke.dealer_located')::uuid;
  v_error_ok boolean := false;
begin
  begin
    perform public.crm_set_dealer_location(v_a, 10.7, 106.7, 'manual_pin', null, null);
  exception when others then
    if sqlerrm like '%permission_denied%' then
      v_error_ok := true;
    else
      raise;
    end if;
  end;

  if not v_error_ok then
    raise exception 'SMOKE_RESULT FAIL permission_denied_not_raised';
  end if;
end;
$smoke$;

reset role;

select
  (select count(*) from public.dealer_location_events e
   where e.customer_id = current_setting('smoke.dealer_located')::uuid) as event_count,
  (select count(*) from public.dealer_location_events e
   where e.customer_id = current_setting('smoke.dealer_located')::uuid
     and e.source = 'manual_clear') as clear_event_count;

select 'SMOKE_RESULT PASS: dealer location pin' as smoke_result;

rollback;
