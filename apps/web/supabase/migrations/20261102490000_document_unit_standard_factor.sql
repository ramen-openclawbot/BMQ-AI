-- 2026-10-21 — đơn vị chuẩn thay hệ số game cũ (owner 21/10).
--
-- A. document_unit_to_material_factor(): a weight/volume pair that the shared
--    stock_units table can convert (kg -> g, l -> ml, ...) wins BEFORE any
--    material_unit_conversions row.  A stale game factor can no longer hide it.
-- B. document_unit_factor_candidates(): in the alias loop, after the item ->
--    material step, q7_unit_factor(document unit, item unit) > 0 always takes
--    the standard path.  The pack label's game conversion_factor is ignored even
--    when pack_match is true.  The approved_conversion fallback also prefers the
--    standard table when the document unit converts to the material unit.
-- C. The existing stock_material_aliases trigger is deliberately not redefined:
--    it derives its value from document_unit_factor_candidates() and writes that
--    candidate.  With B fixed, a standard-convertible pack label can only yield
--    standard_auto / misread_standard, so the trigger cannot write or reopen an
--    alias factor for it.
-- D. Repair the live conversion rows whose factor disagrees with the standard
--    table: retire the bad row first (the approved-overlap trigger), then insert
--    one approved standard row unless a correct active approved row exists.
-- E. For the open 2026-10-20 document-unit questions, recompute the candidate
--    list.  A single remaining factor is answered through the same code path as
--    the owner RPC; otherwise only the candidates column is refreshed.
--
-- No document line row, no stock_material_aliases row and no answered/skipped
-- question is touched.  No DELETE.  The Maestro applies this migration.

-- ===========================================================================
-- A. Standard factor wins before a stored game conversion
-- ===========================================================================

