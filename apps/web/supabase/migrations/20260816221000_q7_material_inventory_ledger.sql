-- Task 7 replacement: Q7-only negative-allowed inventory ledger, structured
-- signed-slip actuals, and explicit confirmation posting. Local migration only;
-- no historical DML/backfill and no shared kitchen_inventory_movements writes.

create table if not exists public.q7_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  movement_date date not null,
  movement_type text not null check (movement_type in ('receipt', 'production_usage', 'adjustment')),
  quantity numeric(15, 3) not null,
  unit text not null,
  source text not null check (source in ('manual_receipt', 'signed_q7_issue', 'manual_adjustment')),
  source_ref_id uuid,
  source_ref_key text,
  source_issue_id uuid references public.production_material_issues(id) on delete restrict,
  source_issue_item_id uuid references public.production_material_issue_items(id) on delete restrict,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint q7_inventory_movements_quantity_check check (
    (
      movement_type in ('receipt', 'production_usage') and quantity > 0
    ) or (
      movement_type = 'adjustment' and quantity <> 0
    )
  ),
  constraint q7_inventory_movements_quantity_finite_check check (
    quantity::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

create index if not exists idx_q7_inventory_movements_item_date
  on public.q7_inventory_movements(kitchen_inventory_item_id, movement_date, created_at, id);

create unique index if not exists q7_inventory_movements_source_ref_key_uidx
  on public.q7_inventory_movements(source, source_ref_key)
  where source_ref_key is not null;

create unique index if not exists q7_inventory_movements_signed_issue_item_uidx
  on public.q7_inventory_movements(source, source_issue_item_id)
  where source = 'signed_q7_issue' and source_issue_item_id is not null;

create table if not exists public.q7_inventory_openings (
  id uuid primary key default gen_random_uuid(),
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  effective_date date not null,
  opening_qty numeric(15, 3),
  unit text not null,
  physical_count_qty numeric(15, 3),
  physical_count_date date,
  audit_actor uuid references auth.users(id) on delete set null,
  audit_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (kitchen_inventory_item_id, effective_date),
  constraint q7_inventory_openings_opening_qty_check check (
    opening_qty is null or (
      opening_qty >= 0 and opening_qty::text not in ('NaN', 'Infinity', '-Infinity')
    )
  ),
  constraint q7_inventory_openings_physical_qty_check check (
    physical_count_qty is null or (
      physical_count_qty >= 0 and physical_count_qty::text not in ('NaN', 'Infinity', '-Infinity')
    )
  )
);

create table if not exists public.q7_inventory_opening_audit_logs (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid references public.q7_inventory_openings(id) on delete restrict,
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  effective_date date not null,
  action text not null check (action in ('created_blank', 'backfilled', 'corrected')),
  old_opening jsonb,
  new_opening jsonb not null,
  actor uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.production_material_issue_check_actuals (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references public.production_material_issue_checks(id) on delete restrict,
  issue_item_id uuid not null references public.production_material_issue_items(id) on delete restrict,
  planned_qty numeric(15, 3) not null,
  actual_qty numeric(15, 3) not null,
  difference_qty numeric(15, 3) generated always as (actual_qty - planned_qty) stored,
  unit text not null,
  evidence_kind text not null check (evidence_kind in ('printed_planned', 'handwritten_final')),
  confidence numeric(5, 4) not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (check_id, issue_item_id),
  constraint production_material_issue_check_actuals_qty_check check (
    planned_qty >= 0 and actual_qty >= 0
    and planned_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and actual_qty::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint production_material_issue_check_actuals_confidence_check check (
    confidence >= 0 and confidence <= 1
    and confidence::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

create or replace function public.q7_prevent_inventory_movement_rewrite()
returns trigger
language plpgsql
as $$
begin
  raise exception 'q7_inventory_movements are append-only';
end;
$$;

drop trigger if exists q7_inventory_movements_immutable on public.q7_inventory_movements;
create trigger q7_inventory_movements_immutable
  before update or delete on public.q7_inventory_movements
  for each row execute function public.q7_prevent_inventory_movement_rewrite();

create or replace function public.q7_prevent_inventory_opening_audit_rewrite()
returns trigger
language plpgsql
as $$
begin
  raise exception 'q7_inventory_opening_audit_logs are append-only';
end;
$$;

drop trigger if exists q7_inventory_opening_audit_logs_immutable on public.q7_inventory_opening_audit_logs;
create trigger q7_inventory_opening_audit_logs_immutable
  before update or delete on public.q7_inventory_opening_audit_logs
  for each row execute function public.q7_prevent_inventory_opening_audit_rewrite();

create or replace function public.q7_prevent_production_material_issue_check_actual_rewrite()
returns trigger
language plpgsql
as $$
begin
  raise exception 'production_material_issue_check_actuals are append-only';
end;
$$;

drop trigger if exists production_material_issue_check_actuals_immutable on public.production_material_issue_check_actuals;
create trigger production_material_issue_check_actuals_immutable
  before update or delete on public.production_material_issue_check_actuals
  for each row execute function public.q7_prevent_production_material_issue_check_actual_rewrite();

create or replace function public.q7_material_inventory_can_edit(v_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.has_role(v_actor_id, 'owner')
    or public.has_module_permission(v_actor_id, 'q7_material_inventory', 'edit')
    or public.has_module_permission(v_actor_id, 'kitchen_inventory', 'edit');
$$;


create or replace function public.q7_material_inventory_can_view(v_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.has_role(v_actor_id, 'owner')
    or public.has_module_permission(v_actor_id, 'q7_material_inventory', 'view')
    or public.has_module_permission(v_actor_id, 'q7_material_inventory', 'edit')
    or public.has_module_permission(v_actor_id, 'kitchen_inventory', 'view')
    or public.has_module_permission(v_actor_id, 'kitchen_inventory', 'edit');
$$;

create or replace function public.get_q7_inventory_snapshot(p_as_of_date date default null)
returns table (
  kitchen_inventory_item_id uuid,
  item_name text,
  unit text,
  opening_qty numeric,
  receipt_qty numeric,
  usage_qty numeric,
  adjustment_qty numeric,
  balance_qty numeric,
  is_negative boolean,
  opening_audited boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_as_of_date date := coalesce(p_as_of_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor_id) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  end if;

  return query
  with mapped_items as (
    select distinct on (m.kitchen_inventory_item_id)
      m.kitchen_inventory_item_id,
      kii.name as item_name,
      kii.unit
    from public.q7_material_issue_material_mappings m
    join public.kitchen_inventory_items kii
      on kii.id = m.kitchen_inventory_item_id
     and kii.active = true
    where m.approval_status = 'approved'
    order by m.kitchen_inventory_item_id, kii.name
  ), latest_opening as (
    select distinct on (o.kitchen_inventory_item_id)
      o.kitchen_inventory_item_id,
      o.effective_date,
      o.opening_qty,
      (o.opening_qty is not null and o.audit_actor is not null) as opening_audited
    from public.q7_inventory_openings o
    where o.effective_date <= v_as_of_date
    order by o.kitchen_inventory_item_id, o.effective_date desc, o.updated_at desc, o.id desc
  ), movement_totals as (
    select
      m.kitchen_inventory_item_id,
      coalesce(sum(m.quantity) filter (where m.movement_type = 'receipt'), 0)::numeric(15, 3) as receipt_qty,
      coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0)::numeric(15, 3) as usage_qty,
      coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0)::numeric(15, 3) as adjustment_qty
    from public.q7_inventory_movements m
    left join latest_opening o on o.kitchen_inventory_item_id = m.kitchen_inventory_item_id
    where m.movement_date <= v_as_of_date
      and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
    group by m.kitchen_inventory_item_id
  )
  select
    mi.kitchen_inventory_item_id,
    mi.item_name,
    mi.unit,
    o.opening_qty,
    coalesce(mt.receipt_qty, 0)::numeric(15, 3) as receipt_qty,
    coalesce(mt.usage_qty, 0)::numeric(15, 3) as usage_qty,
    coalesce(mt.adjustment_qty, 0)::numeric(15, 3) as adjustment_qty,
    (coalesce(o.opening_qty, 0) + coalesce(mt.receipt_qty, 0) - coalesce(mt.usage_qty, 0) + coalesce(mt.adjustment_qty, 0))::numeric(15, 3) as balance_qty,
    ((coalesce(o.opening_qty, 0) + coalesce(mt.receipt_qty, 0) - coalesce(mt.usage_qty, 0) + coalesce(mt.adjustment_qty, 0)) < 0) as is_negative,
    coalesce(o.opening_audited, false) as opening_audited
  from mapped_items mi
  left join latest_opening o on o.kitchen_inventory_item_id = mi.kitchen_inventory_item_id
  left join movement_totals mt on mt.kitchen_inventory_item_id = mi.kitchen_inventory_item_id
  order by mi.item_name, mi.kitchen_inventory_item_id;
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
  v_item public.kitchen_inventory_items%rowtype;
  v_movement_id uuid;
  v_existing public.q7_inventory_movements%rowtype;
  v_source_ref_key text := nullif(btrim(p_source_ref_key), '');
begin
  if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not public.q7_material_inventory_can_edit(v_actor_id) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  if p_movement_date is null then raise exception 'movement_date_required' using errcode = '22023'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity::text in ('NaN', 'Infinity', '-Infinity') then raise exception 'invalid_quantity' using errcode = '22023'; end if;
  if p_source_ref_key is not null and (btrim(p_source_ref_key) = '' or length(btrim(p_source_ref_key)) > 120) then raise exception 'source_ref_key_invalid' using errcode = '22023'; end if;

  select * into v_item from public.kitchen_inventory_items where id = p_kitchen_inventory_item_id and active = true;
  if not found then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;
  if lower(btrim(v_item.unit)) is distinct from lower(btrim(p_unit)) then raise exception 'unit_mismatch' using errcode = '22023'; end if;
  if not exists (select 1 from public.q7_material_issue_material_mappings m where m.kitchen_inventory_item_id = v_item.id and m.approval_status = 'approved') then
    raise exception 'q7_mapping_required' using errcode = '22023';
  end if;

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit, source, source_ref_key, note, created_by
  ) values (
    v_item.id, p_movement_date, 'receipt', p_quantity, v_item.unit, 'manual_receipt', v_source_ref_key, p_note, v_actor_id
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
    if found and v_existing.kitchen_inventory_item_id is not distinct from v_item.id
       and v_existing.movement_date is not distinct from p_movement_date
       and v_existing.movement_type is not distinct from 'receipt'
       and v_existing.quantity is not distinct from p_quantity
       and lower(btrim(v_existing.unit)) is not distinct from lower(btrim(v_item.unit))
       and v_existing.note is not distinct from p_note then
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
  v_item public.kitchen_inventory_items%rowtype;
  old_opening jsonb;
  v_opening public.q7_inventory_openings%rowtype;
  v_action text;
begin
  if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not public.q7_material_inventory_can_edit(v_actor_id) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  if p_effective_date is null then raise exception 'effective_date_required' using errcode = '22023'; end if;
  if p_opening_qty is not null and (p_opening_qty < 0 or p_opening_qty::text in ('NaN', 'Infinity', '-Infinity')) then raise exception 'invalid_opening_qty' using errcode = '22023'; end if;
  if p_physical_count_qty is not null and (p_physical_count_qty < 0 or p_physical_count_qty::text in ('NaN', 'Infinity', '-Infinity')) then raise exception 'invalid_physical_count_qty' using errcode = '22023'; end if;

  select * into v_item from public.kitchen_inventory_items where id = p_kitchen_inventory_item_id and active = true;
  if not found then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;
  if lower(btrim(v_item.unit)) is distinct from lower(btrim(p_unit)) then raise exception 'unit_mismatch' using errcode = '22023'; end if;

  select * into v_opening
  from public.q7_inventory_openings o
  where o.kitchen_inventory_item_id = v_item.id and o.effective_date = p_effective_date
  for update;
  old_opening := case when found then to_jsonb(v_opening) else null end;

  if old_opening is not null
     and v_opening.opening_qty is not distinct from p_opening_qty
     and lower(btrim(v_opening.unit)) is not distinct from lower(btrim(v_item.unit))
     and v_opening.physical_count_qty is not distinct from p_physical_count_qty
     and v_opening.physical_count_date is not distinct from p_physical_count_date
     and v_opening.audit_note is not distinct from p_note then
    return jsonb_build_object('status', 'opening_unchanged', 'opening_id', v_opening.id, 'opening_audited', p_opening_qty is not null);
  end if;

  v_action := case when old_opening is null and p_opening_qty is null then 'created_blank' when old_opening is null then 'backfilled' else 'corrected' end;

  -- no automatic current kitchen ledger mutation; Q7 openings are separate and audited.
  insert into public.q7_inventory_openings(
    kitchen_inventory_item_id, effective_date, opening_qty, unit,
    physical_count_qty, physical_count_date, audit_actor, audit_note,
    created_by, updated_by
  ) values (
    v_item.id, p_effective_date, p_opening_qty, v_item.unit,
    p_physical_count_qty, p_physical_count_date, v_actor_id, p_note,
    v_actor_id, v_actor_id
  )
  on conflict (kitchen_inventory_item_id, effective_date) do update
  set opening_qty = excluded.opening_qty,
      unit = excluded.unit,
      physical_count_qty = excluded.physical_count_qty,
      physical_count_date = excluded.physical_count_date,
      audit_actor = excluded.audit_actor,
      audit_note = excluded.audit_note,
      updated_by = excluded.updated_by,
      updated_at = now()
  returning * into v_opening;

  insert into public.q7_inventory_opening_audit_logs(
    opening_id, kitchen_inventory_item_id, effective_date, action, old_opening, new_opening, actor, note
  ) values (
    v_opening.id, v_item.id, p_effective_date, v_action, old_opening, to_jsonb(v_opening.*), v_actor_id, p_note
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
  v_item public.kitchen_inventory_items%rowtype;
  v_movement_id uuid;
  v_existing public.q7_inventory_movements%rowtype;
  v_source_ref_key text := nullif(btrim(p_source_ref_key), '');
begin
  if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not (public.has_role(v_actor_id, 'owner') or public.has_module_permission(v_actor_id, 'accounting', 'edit')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_quantity is null or p_quantity = 0 or p_quantity::text in ('NaN', 'Infinity', '-Infinity') then raise exception 'invalid_quantity' using errcode = '22023'; end if;
  if p_source_ref_key is not null and (btrim(p_source_ref_key) = '' or length(btrim(p_source_ref_key)) > 120) then raise exception 'source_ref_key_invalid' using errcode = '22023'; end if;

  select * into v_item from public.kitchen_inventory_items where id = p_kitchen_inventory_item_id and active = true;
  if not found then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;
  if lower(btrim(v_item.unit)) is distinct from lower(btrim(p_unit)) then raise exception 'unit_mismatch' using errcode = '22023'; end if;

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit, source, source_ref_key, note, created_by
  ) values (
    v_item.id, p_movement_date, 'adjustment', p_quantity, v_item.unit, 'manual_adjustment', v_source_ref_key, p_reason, v_actor_id
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
    if found and v_existing.kitchen_inventory_item_id is not distinct from v_item.id
       and v_existing.movement_date is not distinct from p_movement_date
       and v_existing.movement_type is not distinct from 'adjustment'
       and v_existing.quantity is not distinct from p_quantity
       and lower(btrim(v_existing.unit)) is not distinct from lower(btrim(v_item.unit))
       and v_existing.note is not distinct from p_reason then
      return jsonb_build_object('status', 'adjustment_unchanged', 'movement_id', v_existing.id);
    end if;
    raise exception 'source_ref_conflict' using errcode = '23505';
  end if;

  raise exception 'q7_adjustment_insert_failed' using errcode = '40001';
end;
$$;
create or replace function public.finalize_q7_material_issue_check_with_actuals(
  p_check_id uuid,
  p_signed_sha256 text,
  p_outcome text,
  p_result jsonb,
  p_actual_rows jsonb,
  p_model text,
  p_model_version text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check public.production_material_issue_checks%rowtype;
  v_issue public.production_material_issues%rowtype;
  v_issue_item_count integer;
  v_actual_count integer := 0;
  v_actual_qty_cap numeric := 1000000000;
  v_result jsonb;
  v_actual jsonb;
  v_issue_item_id_text text;
  v_planned_qty_text text;
  v_actual_qty_text text;
  v_confidence_text text;
  v_issue_item_id uuid;
  v_planned_qty numeric;
  v_actual_qty numeric;
  v_confidence numeric;
  v_item public.production_material_issue_items%rowtype;
  v_actual_seen jsonb := '{}'::jsonb;
  v_is_exact_retry boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  if p_actor_id is null then raise exception 'actor_required' using errcode = '22023'; end if;
  if p_outcome not in ('passed', 'needs_review', 'failed', 'failed_transient', 'error') then raise exception 'invalid_outcome' using errcode = '22023'; end if;

  if p_outcome <> 'passed' then
    if jsonb_typeof(coalesce(p_actual_rows, '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(p_actual_rows, '[]'::jsonb)) <> 0 then
      raise exception 'invalid_actuals_payload' using errcode = '22023';
    end if;
    v_result := public.finalize_q7_material_issue_check(
      p_check_id, p_signed_sha256, p_outcome, p_result, p_model, p_model_version, p_actor_id
    );
    return v_result || jsonb_build_object('actual_count', 0);
  end if;

  if p_actual_rows is null or jsonb_typeof(p_actual_rows) <> 'array' then raise exception 'invalid_actuals_payload' using errcode = '22023'; end if;

  select * into v_check from public.production_material_issue_checks where id = p_check_id for update;
  if not found then raise exception 'check_not_found' using errcode = 'P0002'; end if;
  select * into v_issue from public.production_material_issues where id = v_check.issue_id for update;
  if not found then raise exception 'material_issue_not_found' using errcode = 'P0002'; end if;

  if v_check.signed_file_sha256 is distinct from lower(p_signed_sha256) or v_issue.signed_file_sha256 is distinct from lower(p_signed_sha256) then
    raise exception 'signed_hash_mismatch' using errcode = '22023';
  end if;
  if v_check.checked_by is distinct from p_actor_id then raise exception 'check_actor_mismatch' using errcode = '22023'; end if;
  v_is_exact_retry := v_check.status = 'passed' and v_issue.status = 'ready_to_confirm';
  if not ((v_check.status = 'checking' and v_issue.status = 'checking') or v_is_exact_retry) then
    raise exception 'blocked_check_status' using errcode = '22023';
  end if;

  select count(*) into v_issue_item_count from public.production_material_issue_items where material_issue_id = v_issue.id;
  if jsonb_array_length(p_actual_rows) <> v_issue_item_count then raise exception 'actuals_item_count_mismatch' using errcode = '22023'; end if;

  for v_actual in select value from jsonb_array_elements(p_actual_rows) loop
    if jsonb_typeof(v_actual) <> 'object'
       or jsonb_typeof(v_actual -> 'issue_item_id') <> 'string'
       or jsonb_typeof(v_actual -> 'actual_qty') not in ('number', 'string')
       or jsonb_typeof(v_actual -> 'confidence') not in ('number', 'string')
       or (v_actual ? 'planned_qty' and jsonb_typeof(v_actual -> 'planned_qty') not in ('number', 'string')) then
      raise exception 'invalid_actuals_payload' using errcode = '22023';
    end if;

    v_issue_item_id_text := v_actual ->> 'issue_item_id';
    v_actual_qty_text := v_actual ->> 'actual_qty';
    v_confidence_text := v_actual ->> 'confidence';
    v_planned_qty_text := v_actual ->> 'planned_qty';

    if v_issue_item_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or v_actual_qty_text !~ '^[0-9]+(\.[0-9]+)?$'
       or v_confidence_text !~ '^(0(\.[0-9]+)?|1(\.0+)?)$'
       or (v_planned_qty_text is not null and v_planned_qty_text !~ '^[0-9]+(\.[0-9]+)?$') then
      raise exception 'invalid_actuals_payload' using errcode = '22023';
    end if;

    if v_actual_seen ? v_issue_item_id_text then raise exception 'actuals_duplicate_or_missing_items' using errcode = '22023'; end if;
    v_actual_seen := v_actual_seen || jsonb_build_object(v_issue_item_id_text, true);

    v_issue_item_id := v_issue_item_id_text::uuid;
    v_actual_qty := v_actual_qty_text::numeric;
    v_confidence := v_confidence_text::numeric;
    v_planned_qty := case when v_planned_qty_text is null then null else v_planned_qty_text::numeric end;

    select * into v_item
    from public.production_material_issue_items i
    where i.id = v_issue_item_id and i.material_issue_id = v_issue.id;
    if not found
       or (v_actual ->> 'evidence_kind') not in ('printed_planned', 'handwritten_final')
       or v_actual_qty < 0
       or v_actual_qty > v_actual_qty_cap
       or v_actual_qty::text in ('NaN', 'Infinity', '-Infinity')
       or (v_planned_qty is not null and v_planned_qty is distinct from v_item.required_qty)
       or lower(btrim(v_actual ->> 'unit')) is distinct from lower(btrim(v_item.unit))
       or v_confidence < 0
       or v_confidence > 1 then
      raise exception 'invalid_actuals_payload' using errcode = '22023';
    end if;

    if v_is_exact_retry then
      if not exists (
        select 1
        from public.production_material_issue_check_actuals stored
        where stored.check_id = p_check_id
          and stored.issue_item_id = v_issue_item_id
          and stored.planned_qty is not distinct from coalesce(v_planned_qty, v_item.required_qty)
          and stored.actual_qty is not distinct from v_actual_qty
          and lower(btrim(stored.unit)) is not distinct from lower(btrim(v_item.unit))
          and stored.evidence_kind is not distinct from (v_actual ->> 'evidence_kind')
          and stored.confidence is not distinct from v_confidence
          and stored.created_by is not distinct from p_actor_id
      ) then
        raise exception 'actuals_retry_mismatch' using errcode = '22023';
      end if;
    else
      insert into public.production_material_issue_check_actuals(
        check_id, issue_item_id, planned_qty, actual_qty, unit, evidence_kind, confidence, created_by
      ) values (
        p_check_id,
        v_issue_item_id,
        coalesce(v_planned_qty, v_item.required_qty),
        v_actual_qty,
        v_item.unit,
        v_actual ->> 'evidence_kind',
        v_confidence,
        p_actor_id
      );
    end if;
    v_actual_count := v_actual_count + 1;
  end loop;

  if v_actual_count <> v_issue_item_count then raise exception 'actuals_duplicate_or_missing_items' using errcode = '22023'; end if;

  v_result := public.finalize_q7_material_issue_check(
    p_check_id, p_signed_sha256, p_outcome, p_result, p_model, p_model_version, p_actor_id
  );
  return v_result || jsonb_build_object('actual_count', v_issue_item_count);
end;
$$;
create or replace function public.confirm_q7_material_issue(
  p_issue_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_issue public.production_material_issues%rowtype;
  v_check public.production_material_issue_checks%rowtype;
  v_generator_result jsonb;
  v_generator_status text;
  v_issue_item_count integer := 0;
  v_positive_actual_count integer := 0;
  v_passed_check_count integer := 0;
  v_movement_count integer := 0;
  v_updated_count integer := 0;
  v_negative_count integer := 0;
  v_now timestamptz;
begin
  if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users u where u.id = v_actor_id) then raise exception 'actor_not_found' using errcode = '42501'; end if;
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  elsif not public.q7_material_issue_can_edit(v_actor_id) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_issue from public.production_material_issues where id = p_issue_id;
  if not found then raise exception 'material_issue_not_found' using errcode = 'P0002'; end if;

  v_generator_result := public.generate_q7_production_material_issue(v_issue.production_order_id, v_issue.issue_date);
  v_generator_status := v_generator_result ->> 'status';

  -- The generator serializes on the production order. Refresh and lock the
  -- issue afterwards so a concurrent loser observes the winner's posted state.
  select * into v_issue from public.production_material_issues where id = p_issue_id for update;

  create temp table if not exists q7_confirm_issue_items (
    issue_item_id uuid primary key,
    kitchen_inventory_item_id uuid not null,
    planned_qty numeric(15, 3) not null,
    actual_qty numeric(15, 3) not null,
    unit text not null,
    q7_mapping_id uuid not null,
    canonical_material_id uuid not null,
    source_unit text not null,
    conversion_factor numeric(18, 8) not null
  ) on commit drop;
  truncate table q7_confirm_issue_items;

  if v_issue.status = 'posted' then
    if v_generator_status <> 'posted_unchanged'
       or (v_generator_result ->> 'issue_id')::uuid is distinct from v_issue.id
       or (v_generator_result ->> 'source_hash') is distinct from v_issue.source_hash then
      raise exception 'q7_confirmation_source_changed' using errcode = '22023';
    end if;

    insert into q7_confirm_issue_items(
      issue_item_id, kitchen_inventory_item_id, planned_qty, actual_qty, unit,
      q7_mapping_id, canonical_material_id, source_unit, conversion_factor
    )
    select i.id, i.kitchen_inventory_item_id, i.required_qty, a.actual_qty, i.unit,
           i.q7_mapping_id, i.canonical_material_id, i.source_unit, i.conversion_factor
    from public.production_material_issue_items i
    left join public.production_material_issue_check_actuals a on a.issue_item_id = i.id
    join public.q7_material_issue_material_mappings m on m.id = i.q7_mapping_id
    where i.material_issue_id = v_issue.id
      and m.approval_status = 'approved'
      and a.actual_qty is not null;

    select count(*) into v_issue_item_count from public.production_material_issue_items where material_issue_id = v_issue.id;
    select count(*) into v_positive_actual_count from q7_confirm_issue_items i where i.actual_qty > 0;
    if (select count(*) from q7_confirm_issue_items) <> v_issue_item_count then raise exception 'actuals_required' using errcode = '22023'; end if;

    select count(*) into v_movement_count
    from public.q7_inventory_movements m
    join q7_confirm_issue_items i on i.issue_item_id = m.source_issue_item_id
    where i.actual_qty > 0
      and m.source = 'signed_q7_issue'
      and m.movement_type = 'production_usage'
      and not (
        m.kitchen_inventory_item_id is distinct from i.kitchen_inventory_item_id
        or m.movement_date is distinct from v_issue.issue_date
        or m.quantity is distinct from i.actual_qty
        or lower(btrim(m.unit)) is distinct from lower(btrim(i.unit))
        or m.source_issue_id is distinct from v_issue.id
        or m.created_by is distinct from v_issue.confirmed_by
      );
    if v_movement_count <> v_positive_actual_count then raise exception 'q7_confirm_movement_mismatch' using errcode = '22023'; end if;

    select count(*) into v_negative_count from public.get_q7_inventory_snapshot(v_issue.issue_date) s where s.is_negative;
    return jsonb_build_object('status', 'posted_unchanged', 'issue_id', v_issue.id, 'issue_number', v_issue.issue_number, 'movement_count', v_movement_count, 'negative_count', v_negative_count);
  end if;

  if v_generator_status <> 'ready_to_confirm_unchanged'
     or (v_generator_result ->> 'issue_id')::uuid is distinct from v_issue.id
     or (v_generator_result ->> 'source_hash') is distinct from v_issue.source_hash then
    raise exception 'q7_confirmation_source_changed' using errcode = '22023';
  end if;

  if v_issue.status <> 'ready_to_confirm' then raise exception 'blocked_issue_status' using errcode = '22023'; end if;
  if v_issue.location_code is distinct from 'q7' or v_issue.is_current is not true or v_issue.superseded_by_issue_id is not null then
    raise exception 'blocked_non_current_issue' using errcode = '22023';
  end if;
  if v_issue.issue_date > (now() at time zone 'Asia/Ho_Chi_Minh')::date then raise exception 'blocked_future_issue_date' using errcode = '22023'; end if;
  if v_issue.pdf_path is null or v_issue.pdf_sha256 is null or v_issue.signed_file_path is null or v_issue.signed_file_sha256 is null or v_issue.signed_uploaded_by is null or v_issue.signed_uploaded_at is null then
    raise exception 'signed_metadata_required' using errcode = '22023';
  end if;
  if v_issue.check_status is distinct from 'passed' or v_issue.checked_at is null then raise exception 'passed_check_required' using errcode = '22023'; end if;

  select count(*) into v_passed_check_count
  from public.production_material_issue_checks c
  where c.issue_id = v_issue.id and c.signed_file_sha256 = lower(v_issue.signed_file_sha256) and c.status = 'passed';
  if v_passed_check_count <> 1 then raise exception 'passed_check_required' using errcode = '22023'; end if;

  select * into v_check
  from public.production_material_issue_checks c
  where c.issue_id = v_issue.id and c.signed_file_sha256 = lower(v_issue.signed_file_sha256) and c.status = 'passed'
  for update;
  if v_check.signed_file_sha256 is distinct from lower(v_issue.signed_file_sha256)
     or not (v_check.result @> '{"identity_exact":true,"rows_exact":true,"document_legible":true,"pages_complete":true,"preparer_signed":true,"warehouse_keeper_signed":true,"receiver_signed":true}'::jsonb)
     or not (jsonb_typeof(v_check.result -> 'confidence') = 'number' and (v_check.result ->> 'confidence')::numeric >= 0.8) then
    raise exception 'passed_check_required' using errcode = '22023';
  end if;

  select count(*) into v_issue_item_count from public.production_material_issue_items where material_issue_id = v_issue.id;
  if v_issue_item_count = 0 then raise exception 'issue_items_required' using errcode = '22023'; end if;

  insert into q7_confirm_issue_items(
    issue_item_id, kitchen_inventory_item_id, planned_qty, actual_qty, unit,
    q7_mapping_id, canonical_material_id, source_unit, conversion_factor
  )
  select i.id, i.kitchen_inventory_item_id, i.required_qty, a.actual_qty, i.unit,
         i.q7_mapping_id, i.canonical_material_id, i.source_unit, i.conversion_factor
  from public.production_material_issue_items i
  left join public.production_material_issue_check_actuals a on a.issue_item_id = i.id and a.check_id = v_check.id
  join public.q7_material_issue_material_mappings m on m.id = i.q7_mapping_id
  where i.material_issue_id = v_issue.id
    and m.approval_status = 'approved'
    and m.kitchen_inventory_item_id is not distinct from i.kitchen_inventory_item_id
    and lower(btrim(m.kitchen_unit)) is not distinct from lower(btrim(i.unit))
    and m.conversion_factor is not distinct from i.conversion_factor
    and m.canonical_material_id is not distinct from i.canonical_material_id
    and lower(btrim(m.source_unit)) is not distinct from lower(btrim(i.source_unit))
    and i.required_qty > 0
    and i.required_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and a.actual_qty is not null
    and a.actual_qty >= 0
    and a.actual_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and a.planned_qty is not distinct from i.required_qty
    and lower(btrim(a.unit)) is not distinct from lower(btrim(i.unit));

  if (select count(*) from q7_confirm_issue_items) <> v_issue_item_count then
    raise exception 'issue_item_actual_snapshot_mismatch' using errcode = '22023';
  end if;

  v_now := clock_timestamp();

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_id, source_ref_key, source_issue_id, source_issue_item_id,
    note, created_by, created_at
  )
  select i.kitchen_inventory_item_id,
         v_issue.issue_date,
         'production_usage',
         i.actual_qty,
         i.unit,
         'signed_q7_issue',
         i.issue_item_id,
         'q7-material-issue:' || i.issue_item_id::text,
         v_issue.id,
         i.issue_item_id,
         'Q7 confirmed signed material issue actual quantity',
         v_actor_id,
         v_now
  from q7_confirm_issue_items i
  where i.actual_qty > 0
  order by i.kitchen_inventory_item_id, i.issue_item_id
  on conflict (source, source_issue_item_id) where source = 'signed_q7_issue' and source_issue_item_id is not null do nothing;

  select count(*) into v_positive_actual_count from q7_confirm_issue_items i where i.actual_qty > 0;
  select count(*) into v_movement_count
  from public.q7_inventory_movements m
  join q7_confirm_issue_items i on i.issue_item_id = m.source_issue_item_id
  where i.actual_qty > 0
    and m.source = 'signed_q7_issue'
    and m.movement_type = 'production_usage'
    and not (
      m.kitchen_inventory_item_id is distinct from i.kitchen_inventory_item_id
      or m.movement_date is distinct from v_issue.issue_date
      or m.quantity is distinct from i.actual_qty
      or lower(btrim(m.unit)) is distinct from lower(btrim(i.unit))
      or m.source_issue_id is distinct from v_issue.id
      or m.created_by is distinct from v_actor_id
    );
  if v_movement_count <> v_positive_actual_count then raise exception 'q7_confirm_movement_mismatch' using errcode = '22023'; end if;

  update public.production_material_issues
  set status = 'posted', confirmed_by = v_actor_id, confirmed_at = v_now, posted_at = v_now, updated_at = v_now
  where id = v_issue.id and status = 'ready_to_confirm';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then raise exception 'q7_confirm_issue_update_mismatch' using errcode = '22023'; end if;

  select count(*) into v_negative_count from public.get_q7_inventory_snapshot(v_issue.issue_date) s where s.is_negative;

  insert into public.production_material_issue_events(
    issue_id, event_type, from_status, to_status, actor, metadata
  ) values (
    v_issue.id, 'material_issue_confirmed_and_posted', 'ready_to_confirm', 'posted', v_actor_id,
    jsonb_build_object('movement_count', v_movement_count, 'negative_count', v_negative_count)
  );

  return jsonb_build_object('status', 'posted', 'issue_id', v_issue.id, 'issue_number', v_issue.issue_number, 'movement_count', v_movement_count, 'negative_count', v_negative_count);
end;
$$;

alter table public.q7_inventory_movements enable row level security;
alter table public.q7_inventory_openings enable row level security;
alter table public.q7_inventory_opening_audit_logs enable row level security;
alter table public.production_material_issue_check_actuals enable row level security;

drop policy if exists q7_inventory_movements_select on public.q7_inventory_movements;
create policy q7_inventory_movements_select on public.q7_inventory_movements for select to authenticated
  using (public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'q7_material_inventory', 'view')
    or public.has_module_permission((select auth.uid()), 'kitchen_inventory', 'view'));

drop policy if exists q7_inventory_openings_select on public.q7_inventory_openings;
create policy q7_inventory_openings_select on public.q7_inventory_openings for select to authenticated
  using (public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'q7_material_inventory', 'view')
    or public.has_module_permission((select auth.uid()), 'kitchen_inventory', 'view'));

drop policy if exists q7_inventory_opening_audit_logs_select on public.q7_inventory_opening_audit_logs;
create policy q7_inventory_opening_audit_logs_select on public.q7_inventory_opening_audit_logs for select to authenticated
  using (public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'q7_material_inventory', 'view')
    or public.has_module_permission((select auth.uid()), 'kitchen_inventory', 'view'));

drop policy if exists production_material_issue_check_actuals_select on public.production_material_issue_check_actuals;
create policy production_material_issue_check_actuals_select on public.production_material_issue_check_actuals for select to authenticated
  using (public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'production_q7', 'view')
    or public.has_module_permission((select auth.uid()), 'warehouse', 'view')
    or public.has_module_permission((select auth.uid()), 'kitchen_inventory', 'view'));

revoke all on public.q7_inventory_movements from public, anon, authenticated;
revoke all on public.q7_inventory_openings from public, anon, authenticated;
revoke all on public.q7_inventory_opening_audit_logs from public, anon, authenticated;
revoke all on public.production_material_issue_check_actuals from public, anon, authenticated;
grant select on public.q7_inventory_movements to authenticated;
grant select on public.q7_inventory_openings to authenticated;
grant select on public.q7_inventory_opening_audit_logs to authenticated;
grant select on public.production_material_issue_check_actuals to authenticated;

revoke all on function public.q7_prevent_inventory_movement_rewrite() from public, anon, authenticated;
revoke all on function public.q7_prevent_inventory_opening_audit_rewrite() from public, anon, authenticated;
revoke all on function public.q7_prevent_production_material_issue_check_actual_rewrite() from public, anon, authenticated;
revoke all on function public.q7_material_inventory_can_edit(uuid) from public, anon, authenticated;
revoke all on function public.q7_material_inventory_can_view(uuid) from public, anon, authenticated;

revoke all on function public.get_q7_inventory_snapshot(date) from public;
revoke execute on function public.get_q7_inventory_snapshot(date) from public;
revoke all on function public.get_q7_inventory_snapshot(date) from anon;
revoke execute on function public.get_q7_inventory_snapshot(date) from anon;
grant execute on function public.get_q7_inventory_snapshot(date) to authenticated, service_role;

revoke all on function public.record_q7_inventory_receipt(date, uuid, numeric, text, text, text) from public;
revoke execute on function public.record_q7_inventory_receipt(date, uuid, numeric, text, text, text) from public;
revoke all on function public.record_q7_inventory_receipt(date, uuid, numeric, text, text, text) from anon;
revoke execute on function public.record_q7_inventory_receipt(date, uuid, numeric, text, text, text) from anon;
grant execute on function public.record_q7_inventory_receipt(date, uuid, numeric, text, text, text) to authenticated, service_role;

revoke all on function public.backfill_q7_inventory_opening(date, uuid, numeric, text, numeric, date, text) from public;
revoke execute on function public.backfill_q7_inventory_opening(date, uuid, numeric, text, numeric, date, text) from public;
revoke all on function public.backfill_q7_inventory_opening(date, uuid, numeric, text, numeric, date, text) from anon;
revoke execute on function public.backfill_q7_inventory_opening(date, uuid, numeric, text, numeric, date, text) from anon;
grant execute on function public.backfill_q7_inventory_opening(date, uuid, numeric, text, numeric, date, text) to authenticated, service_role;

revoke all on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) from public;
revoke execute on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) from public;
revoke all on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) from anon;
revoke execute on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) from anon;
grant execute on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) to authenticated, service_role;

revoke all on function public.finalize_q7_material_issue_check_with_actuals(uuid, text, text, jsonb, jsonb, text, text, uuid) from public;
revoke execute on function public.finalize_q7_material_issue_check_with_actuals(uuid, text, text, jsonb, jsonb, text, text, uuid) from public;
revoke all on function public.finalize_q7_material_issue_check_with_actuals(uuid, text, text, jsonb, jsonb, text, text, uuid) from anon;
revoke execute on function public.finalize_q7_material_issue_check_with_actuals(uuid, text, text, jsonb, jsonb, text, text, uuid) from anon;
revoke all on function public.finalize_q7_material_issue_check_with_actuals(uuid, text, text, jsonb, jsonb, text, text, uuid) from authenticated;
revoke execute on function public.finalize_q7_material_issue_check_with_actuals(uuid, text, text, jsonb, jsonb, text, text, uuid) from authenticated;
grant execute on function public.finalize_q7_material_issue_check_with_actuals(uuid, text, text, jsonb, jsonb, text, text, uuid) to service_role;

revoke all on function public.confirm_q7_material_issue(uuid) from public;
revoke execute on function public.confirm_q7_material_issue(uuid) from public;
revoke all on function public.confirm_q7_material_issue(uuid) from anon;
revoke execute on function public.confirm_q7_material_issue(uuid) from anon;
revoke all on function public.confirm_q7_material_issue(uuid) from authenticated;
grant execute on function public.confirm_q7_material_issue(uuid) to authenticated, service_role;
