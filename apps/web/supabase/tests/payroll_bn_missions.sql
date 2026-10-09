-- ============================================================================
-- Rollback-only checks for migration 20261011090000_payroll_bn_missions.sql
--
-- Run against a local/shadow DB that already has the base schema and the
-- payroll_bn migrations applied:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/web/supabase/tests/payroll_bn_missions.sql
--
-- Everything runs inside BEGIN .. ROLLBACK, so no test data is persisted and no
-- real business record is touched. The script needs superuser rights for
-- SET session_replication_role while seeding.
-- ============================================================================

begin;

-- Verify the migration objects exist before testing behaviour.
do $$
begin
  if to_regclass('public.payroll_bn_mission_templates') is null
     or to_regclass('public.payroll_bn_mission_settings') is null
     or to_regclass('public.payroll_bn_missions') is null
     or to_regclass('public.payroll_bn_mission_bonuses') is null
     or to_regclass('public.payroll_bn_mission_audit') is null
     or to_regclass('public.payroll_bn_mission_draws') is null then
    raise exception 'TEST FAILED: mission migration objects are not present';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Seed: four periods with different settings, templates and users.
--   P-MAIN   max=5, budget=500.000  (suggest / one-per-employee / reward)
--   P-CAP    max=2, budget=1.000.000 (N = 2 distinct employees)
--   P-BUDGET max=5, budget=150.000  (cap blocks + overage)
--   P-LOCK   locked
-- ---------------------------------------------------------------------------
set local session_replication_role = replica;

insert into public.payroll_bn_periods
  (id, period_code, period_name, date_from, date_to, status, locked_at, attendance_approved_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'T-LOCK',  'Kỳ đã khoá', '2026-10-01', '2026-10-31', 'locked', now(), now()),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'T-MAIN',  'Kỳ chính',  '2026-10-01', '2026-10-31', 'draft', null, now()),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'T-CAP',   'Kỳ giới hạn 2', '2026-10-01', '2026-10-31', 'draft', null, now()),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'T-BUDGET','Kỳ trần thưởng', '2026-10-01', '2026-10-31', 'draft', null, now());

insert into public.payroll_bn_mission_templates
  (id, period_id, code, name, verification, mode, reward_vnd)
values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'T-DUNGGIO', 'Đúng giờ', 'auto', 'pay', 100000),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'T-CHAMDU',  'Chấm đủ',  'auto', 'pay', null),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', 'T-GIOPT',   'Giờ tối đa', 'auto', 'reconcile_only', 100000),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000003', 'T-DUNGGIO', 'Đúng giờ', 'auto', 'pay', 100000),
  ('bbbbbbbb-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000004', 'T-DUNGGIO', 'Đúng giờ', 'auto', 'pay', 200000);

insert into public.payroll_bn_mission_settings(period_id, max_employees, budget_vnd)
values
  ('aaaaaaaa-0000-0000-0000-000000000002', 5, 500000),
  ('aaaaaaaa-0000-0000-0000-000000000003', 2, 1000000),
  ('aaaaaaaa-0000-0000-0000-000000000004', 5, 150000);

insert into public.user_roles (user_id, role)
values ('55555555-5555-5555-5555-555555555555', 'owner');

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
values
  ('33333333-3333-3333-3333-333333333333', 'payroll', true, true),
  ('66666666-6666-6666-6666-666666666666', 'payroll', true, false);

set local session_replication_role = origin;

-- ---------------------------------------------------------------------------
-- 1) Unique (employee, period, template) and the template code check.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.payroll_bn_missions(period_id, employee_code, template_id, status)
  values ('aaaaaaaa-0000-0000-0000-000000000002', 'E1', 'bbbbbbbb-0000-0000-0000-000000000001', 'suggested');

  begin
    insert into public.payroll_bn_missions(period_id, employee_code, template_id, status)
    values ('aaaaaaaa-0000-0000-0000-000000000002', 'E1', 'bbbbbbbb-0000-0000-0000-000000000001', 'suggested');
    raise exception 'TEST FAILED: duplicate (employee, period, template) was accepted';
  exception
    when unique_violation then null;
  end;

  begin
    insert into public.payroll_bn_mission_templates(period_id, code, name)
    values ('aaaaaaaa-0000-0000-0000-000000000002', 'T-BOGUS', 'Sai mã');
    raise exception 'TEST FAILED: unknown template code was accepted';
  exception
    when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Suggest is idempotent and only touches status suggested.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
