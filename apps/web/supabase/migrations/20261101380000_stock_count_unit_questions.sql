-- Nhiệm vụ game: quy đổi đơn vị cho 12 dòng tồn kho 16/10 (data layer only).
--
-- The 16/10 stock file lists 12 lines whose unit is ambiguous. This migration:
--   A. adds public.stock_count_unit_questions (one seeded question per line);
--   B. seeds batch '2026-10-16' with the suggested catalog item / known factor;
--   C. adds the answer RPC that replays the existing record_q7_stock_count /
--      record_tan_tao_material_count writers exactly once per question;
--   D. adds the read RPC that returns the batch with its suggested / chosen item;
--   E. extends mission_evaluate with the 'stock_count_questions_done' rule;
--   F. seeds one owner mission for the batch.
--
-- It never writes the append-only stock ledgers directly: the answer RPC only
-- delegates to the existing, idempotent per-item count RPCs.
--
-- This migration is additive and idempotent. The Maestro applies it; it does not
-- apply itself.

-- ===========================================================================
-- A. Questions table
-- ===========================================================================

create table if not exists public.stock_count_unit_questions (
  id uuid primary key default gen_random_uuid(),
  batch text not null,
  location text not null check (location in ('q7', 'tan_tao')),
  sort_order integer not null,
  file_label text not null,
  file_qty numeric not null check (file_qty >= 0),
  file_unit text not null,
  suggested_item_id uuid references public.kitchen_inventory_items(id),
  suggested_factor numeric,
  status text not null default 'open' check (status in ('open', 'answered', 'skipped')),
  item_id uuid references public.kitchen_inventory_items(id),
  factor numeric,
  counted_qty numeric,
  record_result jsonb,
  note text,
  answered_by uuid,
  answered_at timestamptz,
  constraint stock_count_unit_questions_batch_location_label_key
    unique (batch, location, file_label)
);

alter table public.stock_count_unit_questions enable row level security;

revoke all on table public.stock_count_unit_questions from public, anon, authenticated;
grant select on table public.stock_count_unit_questions to authenticated;
grant all on table public.stock_count_unit_questions to service_role;

drop policy if exists stock_count_unit_questions_select on public.stock_count_unit_questions;
create policy stock_count_unit_questions_select on public.stock_count_unit_questions
  for select to authenticated
  using (
    public.material_alias_can_admin((select auth.uid()))
    or public.has_role((select auth.uid()), 'owner')
  );

-- ===========================================================================
-- B. Seed batch '2026-10-16'
-- ===========================================================================

insert into public.stock_count_unit_questions (
  batch, location, sort_order, file_label, file_qty, file_unit,
  suggested_item_id, suggested_factor
)
select
  '2026-10-16',
  seed.location,
  seed.sort_order,
  seed.file_label,
  seed.file_qty,
  seed.file_unit,
  (
    select kii.id
    from public.kitchen_inventory_items kii
    where kii.item_code = seed.item_code
    order by kii.active desc nulls last, kii.id
    limit 1
  ),
  seed.suggested_factor
from (values
  ('q7', 1, 'Nước uống Bidrico', 3::numeric, 'bình', 'Q7-EE8D4E85B686C8A318AA', null::numeric),
  ('q7', 2, 'Bột sữa nguyên chất', 4.5::numeric, 'kg', 'NVL-014', null::numeric),
  ('q7', 3, 'Mật ong', 1::numeric, 'lít', 'NVL-030', null::numeric),
  ('q7', 4, 'Tem pháp', 79::numeric, 'tờ', 'CCDC-038', null::numeric),
  ('q7', 5, 'Tem 17k', 48::numeric, 'tờ', 'NVL-082', null::numeric),
  ('tan_tao', 6, 'Muối', 24.9::numeric, 'kg', null::text, null::numeric),
  ('tan_tao', 7, 'Băng keo lớn', 8::numeric, 'cây', 'NVL-083', 6::numeric),
  ('tan_tao', 8, 'Băng keo nhỏ', 4::numeric, 'cây', 'CCDC-008', null::numeric),
  ('tan_tao', 9, 'Giấy bạc', 1::numeric, 'cây', 'NVL-091', 5000::numeric),
  ('tan_tao', 10, 'Giấy thấm dầu', 7::numeric, 'sấp', 'CCDC-017', null::numeric),
  ('tan_tao', 11, 'Nước rửa chén', 2::numeric, 'bình', 'Q7-99937EABA6F1CCAFE425', 3800::numeric),
  ('tan_tao', 12, 'Bao giấy', 8500::numeric, 'cái', 'NVL-104', 1::numeric)
) as seed(location, sort_order, file_label, file_qty, file_unit, item_code, suggested_factor)
on conflict (batch, location, file_label) do nothing;

