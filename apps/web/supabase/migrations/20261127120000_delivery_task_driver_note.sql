-- ============================================================================
-- Migration: Ghi chú của tài xế khi hoàn thành điểm giao (delivery driver note)
--
-- Additive only:
--   (a) public.delivery_tasks.driver_note — optional note of the driver when a
--       delivery point is completed; trimmed, 1..500 characters, null when the
--       driver leaves it empty.
--   (b) public.complete_delivery_task gains a final p_driver_note parameter
--       (default null) and stores it on completion. The existing payroll lock,
--       photo, location/pin, distance and duplicate-completion logic is kept
--       byte-for-byte in behaviour; only the note is added.
--   (c) public.reopen_delivery_task moves the note into reopen_evidence and
--       clears it from the pending row (a reopened point may be reassigned).
--   (d) public.list_delivery_tasks returns driver_note for the management page.
--
-- Release order: apply this migration BEFORE deploying payslip-delivery-complete
-- and payslip-delivery-today, because both read the new column/parameter.
--
-- This migration has NOT been applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (a) Optional driver note
-- ---------------------------------------------------------------------------
alter table public.delivery_tasks
  add column if not exists driver_note text;

alter table public.delivery_tasks
  drop constraint if exists delivery_tasks_driver_note_check;
alter table public.delivery_tasks
  add constraint delivery_tasks_driver_note_check
  check (driver_note is null or (driver_note = btrim(driver_note, E' \t\r\n') and length(driver_note) between 1 and 500));

comment on column public.delivery_tasks.driver_note is
  'Giao hàng — optional driver note entered when completing this delivery point (trimmed, 1..500 characters; null when empty).';

-- ---------------------------------------------------------------------------
-- (b) Completion RPC — one new trailing parameter, everything else unchanged.
--     The old 9-argument signature is replaced, not overloaded.
-- ---------------------------------------------------------------------------
drop function if exists public.complete_delivery_task(
  uuid, text, uuid, text, text, numeric, numeric, numeric, timestamptz
);