declare
  v_first integer;
  v_second integer;
  v_count integer;
begin
  v_first := public.payroll_bn_mission_suggest(
    'aaaaaaaa-0000-0000-0000-000000000002',
    jsonb_build_array(jsonb_build_object('employee_code', 'E2', 'template_code', 'T-DUNGGIO', 'reason_text', '7 ngày trễ', 'source_metrics', '{"so_ngay_tre":7}'::jsonb))
  );
  v_second := public.payroll_bn_mission_suggest(
    'aaaaaaaa-0000-0000-0000-000000000002',
    jsonb_build_array(jsonb_build_object('employee_code', 'E2', 'template_code', 'T-DUNGGIO', 'reason_text', '7 ngày trễ', 'source_metrics', '{"so_ngay_tre":7}'::jsonb))
  );
  if v_first <> 1 or v_second <> 1 then
    raise exception 'TEST FAILED: suggest not idempotent (%, %)', v_first, v_second;
  end if;

  select count(*) into v_count
  from public.payroll_bn_missions
  where period_id = 'aaaaaaaa-0000-0000-0000-000000000002' and employee_code = 'E2';
  if v_count <> 1 then
    raise exception 'TEST FAILED: suggest duplicated the mission (%)', v_count;
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 3) N = 2 distinct employees on P-CAP: the third publish is refused.
-- ---------------------------------------------------------------------------
set local session_replication_role = replica;
insert into public.payroll_bn_missions(period_id, employee_code, template_id, status)
values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'C1', 'bbbbbbbb-0000-0000-0000-000000000004', 'suggested'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'C2', 'bbbbbbbb-0000-0000-0000-000000000004', 'suggested'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'C3', 'bbbbbbbb-0000-0000-0000-000000000004', 'suggested');

-- Latest draw of P-CAP, listing every suggested mission so publish reaches the
-- existing max-employees rule (the drawn check is the last one).
insert into public.payroll_bn_mission_draws(period_id, draw_no, pool, picked, reason)
select 'aaaaaaaa-0000-0000-0000-000000000003', 1,
       jsonb_agg(jsonb_build_object('employee_code', employee_code, 'mission_ids', jsonb_build_array(id))),
       jsonb_agg(jsonb_build_object('employee_code', employee_code, 'mission_id', id)),
       'seed'
from public.payroll_bn_missions
where period_id = 'aaaaaaaa-0000-0000-0000-000000000003' and status = 'suggested';
set local session_replication_role = origin;

set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
declare
  v_ids uuid[];
begin
  select array_agg(id order by employee_code) into v_ids
  from public.payroll_bn_missions
  where period_id = 'aaaaaaaa-0000-0000-0000-000000000003';

  perform public.payroll_bn_mission_publish(v_ids[1]);
  perform public.payroll_bn_mission_publish(v_ids[2]);

  begin
    perform public.payroll_bn_mission_publish(v_ids[3]);
    raise exception 'TEST FAILED: a third employee was published';
  exception
    when sqlstate '23514' then null; -- payroll_bn_mission_max_employees
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 4) One mission per employee on P-MAIN: E1 cannot publish a second template.
-- ---------------------------------------------------------------------------
set local session_replication_role = replica;
insert into public.payroll_bn_missions(period_id, employee_code, template_id, status)
values ('aaaaaaaa-0000-0000-0000-000000000002', 'E1', 'bbbbbbbb-0000-0000-0000-000000000003', 'suggested');

-- Latest draw of P-MAIN, listing every suggested mission so publish reaches the
-- one-mission-per-employee rule.
insert into public.payroll_bn_mission_draws(period_id, draw_no, pool, picked, reason)
select 'aaaaaaaa-0000-0000-0000-000000000002', 1,
       jsonb_agg(jsonb_build_object('employee_code', employee_code, 'mission_ids', jsonb_build_array(id))),
       jsonb_agg(jsonb_build_object('employee_code', employee_code, 'mission_id', id)),
       'seed'
from public.payroll_bn_missions
where period_id = 'aaaaaaaa-0000-0000-0000-000000000002' and status = 'suggested';
set local session_replication_role = origin;