-- ===========================================================================
-- C. Question JSON + read RPC
-- ===========================================================================

create or replace function public.stock_count_unit_question_json(
  p_question public.stock_count_unit_questions
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', q.id,
    'batch', q.batch,
    'location', q.location,
    'sort_order', q.sort_order,
    'file_label', q.file_label,
    'file_qty', q.file_qty,
    'file_unit', q.file_unit,
    'suggested_item_id', q.suggested_item_id,
    'suggested_factor', q.suggested_factor,
    'status', q.status,
    'item_id', q.item_id,
    'factor', q.factor,
    'counted_qty', q.counted_qty,
    'record_result', q.record_result,
    'note', q.note,
    'answered_by', q.answered_by,
    'answered_at', q.answered_at,
    'suggested_item', case
      when s.id is null then null
      else jsonb_build_object(
        'id', s.id,
        'code', s.item_code,
        'name', s.name,
        'unit', s.unit
      )
    end,
    'chosen_item', case
      when c.id is null then null
      else jsonb_build_object(
        'id', c.id,
        'code', c.item_code,
        'name', c.name,
        'unit', c.unit
      )
    end,
    'item_units', coalesce((
      select jsonb_agg(
               jsonb_build_object('code', u.code, 'label', u.label)
               order by u.kind, u.to_base, u.code
             )
      from public.stock_units u
    ), '[]'::jsonb)
  )
  from public.stock_count_unit_questions q
  left join public.kitchen_inventory_items s on s.id = q.suggested_item_id
  left join public.kitchen_inventory_items c on c.id = q.item_id
  where q.id = p_question.id;
$$;

revoke all on function public.stock_count_unit_question_json(public.stock_count_unit_questions)
  from public, anon, authenticated;
grant execute on function public.stock_count_unit_question_json(public.stock_count_unit_questions)
  to service_role;

