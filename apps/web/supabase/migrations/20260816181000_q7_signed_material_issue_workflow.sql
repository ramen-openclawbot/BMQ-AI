-- Q7 signed material-issue workflow preflight guard (Task 1) plus
-- immutable per-production-order workflow schema foundation (Task 2).
--
-- The legacy create_production_material_issue(uuid,date) RPC creates the
-- production material issue, issue items, and kitchen_inventory_movements in one
-- immediate-post call.  Q7 must move to: generate PDF -> signed upload ->
-- one-time check -> explicit confirm/post.  Until that replacement workflow is
-- implemented, block browser/client roles from executing the legacy immediate
-- post RPC.  Do not rewrite history and do not write any kitchen ledger rows in
-- this migration.

revoke all on function public.create_production_material_issue(uuid, date) from public;
revoke execute on function public.create_production_material_issue(uuid, date) from public;

revoke all on function public.create_production_material_issue(uuid, date) from anon;
revoke execute on function public.create_production_material_issue(uuid, date) from anon;

revoke all on function public.create_production_material_issue(uuid, date) from authenticated;
revoke execute on function public.create_production_material_issue(uuid, date) from authenticated;

-- Keep service-role/admin automation technically able to inspect or run guarded
-- smoke tests; the browser UI uses anon/authenticated and cannot call this RPC
-- after the revokes above.
grant execute on function public.create_production_material_issue(uuid, date) to service_role;

-- Revisioned Q7 issue metadata.  location_code stays nullable so historical
-- rows remain valid; future Q7 rows are constrained by the paired status/location
-- check to use q7 while replaying legacy draft rows remains possible.
alter table public.production_material_issues add column if not exists location_code text;
alter table public.production_material_issues add column if not exists revision integer not null default 1;
alter table public.production_material_issues add column if not exists source_hash text;
alter table public.production_material_issues add column if not exists immutable_token uuid not null default gen_random_uuid();
alter table public.production_material_issues add column if not exists pdf_path text;
alter table public.production_material_issues add column if not exists pdf_sha256 text;
alter table public.production_material_issues add column if not exists signed_file_path text;
alter table public.production_material_issues add column if not exists signed_file_sha256 text;
alter table public.production_material_issues add column if not exists signed_uploaded_by uuid references auth.users(id) on delete set null;
alter table public.production_material_issues add column if not exists signed_uploaded_at timestamptz;
alter table public.production_material_issues add column if not exists check_status text;
alter table public.production_material_issues add column if not exists check_metadata jsonb not null default '{}'::jsonb;
alter table public.production_material_issues add column if not exists checked_at timestamptz;
alter table public.production_material_issues add column if not exists confirmed_by uuid references auth.users(id) on delete set null;
alter table public.production_material_issues add column if not exists confirmed_at timestamptz;
alter table public.production_material_issues add column if not exists posted_at timestamptz;
alter table public.production_material_issues add column if not exists is_current boolean not null default true;
alter table public.production_material_issues add column if not exists superseded_by_issue_id uuid references public.production_material_issues(id) on delete restrict;

update public.production_material_issues
set is_current = (status not in ('superseded', 'cancelled'))
where is_current is distinct from (status not in ('superseded', 'cancelled'));

alter table public.production_material_issues
  drop constraint if exists production_material_issues_status_check,
  drop constraint if exists production_material_issues_revision_check,
  drop constraint if exists production_material_issues_location_code_check,
  drop constraint if exists production_material_issues_q7_workflow_location_check,
  drop constraint if exists production_material_issues_check_status_check,
  drop constraint if exists production_material_issues_file_hash_check,
  drop constraint if exists production_material_issues_source_hash_check;

alter table public.production_material_issues
  add constraint production_material_issues_status_check
  check (status in (
    'draft',
    'generated',
    'pdf_ready',
    'signed_uploaded',
    'checking',
    'ready_to_confirm',
    'needs_review',
    'posted',
    'superseded',
    'cancelled'
  )),
  add constraint production_material_issues_revision_check check (revision > 0),
  add constraint production_material_issues_location_code_check
    check (location_code is null or location_code = 'q7'),
  add constraint production_material_issues_q7_workflow_location_check
    check (
      status not in ('generated', 'pdf_ready', 'signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review', 'superseded')
      or location_code = 'q7'
    ) not valid,
  add constraint production_material_issues_check_status_check
    check (check_status is null or check_status in ('pending', 'passed', 'failed', 'error', 'needs_review')),
  add constraint production_material_issues_file_hash_check
    check (
      (pdf_sha256 is null or pdf_sha256 ~ '^[A-Fa-f0-9]{64}$')
      and (signed_file_sha256 is null or signed_file_sha256 ~ '^[A-Fa-f0-9]{64}$')
    ),
  add constraint production_material_issues_source_hash_check
    check (
      (source_hash is null or source_hash ~ '^[a-f0-9]{64}$')
      and (
        status not in ('generated', 'pdf_ready', 'signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review', 'superseded')
        or source_hash is not null
      )
    ) not valid;

alter table public.production_material_issues
  drop constraint if exists production_material_issues_production_order_id_key;

alter table public.production_material_issues
  drop constraint if exists production_material_issues_production_order_revision_key;

alter table public.production_material_issues
  add constraint production_material_issues_production_order_revision_key
  unique (production_order_id, revision);

create unique index if not exists production_material_issues_immutable_token_key
  on public.production_material_issues(immutable_token);

drop index if exists public.production_material_issues_one_current_uidx;
create unique index production_material_issues_one_current_uidx
  on public.production_material_issues(production_order_id)
  where status not in ('superseded', 'cancelled')
    and is_current = true
    and superseded_by_issue_id is null;

create index if not exists idx_production_material_issues_location_status_date
  on public.production_material_issues(location_code, status, issue_date);

-- One-time immutable signed-file check attempts.  Retry by signed file SHA256
-- should return the stored row later rather than creating a second attempt.
create table if not exists public.production_material_issue_checks (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.production_material_issues(id) on delete restrict,
  signed_file_sha256 text not null check (signed_file_sha256 ~ '^[A-Fa-f0-9]{64}$'),
  attempt_no integer not null default 1 check (attempt_no = 1),
  status text not null check (status in ('checking', 'passed', 'failed', 'failed_transient', 'error', 'needs_review')),
  result jsonb not null default '{}'::jsonb,
  model text,
  model_version text,
  checked_by uuid references auth.users(id) on delete set null,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (issue_id, signed_file_sha256)
);

alter table public.production_material_issue_checks
  drop constraint if exists production_material_issue_checks_status_check;

alter table public.production_material_issue_checks
  add constraint production_material_issue_checks_status_check
  check (status in ('checking', 'passed', 'failed', 'failed_transient', 'error', 'needs_review'));

create index if not exists idx_production_material_issue_checks_issue
  on public.production_material_issue_checks(issue_id);

create or replace function public.q7_prevent_production_material_issue_check_rewrite()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'production_material_issue_checks are append/finalize-only';
  end if;

  if tg_op = 'UPDATE'
    and old.status = 'checking'
    and new.status in ('passed', 'failed', 'failed_transient', 'error', 'needs_review')
    and old.issue_id is not distinct from new.issue_id
    and old.signed_file_sha256 is not distinct from new.signed_file_sha256
    and old.attempt_no is not distinct from new.attempt_no
    and old.checked_by is not distinct from new.checked_by
    and old.created_at is not distinct from new.created_at
  then
    return new;
  end if;

  raise exception 'production_material_issue_checks are append/finalize-only';
end;
$$;

drop trigger if exists production_material_issue_checks_immutable_except_finalization
  on public.production_material_issue_checks;
create trigger production_material_issue_checks_immutable_except_finalization
  before update or delete on public.production_material_issue_checks
  for each row execute function public.q7_prevent_production_material_issue_check_rewrite();

revoke all on function public.q7_prevent_production_material_issue_check_rewrite() from public, anon, authenticated;

