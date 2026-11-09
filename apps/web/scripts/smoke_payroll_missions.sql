-- Rollback-only smoke for 20261110090000_payroll_missions.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_missions.sql
--
-- Pure SQL: one transaction wraps one DO block. It sets service_role JWT
-- claims, seeds throwaway campaigns/offers/attendance events and asserts:
--   * an overlapping active campaign is rejected per eligible group
--   * item shape validation rejects duplicate keys
--   * gift on/off for one employee and for a whole list
--   * provisional progress for "chấm công đều" and "đúng giờ", cutoff/grace
--     and the accepted-date window
--   * disqualified review -> earned = [] and no ticket
--   * a ticket is issued only with >= 1 earned item and a draw_ticket item
--   * a ticket is void when the employee left before the draw date
--   * list_payroll_mission_bonus_for_period sums only confirmed,
--     non-disqualified rewards
-- A final rollback leaves no campaign/offer/review/ticket/event behind.

begin;

do $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_start date := v_today - 7;
  v_end date := v_today + 7;
  v_items jsonb;
  v_campaign jsonb;
  v_campaign_id uuid;
  v_overlap jsonb;
  v_period_id uuid;
  v_offer_e1 uuid;
  v_offer_e2 uuid;
  v_offer_e3 uuid;
  v_offer_e4 uuid;
  v_offer_e5 uuid;
  v_progress jsonb;
  v_review jsonb;
  v_bonus jsonb;
  v_ticket public.payroll_mission_draw_tickets%rowtype;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -----------------------------------------------------------------------
  -- Throwaway configuration: everything is data, no mission text in code.
  -- -----------------------------------------------------------------------
  v_items := jsonb_build_array(
    jsonb_build_object(
      'key', 'regular',
      'label', 'Chấm công đều',
      'detail', 'Đủ ngày, không thiếu giờ ra',
      'kind', 'attendance_regular',
      'amount_vnd', 100000,
      'params', jsonb_build_object('min_days', 2)
    ),
    jsonb_build_object(
      'key', 'punctual',
      'label', 'Đúng giờ',
      'detail', 'Vào ca trước 07:00',
      'kind', 'punctual',
      'amount_vnd', 50000,
      'params', jsonb_build_object('cutoff', '07:00', 'grace_minutes', 5)
    ),
    jsonb_build_object(
      'key', 'ticket',
      'label', 'Phiếu bốc thăm',
      'detail', 'Một phiếu quý',
      'kind', 'draw_ticket',
      'amount_vnd', 0,
      'params', '{}'::jsonb
    )
  );

  v_campaign := public.upsert_payroll_mission_campaign(jsonb_build_object(
    'code', 'TASK_MISSION_SMOKE',
    'title', 'Nhiệm vụ smoke',
    'summary', 'Dữ liệu thử, rollback ngay sau block',
    'starts_on', v_start,
    'ends_on', v_end,
    'eligible_groups', jsonb_build_array('Bếp bánh'),
    'items', v_items,
    'rules', jsonb_build_array('Không vi phạm nội quy'),
    'draw', jsonb_build_object(
      'quarter', '2026-Q4',
      'prize_vnd', 5000000,
      'draw_after', to_char(v_today + 30, 'YYYY-MM-DD')
    ),
    'status', 'active'
  ));
  v_campaign_id := (v_campaign->'campaign'->>'id')::uuid;

  -- Overlapping active campaign for the same eligible group must be rejected.
  begin
    v_overlap := public.upsert_payroll_mission_campaign(jsonb_build_object(
      'code', 'TASK_MISSION_OVERLAP',
      'title', 'Nhiệm vụ trùng',
      'starts_on', v_start,
      'ends_on', v_end,
      'eligible_groups', jsonb_build_array('Bếp bánh'),
      'items', v_items,
      'status', 'active'
    ));
    raise exception 'overlap_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%active_campaign_overlap%' then
      raise exception 'overlap_wrong_error: %', sqlerrm;
    end if;
  end;

  -- Duplicate item keys are rejected by the SQL helper.
  begin
    perform public.upsert_payroll_mission_campaign(jsonb_build_object(
      'code', 'TASK_MISSION_BAD_ITEMS',
      'title', 'Nhiệm vụ lỗi',
      'starts_on', v_start,
      'ends_on', v_end,
      'eligible_groups', jsonb_build_array('Bếp bánh'),
      'items', jsonb_build_array(
        jsonb_build_object('key', 'dup', 'label', 'A', 'kind', 'manual', 'amount_vnd', 1),
        jsonb_build_object('key', 'dup', 'label', 'B', 'kind', 'manual', 'amount_vnd', 2)
      ),
      'status', 'draft'
    ));
    raise exception 'duplicate_item_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%duplicate_key%' then
      raise exception 'duplicate_item_wrong_error: %', sqlerrm;
    end if;
  end;

  -- -----------------------------------------------------------------------
  -- Gift toggles: one employee + the whole-list call.
  -- -----------------------------------------------------------------------
  perform public.set_payroll_mission_gift(v_campaign_id, 'TASK_MISSION_E1', true, null);
  perform public.set_payroll_mission_gift(v_campaign_id, 'TASK_MISSION_E2', true, null);
  perform public.set_payroll_mission_gift(v_campaign_id, 'TASK_MISSION_E3', true, time '08:00');
  v_overlap := public.set_payroll_mission_gift_bulk(
    v_campaign_id,
    array['TASK_MISSION_E4', 'TASK_MISSION_E5'],
    true
  );
  if (v_overlap->>'updated')::integer <> 2 then
    raise exception 'bulk_gift_count_unexpected: %', v_overlap;
  end if;

  -- Disabling a pending offer hides it; history is kept by re-enabling it.
  perform public.set_payroll_mission_gift(v_campaign_id, 'TASK_MISSION_E5', false, null);
  if (
    select gift_enabled
    from public.payroll_mission_offers
    where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E5'
  ) is not false then
    raise exception 'gift_disable_not_stored';
  end if;
  perform public.set_payroll_mission_gift(v_campaign_id, 'TASK_MISSION_E5', true, null);

  select id into v_offer_e1 from public.payroll_mission_offers
  where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E1';
  select id into v_offer_e2 from public.payroll_mission_offers
  where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E2';
  select id into v_offer_e3 from public.payroll_mission_offers
  where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E3';
  select id into v_offer_e4 from public.payroll_mission_offers
  where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E4';
  select id into v_offer_e5 from public.payroll_mission_offers
  where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E5';

  -- E1 accepted one day after the campaign starts; an earlier event must be ignored.
  update public.payroll_mission_offers
  set status = 'accepted',
      responded_at = ((v_start + 1) + time '08:00') at time zone 'Asia/Ho_Chi_Minh'
  where id = v_offer_e1;
  -- The rest accepted on the first campaign day.
  update public.payroll_mission_offers
  set status = 'accepted',
      responded_at = (v_start + time '08:00') at time zone 'Asia/Ho_Chi_Minh'
  where id in (v_offer_e2, v_offer_e3, v_offer_e4, v_offer_e5);

  -- -----------------------------------------------------------------------
  -- Attendance events (accepted ledger). Times are Vietnam-local.
  -- -----------------------------------------------------------------------
  insert into public.payroll_bn_attendance_events(
    employee_code, event_kind, work_date, server_received_at, decision
  ) values
    -- E1: event before the accepted date (must be ignored) + 2 complete days,
    -- both on time at 07:05 with the 5-minute grace.
    ('TASK_MISSION_E1', 'in', v_start, ((v_start) + time '07:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E1', 'out', v_start, ((v_start) + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E1', 'in', v_start + 1, ((v_start + 1) + time '07:05') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E1', 'out', v_start + 1, ((v_start + 1) + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E1', 'in', v_start + 2, ((v_start + 2) + time '07:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E1', 'out', v_start + 2, ((v_start + 2) + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    -- E2: missing check-out on day 1 + late on day 1 -> neither item is met.
    ('TASK_MISSION_E2', 'in', v_start + 1, ((v_start + 1) + time '07:10') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E2', 'in', v_start + 2, ((v_start + 2) + time '07:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E2', 'out', v_start + 2, ((v_start + 2) + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    -- E3: 2 complete days but late under the default cutoff. The offer
    -- shift_start 08:00 override makes the punctual item met.
    ('TASK_MISSION_E3', 'in', v_start + 1, ((v_start + 1) + time '07:10') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E3', 'out', v_start + 1, ((v_start + 1) + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E3', 'in', v_start + 2, ((v_start + 2) + time '07:20') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E3', 'out', v_start + 2, ((v_start + 2) + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    -- E5: only one complete day, below min_days 2.
    ('TASK_MISSION_E5', 'in', v_start + 1, ((v_start + 1) + time '07:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_MISSION_E5', 'out', v_start + 1, ((v_start + 1) + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted');

  -- -----------------------------------------------------------------------
  -- Provisional progress
  -- -----------------------------------------------------------------------
  v_progress := public.payroll_mission_progress(v_offer_e1);
  if coalesce((
    select (item->>'met')::boolean
    from jsonb_array_elements(v_progress) item
    where item->>'key' = 'regular'
  ), false) is not true then
    raise exception 'regular_not_met_for_e1: %', v_progress;
  end if;
  if coalesce((
    select (item->>'met')::boolean
    from jsonb_array_elements(v_progress) item
    where item->>'key' = 'punctual'
  ), false) is not true then
    raise exception 'punctual_not_met_for_e1: %', v_progress;
  end if;
  if coalesce((
    select (item->'detail'->>'days_with_in')::integer
    from jsonb_array_elements(v_progress) item
    where item->>'key' = 'regular'
  ), 0) <> 2 then
    raise exception 'accepted_window_not_applied: %', v_progress;
  end if;

  v_progress := public.payroll_mission_progress(v_offer_e2);
  if coalesce((
    select (item->>'met')::boolean
    from jsonb_array_elements(v_progress) item
    where item->>'key' = 'regular'
  ), true) is not false then
    raise exception 'regular_met_with_missing_out: %', v_progress;
  end if;
  if coalesce((
    select (item->'detail'->>'days_missing_out')::integer
    from jsonb_array_elements(v_progress) item
    where item->>'key' = 'regular'
  ), 0) <> 1 then
    raise exception 'missing_out_not_counted: %', v_progress;
  end if;
  if coalesce((
    select (item->>'met')::boolean
    from jsonb_array_elements(v_progress) item
    where item->>'key' = 'punctual'
  ), true) is not false then
    raise exception 'punctual_met_after_late_day: %', v_progress;
  end if;

  v_progress := public.payroll_mission_progress(v_offer_e3);
  if coalesce((
    select (item->>'met')::boolean
    from jsonb_array_elements(v_progress) item
    where item->>'key' = 'punctual'
  ), false) is not true then
    raise exception 'shift_start_override_not_applied: %', v_progress;
  end if;

  -- -----------------------------------------------------------------------
  -- Final review + tickets
  -- -----------------------------------------------------------------------
  v_review := public.review_payroll_mission_offer(
    v_offer_e1,
    array['regular', 'punctual'],
    false,
    null
  );
  if jsonb_array_length(v_review->'review'->'earned') <> 2 then
    raise exception 'e1_earned_count_unexpected: %', v_review;
  end if;
  select * into v_ticket from public.payroll_mission_draw_tickets
  where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E1';
  if v_ticket.id is null or v_ticket.void_reason is not null then
    raise exception 'e1_ticket_not_issued: %', v_review;
  end if;

  -- E2 disqualified: earned forced to [], no ticket.
  v_review := public.review_payroll_mission_offer(
    v_offer_e2,
    array['regular'],
    true,
    'Vi phạm nội quy'
  );
  if jsonb_array_length(v_review->'review'->'earned') <> 0 then
    raise exception 'disqualified_still_earned: %', v_review;
  end if;
  if exists (
    select 1 from public.payroll_mission_draw_tickets
    where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E2'
  ) then
    raise exception 'disqualified_got_ticket';
  end if;

  -- E3 has no period employee row yet; create one that ended before the draw date.
  insert into public.payroll_bn_periods(
    period_code, period_name, date_from, date_to, default_standard_days
  ) values (
    'TASK-MISSION-SMOKE', 'Task mission smoke', v_start, v_end, 26
  ) returning id into v_period_id;

  insert into public.payroll_bn_period_employees(
    period_id, employee_code, employee_name, group_name, employment_type, end_date
  ) values (
    v_period_id, 'TASK_MISSION_E3', 'Task Mission E3', 'Bếp bánh', 'official', v_today - 1
  );

  perform public.review_payroll_mission_offer(
    v_offer_e3,
    array['regular'],
    false,
    null
  );
  select * into v_ticket from public.payroll_mission_draw_tickets
  where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E3';
  if v_ticket.id is null or v_ticket.void_reason is distinct from 'employee_left_before_draw' then
    raise exception 'left_employee_ticket_not_void: %', v_ticket;
  end if;

  -- E4 earned nothing (no_earned_items): no ticket, even though the campaign
  -- has a draw item.
  v_review := public.review_payroll_mission_offer(
    v_offer_e4,
    array[]::text[],
    false,
    null
  );
  if jsonb_array_length(v_review->'review'->'earned') <> 0 then
    raise exception 'empty_review_earned_money: %', v_review;
  end if;
  if exists (
    select 1 from public.payroll_mission_draw_tickets
    where campaign_id = v_campaign_id and employee_code = 'TASK_MISSION_E4'
  ) then
    raise exception 'empty_review_got_ticket';
  end if;

  -- -----------------------------------------------------------------------
  -- Payroll link: only confirmed, non-disqualified rewards.
  -- -----------------------------------------------------------------------
  v_bonus := public.list_payroll_mission_bonus_for_period(v_period_id);

  if coalesce((
    select (value->>'amount_vnd')::numeric
    from jsonb_array_elements(v_bonus) value
    where value->>'employee_code' = 'TASK_MISSION_E1'
  ), 0) <> 150000 then
    raise exception 'e1_bonus_unexpected: %', v_bonus;
  end if;

  if coalesce((
    select (value->>'amount_vnd')::numeric
    from jsonb_array_elements(v_bonus) value
    where value->>'employee_code' = 'TASK_MISSION_E3'
  ), 0) <> 100000 then
    raise exception 'e3_bonus_unexpected: %', v_bonus;
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_bonus) value
    where value->>'employee_code' = 'TASK_MISSION_E2'
  ) then
    raise exception 'disqualified_bonus_leaked: %', v_bonus;
  end if;

  -- The manager list exposes the reviews and tickets too.
  v_campaign := public.list_payroll_missions(v_campaign_id);
  if jsonb_array_length(v_campaign->'campaigns'->0->'offers') <> 5 then
    raise exception 'list_offer_count_unexpected: %', v_campaign;
  end if;

  -- Audit is append-only.
  begin
    delete from public.payroll_mission_events where campaign_id = v_campaign_id;
    raise exception 'events_delete_not_blocked';
  exception when sqlstate '45000' then
    null;
  end;

  if not exists (
    select 1 from public.payroll_mission_events
    where campaign_id = v_campaign_id
  ) then
    raise exception 'mission_writes_not_audited';
  end if;
end;
$$;

rollback;
