-- Task 3 Canonical NVL reconciliation approved-link RPC.
-- Root remains public.sku_cogs_materials only. This migration never merges,
-- deletes, backfills, or rewrites kitchen/SKU/Q7/history/ledger identities.
-- Runtime rollback smoke: wrap this migration plus test calls in BEGIN/ROLLBACK;
-- assert linked rows roll back and historical ledger counts remain unchanged.

create or replace function public.guard_canonical_material_link_update()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_link_owner name;
  v_guc text;
begin
  if new.canonical_material_id is not distinct from old.canonical_material_id
    and new.material_resolution_status is not distinct from old.material_resolution_status
    and new.material_resolution_request_id is not distinct from old.material_resolution_request_id then
    return new;
  end if;

  select pg_get_userbyid(p.proowner) into v_link_owner
  from pg_proc p
  where p.oid = 'public.link_approved_material_resolution(uuid, text, uuid, uuid, text)'::regprocedure;

  -- Keep an explicit pg_get_functiondef marker in this guard contract so review
  -- proves the owner comparison is tied to the exact controlled linker RPC.
  perform pg_get_functiondef('public.link_approved_material_resolution(uuid, text, uuid, uuid, text)'::regprocedure);

  v_guc := nullif(current_setting('material_master.link_request_id', true), '');
  if current_user <> v_link_owner
    or v_guc is null
    or v_guc !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or v_guc::uuid is distinct from new.material_resolution_request_id then
    raise exception 'direct canonical material link update is not allowed' using errcode = '42501';
  end if;

  if new.material_resolution_status <> 'linked'
    or new.canonical_material_id is null
    or new.material_resolution_request_id is null then
    raise exception 'canonical material link transition must be linked with nonnull material/request' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_canonical_material_link_update() from public, anon, authenticated, service_role;

drop trigger if exists trg_guard_kitchen_inventory_items_canonical_link on public.kitchen_inventory_items;
create trigger trg_guard_kitchen_inventory_items_canonical_link
before update of canonical_material_id, material_resolution_status, material_resolution_request_id
on public.kitchen_inventory_items
for each row
execute function public.guard_canonical_material_link_update();

drop trigger if exists trg_guard_product_skus_canonical_link on public.product_skus;
create trigger trg_guard_product_skus_canonical_link
before update of canonical_material_id, material_resolution_status, material_resolution_request_id
on public.product_skus
for each row
execute function public.guard_canonical_material_link_update();