-- Append-only workflow audit events.  Browser roles get SELECT only; future
-- security-definer RPCs will append events while posting remains out of scope.
create table if not exists public.production_material_issue_events (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.production_material_issues(id) on delete restrict,
  event_type text not null,
  from_status text,
  to_status text,
  actor uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_production_material_issue_events_issue
  on public.production_material_issue_events(issue_id, created_at);

create or replace function public.q7_prevent_production_material_issue_event_rewrite()
returns trigger
language plpgsql
as $$
begin
  raise exception 'production_material_issue_events are append-only';
end;
$$;

drop trigger if exists production_material_issue_events_immutable
  on public.production_material_issue_events;
create trigger production_material_issue_events_immutable
  before update or delete on public.production_material_issue_events
  for each row execute function public.q7_prevent_production_material_issue_event_rewrite();

revoke all on function public.q7_prevent_production_material_issue_event_rewrite() from public, anon, authenticated;

-- Explicit owner-approved mapping foundation.  No source rows are inserted here:
-- Q7 issue generation must fail closed unless a mapping row is approved.
create table if not exists public.q7_material_issue_material_mappings (
  id uuid primary key default gen_random_uuid(),
  canonical_material_id uuid not null references public.sku_cogs_materials(id) on delete restrict,
  source_unit text not null,
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  kitchen_unit text not null,
  conversion_factor numeric(18, 8) not null,
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved', 'rejected')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint q7_material_issue_material_mappings_key unique (canonical_material_id, source_unit),
  constraint q7_material_issue_material_mappings_conversion_check
    check (conversion_factor > 0 and conversion_factor::text not in ('NaN', 'Infinity', '-Infinity')),
  constraint q7_material_issue_material_mappings_approved_ready_check
    check (approval_status <> 'approved' or (approved_by is not null and approved_at is not null))
);

create index if not exists idx_q7_material_issue_material_mappings_canonical
  on public.q7_material_issue_material_mappings(canonical_material_id, source_unit, approval_status);
create index if not exists idx_q7_material_issue_material_mappings_kitchen_item
  on public.q7_material_issue_material_mappings(kitchen_inventory_item_id, kitchen_unit, approval_status);

-- Future Q7 ledger rows may carry a location marker, but the 466 historical
-- kitchen movements are intentionally left nullable/ambiguous and are not
-- backfilled or relabelled by this workflow schema migration.
alter table public.kitchen_inventory_movements
  add column if not exists location_code text;

alter table public.production_material_issues enable row level security;
alter table public.production_material_issue_checks enable row level security;
alter table public.production_material_issue_events enable row level security;
alter table public.q7_material_issue_material_mappings enable row level security;

-- Replace legacy broad authenticated write policies on production issues.  Direct
-- mutation is intentionally withheld until future security-definer RPCs exist.
drop policy if exists "production_material_issues_view" on public.production_material_issues;
drop policy if exists "production_material_issues_edit" on public.production_material_issues;
drop policy if exists "p_production_material_issues_select_access" on public.production_material_issues;
drop policy if exists "p_production_material_issues_insert_access" on public.production_material_issues;
drop policy if exists "p_production_material_issues_update_access" on public.production_material_issues;
drop policy if exists "p_production_material_issues_delete_access" on public.production_material_issues;
drop policy if exists q7_production_material_issues_select on public.production_material_issues;
create policy q7_production_material_issues_select
  on public.production_material_issues for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'production_q7', 'view')
    or public.has_module_permission((select auth.uid()), 'warehouse', 'view')
    or public.has_module_permission((select auth.uid()), 'kitchen_inventory', 'view')
    or public.has_module_permission((select auth.uid()), 'q7_material_inventory', 'view')
  );

drop policy if exists q7_production_material_issue_checks_select on public.production_material_issue_checks;
create policy q7_production_material_issue_checks_select
  on public.production_material_issue_checks for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'production_q7', 'view')
    or public.has_module_permission((select auth.uid()), 'warehouse', 'view')
    or public.has_module_permission((select auth.uid()), 'kitchen_inventory', 'view')
    or public.has_module_permission((select auth.uid()), 'q7_material_inventory', 'view')
  );

drop policy if exists q7_production_material_issue_events_select on public.production_material_issue_events;
create policy q7_production_material_issue_events_select
  on public.production_material_issue_events for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'production_q7', 'view')
    or public.has_module_permission((select auth.uid()), 'warehouse', 'view')
    or public.has_module_permission((select auth.uid()), 'kitchen_inventory', 'view')
    or public.has_module_permission((select auth.uid()), 'q7_material_inventory', 'view')
  );

drop policy if exists q7_material_issue_material_mappings_select on public.q7_material_issue_material_mappings;
create policy q7_material_issue_material_mappings_select
  on public.q7_material_issue_material_mappings for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'production_q7', 'view')
    or public.has_module_permission((select auth.uid()), 'warehouse', 'view')
    or public.has_module_permission((select auth.uid()), 'kitchen_inventory', 'view')
    or public.has_module_permission((select auth.uid()), 'q7_material_inventory', 'view')
  );

revoke all on public.production_material_issues from public, anon, authenticated;
revoke all on public.production_material_issue_checks from public, anon, authenticated;
revoke all on public.production_material_issue_events from public, anon, authenticated;
revoke all on public.q7_material_issue_material_mappings from public, anon, authenticated;

grant select on public.production_material_issues to authenticated;
grant select on public.production_material_issue_checks to authenticated;
grant select on public.production_material_issue_events to authenticated;
grant select on public.q7_material_issue_material_mappings to authenticated;

-- Task 3: per-production-order Q7 material issue snapshot generation.
-- This generator writes only Q7 issue headers/items/events after validation. It
-- intentionally performs no kitchen_inventory_movements DML and never calls the
-- legacy immediate-post RPC.

create extension if not exists pgcrypto;

alter table public.production_orders
  add column if not exists location_code text;

alter table public.production_orders
  drop constraint if exists production_orders_location_code_check;
alter table public.production_orders
  add constraint production_orders_location_code_check
  check (location_code is null or location_code = 'q7');

alter table public.production_material_issue_items
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict;
alter table public.production_material_issue_items
  add column if not exists q7_mapping_id uuid references public.q7_material_issue_material_mappings(id) on delete restrict;
alter table public.production_material_issue_items
  add column if not exists source_unit text;
alter table public.production_material_issue_items
  add column if not exists source_required_qty numeric;
alter table public.production_material_issue_items
  add column if not exists conversion_factor numeric(18, 8);

alter table public.production_material_issue_items
  drop constraint if exists production_material_issue_items_q7_source_qty_check,
  drop constraint if exists production_material_issue_items_q7_conversion_check;

alter table public.production_material_issue_items
  add constraint production_material_issue_items_q7_source_qty_check
  check (source_required_qty is null or (
    source_required_qty >= 0
    and source_required_qty::text not in ('NaN', 'Infinity', '-Infinity')
  )),
  add constraint production_material_issue_items_q7_conversion_check
  check (conversion_factor is null or (
    conversion_factor > 0
    and conversion_factor::text not in ('NaN', 'Infinity', '-Infinity')
  ));

alter table public.production_material_issue_items enable row level security;

drop policy if exists "production_material_issue_items_view" on public.production_material_issue_items;
drop policy if exists "production_material_issue_items_edit" on public.production_material_issue_items;
drop policy if exists "p_production_material_issue_items_select_access" on public.production_material_issue_items;
drop policy if exists "p_production_material_issue_items_insert_access" on public.production_material_issue_items;
drop policy if exists "p_production_material_issue_items_update_access" on public.production_material_issue_items;
drop policy if exists "p_production_material_issue_items_delete_access" on public.production_material_issue_items;
drop policy if exists q7_production_material_issue_items_select on public.production_material_issue_items;
create policy q7_production_material_issue_items_select
  on public.production_material_issue_items for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'production_q7', 'view')
    or public.has_module_permission((select auth.uid()), 'warehouse', 'view')
    or public.has_module_permission((select auth.uid()), 'kitchen_inventory', 'view')
    or public.has_module_permission((select auth.uid()), 'q7_material_inventory', 'view')
  );

