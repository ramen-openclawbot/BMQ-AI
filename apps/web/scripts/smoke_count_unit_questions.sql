-- Rollback-only smoke for migration 20261101380000_stock_count_unit_questions.sql.
--
-- Run as one file (from apps/web), by the database owner/Maestro, after the
-- migration is applied:
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_count_unit_questions.sql
-- or wrapped with the migration in one rollback transaction:
--   begin; <migration>; <this file>; rollback;
--
-- The file is self-contained: it opens one transaction (a no-op if one is
-- already open), impersonates the real owner from public.user_roles through
-- request.jwt.claims, then exercises the game:
--   (a) the batch '2026-10-16' has exactly 12 questions;
--   (b) answering 'Băng keo lớn' with NVL-083 × 6 stores counted_qty = 48 and
--       one recorded result through record_tan_tao_material_count;
--   (c) replaying the same answer returns replay = true and adds no second
--       adjustment row;
--   (d) skipping another open question stores status 'skipped';
--   (e) the mission is not done while any question is still open.
-- It raises notice 'SMOKE_RESULT PASS' and rolls back. Nothing is committed.

begin;

do $smoke$
declare
  v_owner uuid;
  v_question public.stock_count_unit_questions%rowtype;
  v_skip_question public.stock_count_unit_questions%rowtype;
  v_item uuid;
  v_answer jsonb;
  v_replay jsonb;
  v_skip jsonb;
  v_skip_replay jsonb;
  v_mission uuid;
  v_eval jsonb;
  v_total integer;
  v_moves_before integer;
  v_moves_after integer;
  v_source_key text;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL: no owner role';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  -- -------------------------------------------------------------------------
  -- (a) The batch is fully seeded.
  -- -------------------------------------------------------------------------
  select count(*)::integer into v_total
  from public.stock_count_unit_questions q
  where q.batch = '2026-10-16';
  if v_total <> 12 then
    raise exception 'SMOKE_RESULT FAIL: batch 2026-10-16 has % questions, expected 12', v_total;
  end if;
  raise notice 'SMOKE: (a) 12 questions seeded';

  -- -------------------------------------------------------------------------
  -- (b) Answer 'Băng keo lớn' with NVL-083 × 6 → counted 48.
  -- -------------------------------------------------------------------------
  select * into v_question
  from public.stock_count_unit_questions q
  where q.batch = '2026-10-16'
    and q.location = 'tan_tao'
    and q.file_label = 'Băng keo lớn';
  if not found then
    raise exception 'SMOKE_RESULT FAIL: Băng keo lớn question not found';
  end if;

  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'NVL-083'
  order by kii.active desc nulls last, kii.id
  limit 1;
  if v_item is null then
    raise exception 'SMOKE_RESULT FAIL: NVL-083 item not found';
  end if;

  if v_question.status = 'open' then
    v_answer := public.answer_stock_count_unit_question(
      v_question.id, v_item, 6, null, null, false, 'smoke: Băng keo lớn'
    );

    if v_answer ->> 'status' is distinct from 'answered' then
      raise exception 'SMOKE_RESULT FAIL: (b) status=%', v_answer ->> 'status';
    end if;
    if (v_answer ->> 'counted_qty')::numeric <> 48 then
      raise exception 'SMOKE_RESULT FAIL: (b) counted_qty=%', v_answer ->> 'counted_qty';
    end if;
    if (v_answer ->> 'factor')::numeric <> 6 then
      raise exception 'SMOKE_RESULT FAIL: (b) factor=%', v_answer ->> 'factor';
    end if;
    if v_answer -> 'record_result' is null
       or v_answer -> 'record_result' ->> 'status' is distinct from 'recorded' then
      raise exception 'SMOKE_RESULT FAIL: (b) record_result=%', v_answer -> 'record_result';
    end if;
    if coalesce((v_answer ->> 'replay')::boolean, false) then
      raise exception 'SMOKE_RESULT FAIL: (b) first answer already replay';
    end if;
    raise notice 'SMOKE: (b) answered counted_qty=% record=%',
      v_answer ->> 'counted_qty', v_answer -> 'record_result' ->> 'status';
  else
    raise notice 'SMOKE: (b) Băng keo lớn already %, replay-only check', v_question.status;
  end if;

  -- -------------------------------------------------------------------------
  -- (c) Replay returns replay = true and never writes a second adjustment.
  -- -------------------------------------------------------------------------
  v_source_key := 'tt-material-count:unit-question:' || v_question.id::text;
  select count(*)::integer into v_moves_before
  from public.tan_tao_material_movements m
  where m.source_ref_key = v_source_key;

  v_replay := public.answer_stock_count_unit_question(
    v_question.id, v_item, 6, null, null, false, 'smoke: replay'
  );
  if coalesce((v_replay ->> 'replay')::boolean, false) is not true then
    raise exception 'SMOKE_RESULT FAIL: (c) replay flag missing: %', v_replay;
  end if;

  select count(*)::integer into v_moves_after
  from public.tan_tao_material_movements m
  where m.source_ref_key = v_source_key;
  if v_moves_after <> v_moves_before then
    raise exception 'SMOKE_RESULT FAIL: (c) replay wrote a second adjustment (% -> %)',
      v_moves_before, v_moves_after;
  end if;

  if v_question.status = 'open' and (v_replay ->> 'counted_qty')::numeric <> 48 then
    raise exception 'SMOKE_RESULT FAIL: (c) replay counted_qty=%', v_replay ->> 'counted_qty';
  end if;
  raise notice 'SMOKE: (c) replay ok, adjustments=%', v_moves_after;

  -- -------------------------------------------------------------------------
  -- (d) Skip another open question.
  -- -------------------------------------------------------------------------
  select * into v_skip_question
  from public.stock_count_unit_questions q
  where q.batch = '2026-10-16'
    and q.status = 'open'
    and q.id <> v_question.id
  order by q.location desc, q.sort_order
  limit 1;
  if not found then
    raise exception 'SMOKE_RESULT FAIL: (d) no open question left to skip';
  end if;

  v_skip := public.answer_stock_count_unit_question(
    v_skip_question.id, null, null, null, null, true, 'smoke: skip'
  );
  if v_skip ->> 'status' is distinct from 'skipped' then
    raise exception 'SMOKE_RESULT FAIL: (d) skip status=%', v_skip ->> 'status';
  end if;
  if coalesce((v_skip ->> 'replay')::boolean, false) then
    raise exception 'SMOKE_RESULT FAIL: (d) first skip already replay';
  end if;
  if v_skip ->> 'record_result' is not null then
    raise exception 'SMOKE_RESULT FAIL: (d) skip recorded a stock result';
  end if;

  v_skip_replay := public.answer_stock_count_unit_question(
    v_skip_question.id, null, null, null, null, true, 'smoke: skip replay'
  );
  if coalesce((v_skip_replay ->> 'replay')::boolean, false) is not true then
    raise exception 'SMOKE_RESULT FAIL: (d) skip replay flag missing';
  end if;
  raise notice 'SMOKE: (d) skipped %', v_skip_question.file_label;

  -- -------------------------------------------------------------------------
  -- (e) The mission is not done while questions stay open.
  -- -------------------------------------------------------------------------
  select m.id into v_mission
  from public.missions m
  where m.code = 'wh-count-units-20261016';
  if v_mission is null then
    raise exception 'SMOKE_RESULT FAIL: (e) mission wh-count-units-20261016 not found';
  end if;

  v_eval := public.mission_evaluate(v_mission);
  if coalesce((v_eval ->> 'done')::boolean, false) then
    raise exception 'SMOKE_RESULT FAIL: (e) mission done while questions stay open';
  end if;
  if (v_eval ->> 'left')::int <= 0 then
    raise exception 'SMOKE_RESULT FAIL: (e) left=%', v_eval ->> 'left';
  end if;
  if (v_eval ->> 'total')::int <> 12 then
    raise exception 'SMOKE_RESULT FAIL: (e) total=%', v_eval ->> 'total';
  end if;
  if v_eval -> 'detail' -> 0 ->> 'kind' is distinct from 'count_questions' then
    raise exception 'SMOKE_RESULT FAIL: (e) detail kind=%', v_eval -> 'detail' -> 0 ->> 'kind';
  end if;
  if v_eval -> 'detail' -> 0 ->> 'batch' is distinct from '2026-10-16' then
    raise exception 'SMOKE_RESULT FAIL: (e) detail batch=%', v_eval -> 'detail' -> 0 ->> 'batch';
  end if;
  if (v_eval -> 'detail' -> 0 ->> 'skipped')::int < 1 then
    raise exception 'SMOKE_RESULT FAIL: (e) skipped not counted';
  end if;
  raise notice 'SMOKE: (e) mission left=% total=% skipped=%',
    v_eval ->> 'left', v_eval ->> 'total', v_eval -> 'detail' -> 0 ->> 'skipped';

  raise notice 'SMOKE_RESULT PASS';
end;
$smoke$;

rollback;
