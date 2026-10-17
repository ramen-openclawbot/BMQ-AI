-- 2026-10-17 — Khớp công thức Q7 với món kho đã kiểm kê, rồi trừ NVL từ 17/10.
--
-- Additive migration on top of 20261101390000 and 20261101400000. It adds:
--   1. public.q7_bom_line_decisions — append-only owner decision log.
--   2. post_material_issue_usage — cutover guard uses <=, excludes decisions /
--      non_stock items and reports how many item lines it skipped.
--   3. public.get_q7_bom_mismatch_review() — open BOM lines with candidates.
--   4. public.resolve_q7_bom_line(...) — owner remap / exclude decision.
--   5. public.post_pending_q7_material_issues(...) — catch-up + daily cron.
--   6. mission_evaluate rule q7_bom_mismatch_resolved and its owner mission.
--
-- No existing stock count is touched. Nothing is posted for issue_date <= cutover.

-- ===========================================================================
-- 1. Decision log (append-only; one active row per material + source unit)
-- ===========================================================================

create table if not exists public.q7_bom_line_decisions (
  id uuid primary key default gen_random_uuid(),
  canonical_material_id uuid not null references public.sku_cogs_materials(id) on delete restrict,
  source_unit text not null,
  action text not null check (action in ('remap', 'not_tracked', 'bom_error')),
  old_kitchen_item_id uuid references public.kitchen_inventory_items(id) on delete restrict,
  new_kitchen_item_id uuid references public.kitchen_inventory_items(id) on delete restrict,
  conversion_factor numeric,
  note text,
  request_id uuid not null unique,
  active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint q7_bom_line_decisions_source_unit_check check (btrim(source_unit) <> ''),
  constraint q7_bom_line_decisions_remap_check check (
    action <> 'remap'
    or (
      new_kitchen_item_id is not null
      and conversion_factor is not null
      and conversion_factor > 0
      and conversion_factor::text not in ('NaN', 'Infinity', '-Infinity')
    )
  )
);

create unique index if not exists q7_bom_line_decisions_one_active_uidx
  on public.q7_bom_line_decisions(canonical_material_id, lower(btrim(source_unit)))
  where active = true;

create index if not exists idx_q7_bom_line_decisions_material
  on public.q7_bom_line_decisions(canonical_material_id, created_at desc);

alter table public.q7_bom_line_decisions enable row level security;

drop policy if exists q7_bom_line_decisions_select on public.q7_bom_line_decisions;
create policy q7_bom_line_decisions_select
  on public.q7_bom_line_decisions for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.q7_material_inventory_can_view((select auth.uid()))
  );

revoke all on table public.q7_bom_line_decisions from public, anon, authenticated;
grant select on table public.q7_bom_line_decisions to authenticated;
grant all on table public.q7_bom_line_decisions to service_role;

-- ===========================================================================
-- 2. Cutover guard (<=) and exclusion-aware posting
-- ===========================================================================