create or replace function public.document_unit_to_material_factor(
  p_material_id uuid,
  p_from_unit text
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_material public.sku_cogs_materials%rowtype;
  v_from text := lower(btrim(coalesce(p_from_unit, '')));
  v_to text;
  v_factor numeric;
begin
  if v_from = '' then
    return null;
  end if;

  select * into v_material
  from public.sku_cogs_materials m
  where m.id = p_material_id
    and m.active = true;
  if not found then
    return null;
  end if;

  v_to := lower(btrim(coalesce(v_material.default_unit, '')));
  if v_to = '' then
    return null;
  end if;
  if v_from = v_to then
    return 1;
  end if;

  -- The shared standard table is the owner-approved truth.  Check it before the
  -- game conversion rows so a stale alias factor cannot shadow kg/l/ml.
  v_factor := public.q7_unit_factor(p_from_unit, v_material.default_unit);
  if v_factor is not null and v_factor > 0 then
    return round(v_factor, 6);
  end if;

  select c.factor into v_factor
  from public.material_unit_conversions c
  where c.material_id = p_material_id
    and c.active = true
    and c.approved = true
    and lower(btrim(c.from_unit)) = v_from
    and lower(btrim(c.to_unit)) = v_to
    and c.effective_from <= current_date
    and (c.effective_to is null or c.effective_to >= current_date)
  order by c.effective_from desc, c.created_at desc, c.id
  limit 1;

  if v_factor is not null and v_factor > 0 then
    return round(v_factor, 6);
  end if;

  return null;
end;
$$;

revoke all on function public.document_unit_to_material_factor(uuid, text) from public, anon;
grant execute on function public.document_unit_to_material_factor(uuid, text) to service_role;

-- ===========================================================================
-- B. Standard candidate wins over the game alias factor
-- ===========================================================================

create or replace function public.document_unit_factor_candidates(
  p_material_id uuid,
  p_doc_unit text,
  p_supplier_id uuid,
  p_normalized_name text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc text := public.normalize_document_unit(p_doc_unit);
  v_raw text := lower(btrim(coalesce(p_doc_unit, '')));
  v_material public.sku_cogs_materials%rowtype;
  v_out jsonb := '[]'::jsonb;
  v_factor numeric;
  v_step numeric;
  v_std numeric;
  v_source text;
  v_sources jsonb;
  v_seen numeric[] := '{}'::numeric[];
  v_approved numeric;
  r record;
begin
  if v_doc is null then
    return '[]'::jsonb;
  end if;

  select * into v_material
  from public.sku_cogs_materials m
  where m.id = p_material_id
    and m.active = true;
  if not found then
    return '[]'::jsonb;
  end if;

  for r in
    select
      a.id,
      a.conversion_factor,
      a.pack_label,
      kii.unit as item_unit,
      (a.pack_label is not null
       and public.normalize_document_unit(a.pack_label) = v_doc) as pack_match
    from public.stock_material_aliases a
    join public.kitchen_inventory_items kii on kii.id = a.kitchen_inventory_item_id
    where a.line_class = 'stock'
      and a.kitchen_inventory_item_id is not null
      and kii.canonical_material_id = p_material_id
      and (p_normalized_name is null or a.normalized_name = p_normalized_name)
    order by
      (a.pack_label is not null and public.normalize_document_unit(a.pack_label) = v_doc) desc,
      (a.supplier_id is not distinct from p_supplier_id) desc,
      a.id
  loop
    v_step := public.document_unit_to_material_factor(p_material_id, r.item_unit);
    if v_step is null then
      continue;
    end if;

    v_std := public.q7_unit_factor(v_doc, r.item_unit);
    if v_std is not null and v_std > 0 then
      -- A standard-convertible pack label never uses the game conversion_factor,
      -- even when the pack label itself matched.
      v_factor := round(v_std * v_step, 6);
      if v_raw is distinct from v_doc then
        v_source := 'misread_standard';
      else
        v_source := 'standard_auto';
      end if;
      v_sources := jsonb_build_array(v_source);
    elsif r.pack_match then
      v_factor := round(r.conversion_factor * v_step, 6);
      v_source := 'game_alias_factor';
      v_sources := jsonb_build_array('game_alias_factor');
    else
      v_factor := public.q7_unit_factor(v_doc, r.item_unit);
      if v_factor is null then
        continue;
      end if;
      v_factor := round(v_factor * v_step, 6);
      if v_raw is distinct from v_doc then
        v_source := 'misread_standard';
      else
        v_source := 'standard_auto';
      end if;
      v_sources := jsonb_build_array(v_source);
    end if;

    if v_factor is null
       or v_factor <= 0
       or v_factor::text in ('NaN', 'Infinity', '-Infinity') then
      continue;
    end if;

    if not (v_factor = any (v_seen)) then
      v_seen := array_append(v_seen, v_factor);

      -- A pack factor that still needs the item -> material step is shown as
      -- "game + đổi chuẩn" to the owner.
      if v_step <> 1 and v_source = 'game_alias_factor' then
        v_sources := jsonb_build_array('game_alias_factor', 'standard_auto');
      end if;

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'factor', v_factor,
        'source', v_source,
        'alias_id', r.id,
        'sources', v_sources
      ));
    end if;
  end loop;

  -- When no label yields a factor, a standard document -> material pair is the
  -- only defensible value, ahead of an approved conversion row.
  if jsonb_array_length(v_out) = 0 then
    v_std := public.q7_unit_factor(v_doc, v_material.default_unit);
    if v_std is not null and v_std > 0 then
      v_out := jsonb_build_array(jsonb_build_object(
        'factor', round(v_std, 6),
        'source', 'standard_auto',
        'alias_id', null,
        'sources', jsonb_build_array('standard_auto')
      ));
    else
      select c.factor into v_approved
      from public.material_unit_conversions c
      where c.material_id = p_material_id
        and c.active = true
        and c.approved = true
        and lower(btrim(c.from_unit)) = v_doc
        and lower(btrim(c.to_unit)) = lower(btrim(v_material.default_unit))
        and c.effective_from <= current_date
        and (c.effective_to is null or c.effective_to >= current_date)
      order by c.effective_from desc, c.created_at desc, c.id
      limit 1;

      if v_approved is not null then
        v_out := jsonb_build_array(jsonb_build_object(
          'factor', round(v_approved, 6),
          'source', 'approved_conversion',
          'alias_id', null,
          'sources', jsonb_build_array('approved_conversion')
        ));
      end if;
    end if;
  end if;

  return v_out;
