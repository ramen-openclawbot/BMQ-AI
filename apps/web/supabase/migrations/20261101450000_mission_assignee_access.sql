-- 2026-10-17 — Cho người được giao nhiệm vụ dùng đúng bốn bộ công cụ.
--
-- Additive migration on top of 20261101440000_tan_tao_pate_recipe_production.sql.
-- It adds:
--   1. public.mission_actor_holds(uuid, text) — người có nhiệm vụ đang mở
--      (bản gốc hoặc bản sao) đúng quy tắc chấm.
--   2. Chín RPC đọc / ghi của bốn bộ công cụ nhận thêm người được giao nhiệm vụ
--      ngoài cổng chủ sở hữu / quản trị hiện có. Mọi dòng khác giữ nguyên.
--   3. Quy tắc chấm mới 'sku_counted' và RPC ghi số đếm BMQ-001.
--   4. Nhiệm vụ chủ sở hữu 'wh-count-bmq001-20261017'.
--
-- assign_mission / unassign_mission không đổi và vẫn chỉ dành cho chủ sở hữu.
-- Không hard-code UUID / email. Không ghi đè bảng hay hàm nào khác.
--
-- This migration is additive and idempotent. The Maestro applies it; it does not
-- apply itself.

-- ===========================================================================
-- 1. Ai đang giữ một nhiệm vụ mở với quy tắc này?
-- ===========================================================================

create or replace function public.mission_actor_holds(p_actor uuid, p_check_rule text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.missions m
    where m.assignee_user_id = p_actor
      and m.status = 'open'
      and m.check_rule = p_check_rule
  );
$$;

revoke all on function public.mission_actor_holds(uuid, text) from public, anon;
grant execute on function public.mission_actor_holds(uuid, text) to authenticated, service_role;

-- ===========================================================================
-- 2. Mission rule sku_counted
-- ===========================================================================

