-- Run as one file: begin; <this file>; rollback; via `supabase db query --linked -f`. Rolls back by raising SMOKE_RESULT.
-- Rollback-only behavioural checks for the surprise-mission migrations.
do $$
declare
  v_owner uuid;
  v_period uuid := gen_random_uuid();
  v_tpl_pay uuid; v_tpl_rec uuid;
  v_draw jsonb; v_picked jsonb; v_count int; v_id uuid; v_other uuid;
  v_log text := '';
  v_ok boolean;
  v_row record;
begin
  -- structure + grants (BMQ has no default grants)
  for v_row in select unnest(array['payroll_bn_mission_templates','payroll_bn_mission_settings','payroll_bn_missions','payroll_bn_mission_bonuses','payroll_bn_mission_audit','payroll_bn_mission_draws']) as t loop
    if not has_table_privilege('authenticated', 'public.'||v_row.t, 'select') then raise exception 'CHECK FAIL: no select grant on %', v_row.t; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.'||v_row.t)::regclass) then raise exception 'CHECK FAIL: RLS off on %', v_row.t; end if;
  end loop;
  if has_table_privilege('anon', 'public.payroll_bn_missions', 'select') then raise exception 'CHECK FAIL: anon can read missions'; end if;
  for v_row in select p.proname from pg_proc p where p.proname in ('payroll_bn_mission_draw','payroll_bn_mission_publish','payroll_bn_mission_create_bonuses','payroll_bn_import_attendance') loop
    if not has_function_privilege('authenticated', (select oid from pg_proc where proname = v_row.proname limit 1), 'execute') then raise exception 'CHECK FAIL: no execute on %', v_row.proname; end if;
  end loop;
  if not exists (select 1 from information_schema.columns where table_name='payroll_bn_attendance_rows' and column_name='late_minutes') then raise exception 'CHECK FAIL: late_minutes missing'; end if;
  v_log := v_log || 'structure ok; ';

  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then raise exception 'CHECK FAIL: no owner user'; end if;

  insert into public.payroll_bn_periods(id, period_code, period_name, date_from, date_to, status)
  values (v_period, 'SMOKE-MISSIONS-'||left(v_period::text,8), 'SMOKE missions', '2099-01-01', '2099-01-31', 'draft');
  insert into public.payroll_bn_mission_templates(period_id, code, name, verification, mode, reward_vnd, enabled)
  values (v_period, 'T-DUNGGIO', 'Đúng giờ', 'auto', 'pay', 100000, true) returning id into v_tpl_pay;
  insert into public.payroll_bn_mission_templates(period_id, code, name, verification, mode, reward_vnd, enabled)
  values (v_period, 'T-GIOPT', 'Mốc giờ', 'auto', 'reconcile_only', null, true) returning id into v_tpl_rec;
  insert into public.payroll_bn_mission_settings(period_id, max_employees, budget_vnd) values (v_period, 2, 500000);

  -- act as the owner through PostgREST's identity
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- migration 2: import keeps Ca / Trễ / Sớm
  perform public.payroll_bn_import_attendance(v_period, 'smoke.xls', encode(sha256(convert_to(v_period::text,'UTF8')),'hex'),
    '[{"employee_code":"S1","employee_name":"S1","work_date":"2099-01-02","check_in":"08:05:00","check_out":"17:00:00","department":null,"shift":"HC","late_minutes":5,"early_minutes":0}]'::jsonb);
  select count(*) into v_count from public.payroll_bn_attendance_rows where period_id = v_period and shift = 'HC' and late_minutes = 5;
  if v_count <> 1 then raise exception 'CHECK FAIL: import did not keep shift/late (%).', v_count; end if;
  v_log := v_log || 'import shift/late ok; ';

  perform public.payroll_bn_mission_suggest(v_period, jsonb_build_array(
    jsonb_build_object('period_id', v_period, 'employee_code','S1','template_code','T-DUNGGIO','reason_text','1 ngày trễ','source_metrics','{}'::jsonb),
    jsonb_build_object('period_id', v_period, 'employee_code','S2','template_code','T-DUNGGIO','reason_text','2 ngày trễ','source_metrics','{}'::jsonb),
    jsonb_build_object('period_id', v_period, 'employee_code','S3','template_code','T-DUNGGIO','reason_text','3 ngày trễ','source_metrics','{}'::jsonb),
    jsonb_build_object('period_id', v_period, 'employee_code','S4','template_code','T-GIOPT','reason_text','giờ','source_metrics','{}'::jsonb)));
  select count(*) into v_count from public.payroll_bn_missions where period_id = v_period and status = 'suggested';
  if v_count <> 4 then raise exception 'CHECK FAIL: suggest count %', v_count; end if;

  perform public.payroll_bn_mission_draw(v_period, null);
  select picked into v_picked from public.payroll_bn_mission_draws where period_id = v_period order by draw_no desc limit 1;
  if jsonb_array_length(v_picked) <> 2 then raise exception 'CHECK FAIL: picked %', v_picked; end if;
  if exists (select 1 from jsonb_array_elements(v_picked) e where e.value->>'employee_code' = 'S4') then raise exception 'CHECK FAIL: reconcile-only S4 was drawn'; end if;
  v_log := v_log || 'draw 2 of 3 pay candidates ok; ';

  v_ok := false; begin perform public.payroll_bn_mission_draw(v_period, null); exception when others then v_ok := sqlerrm like '%draw_reason_required%'; end;
  if not v_ok then raise exception 'CHECK FAIL: redraw without reason allowed'; end if;
  perform public.payroll_bn_mission_draw(v_period, 'smoke redraw');
  select picked into v_picked from public.payroll_bn_mission_draws where period_id = v_period order by draw_no desc limit 1;

  select m.id into v_other from public.payroll_bn_missions m where m.period_id = v_period and m.employee_code not in (select e.value->>'employee_code' from jsonb_array_elements(v_picked) e) and m.employee_code <> 'S4' limit 1;
  v_ok := false; begin perform public.payroll_bn_mission_publish(v_other); exception when others then v_ok := sqlerrm like '%not_drawn%'; end;
  if not v_ok then raise exception 'CHECK FAIL: publish of a non-drawn mission allowed'; end if;

  for v_row in select (e.value->>'mission_id')::uuid as id from jsonb_array_elements(v_picked) e loop
    perform public.payroll_bn_mission_publish(v_row.id);
  end loop;
  v_ok := false; begin perform public.payroll_bn_mission_draw(v_period, 'after publish'); exception when others then v_ok := sqlerrm like '%draw_after_publish%'; end;
  if not v_ok then raise exception 'CHECK FAIL: draw after publish allowed'; end if;
  v_log := v_log || 'redraw reason / not_drawn / after_publish ok; ';

  v_id := (v_picked->0->>'mission_id')::uuid;
  v_ok := false; begin perform public.payroll_bn_mission_evaluate(v_id, 'achieved', '{}'::jsonb); exception when others then v_ok := true; end;
  if not v_ok then raise exception 'CHECK FAIL: evaluate before attendance approval / acceptance allowed'; end if;

  perform set_config('role', 'postgres', true);
  update public.payroll_bn_periods set attendance_approved_at = now() where id = v_period;
  perform set_config('role', 'authenticated', true);
  v_ok := false; begin perform public.payroll_bn_mission_evaluate(v_id, 'achieved', '{}'::jsonb); exception when others then v_ok := sqlerrm like '%invalid_status%'; end;
  if not v_ok then raise exception 'CHECK FAIL: evaluate of a not-accepted mission allowed'; end if;

  perform set_config('role', 'postgres', true);
  update public.payroll_bn_missions set status = 'accepted', accepted_at = now() where id = v_id;
  perform set_config('role', 'authenticated', true);
  perform public.payroll_bn_mission_evaluate(v_id, 'achieved', '{"smoke":true}'::jsonb);
  perform public.payroll_bn_mission_create_bonuses(v_period);
  perform public.payroll_bn_mission_create_bonuses(v_period);
  select count(*) into v_count from public.payroll_bn_mission_bonuses where period_id = v_period;
  if v_count <> 1 then raise exception 'CHECK FAIL: bonuses %', v_count; end if;
  if (select status from public.payroll_bn_missions where id = v_id) <> 'paid' then raise exception 'CHECK FAIL: not paid'; end if;
  if (select amount_vnd from public.payroll_bn_mission_bonuses where mission_id = v_id) <> 100000 then raise exception 'CHECK FAIL: amount'; end if;
  v_log := v_log || 'evaluate/bonus once/paid ok; ';

  perform public.payroll_bn_set_period_locked(v_period);
  v_ok := false; begin perform public.payroll_bn_mission_create_bonuses(v_period); exception when others then v_ok := sqlerrm like '%locked%'; end;
  if not v_ok then raise exception 'CHECK FAIL: bonuses on a locked period allowed'; end if;
  v_log := v_log || 'locked period ok; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