end;
$$;

revoke all on function public.document_unit_factor_candidates(uuid, text, uuid, text) from public, anon;
grant execute on function public.document_unit_factor_candidates(uuid, text, uuid, text) to service_role;

-- ===========================================================================
-- C. Trigger note
-- ===========================================================================
--
-- public.trg_stock_material_alias_document_unit_factor() is intentionally left
-- as-is.  It never invents a factor: it calls document_unit_factor_candidates()
-- and writes that candidate.  After section B, a standard-convertible pack label
-- returns only standard_auto / misread_standard, so the trigger cannot write or reopen an alias factor
-- for such a label.  It can only write an alias factor for a label that the
-- shared standard table cannot convert at all.

-- ===========================================================================
-- D. Repair the 15 wrong live game factors
-- ===========================================================================

do $document_unit_standard_factor_repair$
declare
  v_row record;
  v_owner uuid;
  v_fixed integer := 0;
  v_inserted integer := 0;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  for v_row in
    select
      c.*,
      public.q7_unit_factor(c.from_unit, c.to_unit) as standard_factor
    from public.material_unit_conversions c
    where c.active = true
      and public.q7_unit_factor(c.from_unit, c.to_unit) is not null
      and c.factor <> round(public.q7_unit_factor(c.from_unit, c.to_unit), 6)
    order by c.material_id, c.id
    for update
  loop
    -- Retire first: the approved-overlap trigger rejects two live approved rows.
    update public.material_unit_conversions
    set active = false,
        effective_to = coalesce(effective_to, current_date),
        updated_at = now()
    where id = v_row.id;
    v_fixed := v_fixed + 1;

    if not exists (
      select 1
      from public.material_unit_conversions c2
      where c2.material_id = v_row.material_id
        and lower(btrim(c2.from_unit)) = lower(btrim(v_row.from_unit))
        and lower(btrim(c2.to_unit)) = lower(btrim(v_row.to_unit))
        and c2.active = true
        and c2.approved = true
        and c2.factor = round(v_row.standard_factor, 6)
        and c2.effective_from <= current_date
        and (c2.effective_to is null or c2.effective_to >= current_date)
    ) then
      if v_owner is null then
        raise notice 'document_unit_standard_factor: no owner, corrected row skipped for %', v_row.id;
      else
        insert into public.material_unit_conversions (
          material_id, from_unit, to_unit, factor, effective_from, effective_to,
          source_type, source_id, approved, approved_by, approved_at, active,
          metadata, created_by
        ) values (
          v_row.material_id, v_row.from_unit, v_row.to_unit,
          round(v_row.standard_factor, 6), current_date, null,
          'standard_auto', v_row.source_id, true, v_owner, now(), true,
          jsonb_build_object(
            'note', 'Sửa 21/10: đơn vị chuẩn thay hệ số game cũ',
            'factor_source', 'standard_auto',
            'repaired_conversion_id', v_row.id
          ),
          v_owner
        );
        v_inserted := v_inserted + 1;
      end if;
    end if;
  end loop;

  raise notice 'document_unit_standard_factor: deactivated %, inserted %', v_fixed, v_inserted;
end;
$document_unit_standard_factor_repair$;

-- ===========================================================================
-- E. Answer / refresh the open 2026-10-20 questions
-- ===========================================================================