set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
declare
  v_first uuid;
  v_second uuid;
begin
  select id into v_first from public.payroll_bn_missions
   where period_id = 'aaaaaaaa-0000-0000-0000-000000000002' and employee_code = 'E1'
     and template_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  perform public.payroll_bn_mission_publish(v_first);

  select id into v_second from public.payroll_bn_missions
   where period_id = 'aaaaaaaa-0000-0000-0000-000000000002' and employee_code = 'E1'
     and template_id = 'bbbbbbbb-0000-0000-0000-000000000003';
  begin
    perform public.payroll_bn_mission_publish(v_second);
    raise exception 'TEST FAILED: a second mission for the same employee was published';
  exception
    when sqlstate '23505' then null; -- payroll_bn_mission_one_per_employee
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 5) mode=pay with a null reward is refused on P-MAIN.
-- ---------------------------------------------------------------------------
set local session_replication_role = replica;
insert into public.payroll_bn_missions(period_id, employee_code, template_id, status)
values ('aaaaaaaa-0000-0000-0000-000000000002', 'E4', 'bbbbbbbb-0000-0000-0000-000000000002', 'suggested');
set local session_replication_role = origin;

set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
declare
  v_mission uuid;
begin
  select id into v_mission from public.payroll_bn_missions
   where period_id = 'aaaaaaaa-0000-0000-0000-000000000002' and employee_code = 'E4';
  begin
    perform public.payroll_bn_mission_publish(v_mission);
    raise exception 'TEST FAILED: pay mode without a reward was published';
  exception
    when sqlstate '22023' then null; -- payroll_bn_mission_reward_required
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 6) The budget cap blocks on P-BUDGET and the error carries the overage.
-- ---------------------------------------------------------------------------
set local session_replication_role = replica;
insert into public.payroll_bn_missions(period_id, employee_code, template_id, status)
values ('aaaaaaaa-0000-0000-0000-000000000004', 'B1', 'bbbbbbbb-0000-0000-0000-000000000005', 'suggested');
set local session_replication_role = origin;

set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
declare
  v_mission uuid;
begin
  select id into v_mission from public.payroll_bn_missions
   where period_id = 'aaaaaaaa-0000-0000-0000-000000000004' and employee_code = 'B1';
  begin
    perform public.payroll_bn_mission_publish(v_mission);
    raise exception 'TEST FAILED: budget cap was ignored';
  exception
    when sqlstate '23514' then
      if sqlerrm not like '%budget_exceeded%' then
        raise exception 'TEST FAILED: expected budget_exceeded, got %', sqlerrm;
      end if;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 7) A locked period rejects mission writes and bonus creation.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.payroll_bn_missions(period_id, employee_code, template_id, status)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'E9', 'bbbbbbbb-0000-0000-0000-000000000001', 'suggested');
    raise exception 'TEST FAILED: locked period accepted a mission';
  exception
    when sqlstate '55006' then null;
  end;
end $$;

set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
begin
  begin
    perform public.payroll_bn_mission_create_bonuses('aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'TEST FAILED: locked period accepted bonuses';
  exception
    when sqlstate '55006' then null;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 8) create_bonuses is idempotent (one row per mission) and audits the write.
-- ---------------------------------------------------------------------------
set local session_replication_role = replica;
update public.payroll_bn_missions set status = 'achieved'
 where period_id = 'aaaaaaaa-0000-0000-0000-000000000002' and employee_code = 'E1'
   and template_id = 'bbbbbbbb-0000-0000-0000-000000000001';
set local session_replication_role = origin;

set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
declare
  v_first integer;
  v_second integer;
  v_bonus integer;
  v_audit integer;
begin
  v_first := public.payroll_bn_mission_create_bonuses('aaaaaaaa-0000-0000-0000-000000000002');
  v_second := public.payroll_bn_mission_create_bonuses('aaaaaaaa-0000-0000-0000-000000000002');
  if v_first <> 1 or v_second <> 0 then
    raise exception 'TEST FAILED: create_bonuses not idempotent (%, %)', v_first, v_second;
  end if;

  select count(*) into v_bonus
  from public.payroll_bn_mission_bonuses
  where period_id = 'aaaaaaaa-0000-0000-0000-000000000002';
  if v_bonus <> 1 then
    raise exception 'TEST FAILED: % bonus rows for one achieved mission', v_bonus;
  end if;

  select count(*) into v_audit
  from public.payroll_bn_mission_audit
  where period_id = 'aaaaaaaa-0000-0000-0000-000000000002' and action = 'create_bonus';
  if v_audit <> 1 then
    raise exception 'TEST FAILED: create_bonus audit rows=%', v_audit;
  end if;