create or replace function public.post_material_issue_usage(p_issue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue public.production_material_issues%rowtype;
  v_cutover date;
  v_row record;
  v_inserted integer := 0;
  v_row_count integer := 0;
  v_skipped integer := 0;
  v_excluded boolean := false;
begin
  select * into v_issue from public.production_material_issues where id = p_issue_id;
  if not found then
    return jsonb_build_object('status', 'issue_not_found');
  end if;
  if v_issue.location_code is distinct from 'q7' then
    return jsonb_build_object('status', 'unsupported_location');
  end if;
  if v_issue.is_current is not true then
    return jsonb_build_object('status', 'not_current');
  end if;
  if v_issue.status not in ('pdf_ready', 'posted') then
    return jsonb_build_object('status', 'not_postable');
  end if;

  v_cutover := public.stock_ledger_cutover_date('q7');
  -- The count date itself is the truth: issue_date = cutover is NOT posted.
  if v_cutover is null or v_issue.issue_date <= v_cutover then
    return jsonb_build_object(
      'status', 'before_cutover',
      'issue_id', p_issue_id,
      'movement_count', 0,
      'skipped_count', 0
    );
  end if;

  for v_row in
    select i.id as item_id,
           i.kitchen_inventory_item_id,
           i.unit,
           i.required_qty,
           i.q7_mapping_id,
           i.canonical_material_id,
           i.source_unit,
           kii.item_class
    from public.production_material_issue_items i
    left join public.kitchen_inventory_items kii on kii.id = i.kitchen_inventory_item_id
    where i.material_issue_id = p_issue_id
      and i.kitchen_inventory_item_id is not null
      and coalesce(i.required_qty, 0) > 0
      and i.required_qty::text not in ('NaN', 'Infinity', '-Infinity')
      and exists (
        select 1
        from public.q7_material_issue_material_mappings m
        where m.approval_status = 'approved'
          and (
            m.id = i.q7_mapping_id
            or (
              i.q7_mapping_id is null
              and i.canonical_material_id is not null
              and m.canonical_material_id = i.canonical_material_id
            )
          )
      )
  loop
    select exists (
      select 1
      from public.q7_bom_line_decisions d
      where d.active = true
        and d.action in ('not_tracked', 'bom_error')
        and d.canonical_material_id = v_row.canonical_material_id
        and lower(btrim(d.source_unit)) = lower(btrim(coalesce(v_row.source_unit, '')))
    ) into v_excluded;

    if v_excluded or coalesce(v_row.item_class, '') = 'non_stock' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Write the issue item's own canonical_material_id / q7_mapping_id instead
    -- of calling resolve_q7_canonical_inventory_item(). A resolved remap can
    -- leave the target kitchen item linked to another material or holding its
    -- own approved mapping; the resolver would then refuse the pair with
    -- q7_mapping_identity_mismatch. The approved mapping row for this BOM line
    -- is the authority for where this material's usage goes, so post it
    -- directly with the ids carried by the issue item.
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, source_issue_id, source_issue_item_id,
      q7_mapping_id, canonical_material_id, note, created_by
    ) values (
      v_row.kitchen_inventory_item_id, v_issue.issue_date, 'production_usage', v_row.required_qty,
      v_row.unit, 'production_material_issue', 'pmi-item:' || v_row.item_id::text,
      v_issue.id, v_row.item_id, v_row.q7_mapping_id, v_row.canonical_material_id,
      'Xuất NVL cho sản xuất ' || v_issue.issue_number, auth.uid()
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
    get diagnostics v_row_count = row_count;
    v_inserted := v_inserted + v_row_count;
  end loop;

  return jsonb_build_object(
    'status', 'posted',
    'issue_id', p_issue_id,
    'movement_count', v_inserted,
    'skipped_count', v_skipped
  );
end;
$$;

-- ===========================================================================
-- 3. Review: every open BOM line for current Q7 issues after cutover
-- ===========================================================================

create or replace function public.q7_bom_mismatch_review_internal()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutover date;
  v_group record;
  v_rows jsonb := '[]'::jsonb;
  v_has_count boolean;
  v_balance numeric;
  v_unposted numeric;
  v_projected numeric;
  v_open boolean;
  v_excluded boolean;
  v_resolved boolean;
  v_candidates jsonb;
  v_decision jsonb;
begin
  v_cutover := public.stock_ledger_cutover_date('q7');
  if v_cutover is null then
    return '[]'::jsonb;
  end if;

  for v_group in
    with scoped as (
      select pi.issue_date,
             i.canonical_material_id,
             lower(btrim(i.source_unit)) as source_unit,
             coalesce(i.required_qty, 0)::numeric as required_qty,
             i.id as item_id
      from public.production_material_issue_items i
      join public.production_material_issues pi on pi.id = i.material_issue_id
      where pi.location_code = 'q7'
        and pi.is_current = true
        and pi.issue_date > v_cutover
        and pi.status not in ('cancelled', 'needs_review')
        and i.canonical_material_id is not null
        and i.source_unit is not null
        and btrim(i.source_unit) <> ''
    ),
    day_totals as (
      select canonical_material_id, source_unit, issue_date, sum(required_qty) as planned_qty
      from scoped
      group by canonical_material_id, source_unit, issue_date
    ),
    grouped as (
      select canonical_material_id,
             source_unit,
             sum(planned_qty) as planned_qty_total,
             max(issue_date) as latest_issue_date,
             jsonb_agg(
               jsonb_build_object('issue_date', issue_date, 'planned_qty', round(planned_qty, 3))
               order by issue_date
             ) as planned_by_date
      from day_totals
      group by canonical_material_id, source_unit
    )
    select g.*,
           scm.material_code,
           scm.canonical_name,
           scm.default_unit as canonical_default_unit,
           m.id as mapping_id,
           m.kitchen_inventory_item_id,
           m.kitchen_unit,
           m.conversion_factor,
           kii.item_code,
           kii.name as kitchen_name,
           kii.unit as kitchen_item_unit,
           kii.item_class,
           d.id as decision_id,
           d.action as decision_action,
           d.new_kitchen_item_id as decision_new_item_id,
           d.conversion_factor as decision_factor,
           d.note as decision_note,
           d.created_at as decision_created_at
    from grouped g
    join public.sku_cogs_materials scm on scm.id = g.canonical_material_id
    left join public.q7_material_issue_material_mappings m
      on m.canonical_material_id = g.canonical_material_id
     and lower(btrim(m.source_unit)) = g.source_unit
     and m.approval_status = 'approved'
    left join public.kitchen_inventory_items kii on kii.id = m.kitchen_inventory_item_id
    left join public.q7_bom_line_decisions d
      on d.canonical_material_id = g.canonical_material_id
     and lower(btrim(d.source_unit)) = g.source_unit
     and d.active = true
    order by scm.material_code, g.source_unit
  loop
    v_has_count := false;
    v_balance := 0;
    v_unposted := 0;
    v_candidates := '[]'::jsonb;
    v_decision := null;
    v_excluded := false;
    v_resolved := false;

    if v_group.decision_id is not null then
      v_decision := jsonb_build_object(
        'id', v_group.decision_id,
        'action', v_group.decision_action,
        'new_kitchen_item_id', v_group.decision_new_item_id,
        'conversion_factor', v_group.decision_factor,
        'note', v_group.decision_note,
        'created_at', v_group.decision_created_at
      );
      v_excluded := v_group.decision_action in ('not_tracked', 'bom_error');
      v_resolved := not v_excluded;
    end if;

    if v_group.kitchen_inventory_item_id is not null then
      select exists (
        select 1
        from public.q7_inventory_movements mv
        where mv.kitchen_inventory_item_id = v_group.kitchen_inventory_item_id
          and mv.source = 'manual_adjustment'
          and mv.movement_date >= v_cutover
        union all
        select 1
        from public.stock_count_lines l
        join public.stock_count_sessions s on s.id = l.session_id
        where s.location = 'q7'
          and s.status = 'submitted'
          and l.target_kind = 'item'
          and l.target_id = v_group.kitchen_inventory_item_id
          and l.counted_qty is not null
          and s.count_date >= v_cutover
      ) into v_has_count;

      select s.balance_qty into v_balance
      from public.get_q7_inventory_snapshot(v_group.latest_issue_date) s
      where s.kitchen_inventory_item_id = v_group.kitchen_inventory_item_id;
      v_balance := coalesce(v_balance, 0);

      -- Only planned usage that is not already posted can still push the
      -- balance negative; already-posted usage is already inside the balance.
      select coalesce(sum(coalesce(i.required_qty, 0)), 0) into v_unposted
      from public.production_material_issue_items i
      join public.production_material_issues pi on pi.id = i.material_issue_id
      where i.canonical_material_id = v_group.canonical_material_id
        and lower(btrim(i.source_unit)) = v_group.source_unit
        and pi.location_code = 'q7'
        and pi.is_current = true
        and pi.issue_date > v_cutover
        and pi.status not in ('cancelled', 'needs_review')
        and not exists (
          select 1
          from public.q7_inventory_movements mv2
          where mv2.source = 'production_material_issue'
            and mv2.source_issue_item_id = i.id
        );

    end if;

      select coalesce(jsonb_agg(jsonb_build_object(
               'kitchen_inventory_item_id', c.id,
               'item_code', c.item_code,
               'name', c.name,
               'unit', c.unit,
               'counted_balance', c.counted_balance,
               'similarity', c.score
             ) order by c.score desc, c.name), '[]'::jsonb)
      into v_candidates
      from (
        select kii2.id,
               kii2.item_code,
               kii2.name,
               kii2.unit,
               coalesce((
                 select l2.counted_qty
                 from public.stock_count_lines l2
                 join public.stock_count_sessions s2 on s2.id = l2.session_id
                 where s2.location = 'q7'
                   and s2.status = 'submitted'
                   and l2.target_kind = 'item'
                   and l2.target_id = kii2.id
                   and l2.counted_qty is not null
                   and s2.count_date >= v_cutover
                 order by s2.count_date desc, l2.counted_at desc nulls last
                 limit 1
               ), (
                 select s3.balance_qty
                 from public.get_q7_inventory_snapshot(v_group.latest_issue_date) s3
                 where s3.kitchen_inventory_item_id = kii2.id
               ), 0) as counted_balance,
               coalesce(public.q7_material_name_similarity(kii2.name, v_group.canonical_name), 0) as score
        from public.kitchen_inventory_items kii2
        where kii2.active = true
          and (
            exists (
              select 1
              from public.q7_inventory_movements mv3
              where mv3.kitchen_inventory_item_id = kii2.id
                and mv3.source = 'manual_adjustment'
                and mv3.movement_date >= v_cutover
            )
            or exists (
              select 1
              from public.stock_count_lines l3
              join public.stock_count_sessions s4 on s4.id = l3.session_id
              where s4.location = 'q7'
                and s4.status = 'submitted'
                and l3.target_kind = 'item'
                and l3.target_id = kii2.id
                and l3.counted_qty is not null
                and s4.count_date >= v_cutover
            )
          )
        order by score desc, kii2.name
        limit 5
      ) c;
    v_projected := round(v_balance - v_unposted, 3);
    v_open := v_group.decision_id is null and (
      v_group.mapping_id is null
      or v_group.kitchen_inventory_item_id is null
      or coalesce(v_group.item_class, '') = 'non_stock'
      or not v_has_count
      or v_projected < 0
    );

    if v_open or v_group.decision_id is not null then
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'canonical_material_id', v_group.canonical_material_id,
        'canonical_material', jsonb_build_object(
          'id', v_group.canonical_material_id,
          'code', v_group.material_code,
          'name', v_group.canonical_name,
          'default_unit', v_group.canonical_default_unit
        ),
        'source_unit', v_group.source_unit,
        'current_mapping', case when v_group.mapping_id is null then null else jsonb_build_object(
          'q7_mapping_id', v_group.mapping_id,
          'kitchen_inventory_item_id', v_group.kitchen_inventory_item_id,
          'item_code', v_group.item_code,
          'name', v_group.kitchen_name,
          'unit', v_group.kitchen_item_unit,
          'conversion_factor', v_group.conversion_factor
        ) end,
        'planned_qty_total', round(v_group.planned_qty_total, 3),
        'planned_by_issue_date', v_group.planned_by_date,
        'latest_issue_date', v_group.latest_issue_date,
        'current_balance', round(v_balance, 3),
        'projected_balance', v_projected,
        'has_count_since_cutover', v_has_count,
        'item_class', v_group.item_class,
        'open', v_open,
        'resolved', v_resolved,
        'excluded', v_excluded,
        'decision', v_decision,
        'candidates', v_candidates
      ));
    end if;
  end loop;

  return v_rows;