-- The owner RPC needs auth.uid(); the migration DO block does not have one.
-- Extract the persisted answer flow into one internal helper used by both, so
-- the RPC keeps exactly the same behaviour and the batch block can answer as an
-- owner.
create or replace function public.document_unit_answer_internal(
  p_id uuid,
  p_action text,
  p_factor numeric,
  p_actual_unit text,
  p_reason text,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_approved_by uuid;
  v_question public.document_unit_questions%rowtype;
  v_action text;
  v_factor numeric;
  v_actual text;
  v_froms text[] := array[]::text[];
  v_from text;
  v_pair record;
  v_reason text;
begin
  select * into v_question
  from public.document_unit_questions q
  where q.id = p_id
  for update;
  if not found then
    raise exception 'question_not_found' using errcode = 'P0002';
  end if;

  if v_question.status <> 'open' then
    return public.document_unit_question_json(v_question)
      || jsonb_build_object('replay', true);
  end if;

  v_action := lower(btrim(coalesce(p_action, '')));
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  if v_action = 'skip' then
    update public.document_unit_questions
    set status = 'skipped',
        action = 'skip',
        factor = null,
        actual_unit = null,
        reason = v_reason,
        answered_by = p_actor,
        answered_at = now()
    where id = v_question.id
    returning * into v_question;

    return public.document_unit_question_json(v_question)
      || jsonb_build_object('replay', false);
  end if;

  v_approved_by := coalesce(
    p_actor,
    (
      select ur.user_id
      from public.user_roles ur
      where ur.role::text = 'owner'
      order by ur.created_at, ur.user_id
      limit 1
    )
  );
  if v_approved_by is null then
    raise exception 'owner_required' using errcode = '42501';
  end if;

  if v_action = 'factor' then
    if p_factor is null
       or p_factor <= 0
       or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'factor_required' using errcode = '22023';
    end if;
    v_factor := round(p_factor, 6);
    v_actual := null;
    v_froms := array[v_question.doc_unit, v_question.doc_unit_normalized];
  elsif v_action = 'misread' then
    v_actual := public.normalize_document_unit(p_actual_unit);
    if v_actual is null then
      raise exception 'actual_unit_required' using errcode = '22023';
    end if;

    v_factor := public.q7_unit_factor(v_actual, v_question.default_unit);
    if v_factor is null then
      if p_factor is null
         or p_factor <= 0
         or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'factor_required' using errcode = '22023';
      end if;
      v_factor := round(p_factor, 6);
    else
      v_factor := round(v_factor, 6);
    end if;

    v_froms := array[v_question.doc_unit, v_question.doc_unit_normalized, v_actual];
  else
    raise exception 'action_invalid' using errcode = '22023';
  end if;

  select array_agg(x) into v_froms
  from (
    select distinct on (lower(btrim(u))) btrim(u) as x
    from unnest(v_froms) u
    where nullif(btrim(u), '') is not null
    order by lower(btrim(u)), btrim(u)
  ) d;

  foreach v_from in array coalesce(v_froms, array[]::text[]) loop
    -- The old pair is retired first so the unique approved index stays valid.
    update public.material_unit_conversions c
    set active = false,
        effective_to = coalesce(c.effective_to, greatest(c.effective_from, current_date)),
        updated_at = now()
    where c.material_id = v_question.material_id
      and c.active = true
      and c.approved = true
      and lower(btrim(c.from_unit)) = lower(v_from)
      and lower(btrim(c.to_unit)) = lower(btrim(v_question.default_unit));

    insert into public.material_unit_conversions (
      material_id, from_unit, to_unit, factor, effective_from, effective_to,
      source_type, source_id, approved, approved_by, approved_at, active,
      metadata, created_by
    ) values (
      v_question.material_id, v_from, v_question.default_unit, v_factor,
      current_date, null,
      'document_unit_question', v_question.id, true, v_approved_by, now(), true,
      jsonb_build_object(
        'factor_source', 'owner_factor_doc',
        'question_id', v_question.id,
        'action', v_action,
        'reason', coalesce(v_reason, 'Trả lời câu hỏi đơn vị chứng từ')
      ),
      p_actor
    );
  end loop;

  for v_pair in
    select distinct p.supplier_id, p.normalized_name
    from public.document_unit_mismatch_pairs_internal() p
    where p.material_id = v_question.material_id
      and p.doc_unit_normalized = v_question.doc_unit_normalized
  loop
    perform public.link_documents_from_stock_aliases(
      v_pair.supplier_id,
      v_pair.normalized_name,
      false
    );
  end loop;

  update public.document_unit_questions
  set status = 'answered',
      action = v_action,
      factor = v_factor,
      actual_unit = v_actual,
      reason = v_reason,
      answered_by = p_actor,
      answered_at = now()
  where id = v_question.id
  returning * into v_question;

  return public.document_unit_question_json(v_question)
    || jsonb_build_object('replay', false);
end;
$$;

revoke all on function public.document_unit_answer_internal(uuid, text, numeric, text, text, uuid) from public, anon;
grant execute on function public.document_unit_answer_internal(uuid, text, numeric, text, text, uuid) to service_role;

create or replace function public.answer_document_unit_question(
  p_id uuid,
  p_action text,
  p_factor numeric,
  p_actual_unit text,
  p_reason text
)
returns jsonb
language plpgsql
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
    if not public.has_role(v_actor, 'owner') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  return public.document_unit_answer_internal(
    p_id, p_action, p_factor, p_actual_unit, p_reason, v_actor
  );
end;
$$;

revoke all on function public.answer_document_unit_question(uuid, text, numeric, text, text) from public, anon;
grant execute on function public.answer_document_unit_question(uuid, text, numeric, text, text) to authenticated, service_role;

do $document_unit_standard_factor_questions$
declare
  v_question record;
  v_pair record;
  v_owner uuid;
  v_raw jsonb;
  v_candidates jsonb;
  v_factor numeric;
  v_processed integer := 0;
  v_answered integer := 0;
  v_refreshed integer := 0;
  v_claims text := current_setting('request.jwt.claims', true);
begin
  -- link_documents_from_stock_aliases() only runs for service_role or a signed-in
  -- owner; a migration has neither, so act as service_role for this block only.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  for v_question in
    select q.*
    from public.document_unit_questions q
    where q.batch = '2026-10-20'
      and q.status = 'open'
    order by q.id
    for update
  loop
    v_raw := '[]'::jsonb;

    for v_pair in
      select p.supplier_id, p.normalized_name, p.doc_unit
      from public.document_unit_mismatch_pairs_internal() p
      where p.material_id = v_question.material_id
        and p.doc_unit_normalized = v_question.doc_unit_normalized
    loop
      v_raw := v_raw || public.document_unit_factor_candidates(
        v_question.material_id,
        v_pair.doc_unit,
        v_pair.supplier_id,
        v_pair.normalized_name
      );
    end loop;

    -- Same one-value-per-factor rule as seed_document_unit_conversions().
    select coalesce(jsonb_agg(c order by (c ->> 'factor')::numeric), '[]'::jsonb)
    into v_candidates
    from (
      select distinct on ((c ->> 'factor')::numeric) c
      from jsonb_array_elements(v_raw) c
      order by (c ->> 'factor')::numeric,
        case c ->> 'source'
          when 'game_alias_factor' then 0
          when 'misread_standard' then 1
          when 'standard_auto' then 2
          when 'approved_conversion' then 3
          else 4
        end
    ) s;

    v_processed := v_processed + 1;

    if jsonb_array_length(v_candidates) = 1 then
      if v_owner is null then
        raise notice 'document_unit_standard_factor: no owner, question % left open', v_question.id;
      else
        v_factor := (v_candidates -> 0 ->> 'factor')::numeric;
        perform public.document_unit_answer_internal(
          v_question.id,
          'factor',
          v_factor,
          null,
          'Đổi chuẩn tự động 21/10',
          v_owner
        );
        v_answered := v_answered + 1;
      end if;
    else
      update public.document_unit_questions
      set candidates = v_candidates
      where id = v_question.id
        and status = 'open';
      v_refreshed := v_refreshed + 1;
    end if;
  end loop;

  raise notice 'document_unit_standard_factor: questions %, answered %, refreshed %',
    v_processed, v_answered, v_refreshed;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end;
$document_unit_standard_factor_questions$;