end $$;
reset role;

-- Every write RPC above must have left an audit row.
do $$
declare
  v_actions text[];
begin
  select array_agg(distinct action) into v_actions
  from public.payroll_bn_mission_audit
  where period_id = 'aaaaaaaa-0000-0000-0000-000000000002';
  if not ('suggest' = any(v_actions) and 'publish' = any(v_actions) and 'create_bonus' = any(v_actions)) then
    raise exception 'TEST FAILED: audit trail is missing actions: %', v_actions;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9) RLS: a viewer cannot publish.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated"}';
set local role authenticated;
do $$
declare
  v_mission uuid;
begin
  select id into v_mission from public.payroll_bn_missions
   where period_id = 'aaaaaaaa-0000-0000-0000-000000000004' and employee_code = 'B1';
  begin
    perform public.payroll_bn_mission_publish(v_mission);
    raise exception 'TEST FAILED: payroll viewer was allowed to publish';
  exception
    when insufficient_privilege then null; -- 42501
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 10) Draw (bốc thăm): pool snapshot, max 2, second-draw reason, after-publish,
--     not-drawn publish and the locked period.
-- ---------------------------------------------------------------------------
set local session_replication_role = replica;

insert into public.payroll_bn_periods
  (id, period_code, period_name, date_from, date_to, status, locked_at, attendance_approved_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000005', 'T-DRAW',     'Kỳ bốc thăm',  '2026-10-01', '2026-10-31', 'draft', null, now()),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'T-NOTDRAWN', 'Kỳ không trúng','2026-10-01', '2026-10-31', 'draft', null, now()),
  ('aaaaaaaa-0000-0000-0000-000000000007', 'T-EMPTY',    'Kỳ rỗng',       '2026-10-01', '2026-10-31', 'draft', null, now());

insert into public.payroll_bn_mission_templates
  (id, period_id, code, name, verification, mode, reward_vnd)
values
  ('bbbbbbbb-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000005', 'T-DUNGGIO', 'Đúng giờ', 'auto', 'pay', 100000),
  ('bbbbbbbb-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000006', 'T-DUNGGIO', 'Đúng giờ', 'auto', 'pay', 100000);

insert into public.payroll_bn_mission_settings(period_id, max_employees, budget_vnd)
values
  ('aaaaaaaa-0000-0000-0000-000000000005', 2, 1000000),
  ('aaaaaaaa-0000-0000-0000-000000000006', 5, 1000000),
  ('aaaaaaaa-0000-0000-0000-000000000007', 2, 1000000);

-- Four suggested missions for the draw, one per employee.
insert into public.payroll_bn_missions(id, period_id, employee_code, template_id, status)
values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000005', 'D1', 'bbbbbbbb-0000-0000-0000-000000000006', 'suggested'),
  ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000005', 'D2', 'bbbbbbbb-0000-0000-0000-000000000006', 'suggested'),
  ('dddddddd-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000005', 'D3', 'bbbbbbbb-0000-0000-0000-000000000006', 'suggested'),
  ('dddddddd-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000005', 'D4', 'bbbbbbbb-0000-0000-0000-000000000006', 'suggested');

-- One suggested mission on P-NOTDRAWN, deliberately absent from the seeded draw.
insert into public.payroll_bn_missions(id, period_id, employee_code, template_id, status)
values ('dddddddd-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000006', 'N1', 'bbbbbbbb-0000-0000-0000-000000000007', 'suggested');

insert into public.payroll_bn_mission_draws(period_id, draw_no, pool, picked, reason)
values (
  'aaaaaaaa-0000-0000-0000-000000000006',
  1,
  '[]'::jsonb,
  jsonb_build_array(
    jsonb_build_object('employee_code', 'N2', 'mission_id', 'dddddddd-0000-0000-0000-000000000099')
  ),
  'seed'
);

set local session_replication_role = origin;

set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;

do $$
declare
  v_result jsonb;
  v_draws integer;
  v_picked integer;
begin
  -- Draw #1: at most 2 people, each with one of their own suggested missions.
  v_result := public.payroll_bn_mission_draw('aaaaaaaa-0000-0000-0000-000000000005', null);
  select count(*) into v_draws from public.payroll_bn_mission_draws
   where period_id = 'aaaaaaaa-0000-0000-0000-000000000005';
  if v_draws <> 1 then
    raise exception 'TEST FAILED: expected 1 draw row, got %', v_draws;
  end if;

  v_picked := jsonb_array_length(v_result->'picked');
  if v_picked < 1 or v_picked > 2 then
    raise exception 'TEST FAILED: picked % employees (max 2)', v_picked;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_result->'picked') p(value)
    where not exists (
      select 1
      from public.payroll_bn_missions m
      where m.id = (p.value->>'mission_id')::uuid
        and m.employee_code = p.value->>'employee_code'
        and m.period_id = 'aaaaaaaa-0000-0000-0000-000000000005'
        and m.status = 'suggested'
    )
  ) then
    raise exception 'TEST FAILED: draw picked a mission outside the pool';
  end if;

  -- Draw #2 without a reason is refused.
  begin
    perform public.payroll_bn_mission_draw('aaaaaaaa-0000-0000-0000-000000000005', '   ');
    raise exception 'TEST FAILED: second draw without a reason was accepted';
  exception
    when sqlstate '22023' then null; -- payroll_bn_mission_draw_reason_required
  end;

  -- Draw #2 with a reason is accepted.
  perform public.payroll_bn_mission_draw(
    'aaaaaaaa-0000-0000-0000-000000000005',
    'Bốc lại sau khi rà soát'
  );
  select count(*) into v_draws from public.payroll_bn_mission_draws
   where period_id = 'aaaaaaaa-0000-0000-0000-000000000005';
  if v_draws <> 2 then
    raise exception 'TEST FAILED: expected 2 draw rows, got %', v_draws;
  end if;
