-- Rollback-only smoke for 20261110180000_payroll_bn_shift_schedule.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_bn_shift_schedule.sql
--
-- Pure SQL: one transaction wraps one DO block. It sets service_role JWT
-- claims, seeds a throwaway period/employees/config and asserts:
--   * an on-time complete week is registered;
--   * submitting after the deadline is rejected;
--   * a week without a day off is rejected;
--   * a closed date is ignored/removed;
--   * the last slot taken by one employee waitlists the second one;
--   * a day off above the daily limit is waitlisted;
--   * a manager edit records previous_shift_code;
--   * publish stores carried entries for an unregistered employee with a
--     previous week;
--   * the board exposes coverage numbers and warnings;
--   * payroll_mission_progress uses each date's registered shift start
--     (07:45 is on time with an 08:00 shift, late with the 07:00 fallback)
--     and falls back on a date without an entry;
--   * the audit table is append-only.
-- A final rollback leaves no fixture behind.

begin;

do $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_current_week date := public.payroll_bn_shift_week_start(v_today);
  v_week date := v_current_week + 7;
  v_period_id uuid;
  v_settings public.payroll_bn_shift_settings%rowtype;
  v_entries jsonb;
  v_result jsonb;
  v_board jsonb;
  v_week_row public.payroll_bn_shift_weeks%rowtype;
  v_entry public.payroll_bn_shift_entries%rowtype;
  v_campaign jsonb;
  v_campaign_id uuid;
  v_offer_id uuid;
  v_progress jsonb;
  v_detail jsonb;
  v_count integer;
  v_date1 date := v_today - 2;
  v_date2 date := v_today - 1;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -----------------------------------------------------------------------
  -- Throwaway data-driven configuration. No shift type is seeded by the
  -- migration; every code/time/needed/limit below is a smoke fixture.
  -- -----------------------------------------------------------------------
  v_result := public.upsert_payroll_bn_shift_config(jsonb_build_object(
    'shift_types', jsonb_build_array(
      jsonb_build_object(
        'code', 'TASK_SHIFT_SANG',
        'label', 'Ca sáng smoke',
        'start_time', '08:00',
        'end_time', '12:00',
        'sort', 1,
        'active', true
      ),
      jsonb_build_object(
        'code', 'TASK_SHIFT_CHIEU',
        'label', 'Ca chiều smoke',
        'start_time', '13:00',
        'end_time', '17:00',
        'sort', 2,
        'active', true
      )
    ),
    'quotas', jsonb_build_array(
      jsonb_build_object(
        'shift_code', 'TASK_SHIFT_SANG',
        'iso_dow', null,
        'needed', 1,
        'quota_group', null
      ),
      jsonb_build_object(
        'shift_code', 'TASK_SHIFT_CHIEU',
        'iso_dow', null,
        'needed', 5,
        'quota_group', null
      )
    ),
    'settings', jsonb_build_object(
      'eligible_groups', jsonb_build_array('Bếp bánh'),
      -- The opening/deadline days belong to the current week, so "now" is
      -- inside the window for next week's target week.
      'open_iso_dow', 1,
      'deadline_iso_dow', 7,
      'deadline_time', '23:59',
      'max_off_per_day', 1,
      'min_staff_per_day', 5,
      'min_off_days_per_week', 1
    )
  ));

  select * into v_settings
  from public.payroll_bn_shift_settings
  where id;

  -- A future latest period makes these throwaway employees the board roster.
  insert into public.payroll_bn_periods(
    period_code, period_name, date_from, date_to, default_standard_days
  ) values (
    'TASK-SHIFT-SMOKE',
    'Task shift smoke',
    v_week + 3650,
    v_week + 3680,
    26
  ) returning id into v_period_id;

  insert into public.payroll_bn_period_employees(
    period_id, employee_code, employee_name, group_name, employment_type, end_date
  ) values
    (v_period_id, 'TASK_SHIFT_E1', 'Task Shift E1', 'Bếp bánh', 'official', null),
    (v_period_id, 'TASK_SHIFT_E2', 'Task Shift E2', 'Bếp bánh', 'official', null),
    (v_period_id, 'TASK_SHIFT_E3', 'Task Shift E3', 'Bếp bánh', 'official', null),
    (v_period_id, 'TASK_SHIFT_E4', 'Task Shift E4', 'Bếp bánh', 'official', null),
    (v_period_id, 'TASK_SHIFT_E5', 'Task Shift E5', 'Bếp bánh', 'official', null);

  -- -----------------------------------------------------------------------
  -- E1 registers a complete on-time week (6 shifts + the last day off).
  -- -----------------------------------------------------------------------
  select jsonb_agg(jsonb_build_object(
    'work_date', v_week + day_offset,
    'shift_code', case when day_offset = 6 then null else 'TASK_SHIFT_SANG' end
  ) order by day_offset)
  into v_entries
  from generate_series(0, 6) as day_offset;

  v_result := public.submit_payroll_bn_shift_registration(
    'TASK_SHIFT_E1',
    v_week,
    v_entries
  );

  if (v_result->>'eligible')::boolean is not true then
    raise exception 'e1_not_eligible: %', v_result;
  end if;
  if (v_result->'week'->>'can_edit')::boolean is not true then
    raise exception 'e1_week_not_editable: %', v_result;
  end if;
  if (v_result->'week'->>'week_start')::date <> v_week then
    raise exception 'e1_wrong_week: %', v_result;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_result->'days') d
    where (d->'my'->>'state') = 'waitlist'
  ) then
    raise exception 'e1_first_slot_waitlisted: %', v_result;
  end if;

  -- -----------------------------------------------------------------------
  -- E2 takes the same last slot on day 0 -> waitlist. E2's day 6 off is also
  -- waitlisted because E1 already has one day off.
  -- -----------------------------------------------------------------------
  select jsonb_agg(jsonb_build_object(
    'work_date', v_week + day_offset,
    'shift_code', case when day_offset = 6 then null else 'TASK_SHIFT_SANG' end
  ) order by day_offset)
  into v_entries
  from generate_series(0, 6) as day_offset;

  v_result := public.submit_payroll_bn_shift_registration(
    'TASK_SHIFT_E2',
    v_week,
    v_entries
  );

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'days') d
    where d->>'work_date' = (v_week)::text
      and d->'my'->>'state' = 'waitlist'
  ) then
    raise exception 'last_slot_not_waitlisted: %', v_result;
  end if;

  -- -----------------------------------------------------------------------
  -- E3 off-day beyond max_off_per_day -> waitlist.
  -- -----------------------------------------------------------------------
  select jsonb_agg(jsonb_build_object(
    'work_date', v_week + day_offset,
    'shift_code', case when day_offset = 6 then null else 'TASK_SHIFT_SANG' end
  ) order by day_offset)
  into v_entries
  from generate_series(0, 6) as day_offset;

  v_result := public.submit_payroll_bn_shift_registration(
    'TASK_SHIFT_E3',
    v_week,
    v_entries
  );

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'days') d
    where d->>'work_date' = (v_week + 6)::text
      and d->'my'->>'state' = 'waitlist'
  ) then
    raise exception 'off_limit_not_waitlisted: %', v_result;
  end if;

  -- -----------------------------------------------------------------------
  -- E4 registers a normal week, then the manager changes one cell.
  -- -----------------------------------------------------------------------
  select jsonb_agg(jsonb_build_object(
    'work_date', v_week + day_offset,
    'shift_code', case
      when day_offset = 6 then null
      when day_offset = 2 then 'TASK_SHIFT_CHIEU'
      else 'TASK_SHIFT_CHIEU'
    end
  ) order by day_offset)
  into v_entries
  from generate_series(0, 6) as day_offset;

  perform public.submit_payroll_bn_shift_registration(
    'TASK_SHIFT_E4',
    v_week,
    v_entries
  );

  v_result := public.set_payroll_bn_shift_entry(
    v_week,
    'TASK_SHIFT_E4',
    v_week + 2,
    'TASK_SHIFT_SANG'
  );

  if (v_result->'entry'->>'previous_shift_code') is distinct from 'TASK_SHIFT_CHIEU' then
    raise exception 'manager_edit_lost_previous_shift: %', v_result;
  end if;
  if (v_result->'entry'->>'source') is distinct from 'manager' then
    raise exception 'manager_edit_wrong_source: %', v_result;
  end if;
  if (v_result->'entry'->>'state') is distinct from 'registered' then
    raise exception 'manager_edit_wrong_state: %', v_result;
  end if;

  -- -----------------------------------------------------------------------
  -- E5 has entries for the current week and none for next week. Publishing
  -- next week stores those suggestions as source='carried'.
  -- -----------------------------------------------------------------------
  insert into public.payroll_bn_shift_weeks(week_start, status)
  values (v_current_week, 'open')
  on conflict (week_start) do nothing;

  insert into public.payroll_bn_shift_entries(
    week_start, employee_code, work_date, shift_code, state, source
  ) values
    (v_current_week, 'TASK_SHIFT_E5', v_current_week, 'TASK_SHIFT_SANG', 'registered', 'employee'),
    (v_current_week, 'TASK_SHIFT_E5', v_current_week + 1, null, 'registered', 'employee');

  v_result := public.publish_payroll_bn_shift_week(v_week);

  if (v_result->'week'->>'status') is distinct from 'published' then
    raise exception 'publish_status_not_stored: %', v_result;
  end if;

  select count(*)
  into v_count
  from public.payroll_bn_shift_entries
  where employee_code = 'TASK_SHIFT_E5'
    and week_start = v_week
    and source = 'carried';

  if v_count <> 2 then
    raise exception 'carried_entries_not_stored: %', v_count;
  end if;

  if not exists (
    select 1
    from public.payroll_bn_shift_entries
    where employee_code = 'TASK_SHIFT_E5'
      and week_start = v_week
      and work_date = v_week
      and source = 'carried'
  ) then
    raise exception 'carried_entry_not_shifted_plus_7';
  end if;

  v_result := public.reopen_payroll_bn_shift_week(v_week);
  if (v_result->'week'->>'status') is distinct from 'open' then
    raise exception 'reopen_not_stored: %', v_result;
  end if;

  -- -----------------------------------------------------------------------
  -- Manager board: coverage numbers + warnings + unregistered list.
  -- -----------------------------------------------------------------------
  v_board := public.get_payroll_bn_shift_board(v_week);

  if jsonb_array_length(v_board->'employees') <> 5 then
    raise exception 'board_employee_count_unexpected: %', v_board;
  end if;
  if jsonb_array_length(v_board->'coverage'->'dates') <> 7 then
    raise exception 'board_coverage_days_unexpected: %', v_board->'coverage';
  end if;
  if (v_board->'coverage'->'dates'->0->>'total_staff')::integer < 1 then
    raise exception 'board_total_staff_unexpected: %', v_board->'coverage'->'dates'->0;
  end if;
  if not (v_board->'warnings' ? 'below_needed')
     or not (v_board->'warnings' ? 'below_min_staff')
     or not (v_board->'warnings' ? 'off_above_max')
     or not (v_board->'warnings' ? 'unregistered') then
    raise exception 'board_warnings_missing: %', v_board->'warnings';
  end if;

  -- -----------------------------------------------------------------------
  -- Punctual link: E1 has an 08:00 shift on date1 and no entry on date2.
  -- 07:45 on date1 is on time (schedule), 07:45 on date2 is late (fallback
  -- 07:00). detail.cutoff stays the fallback and scheduled_days counts date1.
  -- -----------------------------------------------------------------------
  v_campaign := public.upsert_payroll_mission_campaign(jsonb_build_object(
    'code', 'TASK_SHIFT_PROGRESS',
    'title', 'Task shift progress smoke',
    'starts_on', v_today - 7,
    'ends_on', v_today + 7,
    'eligible_groups', jsonb_build_array('Bếp bánh'),
    'items', jsonb_build_array(jsonb_build_object(
      'key', 'punctual',
      'label', 'Đúng giờ',
      'kind', 'punctual',
      'amount_vnd', 1000,
      'params', jsonb_build_object('cutoff', '07:00', 'grace_minutes', 0)
    )),
    'status', 'active'
  ));
  v_campaign_id := (v_campaign->'campaign'->>'id')::uuid;

  perform public.set_payroll_mission_gift(v_campaign_id, 'TASK_SHIFT_E1', true, null);

  select id into v_offer_id
  from public.payroll_mission_offers
  where campaign_id = v_campaign_id
    and employee_code = 'TASK_SHIFT_E1';

  update public.payroll_mission_offers
  set status = 'accepted',
      responded_at = ((v_today - 7) + time '08:00') at time zone 'Asia/Ho_Chi_Minh'
  where id = v_offer_id;

  -- v_date1 can fall in the previous week (e.g. on a Monday or Tuesday).
  insert into public.payroll_bn_shift_weeks(week_start, status)
  values (public.payroll_bn_shift_week_start(v_date1), 'open')
  on conflict (week_start) do nothing;

  insert into public.payroll_bn_shift_entries(
    week_start, employee_code, work_date, shift_code, state, source
  ) values (
    public.payroll_bn_shift_week_start(v_date1),
    'TASK_SHIFT_E1',
    v_date1,
    'TASK_SHIFT_SANG',
    'registered',
    'manager'
  );

  insert into public.payroll_bn_attendance_events(
    employee_code, event_kind, work_date, server_received_at, decision
  ) values
    ('TASK_SHIFT_E1', 'in', v_date1, (v_date1 + time '07:45') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_SHIFT_E1', 'out', v_date1, (v_date1 + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_SHIFT_E1', 'in', v_date2, (v_date2 + time '07:45') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_SHIFT_E1', 'out', v_date2, (v_date2 + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted');

  v_progress := public.payroll_mission_progress(v_offer_id);

  select item->'detail'
  into v_detail
  from jsonb_array_elements(v_progress) item
  where item->>'key' = 'punctual';

  if (v_detail->>'days_with_in')::integer <> 2 then
    raise exception 'progress_days_unexpected: %', v_detail;
  end if;
  if (v_detail->>'on_time_days')::integer <> 1 then
    raise exception 'progress_schedule_cutoff_not_applied: %', v_detail;
  end if;
  if (v_detail->>'scheduled_days')::integer <> 1 then
    raise exception 'progress_scheduled_days_unexpected: %', v_detail;
  end if;
  if (v_detail->>'cutoff') is distinct from '07:00' then
    raise exception 'progress_fallback_cutoff_changed: %', v_detail;
  end if;
  if coalesce((
    select (item->>'met')::boolean
    from jsonb_array_elements(v_progress) item
    where item->>'key' = 'punctual'
  ), true) is not false then
    raise exception 'progress_late_day_not_counted: %', v_progress;
  end if;

  -- -----------------------------------------------------------------------
  -- Closed date: it is ignored/removed from the submitted week.
  -- -----------------------------------------------------------------------
  perform public.set_payroll_bn_shift_closed_dates(v_week, array[v_week + 4]);

  select jsonb_agg(jsonb_build_object(
    'work_date', v_week + day_offset,
    'shift_code', case when day_offset = 6 then null else 'TASK_SHIFT_SANG' end
  ) order by day_offset)
  into v_entries
  from generate_series(0, 6) as day_offset
  where day_offset <> 4;

  -- A stale entry for the closed date is sent too and must be ignored.
  v_entries := v_entries || jsonb_build_array(jsonb_build_object(
    'work_date', v_week + 4,
    'shift_code', 'TASK_SHIFT_SANG'
  ));

  v_result := public.submit_payroll_bn_shift_registration(
    'TASK_SHIFT_E1',
    v_week,
    v_entries
  );

  select value into v_result
  from jsonb_array_elements(v_result->'days')
  where value->>'work_date' = (v_week + 4)::text;

  if (v_result->>'closed')::boolean is not true or v_result->'my' <> 'null'::jsonb then
    raise exception 'closed_date_not_ignored: %', v_result;
  end if;

  -- -----------------------------------------------------------------------
  -- After the deadline (target = this week, whose window closed last Sunday).
  -- -----------------------------------------------------------------------
  begin
    perform public.submit_payroll_bn_shift_registration(
      'TASK_SHIFT_E1',
      v_current_week,
      '[]'::jsonb
    );
    raise exception 'deadline_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%shift_registration_closed%' then
      raise exception 'deadline_wrong_error: %', sqlerrm;
    end if;
  end;

  -- -----------------------------------------------------------------------
  -- No day off is rejected.
  -- -----------------------------------------------------------------------
  select jsonb_agg(jsonb_build_object(
    'work_date', v_week + day_offset,
    'shift_code', 'TASK_SHIFT_SANG'
  ) order by day_offset)
  into v_entries
  from generate_series(0, 6) as day_offset;

  begin
    perform public.submit_payroll_bn_shift_registration(
      'TASK_SHIFT_E1',
      v_week,
      v_entries
    );
    raise exception 'no_day_off_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%shift_day_off_required%' then
      raise exception 'no_day_off_wrong_error: %', sqlerrm;
    end if;
  end;

  -- -----------------------------------------------------------------------
  -- Audit is append-only.
  -- -----------------------------------------------------------------------
  begin
    delete from public.payroll_bn_shift_events where week_start = v_week;
    raise exception 'events_delete_not_blocked';
  exception when sqlstate '45000' then
    null;
  end;

  if not exists (
    select 1 from public.payroll_bn_shift_events where week_start = v_week
  ) then
    raise exception 'shift_writes_not_audited';
  end if;
end;
$$;

rollback;
