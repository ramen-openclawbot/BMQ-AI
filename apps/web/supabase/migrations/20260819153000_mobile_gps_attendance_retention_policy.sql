-- Task9 mobile GPS attendance coordinate-detail retention policy.
-- Safe default: disabled and preview-only until BMQ owner explicitly approves
-- a positive coordinate_detail_retention_days value and a later execution path.

create table if not exists public.mobile_gps_attendance_retention_policy_config (
  id boolean primary key default true,
  coordinate_detail_retention_days integer,
  dry_run_only boolean not null default true,
  retention_policy_enabled boolean not null default false,
  configured_by uuid,
  configured_at timestamptz not null default now(),
  configuration_note text,
  constraint mobile_gps_attendance_retention_policy_singleton check (id),
  constraint mobile_gps_attendance_retention_policy_days_check check (
    coordinate_detail_retention_days is null or coordinate_detail_retention_days > 0
  ),
  constraint mobile_gps_attendance_retention_policy_disabled_safe_check check (
    retention_policy_enabled = (
      coordinate_detail_retention_days is not null
      and coalesce(coordinate_detail_retention_days, 0) > 0
      and dry_run_only = false
    )
  ),
  constraint mobile_gps_attendance_retention_policy_note_check check (
    configuration_note is null or length(configuration_note) <= 1000
  )
);

insert into public.mobile_gps_attendance_retention_policy_config(
  id,
  coordinate_detail_retention_days,
  dry_run_only,
  retention_policy_enabled,
  configured_by,
  configuration_note
) values (
  true,
  null,
  true,
  false, -- retention_policy_enabled false until owner-approved positive duration and execution path
  null,
  'Task9 disabled preview-only seed: no BMQ retention duration has been approved.'
)
on conflict (id) do update
set
  coordinate_detail_retention_days = case
    when public.mobile_gps_attendance_retention_policy_config.coordinate_detail_retention_days is null
      then excluded.coordinate_detail_retention_days
    else public.mobile_gps_attendance_retention_policy_config.coordinate_detail_retention_days
  end,
  dry_run_only = case
    when public.mobile_gps_attendance_retention_policy_config.coordinate_detail_retention_days is null
      then true
    else public.mobile_gps_attendance_retention_policy_config.dry_run_only
  end,
  retention_policy_enabled = case
    when public.mobile_gps_attendance_retention_policy_config.coordinate_detail_retention_days is null
      then false
    else public.mobile_gps_attendance_retention_policy_config.retention_policy_enabled
  end;

alter table public.mobile_gps_attendance_retention_policy_config enable row level security;
revoke all on table public.mobile_gps_attendance_retention_policy_config from public, anon, authenticated;
grant select on table public.mobile_gps_attendance_retention_policy_config to authenticated, service_role;

drop policy if exists mobile_gps_att_retention_policy_owner_select on public.mobile_gps_attendance_retention_policy_config;
create policy mobile_gps_att_retention_policy_owner_select
on public.mobile_gps_attendance_retention_policy_config for select to authenticated
using (public.has_role((select auth.uid()), 'owner'));

create or replace view public.mobile_gps_attendance_retention_policy_status as
select
  cfg.coordinate_detail_retention_days,
  (cfg.coordinate_detail_retention_days is not null and coalesce(cfg.coordinate_detail_retention_days, 0) > 0) as retention_days_configured,
  cfg.dry_run_only,
  cfg.retention_policy_enabled,
  case
    when cfg.retention_policy_enabled then 'enabled_for_future_execution_after_owner_configuration'
    else 'redaction_policy_disabled'
  end as policy_status,
  true as would_redact_device_coordinates,
  true as would_redact_geofence_coordinates,
  true as would_redact_request_ip_hash,
  true as would_redact_request_user_agent,
  true as preserves_decision_work_date_actor_distance_accuracy_audit,
  cfg.configured_by,
  cfg.configured_at,
  cfg.configuration_note
from public.mobile_gps_attendance_retention_policy_config cfg
where public.has_role((select auth.uid()), 'owner')
   or (select auth.role()) = 'service_role';

revoke all on public.mobile_gps_attendance_retention_policy_status from public, anon;
grant select on public.mobile_gps_attendance_retention_policy_status to authenticated, service_role;

create or replace function public.preview_mobile_gps_attendance_coordinate_retention(
  p_batch_limit integer default 100
)
returns table (
  preview_status text,
  event_id uuid,
  actor_type text,
  kiosk_report_staff_id uuid,
  delivery_staff_id uuid,
  work_date date,
  decision text,
  reason_code text,
  distance_m numeric,
  device_accuracy_m numeric,
  created_at timestamptz,
  would_redact_device_coordinates boolean,
  would_redact_geofence_coordinates boolean,
  would_redact_request_ip_hash boolean,
  would_redact_request_user_agent boolean,
  preserves_decision_work_date_actor_distance_accuracy_audit boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_policy public.mobile_gps_attendance_retention_policy_config%rowtype;
  v_limit integer := least(greatest(coalesce(p_batch_limit, 100), 1), 500);
begin
  if coalesce((select auth.role()), '') <> 'service_role'
    and not public.has_role((select auth.uid()), 'owner') then
    raise exception 'mobile_gps_attendance_retention_owner_required'
      using errcode = '42501';
  end if;

  select * into v_policy
  from public.mobile_gps_attendance_retention_policy_config
  where id = true;

  if not found
    or not v_policy.retention_policy_enabled
    or v_policy.coordinate_detail_retention_days is null
    or coalesce(v_policy.coordinate_detail_retention_days, 0) <= 0 then
    return query
    select
      'redaction_policy_disabled'::text,
      null::uuid,
      null::text,
      null::uuid,
      null::uuid,
      null::date,
      null::text,
      null::text,
      null::numeric,
      null::numeric,
      null::timestamptz,
      true,
      true,
      true,
      true,
      true;
    return;
  end if;

  return query
  select
    'would_redact_coordinate_detail'::text,
    e.id,
    e.actor_type,
    e.kiosk_report_staff_id,
    e.delivery_staff_id,
    e.work_date,
    e.decision,
    e.reason_code,
    e.distance_m,
    e.device_accuracy_m,
    e.created_at,
    true,
    true,
    true,
    true,
    true
  from public.mobile_gps_attendance_events e
  where e.created_at < statement_timestamp() - make_interval(days => v_policy.coordinate_detail_retention_days)
  order by e.created_at asc, e.id asc
  limit v_limit;
end;
$$;

revoke all on function public.preview_mobile_gps_attendance_coordinate_retention(integer) from public, anon;
grant execute on function public.preview_mobile_gps_attendance_coordinate_retention(integer) to authenticated, service_role;

comment on table public.mobile_gps_attendance_retention_policy_config is
  'Disabled-by-default coordinate-detail retention policy. No automatic redaction is enabled until an owner explicitly configures a positive duration and a later execution path is approved.';
comment on view public.mobile_gps_attendance_retention_policy_status is
  'Owner-only retention policy status. Defines coordinate detail fields that would be redacted while preserving attendance decision/date/actor/distance/accuracy/audit evidence.';
comment on function public.preview_mobile_gps_attendance_coordinate_retention(integer) is
  'Dry-run only bounded preview of GPS coordinate-detail retention candidates; does not mutate immutable attendance evidence.';