end;
$$;

revoke all on function public.q7_bom_mismatch_review_internal() from public, anon, authenticated, service_role;

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
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  return public.q7_bom_mismatch_review_internal();
end;
$$;

revoke all on function public.get_q7_bom_mismatch_review() from public, anon;
grant execute on function public.get_q7_bom_mismatch_review() to authenticated, service_role;

-- ===========================================================================
-- 4. Resolve one open BOM line (owner only, replay-safe, never deletes)
-- ===========================================================================

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
  if v_actor is null or not public.has_role(v_actor, 'owner') then
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

-- ===========================================================================
-- 5. Catch-up: regenerate stale issues, then post every pending issue once
-- ===========================================================================

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
     and not public.has_role(v_actor, 'owner') then
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

-- ===========================================================================
-- 6. Mission rule q7_bom_mismatch_resolved (older branches copied unchanged)
-- ===========================================================================

alter table public.missions drop constraint if exists missions_check_rule_check;
alter table public.missions add constraint missions_check_rule_check check (
  check_rule in (
    'stock_alias_factor_fixed',
    'stock_duplicate_resolved',
    'stock_unknown_units_cleared',
    'material_links_done',
    'stock_count_questions_done',
    'q7_bom_mismatch_resolved'
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
-- 7. Daily catch-up schedule (22:40 UTC = 05:40 Asia/Ho_Chi_Minh)
-- ===========================================================================

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'q7-post-pending-material-issues'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'q7-post-pending-material-issues',
    '40 22 * * *',
    $job$ select public.post_pending_q7_material_issues(false); $job$
  );
end;
$$;

-- ===========================================================================
-- 8. Seed the owner mission (same area / badge style as the warehouse set)
-- ===========================================================================

do $seed_q7_bom_match_mission$
declare
  v_owner uuid;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  if v_owner is null then
    raise notice 'q7 bom match mission seed skipped: no owner role';
    return;
  end if;

  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, status, created_by
  ) values (
    'wh-q7-bom-match-20261017',
    'warehouse',
    'Khớp công thức Q7 với kho',
    'Trỏ từng nguyên liệu công thức vào đúng món kho đã kiểm kê để trừ NVL từ 17/10',
    v_owner,
    'q7_bom_mismatch_resolved',
    '{}'::jsonb,
    'cham_chi',
    7,
    'open',
    v_owner
  )
  on conflict (code) do nothing;
end;
$seed_q7_bom_match_mission$;