alter table public.missions drop constraint if exists missions_check_rule_check;
alter table public.missions add constraint missions_check_rule_check check (
  check_rule in (
    'stock_alias_factor_fixed',
    'stock_duplicate_resolved',
    'stock_unknown_units_cleared',
    'material_links_done',
    'stock_count_questions_done',
    'q7_bom_mismatch_resolved',
    'tan_tao_recipe_done',
    'sku_counted'
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
  v_bom_open integer := 0;
  v_bom_excluded integer := 0;
  v_bom_resolved integer := 0;
  v_bom_total integer := 0;
  v_recipe public.tan_tao_recipes%rowtype;
  v_recipe_total integer := 0;
  v_recipe_open integer := 0;
  v_recipe_answered integer := 0;
  v_recipe_not_used integer := 0;
  v_recipe_code text;
  v_sku_code text;
  v_since date;
  v_sku_counted_at timestamptz;
  v_sku_counted_qty numeric;
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

  elsif v_mission.check_rule = 'q7_bom_mismatch_resolved' then
    v_review := public.get_q7_bom_mismatch_review();
    v_bom_total := coalesce(jsonb_array_length(v_review), 0);
    select
      count(*) filter (where (r ->> 'open')::boolean = true)::integer,
      count(*) filter (where (r ->> 'excluded')::boolean = true)::integer,
      count(*) filter (where (r ->> 'resolved')::boolean = true)::integer
    into v_bom_open, v_bom_excluded, v_bom_resolved
    from jsonb_array_elements(v_review) r;

    v_total := v_bom_total;
    v_left := coalesce(v_bom_open, 0);
    v_done := (
      v_left = 0
      and exists (
        select 1
        from public.production_material_issues pmi
        where pmi.location_code = 'q7'
          and pmi.is_current = true
          and pmi.issue_date > public.stock_ledger_cutover_date('q7')
      )
    );
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'bom_mismatch',
      'open', v_left,
      'resolved', coalesce(v_bom_resolved, 0),
      'excluded', coalesce(v_bom_excluded, 0),
      'total', v_total
    ));

  elsif v_mission.check_rule = 'tan_tao_recipe_done' then
    v_recipe_code := v_mission.check_params ->> 'code';

    select * into v_recipe
    from public.tan_tao_recipes r
    where r.code = v_recipe_code;

    if not found then
      v_total := 0;
      v_left := 0;
      v_done := false;
      v_detail := jsonb_build_array(jsonb_build_object(
        'kind', 'recipe',
        'code', v_recipe_code,
        'open', 0,
        'answered', 0,
        'not_used', 0,
        'batch_set', false
      ));
    else
      select
        count(*)::integer,
        (count(*) filter (where l.status = 'open'))::integer,
        (count(*) filter (where l.status = 'answered'))::integer,
        (count(*) filter (where l.status = 'not_used'))::integer
      into v_recipe_total, v_recipe_open, v_recipe_answered, v_recipe_not_used
      from public.tan_tao_recipe_lines l
      where l.recipe_id = v_recipe.id;

      v_done := (v_recipe.status = 'complete');
      v_total := coalesce(v_recipe_total, 0) + 1;
      v_left := case
        when v_done then 0
        else coalesce(v_recipe_open, 0)
          + case when coalesce(v_recipe.batch_output_kg, 0) > 0 then 0 else 1 end
      end;
      v_detail := jsonb_build_array(jsonb_build_object(
        'kind', 'recipe',
        'code', v_recipe.code,
        'open', coalesce(v_recipe_open, 0),
        'answered', coalesce(v_recipe_answered, 0),
        'not_used', coalesce(v_recipe_not_used, 0),
        'batch_set', coalesce(v_recipe.batch_output_kg, 0) > 0
      ));
    end if;

  elsif v_mission.check_rule = 'sku_counted' then
    v_sku_code := v_mission.check_params ->> 'sku_code';
    v_since := (v_mission.check_params ->> 'since')::date;

    select d.created_at, d.quantity
    into v_sku_counted_at, v_sku_counted_qty
    from public.tan_tao_warehouse_documents d
    where d.document_type = 'stock_count'
      and d.status = 'posted'
      and lower(btrim(d.sku_code_snapshot)) = lower(btrim(v_sku_code))
      and (d.created_at at time zone 'Asia/Ho_Chi_Minh')::date >= v_since
    order by d.created_at desc, d.id desc
    limit 1;

    v_done := found;
    v_total := 1;
    v_left := case when v_done then 0 else 1 end;
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'sku_count',
      'sku_code', v_sku_code,
      'since', v_since,
      'counted_at', v_sku_counted_at,
      'counted_qty', v_sku_counted_qty
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
-- 3. Ghi số đếm SKU qua đúng đường kiểm kê Tân Tạo
-- ===========================================================================