create or replace function public.get_stock_count_unit_questions(p_batch text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.material_alias_can_admin(v_actor)
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  return coalesce((
    select jsonb_agg(
             public.stock_count_unit_question_json(q)
             order by q.location desc, q.sort_order
           )
    from public.stock_count_unit_questions q
    where q.batch = p_batch
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_stock_count_unit_questions(text) from public, anon;
grant execute on function public.get_stock_count_unit_questions(text) to authenticated, service_role;

-- ===========================================================================
-- D. Answer RPC
-- ===========================================================================

create or replace function public.answer_stock_count_unit_question(
  p_question_id uuid,
  p_item_id uuid,
  p_factor numeric,
  p_new_item_name text,
  p_new_item_unit text,
  p_skip boolean,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_question public.stock_count_unit_questions%rowtype;
  v_item public.kitchen_inventory_items%rowtype;
  v_item_id uuid;
  v_material_id uuid;
  v_link jsonb;
  v_created jsonb;
  v_counted numeric;
  v_record jsonb;
  v_note text;
  v_new_name text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.material_alias_can_admin(v_actor)
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_question
  from public.stock_count_unit_questions
  where id = p_question_id
  for update;
  if not found then
    raise exception 'question_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent replay: an answered / skipped question is returned exactly as
  -- stored and never reaches the stock ledger again.
  if v_question.status <> 'open' then
    return public.stock_count_unit_question_json(v_question)
      || jsonb_build_object('replay', true);
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  if coalesce(p_skip, false) then
    update public.stock_count_unit_questions
    set status = 'skipped',
        note = v_note,
        answered_by = v_actor,
        answered_at = now()
    where id = v_question.id
    returning * into v_question;

    return public.stock_count_unit_question_json(v_question)
      || jsonb_build_object('replay', false);
  end if;

  if p_factor is null
     or p_factor <= 0
     or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'factor_required' using errcode = '22023';
  end if;

  v_new_name := nullif(btrim(coalesce(p_new_item_name, '')), '');
  if p_item_id is null and v_new_name is null then
    raise exception 'item_or_new_item_required' using errcode = '22023';
  end if;
  if p_item_id is not null and v_new_name is not null then
    raise exception 'item_or_new_item_required' using errcode = '22023';
  end if;

  if p_item_id is not null then
    select * into v_item
    from public.kitchen_inventory_items
    where id = p_item_id
      and active = true
      and merged_into_id is null;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;
    v_item_id := v_item.id;
  else
    v_created := public.create_stock_material_item(
      v_new_name, p_new_item_unit, v_question.location, gen_random_uuid()
    );
    v_item_id := (v_created ->> 'item_id')::uuid;
    select * into v_item
    from public.kitchen_inventory_items
    where id = v_item_id;
  end if;

  v_counted := round(v_question.file_qty * p_factor, 3);

  if v_question.location = 'q7' then
    if v_item.canonical_material_id is null then
      select m.id into v_material_id
      from public.sku_cogs_materials m
      where m.active = true
        and m.normalized_name = public.material_master_normalize(v_item.name)
      order by m.created_at, m.id
      limit 1;

      v_link := public.link_q7_item_material(
        v_item.id,
        v_material_id,
        v_material_id is null,
        gen_random_uuid(),
        null
      );
      v_material_id := (v_link ->> 'material_id')::uuid;

      select * into v_item
      from public.kitchen_inventory_items
      where id = v_item.id;
    else
      v_material_id := v_item.canonical_material_id;
    end if;

    -- The 2026-10-16 bootstrap approved a 1:1 mapping between the canonical
    -- material and the Q7 ledger identity. Keep that invariant for the question.
    if v_material_id is not null and not exists (
      select 1
      from public.q7_material_issue_material_mappings m
      where m.canonical_material_id = v_material_id
        and m.source_unit = v_item.unit
        and m.approval_status = 'approved'
    ) then
      insert into public.q7_material_issue_material_mappings (
        canonical_material_id,
        source_unit,
        kitchen_inventory_item_id,
        kitchen_unit,
        conversion_factor,
        approval_status,
        approved_by,
        approved_at,
        notes,
        created_by,
        updated_by
      ) values (
        v_material_id,
        v_item.unit,
        v_item.id,
        v_item.unit,
        1,
        'approved',
        v_actor,
        now(),
        'Nhiệm vụ quy đổi tồn 16/10',
        v_actor,
        v_actor
      )
      on conflict (canonical_material_id, source_unit) do nothing;
    end if;

    v_record := public.record_q7_stock_count(
      v_item.id,
      v_counted,
      date '2026-10-16',
      v_note,
      'unit-question:' || v_question.id::text
    );
  else
    v_record := public.record_tan_tao_material_count(
      v_item.id,
      v_counted,
      date '2026-10-16',
      v_note,
      'unit-question:' || v_question.id::text
    );
  end if;

  update public.stock_count_unit_questions
  set status = 'answered',
      item_id = v_item.id,
      factor = p_factor,
      counted_qty = v_counted,
      record_result = v_record,
      note = v_note,
      answered_by = v_actor,
      answered_at = now()
  where id = v_question.id
  returning * into v_question;

  return public.stock_count_unit_question_json(v_question)
    || jsonb_build_object('replay', false);
end;
$$;

revoke all on function public.answer_stock_count_unit_question(
  uuid, uuid, numeric, text, text, boolean, text
) from public, anon;
grant execute on function public.answer_stock_count_unit_question(
  uuid, uuid, numeric, text, text, boolean, text
) to authenticated, service_role;

-- ===========================================================================
-- E. mission_evaluate — add the stock_count_questions_done rule
--    (every existing branch is copied unchanged)
-- ===========================================================================

alter table public.missions drop constraint if exists missions_check_rule_check;
alter table public.missions add constraint missions_check_rule_check check (
  check_rule in (
    'stock_alias_factor_fixed',
    'stock_duplicate_resolved',
    'stock_unknown_units_cleared',
    'material_links_done',
    'stock_count_questions_done'
  )
);

create or replace function public.mission_evaluate(p_mission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mission public.missions%rowtype;
  v_done boolean := false;
  v_total integer := 0;
  v_left integer := 0;
  v_detail jsonb := '[]'::jsonb;
  v_alias_id uuid;
  v_bad_factor numeric;
  v_bad_item uuid;
  v_alias public.stock_material_aliases%rowtype;
  v_alias_found boolean;
  v_item_name text;
  v_item_unit text;
  v_fixed boolean;
  v_rows jsonb;
  v_index integer;
  v_active integer;
  v_name_changed boolean;
  v_pair boolean;
  v_a uuid;
  v_b uuid;
  v_row public.kitchen_inventory_items%rowtype;
  v_days integer;
  v_initial integer;
  v_groups integer;
  v_ignored integer;
  v_location text;
  v_review jsonb;
  v_counts jsonb;
  v_linked integer;
  v_batch text;
  v_question_total integer := 0;
  v_question_open integer := 0;
  v_question_answered integer := 0;
  v_question_skipped integer := 0;
begin
  select * into v_mission from public.missions where id = p_mission_id;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if v_mission.check_rule = 'stock_alias_factor_fixed' then
    v_rows := coalesce(v_mission.check_params -> 'aliases', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_alias_id := (v_rows -> v_index ->> 'id')::uuid;
      v_bad_factor := (v_rows -> v_index ->> 'bad_factor')::numeric;
      v_bad_item := (v_rows -> v_index ->> 'bad_item_id')::uuid;

      select * into v_alias from public.stock_material_aliases a where a.id = v_alias_id;
      v_alias_found := found;

      if not v_alias_found then
        v_fixed := true;
        v_item_name := null;
        v_item_unit := null;
      else
        select k.name, k.unit into v_item_name, v_item_unit
        from public.kitchen_inventory_items k
        where k.id = v_alias.kitchen_inventory_item_id;

        v_fixed := (v_alias.conversion_factor is distinct from v_bad_factor)
          or (v_alias.kitchen_inventory_item_id is distinct from v_bad_item);
      end if;

      if not v_fixed then
        v_left := v_left + 1;
      end if;

      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'id', v_alias_id,
        'name', case when v_alias_found then v_alias.normalized_name else null end,
        'unit', case when v_alias_found then v_alias.unit else null end,
        'factor', case when v_alias_found then v_alias.conversion_factor else null end,
        'item_name', v_item_name,
        'item_unit', v_item_unit,
        'fixed', v_fixed
      ));
    end loop;
    v_done := (v_left = 0);

  elsif v_mission.check_rule = 'stock_duplicate_resolved' then
    v_rows := coalesce(v_mission.check_params -> 'items', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    v_active := 0;
    v_name_changed := false;
    v_pair := false;

    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_a := (v_rows -> v_index ->> 'id')::uuid;
      select * into v_row from public.kitchen_inventory_items k where k.id = v_a;
      if not found then
        v_name_changed := true;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_a,
          'code', null,
          'name', null,
          'unit', null,
          'active', false,
          'on_hand', 0,
          'alias_count', 0
        ));
      else
        if coalesce(v_row.active, false) then
          v_active := v_active + 1;
        end if;
        if v_row.name is distinct from (v_rows -> v_index ->> 'name') then
          v_name_changed := true;
        end if;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_row.id,
          'code', v_row.item_code,
          'name', v_row.name,
          'unit', v_row.unit,
          'active', coalesce(v_row.active, false),
          'on_hand', coalesce((
            select sum(case m.movement_type
                         when 'receipt' then m.quantity
                         when 'production_usage' then -m.quantity
                         when 'adjustment' then m.quantity
                         else 0 end)
            from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = v_row.id
          ), 0),
          'alias_count', (
            select count(*)
            from public.stock_material_aliases a
            where a.kitchen_inventory_item_id = v_row.id
          )
        ));
      end if;
    end loop;

    if v_total = 2 then
      v_a := (v_rows -> 0 ->> 'id')::uuid;
      v_b := (v_rows -> 1 ->> 'id')::uuid;
      select exists (
        select 1 from public.stock_item_distinct_pairs p
        where p.item_a = least(v_a, v_b)
          and p.item_b = greatest(v_a, v_b)
      ) into v_pair;
    end if;

    v_done := (v_active < 2) or v_name_changed or v_pair;
    v_left := case when v_done then 0 else 1 end;

  elsif v_mission.check_rule = 'stock_unknown_units_cleared' then
    v_days := coalesce((v_mission.check_params ->> 'days')::integer, 60);
    v_initial := coalesce((v_mission.check_params ->> 'initial')::integer, 0);
    v_total := v_initial;

    select count(distinct lower(btrim(r.unit)))::integer into v_groups
    from public.stock_unknown_purchase_unit_rows(v_days) r;

    select count(*)::integer into v_ignored
    from public.stock_unit_ignored_variants g
    where exists (
      select 1
      from public.stock_unknown_purchase_unit_rows(v_days) r
      where g.variant = lower(btrim(r.unit))
    );

    v_left := greatest(coalesce(v_groups, 0) - coalesce(v_ignored, 0), 0);
    v_done := (v_left = 0);

    select coalesce(jsonb_agg(jsonb_build_object(
             'unit', r.unit,
             'line_count', r.line_count,
             'example_name', r.example_name,
             'source_table', r.source_table
           ) order by r.line_count desc, r.unit asc, r.source_table asc), '[]'::jsonb)
    into v_detail
    from public.stock_unknown_purchase_unit_rows(v_days) r;

  elsif v_mission.check_rule = 'material_links_done' then
    v_location := v_mission.check_params ->> 'location';
    v_counts := public.material_link_counts_internal(v_location);
    v_left := coalesce((v_counts ->> 'total')::int, 0);
    v_linked := coalesce((v_counts ->> 'linked_total')::int, 0);
    v_total := v_left + v_linked;
    v_done := (v_left = 0 and v_total > 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'location', v_location,
      'remaining', v_left,
      'linked', v_linked,
      'exact', coalesce((v_counts ->> 'exact')::int, 0),
      'skipped', coalesce((v_counts ->> 'skipped')::int, 0)
    ));

  elsif v_mission.check_rule = 'stock_count_questions_done' then
    v_batch := v_mission.check_params ->> 'batch';

    select
      count(*)::integer,
      (count(*) filter (where q.status = 'open'))::integer,
      (count(*) filter (where q.status = 'answered'))::integer,
      (count(*) filter (where q.status = 'skipped'))::integer
    into v_question_total, v_question_open, v_question_answered, v_question_skipped
    from public.stock_count_unit_questions q
    where q.batch = v_batch;

    v_total := coalesce(v_question_total, 0);
    v_left := coalesce(v_question_open, 0);
    v_done := (v_total > 0 and v_left = 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'count_questions',
      'batch', v_batch,
      'total', v_total,
      'open', v_left,
      'answered', coalesce(v_question_answered, 0),
      'skipped', coalesce(v_question_skipped, 0)
    ));

  else
    raise exception 'unknown_check_rule' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'done', v_done,
    'total', v_total,
    'left', v_left,
    'detail', v_detail
  );
end;
$$;

revoke all on function public.mission_evaluate(uuid) from public, anon, authenticated;
grant execute on function public.mission_evaluate(uuid) to service_role;

-- ===========================================================================
-- F. Seed one owner mission for the batch
-- ===========================================================================

do $seed_count_unit_mission$
declare
  v_owner uuid;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  if v_owner is null then
    raise notice 'count unit mission seed skipped: no owner role';
    return;
  end if;

  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, status, created_by
  ) values (
    'wh-count-units-20261016',
    'warehouse',
    'Quy đổi tồn 16/10',
    'Trả lời 12 dòng tồn kho chưa rõ đơn vị trong file 16/10',
    v_owner,
    'stock_count_questions_done',
    jsonb_build_object('batch', '2026-10-16'),
    'cham_chi',
    6,
    'open',
    v_owner
  )
  on conflict (code) do nothing;
end;
$seed_count_unit_mission$;
