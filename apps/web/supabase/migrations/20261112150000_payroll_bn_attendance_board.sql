-- ============================================================================
-- Migration: Bảng chấm công trực tiếp + xếp hạng đúng giờ (payroll_bn)
--
-- Adds two read-only manager RPCs plus one internal helper:
--   * public.payroll_bn_shift_start_for(code, date)  — per-date shift start
--   * public.get_payroll_bn_attendance_board(date)   — one-day live board
--   * public.get_payroll_bn_punctuality_ranking(from, to)
--
-- No table, no trigger, no cron, no data write. The helper is not callable by
-- anon/authenticated; both manager RPCs are authenticated + service_role and
-- re-check owner / payroll.edit inside.
--
-- ON-TIME RULE (chosen to match the shift-schedule contract):
--   published week registered shift start -> payroll_bn_employee_shifts manual
--   start -> punctual cutoff of the employee's active mission campaign.
--   Grace is payroll_bn_shift_settings.late_grace_minutes, minutes floored.
--   This reproduces get_payroll_bn_shift_attendance_flags (published week +
--   settings grace). payroll_mission_progress is close but not identical: its
--   punctual item also accepts a registered start from an UNPUBLISHED week and
--   uses the item's own params.grace_minutes. Where they differ, this migration
--   follows the shift-schedule rule requested for the attendance flags.
--   The mission fallback 07:00 is the same literal used by
--   public.payroll_mission_progress; no shared config row exists for it.
--
-- This migration has NOT been applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Per-date shift start for one employee
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_shift_start_for(
  p_employee_code text,
  p_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_code text := btrim(coalesce(p_employee_code, ''));
  v_week_start date;
  v_week public.payroll_bn_shift_weeks%rowtype;
  v_entry public.payroll_bn_shift_entries%rowtype;
  v_start_time time;
  v_source text;
  v_scheduled_off boolean := false;
  v_on_leave boolean := false;
  v_closed boolean := false;
  v_manual_time time;
  v_offer public.payroll_mission_offers%rowtype;
  v_campaign public.payroll_mission_campaigns%rowtype;
  v_item jsonb;
  v_cutoff_text text;
  -- Same fallback as public.payroll_mission_progress when the punctual item has
  -- no valid params.cutoff. No separate configuration row exists for it.
  v_mission_default time := time '07:00';
begin
  if v_code = '' or p_date is null then
    return jsonb_build_object(
      'start_time', null,
      'source', null,
      'scheduled_off', false,
      'on_leave', false,
      'closed', false
    );
  end if;

  v_week_start := public.payroll_bn_shift_week_start(p_date);

  if v_week_start is not null then
    select * into v_week
    from public.payroll_bn_shift_weeks
    where week_start = v_week_start;
  end if;

  -- 2) Published schedule wins over every manual/mission cutoff.
  if v_week.week_start is not null and v_week.status = 'published' then
    v_closed := p_date = any (coalesce(v_week.closed_dates, '{}'::date[]));

    select * into v_entry
    from public.payroll_bn_shift_entries
    where employee_code = v_code
      and work_date = p_date;

    if v_entry.id is not null then
      if v_entry.shift_code is not null then
        select st.start_time into v_start_time
        from public.payroll_bn_shift_types st
        where st.code = v_entry.shift_code;

        if v_start_time is not null then
          v_source := 'schedule';
        end if;
      else
        -- A registered null-shift entry is a scheduled day off.
        v_scheduled_off := true;
      end if;
    end if;
  end if;

  -- Approved leave is a day flag independent of the shift source.
  select exists (
    select 1
    from public.payroll_bn_shift_requests r
    where r.employee_code = v_code
      and r.work_date = p_date
      and r.kind = 'leave'
      and r.state = 'approved'
  )
  into v_on_leave;

  -- 3) Manual then mission, only when the published schedule has no start and
  --    the day is not already an off day.
  if v_start_time is null and not v_scheduled_off and not v_on_leave and not v_closed then
    select s.shift_start into v_manual_time
    from public.payroll_bn_employee_shifts s
    where s.employee_code = v_code;

    if v_manual_time is not null then
      v_start_time := v_manual_time;
      v_source := 'manual';
    else
      -- 4) The cutoff the mission uses for this date: offer override first,
      --    then the punctual item params.cutoff, then the same 07:00 fallback.
      select o.* into v_offer
      from public.payroll_mission_offers o
      join public.payroll_mission_campaigns c on c.id = o.campaign_id
      where o.employee_code = v_code
        and c.status = 'active'
        and p_date between c.starts_on and c.ends_on
        -- Only when the campaign targets the employee's group (latest period
        -- catalogue). A gift sent to another group (e.g. Kho) must not give
        -- that group the kitchen's punctual cutoff as a shift start.
        and (
          coalesce(cardinality(c.eligible_groups), 0) = 0
          or exists (
            select 1
            from public.payroll_bn_period_employees pe
            where pe.employee_code = v_code
              and pe.period_id = (
                select p.id from public.payroll_bn_periods p
                order by p.date_from desc, p.created_at desc
                limit 1
              )
              and pe.group_name = any (c.eligible_groups)
          )
        )
      order by c.starts_on desc, c.created_at desc
      limit 1;

      if v_offer.id is not null then
        select * into v_campaign
        from public.payroll_mission_campaigns
        where id = v_offer.campaign_id;

        if v_offer.shift_start is not null then
          v_start_time := v_offer.shift_start;
        else
          select value into v_item
          from jsonb_array_elements(v_campaign.items)
          where value->>'kind' = 'punctual'
          limit 1;

          v_cutoff_text := nullif(btrim(coalesce(v_item->'params'->>'cutoff', '')), '');

          if v_cutoff_text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
            v_start_time := v_cutoff_text::time;
          else
            v_start_time := v_mission_default;
          end if;
        end if;

        v_source := 'mission';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'start_time', case when v_start_time is null then null else to_char(v_start_time, 'HH24:MI') end,
    'source', v_source,
    'scheduled_off', v_scheduled_off,
    'on_leave', v_on_leave,
    'closed', v_closed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) One-day attendance board