create or replace function public.record_mission_sku_count(
  p_mission_id uuid,
  p_counted_qty numeric,
  p_note text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_mission public.missions%rowtype;
  v_root public.missions%rowtype;
  v_owner uuid;
  v_sku_code text;
  v_note text;
  v_prev_role text;
  v_result jsonb;
begin
  select * into v_mission
  from public.missions m
  where m.id = p_mission_id;
  if not found or v_mission.check_rule <> 'sku_counted' then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if v_mission.status <> 'open' then
    raise exception 'mission_not_open' using errcode = '22023';
  end if;

  if v_mission.parent_mission_id is null then
    v_root := v_mission;
  else
    select * into v_root
    from public.missions m
    where m.id = v_mission.parent_mission_id;
    if not found then
      raise exception 'mission_not_found' using errcode = 'P0002';
    end if;
  end if;
  v_owner := v_root.assignee_user_id;

  if v_actor is null
     or not (v_actor = v_owner or v_actor = v_mission.assignee_user_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_counted_qty is null
     or p_counted_qty < 0
     or p_counted_qty::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'nonnegative_count_required' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  v_sku_code := v_mission.check_params ->> 'sku_code';
  if nullif(btrim(coalesce(v_sku_code, '')), '') is null then
    raise exception 'sku_code_required' using errcode = '22023';
  end if;

  v_note := coalesce(
    nullif(btrim(coalesce(p_note, '')), ''),
    'Nhiệm vụ đếm ' || v_sku_code
  );

  -- record_tan_tao_stock_count is itself a SECURITY DEFINER RPC that gates on
  -- can_manage_tan_tao_warehouse(). A mission assignee may not hold that
  -- inventory permission, so run just that nested call under the same service
  -- context the other SECURITY DEFINER jobs use, then restore the claim.
  -- auth.uid() is left untouched: the document keeps the real actor.
  v_prev_role := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_result := public.record_tan_tao_stock_count(
    v_sku_code,
    p_counted_qty,
    v_note,
    'mission-count:' || p_request_id::text
  );
  perform set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);

  return jsonb_build_object(
    'mission_id', v_mission.id,
    'sku_code', v_sku_code,
    'counted_qty', p_counted_qty,
    'result', v_result
  );
end;
$$;

revoke all on function public.record_mission_sku_count(uuid, numeric, text, uuid)
  from public, anon;
grant execute on function public.record_mission_sku_count(uuid, numeric, text, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 4. Bốn bộ công cụ: thêm người được giao nhiệm vụ vào cổng quyền
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 4.1. Q7 BOM — get_q7_bom_mismatch_review / resolve_q7_bom_line /
--      post_pending_q7_material_issues (q7_bom_mismatch_resolved)
-- ---------------------------------------------------------------------------

create or replace function public.get_q7_bom_mismatch_review()
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
      or public.q7_material_inventory_can_view(v_actor)
      or public.mission_actor_holds(v_actor, 'q7_bom_mismatch_resolved')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  return public.q7_bom_mismatch_review_internal();
end;
$$;

revoke all on function public.get_q7_bom_mismatch_review() from public, anon;
grant execute on function public.get_q7_bom_mismatch_review() to authenticated, service_role;

create or replace function public.resolve_q7_bom_line(
  p_canonical_material_id uuid,
  p_source_unit text,
  p_action text,
  p_target_item_id uuid,
  p_factor numeric,
  p_note text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_source_unit text;
  v_existing public.q7_bom_line_decisions%rowtype;
  v_mapping public.q7_material_issue_material_mappings%rowtype;
  v_target public.kitchen_inventory_items%rowtype;
  v_old_item uuid;
  v_new_item uuid;
  v_factor numeric;
  v_decision_id uuid;
  v_now timestamptz := now();
begin
  if v_actor is null or not (
    public.has_role(v_actor, 'owner')
    or public.mission_actor_holds(v_actor, 'q7_bom_mismatch_resolved')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  select * into v_existing
  from public.q7_bom_line_decisions d
  where d.request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'status', 'resolved',
      'replay', true,
      'decision_id', v_existing.id,
      'action', v_existing.action,
      'canonical_material_id', v_existing.canonical_material_id,
      'source_unit', v_existing.source_unit,
      'old_kitchen_item_id', v_existing.old_kitchen_item_id,
      'new_kitchen_item_id', v_existing.new_kitchen_item_id,
      'conversion_factor', v_existing.conversion_factor,
      'note', v_existing.note,
      'created_at', v_existing.created_at
    );
  end if;

  if p_canonical_material_id is null then
    raise exception 'canonical_material_required' using errcode = '22023';
  end if;
  v_source_unit := lower(btrim(coalesce(p_source_unit, '')));
  if v_source_unit = '' then
    raise exception 'source_unit_required' using errcode = '22023';
  end if;
  if p_action not in ('remap', 'not_tracked', 'bom_error') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('q7_bom_line_decision'),
    hashtext(p_canonical_material_id::text || '|' || v_source_unit)
  );

  select * into v_existing
  from public.q7_bom_line_decisions d
  where d.request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'status', 'resolved',
      'replay', true,
      'decision_id', v_existing.id,
      'action', v_existing.action,
      'canonical_material_id', v_existing.canonical_material_id,
      'source_unit', v_existing.source_unit,
      'old_kitchen_item_id', v_existing.old_kitchen_item_id,
      'new_kitchen_item_id', v_existing.new_kitchen_item_id,
      'conversion_factor', v_existing.conversion_factor,
      'note', v_existing.note,
      'created_at', v_existing.created_at
    );
  end if;

  select * into v_mapping
  from public.q7_material_issue_material_mappings m
  where m.canonical_material_id = p_canonical_material_id
    and lower(btrim(m.source_unit)) = v_source_unit
    and m.approval_status = 'approved'
  order by m.id::text
  limit 1;

  v_old_item := v_mapping.kitchen_inventory_item_id;
  v_new_item := null;
  v_factor := null;

  if p_action = 'remap' then
    if p_target_item_id is null then
      raise exception 'target_item_required' using errcode = '22023';
    end if;
    if p_factor is null
       or p_factor <= 0
       or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_conversion_factor' using errcode = '22023';
    end if;
    if v_mapping.id is null then
      raise exception 'q7_mapping_required' using errcode = '22023';
    end if;

    select * into v_target
    from public.kitchen_inventory_items k
    where k.id = p_target_item_id
      and k.active = true;
    if not found then
      raise exception 'q7_item_not_found' using errcode = 'P0002';
    end if;

    -- Only the mapping row moves. The target item keeps its own canonical
    -- link / approved mapping untouched: the BOM line mapping is authority.
    update public.q7_material_issue_material_mappings
    set kitchen_inventory_item_id = v_target.id,
        kitchen_unit = v_target.unit,
        conversion_factor = p_factor,
        notes = concat_ws(
          ' · ',
          nullif(btrim(coalesce(notes, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''),
          'Q7 BOM remap ' || v_source_unit || ' → ' || v_target.item_code
        ),
        updated_by = v_actor,
        updated_at = v_now
    where id = v_mapping.id;

    v_new_item := v_target.id;
    v_factor := p_factor;
  end if;

  update public.q7_bom_line_decisions
  set active = false
  where canonical_material_id = p_canonical_material_id
    and lower(btrim(source_unit)) = v_source_unit
    and active = true;

  insert into public.q7_bom_line_decisions(
    canonical_material_id, source_unit, action, old_kitchen_item_id,
    new_kitchen_item_id, conversion_factor, note, request_id, active,
    created_by, created_at
  ) values (
    p_canonical_material_id, v_source_unit, p_action, v_old_item,
    v_new_item, v_factor, nullif(btrim(coalesce(p_note, '')), ''), p_request_id, true,
    v_actor, v_now
  )
  returning id into v_decision_id;

  return jsonb_build_object(
    'status', 'resolved',
    'replay', false,
    'decision_id', v_decision_id,
    'action', p_action,
    'canonical_material_id', p_canonical_material_id,
    'source_unit', v_source_unit,
    'old_kitchen_item_id', v_old_item,
    'new_kitchen_item_id', v_new_item,
    'conversion_factor', v_factor,
    'note', nullif(btrim(coalesce(p_note, '')), ''),
    'created_at', v_now
  );
end;
$$;

revoke all on function public.resolve_q7_bom_line(uuid, text, text, uuid, numeric, text, uuid)
  from public, anon;
grant execute on function public.resolve_q7_bom_line(uuid, text, text, uuid, numeric, text, uuid)
  to authenticated, service_role;

create or replace function public.post_pending_q7_material_issues(p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cutover date;
  v_issue record;
  v_open_rows jsonb;
  v_generator jsonb;
  v_status text;
  v_open boolean;
  v_stale boolean;
  v_action text;
  v_final_id uuid;
  v_final_number text;
  v_final_status text;
  v_needs_pdf_ready boolean;
  v_before_count integer;
  v_after_count integer;
  v_movements integer;
  v_skipped integer;
  v_post jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_total_posted integer := 0;
  v_total_already integer := 0;
  v_total_regenerated integer := 0;
  v_total_skipped integer := 0;
begin
  -- The scheduler has no JWT; treat the cron run as the service role.
  if v_actor is null and coalesce(auth.role(), '') <> 'service_role' then
    perform set_config('request.jwt.claim.role', 'service_role', true);
  end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_role(v_actor, 'owner')
     and not public.mission_actor_holds(v_actor, 'q7_bom_mismatch_resolved') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_cutover := public.stock_ledger_cutover_date('q7');
  if v_cutover is null then
    return jsonb_build_object(
      'status', 'ok',
      'dry_run', coalesce(p_dry_run, false),
      'cutover_date', null,
      'issues', '[]'::jsonb,
      'posted', 0,
      'already_posted', 0,
      'regenerated', 0,
      'skipped_open_mismatch', 0
    );
  end if;

  v_open_rows := public.get_q7_bom_mismatch_review();

  for v_issue in
    select pmi.*
    from public.production_material_issues pmi
    where pmi.location_code = 'q7'
      and pmi.is_current = true
      and pmi.issue_date > v_cutover
      and pmi.status not in ('cancelled', 'superseded')
    order by pmi.issue_date, pmi.issue_number
  loop
    v_action := null;
    v_movements := 0;
    v_skipped := 0;
    v_generator := null;
    v_final_id := v_issue.id;
    v_final_number := v_issue.issue_number;
    v_final_status := v_issue.status;
    v_needs_pdf_ready := false;

    select exists (
      select 1
      from jsonb_array_elements(v_open_rows) r
      where (r ->> 'open')::boolean = true
        and exists (
          select 1
          from public.production_material_issue_items i
          where i.material_issue_id = v_issue.id
            and i.canonical_material_id = (r ->> 'canonical_material_id')::uuid
            and lower(btrim(i.source_unit)) = (r ->> 'source_unit')
        )
    ) into v_open;

    if v_open then
      v_action := 'skipped_open_mismatch';
    else
      select exists (
        select 1
        from public.production_material_issue_items i
        left join public.q7_material_issue_material_mappings m
          on m.canonical_material_id = i.canonical_material_id
         and lower(btrim(m.source_unit)) = lower(btrim(i.source_unit))
         and m.approval_status = 'approved'
        where i.material_issue_id = v_issue.id
          and (
            m.id is null
            or m.id is distinct from i.q7_mapping_id
            or m.kitchen_inventory_item_id is distinct from i.kitchen_inventory_item_id
            or lower(btrim(m.kitchen_unit)) is distinct from lower(btrim(i.unit))
            or m.conversion_factor is distinct from i.conversion_factor
          )
      ) into v_stale;

      if v_stale and v_issue.status <> 'posted' then
        if p_dry_run then
          v_action := 'regenerated';
        else
          v_generator := public.generate_q7_production_material_issue(
            v_issue.production_order_id,
            v_issue.issue_date
          );
          v_status := v_generator ->> 'status';
          if v_status = 'generated' then
            v_final_id := (v_generator ->> 'issue_id')::uuid;
            v_final_number := coalesce(v_generator ->> 'issue_number', v_issue.issue_number);
            v_final_status := 'generated';
            v_needs_pdf_ready := true;
            v_action := 'regenerated';
          elsif v_status like '%_unchanged' then
            v_final_id := coalesce((v_generator ->> 'issue_id')::uuid, v_issue.id);
            v_final_number := coalesce(v_generator ->> 'issue_number', v_issue.issue_number);
          else
            v_action := 'skipped_open_mismatch';
          end if;
        end if;
      end if;

      -- A regenerated revision may expose a different material set. Re-read
      -- the live review against that revision before posting anything.
      if v_action = 'regenerated' and not p_dry_run then
        v_open_rows := public.get_q7_bom_mismatch_review();
        select exists (
          select 1
          from jsonb_array_elements(v_open_rows) r
          where (r ->> 'open')::boolean = true
            and exists (
              select 1
              from public.production_material_issue_items i
              where i.material_issue_id = v_final_id
                and i.canonical_material_id = (r ->> 'canonical_material_id')::uuid
                and lower(btrim(i.source_unit)) = (r ->> 'source_unit')
            )
        ) into v_open;
        if v_open then
          v_action := 'skipped_open_mismatch';
        end if;
      end if;

      if p_dry_run then
        if v_action is distinct from 'regenerated' then
          select count(*) into v_before_count
          from public.q7_inventory_movements mv
          where mv.source = 'production_material_issue'
            and mv.source_issue_id = v_issue.id;
          v_action := case when v_before_count > 0 then 'already_posted' else 'posted' end;
        end if;
      elsif coalesce(v_action, '') <> 'skipped_open_mismatch' then
        select count(*) into v_before_count
        from public.q7_inventory_movements mv
        where mv.source = 'production_material_issue'
          and mv.source_issue_id = v_final_id;

        if v_final_status = 'generated' then
          v_needs_pdf_ready := true;
        end if;
        if v_needs_pdf_ready then
          -- Hand the regenerated / still-pending revision to the existing
          -- posting trigger. The next signed revision can still supersede it.
          update public.production_material_issues
          set status = 'pdf_ready', updated_at = now()
          where id = v_final_id
            and status = 'generated';
        end if;

        v_post := public.post_material_issue_usage(v_final_id);
        v_status := v_post ->> 'status';

        select count(*) into v_after_count
        from public.q7_inventory_movements mv
        where mv.source = 'production_material_issue'
          and mv.source_issue_id = v_final_id;

        v_movements := greatest(v_after_count - v_before_count, 0);
        v_skipped := coalesce((v_post ->> 'skipped_count')::integer, 0);

        if v_action is distinct from 'regenerated' then
          if v_status = 'before_cutover' then
            v_action := 'before_cutover';
          elsif v_movements > 0 then
            v_action := 'posted';
          elsif v_after_count > 0 then
            v_action := 'already_posted';
          else
            v_action := 'skipped_open_mismatch';
          end if;
        end if;
      end if;
    end if;

    if v_action = 'posted' then
      v_total_posted := v_total_posted + 1;
    elsif v_action = 'already_posted' then
      v_total_already := v_total_already + 1;
    elsif v_action = 'regenerated' then
      v_total_regenerated := v_total_regenerated + 1;
    elsif v_action = 'skipped_open_mismatch' then
      v_total_skipped := v_total_skipped + 1;
    end if;

    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'issue_id', v_final_id,
      'issue_number', v_final_number,
      'issue_date', v_issue.issue_date,
      'action', v_action,
      'movements', v_movements,
      'skipped', v_skipped
    ));
  end loop;

  return jsonb_build_object(
    'status', 'ok',
    'dry_run', coalesce(p_dry_run, false),
    'cutover_date', v_cutover,
    'issues', v_issues,
    'posted', v_total_posted,
    'already_posted', v_total_already,
    'regenerated', v_total_regenerated,
    'skipped_open_mismatch', v_total_skipped
  );
end;
$$;

revoke all on function public.post_pending_q7_material_issues(boolean)
  from public, anon;
grant execute on function public.post_pending_q7_material_issues(boolean)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4.2. Công thức pate Tân Tạo — get_tan_tao_recipe /
--      answer_tan_tao_recipe_line / set_tan_tao_recipe_batch
--      (tan_tao_recipe_done)
-- ---------------------------------------------------------------------------

create or replace function public.get_tan_tao_recipe(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe public.tan_tao_recipes%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_open integer := 0;
  v_answered integer := 0;
  v_not_used integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner'::public.app_role)
      or public.can_view_tan_tao_warehouse()
      or public.mission_actor_holds(v_actor, 'tan_tao_recipe_done')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_recipe
  from public.tan_tao_recipes r
  where r.code = lower(btrim(coalesce(p_code, '')));
  if not found then
    raise exception 'recipe_not_found' using errcode = 'P0002';
  end if;

  select
    (count(*) filter (where l.status = 'open'))::integer,
    (count(*) filter (where l.status = 'answered'))::integer,
    (count(*) filter (where l.status = 'not_used'))::integer
  into v_open, v_answered, v_not_used
  from public.tan_tao_recipe_lines l
  where l.recipe_id = v_recipe.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id,
           'line_kind', l.line_kind,
           'sort_order', l.sort_order,
           'label', l.label,
           'kitchen_inventory_item_id', l.kitchen_inventory_item_id,
           'item_code', i.item_code,
           'item_name', i.name,
           'item_unit', i.unit,
           'sku_code', l.sku_code,
           'grams_per_batch', l.grams_per_batch,
           'pate_grams_per_pack', l.pate_grams_per_pack,
           'pack_item_id', l.pack_item_id,
           'pack_item_code', p.item_code,
           'pack_item_name', p.name,
           'pack_item_unit', p.unit,
           'label_item_id', l.label_item_id,
           'label_item_code', lb.item_code,
           'label_item_name', lb.name,
           'label_item_unit', lb.unit,
           'status', l.status,
           'answered_by', l.answered_by,
           'answered_at', l.answered_at
         ) order by l.line_kind desc, l.sort_order, l.id), '[]'::jsonb)
  into v_lines
  from public.tan_tao_recipe_lines l
  left join public.kitchen_inventory_items i on i.id = l.kitchen_inventory_item_id
  left join public.kitchen_inventory_items p on p.id = l.pack_item_id
  left join public.kitchen_inventory_items lb on lb.id = l.label_item_id
  where l.recipe_id = v_recipe.id;

  return jsonb_build_object(
    'id', v_recipe.id,
    'code', v_recipe.code,
    'name', v_recipe.name,
    'batch_output_kg', v_recipe.batch_output_kg,
    'batch_set', coalesce(v_recipe.batch_output_kg, 0) > 0,
    'status', v_recipe.status,
    'updated_by', v_recipe.updated_by,
    'updated_at', v_recipe.updated_at,
    'line_count', v_open + v_answered + v_not_used,
    'open_count', v_open,
    'answered_count', v_answered,
    'not_used_count', v_not_used,
    'lines', v_lines,
    'can_answer', (
      coalesce(auth.role(), '') = 'service_role'
      or public.has_role(v_actor, 'owner'::public.app_role)
    )
  );