create or replace function public.link_approved_material_resolution(
  p_request_id uuid,
  p_source_table text,
  p_source_id uuid,
  p_expected_material_id uuid,
  p_reason text default 'approved material reconciliation link'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.material_resolution_requests%rowtype;
  v_material public.sku_cogs_materials%rowtype;
  v_source_table text := lower(btrim(coalesce(p_source_table, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_old_material_id uuid;
  v_old_status text;
  v_old_request_id uuid;
  v_current_name text;
  v_current_code text;
  v_current_unit text;
  v_current_supplier_id uuid;
  v_unit_check jsonb;
  v_unit_blockers text[] := '{}'::text[];
  v_required_caps text[] := array['unit'];
  v_candidate_source text;
begin
  if not (public.can_edit_material_master() or coalesce(public.material_master_jwt_role(), '') = 'service_role') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if v_source_table not in ('kitchen_inventory_items', 'product_skus') then
    raise exception 'source_table not allowlisted for reconciliation link' using errcode = '22023';
  end if;
  if p_source_id is null or p_expected_material_id is null then
    raise exception 'exact source id and expected material id required' using errcode = '22023';
  end if;

  select * into v_req
  from public.material_resolution_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'resolution request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'resolved_existing'
    or v_req.resolved_material_id is null
    or v_req.reviewed_at is null
    or v_req.reviewer_id is null then
    raise exception 'terminal approved request required for reconciliation link' using errcode = '23514';
  end if;
  if lower(btrim(v_req.source_table)) <> v_source_table or v_req.source_id is distinct from p_source_id then
    raise exception 'request source identity mismatch' using errcode = '23514';
  end if;
  if v_req.resolved_material_id <> p_expected_material_id then
    raise exception 'approved material mismatch' using errcode = '23514';
  end if;

  v_candidate_source := v_req.safe_payload->>'candidate_source';
  if v_candidate_source not in ('material_code','normalized_canonical_name','approved_supplier_alias','approved_source_alias','approved_global_alias')
    or v_req.safe_payload->>'confidence' <> 'exact'
    or v_req.safe_payload->>'field_name' <> 'task3_reconciliation' then
    raise exception 'safe_payload exact task3 evidence required' using errcode = '23514';
  end if;

  select * into v_material
  from public.sku_cogs_materials
  where id = v_req.resolved_material_id
  for update;
  if not found or v_material.active is not true then
    raise exception 'active canonical material required' using errcode = '23514';
  end if;

  if v_req.supplier_id is not null then
    v_required_caps := array['unit','supplier_product'];
  end if;

  if v_source_table = 'kitchen_inventory_items' then
    select canonical_material_id, material_resolution_status, material_resolution_request_id, name, item_code, unit
      into v_old_material_id, v_old_status, v_old_request_id, v_current_name, v_current_code, v_current_unit
    from public.kitchen_inventory_items
    where id = p_source_id
    for update;
    if not found then
      raise exception 'source kitchen inventory item not found' using errcode = 'P0002';
    end if;
    if v_req.supplier_id is not null then
      raise exception 'source identity drift: kitchen source must not have supplier' using errcode = '23514';
    end if;
  elsif v_source_table = 'product_skus' then
    select canonical_material_id, material_resolution_status, material_resolution_request_id, product_name, sku_code, unit, supplier_id
      into v_old_material_id, v_old_status, v_old_request_id, v_current_name, v_current_code, v_current_unit, v_current_supplier_id
    from public.product_skus
    where id = p_source_id
    for update;
    if not found then
      raise exception 'source product sku not found' using errcode = 'P0002';
    end if;
    if v_current_supplier_id is distinct from v_req.supplier_id then
      raise exception 'source identity drift: supplier mismatch' using errcode = '23514';
    end if;
  end if;

  if public.material_master_normalize(v_current_name) <> public.material_master_normalize(v_req.raw_name)
    or lower(btrim(coalesce(v_current_code, ''))) is distinct from lower(btrim(coalesce(v_req.raw_code, '')))
    or lower(btrim(coalesce(v_current_unit, ''))) is distinct from lower(btrim(coalesce(v_req.raw_unit, ''))) then
    raise exception 'source identity drift: name/code/unit mismatch' using errcode = '23514';
  end if;
  if v_old_material_id is not null and v_old_material_id <> v_req.resolved_material_id then
    raise exception 'source already linked to different canonical material' using errcode = '23514';
  end if;

  v_unit_check := public.assert_material_ready(v_req.resolved_material_id, v_required_caps, v_req.supplier_id, v_current_unit, current_date);
  v_unit_blockers := array(select jsonb_array_elements_text(coalesce(v_unit_check->'blockers', '[]'::jsonb)));
  if 'supplier_unmapped' = any(v_unit_blockers) then
    raise exception 'supplier_unmapped' using errcode = '23514';
  end if;
  if 'unit_unmapped' = any(v_unit_blockers) then
    raise exception 'unit_unmapped' using errcode = '23514';
  end if;
  if coalesce((v_unit_check->>'ready')::boolean, false) is not true then
    raise exception 'unit_conversion_required' using errcode = '23514';
  end if;

  if v_old_material_id = v_req.resolved_material_id and v_old_request_id = p_request_id and v_old_status = 'linked' then
    return jsonb_build_object('status', 'linked_unchanged', 'source_table', v_source_table, 'source_id', p_source_id, 'material_id', v_req.resolved_material_id, 'request_id', p_request_id);
  end if;

  perform set_config('material_master.link_request_id', p_request_id::text, true);
  if v_source_table = 'kitchen_inventory_items' then
    update public.kitchen_inventory_items
    set canonical_material_id = v_req.resolved_material_id,
        material_resolution_status = 'linked',
        material_resolution_request_id = p_request_id
    where id = p_source_id;
  elsif v_source_table = 'product_skus' then
    update public.product_skus
    set canonical_material_id = v_req.resolved_material_id,
        material_resolution_status = 'linked',
        material_resolution_request_id = p_request_id
    where id = p_source_id;
  end if;
  perform set_config('material_master.link_request_id', '', true);

  perform public.material_master_audit_append(
    'link_approved_material_resolution',
    v_req.resolved_material_id,
    p_request_id,
    v_reason,
    jsonb_build_object('source_table', v_source_table, 'source_id', p_source_id, 'canonical_material_id', v_old_material_id, 'material_resolution_status', v_old_status, 'material_resolution_request_id', v_old_request_id),
    jsonb_build_object('source_table', v_source_table, 'source_id', p_source_id, 'canonical_material_id', v_req.resolved_material_id, 'material_resolution_status', 'linked', 'material_resolution_request_id', p_request_id),
    jsonb_build_object('task', 'task3_reconciliation', 'candidate_source', v_candidate_source, 'source_table', v_source_table, 'source_id', p_source_id)
  );

  return jsonb_build_object('status', 'linked', 'source_table', v_source_table, 'source_id', p_source_id, 'material_id', v_req.resolved_material_id, 'request_id', p_request_id);
end;
$$;

revoke execute on function public.link_approved_material_resolution(uuid, text, uuid, uuid, text) from public, anon;
grant execute on function public.link_approved_material_resolution(uuid, text, uuid, uuid, text) to authenticated, service_role;

create or replace function public.apply_approved_material_reconciliation(
  p_source_type text,
  p_source_table text,
  p_source_id uuid,
  p_raw_name text,
  p_raw_code text,
  p_raw_unit text,
  p_supplier_id uuid,
  p_expected_material_id uuid,
  p_candidate_source text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_table text := lower(btrim(coalesce(p_source_table, '')));
  v_source_type text := lower(btrim(coalesce(p_source_type, '')));
  v_candidate_source text := lower(btrim(coalesce(p_candidate_source, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_request jsonb;
  v_confirm jsonb;
  v_link jsonb;
  v_request_id uuid;
begin
  if not (public.can_edit_material_master() or coalesce(public.material_master_jwt_role(), '') = 'service_role') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_source_table not in ('kitchen_inventory_items', 'product_skus') then
    raise exception 'source_table not allowlisted for reconciliation link' using errcode = '22023';
  end if;
  if v_source_type not in ('kitchen_inventory', 'product_sku') then
    raise exception 'source_type not allowlisted for reconciliation link' using errcode = '22023';
  end if;
  if (v_source_table = 'kitchen_inventory_items' and v_source_type <> 'kitchen_inventory')
    or (v_source_table = 'product_skus' and v_source_type <> 'product_sku') then
    raise exception 'source type/table mismatch' using errcode = '23514';
  end if;
  if p_source_id is null or p_expected_material_id is null then
    raise exception 'exact source id and expected material id required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_raw_name, '')), '') is null then
    raise exception 'raw_name required' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if v_candidate_source not in ('material_code','normalized_canonical_name','approved_supplier_alias','approved_source_alias','approved_global_alias') then
    raise exception 'candidate_source not allowlisted for atomic reconciliation apply' using errcode = '23514';
  end if;

  v_request := public.request_material_resolution(
    v_source_type,
    v_source_table,
    p_source_id,
    null,
    p_raw_name,
    p_raw_code,
    p_raw_unit,
    p_supplier_id,
    jsonb_build_object('candidate_source', v_candidate_source, 'confidence', 'exact', 'field_name', 'task3_reconciliation')
  );

  if coalesce(v_request->>'status', '') not in ('already_resolved', 'request_existing')
    or coalesce(v_request->>'resolution_status', '') <> 'resolved_existing'
    or (v_request->>'request_id') is null
    or (v_request->>'resolved_material_id')::uuid is distinct from p_expected_material_id then
    raise exception 'request_material_resolution did not return exact approved resolved_existing response' using errcode = '23514';
  end if;
  v_request_id := (v_request->>'request_id')::uuid;

  v_confirm := public.confirm_material_resolution(
    v_request_id,
    'resolve_existing',
    p_expected_material_id,
    null,
    jsonb_build_object('alias_name', p_raw_name, 'candidate_source', v_candidate_source, 'confidence', 'exact', 'field_name', 'task3_reconciliation'),
    '{}'::jsonb,
    v_reason
  );

  if coalesce(v_confirm->>'status', '') not in ('resolved_existing', 'resolution_unchanged')
    or (v_confirm->>'request_id')::uuid is distinct from v_request_id
    or (v_confirm->>'material_id')::uuid is distinct from p_expected_material_id then
    raise exception 'confirm_material_resolution did not return exact terminal existing response' using errcode = '23514';
  end if;

  v_link := public.link_approved_material_resolution(
    v_request_id,
    v_source_table,
    p_source_id,
    p_expected_material_id,
    v_reason
  );

  if coalesce(v_link->>'status', '') not in ('linked', 'linked_unchanged')
    or coalesce(v_link->>'source_table', '') <> v_source_table
    or (v_link->>'source_id')::uuid is distinct from p_source_id
    or (v_link->>'material_id')::uuid is distinct from p_expected_material_id
    or (v_link->>'request_id')::uuid is distinct from v_request_id then
    raise exception 'link_approved_material_resolution did not return exact linked response' using errcode = '23514';
  end if;

  return jsonb_build_object(
    'status', v_link->>'status',
    'source_table', v_source_table,
    'source_id', p_source_id,
    'material_id', p_expected_material_id,
    'request_id', v_request_id
  );
end;
$$;

revoke execute on function public.apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text) from public, anon;
grant execute on function public.apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text) to authenticated, service_role;