revoke all on public.production_material_issue_items from public, anon, authenticated;
grant select on public.production_material_issue_items to authenticated;

create or replace function public.q7_material_issue_can_edit(v_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.has_role(v_actor_id, 'owner')
    or public.has_module_permission(v_actor_id, 'production_q7', 'edit')
    or public.has_module_permission(v_actor_id, 'warehouse', 'edit')
    or public.has_module_permission(v_actor_id, 'kitchen_inventory', 'edit')
    or public.has_module_permission(v_actor_id, 'q7_material_inventory', 'edit');
$$;

create or replace function public.generate_q7_production_material_issue(
  p_production_order_id uuid,
  p_expected_issue_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  order_row public.production_orders%rowtype;
  current_issue public.production_material_issues%rowtype;
  v_has_current_issue boolean := false;
  v_issue_id uuid;
  v_issue_number text;
  v_issue_date date;
  v_source_hash text;
  v_next_revision integer := 1;
  v_blockers jsonb := '[]'::jsonb;
  v_total_amount numeric(16, 2) := 0;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  elsif not (
    public.has_role(v_actor_id, 'owner')
    or public.has_module_permission(v_actor_id, 'production_q7', 'edit')
    or public.has_module_permission(v_actor_id, 'warehouse', 'edit')
    or public.has_module_permission(v_actor_id, 'kitchen_inventory', 'edit')
    or public.has_module_permission(v_actor_id, 'q7_material_inventory', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('q7_production_material_issue'), hashtext(p_production_order_id::text));

  select * into order_row
  from public.production_orders
  where id = p_production_order_id for update;

  if not found then
    raise exception 'production_order_not_found' using errcode = 'P0002';
  end if;

  select coalesce(
    order_row.planned_start_date,
    (select min(poi.delivery_date) from public.production_order_items poi where poi.production_order_id = p_production_order_id),
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  ) into v_issue_date;

  if p_expected_issue_date is not null and p_expected_issue_date is distinct from v_issue_date then
    return jsonb_build_object(
      'status', 'blocked_issue_date_changed',
      'production_order_id', p_production_order_id,
      'blockers', jsonb_build_array(jsonb_build_object('status', 'blocked_issue_date_changed'))
    );
  end if;

  perform pg_advisory_xact_lock(hashtext('q7_production_material_issue_date'), hashtext(v_issue_date::text));

  select * into current_issue
  from public.production_material_issues
  where production_order_id = p_production_order_id
    and status not in ('superseded', 'cancelled')
  for update;
  v_has_current_issue := found;

  if order_row.location_code is distinct from 'q7' then
    return jsonb_build_object(
      'status', 'blocked_non_q7_order',
      'production_order_id', p_production_order_id,
      'blockers', jsonb_build_array(jsonb_build_object('status', 'blocked_non_q7_order', 'details', jsonb_build_object('location_code', order_row.location_code)))
    );
  end if;

  if order_row.status::text = 'cancelled' then
    return jsonb_build_object(
      'status', 'blocked_cancelled_order',
      'production_order_id', p_production_order_id,
      'blockers', jsonb_build_array(jsonb_build_object('status', 'blocked_cancelled_order'))
    );
  end if;

  if order_row.status::text = 'completed' and not (v_has_current_issue and current_issue.status = 'posted') then
    return jsonb_build_object(
      'status', 'blocked_completed_order',
      'production_order_id', p_production_order_id,
      'blockers', jsonb_build_array(jsonb_build_object('status', 'blocked_completed_order'))
    );
  end if;

  if order_row.status::text not in ('planned', 'in_progress', 'completed') then
    return jsonb_build_object(
      'status', 'blocked_ineligible_status',
      'production_order_id', p_production_order_id,
      'blockers', jsonb_build_array(jsonb_build_object('status', 'blocked_ineligible_status', 'details', jsonb_build_object('order_status', order_row.status)))
    );
  end if;

  create temp table if not exists q7_order_lines (
    production_order_item_id uuid primary key,
    finished_sku_id uuid,
    product_name text not null,
    finished_qty numeric,
    selected_version_id uuid,
    selected_version_no integer,
    selected_finished_output_qty numeric,
    selected_parent_name text,
    selected_effective_from date
  ) on commit drop;
  truncate table q7_order_lines;

  insert into q7_order_lines(
    production_order_item_id, finished_sku_id, product_name, finished_qty,
    selected_version_id, selected_version_no, selected_finished_output_qty,
    selected_parent_name, selected_effective_from
  )
  select
    poi.id,
    poi.sku_id,
    poi.product_name,
    case
      when poi.actual_qty > 0 then poi.actual_qty
      when poi.planned_qty > 0 then poi.planned_qty
      when poi.ordered_qty > 0 then poi.ordered_qty
      else coalesce(nullif(poi.actual_qty, 0), nullif(poi.planned_qty, 0), nullif(poi.ordered_qty, 0))
    end,
    latest_version.id,
    latest_version.version_no,
    case
      when nullif(latest_version.product_snapshot ->> 'finished_output_qty', '') ~ '^[0-9]+(\.[0-9]+)?$'
        then (latest_version.product_snapshot ->> 'finished_output_qty')::numeric
      else null
    end,
    nullif(btrim(latest_version.product_snapshot ->> 'product_name'), ''),
    latest_version.effective_from
  from public.production_order_items poi
  left join lateral (
    select v.id, v.version_no, v.effective_from, v.product_snapshot
    from public.sku_cogs_versions v
    where v.sku_id = poi.sku_id
      and v.effective_from <= v_issue_date
      and (v.effective_to is null or v_issue_date <= v.effective_to)
    order by v.effective_from desc, v.version_no desc, v.id::text desc
    limit 1
  ) latest_version on true
  where poi.production_order_id = p_production_order_id;

  create temp table if not exists blockers (
    status text not null,
    details jsonb not null
  ) on commit drop;
  truncate table blockers;

  insert into blockers(status, details)
  select 'blocked_missing_finished_skus', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'product_name', product_name
  ))
  from q7_order_lines
  where finished_sku_id is null
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_nonpositive_quantities', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'product_name', product_name,
    'finished_qty', finished_qty
  ))
  from q7_order_lines
  where coalesce(finished_qty, 0) <= 0
    or finished_qty::text in ('NaN', 'Infinity', '-Infinity')
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_missing_formulations', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'finished_sku_id', finished_sku_id,
    'product_name', product_name
  ))
  from q7_order_lines
  where finished_sku_id is not null
    and selected_version_id is null
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_invalid_formulations', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'finished_sku_id', finished_sku_id,
    'finished_output_qty', selected_finished_output_qty
  ))
  from q7_order_lines
  where selected_version_id is not null
    and (
      coalesce(selected_finished_output_qty, 0) <= 0
      or selected_finished_output_qty::text in ('NaN', 'Infinity', '-Infinity')
    )
  having count(*) > 0;

  create temp table if not exists leaf_formulations (
    production_order_item_id uuid not null,
    version_id uuid not null,
    canonical_material_id uuid,
    material_code text,
    ingredient_name text not null,
    source_unit text,
    unit_cost numeric,
    dosage_qty numeric,
    wastage_percent numeric,
    sort_order integer
  ) on commit drop;
  truncate table leaf_formulations;

  insert into leaf_formulations(
    production_order_item_id, version_id, canonical_material_id, material_code,
    ingredient_name, source_unit, unit_cost, dosage_qty, wastage_percent, sort_order
  )
  select
    ol.production_order_item_id,
    f.version_id,
    f.canonical_material_id,
    nullif(btrim(f.material_code), ''),
    case
      when ol.selected_parent_name is not null and position(ol.selected_parent_name || ' > ' in f.ingredient_name) = 1
        then replace(f.ingredient_name, ol.selected_parent_name || ' > ', '')
      else f.ingredient_name
    end,
    lower(nullif(btrim(f.unit), '')),
    coalesce(f.unit_price, 0),
    f.dosage_qty,
    f.wastage_percent,
    coalesce(f.sort_order, 0)
  from q7_order_lines ol
  join public.sku_cogs_version_formulations f on f.version_id = ol.selected_version_id
  where ol.selected_version_id is not null
    and not exists (
      select 1
      from public.sku_cogs_version_formulations child
      where child.version_id = f.version_id
        and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
    );

  insert into blockers(status, details)
  select 'blocked_missing_formulations', jsonb_agg(jsonb_build_object(
    'production_order_item_id', ol.production_order_item_id,
    'finished_sku_id', ol.finished_sku_id,
    'version_id', ol.selected_version_id,
    'version_no', ol.selected_version_no,
    'product_name', ol.product_name
  ))
  from q7_order_lines ol
  where ol.selected_version_id is not null
    and not exists (select 1 from leaf_formulations lf where lf.production_order_item_id = ol.production_order_item_id)
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_invalid_formulations', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'ingredient_name', ingredient_name,
    'dosage_qty', dosage_qty,
    'wastage_percent', wastage_percent
  ))
  from leaf_formulations
  where canonical_material_id is null
    or source_unit is null
    or coalesce(dosage_qty, 0) <= 0
    or dosage_qty::text in ('NaN', 'Infinity', '-Infinity')
    or wastage_percent is null
    or wastage_percent < 0
    or wastage_percent::text in ('NaN', 'Infinity', '-Infinity')
  having count(*) > 0;

  create temp table if not exists calc_rows (
    production_order_item_id uuid not null,
    finished_sku_id uuid not null,
    selected_version_id uuid not null,
    selected_version_no integer,
    canonical_material_id uuid not null,
    material_code text,
    ingredient_name text not null,
    source_unit text not null,
    source_required_qty numeric not null,
    unit_cost numeric not null,
    amount numeric not null,
    sort_order integer not null
  ) on commit drop;
  truncate table calc_rows;

  insert into calc_rows(
    production_order_item_id, finished_sku_id, selected_version_id, selected_version_no,
    canonical_material_id, material_code, ingredient_name, source_unit,
    source_required_qty, unit_cost, amount, sort_order
  )
  select
    ol.production_order_item_id,
    ol.finished_sku_id,
    ol.selected_version_id,
    ol.selected_version_no,
    f.canonical_material_id,
    f.material_code,
    f.ingredient_name,
    f.source_unit,
    round(((ol.finished_qty / ol.selected_finished_output_qty) * f.dosage_qty * (1 + f.wastage_percent / 100.0))::numeric, 6),
    f.unit_cost,
    round(((ol.finished_qty / ol.selected_finished_output_qty) * f.dosage_qty * (1 + f.wastage_percent / 100.0) * f.unit_cost)::numeric, 2),
    f.sort_order
  from q7_order_lines ol
  join leaf_formulations f on f.production_order_item_id = ol.production_order_item_id
  where ol.finished_sku_id is not null
    and ol.finished_qty > 0
    and ol.finished_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and ol.selected_finished_output_qty > 0
    and ol.selected_finished_output_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and f.canonical_material_id is not null
    and f.source_unit is not null
    and f.dosage_qty > 0
    and f.dosage_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and f.wastage_percent >= 0
    and f.wastage_percent::text not in ('NaN', 'Infinity', '-Infinity');

  insert into blockers(status, details)
  select 'blocked_nonpositive_required_qty', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'ingredient_name', ingredient_name,
    'source_required_qty', source_required_qty
  ))
  from calc_rows
  where coalesce(source_required_qty, 0) <= 0
    or source_required_qty::text in ('NaN', 'Infinity', '-Infinity')
  having count(*) > 0;

  create temp table if not exists mapping_candidates (
    canonical_material_id uuid not null,
    source_unit text not null,
    mapping_count integer not null,
    q7_mapping_id uuid,
    kitchen_inventory_item_id uuid,
    kitchen_unit text,
    conversion_factor numeric(18, 8)
  ) on commit drop;
  truncate table mapping_candidates;

  insert into mapping_candidates(
    canonical_material_id, source_unit, mapping_count, q7_mapping_id,
    kitchen_inventory_item_id, kitchen_unit, conversion_factor
  )
  select
    cr.canonical_material_id,
    cr.source_unit,
    count(m.id) filter (where m.approval_status = 'approved') as mapping_count,
    (array_agg(m.id order by m.id::text) filter (where m.approval_status = 'approved'))[1],
    (array_agg(m.kitchen_inventory_item_id order by m.id::text) filter (where m.approval_status = 'approved'))[1],
    (array_agg(m.kitchen_unit order by m.id::text) filter (where m.approval_status = 'approved'))[1],
    (array_agg(m.conversion_factor order by m.id::text) filter (where m.approval_status = 'approved'))[1]
  from (select distinct canonical_material_id, source_unit from calc_rows) cr
  left join public.q7_material_issue_material_mappings m
    on m.canonical_material_id = cr.canonical_material_id
   and lower(btrim(m.source_unit)) = cr.source_unit
  group by cr.canonical_material_id, cr.source_unit;

  insert into blockers(status, details)
  select 'blocked_missing_q7_mappings', jsonb_agg(jsonb_build_object(
    'canonical_material_id', canonical_material_id,
    'source_unit', source_unit
  ))
  from mapping_candidates
  where mapping_count = 0
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_duplicate_q7_mappings', jsonb_agg(jsonb_build_object(
    'canonical_material_id', canonical_material_id,
    'source_unit', source_unit,
    'mapping_count', mapping_count
  ))
  from mapping_candidates
  where mapping_count <> 1 and mapping_count > 1
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_invalid_q7_mappings', jsonb_agg(jsonb_build_object(
    'canonical_material_id', canonical_material_id,
    'source_unit', source_unit,
    'q7_mapping_id', q7_mapping_id,
    'conversion_factor', conversion_factor
  ))
  from mapping_candidates
  where mapping_count = 1
    and (
      conversion_factor is null
      or conversion_factor <= 0
      or conversion_factor::text in ('NaN', 'Infinity', '-Infinity')
      or kitchen_unit is null
      or btrim(kitchen_unit) = ''
      or kitchen_inventory_item_id is null
    )
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_missing_kitchen_items', jsonb_agg(jsonb_build_object(
    'canonical_material_id', mc.canonical_material_id,
    'source_unit', mc.source_unit,
    'q7_mapping_id', mc.q7_mapping_id,
    'kitchen_inventory_item_id', mc.kitchen_inventory_item_id
  ))
  from mapping_candidates mc
  left join public.kitchen_inventory_items kii on kii.id = mc.kitchen_inventory_item_id and kii.active = true
  where mc.mapping_count = 1
    and (mc.kitchen_inventory_item_id is null or kii.id is null)
  having count(*) > 0;

  if exists (select 1 from blockers) then
    select jsonb_agg(jsonb_build_object('status', status, 'details', details) order by status)
      into v_blockers
    from blockers;

    return jsonb_build_object(
      'status', (select status from blockers order by status limit 1),
      'production_order_id', p_production_order_id,
      'blockers', coalesce(v_blockers, '[]'::jsonb)
    );
  end if;

  create temp table if not exists agg_items (
    production_order_item_id uuid not null,
    finished_sku_id uuid not null,
    selected_version_id uuid not null,
    canonical_material_id uuid not null,
    q7_mapping_id uuid not null,
    kitchen_inventory_item_id uuid not null,
    ingredient_name text not null,
    material_code text,
    source_unit text not null,
    source_required_qty numeric not null,
    conversion_factor numeric(18, 8) not null,
    required_qty numeric(15, 3) not null,
    kitchen_unit text not null,
    unit_cost numeric(14, 2) not null,
    amount numeric(16, 2) not null,
    sort_order integer not null,
    source_ref_key text not null
  ) on commit drop;
  truncate table agg_items;

  insert into agg_items(
    production_order_item_id, finished_sku_id, selected_version_id,
    canonical_material_id, q7_mapping_id, kitchen_inventory_item_id,
    ingredient_name, material_code, source_unit, source_required_qty,
    conversion_factor, required_qty, kitchen_unit, unit_cost, amount, sort_order,
    source_ref_key
  )
  select
    min(cr.production_order_item_id::text)::uuid,
    min(cr.finished_sku_id::text)::uuid,
    min(cr.selected_version_id::text)::uuid,
    cr.canonical_material_id,
    mc.q7_mapping_id,
    mc.kitchen_inventory_item_id,
    min(cr.ingredient_name),
    min(cr.material_code) filter (where cr.material_code is not null),
    cr.source_unit,
    round(sum(cr.source_required_qty)::numeric, 6),
    mc.conversion_factor,
    round((sum(cr.source_required_qty) * mc.conversion_factor)::numeric, 3),
    mc.kitchen_unit,
    0::numeric(14, 2),
    0::numeric(16, 2),
    min(cr.sort_order),
    cr.canonical_material_id::text || '|' || cr.source_unit || '|' || mc.q7_mapping_id::text
  from calc_rows cr
  join mapping_candidates mc
    on mc.canonical_material_id = cr.canonical_material_id
   and mc.source_unit = cr.source_unit
  where mc.mapping_count = 1
    and mc.conversion_factor > 0
  group by cr.canonical_material_id, cr.source_unit, mc.q7_mapping_id,
    mc.kitchen_inventory_item_id, mc.kitchen_unit, mc.conversion_factor;

  select coalesce(sum(amount), 0) into v_total_amount from agg_items;

  insert into blockers(status, details)
  select 'blocked_nonpositive_required_qty', jsonb_agg(jsonb_build_object(
    'canonical_material_id', canonical_material_id,
    'source_unit', source_unit,
    'required_qty', required_qty,
    'conversion_factor', conversion_factor
  ))
  from agg_items
  where required_qty <= 0
    or required_qty::text in ('NaN', 'Infinity', '-Infinity')
    or source_required_qty * conversion_factor <= 0
  having count(*) > 0;

  if exists (select 1 from blockers) then
    select jsonb_agg(jsonb_build_object('status', status, 'details', details) order by status)
      into v_blockers
    from blockers;

    return jsonb_build_object(
      'status', (select status from blockers order by status limit 1),
      'production_order_id', p_production_order_id,
      'blockers', coalesce(v_blockers, '[]'::jsonb)
    );
  end if;

  select encode(extensions.digest(string_agg(snapshot_key, '|' order by snapshot_key), 'sha256'), 'hex')
    into v_source_hash
  from (
    select 'O|' || order_row.id::text || '|' || order_row.production_number || '|' || v_issue_date::text as snapshot_key
    union all
    select 'L|' || ol.production_order_item_id::text || '|' || ol.finished_sku_id::text || '|' || ol.finished_qty::text || '|' || ol.selected_version_id::text || '|' || coalesce(ol.selected_version_no::text, '') || '|' || coalesce(ol.selected_finished_output_qty::text, '')
    from q7_order_lines ol
    union all
    select 'F|' || cr.production_order_item_id::text || '|' || cr.selected_version_id::text || '|' || cr.canonical_material_id::text || '|' || cr.source_unit || '|' || cr.source_required_qty::text
    from calc_rows cr
    union all
    select 'M|' || ai.canonical_material_id::text || '|' || ai.source_unit || '|' || ai.q7_mapping_id::text || '|' || ai.kitchen_inventory_item_id::text || '|' || ai.kitchen_unit || '|' || ai.conversion_factor::text || '|' || ai.required_qty::text
    from agg_items ai
  ) stable_snapshot;

  if v_has_current_issue
    and current_issue.status in ('generated', 'pdf_ready', 'signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review', 'posted')
    and current_issue.source_hash = v_source_hash then
    return jsonb_build_object(
      'status', current_issue.status || '_unchanged',
      'issue_id', current_issue.id,
      'issue_number', current_issue.issue_number,
      'revision', current_issue.revision,
      'source_hash', current_issue.source_hash,
      'item_count', (select count(*) from public.production_material_issue_items i where i.material_issue_id = current_issue.id),
      'blockers', '[]'::jsonb
    );
  end if;

  if v_has_current_issue and current_issue.status = 'posted' then
    return jsonb_build_object(
      'status', 'blocked_posted_issue_changed',
      'issue_id', current_issue.id,
      'issue_number', current_issue.issue_number,
      'revision', current_issue.revision,
      'source_hash', current_issue.source_hash,
      'blockers', jsonb_build_array(jsonb_build_object('status', 'blocked_posted_issue_changed'))
    );
  end if;

  if v_has_current_issue then
    update public.production_material_issues set status = 'superseded', updated_at = now()
    where id = current_issue.id;

    update public.production_material_issues set is_current = false
    where id = current_issue.id;

    insert into public.production_material_issue_events(
      issue_id, event_type, from_status, to_status, actor, metadata
    ) values (
      current_issue.id, 'superseded', current_issue.status, 'superseded', v_actor_id,
      jsonb_build_object('replacement_source_hash', v_source_hash)
    );

    v_next_revision := current_issue.revision + 1;
  else
    v_next_revision := 1;
  end if;

  select 'PXK-NVL-Q7-' || to_char(v_issue_date, 'YYYYMMDD') || '-' || lpad((coalesce(max(split_part(issue_number, '-', 5)::integer), 0) + 1)::text, 3, '0')
    into v_issue_number
  from public.production_material_issues
  where issue_number like 'PXK-NVL-Q7-' || to_char(v_issue_date, 'YYYYMMDD') || '-%'
    and split_part(issue_number, '-', 5) ~ '^[0-9]+$';

  insert into public.production_material_issues(
    issue_number, production_order_id, source_po_inbox_id, revenue_draft_id,
    sales_po_doc_id, issue_date, status, total_amount, notes, created_by,
    location_code, revision, source_hash
  ) values (
    v_issue_number, order_row.id, order_row.source_po_inbox_id, order_row.revenue_draft_id,
    order_row.sales_po_doc_id, v_issue_date, 'generated', v_total_amount,
    'Q7 generated material issue snapshot; no inventory deduction', v_actor_id,
    'q7', v_next_revision, v_source_hash
  ) returning id into v_issue_id;

  if v_has_current_issue then
    update public.production_material_issues
    set superseded_by_issue_id = v_issue_id
    where id = current_issue.id;
  end if;

  insert into public.production_material_issue_items(
    material_issue_id, production_order_item_id, finished_sku_id,
    kitchen_inventory_item_id, ingredient_name, material_code,
    planned_finished_qty, dosage_qty, wastage_percent, required_qty, unit,
    unit_cost, amount, source_ref_key, canonical_material_id, q7_mapping_id,
    source_unit, source_required_qty, conversion_factor
  )
  select
    v_issue_id, production_order_item_id, finished_sku_id,
    kitchen_inventory_item_id, ingredient_name, material_code,
    0, 0, 0, required_qty, kitchen_unit,
    unit_cost, amount, source_ref_key, canonical_material_id, q7_mapping_id,
    source_unit, source_required_qty, conversion_factor
  from agg_items
  order by sort_order, ingredient_name, source_ref_key;

  insert into public.production_material_issue_events(
    issue_id, event_type, from_status, to_status, actor, metadata
  ) values (
    v_issue_id, 'generation_generated', null, 'generated', v_actor_id,
    jsonb_build_object('production_order_id', p_production_order_id, 'source_hash', v_source_hash)
  );

  return jsonb_build_object(
    'status', 'generated',
    'issue_id', v_issue_id,
    'issue_number', v_issue_number,
    'revision', v_next_revision,
    'source_hash', v_source_hash,
    'item_count', (select count(*) from agg_items),
    'blockers', '[]'::jsonb
  );
