-- Rollback-only smoke for 20261110150000_payroll_bn_employee_shifts.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_bn_employee_shifts.sql
--
-- Pure SQL: one transaction wraps one DO block. It sets service_role JWT
-- claims, seeds a throwaway campaign/offer/attendance day and asserts the
-- punctual cutoff precedence:
--   * item cutoff 07:00 + accepted check-in 07:45 -> item not met
--   * employee shift start 08:00 -> the same 07:45 check-in is on time
--   * offer.shift_start 07:30 wins over the employee shift -> not met again
--   * removing the employee shift returns to the item cutoff 07:00
-- A final rollback leaves no campaign/offer/event/shift behind.

begin;

do $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_campaign_id uuid;
  v_offer_id uuid;
  v_progress jsonb;
  v_met boolean;
  v_cutoff text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -----------------------------------------------------------------------
  -- Throwaway configuration: one punctual item with cutoff 07:00.
  -- -----------------------------------------------------------------------
  insert into public.payroll_mission_campaigns(
    code,
    title,
    summary,
    starts_on,
    ends_on,
    eligible_groups,
    items,
    rules,
    status
  ) values (
    'TASK_SHIFT_SMOKE',
    'Nhiệm vụ smoke giờ vào ca',
    'Dữ liệu thử, rollback ngay sau block',
    v_today - 7,
    v_today + 7,
    array['Bếp bánh'],
    jsonb_build_array(jsonb_build_object(
      'key', 'punctual',
      'label', 'Đúng giờ',
      'detail', 'Vào ca đúng giờ',
      'kind', 'punctual',
      'amount_vnd', 50000,
      'params', jsonb_build_object('cutoff', '07:00', 'grace_minutes', 0)
    )),
    '{}'::text[],
    'active'
  )
  returning id into v_campaign_id;

  insert into public.payroll_mission_offers(
    campaign_id,
    employee_code,
    status,
    responded_at
  ) values (
    v_campaign_id,
    'TASK_SHIFT_E1',
    'accepted',
    ((v_today - 1) + time '08:00') at time zone 'Asia/Ho_Chi_Minh'
  )
  returning id into v_offer_id;

  -- One accepted check-in at 07:45, later than the item cutoff 07:00.
  insert into public.payroll_bn_attendance_events(
    employee_code,
    event_kind,
    work_date,
    server_received_at,
    decision
  ) values
    (
      'TASK_SHIFT_E1',
      'in',
      v_today,
      (v_today + time '07:45') at time zone 'Asia/Ho_Chi_Minh',
      'accepted'
    ),
    (
      'TASK_SHIFT_E1',
      'out',
      v_today,
      (v_today + time '17:00') at time zone 'Asia/Ho_Chi_Minh',
      'accepted'
    );

  -- -----------------------------------------------------------------------
  -- 1. No employee shift: 07:45 is late under the item cutoff 07:00.
  -- -----------------------------------------------------------------------
  v_progress := public.payroll_mission_progress(v_offer_id);
  select (item->>'met')::boolean, item->'detail'->>'cutoff'
  into v_met, v_cutoff
  from jsonb_array_elements(v_progress) item
  where item->>'key' = 'punctual';

  if v_met is not false then
    raise exception 'punctual_met_without_employee_shift: %', v_progress;
  end if;
  if v_cutoff is distinct from '07:00' then
    raise exception 'default_cutoff_not_07_00: %', v_progress;
  end if;

  -- -----------------------------------------------------------------------
  -- 2. Employee shift start 08:00: the same 07:45 is on time.
  -- -----------------------------------------------------------------------
  insert into public.payroll_bn_employee_shifts(employee_code, shift_start)
  values ('TASK_SHIFT_E1', time '08:00')
  on conflict (employee_code) do update
  set shift_start = excluded.shift_start;

  v_progress := public.payroll_mission_progress(v_offer_id);
  select (item->>'met')::boolean, item->'detail'->>'cutoff'
  into v_met, v_cutoff
  from jsonb_array_elements(v_progress) item
  where item->>'key' = 'punctual';

  if v_met is not true then
    raise exception 'employee_shift_not_applied: %', v_progress;
  end if;
  if v_cutoff is distinct from '08:00' then
    raise exception 'employee_shift_cutoff_not_reported: %', v_progress;
  end if;

  -- -----------------------------------------------------------------------
  -- 3. Offer shift_start 07:30 wins over the employee shift: not met again.
  -- -----------------------------------------------------------------------
  update public.payroll_mission_offers
  set shift_start = time '07:30'
  where id = v_offer_id;

  v_progress := public.payroll_mission_progress(v_offer_id);
  select (item->>'met')::boolean, item->'detail'->>'cutoff'
  into v_met, v_cutoff
  from jsonb_array_elements(v_progress) item
  where item->>'key' = 'punctual';

  if v_met is not false then
    raise exception 'offer_shift_start_not_applied: %', v_progress;
  end if;
  if v_cutoff is distinct from '07:30' then
    raise exception 'offer_shift_start_cutoff_not_reported: %', v_progress;
  end if;

  -- -----------------------------------------------------------------------
  -- 4. Removing the employee shift returns to the item cutoff 07:00.
  -- -----------------------------------------------------------------------
  delete from public.payroll_bn_employee_shifts
  where employee_code = 'TASK_SHIFT_E1';

  update public.payroll_mission_offers
  set shift_start = null
  where id = v_offer_id;

  v_progress := public.payroll_mission_progress(v_offer_id);
  select (item->>'met')::boolean, item->'detail'->>'cutoff'
  into v_met, v_cutoff
  from jsonb_array_elements(v_progress) item
  where item->>'key' = 'punctual';

  if v_met is not false then
    raise exception 'punctual_met_after_shift_removal: %', v_progress;
  end if;
  if v_cutoff is distinct from '07:00' then
    raise exception 'removed_shift_still_applied: %', v_progress;
  end if;
end;
$$;

rollback;