end $$;

-- Publish a mission of the latest draw, then a further draw is refused.
do $$
declare
  v_mission uuid;
begin
  select (p.value->>'mission_id')::uuid into v_mission
  from public.payroll_bn_mission_draws d
  cross join lateral jsonb_array_elements(d.picked) p(value)
  where d.period_id = 'aaaaaaaa-0000-0000-0000-000000000005'
  order by d.draw_no desc
  limit 1;

  perform public.payroll_bn_mission_publish(v_mission);

  begin
    perform public.payroll_bn_mission_draw(
      'aaaaaaaa-0000-0000-0000-000000000005',
      'Bốc sau khi đã phát hành'
    );
    raise exception 'TEST FAILED: draw after publish was accepted';
  exception
    when sqlstate '55006' then null; -- payroll_bn_mission_draw_after_publish
  end;
end $$;

-- A mission that is not part of the latest draw cannot be published.
do $$
begin
  begin
    perform public.payroll_bn_mission_publish('dddddddd-0000-0000-0000-000000000005');
    raise exception 'TEST FAILED: a not-drawn mission was published';
  exception
    when sqlstate '22023' then
      if sqlerrm not like '%payroll_bn_mission_not_drawn%' then
        raise exception 'TEST FAILED: expected not_drawn, got %', sqlerrm;
      end if;
  end;
end $$;

-- The empty period has no suggested mission → an explicit error.
do $$
begin
  begin
    perform public.payroll_bn_mission_draw('aaaaaaaa-0000-0000-0000-000000000007', null);
    raise exception 'TEST FAILED: an empty pool was accepted';
  exception
    when sqlstate '22023' then
      if sqlerrm not like '%payroll_bn_mission_draw_empty_pool%' then
        raise exception 'TEST FAILED: expected empty_pool, got %', sqlerrm;
      end if;
  end;
end $$;

reset role;

-- The locked period rejects a draw.
set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
set local role authenticated;
do $$
begin
  begin
    perform public.payroll_bn_mission_draw('aaaaaaaa-0000-0000-0000-000000000001', null);
    raise exception 'TEST FAILED: a locked period accepted a draw';
  exception
    when sqlstate '55006' then null; -- payroll_bn_period_locked
  end;
end $$;
reset role;

rollback;