end;
$$;

revoke all on function public.q7_material_issue_can_edit(uuid) from public, anon, authenticated;
revoke all on function public.generate_q7_production_material_issue(uuid,date) from public;
revoke execute on function public.generate_q7_production_material_issue(uuid,date) from public;
revoke all on function public.generate_q7_production_material_issue(uuid,date) from anon;
revoke execute on function public.generate_q7_production_material_issue(uuid,date) from anon;
revoke all on function public.generate_q7_production_material_issue(uuid,date) from authenticated;
grant execute on function public.generate_q7_production_material_issue(uuid,date) to authenticated, service_role;

-- Task 4: private server-generated Q7 material issue PDF documents.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'production-material-issue-documents',
  'production-material-issue-documents',
  false,
  20971520,
  array['application/pdf']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.consume_q7_material_issue_pdf_rate_limit(
  p_user_id uuid,
  p_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_function_name text := 'production-material-issue-pdf';
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_usage_count integer;
  v_allowed boolean;
  v_retry_after_seconds integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;

  if p_daily_limit is null or p_daily_limit < 1 or p_daily_limit > 500 then
    raise exception 'invalid_daily_limit' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'user_not_found' using errcode = '22023';
  end if;

  v_window_start := date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh';
  v_window_end := v_window_start + interval '1 day';

  insert into public.ai_function_rate_limits(
    user_id, function_name, usage_count, window_start, window_end, created_at, updated_at
  ) values (
    p_user_id, v_function_name, 1, v_window_start, v_window_end, now(), now()
  )
  on conflict (user_id, function_name, window_start) do update
  set usage_count = public.ai_function_rate_limits.usage_count + 1,
      window_end = excluded.window_end,
      updated_at = now()
  returning usage_count into v_usage_count;

  v_allowed := v_usage_count <= p_daily_limit;
  v_retry_after_seconds := case
    when v_allowed then null
    else greatest(1, ceil(extract(epoch from (v_window_end - now())))::integer)
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'remaining', greatest(0, p_daily_limit - v_usage_count),
    'reset', v_window_end,
    'retry_after_seconds', v_retry_after_seconds
  );