end;
$$;

revoke all on function public.get_tan_tao_recipe(text) from public, anon;
grant execute on function public.get_tan_tao_recipe(text) to authenticated, service_role;

create or replace function public.answer_tan_tao_recipe_line(
  p_line_id uuid,
  p_item_id uuid default null,
  p_grams numeric default null,
  p_not_used boolean default false,
  p_pack_item_id uuid default null,
  p_label_item_id uuid default null,
  p_pate_grams numeric default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line public.tan_tao_recipe_lines%rowtype;
  v_recipe public.tan_tao_recipes%rowtype;
  v_item public.kitchen_inventory_items%rowtype;
  v_answered_by uuid;
  v_answered_at timestamptz;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner'::public.app_role)
      or public.mission_actor_holds(v_actor, 'tan_tao_recipe_done')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_line
  from public.tan_tao_recipe_lines l
  where l.id = p_line_id
  for update;
  if not found then
    raise exception 'recipe_line_not_found' using errcode = 'P0002';
  end if;

  select * into v_recipe
  from public.tan_tao_recipes r
  where r.id = v_line.recipe_id
  for update;

  v_answered_by := coalesce(v_line.answered_by, v_actor);
  v_answered_at := coalesce(v_line.answered_at, now());

  if v_line.line_kind = 'ingredient' then
    if coalesce(p_not_used, false) then
      update public.tan_tao_recipe_lines l
      set status = 'not_used',
          kitchen_inventory_item_id = null,
          grams_per_batch = null,
          answered_by = v_answered_by,
          answered_at = v_answered_at
      where l.id = v_line.id;
    else
      if p_item_id is null then
        raise exception 'ingredient_item_required' using errcode = '22023';
      end if;
      select * into v_item
      from public.kitchen_inventory_items kii
      where kii.id = p_item_id
        and kii.active = true
        and kii.merged_into_id is null;
      if not found then
        raise exception 'ingredient_item_not_found' using errcode = 'P0002';
      end if;
      if p_grams is null or p_grams <= 0
         or p_grams::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'invalid_grams_per_batch' using errcode = '22023';
      end if;

      update public.tan_tao_recipe_lines l
      set status = 'answered',
          kitchen_inventory_item_id = p_item_id,
          grams_per_batch = p_grams,
          answered_by = v_answered_by,
          answered_at = v_answered_at
      where l.id = v_line.id;
    end if;

  elsif v_line.line_kind = 'pack' then
    if coalesce(p_not_used, false) then
      raise exception 'not_used_not_allowed_for_pack' using errcode = '22023';
    end if;
    if p_pack_item_id is null then
      raise exception 'pack_item_required' using errcode = '22023';
    end if;
    select * into v_item
    from public.kitchen_inventory_items kii
    where kii.id = p_pack_item_id
      and kii.active = true
      and kii.merged_into_id is null;
    if not found then
      raise exception 'pack_item_not_found' using errcode = 'P0002';
    end if;
    if p_label_item_id is not null then
      select * into v_item
      from public.kitchen_inventory_items kii
      where kii.id = p_label_item_id
        and kii.active = true
        and kii.merged_into_id is null;
      if not found then
        raise exception 'label_item_not_found' using errcode = 'P0002';
      end if;
    end if;
    if p_pate_grams is null or p_pate_grams <= 0
       or p_pate_grams::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_pate_grams_per_pack' using errcode = '22023';
    end if;

    update public.tan_tao_recipe_lines l
    set status = 'answered',
        pack_item_id = p_pack_item_id,
        label_item_id = p_label_item_id,
        pate_grams_per_pack = p_pate_grams,
        answered_by = v_answered_by,
        answered_at = v_answered_at
    where l.id = v_line.id;

  else
    raise exception 'unsupported_recipe_line_kind' using errcode = '22023';
  end if;

  perform public.tan_tao_recipe_refresh_status(v_line.recipe_id);
  v_result := public.get_tan_tao_recipe(v_recipe.code)
    || jsonb_build_object('answered_line_id', v_line.id);
  return v_result;
end;
$$;

revoke all on function public.answer_tan_tao_recipe_line(uuid, uuid, numeric, boolean, uuid, uuid, numeric, uuid)
  from public, anon;
grant execute on function public.answer_tan_tao_recipe_line(uuid, uuid, numeric, boolean, uuid, uuid, numeric, uuid)
  to authenticated, service_role;

create or replace function public.set_tan_tao_recipe_batch(
  p_code text,
  p_batch_output_kg numeric,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe public.tan_tao_recipes%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner'::public.app_role)
      or public.mission_actor_holds(v_actor, 'tan_tao_recipe_done')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_batch_output_kg is null or p_batch_output_kg < 0
     or p_batch_output_kg::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_batch_output_kg' using errcode = '22023';
  end if;

  select * into v_recipe
  from public.tan_tao_recipes r
  where r.code = lower(btrim(coalesce(p_code, '')))
  for update;
  if not found then
    raise exception 'recipe_not_found' using errcode = 'P0002';
  end if;

  update public.tan_tao_recipes r
  set batch_output_kg = p_batch_output_kg,
      updated_by = v_actor,
      updated_at = now()
  where r.id = v_recipe.id;

  perform public.tan_tao_recipe_refresh_status(v_recipe.id);
  return public.get_tan_tao_recipe(v_recipe.code);
end;
$$;

revoke all on function public.set_tan_tao_recipe_batch(text, numeric, uuid) from public, anon;
grant execute on function public.set_tan_tao_recipe_batch(text, numeric, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4.3. Câu hỏi đơn vị kiểm kê — get_stock_count_unit_questions /
--      answer_stock_count_unit_question (stock_count_questions_done)
-- ---------------------------------------------------------------------------

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
      or public.mission_actor_holds(v_actor, 'stock_count_questions_done')
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
      or public.mission_actor_holds(v_actor, 'stock_count_questions_done')
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
-- 5. Gieo nhiệm vụ đếm BMQ-001 cho chủ sở hữu
-- ===========================================================================

do $seed_wh_count_bmq001_mission$
declare
  v_owner uuid;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  if v_owner is null then
    raise notice 'wh count bmq001 mission seed skipped: no owner role';
    return;
  end if;

  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, status, created_by
  ) values (
    'wh-count-bmq001-20261017',
    'warehouse',
    'Đếm bánh mì que Tân Tạo',
    'Đếm số que BMQ-001 đang có ở kho Tân Tạo và nhập vào',
    v_owner,
    'sku_counted',
    jsonb_build_object(
      'location', 'tan_tao',
      'sku_code', 'BMQ-001',
      'since', '2026-10-17'
    ),
    'cham_chi',
    9,
    'open',
    v_owner
  )
  on conflict (code) do nothing;
end;
$seed_wh_count_bmq001_mission$;
