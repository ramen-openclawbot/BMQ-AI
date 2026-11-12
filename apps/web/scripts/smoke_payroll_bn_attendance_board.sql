-- Rollback-only smoke for 20261112150000_payroll_bn_attendance_board.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_bn_attendance_board.sql
--
-- Pure SQL: one transaction wraps one DO block that seeds throwaway TASK
-- site/gates/period/week/types/entries/requests/override/mission/events rows,
-- then asserts:
--   * every board status: on_time, late, absent_overdue, not_yet,
--     no_shift_time, off (leave + scheduled off + closed), override
--   * minutes_late, checked_out, rejected_count, totals and row order
--   * shift precedence schedule > manual > mission
--   * board on_time/late agrees with get_payroll_bn_shift_attendance_flags
--   * ranking worked/on-time/late/absent/no-shift counts, totals,
--     best/current streak, tie ranks and ordering
--   * p_to clamp, 92-day limit, p_from > p_to, future date and non-manager
--   * the two RPCs leave events/devices/entries/requests/overrides unchanged
-- A final rollback leaves no fixture behind.

begin;

do $$
declare
  v_now timestamp;
  v_local_now time;
  v_today date;
  v_this_week date;
  v_prev_week date;
  v_d1 date;
  v_d2 date;
  v_d3 date;
  v_d4 date;
  v_d5 date;
  v_d6 date;
  v_d7 date;
  v_site_id uuid;
  v_period_id uuid;
  v_period_from date;
  v_campaign_id uuid;
  v_manager uuid;
  v_future_start time;
  v_board jsonb;
  v_ranking jsonb;
  v_flags jsonb;
  v_row jsonb;
  v_totals jsonb;
  v_helper jsonb;
  v_error text;
  v_flag_late boolean;
  v_flag_minutes integer;
  v_offset integer;
  v_day date;
  v_events_before bigint;
  v_events_after bigint;
  v_devices_before bigint;
  v_devices_after bigint;
  v_entries_before bigint;
  v_entries_after bigint;
  v_requests_before bigint;
  v_requests_after bigint;
  v_overrides_before bigint;
  v_overrides_after bigint;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  v_now := (now() at time zone 'Asia/Ho_Chi_Minh');
  v_local_now := (v_now)::time;
  v_today := (v_now)::date;
  v_this_week := public.payroll_bn_shift_week_start(v_today);
  v_prev_week := v_this_week - 7;
  v_d1 := v_prev_week;
  v_d2 := v_prev_week + 1;
  v_d3 := v_prev_week + 2;
  v_d4 := v_prev_week + 3;
  v_d5 := v_prev_week + 4;
  v_d6 := v_prev_week + 5;
  v_d7 := v_prev_week + 6;

  -- A future start that is always later than "now" on the same date.
  if v_local_now >= time '23:29' then
    v_future_start := time '23:59:59';
  else
    v_future_start := v_local_now + interval '30 minutes';
  end if;

  -- Manager identity for the fixtures and the authenticated calls.
  select ur.user_id into v_manager
  from public.user_roles ur
  where ur.role = 'owner'
  limit 1;

  if v_manager is null then
    select ump.user_id into v_manager
    from public.user_module_permissions ump
    where ump.module_key = 'payroll'
      and ump.can_edit
    limit 1;
  end if;

  if v_manager is null then
    raise exception 'task_attendance_board_smoke_no_manager';
  end if;

  -- -----------------------------------------------------------------------
  -- Throwaway fixtures (rolled back below)
  -- -----------------------------------------------------------------------
  insert into public.attendance_geofence_locations(
    code, name, location_type, kiosk_location_id, latitude, longitude,
    accepted_radius_m, active
  ) values (
    'task_payroll_bn_attendance_board_site',
    'Task Payroll BN Attendance Board Site',
    'kitchen',
    null,
    10.750000,
    106.650000,
    50,
    true
  )
  on conflict (code) do update
  set latitude = excluded.latitude,
      longitude = excluded.longitude,
      accepted_radius_m = excluded.accepted_radius_m,
      active = true
  returning id into v_site_id;

  insert into public.payroll_bn_attendance_gates(
    employee_code, enabled, geofence_location_id
  )
  select employee_code, true, v_site_id
  from (values
    ('TASK_BOARD_E1'),
    ('TASK_BOARD_E2'),
    ('TASK_BOARD_E3'),
    ('TASK_BOARD_E4'),
    ('TASK_BOARD_E5'),
    ('TASK_BOARD_E6'),
    ('TASK_BOARD_E7'),
    ('TASK_BOARD_E8'),
    ('TASK_BOARD_E9'),
    ('TASK_BOARD_E10'),
    ('TASK_BOARD_E11'),
    ('TASK_BOARD_E12'),
    ('TASK_BOARD_E13')
  ) as employees(employee_code)
  on conflict (employee_code) do update
  set enabled = true,
      geofence_location_id = excluded.geofence_location_id;

  -- Isolate board totals from real gates; rollback restores every row.
  update public.payroll_bn_attendance_gates
  set enabled = false
  where employee_code not like 'TASK\_BOARD\_%' escape '\';

  -- The latest payroll period catalogue supplies names and groups.
  select coalesce(max(p.date_from), v_today) + 1
  into v_period_from
  from public.payroll_bn_periods p;

  insert into public.payroll_bn_periods(
    period_code, period_name, date_from, date_to
  ) values (
    'TASK_ATTENDANCE_BOARD_PERIOD',
    'Task Attendance Board Period',
    v_period_from,
    v_period_from + 30
  )
  on conflict (period_code) do update
  set date_from = excluded.date_from,
      date_to = excluded.date_to
  returning id into v_period_id;

  insert into public.payroll_bn_period_employees(
    period_id, employee_code, employee_name, group_name, employment_type
  )
  select
    v_period_id,
    e.code,
    'TASK Board ' || e.code,
    'Bếp bánh',
    'official'
  from (values
    ('TASK_BOARD_E1'), ('TASK_BOARD_E2'), ('TASK_BOARD_E3'),
    ('TASK_BOARD_E4'), ('TASK_BOARD_E5'), ('TASK_BOARD_E6'),
    ('TASK_BOARD_E7'), ('TASK_BOARD_E8'), ('TASK_BOARD_E9'),
    ('TASK_BOARD_E10'), ('TASK_BOARD_E11'), ('TASK_BOARD_E12'),
    ('TASK_BOARD_E13')
  ) as e(code)
  on conflict (period_id, employee_code) do update
  set employee_name = excluded.employee_name,
      group_name = excluded.group_name;

  insert into public.payroll_bn_shift_settings(id, eligible_groups, late_grace_minutes)
  values (true, array['Bếp bánh']::text[], 5)
  on conflict (id) do update
  set eligible_groups = excluded.eligible_groups,
      late_grace_minutes = excluded.late_grace_minutes;

  insert into public.payroll_bn_shift_types(
    code, label, start_time, end_time, sort, active
  ) values
    ('TASK_BOARD_SHIFT_0000', 'TASK Board 00:00', time '00:00', time '08:00', 101, true),
    ('TASK_BOARD_SHIFT_0800', 'TASK Board 08:00', time '08:00', time '17:00', 102, true),
    ('TASK_BOARD_SHIFT_0900', 'TASK Board 09:00', time '09:00', time '18:00', 103, true),
    ('TASK_BOARD_SHIFT_FUTURE', 'TASK Board Future', v_future_start, null, 104, true)
  on conflict (code) do update
  set start_time = excluded.start_time,
      end_time = excluded.end_time,
      active = true;

  insert into public.payroll_bn_shift_weeks(
    week_start, status, closed_dates, published_at
  ) values
    (v_prev_week, 'published', array[v_d6]::date[], now()),
    (v_this_week, 'published', '{}'::date[], now())
  on conflict (week_start) do update
  set status = 'published',
      closed_dates = excluded.closed_dates,
      published_at = excluded.published_at;

  insert into public.payroll_bn_shift_entries(
    week_start, employee_code, work_date, shift_code, state, source
  ) values
    -- Ranking week (previous week)
    (v_prev_week, 'TASK_BOARD_E1', v_d1, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E1', v_d2, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E1', v_d3, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E1', v_d4, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E1', v_d5, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E2', v_d1, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E2', v_d2, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E2', v_d3, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E2', v_d4, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E2', v_d5, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E2', v_d6, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E3', v_d1, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E3', v_d2, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E3', v_d3, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E3', v_d4, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E3', v_d5, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E4', v_d2, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E4', v_d3, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E5', v_d1, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E5', v_d2, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E5', v_d3, null, 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E5', v_d4, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E5', v_d5, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_prev_week, 'TASK_BOARD_E7', v_d1, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    -- Today
    (v_this_week, 'TASK_BOARD_E1', v_today, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_this_week, 'TASK_BOARD_E2', v_today, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_this_week, 'TASK_BOARD_E3', v_today, 'TASK_BOARD_SHIFT_FUTURE', 'registered', 'manager'),
    (v_this_week, 'TASK_BOARD_E4', v_today, 'TASK_BOARD_SHIFT_0000', 'registered', 'manager'),
    (v_this_week, 'TASK_BOARD_E5', v_today, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_this_week, 'TASK_BOARD_E6', v_today, null, 'registered', 'manager'),
    (v_this_week, 'TASK_BOARD_E7', v_today, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_this_week, 'TASK_BOARD_E9', v_today, 'TASK_BOARD_SHIFT_0800', 'registered', 'manager'),
    (v_this_week, 'TASK_BOARD_E12', v_today, 'TASK_BOARD_SHIFT_0900', 'registered', 'manager')
  on conflict (employee_code, work_date) do update
  set week_start = excluded.week_start,
      shift_code = excluded.shift_code,
      state = excluded.state,
      source = excluded.source;

  -- Manual shift starts (E10/E13 also have a mission offer: manual must win).
  insert into public.payroll_bn_employee_shifts(employee_code, shift_start)
  values
    ('TASK_BOARD_E10', time '07:30'),
    ('TASK_BOARD_E12', time '07:00'),
    ('TASK_BOARD_E13', time '07:00')
  on conflict (employee_code) do update
  set shift_start = excluded.shift_start;

  -- Approved leave: E5 yesterday (ranking) and today (board).
  insert into public.payroll_bn_shift_requests(
    week_start, work_date, employee_code, kind, from_shift_code,
    to_shift_code, reason, state, decided_at
  ) values
    (v_prev_week, v_d2, 'TASK_BOARD_E5', 'leave', 'TASK_BOARD_SHIFT_0800', null,
     'TASK board approved leave yesterday', 'approved', now()),
    (v_this_week, v_today, 'TASK_BOARD_E5', 'leave', 'TASK_BOARD_SHIFT_0800', null,
     'TASK board approved leave today', 'approved', now());

  -- Manager approval of an incomplete day (no check-in).
  insert into public.payroll_bn_attendance_day_overrides(
    employee_code, work_date, reason, approved_by
  ) values (
    'TASK_BOARD_E7', v_today, 'TASK board approved work day', v_manager
  )
  on conflict (employee_code, work_date) do update
  set reason = excluded.reason;

  -- Active mission campaign: E11/E13/E10 have offers; E11 has no manual start.
  insert into public.payroll_mission_campaigns(
    code, title, starts_on, ends_on, eligible_groups, items, status
  ) values (
    'TASK_ATTENDANCE_BOARD_MISSION',
    'Task Attendance Board Mission',
    v_today,
    v_today + 1,
    '{}'::text[],
    '[{"key":"punctual","label":"Đúng giờ","kind":"punctual","params":{"cutoff":"00:10","grace_minutes":0}}]'::jsonb,
    'active'
  )
  on conflict (code) do update
  set starts_on = excluded.starts_on,
      ends_on = excluded.ends_on,
      items = excluded.items,
      status = 'active'
  returning id into v_campaign_id;

  insert into public.payroll_mission_offers(campaign_id, employee_code, status)
  values
    (v_campaign_id, 'TASK_BOARD_E10', 'pending'),
    (v_campaign_id, 'TASK_BOARD_E11', 'pending'),
    (v_campaign_id, 'TASK_BOARD_E13', 'pending')
  on conflict (campaign_id, employee_code) do update
  set status = excluded.status,
      responded_at = null;

  -- Previous-week attendance (ranking + flags agreement).
  insert into public.payroll_bn_attendance_events(
    employee_code, event_kind, work_date, server_received_at, decision, reject_reason
  ) values
    ('TASK_BOARD_E1', 'in', v_d1, (v_d1 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E1', 'out', v_d1, (v_d1 + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E1', 'in', v_d2, (v_d2 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E1', 'in', v_d3, (v_d3 + time '08:10') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E1', 'in', v_d5, (v_d5 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E2', 'in', v_d1, (v_d1 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E2', 'in', v_d2, (v_d2 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E2', 'in', v_d3, (v_d3 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E2', 'in', v_d4, (v_d4 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E2', 'in', v_d5, (v_d5 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E3', 'in', v_d1, (v_d1 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E3', 'in', v_d2, (v_d2 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E3', 'in', v_d3, (v_d3 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E3', 'in', v_d4, (v_d4 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E3', 'in', v_d5, (v_d5 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E4', 'in', v_d2, (v_d2 + time '08:20') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E4', 'in', v_d3, (v_d3 + time '08:15') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E5', 'in', v_d1, (v_d1 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E5', 'in', v_d4, (v_d4 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E5', 'in', v_d5, (v_d5 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E6', 'in', v_d1, (v_d1 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null)
  ;

  -- Today's attendance, including one rejected attempt for E1.
  insert into public.payroll_bn_attendance_events(
    employee_code, event_kind, work_date, server_received_at, decision, reject_reason
  ) values
    ('TASK_BOARD_E1', 'out', v_today, (v_today + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E1', 'in', v_today, (v_today + time '08:02') at time zone 'Asia/Ho_Chi_Minh', 'rejected', 'outside_geofence'),
    ('TASK_BOARD_E1', 'in', v_today, (v_today + time '08:03') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E2', 'in', v_today, (v_today + time '08:15') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E9', 'in', v_today, (v_today + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E10', 'in', v_today, (v_today + time '07:40') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E11', 'in', v_today, (v_today + time '00:25') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E12', 'in', v_today, (v_today + time '09:05') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null),
    ('TASK_BOARD_E13', 'in', v_today, (v_today + time '07:10') at time zone 'Asia/Ho_Chi_Minh', 'accepted', null)
  ;

  -- Manager identity for the authenticated calls.
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_manager)::text,
    true
  );

  -- Row counts before the first read-only RPC call.
  select count(*) into v_events_before from public.payroll_bn_attendance_events;
  select count(*) into v_devices_before from public.payroll_bn_attendance_devices;
  select count(*) into v_entries_before from public.payroll_bn_shift_entries;
  select count(*) into v_requests_before from public.payroll_bn_shift_requests;
  select count(*) into v_overrides_before from public.payroll_bn_attendance_day_overrides;

  -- -----------------------------------------------------------------------
  -- 1. Shift-start precedence: schedule > manual > mission.
  -- -----------------------------------------------------------------------
  v_helper := public.payroll_bn_shift_start_for('TASK_BOARD_E12', v_today);
  if v_helper->>'start_time' is distinct from '09:00'
     or v_helper->>'source' is distinct from 'schedule' then
    raise exception 'precedence_schedule_lost: %', v_helper;
  end if;

  v_helper := public.payroll_bn_shift_start_for('TASK_BOARD_E10', v_today);
  if v_helper->>'start_time' is distinct from '07:30'
     or v_helper->>'source' is distinct from 'manual' then
    raise exception 'precedence_manual_lost: %', v_helper;
  end if;

  v_helper := public.payroll_bn_shift_start_for('TASK_BOARD_E11', v_today);
  if v_helper->>'start_time' is distinct from '00:10'
     or v_helper->>'source' is distinct from 'mission' then
    raise exception 'precedence_mission_lost: %', v_helper;
  end if;

  v_helper := public.payroll_bn_shift_start_for('TASK_BOARD_E6', v_today);
  if coalesce((v_helper->>'scheduled_off')::boolean, false) is not true
     or v_helper->>'start_time' is not null
     or v_helper->>'source' is not null then
    raise exception 'scheduled_off_lost: %', v_helper;
  end if;

  v_helper := public.payroll_bn_shift_start_for('TASK_BOARD_E5', v_today);
  if coalesce((v_helper->>'on_leave')::boolean, false) is not true then
    raise exception 'approved_leave_lost: %', v_helper;
  end if;

  v_helper := public.payroll_bn_shift_start_for('TASK_BOARD_E2', v_d6);
  if coalesce((v_helper->>'closed')::boolean, false) is not true then
    raise exception 'closed_date_lost: %', v_helper;
  end if;

  v_helper := public.payroll_bn_shift_start_for('TASK_BOARD_E8', v_today);
  if v_helper->>'start_time' is not null
     or v_helper->>'source' is not null
     or coalesce((v_helper->>'scheduled_off')::boolean, false)
     or coalesce((v_helper->>'on_leave')::boolean, false)
     or coalesce((v_helper->>'closed')::boolean, false) then
    raise exception 'no_shift_time_not_empty: %', v_helper;
  end if;

  -- -----------------------------------------------------------------------
  -- 2. Today's board: every status, minutes, flags, totals and order.
  -- -----------------------------------------------------------------------
  v_board := public.get_payroll_bn_attendance_board(v_today);

  if v_board->>'date' is distinct from v_today::text then
    raise exception 'board_date_wrong: %', v_board->>'date';
  end if;
  if (v_board->>'late_grace_minutes')::integer <> 5 then
    raise exception 'board_grace_wrong: %', v_board->>'late_grace_minutes';
  end if;

  v_totals := v_board->'totals';
  if (v_totals->>'employees')::integer <> 13
     or (v_totals->>'checked_in')::integer <> 7
     or (v_totals->>'on_time')::integer <> 3
     or (v_totals->>'late')::integer <> 4
     or (v_totals->>'not_yet')::integer <> 1
     or (v_totals->>'absent_overdue')::integer <> 1
     or (v_totals->>'checked_out')::integer <> 1
     or (v_totals->>'off')::integer <> 2
     or (v_totals->>'no_shift_time')::integer <> 1 then
    raise exception 'board_totals_wrong: %', v_totals;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E1';
  if v_row->>'status' is distinct from 'on_time'
     or v_row->>'shift_start' is distinct from '08:00'
     or v_row->>'shift_source' is distinct from 'schedule'
     or (v_row->>'minutes_late')::integer <> 3
     or coalesce((v_row->>'checked_out')::boolean, false) is not true
     or (v_row->>'rejected_count')::integer <> 1 then
    raise exception 'board_on_time_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E2';
  if v_row->>'status' is distinct from 'late'
     or (v_row->>'minutes_late')::integer <> 15 then
    raise exception 'board_late_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E3';
  if v_row->>'status' is distinct from 'not_yet'
     or v_row->>'shift_source' is distinct from 'schedule' then
    raise exception 'board_not_yet_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E4';
  if v_row->>'status' is distinct from 'absent_overdue' then
    raise exception 'board_absent_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E5';
  if v_row->>'status' is distinct from 'off'
     or coalesce((v_row->>'on_leave')::boolean, false) is not true then
    raise exception 'board_leave_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E6';
  if v_row->>'status' is distinct from 'off'
     or coalesce((v_row->>'scheduled_off')::boolean, false) is not true then
    raise exception 'board_scheduled_off_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E7';
  if v_row->>'status' is distinct from 'override'
     or coalesce((v_row->>'has_override')::boolean, false) is not true then
    raise exception 'board_override_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E8';
  if v_row->>'status' is distinct from 'no_shift_time'
     or v_row->>'shift_start' is not null then
    raise exception 'board_no_shift_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E10';
  if v_row->>'shift_source' is distinct from 'manual'
     or (v_row->>'minutes_late')::integer <> 10 then
    raise exception 'board_manual_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E11';
  if v_row->>'shift_source' is distinct from 'mission'
     or (v_row->>'minutes_late')::integer <> 15 then
    raise exception 'board_mission_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E12';
  if v_row->>'shift_source' is distinct from 'schedule'
     or (v_row->>'minutes_late')::integer <> 5
     or v_row->>'status' is distinct from 'on_time' then
    raise exception 'board_schedule_precedence_row_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E13';
  if v_row->>'shift_source' is distinct from 'manual'
     or (v_row->>'minutes_late')::integer <> 10 then
    raise exception 'board_manual_precedence_row_wrong: %', v_row;
  end if;

  if (v_board->'employees'->0->>'status') is distinct from 'absent_overdue'
     or (v_board->'employees'->1->>'status') is distinct from 'not_yet'
     or (v_board->'employees'->2->>'employee_code') is distinct from 'TASK_BOARD_E11'
     or (v_board->'employees'->3->>'employee_code') is distinct from 'TASK_BOARD_E13'
     or (v_board->'employees'->4->>'employee_code') is distinct from 'TASK_BOARD_E10'
     or (v_board->'employees'->5->>'employee_code') is distinct from 'TASK_BOARD_E2'
     or (v_board->'employees'->6->>'status') is distinct from 'on_time'
     or (v_board->'employees'->7->>'status') is distinct from 'on_time'
     or (v_board->'employees'->8->>'employee_code') is distinct from 'TASK_BOARD_E12'
     or (v_board->'employees'->9->>'status') is distinct from 'no_shift_time'
     or (v_board->'employees'->10->>'status') is distinct from 'off'
     or (v_board->'employees'->11->>'status') is distinct from 'off'
     or (v_board->'employees'->12->>'status') is distinct from 'override' then
    raise exception 'board_order_wrong: %', v_board->'employees';
  end if;

  -- Closed date: no check-in on a working day stays off, never absent.
  v_board := public.get_payroll_bn_attendance_board(v_d6);
  select value into v_row
  from jsonb_array_elements(v_board->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E2';
  if v_row->>'status' is distinct from 'off'
     or coalesce((v_row->>'closed')::boolean, false) is not true
     or v_row->>'shift_start' is distinct from '08:00' then
    raise exception 'board_closed_row_wrong: %', v_row;
  end if;

  -- -----------------------------------------------------------------------
  -- 3. Board on_time/late agrees with the schedule attendance flags.
  -- -----------------------------------------------------------------------
  v_flags := public.get_payroll_bn_shift_attendance_flags(v_prev_week);

  for v_offset in 0..6 loop
    v_day := v_prev_week + v_offset;
    v_board := public.get_payroll_bn_attendance_board(v_day);

    for v_row in
      select value
      from jsonb_array_elements(v_board->'employees') r
      where r->>'employee_code' like 'TASK\_BOARD\_%' escape '\'
        and r->>'check_in_at' is not null
        and r->>'shift_start' is not null
    loop
      select exists (
        select 1
        from jsonb_array_elements(v_flags->'flags') f
        where f->>'employee_code' = v_row->>'employee_code'
          and f->>'work_date' = v_day::text
          and f->>'kind' = 'late'
      )
      into v_flag_late;

      if v_flag_late is distinct from (v_row->>'status' = 'late') then
        raise exception 'board_flags_late_mismatch % %: % / %',
          v_day, v_row->>'employee_code', v_row, v_flags;
      end if;

      if v_flag_late then
        select (f->>'minutes_late')::integer
        into v_flag_minutes
        from jsonb_array_elements(v_flags->'flags') f
        where f->>'employee_code' = v_row->>'employee_code'
          and f->>'work_date' = v_day::text
          and f->>'kind' = 'late'
        limit 1;

        if (v_row->>'minutes_late')::integer <> v_flag_minutes then
          raise exception 'board_flags_minutes_mismatch % %: % / %',
            v_day, v_row->>'employee_code', v_row->>'minutes_late', v_flag_minutes;
        end if;
      end if;
    end loop;
  end loop;

  -- -----------------------------------------------------------------------
  -- 4. Ranking counts, totals, streaks, ties and order.
  -- -----------------------------------------------------------------------
  v_ranking := public.get_payroll_bn_punctuality_ranking(v_prev_week, v_d7);

  if v_ranking->>'from' is distinct from v_prev_week::text
     or v_ranking->>'to' is distinct from v_d7::text
     or (v_ranking->>'late_grace_minutes')::integer <> 5 then
    raise exception 'ranking_envelope_wrong: %', v_ranking;
  end if;

  select value into v_row
  from jsonb_array_elements(v_ranking->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E1';
  if (v_row->>'worked_days')::integer <> 4
     or (v_row->>'on_time_days')::integer <> 3
     or (v_row->>'late_days')::integer <> 1
     or (v_row->>'late_minutes_total')::integer <> 10
     or (v_row->>'no_shift_time_days')::integer <> 1
     or (v_row->>'absent_days')::integer <> 1
     or (v_row->>'best_streak')::integer <> 2
     or (v_row->>'current_streak')::integer <> 1
     or (v_row->>'on_time_rate')::numeric <> 0.75
     or (v_row->>'rank')::integer <> 4 then
    raise exception 'ranking_e1_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_ranking->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E2';
  if (v_row->>'worked_days')::integer <> 5
     or (v_row->>'on_time_days')::integer <> 5
     or (v_row->>'late_days')::integer <> 0
     or (v_row->>'late_minutes_total')::integer <> 0
     or (v_row->>'absent_days')::integer <> 0
     or (v_row->>'best_streak')::integer <> 5
     or (v_row->>'current_streak')::integer <> 5
     or (v_row->>'on_time_rate')::numeric <> 1.00
     or (v_row->>'rank')::integer <> 1 then
    raise exception 'ranking_e2_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_ranking->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E3';
  if (v_row->>'rank')::integer <> 1
     or (v_row->>'on_time_days')::integer <> 5 then
    raise exception 'ranking_tie_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_ranking->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E5';
  if (v_row->>'worked_days')::integer <> 3
     or (v_row->>'on_time_days')::integer <> 3
     or (v_row->>'absent_days')::integer <> 0
     or (v_row->>'best_streak')::integer <> 3
     or (v_row->>'current_streak')::integer <> 3
     or (v_row->>'rank')::integer <> 3 then
    raise exception 'ranking_off_streak_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_ranking->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E4';
  if (v_row->>'worked_days')::integer <> 2
     or (v_row->>'on_time_days')::integer <> 0
     or (v_row->>'late_days')::integer <> 2
     or (v_row->>'late_minutes_total')::integer <> 35
     or (v_row->>'on_time_rate')::numeric <> 0.00
     or (v_row->>'rank')::integer <> 5 then
    raise exception 'ranking_late_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_ranking->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E6';
  if (v_row->>'worked_days')::integer <> 1
     or (v_row->>'no_shift_time_days')::integer <> 6
     or v_row->>'on_time_rate' is not null then
    raise exception 'ranking_no_shift_wrong: %', v_row;
  end if;

  select value into v_row
  from jsonb_array_elements(v_ranking->'employees') r
  where r->>'employee_code' = 'TASK_BOARD_E7';
  if (v_row->>'absent_days')::integer <> 1
     or (v_row->>'worked_days')::integer <> 0 then
    raise exception 'ranking_absent_wrong: %', v_row;
  end if;

  if (
    select count(*)
    from jsonb_array_elements(v_ranking->'employees') r
    where (r->>'rank')::integer = 1
  ) <> 2 then
    raise exception 'ranking_tie_count_wrong: %', v_ranking->'employees';
  end if;

  -- p_to clamps to today.
  v_ranking := public.get_payroll_bn_punctuality_ranking(v_prev_week, v_today + 10);
  if v_ranking->>'to' is distinct from v_today::text then
    raise exception 'ranking_to_not_clamped: %', v_ranking->>'to';
  end if;

  -- 92 days inclusive is allowed.
  v_ranking := public.get_payroll_bn_punctuality_ranking(v_today - 91, v_today);
  if v_ranking->>'from' is distinct from (v_today - 91)::text
     or v_ranking->>'to' is distinct from v_today::text then
    raise exception 'ranking_92_day_range_wrong: %', v_ranking;
  end if;

  -- -----------------------------------------------------------------------
  -- 5. Refusals: future date, >92 days, reversed range, non-manager.
  -- -----------------------------------------------------------------------
  begin
    perform public.get_payroll_bn_attendance_board(v_today + 1);
    raise exception 'board_future_date_not_blocked';
  exception when sqlstate '22023' then
    get stacked diagnostics v_error = message_text;
    if v_error not like '%payroll_bn_board_future_date%' then
      raise exception 'board_future_date_wrong_error: %', v_error;
    end if;
  end;

  begin
    perform public.get_payroll_bn_punctuality_ranking(v_today - 92, v_today);
    raise exception 'ranking_93_days_not_blocked';
  exception when sqlstate '22023' then
    null;
  end;

  begin
    perform public.get_payroll_bn_punctuality_ranking(v_today, v_today - 1);
    raise exception 'ranking_reversed_range_not_blocked';
  exception when sqlstate '22023' then
    null;
  end;

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000dd"}',
    true
  );

  begin
    perform public.get_payroll_bn_attendance_board(v_today);
    raise exception 'board_non_manager_not_blocked';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    perform public.get_payroll_bn_punctuality_ranking(v_prev_week, v_d7);
    raise exception 'ranking_non_manager_not_blocked';
  exception when sqlstate '42501' then
    null;
  end;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_manager)::text,
    true
  );

  -- -----------------------------------------------------------------------
  -- 6. The read-only RPCs wrote no rows.
  -- -----------------------------------------------------------------------
  perform public.get_payroll_bn_attendance_board(v_today);
  perform public.get_payroll_bn_attendance_board(v_prev_week + 2);
  perform public.get_payroll_bn_punctuality_ranking(v_prev_week, v_d7);

  select count(*) into v_events_after from public.payroll_bn_attendance_events;
  select count(*) into v_devices_after from public.payroll_bn_attendance_devices;
  select count(*) into v_entries_after from public.payroll_bn_shift_entries;
  select count(*) into v_requests_after from public.payroll_bn_shift_requests;
  select count(*) into v_overrides_after from public.payroll_bn_attendance_day_overrides;

  if v_events_after <> v_events_before
     or v_devices_after <> v_devices_before
     or v_entries_after <> v_entries_before
     or v_requests_after <> v_requests_before
     or v_overrides_after <> v_overrides_before then
    raise exception 'readonly_rpc_changed_rows: events %/%, devices %/%, entries %/%, requests %/%, overrides %/%',
      v_events_before, v_events_after,
      v_devices_before, v_devices_after,
      v_entries_before, v_entries_after,
      v_requests_before, v_requests_after,
      v_overrides_before, v_overrides_after;
  end if;

  raise notice 'ATTENDANCE_BOARD_SMOKE_PASS';
end
$$;

rollback;