end;
$$;

revoke all on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) from public;
revoke execute on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) from public;
revoke all on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) from anon;
revoke execute on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) from anon;
revoke all on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) from authenticated;
revoke execute on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) from authenticated;
grant execute on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) to service_role;

create or replace function public.record_q7_material_issue_pdf(
  p_issue_id uuid,
  p_pdf_path text,
  p_pdf_sha256 text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_issue public.production_material_issues%rowtype;
  v_expected_path text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_actor_id is null then
    raise exception 'actor_required' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_actor_id) then
    raise exception 'actor_not_found' using errcode = '22023';
  end if;

  if p_pdf_sha256 is null or p_pdf_sha256 !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'invalid_pdf_sha256' using errcode = '22023';
  end if;

  select * into v_issue
  from public.production_material_issues
  where id = p_issue_id
  for update;

  if not found then
    raise exception 'material_issue_not_found' using errcode = 'P0002';
  end if;

  v_expected_path := 'q7/' || v_issue.id::text || '/revision-' || v_issue.revision::text || '/original.pdf';

  if v_issue.location_code is distinct from 'q7' then
    raise exception 'blocked_non_q7_issue' using errcode = '22023';
  end if;

  if v_issue.is_current is not true or v_issue.superseded_by_issue_id is not null then
    raise exception 'blocked_non_current_issue' using errcode = '22023';
  end if;

  if v_issue.status in ('superseded', 'cancelled', 'signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review', 'posted') then
    raise exception 'blocked_issue_status' using errcode = '22023';
  end if;

  if v_issue.status not in ('generated', 'pdf_ready') then
    raise exception 'blocked_issue_status' using errcode = '22023';
  end if;

  if p_pdf_path is distinct from v_expected_path then
    raise exception 'invalid_pdf_path' using errcode = '22023';
  end if;

  if v_issue.status = 'pdf_ready' then
    if v_issue.pdf_path is not distinct from p_pdf_path
       and v_issue.pdf_sha256 is not distinct from lower(p_pdf_sha256) then
      return jsonb_build_object(
        'status', 'pdf_ready_unchanged',
        'issue_id', v_issue.id,
        'issue_number', v_issue.issue_number,
        'revision', v_issue.revision,
        'pdf_sha256', v_issue.pdf_sha256
      );
    end if;
    raise exception 'pdf_metadata_mismatch' using errcode = '22023';
  end if;

  if v_issue.pdf_path is not null or v_issue.pdf_sha256 is not null then
    raise exception 'pdf_metadata_mismatch' using errcode = '22023';
  end if;

  update public.production_material_issues
  set pdf_path = p_pdf_path,
      pdf_sha256 = lower(p_pdf_sha256),
      status = 'pdf_ready',
      updated_at = now()
  where id = p_issue_id;

  insert into public.production_material_issue_events(
    issue_id, event_type, from_status, to_status, actor, metadata
  ) values (
    p_issue_id,
    'material_issue_pdf_ready',
    'generated',
    'pdf_ready',
    p_actor_id,
    jsonb_build_object('pdf_sha256', lower(p_pdf_sha256), 'revision', v_issue.revision)
  );

  return jsonb_build_object(
    'status', 'pdf_ready',
    'issue_id', v_issue.id,
    'issue_number', v_issue.issue_number,
    'revision', v_issue.revision,
    'pdf_sha256', lower(p_pdf_sha256)
  );
