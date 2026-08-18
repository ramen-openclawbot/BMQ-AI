-- Task 8 linked rollback-only runtime smoke for Q7 canonical controller.
-- Execute with: supabase db query --linked -f apps/web/scripts/material_master/q7_canonical_controller_rollback_smoke.sql
-- This file applies the Task8 migration inside BEGIN, exercises exact RPC signatures,
-- asserts fail-closed canonical/mapping behavior, then ROLLBACKs and returns residue evidence.

begin;

create or replace function pg_temp.assert_sqlstate(p_name text, p_sql text, p_expected text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
  raise exception 'expected % for %', p_expected, p_name;
exception when others then
  if sqlstate <> p_expected then
    raise exception 'unexpected SQLSTATE for %, got %, expected %, message %', p_name, sqlstate, p_expected, sqlerrm;
  end if;
end;
$$;

create or replace function pg_temp.assert_error(p_name text, p_sql text, p_expected text, p_message text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
  raise exception 'expected %/% for %', p_expected, p_message, p_name;
exception when others then
  if sqlstate <> p_expected or sqlerrm <> p_message then
    raise exception 'unexpected error for %, got % %, expected % %', p_name, sqlstate, sqlerrm, p_expected, p_message;
  end if;
end;
$$;

create temp table task8_counts_before as
select
  (select count(*) from public.kitchen_inventory_movements) as kitchen_inventory_movements,
  (select count(*) from public.q7_inventory_movements) as q7_inventory_movements,
  (select count(*) from public.q7_inventory_openings) as q7_inventory_openings,
  (select count(*) from public.q7_inventory_opening_audit_logs) as q7_inventory_opening_audit_logs;

-- Task 8: canonical Q7 controller slice.
-- Additive migration only: canonical picker/read model plus fail-closed
-- canonical resolver for manual Q7 receipt/opening writes. No historical backfill,
-- no kitchen_inventory_movements DML, and Q7 location/unit rows remain independent.

alter table public.kitchen_inventory_items
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  add column if not exists material_resolution_status text;

alter table public.q7_inventory_movements
  add column if not exists q7_mapping_id uuid references public.q7_material_issue_material_mappings(id) on delete restrict,
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict;

alter table public.q7_inventory_openings
  add column if not exists q7_mapping_id uuid references public.q7_material_issue_material_mappings(id) on delete restrict,
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict;

alter table public.q7_inventory_opening_audit_logs
  add column if not exists q7_mapping_id uuid references public.q7_material_issue_material_mappings(id) on delete restrict,
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict;

create index if not exists idx_q7_inventory_movements_canonical
  on public.q7_inventory_movements(canonical_material_id, kitchen_inventory_item_id, movement_date);

create index if not exists idx_q7_inventory_openings_canonical
  on public.q7_inventory_openings(canonical_material_id, kitchen_inventory_item_id, effective_date);

create or replace function public.resolve_q7_canonical_inventory_item(
  p_kitchen_inventory_item_id uuid,
  p_unit text
)
returns table (
  kitchen_inventory_item_id uuid,
  unit text,
  q7_mapping_id uuid,
  canonical_material_id uuid,
  material_code text,
  canonical_name text,
  canonical_default_unit text,
  source_unit text,
  conversion_factor numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_exact_mapping_count integer := 0;
  v_mapping record;
  v_related_mapping_count integer := 0;
begin
  if p_kitchen_inventory_item_id is null then
    raise exception 'q7_item_not_found' using errcode = 'P0002';
  end if;
  if p_unit is null or btrim(p_unit) = '' then
    raise exception 'unit_required' using errcode = '22023';
  end if;

  select
    kii.id,
    kii.unit,
    kii.canonical_material_id,
    kii.material_resolution_status,
    scm.id as active_canonical_material_id,
    scm.material_code,
    scm.canonical_name,
    scm.default_unit as canonical_default_unit
  into v_item
  from public.kitchen_inventory_items kii
  left join public.sku_cogs_materials scm
    on scm.id = kii.canonical_material_id
   and scm.active = true
  where kii.id = p_kitchen_inventory_item_id
    and kii.active = true;

  if not found then
    raise exception 'q7_item_not_found' using errcode = 'P0002';
  end if;

  if lower(btrim(v_item.unit)) is distinct from lower(btrim(p_unit)) then
    raise exception 'unit_mismatch' using errcode = '22023';
  end if;

  if v_item.canonical_material_id is null
     or v_item.material_resolution_status is distinct from 'linked'
     or v_item.active_canonical_material_id is null then
    raise exception 'q7_canonical_link_required' using errcode = '22023';
  end if;

  select count(*) into v_exact_mapping_count
  from public.q7_material_issue_material_mappings m
  where m.approval_status = 'approved'
    and m.canonical_material_id is not distinct from v_item.canonical_material_id
    and m.kitchen_inventory_item_id is not distinct from v_item.id
    and lower(btrim(m.kitchen_unit)) is not distinct from lower(btrim(v_item.unit));

  if v_exact_mapping_count <> 1 then
    select count(*) into v_related_mapping_count
    from public.q7_material_issue_material_mappings m
    where m.approval_status = 'approved'
      and (
        m.kitchen_inventory_item_id is not distinct from v_item.id
        or m.canonical_material_id is not distinct from v_item.canonical_material_id
      );

    if v_related_mapping_count = 0 then
      raise exception 'q7_mapping_required' using errcode = '22023';
    end if;

    raise exception 'q7_mapping_identity_mismatch' using errcode = '22023';
  end if;

  select m.id, m.source_unit, m.conversion_factor
  into v_mapping
  from public.q7_material_issue_material_mappings m
  where m.approval_status = 'approved'
    and m.canonical_material_id is not distinct from v_item.canonical_material_id
    and m.kitchen_inventory_item_id is not distinct from v_item.id
    and lower(btrim(m.kitchen_unit)) is not distinct from lower(btrim(v_item.unit))
  order by m.id::text
  limit 1;

  return query select
    v_item.id::uuid,
    v_item.unit::text,
    v_mapping.id::uuid,
    v_item.canonical_material_id::uuid,
    v_item.material_code::text,
    v_item.canonical_name::text,
    v_item.canonical_default_unit::text,
    v_mapping.source_unit::text,
    v_mapping.conversion_factor::numeric;
end;
$$;

create or replace function public.get_q7_inventory_picker()
returns table (
  kitchen_inventory_item_id uuid,
  item_name text,
  unit text,
  q7_mapping_id uuid,
  canonical_material_id uuid,
  material_code text,
  canonical_name text,
  canonical_default_unit text,
  location_unit text,
  source_unit text,
  conversion_factor numeric,
  display_label text,
  active boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor_id) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  end if;

  return query
  with approved_picker as (
    select
      kii.id as kitchen_inventory_item_id,
      kii.name as item_name,
      kii.unit,
      m.id as q7_mapping_id,
      scm.id as canonical_material_id,
      scm.material_code,
      scm.canonical_name,
      scm.default_unit as canonical_default_unit,
      kii.unit as location_unit,
      m.source_unit,
      m.conversion_factor,
      scm.material_code || ' · ' || scm.canonical_name || ' · ' || kii.unit as display_label,
      true as active,
      count(*) over (
        partition by m.canonical_material_id, m.kitchen_inventory_item_id, lower(btrim(m.kitchen_unit))
      ) as approved_mapping_count
    from public.q7_material_issue_material_mappings m
    join public.kitchen_inventory_items kii
      on kii.id = m.kitchen_inventory_item_id
     and kii.active = true
     and kii.material_resolution_status = 'linked'
     and kii.canonical_material_id is not null
     and lower(btrim(m.kitchen_unit)) is not distinct from lower(btrim(kii.unit))
    join public.sku_cogs_materials scm
      on scm.id = kii.canonical_material_id
     and scm.id = m.canonical_material_id
     and scm.active = true
    where m.approval_status = 'approved'
  )
  select
    p.kitchen_inventory_item_id, p.item_name, p.unit, p.q7_mapping_id,
    p.canonical_material_id, p.material_code, p.canonical_name,
    p.canonical_default_unit, p.location_unit, p.source_unit,
    p.conversion_factor, p.display_label, p.active
  from approved_picker p
  where p.approved_mapping_count = 1
  order by p.material_code, p.canonical_name, p.location_unit, p.source_unit, p.kitchen_inventory_item_id;
end;
$$;

create or replace function public.record_q7_inventory_receipt(
  p_movement_date date,
  p_kitchen_inventory_item_id uuid,
  p_quantity numeric,
  p_unit text,
  p_source_ref_key text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_resolved record;
  v_movement_id uuid;
  v_existing public.q7_inventory_movements%rowtype;
  v_source_ref_key text := nullif(btrim(p_source_ref_key), '');
begin
  if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not public.q7_material_inventory_can_edit(v_actor_id) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  if p_movement_date is null then raise exception 'movement_date_required' using errcode = '22023'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity::text in ('NaN', 'Infinity', '-Infinity') then raise exception 'invalid_quantity' using errcode = '22023'; end if;
  if p_source_ref_key is not null and (btrim(p_source_ref_key) = '' or length(btrim(p_source_ref_key)) > 120) then raise exception 'source_ref_key_invalid' using errcode = '22023'; end if;

  select * into v_resolved
  from public.resolve_q7_canonical_inventory_item(p_kitchen_inventory_item_id, p_unit);

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit, source,
    source_ref_key, note, created_by, q7_mapping_id, canonical_material_id
  ) values (
    v_resolved.kitchen_inventory_item_id, p_movement_date, 'receipt', p_quantity,
    v_resolved.unit, 'manual_receipt', v_source_ref_key, p_note, v_actor_id,
    v_resolved.q7_mapping_id, v_resolved.canonical_material_id
  )
  on conflict (source, source_ref_key) where source_ref_key is not null do nothing
  returning id into v_movement_id;

  if v_movement_id is not null then
    return jsonb_build_object('status', 'receipt_recorded', 'movement_id', v_movement_id);
  end if;

  if v_source_ref_key is not null then
    select * into v_existing
    from public.q7_inventory_movements
    where source = 'manual_receipt' and source_ref_key = v_source_ref_key
    for update;
    if found and v_existing.kitchen_inventory_item_id is not distinct from v_resolved.kitchen_inventory_item_id
       and v_existing.movement_date is not distinct from p_movement_date
       and v_existing.movement_type is not distinct from 'receipt'
       and v_existing.quantity is not distinct from p_quantity
       and lower(btrim(v_existing.unit)) is not distinct from lower(btrim(v_resolved.unit))
       and v_existing.note is not distinct from p_note
       and v_existing.q7_mapping_id is not distinct from v_resolved.q7_mapping_id
       and v_existing.canonical_material_id is not distinct from v_resolved.canonical_material_id then
      return jsonb_build_object('status', 'receipt_unchanged', 'movement_id', v_existing.id);
    end if;
    raise exception 'source_ref_conflict' using errcode = '23505';
  end if;

  raise exception 'q7_receipt_insert_failed' using errcode = '40001';
end;
$$;

create or replace function public.backfill_q7_inventory_opening(
  p_effective_date date,
  p_kitchen_inventory_item_id uuid,
  p_opening_qty numeric,
  p_unit text,
  p_physical_count_qty numeric default null,
  p_physical_count_date date default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_resolved record;
  old_opening jsonb;
  v_opening public.q7_inventory_openings%rowtype;
  v_action text;
begin
  if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not public.q7_material_inventory_can_edit(v_actor_id) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  if p_effective_date is null then raise exception 'effective_date_required' using errcode = '22023'; end if;
  if p_opening_qty is not null and (p_opening_qty < 0 or p_opening_qty::text in ('NaN', 'Infinity', '-Infinity')) then raise exception 'invalid_opening_qty' using errcode = '22023'; end if;
  if p_physical_count_qty is not null and (p_physical_count_qty < 0 or p_physical_count_qty::text in ('NaN', 'Infinity', '-Infinity')) then raise exception 'invalid_physical_count_qty' using errcode = '22023'; end if;

  select * into v_resolved
  from public.resolve_q7_canonical_inventory_item(p_kitchen_inventory_item_id, p_unit);

  select * into v_opening
  from public.q7_inventory_openings o
  where o.kitchen_inventory_item_id = v_resolved.kitchen_inventory_item_id and o.effective_date = p_effective_date
  for update;
  old_opening := case when found then to_jsonb(v_opening) else null end;

  if old_opening is not null
     and v_opening.opening_qty is not distinct from p_opening_qty
     and lower(btrim(v_opening.unit)) is not distinct from lower(btrim(v_resolved.unit))
     and v_opening.physical_count_qty is not distinct from p_physical_count_qty
     and v_opening.physical_count_date is not distinct from p_physical_count_date
     and v_opening.audit_note is not distinct from p_note
     and v_opening.q7_mapping_id is not distinct from v_resolved.q7_mapping_id
     and v_opening.canonical_material_id is not distinct from v_resolved.canonical_material_id then
    return jsonb_build_object('status', 'opening_unchanged', 'opening_id', v_opening.id, 'opening_audited', p_opening_qty is not null);
  end if;

  v_action := case when old_opening is null and p_opening_qty is null then 'created_blank' when old_opening is null then 'backfilled' else 'corrected' end;

  insert into public.q7_inventory_openings(
    kitchen_inventory_item_id, effective_date, opening_qty, unit,
    physical_count_qty, physical_count_date, audit_actor, audit_note,
    created_by, updated_by, q7_mapping_id, canonical_material_id
  ) values (
    v_resolved.kitchen_inventory_item_id, p_effective_date, p_opening_qty, v_resolved.unit,
    p_physical_count_qty, p_physical_count_date, v_actor_id, p_note,
    v_actor_id, v_actor_id, v_resolved.q7_mapping_id, v_resolved.canonical_material_id
  )
  on conflict (kitchen_inventory_item_id, effective_date) do update
  set opening_qty = excluded.opening_qty,
      unit = excluded.unit,
      physical_count_qty = excluded.physical_count_qty,
      physical_count_date = excluded.physical_count_date,
      audit_actor = excluded.audit_actor,
      audit_note = excluded.audit_note,
      updated_by = excluded.updated_by,
      updated_at = now(),
      q7_mapping_id = excluded.q7_mapping_id,
      canonical_material_id = excluded.canonical_material_id
  returning * into v_opening;

  insert into public.q7_inventory_opening_audit_logs(
    opening_id, kitchen_inventory_item_id, effective_date, action, old_opening, new_opening,
    actor, note, q7_mapping_id, canonical_material_id
  ) values (
    v_opening.id, v_resolved.kitchen_inventory_item_id, p_effective_date, v_action, old_opening,
    to_jsonb(v_opening.*) || jsonb_build_object('q7_mapping_id', v_resolved.q7_mapping_id, 'canonical_material_id', v_resolved.canonical_material_id),
    v_actor_id, p_note, v_resolved.q7_mapping_id, v_resolved.canonical_material_id
  );

  return jsonb_build_object('status', 'opening_recorded', 'opening_id', v_opening.id, 'opening_audited', p_opening_qty is not null);
end;
$$;

create or replace function public.record_q7_inventory_adjustment(
  p_movement_date date,
  p_kitchen_inventory_item_id uuid,
  p_quantity numeric,
  p_unit text,
  p_reason text,
  p_source_ref_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_resolved record;
  v_movement_id uuid;
  v_existing public.q7_inventory_movements%rowtype;
  v_source_ref_key text := nullif(btrim(p_source_ref_key), '');
begin
  if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not (public.has_role(v_actor_id, 'owner') or public.has_module_permission(v_actor_id, 'accounting', 'edit')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_movement_date is null then raise exception 'movement_date_required' using errcode = '22023'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_quantity is null or p_quantity = 0 or p_quantity::text in ('NaN', 'Infinity', '-Infinity') then raise exception 'invalid_quantity' using errcode = '22023'; end if;
  if p_source_ref_key is not null and (btrim(p_source_ref_key) = '' or length(btrim(p_source_ref_key)) > 120) then raise exception 'source_ref_key_invalid' using errcode = '22023'; end if;

  select * into v_resolved
  from public.resolve_q7_canonical_inventory_item(p_kitchen_inventory_item_id, p_unit);

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit, source,
    source_ref_key, note, created_by, q7_mapping_id, canonical_material_id
  ) values (
    v_resolved.kitchen_inventory_item_id, p_movement_date, 'adjustment', p_quantity,
    v_resolved.unit, 'manual_adjustment', v_source_ref_key, p_reason, v_actor_id,
    v_resolved.q7_mapping_id, v_resolved.canonical_material_id
  )
  on conflict (source, source_ref_key) where source_ref_key is not null do nothing
  returning id into v_movement_id;

  if v_movement_id is not null then
    return jsonb_build_object('status', 'adjustment_recorded', 'movement_id', v_movement_id);
  end if;

  if v_source_ref_key is not null then
    select * into v_existing
    from public.q7_inventory_movements
    where source = 'manual_adjustment' and source_ref_key = v_source_ref_key
    for update;
    if found and v_existing.kitchen_inventory_item_id is not distinct from v_resolved.kitchen_inventory_item_id
       and v_existing.movement_date is not distinct from p_movement_date
       and v_existing.movement_type is not distinct from 'adjustment'
       and v_existing.quantity is not distinct from p_quantity
       and lower(btrim(v_existing.unit)) is not distinct from lower(btrim(v_resolved.unit))
       and v_existing.note is not distinct from p_reason
       and v_existing.q7_mapping_id is not distinct from v_resolved.q7_mapping_id
       and v_existing.canonical_material_id is not distinct from v_resolved.canonical_material_id then
      return jsonb_build_object('status', 'adjustment_unchanged', 'movement_id', v_existing.id);
    end if;
    raise exception 'source_ref_conflict' using errcode = '23505';
  end if;

  raise exception 'q7_adjustment_insert_failed' using errcode = '40001';
end;
$$;

revoke all on function public.resolve_q7_canonical_inventory_item(uuid, text) from public, anon, authenticated, service_role;

revoke all on function public.get_q7_inventory_picker() from public;
revoke execute on function public.get_q7_inventory_picker() from public;
revoke all on function public.get_q7_inventory_picker() from anon;
revoke execute on function public.get_q7_inventory_picker() from anon;
grant execute on function public.get_q7_inventory_picker() to authenticated, service_role;

revoke all on function public.record_q7_inventory_receipt(date, uuid, numeric, text, text, text) from public, anon, service_role;
grant execute on function public.record_q7_inventory_receipt(date, uuid, numeric, text, text, text) to authenticated;

revoke all on function public.backfill_q7_inventory_opening(date, uuid, numeric, text, numeric, date, text) from public, anon, service_role;
grant execute on function public.backfill_q7_inventory_opening(date, uuid, numeric, text, numeric, date, text) to authenticated;

revoke all on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) from public, anon, service_role;
grant execute on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) to authenticated;

do $$
begin
  if to_regprocedure('public.resolve_q7_canonical_inventory_item(uuid,text)') is null then raise exception 'missing resolve_q7_canonical_inventory_item signature'; end if;
  if to_regprocedure('public.get_q7_inventory_picker()') is null then raise exception 'missing get_q7_inventory_picker signature'; end if;
  if to_regprocedure('public.record_q7_inventory_receipt(date,uuid,numeric,text,text,text)') is null then raise exception 'missing record_q7_inventory_receipt signature'; end if;
  if to_regprocedure('public.backfill_q7_inventory_opening(date,uuid,numeric,text,numeric,date,text)') is null then raise exception 'missing backfill_q7_inventory_opening signature'; end if;
  if to_regprocedure('public.record_q7_inventory_adjustment(date,uuid,numeric,text,text,text)') is null then raise exception 'missing record_q7_inventory_adjustment signature'; end if;
  if has_function_privilege('anon', 'public.get_q7_inventory_picker()', 'execute') then raise exception 'anon must not execute get_q7_inventory_picker'; end if;
  if has_function_privilege('anon', 'public.record_q7_inventory_receipt(date,uuid,numeric,text,text,text)', 'execute') then raise exception 'anon must not execute record_q7_inventory_receipt'; end if;
  if has_function_privilege('anon', 'public.backfill_q7_inventory_opening(date,uuid,numeric,text,numeric,date,text)', 'execute') then raise exception 'anon must not execute backfill_q7_inventory_opening'; end if;
  if has_function_privilege('service_role', 'public.record_q7_inventory_receipt(date,uuid,numeric,text,text,text)', 'execute')
     or has_function_privilege('service_role', 'public.backfill_q7_inventory_opening(date,uuid,numeric,text,numeric,date,text)', 'execute')
     or has_function_privilege('service_role', 'public.record_q7_inventory_adjustment(date,uuid,numeric,text,text,text)', 'execute') then
    raise exception 'service_role actor spoof path unexpectedly has Task8 write execute privilege';
  end if;
end $$;

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001', 'authenticated', 'authenticated', 'task8-q7-smoke@example.invalid', '', now(), now(), now())
on conflict (id) do nothing;

insert into public.user_roles(user_id, role)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001', 'owner')
on conflict do nothing;

insert into public.sku_cogs_materials (id, material_code, canonical_name, normalized_name, default_unit, active, created_by)
values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101', 'NVL-T8-ACTIVE', 'Task8 Active Canonical', 'task8 active canonical', 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb102', 'NVL-T8-NOMAP', 'Task8 No Mapping Canonical', 'task8 no mapping canonical', 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb103', 'NVL-T8-MISMATCH', 'Task8 Mismatch Canonical', 'task8 mismatch canonical', 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb104', 'NVL-T8-INACTIVE', 'Task8 Inactive Canonical', 'task8 inactive canonical', 'kg', false, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb105', 'NVL-T8-DUPE', 'Task8 Duplicate Canonical', 'task8 duplicate canonical', 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001');

insert into public.kitchen_inventory_items (id, item_code, normalized_key, item_type, name, unit, active, canonical_material_id, material_resolution_status)
values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201', 'T8-Q7-ACTIVE', 'task8-q7-active', 'ingredient', 'Task8 Active Kitchen', 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101', 'linked'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb202', 'T8-Q7-NOLINK', 'task8-q7-nolink', 'ingredient', 'Task8 No Link Kitchen', 'kg', true, null, null),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb203', 'T8-Q7-NOMAP', 'task8-q7-nomap', 'ingredient', 'Task8 No Mapping Kitchen', 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb102', 'linked'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb204', 'T8-Q7-MISMATCH', 'task8-q7-mismatch', 'ingredient', 'Task8 Mismatch Kitchen', 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb103', 'linked'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb205', 'T8-Q7-INACTIVE', 'task8-q7-inactive', 'ingredient', 'Task8 Inactive Kitchen', 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb104', 'linked'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb206', 'T8-Q7-DUPE', 'task8-q7-dupe', 'ingredient', 'Task8 Duplicate Kitchen', 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb105', 'linked');

insert into public.q7_material_issue_material_mappings (id, canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at, created_by)
values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb301', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101', 'kg', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201', 'kg', 1, 'approved', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001', now(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb302', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101', 'box', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb204', 'kg', 1, 'approved', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001', now(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb303', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb104', 'kg', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb205', 'kg', 1, 'approved', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001', now(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb304', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb105', 'kg', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb206', 'kg', 1, 'approved', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001', now(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb305', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb105', 'pack', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb206', 'kg', 1, 'approved', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001', now(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001');

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001', true);
select set_config('request.jwt.claims', jsonb_build_object('role','service_role','sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001')::text, true);

create temp table task8_picker as select * from public.get_q7_inventory_picker() where kitchen_inventory_item_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201';
create temp table task8_receipt as select public.record_q7_inventory_receipt(date '2026-08-18', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201', 5, 'KG', 'task8-receipt-smoke', 'Task8 rollback receipt') as response;
create temp table task8_receipt_again as select public.record_q7_inventory_receipt(date '2026-08-18', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201', 5, 'kg', 'task8-receipt-smoke', 'Task8 rollback receipt') as response;
create temp table task8_opening as select public.backfill_q7_inventory_opening(date '2026-08-01', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201', null, 'kg', null, null, 'Task8 blank opening') as response;
create temp table task8_adjustment as select public.record_q7_inventory_adjustment(date '2026-08-19', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201', -10, 'kg', 'Task8 negative balance rollback probe', 'task8-adjustment-smoke') as response;

create temp table task8_snapshot as select * from public.get_q7_inventory_snapshot(date '2026-08-19') where kitchen_inventory_item_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201';

do $$
declare
  c record;
  v_picker record;
  v_receipt jsonb;
  v_receipt_again jsonb;
  v_opening jsonb;
  v_adjustment jsonb;
  v_snapshot record;
  v_movement record;
begin
  select * into c from task8_counts_before;
  select * into v_picker from task8_picker;
  if not found or v_picker.display_label <> 'NVL-T8-ACTIVE · Task8 Active Canonical · kg' or v_picker.location_unit <> 'kg' or v_picker.canonical_material_id <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101' then
    raise exception 'picker canonical display mismatch: %', row_to_json(v_picker);
  end if;

  select response into v_receipt from task8_receipt;
  select response into v_receipt_again from task8_receipt_again;
  select response into v_opening from task8_opening;
  select response into v_adjustment from task8_adjustment;
  if v_receipt->>'status' <> 'receipt_recorded' then raise exception 'receipt did not record: %', v_receipt; end if;
  if v_receipt_again->>'status' <> 'receipt_unchanged' then raise exception 'receipt idempotency failed: %', v_receipt_again; end if;
  if v_opening->>'status' <> 'opening_recorded' then raise exception 'opening did not record: %', v_opening; end if;
  if v_adjustment->>'status' <> 'adjustment_recorded' then raise exception 'adjustment did not record: %', v_adjustment; end if;

  if exists (select 1 from public.get_q7_inventory_picker() where kitchen_inventory_item_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb206') then
    raise exception 'duplicate indistinguishable approved mappings leaked into picker';
  end if;

  select * into v_movement from public.q7_inventory_movements where source = 'manual_receipt' and source_ref_key = 'task8-receipt-smoke';
  if v_movement.q7_mapping_id <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb301' or v_movement.canonical_material_id <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101' then
    raise exception 'receipt did not snapshot canonical mapping: %', row_to_json(v_movement);
  end if;
  if not exists (
    select 1 from public.q7_inventory_movements
    where source = 'manual_adjustment' and source_ref_key = 'task8-adjustment-smoke'
      and q7_mapping_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb301'
      and canonical_material_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101'
  ) then raise exception 'adjustment did not snapshot canonical mapping'; end if;

  if not exists (
    select 1 from public.q7_inventory_openings
    where kitchen_inventory_item_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201'
      and q7_mapping_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb301'
      and canonical_material_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101'
  ) then raise exception 'opening did not snapshot canonical mapping'; end if;

  if not exists (
    select 1 from public.q7_inventory_opening_audit_logs
    where kitchen_inventory_item_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201'
      and q7_mapping_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb301'
      and canonical_material_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101'
      and new_opening ? 'q7_mapping_id'
  ) then raise exception 'opening audit did not snapshot canonical mapping'; end if;

  select * into v_snapshot from task8_snapshot;
  if not found or v_snapshot.balance_qty <> -5 or v_snapshot.is_negative is not true then
    raise exception 'Q7 negative-allowed balance mismatch: %', row_to_json(v_snapshot);
  end if;

  if (select count(*) from public.kitchen_inventory_movements) <> c.kitchen_inventory_movements then
    raise exception 'shared kitchen_inventory_movements changed inside rollback smoke';
  end if;
end $$;

select pg_temp.assert_error('missing canonical link receipt', $sql$
  select public.record_q7_inventory_receipt(date '2026-08-18', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb202', 1, 'kg', null, null)
$sql$, '22023', 'q7_canonical_link_required');
select pg_temp.assert_error('missing canonical link adjustment', $sql$
  select public.record_q7_inventory_adjustment(date '2026-08-18', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb202', -1, 'kg', 'Task8 blocked adjustment', null)
$sql$, '22023', 'q7_canonical_link_required');
select pg_temp.assert_error('missing mapping receipt', $sql$
  select public.record_q7_inventory_receipt(date '2026-08-18', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb203', 1, 'kg', null, null)
$sql$, '22023', 'q7_mapping_required');
select pg_temp.assert_error('mapping identity mismatch receipt', $sql$
  select public.record_q7_inventory_receipt(date '2026-08-18', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb204', 1, 'kg', null, null)
$sql$, '22023', 'q7_mapping_identity_mismatch');
select pg_temp.assert_error('inactive canonical opening', $sql$
  select public.backfill_q7_inventory_opening(date '2026-08-01', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb205', 1, 'kg', null, null, null)
$sql$, '22023', 'q7_canonical_link_required');
select pg_temp.assert_error('duplicate mapping opening', $sql$
  select public.backfill_q7_inventory_opening(date '2026-08-01', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb206', 1, 'kg', null, null, null)
$sql$, '22023', 'q7_mapping_identity_mismatch');

rollback;

select
  (select count(*) from public.sku_cogs_materials where id::text like 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb1%') as task8_canonical_rows_after_rollback,
  (select count(*) from public.kitchen_inventory_items where id::text like 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb2%') as task8_kitchen_rows_after_rollback,
  (select count(*) from public.q7_material_issue_material_mappings where id::text like 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb3%') as task8_mapping_rows_after_rollback,
  (select count(*) from public.q7_inventory_movements where source_ref_key in ('task8-receipt-smoke', 'task8-adjustment-smoke')) as task8_q7_write_rows_after_rollback,
  (select count(*) from public.kitchen_inventory_movements) as kitchen_inventory_movements_after_rollback;
