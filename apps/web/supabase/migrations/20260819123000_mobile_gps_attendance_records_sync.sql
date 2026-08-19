-- Task6: transactionally sync accepted mobile GPS events into attendance_records.
-- Prospective/rerunnable only: no historical backfill.

alter table public.attendance_records
  add column if not exists department text,
  add column if not exists source_type text,
  add column if not exists source_event_id uuid references public.mobile_gps_attendance_events(id) on delete restrict,
  add column if not exists source_actor_type text,
  add column if not exists source_distance_m numeric(10,2),
  add column if not exists source_accuracy_m numeric(8,2);

alter table public.attendance_records
  drop constraint if exists attendance_records_source_type_check,
  add constraint attendance_records_source_type_check
    check (source_type is null or source_type in ('qr', 'manual', 'mobile_gps')),
  drop constraint if exists attendance_records_source_actor_type_check,
  add constraint attendance_records_source_actor_type_check
    check (source_actor_type is null or source_actor_type in ('report_staff', 'delivery_staff')),
  drop constraint if exists attendance_records_source_distance_check,
  add constraint attendance_records_source_distance_check
    check (source_distance_m is null or source_distance_m >= 0),
  drop constraint if exists attendance_records_source_accuracy_check,
  add constraint attendance_records_source_accuracy_check
    check (source_accuracy_m is null or source_accuracy_m >= 0);

create unique index if not exists attendance_records_source_event_unique
  on public.attendance_records(source_event_id)
  where source_event_id is not null;

create table if not exists public.attendance_records_trusted_gps_context (
  context_token uuid primary key,
  txid bigint not null,
  backend_pid integer not null,
  purpose text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint attendance_records_trusted_gps_context_purpose_check
    check (purpose = 'mobile_gps_attendance_sync')
);

revoke all on table public.attendance_records_trusted_gps_context from public, anon, authenticated, service_role;

create table if not exists public.mobile_gps_attendance_sync_results (
  id uuid primary key default gen_random_uuid(),
  gps_event_id uuid not null references public.mobile_gps_attendance_events(id) on delete restrict,
  attendance_record_id uuid references public.attendance_records(id) on delete set null,
  employee_code text not null,
  work_date date not null,
  sync_status text not null,
  reason_code text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(gps_event_id),
  constraint mobile_gps_att_sync_status_check
    check (sync_status in ('synced', 'already_synced', 'skipped_locked', 'conflict')),
  constraint mobile_gps_att_sync_reason_check
    check (reason_code ~ '^[a-z0-9_]{2,80}$')
);

create index if not exists mobile_gps_att_sync_results_record_idx
  on public.mobile_gps_attendance_sync_results(attendance_record_id, created_at desc);
create index if not exists mobile_gps_att_sync_results_employee_day_idx
  on public.mobile_gps_attendance_sync_results(employee_code, work_date, created_at desc);

alter table public.mobile_gps_attendance_sync_results enable row level security;

revoke all on table public.mobile_gps_attendance_sync_results from public, anon, authenticated;
grant select on table public.mobile_gps_attendance_sync_results to authenticated;

drop policy if exists mobile_gps_att_sync_results_select_attendance_payroll on public.mobile_gps_attendance_sync_results;
create policy mobile_gps_att_sync_results_select_attendance_payroll
on public.mobile_gps_attendance_sync_results for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'view')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
  or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
);