end;
$$;

revoke all on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) from public;
revoke execute on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) from public;
revoke all on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) from anon;
revoke execute on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) from anon;
revoke all on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) from authenticated;
revoke execute on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) from authenticated;
grant execute on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) to service_role;

-- Task 5A: private signed Q7 material issue PDF upload foundation.
-- Signed uploads are recorded by service-role-only RPCs after the Edge function
-- writes the private PDF object.  This task intentionally does not create signed
-- file review attempts, confirmation, posting, or inventory movement rows.

create or replace function public.consume_q7_material_issue_signed_upload_rate_limit(
  p_user_id uuid,
  p_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_function_name text := 'production-material-issue-signed-upload';
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_usage_count integer;
  v_allowed boolean;
  v_retry_after_seconds integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;

  if p_daily_limit is null or p_daily_limit < 1 or p_daily_limit > 500 then
    raise exception 'invalid_daily_limit' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'user_not_found' using errcode = '22023';
  end if;

  v_window_start := date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh';
  v_window_end := v_window_start + interval '1 day';

  insert into public.ai_function_rate_limits(
    user_id, function_name, usage_count, window_start, window_end, created_at, updated_at
  ) values (
    p_user_id, v_function_name, 1, v_window_start, v_window_end, now(), now()
  )
  on conflict (user_id, function_name, window_start) do update
  set usage_count = public.ai_function_rate_limits.usage_count + 1,
      window_end = excluded.window_end,
      updated_at = now()
  returning usage_count into v_usage_count;

  v_allowed := v_usage_count <= p_daily_limit;
  v_retry_after_seconds := case
    when v_allowed then null
    else greatest(1, ceil(extract(epoch from (v_window_end - now())))::integer)
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'remaining', greatest(0, p_daily_limit - v_usage_count),
    'reset', v_window_end,
    'retry_after_seconds', v_retry_after_seconds
  );
end;
$$;

revoke all on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) from public;
revoke execute on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) from public;
revoke all on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) from anon;
revoke execute on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) from anon;
revoke all on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) from authenticated;
revoke execute on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) from authenticated;
grant execute on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) to service_role;

