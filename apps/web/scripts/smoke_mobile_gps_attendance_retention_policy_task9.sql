-- Rollback-only runtime smoke for Task9 retention policy.
-- Usage after applying Task9 migration to a disposable/rollback DB:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/smoke_mobile_gps_attendance_retention_policy_task9.sql

begin;

create temp table task9_retention_before as
select count(*)::bigint as event_count
from public.mobile_gps_attendance_events;

-- retention_policy_disabled_by_default
select 1 / case when exists (
  select 1
  from public.mobile_gps_attendance_retention_policy_config
  where id = true
    and coordinate_detail_retention_days is null
    and dry_run_only is true
    and retention_policy_enabled is false
) then 1 else 0 end as retention_policy_disabled_by_default;

-- retention_preview_is_dry_run_only
select set_config('request.jwt.claim.role', 'service_role', true);
select 1 / case when exists (
  select 1
  from public.preview_mobile_gps_attendance_coordinate_retention(25)
  where preview_status = 'redaction_policy_disabled'
    and event_id is null
    and would_redact_device_coordinates is true
    and would_redact_geofence_coordinates is true
    and would_redact_request_ip_hash is true
    and would_redact_request_user_agent is true
    and preserves_decision_work_date_actor_distance_accuracy_audit is true
) then 1 else 0 end as retention_preview_is_dry_run_only;

-- retention_preview_owner_required
DO $$
begin
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
  begin
    perform * from public.preview_mobile_gps_attendance_coordinate_retention(1);
    raise exception 'retention_preview_owner_required did not fail';
  exception when insufficient_privilege then
    raise notice 'retention_preview_owner_required';
  end;
end;
$$;

-- retention_preview_service_role_allowed
select set_config('request.jwt.claim.role', 'service_role', true);
select 1 / case when exists (
  select 1
  from public.preview_mobile_gps_attendance_coordinate_retention(1)
  where preview_status = 'redaction_policy_disabled'
) then 1 else 0 end as retention_preview_service_role_allowed;

-- Role privilege matrix for the dry-run-only RPC.
select 1 / case when not has_function_privilege('anon', 'public.preview_mobile_gps_attendance_coordinate_retention(integer)', 'execute') then 1 else 0 end as retention_preview_anon_denied;
select 1 / case when has_function_privilege('authenticated', 'public.preview_mobile_gps_attendance_coordinate_retention(integer)', 'execute') then 1 else 0 end as retention_preview_authenticated_owner_gated;
select 1 / case when has_function_privilege('service_role', 'public.preview_mobile_gps_attendance_coordinate_retention(integer)', 'execute') then 1 else 0 end as retention_preview_service_role_granted;

-- retention_policy_no_event_mutation
select 1 / case when (select event_count from task9_retention_before) = (select count(*) from public.mobile_gps_attendance_events) then 1 else 0 end as retention_policy_no_event_mutation;

rollback;