create or replace function public.sync_mobile_gps_event_to_attendance_record(p_gps_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.mobile_gps_attendance_events%rowtype;
  v_existing_sync public.mobile_gps_attendance_sync_results%rowtype;
  v_record public.attendance_records%rowtype;
  v_employee_code text;
  v_employee_name text;
  v_department text;
  v_trusted_gps_token uuid;
begin
  select * into v_existing_sync
  from public.mobile_gps_attendance_sync_results
  where gps_event_id = p_gps_event_id;

  if v_existing_sync.id is not null then
    return jsonb_build_object(
      'status', case when v_existing_sync.sync_status = 'synced' then 'already_synced' else v_existing_sync.sync_status end,
      'attendance_record_id', v_existing_sync.attendance_record_id,
      'gps_event_id', p_gps_event_id
    );
  end if;

  select * into v_event
  from public.mobile_gps_attendance_events
  where id = p_gps_event_id;

  if v_event.id is null then
    raise exception 'mobile_gps_attendance_event_not_found';
  end if;

  if v_event.decision <> 'accepted' then
    return jsonb_build_object('status', 'skipped_rejected', 'gps_event_id', p_gps_event_id);
  end if;

  if v_event.actor_type = 'report_staff' then
    v_employee_code := 'KIOSK:' || v_event.kiosk_report_staff_id::text;
    v_department := 'Điểm bán';
    select full_name into v_employee_name
    from public.kiosk_report_staff
    where id = v_event.kiosk_report_staff_id;
  elsif v_event.actor_type = 'delivery_staff' then
    v_employee_code := 'DELIVERY:' || v_event.delivery_staff_id::text;
    v_department := 'Giao hàng';
    select full_name into v_employee_name
    from public.delivery_staff
    where id = v_event.delivery_staff_id;
  else
    raise exception 'mobile_gps_attendance_actor_type_unsupported';
  end if;

  v_employee_name := coalesce(nullif(btrim(v_employee_name), ''), v_employee_code);

  v_trusted_gps_token := gen_random_uuid();
  delete from public.attendance_records_trusted_gps_context
  where created_at < clock_timestamp() - interval '10 minutes';
  insert into public.attendance_records_trusted_gps_context(context_token, txid, backend_pid, purpose)
  values (v_trusted_gps_token, txid_current(), pg_backend_pid(), 'mobile_gps_attendance_sync');
  perform set_config('attendance_records.trusted_gps_token', v_trusted_gps_token::text, true);

  insert into public.attendance_records (
    employee_code,
    employee_name,
    department,
    work_date,
    actual_check_in,
    actual_check_out,
    status,
    minutes_late,
    minutes_early_leave,
    missing_check_in,
    missing_check_out,
    source_type,
    source_event_id,
    source_actor_type,
    source_distance_m,
    source_accuracy_m
  ) values (
    v_employee_code,
    v_employee_name,
    v_department,
    v_event.work_date,
    v_event.created_at,
    null,
    'missing_check_out'::public.attendance_status_type,
    0,
    0,
    false,
    true,
    'mobile_gps',
    v_event.id,
    v_event.actor_type,
    round(v_event.distance_m, 0),
    round(v_event.device_accuracy_m, 0)
  )
  on conflict (employee_code, work_date) do nothing;

  select * into v_record
  from public.attendance_records
  where employee_code = v_employee_code
    and work_date = v_event.work_date
  for update;

  if v_record.id is null then
    raise exception 'attendance_record_sync_missing_after_insert';
  end if;

  if v_record.locked_by_hr is true then
    insert into public.mobile_gps_attendance_sync_results(
      gps_event_id, attendance_record_id, employee_code, work_date, sync_status, reason_code, details
    ) values (
      v_event.id, v_record.id, v_employee_code, v_event.work_date, 'skipped_locked', 'locked_by_hr',
      jsonb_build_object('source_type', v_record.source_type)
    )
    on conflict (gps_event_id) do nothing;

    delete from public.attendance_records_trusted_gps_context where context_token = v_trusted_gps_token;
    perform set_config('attendance_records.trusted_gps_token', '', true);
    return jsonb_build_object('status', 'skipped_locked', 'attendance_record_id', v_record.id, 'gps_event_id', v_event.id);
  end if;

  if v_record.source_event_id is not null and v_record.source_event_id is distinct from v_event.id then
    insert into public.mobile_gps_attendance_sync_results(
      gps_event_id, attendance_record_id, employee_code, work_date, sync_status, reason_code, details
    ) values (
      v_event.id, v_record.id, v_employee_code, v_event.work_date, 'conflict', 'attendance_record_has_other_source_event',
      jsonb_build_object('existing_source_event_id', v_record.source_event_id)
    )
    on conflict (gps_event_id) do nothing;

    delete from public.attendance_records_trusted_gps_context where context_token = v_trusted_gps_token;
    perform set_config('attendance_records.trusted_gps_token', '', true);
    return jsonb_build_object('status', 'conflict', 'attendance_record_id', v_record.id, 'gps_event_id', v_event.id);
  end if;

  update public.attendance_records
  set employee_name = v_employee_name,
      department = v_department,
      actual_check_in = v_event.created_at,
      source_type = 'mobile_gps',
      source_event_id = v_event.id,
      source_actor_type = v_event.actor_type,
      source_distance_m = round(v_event.distance_m, 0),
      source_accuracy_m = round(v_event.device_accuracy_m, 0)
  where id = v_record.id
  returning * into v_record;

  insert into public.mobile_gps_attendance_sync_results(
    gps_event_id, attendance_record_id, employee_code, work_date, sync_status, reason_code, details
  ) values (
    v_event.id, v_record.id, v_employee_code, v_event.work_date, 'synced', 'attendance_record_synced',
    jsonb_build_object('source_type', 'mobile_gps', 'actor_type', v_event.actor_type)
  )
  on conflict (gps_event_id) do nothing;

  delete from public.attendance_records_trusted_gps_context where context_token = v_trusted_gps_token;
  perform set_config('attendance_records.trusted_gps_token', '', true);
  return jsonb_build_object('status', 'synced', 'attendance_record_id', v_record.id, 'gps_event_id', v_event.id);
exception when others then
  if v_trusted_gps_token is not null then
    delete from public.attendance_records_trusted_gps_context where context_token = v_trusted_gps_token;
  end if;
  perform set_config('attendance_records.trusted_gps_token', '', true);
  raise;
end;
$$;

revoke all on function public.sync_mobile_gps_event_to_attendance_record(uuid) from public, anon, authenticated;
grant execute on function public.sync_mobile_gps_event_to_attendance_record(uuid) to service_role;

comment on function public.sync_mobile_gps_event_to_attendance_record(uuid) is
  'Task6 accepted GPS event -> attendance_records sync. Locks existing rows, never overwrites locked HR rows, preserves immutable event evidence, and writes durable sync result rows for synced/locked/conflict outcomes.';
comment on table public.mobile_gps_attendance_sync_results is
  'Durable Task6 sync audit for accepted mobile GPS attendance evidence into attendance_records.';
comment on column public.attendance_records.source_event_id is
  'Immutable mobile_gps_attendance_events provenance link when source_type = mobile_gps.';