create or replace function public.record_q7_material_issue_signed_upload(
  p_issue_id uuid,
  p_signed_path text,
  p_signed_sha256 text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue public.production_material_issues%rowtype;
  v_expected_path text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_actor_id is null then
    raise exception 'actor_required' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_actor_id) then
    raise exception 'actor_not_found' using errcode = '22023';
  end if;

  if p_signed_sha256 is null or p_signed_sha256 !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'invalid_signed_sha256' using errcode = '22023';
  end if;

  select * into v_issue
  from public.production_material_issues
  where id = p_issue_id
  for update;

  if not found then
    raise exception 'material_issue_not_found' using errcode = 'P0002';
  end if;

  v_expected_path := 'q7/' || v_issue.id::text || '/revision-' || v_issue.revision::text || '/signed/' || lower(p_signed_sha256) || '.pdf';

  if v_issue.location_code is distinct from 'q7' then
    raise exception 'blocked_non_q7_issue' using errcode = '22023';
  end if;

  if v_issue.is_current is not true or v_issue.superseded_by_issue_id is not null then
    raise exception 'blocked_non_current_issue' using errcode = '22023';
  end if;

  if v_issue.pdf_path is null or v_issue.pdf_sha256 is null then
    raise exception 'original_pdf_required' using errcode = '22023';
  end if;

  if p_signed_path is distinct from v_expected_path then
    raise exception 'invalid_signed_path' using errcode = '22023';
  end if;

  if v_issue.status = 'signed_uploaded' then
    if v_issue.signed_file_path is not distinct from p_signed_path
       and v_issue.signed_file_sha256 is not distinct from lower(p_signed_sha256) then
      return jsonb_build_object(
        'status', 'signed_uploaded_unchanged',
        'issue_id', v_issue.id,
        'issue_number', v_issue.issue_number,
        'revision', v_issue.revision,
        'signed_sha256', v_issue.signed_file_sha256
      );
    end if;
    raise exception 'signed_metadata_mismatch' using errcode = '22023';
  end if;

  if v_issue.status <> 'pdf_ready' then
    raise exception 'blocked_issue_status' using errcode = '22023';
  end if;

  if v_issue.signed_file_path is not null or v_issue.signed_file_sha256 is not null then
    raise exception 'signed_metadata_mismatch' using errcode = '22023';
  end if;

  update public.production_material_issues
  set signed_file_path = p_signed_path,
      signed_file_sha256 = lower(p_signed_sha256),
      signed_uploaded_by = p_actor_id,
      signed_uploaded_at = now(),
      status = 'signed_uploaded',
      updated_at = now()
  where id = p_issue_id;

  insert into public.production_material_issue_events(
    issue_id, event_type, from_status, to_status, actor, metadata
  ) values (
    p_issue_id,
    'material_issue_signed_uploaded',
    'pdf_ready',
    'signed_uploaded',
    p_actor_id,
    jsonb_build_object('signed_sha256', lower(p_signed_sha256), 'revision', v_issue.revision)
  );

  return jsonb_build_object(
    'status', 'signed_uploaded',
    'issue_id', v_issue.id,
    'issue_number', v_issue.issue_number,
    'revision', v_issue.revision,
    'signed_sha256', lower(p_signed_sha256)
  );
end;
$$;

revoke all on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) from public;
revoke execute on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) from public;
revoke all on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) from anon;
revoke execute on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) from anon;
revoke all on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) from authenticated;
revoke execute on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) from authenticated;
grant execute on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) to service_role;

-- Task 6A: one-time automated signed Q7 material issue document check.
-- The Edge function may claim exactly one attempt per signed file SHA and then
-- finalize it once.  This task intentionally performs no confirmation,
-- posting, inventory deduction, or kitchen ledger writes.

create or replace function public.consume_q7_material_issue_check_rate_limit(
  p_user_id uuid,
  p_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_function_name text := 'production-material-issue-check';
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_usage_count integer;
  v_allowed boolean;
  v_retry_after_seconds integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;

  if p_daily_limit is null or p_daily_limit < 1 or p_daily_limit > 500 then
    raise exception 'invalid_daily_limit' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'user_not_found' using errcode = '22023';
  end if;

  v_window_start := date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh';
  v_window_end := v_window_start + interval '1 day';

  insert into public.ai_function_rate_limits(
    user_id, function_name, usage_count, window_start, window_end, created_at, updated_at
  ) values (
    p_user_id, v_function_name, 1, v_window_start, v_window_end, now(), now()
  )
  on conflict (user_id, function_name, window_start) do update
  set usage_count = public.ai_function_rate_limits.usage_count + 1,
      window_end = excluded.window_end,
      updated_at = now()
  returning usage_count into v_usage_count;

  v_allowed := v_usage_count <= p_daily_limit;
  v_retry_after_seconds := case
    when v_allowed then null
    else greatest(1, ceil(extract(epoch from (v_window_end - now())))::integer)
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'remaining', greatest(0, p_daily_limit - v_usage_count),
    'reset', v_window_end,
    'retry_after_seconds', v_retry_after_seconds
  );
end;
$$;

revoke all on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) from public;
revoke execute on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) from public;
revoke all on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) from anon;
revoke execute on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) from anon;
revoke all on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) from authenticated;
revoke execute on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) from authenticated;
grant execute on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) to service_role;

create or replace function public.begin_q7_material_issue_check(
  p_issue_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue public.production_material_issues%rowtype;
  v_check public.production_material_issue_checks%rowtype;
  v_inserted_count integer;
  v_production_order_number text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_actor_id is null then
    raise exception 'actor_required' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_actor_id) then
    raise exception 'actor_not_found' using errcode = '22023';
  end if;

  select * into v_issue
  from public.production_material_issues
  where id = p_issue_id for update;

  if not found then
    raise exception 'material_issue_not_found' using errcode = 'P0002';
  end if;

  if v_issue.location_code is distinct from 'q7' then
    raise exception 'blocked_non_q7_issue' using errcode = '22023';
  end if;

  if v_issue.is_current is not true or v_issue.superseded_by_issue_id is not null then
    raise exception 'blocked_non_current_issue' using errcode = '22023';
  end if;

  if v_issue.status not in ('signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review') then
    raise exception 'blocked_issue_status' using errcode = '22023';
  end if;

  if v_issue.pdf_path is null or v_issue.pdf_sha256 is null then
    raise exception 'original_pdf_required' using errcode = '22023';
  end if;

  if v_issue.pdf_sha256 !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'invalid_original_pdf_sha256' using errcode = '22023';
  end if;

  if v_issue.signed_file_path is null or v_issue.signed_file_sha256 is null then
    raise exception 'signed_pdf_required' using errcode = '22023';
  end if;

  if v_issue.signed_file_sha256 !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'invalid_signed_sha256' using errcode = '22023';
  end if;

  select po.production_number into v_production_order_number
  from public.production_orders po
  where po.id = v_issue.production_order_id;

  -- A non-uploaded workflow state is valid only when the immutable check row
  -- already exists. Never create a fresh attempt on a drifted terminal issue.
  if v_issue.status <> 'signed_uploaded'
     and not exists (
       select 1
       from public.production_material_issue_checks c
       where c.issue_id = v_issue.id
         and c.signed_file_sha256 = lower(v_issue.signed_file_sha256)
     ) then
    raise exception 'blocked_missing_check_state' using errcode = '22023';
  end if;

  insert into public.production_material_issue_checks(
    issue_id, signed_file_sha256, attempt_no, status, checked_by
  ) values (
    v_issue.id, lower(v_issue.signed_file_sha256), 1, 'checking', p_actor_id
  )
  on conflict (issue_id, signed_file_sha256) do nothing
  returning * into v_check;
  get diagnostics v_inserted_count = row_count;

  if v_inserted_count = 1 then
    update public.production_material_issues
    set status = 'checking',
        check_status = 'pending',
        updated_at = now()
    where id = p_issue_id and status = 'signed_uploaded';

    insert into public.production_material_issue_events(
      issue_id, event_type, from_status, to_status, actor, metadata
    ) values (
      v_issue.id,
      'material_issue_check_started',
      v_issue.status,
      'checking',
      p_actor_id,
      jsonb_build_object('check_id', v_check.id, 'revision', v_issue.revision)
    );

    return jsonb_build_object(
      'status', 'checking_started',
      'check_id', v_check.id,
      'issue_id', v_issue.id,
      'issue_number', v_issue.issue_number,
      'issue_date', v_issue.issue_date,
      'revision', v_issue.revision,
      'production_order_id', v_issue.production_order_id,
      'production_order_number', v_production_order_number,
      'signed_file_path', v_issue.signed_file_path,
      'signed_file_sha256', lower(v_issue.signed_file_sha256)
    );
  end if;

  select * into v_check
  from public.production_material_issue_checks
  where issue_id = v_issue.id
    and signed_file_sha256 = lower(v_issue.signed_file_sha256)
  for update;

  if v_check.status = 'checking' then
    return jsonb_build_object(
      'status', 'checking_unchanged',
      'check_id', v_check.id,
      'issue_id', v_issue.id,
      'issue_number', v_issue.issue_number,
      'issue_date', v_issue.issue_date,
      'revision', v_issue.revision,
      'production_order_id', v_issue.production_order_id,
      'production_order_number', v_production_order_number
    );
  end if;

  return jsonb_build_object(
    'status', 'already_checked',
    'check_id', v_check.id,
    'issue_id', v_issue.id,
    'issue_number', v_issue.issue_number,
    'issue_date', v_issue.issue_date,
    'revision', v_issue.revision,
    'production_order_id', v_issue.production_order_id,
    'production_order_number', v_production_order_number,
    'check_status', v_check.status,
    'result', v_check.result,
    'model', v_check.model,
    'model_version', v_check.model_version,
    'checked_at', v_check.checked_at
  );