-- ---------------------------------------------------------------------------
create or replace function public.get_payroll_bn_attendance_board(
  p_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamp := (now() at time zone 'Asia/Ho_Chi_Minh');
  v_today date := (v_now)::date;
  v_date date := coalesce(p_date, v_today);
  v_grace integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_totals jsonb;
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_board_forbidden' using errcode = '42501';
  end if;

  if v_date > v_today then
    raise exception 'payroll_bn_board_future_date' using errcode = '22023';
  end if;

  v_grace := coalesce((
    select s.late_grace_minutes
    from public.payroll_bn_shift_settings s
    where s.id
  ), 0);

  with gate_rows as (
    select g.employee_code
    from public.payroll_bn_attendance_gates g
    where g.enabled
  ),
  employees as (
    select
      gr.employee_code,
      public.payroll_bn_shift_employee_name(gr.employee_code) as name,
      (
        select pe.group_name
        from (
          select p.id
          from public.payroll_bn_periods p
          order by p.date_from desc, p.created_at desc
          limit 1
        ) lp
        join public.payroll_bn_period_employees pe on pe.period_id = lp.id
        where pe.employee_code = gr.employee_code
      ) as group_name
    from gate_rows gr
  ),
  shift_info as (
    select
      e.employee_code,
      e.name,
      e.group_name,
      public.payroll_bn_shift_start_for(e.employee_code, v_date) as info
    from employees e
  ),
  day_events as (
    select
      ev.employee_code,
      min(ev.server_received_at) filter (
        where ev.decision = 'accepted' and ev.event_kind = 'in'
      ) as check_in_at,
      count(*) filter (where ev.decision = 'rejected') as rejected_count
    from public.payroll_bn_attendance_events ev
    where ev.work_date = v_date
    group by ev.employee_code
  ),
  day_outs as (
    select ev.employee_code, max(ev.server_received_at) as check_out_at
    from public.payroll_bn_attendance_events ev
    join day_events de on de.employee_code = ev.employee_code
    where ev.work_date = v_date
      and ev.decision = 'accepted'
      and ev.event_kind = 'out'
      and de.check_in_at is not null
      and ev.server_received_at >= de.check_in_at
    group by ev.employee_code
  ),
  base as (
    select
      si.employee_code,
      si.name,
      si.group_name,
      nullif(si.info->>'start_time', '')::time as start_time,
      si.info->>'source' as shift_source,
      coalesce((si.info->>'scheduled_off')::boolean, false) as scheduled_off,
      coalesce((si.info->>'on_leave')::boolean, false) as on_leave,
      coalesce((si.info->>'closed')::boolean, false) as closed,
      de.check_in_at,
      dout.check_out_at,
      coalesce(de.rejected_count, 0) as rejected_count,
      exists (
        select 1
        from public.payroll_bn_attendance_day_overrides o
        where o.employee_code = si.employee_code
          and o.work_date = v_date
      ) as has_override
    from shift_info si
    left join day_events de on de.employee_code = si.employee_code
    left join day_outs dout on dout.employee_code = si.employee_code
  ),
  computed as (
    select
      b.*,
      case
        when b.start_time is null or b.check_in_at is null then null
        else greatest(
          0,
          floor(
            extract(epoch from (
              (b.check_in_at at time zone 'Asia/Ho_Chi_Minh')::time - b.start_time
            )) / 60
          )::integer
        )
      end as minutes_late
    from base b
  ),
  statused as (
    select
      c.*,
      case
        when c.check_in_at is not null and c.start_time is null then 'no_shift_time'
        when c.check_in_at is not null then
          case when c.minutes_late <= v_grace then 'on_time' else 'late' end
        when c.scheduled_off or c.on_leave or c.closed then 'off'
        when c.has_override then 'override'
        when c.start_time is null then 'no_shift_time'
        when v_date = v_today
          and v_now <= v_date + c.start_time + make_interval(mins => v_grace) then 'not_yet'
        else 'absent_overdue'
      end as status
    from computed c
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'employee_code', s.employee_code,
          'name', s.name,
          'group_name', s.group_name,
          'shift_start', case when s.start_time is null then null else to_char(s.start_time, 'HH24:MI') end,
          'shift_source', s.shift_source,
          'scheduled_off', s.scheduled_off,
          'on_leave', s.on_leave,
          'closed', s.closed,
          'check_in_at', s.check_in_at,
          'check_out_at', s.check_out_at,
          'minutes_late', s.minutes_late,
          'status', s.status,
          'checked_out', s.check_out_at is not null,
          'rejected_count', s.rejected_count,
          'has_override', s.has_override
        )
        order by
          case s.status
            when 'absent_overdue' then 0
            when 'not_yet' then 1
            when 'late' then 2
            when 'on_time' then 3
            when 'no_shift_time' then 4
            when 'off' then 5
            else 6
          end,
          s.start_time nulls last,
          s.name,
          s.employee_code
      ),
      '[]'::jsonb
    ),
    jsonb_build_object(
      'employees', count(*),
      'checked_in', count(*) filter (where s.check_in_at is not null),
      'on_time', count(*) filter (where s.status = 'on_time'),
      'late', count(*) filter (where s.status = 'late'),
      'not_yet', count(*) filter (where s.status = 'not_yet'),
      'absent_overdue', count(*) filter (where s.status = 'absent_overdue'),
      'checked_out', count(*) filter (where s.check_out_at is not null),
      'off', count(*) filter (where s.status = 'off'),
      'no_shift_time', count(*) filter (where s.status = 'no_shift_time')
    )
  into v_rows, v_totals
  from statused s;

  return jsonb_build_object(
    'date', v_date,
    'generated_at', now(),
    'late_grace_minutes', v_grace,
    'employees', v_rows,
    'totals', v_totals
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Punctuality ranking
-- ---------------------------------------------------------------------------
create or replace function public.get_payroll_bn_punctuality_ranking(
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_from date := p_from;
  v_to date;
  v_grace integer := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_board_forbidden' using errcode = '42501';
  end if;

  if p_from is null or p_to is null then
    raise exception 'payroll_bn_board_range_invalid' using errcode = '22023';
  end if;

  v_to := least(p_to, v_today);

  -- 92 calendar days inclusive: from .. from+91.
  if v_from > v_to or (v_to - v_from) > 91 then
    raise exception 'payroll_bn_board_range_invalid' using errcode = '22023';
  end if;

  v_grace := coalesce((
    select s.late_grace_minutes
    from public.payroll_bn_shift_settings s
    where s.id
  ), 0);

  with gate_rows as (
    select g.employee_code
    from public.payroll_bn_attendance_gates g
    where g.enabled
  ),
  employees as (
    select
      gr.employee_code,
      public.payroll_bn_shift_employee_name(gr.employee_code) as name,
      (
        select pe.group_name
        from (
          select p.id
          from public.payroll_bn_periods p
          order by p.date_from desc, p.created_at desc
          limit 1
        ) lp
        join public.payroll_bn_period_employees pe on pe.period_id = lp.id
        where pe.employee_code = gr.employee_code
      ) as group_name
    from gate_rows gr
  ),
  days as (
    select gs::date as work_date
    from generate_series(v_from, v_to, interval '1 day') gs
  ),
  shift_info as (
    select
      e.employee_code,
      e.name,
      e.group_name,
      d.work_date,
      public.payroll_bn_shift_start_for(e.employee_code, d.work_date) as info
    from employees e
    cross join days d
  ),
  checkins as (
    select
      ev.employee_code,
      ev.work_date,
      min(ev.server_received_at) as check_in_at
    from public.payroll_bn_attendance_events ev
    where ev.work_date between v_from and v_to
      and ev.decision = 'accepted'
      and ev.event_kind = 'in'
    group by ev.employee_code, ev.work_date
  ),
  base as (
    select
      si.employee_code,
      si.name,
      si.group_name,
      si.work_date,
      nullif(si.info->>'start_time', '')::time as start_time,
      coalesce((si.info->>'scheduled_off')::boolean, false) as scheduled_off,
      coalesce((si.info->>'on_leave')::boolean, false) as on_leave,
      coalesce((si.info->>'closed')::boolean, false) as closed,
      ci.check_in_at,
      exists (
        select 1
        from public.payroll_bn_attendance_day_overrides o
        where o.employee_code = si.employee_code
          and o.work_date = si.work_date
      ) as has_override
    from shift_info si
    left join checkins ci
      on ci.employee_code = si.employee_code
     and ci.work_date = si.work_date
  ),
  computed as (
    select
      b.*,
      case
        when b.start_time is null or b.check_in_at is null then null
        else greatest(
          0,
          floor(
            extract(epoch from (
              (b.check_in_at at time zone 'Asia/Ho_Chi_Minh')::time - b.start_time
            )) / 60
          )::integer
        )
      end as minutes_late
    from base b
  ),
  marked as (
    select
      c.*,
      (c.check_in_at is not null) as worked,
      (
        c.start_time is not null
        and not (c.scheduled_off or c.on_leave or c.closed)
        and not c.has_override
        and c.check_in_at is null
        and c.work_date < v_today
      ) as is_absent,
      case
        when c.check_in_at is not null and c.start_time is null then 'break'
        when c.check_in_at is not null then
          case when c.minutes_late <= v_grace then 'on_time' else 'break' end
        when c.scheduled_off or c.on_leave or c.closed then 'skip'
        when c.has_override then 'skip'
        when c.start_time is not null and c.work_date < v_today then 'break'
        else 'skip'
      end as streak_kind
    from computed c
  ),
  stats as (
    select
      m.employee_code,
      m.name,
      m.group_name,
      count(*) filter (where m.worked) as worked_days,
      count(*) filter (where m.streak_kind = 'on_time') as on_time_days,
      count(*) filter (
        where m.worked and m.start_time is not null and m.minutes_late > v_grace
      ) as late_days,
      coalesce(
        sum(m.minutes_late) filter (
          where m.worked and m.start_time is not null and m.minutes_late > v_grace
        ),
        0
      ) as late_minutes_total,
      -- Mirrors the board's no_shift_time status: any non-off date without a
      -- start time, including a worked date with no configured shift.
      count(*) filter (
        where m.start_time is null
          and (
            m.worked
            or (not (m.scheduled_off or m.on_leave or m.closed) and not m.has_override)
          )
      ) as no_shift_time_days,
      count(*) filter (where m.is_absent) as absent_days
    from marked m
    group by m.employee_code, m.name, m.group_name
  ),
  streak_events as (
    select m.employee_code, m.work_date, m.streak_kind
    from marked m
    where m.streak_kind <> 'skip'
  ),
  runs as (
    select
      se.employee_code,
      se.work_date,
      se.streak_kind,
      sum(case when se.streak_kind = 'break' then 1 else 0 end)
        over (partition by se.employee_code order by se.work_date) as run_group
    from streak_events se
  ),
  run_stats as (
    select
      r.employee_code,
      r.run_group,
      count(*) filter (where r.streak_kind = 'on_time') as run_len
    from runs r
    group by r.employee_code, r.run_group
  ),
  streak_stats as (
    select
      s.employee_code,
      coalesce((
        select max(rs.run_len)
        from run_stats rs
        where rs.employee_code = s.employee_code
      ), 0) as best_streak,
      coalesce((
        select rs.run_len
        from run_stats rs
        where rs.employee_code = s.employee_code
        order by rs.run_group desc
        limit 1
      ), 0) as current_streak
    from stats s
  ),
  scored as (
    select
      s.employee_code,
      s.name,
      s.group_name,
      s.worked_days,
      s.on_time_days,
      s.late_days,
      s.late_minutes_total,
      s.no_shift_time_days,
      s.absent_days,
      st.best_streak,
      st.current_streak,
      case
        when s.on_time_days + s.late_days > 0
          then round(s.on_time_days::numeric / (s.on_time_days + s.late_days), 2)
        else null
      end as on_time_rate
    from stats s
    join streak_stats st on st.employee_code = s.employee_code
  ),
  ranked as (
    select
      sc.*,
      rank() over (
        order by
          sc.on_time_days desc,
          sc.on_time_rate desc nulls last,
          sc.late_minutes_total asc
      ) as rank
    from scored sc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'rank', r.rank,
        'employee_code', r.employee_code,
        'name', r.name,
        'group_name', r.group_name,
        'worked_days', r.worked_days,
        'on_time_days', r.on_time_days,
        'late_days', r.late_days,
        'late_minutes_total', r.late_minutes_total,
        'no_shift_time_days', r.no_shift_time_days,
        'absent_days', r.absent_days,
        'best_streak', r.best_streak,
        'current_streak', r.current_streak,
        'on_time_rate', r.on_time_rate
      )
      order by r.rank, r.name, r.employee_code
    ),
    '[]'::jsonb
  )
  into v_rows
  from ranked r;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'late_grace_minutes', v_grace,
    'employees', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Grants: helper internal, two manager RPCs authenticated + service_role