create or replace function public.complete_delivery_task(
  p_task_id uuid,
  p_employee_code text,
  p_session_id uuid,
  p_device_hash text,
  p_photo_path text,
  p_latitude numeric,
  p_longitude numeric,
  p_accuracy_m numeric,
  p_device_captured_at timestamptz,
  p_driver_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_code text := btrim(coalesce(p_employee_code, ''));
  v_device_hash text := nullif(lower(btrim(coalesce(p_device_hash, ''))), '');
  v_photo_path text := nullif(btrim(coalesce(p_photo_path, '')), '');
  v_driver_note text := nullif(btrim(replace(coalesce(p_driver_note, ''), E'\r\n', E'\n'), E' \t\r\n'), '');
  v_now timestamptz := statement_timestamp();
  v_today date;
  v_hour integer;
  v_task public.delivery_tasks%rowtype;
  v_destination public.mini_crm_customers%rowtype;
  v_location_attached boolean := false;
  v_distance numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'delivery_complete_service_role_required' using errcode = '42501';
  end if;

  if p_task_id is null or v_employee_code = '' then
    raise exception 'delivery_task_and_employee_required' using errcode = '22023';
  end if;

  if length(v_driver_note) > 500 then
    raise exception 'delivery_note_too_long' using errcode = '22023';
  end if;

  if v_photo_path is null then
    raise exception 'delivery_photo_required' using errcode = '22023';
  end if;

  if p_latitude is null or p_longitude is null
     or p_latitude < -90 or p_latitude > 90
     or p_longitude < -180 or p_longitude > 180 then
    raise exception 'delivery_location_invalid' using errcode = '22023';
  end if;

  if p_accuracy_m is null or p_accuracy_m < 0 then
    raise exception 'delivery_accuracy_invalid' using errcode = '22023';
  end if;

  select * into v_task
  from public.delivery_tasks
  where id = p_task_id
  for update;

  if v_task.id is null then
    raise exception 'delivery_task_not_found' using errcode = 'P0002';
  end if;

  if v_task.employee_code is null or btrim(v_task.employee_code) <> v_employee_code then
    raise exception 'delivery_task_not_assigned' using errcode = '42501';
  end if;

  -- A locked month is immutable, including a late completion of its task.
  if exists (
    select 1
    from public.payroll_bn_periods p
    where p.status = 'locked'
      and v_task.delivery_date between p.date_from and p.date_to
  ) then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  v_today := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_hour := extract(hour from (v_now at time zone 'Asia/Ho_Chi_Minh'))::integer;

  -- A task explicitly reopened by the owner may be completed again even when
  -- its delivery date is older than the normal today / yesterday-before-06:00
  -- window. The reopen reason/actor/evidence stay on the task for audit.
  if v_task.reopened_at is null
     and v_task.delivery_date <> v_today
     and not (v_task.delivery_date = v_today - 1 and v_hour < 6) then
    raise exception 'delivery_task_date_closed' using errcode = '22023';
  end if;

  if v_task.status <> 'pending' then
    raise exception 'delivery_task_not_pending' using errcode = 'P0001';
  end if;

  select * into v_destination
  from public.mini_crm_customers
  where id = v_task.destination_customer_id;

  if v_destination.id is null then
    raise exception 'delivery_destination_not_found' using errcode = 'P0002';
  end if;

  if v_destination.location_lat is null or v_destination.location_lng is null then
    update public.mini_crm_customers
    set location_lat = p_latitude,
        location_lng = p_longitude,
        location_source = 'delivery_gps'
    where id = v_destination.id
      and (location_lat is null or location_lng is null);

    if found then
      v_location_attached := true;
      v_distance := null;
    else
      -- A concurrent first completion attached the coordinates between the
      -- read and this update: keep the existing point and only store distance.
      select * into v_destination
      from public.mini_crm_customers
      where id = v_task.destination_customer_id;
      v_location_attached := false;
      v_distance := round(
        public.payroll_bn_haversine_meters(
          p_latitude,
          p_longitude,
          v_destination.location_lat,
          v_destination.location_lng
        ),
        2
      );
    end if;
  else
    v_location_attached := false;
    v_distance := round(
      public.payroll_bn_haversine_meters(
        p_latitude,
        p_longitude,
        v_destination.location_lat,
        v_destination.location_lng
      ),
      2
    );
  end if;

  update public.delivery_tasks
  set status = 'completed',
      completed_at = v_now,
      completed_session_id = p_session_id,
      device_captured_at = p_device_captured_at,
      latitude = p_latitude,
      longitude = p_longitude,
      accuracy_m = p_accuracy_m,
      distance_m = v_distance,
      location_attached = v_location_attached,
      photo_path = v_photo_path,
      device_hash = v_device_hash,
      driver_note = v_driver_note
  where id = v_task.id
    and status = 'pending'
  returning * into v_task;

  if v_task.id is null then
    raise exception 'delivery_task_not_pending' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'task_id', v_task.id,
    'status', v_task.status,
    'completed_at', v_task.completed_at,
    'device_captured_at', v_task.device_captured_at,
    'latitude', v_task.latitude,
    'longitude', v_task.longitude,
    'accuracy_m', v_task.accuracy_m,
    'distance_m', v_task.distance_m,
    'location_attached', v_task.location_attached,
    'photo_path', v_task.photo_path,
    'driver_note', v_task.driver_note
  );
end;
$$;