end;
$$;

revoke all on function public.begin_q7_material_issue_check(uuid, uuid) from public;
revoke execute on function public.begin_q7_material_issue_check(uuid, uuid) from public;
revoke all on function public.begin_q7_material_issue_check(uuid, uuid) from anon;
revoke execute on function public.begin_q7_material_issue_check(uuid, uuid) from anon;
revoke all on function public.begin_q7_material_issue_check(uuid, uuid) from authenticated;
revoke execute on function public.begin_q7_material_issue_check(uuid, uuid) from authenticated;
grant execute on function public.begin_q7_material_issue_check(uuid, uuid) to service_role;

create or replace function public.finalize_q7_material_issue_check(
  p_check_id uuid,
  p_signed_sha256 text,
  p_outcome text,
  p_result jsonb,
  p_model text,
  p_model_version text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check public.production_material_issue_checks%rowtype;
  v_issue public.production_material_issues%rowtype;
  v_to_status text;
  v_check_status text;
  v_confidence numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_actor_id is null then
    raise exception 'actor_required' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_actor_id) then
    raise exception 'actor_not_found' using errcode = '22023';
  end if;

  if p_signed_sha256 is null or p_signed_sha256 !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'invalid_signed_sha256' using errcode = '22023';
  end if;

  if p_outcome not in ('passed', 'needs_review', 'failed', 'failed_transient', 'error') then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;

  if p_result is null or jsonb_typeof(p_result) <> 'object' then
    raise exception 'invalid_result' using errcode = '22023';
  end if;

  if octet_length(p_result::text) > 20000 then
    raise exception 'result_too_large' using errcode = '22023';
  end if;

  select * into v_check
  from public.production_material_issue_checks
  where id = p_check_id
  for update;

  if not found then
    raise exception 'check_not_found' using errcode = 'P0002';
  end if;

  select * into v_issue
  from public.production_material_issues
  where id = v_check.issue_id
  for update;

  if not found then
    raise exception 'material_issue_not_found' using errcode = 'P0002';
  end if;

  if v_check.signed_file_sha256 is distinct from lower(p_signed_sha256) then
    raise exception 'check_hash_mismatch' using errcode = '22023';
  end if;

  if v_check.checked_by is distinct from p_actor_id then
    raise exception 'check_actor_mismatch' using errcode = '22023';
  end if;

  if v_issue.signed_file_sha256 is distinct from lower(p_signed_sha256) then
    raise exception 'issue_hash_mismatch' using errcode = '22023';
  end if;

  if v_issue.location_code is distinct from 'q7'
     or v_issue.is_current is not true
     or v_issue.superseded_by_issue_id is not null then
    raise exception 'blocked_non_current_issue' using errcode = '22023';
  end if;

  if v_check.status <> 'checking' then
    if v_check.status = p_outcome
       and v_check.signed_file_sha256 = lower(p_signed_sha256)
       and v_check.result = p_result then
      return jsonb_build_object(
        'status', 'already_final',
        'check_id', v_check.id,
        'issue_id', v_issue.id,
        'outcome', v_check.status,
        'result', v_check.result,
        'model', v_check.model,
        'model_version', v_check.model_version,
        'checked_at', v_check.checked_at
      );
    end if;
    raise exception 'check_already_final' using errcode = '22023';
  end if;

  if v_issue.status <> 'checking' then
    raise exception 'blocked_issue_status' using errcode = '22023';
  end if;

  if not (p_result ? 'confidence') or jsonb_typeof(p_result -> 'confidence') <> 'number' then
    raise exception 'invalid_result_confidence' using errcode = '22023';
  end if;

  v_confidence := (p_result ->> 'confidence')::numeric;
  if v_confidence < 0 or v_confidence > 1 then
    raise exception 'invalid_result_confidence' using errcode = '22023';
  end if;

  if p_outcome = 'passed' and not (
    p_result @> '{"identity_exact":true,"rows_exact":true,"document_legible":true,"pages_complete":true,"preparer_signed":true,"warehouse_keeper_signed":true,"receiver_signed":true}'::jsonb
    and v_confidence >= 0.8
  ) then
    raise exception 'invalid_pass_result' using errcode = '22023';
  end if;

  v_to_status := case when p_outcome = 'passed' then 'ready_to_confirm' else 'needs_review' end;
  v_check_status := case when p_outcome = 'passed' then 'passed' when p_outcome in ('failed', 'failed_transient', 'error') then 'error' else 'needs_review' end;

  update public.production_material_issue_checks
  set status = p_outcome,
      result = p_result,
      model = nullif(left(coalesce(p_model, ''), 120), ''),
      model_version = nullif(left(coalesce(p_model_version, ''), 120), ''),
      checked_at = now()
  where id = p_check_id;

  update public.production_material_issues
  set status = v_to_status,
      check_status = v_check_status,
      check_metadata = jsonb_build_object(
        'check_id', p_check_id,
        'outcome', p_outcome,
        'confidence', v_confidence,
        'model', nullif(left(coalesce(p_model, ''), 120), ''),
        'result', p_result
      ),
      checked_at = now(),
      updated_at = now()
  where id = v_issue.id;

  insert into public.production_material_issue_events(
    issue_id, event_type, from_status, to_status, actor, metadata
  ) values (
    v_issue.id,
    'material_issue_check_completed',
    'checking',
    v_to_status,
    p_actor_id,
    jsonb_build_object('outcome', p_outcome,
      'check_id', p_check_id,
      'model', nullif(left(coalesce(p_model, ''), 120), ''),
      'confidence', v_confidence
    )
  );

  return jsonb_build_object(
    'status', 'finalized',
    'check_id', p_check_id,
    'issue_id', v_issue.id,
    'issue_status', v_to_status,
    'outcome', p_outcome,
    'model', nullif(left(coalesce(p_model, ''), 120), ''),
    'model_version', nullif(left(coalesce(p_model_version, ''), 120), '')
  );
end;
$$;

revoke all on function public.finalize_q7_material_issue_check(uuid, text, text, jsonb, text, text, uuid) from public;
revoke execute on function public.finalize_q7_material_issue_check(uuid, text, text, jsonb, text, text, uuid) from public;
revoke all on function public.finalize_q7_material_issue_check(uuid, text, text, jsonb, text, text, uuid) from anon;
revoke execute on function public.finalize_q7_material_issue_check(uuid, text, text, jsonb, text, text, uuid) from anon;
revoke all on function public.finalize_q7_material_issue_check(uuid, text, text, jsonb, text, text, uuid) from authenticated;
revoke execute on function public.finalize_q7_material_issue_check(uuid, text, text, jsonb, text, text, uuid) from authenticated;
grant execute on function public.finalize_q7_material_issue_check(uuid, text, text, jsonb, text, text, uuid) to service_role;