-- ---------------------------------------------------------------------------
revoke all on function public.payroll_bn_shift_start_for(text, date)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_shift_start_for(text, date)
  to service_role;

revoke all on function public.get_payroll_bn_attendance_board(date)
  from public, anon, authenticated;
grant execute on function public.get_payroll_bn_attendance_board(date)
  to authenticated, service_role;

revoke all on function public.get_payroll_bn_punctuality_ranking(date, date)
  from public, anon, authenticated;
grant execute on function public.get_payroll_bn_punctuality_ranking(date, date)
  to authenticated, service_role;

comment on function public.payroll_bn_shift_start_for(text, date) is
  'Internal per-date shift start: published week entry, manual employee shift, then active mission punctual cutoff. Returns start_time, source, scheduled_off, on_leave, closed.';
comment on function public.get_payroll_bn_attendance_board(date) is
  'Manager one-day attendance board for every enabled GPS gate. p_date null = today in Asia/Ho_Chi_Minh; future dates raise payroll_bn_board_future_date (22023). Read-only.';
comment on function public.get_payroll_bn_punctuality_ranking(date, date) is
  'Manager punctuality ranking over a date range (p_to clamped to today ICT; more than 92 days or p_from > p_to raises payroll_bn_board_range_invalid). Read-only.';