revoke all on function public.complete_delivery_task(
  uuid, text, uuid, text, text, numeric, numeric, numeric, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.complete_delivery_task(
  uuid, text, uuid, text, text, numeric, numeric, numeric, timestamptz, text
) to service_role;

comment on function public.complete_delivery_task(
  uuid, text, uuid, text, text, numeric, numeric, numeric, timestamptz, text
) is
  'Giao hàng — service-role completion: verifies driver/date/pending, stores server_completed_at + GPS + accuracy and the optional trimmed driver_note (max 500 chars), attaches the destination coordinates on the first-ever completion and stores distance_m afterwards. A duplicate call raises delivery_task_not_pending and never overwrites the saved note with null. No geofence or time flag.';

-- ---------------------------------------------------------------------------
-- (c) Reopen must keep the driver note in the audit evidence, not on the
--     pending task: a reopened point may be reassigned, and completing it
--     again must not silently lose the note that belonged to the previous
--     completion. Everything else about reopen is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.reopen_delivery_task(
  p_task_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row public.delivery_tasks%rowtype;
  v_existing public.delivery_tasks%rowtype;
  v_evidence jsonb;
begin
  if not public.has_role(v_uid, 'owner') then
    raise exception 'delivery_reopen_owner_only' using errcode = '42501';
  end if;

  if v_reason = '' then
    raise exception 'delivery_reopen_reason_required' using errcode = '22023';
  end if;

  select * into v_existing
  from public.delivery_tasks
  where id = p_task_id
    and status = 'completed'
  for update;

  if v_existing.id is null then
    raise exception 'delivery_task_not_completed' using errcode = 'P0002';
  end if;

  -- A locked month is immutable: reopening would change its delivery units.
  if exists (
    select 1
    from public.payroll_bn_periods p
    where p.status = 'locked'
      and v_existing.delivery_date between p.date_from and p.date_to
  ) then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  -- If this completion attached the destination pin, undo it when the pin is
  -- still exactly the evidence coordinates. A later CRM pin / different pin is
  -- kept untouched.
  if v_existing.location_attached
     and v_existing.latitude is not null
     and v_existing.longitude is not null then
    update public.mini_crm_customers
    set location_lat = null,
        location_lng = null,
        location_source = null
    where id = v_existing.destination_customer_id
      and location_source = 'delivery_gps'
      and location_lat = v_existing.latitude
      and location_lng = v_existing.longitude;
  end if;

  v_evidence := jsonb_build_object(
    'completed_at', v_existing.completed_at,
    'completed_session_id', v_existing.completed_session_id,
    'device_captured_at', v_existing.device_captured_at,
    'latitude', v_existing.latitude,
    'longitude', v_existing.longitude,
    'accuracy_m', v_existing.accuracy_m,
    'distance_m', v_existing.distance_m,
    'location_attached', v_existing.location_attached,
    'photo_path', v_existing.photo_path,
    'device_hash', v_existing.device_hash,
    'driver_note', v_existing.driver_note
  );

  update public.delivery_tasks
  set status = 'pending',
      completed_at = null,
      completed_session_id = null,
      device_captured_at = null,
      latitude = null,
      longitude = null,
      accuracy_m = null,
      distance_m = null,
      location_attached = false,
      photo_path = null,
      device_hash = null,
      driver_note = null,
      changed_after_completion = false,
      reopened_at = now(),
      reopened_by = v_uid,
      reopen_reason = v_reason,
      reopen_evidence = v_evidence
  where id = p_task_id
    and status = 'completed'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'delivery_task_not_completed' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'task', to_jsonb(v_row),
    'reason', v_reason,
    'reopened_by', v_uid,
    'previous_evidence', v_evidence
  );
end;
$$;

revoke all on function public.reopen_delivery_task(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reopen_delivery_task(uuid, text) to authenticated, service_role;

comment on function public.reopen_delivery_task(uuid, text) is
  'Giao hàng — owner-only reopen of a completed task in an open month: back to pending, completion evidence (including the driver note) kept in reopen_evidence, reason/actor stored, and the task may be completed again outside the normal date window.';

-- ---------------------------------------------------------------------------
-- (d) Management list — same fields plus driver_note
-- ---------------------------------------------------------------------------
create or replace function public.list_delivery_tasks(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_date date := coalesce(p_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_tasks jsonb;
begin
  if not public.delivery_can_view(v_uid) then
    raise exception 'insufficient_privilege: payroll view required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'delivery_date', t.delivery_date,
      'destination_customer_id', t.destination_customer_id,
      'destination_name', t.destination_name,
      'address', t.address,
      'employee_code', t.employee_code,
      'driver_name', driver.employee_name,
      'units', t.units,
      'sort_order', t.sort_order,
      'status', t.status,
      'order_ids', t.order_ids,
      'quantity', t.quantity,
      'items', t.items,
      'dealer_note', t.dealer_note,
      'driver_note', t.driver_note,
      'generated_at', t.generated_at,
      'changed_after_completion', t.changed_after_completion,
      'completed_at', t.completed_at,
      'device_captured_at', t.device_captured_at,
      'latitude', t.latitude,
      'longitude', t.longitude,
      'accuracy_m', t.accuracy_m,
      'distance_m', t.distance_m,
      'location_attached', t.location_attached,
      'photo_path', t.photo_path,
      'reopened_at', t.reopened_at,
      'reopen_reason', t.reopen_reason,
      'reopen_evidence', t.reopen_evidence
    )
    order by t.sort_order, t.destination_name, t.id
  ), '[]'::jsonb)
  into v_tasks
  from public.delivery_tasks t
  left join lateral (
    select pe.employee_name
    from public.payroll_bn_period_employees pe
    join public.payroll_bn_periods p on p.id = pe.period_id
    where pe.employee_code = t.employee_code
    order by p.date_from desc, pe.created_at desc
    limit 1
  ) driver on true
  where t.delivery_date = v_date;

  return v_tasks;
end;
$$;

revoke all on function public.list_delivery_tasks(date) from public, anon, authenticated;
grant execute on function public.list_delivery_tasks(date) to authenticated, service_role;

comment on function public.list_delivery_tasks(date) is
  'Giao hàng — tasks of one date with driver name, photo path, driver note and whether the destination already had coordinates. Owner or payroll.view.';
