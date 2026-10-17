-- 2026-11-01 — Sửa mã chuẩn gắn sai + sổ Q7 nhận vật tư không phải nguyên liệu.
--
-- Thay đổi additive:
--   A. public.material_relinks — sổ audit relink (client chỉ được SELECT).
--   B. public.relink_item_material — owner di chuyển một item ĐÃ gắn sang một
--      material chuẩn khác, vẫn đi qua guard canonical-link hiện hữu. Không xoá
--      identity/lịch sử; alias tên sai chỉ bị tắt, mapping Q7 cũ bị rejected.
--   C. public.resolve_q7_canonical_inventory_item — item active đã skip với lý do
--      'not_material' được trả về mapping/canonical null, factor 1. Mọi nhánh
--      khác giữ nguyên, đặc biệt nguyên liệu chưa gắn vẫn raise
--      q7_canonical_link_required.
--
-- Migration này do Maestro apply; nó không tự apply.

-- ===========================================================================
-- A. Audit relink (server ghi, client chỉ đọc)
-- ===========================================================================

create table if not exists public.material_relinks (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.kitchen_inventory_items(id),
  old_material_id uuid,
  new_material_id uuid not null,
  old_request_id uuid,
  new_request_id uuid not null,
  reason text not null,
  request_id uuid not null unique,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

alter table public.material_relinks enable row level security;

drop policy if exists material_relinks_select on public.material_relinks;
create policy material_relinks_select on public.material_relinks
  for select to authenticated
  using (
    public.has_role(auth.uid(), 'owner')
    or public.can_edit_material_master()
  );

revoke all on table public.material_relinks from public, anon, authenticated;
grant select on table public.material_relinks to authenticated;
grant all on table public.material_relinks to service_role;

-- ===========================================================================
-- B. Owner relink RPC — guarded controller path
-- ===========================================================================

create or replace function public.relink_item_material(
  p_item_id uuid,
  p_material_id uuid,
  p_create_new boolean,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_old public.sku_cogs_materials%rowtype;
  v_target public.sku_cogs_materials%rowtype;
  v_existing public.material_relinks%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_name_norm text;
  v_candidate_source text;
  v_created boolean := false;
  v_created_json jsonb;
  v_target_material_code text;
  v_old_request_id uuid;
  v_request_key text;
  v_new_request_id uuid;
begin
  if not public.has_role(v_actor, 'owner') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  if p_item_id is null then
    raise exception 'item_required' using errcode = '22023';
  end if;
  if coalesce(p_create_new, false) and p_material_id is not null then
    raise exception 'exactly one of material or create required' using errcode = '22023';
  end if;
  if not coalesce(p_create_new, false) and p_material_id is null then
    raise exception 'exactly one of material or create required' using errcode = '22023';
  end if;

  -- Serialize replay on the caller request id so the audit row is the single
  -- idempotency source even under concurrent submission.
  perform pg_advisory_xact_lock(hashtext('material_relink:' || p_request_id::text));

  select * into v_existing
  from public.material_relinks
  where request_id = p_request_id;
  if found then
    select m.material_code into v_target_material_code
    from public.sku_cogs_materials m
    where m.id = v_existing.new_material_id;
    return jsonb_build_object(
      'item_id', v_existing.item_id,
      'old_material_id', v_existing.old_material_id,
      'new_material_id', v_existing.new_material_id,
      'new_material_code', v_target_material_code,
      'created_material', false,
      'replay', true
    );
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id
  for update;
  if not found
     or v_item.active is not true
     or v_item.merged_into_id is not null
     or v_item.canonical_material_id is null
     or v_item.material_resolution_status is distinct from 'linked' then
    raise exception 'item_not_linked' using errcode = '22023';
  end if;

  select * into v_old
  from public.sku_cogs_materials
  where id = v_item.canonical_material_id;
  if not found then
    raise exception 'item_not_linked' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.q7_inventory_movements m
    where m.kitchen_inventory_item_id = v_item.id
  ) then
    raise exception 'item_has_q7_movements' using errcode = '23514';
  end if;

  v_name_norm := public.material_master_normalize(v_item.name);
  if v_name_norm is null or v_name_norm = '' then
    raise exception 'item_name_required' using errcode = '22023';
  end if;

  -- Tạo mới qua controller chuẩn; nếu tên đã tồn tại thì tái dùng material active.
  if coalesce(p_create_new, false) then
    begin
      v_created_json := public.create_canonical_material(
        null, v_item.name, v_item.unit, null, null, null, v_reason, null
      );
    exception when unique_violation then
      v_created_json := null;
    end;
    if v_created_json is not null then
      v_created := true;
      select * into v_target
      from public.sku_cogs_materials
      where id = (v_created_json ->> 'material_id')::uuid;
    else
      select * into v_target
      from public.sku_cogs_materials
      where normalized_name = v_name_norm
      order by active desc, created_at, id
      limit 1;
      if not found then
        raise exception 'material_create_failed' using errcode = '23505';
      end if;
      if v_target.active is not true then
        raise exception 'material_inactive' using errcode = '23514';
      end if;
    end if;
  else
    select * into v_target
    from public.sku_cogs_materials
    where id = p_material_id;
    if not found then
      raise exception 'material_not_found' using errcode = 'P0002';
    end if;
    if v_target.active is not true then
      raise exception 'material_inactive' using errcode = '23514';
    end if;
  end if;

  if v_target.id = v_old.id then
    raise exception 'same_material' using errcode = '23514';
  end if;

  if v_target.normalized_name = v_name_norm then
    v_candidate_source := 'normalized_canonical_name';
  else
    v_candidate_source := 'approved_global_alias';
  end if;

  -- Request terminal resolved_existing để guard canonical-link chỉ cho phép đúng
  -- giao dịch này đi qua. new_request_id là request mới của lần relink.
  v_old_request_id := v_item.material_resolution_request_id;
  v_request_key := md5(
      'material_relink:' || p_request_id::text || ':' || v_item.id::text || ':' || v_target.id::text
    ) || md5(
      'material_relink:' || v_target.id::text || ':' || p_request_id::text || ':' || v_item.id::text
    );

  insert into public.material_resolution_requests(
    request_key, source_type, source_table, source_id, raw_name, raw_code, raw_unit,
    normalized_name, candidate_material_ids, safe_payload, status, candidate_status,
    resolved_material_id, reviewer_id, reviewer_reason, reviewed_at, created_by
  ) values (
    v_request_key, 'kitchen_inventory', 'kitchen_inventory_items', v_item.id,
    btrim(v_item.name), v_item.item_code, v_item.unit, v_name_norm,
    array[v_target.id],
    jsonb_build_object(
      'candidate_source', v_candidate_source,
      'confidence', 'exact',
      'field_name', 'task3_reconciliation'
    ),
    'resolved_existing', null, v_target.id, v_actor, v_reason, now(), v_actor
  )
  returning id into v_new_request_id;

  perform set_config('material_master.link_request_id', v_new_request_id::text, true);
  update public.kitchen_inventory_items
  set canonical_material_id = v_target.id,
      material_resolution_status = 'linked',
      material_resolution_request_id = v_new_request_id
  where id = v_item.id;
  perform set_config('material_master.link_request_id', '', true);

  -- Tên món đang bị alias cũ giữ sai. Chỉ tắt alias khi không còn item active
  -- cùng tên vẫn gắn material cũ; không xoá alias hay bất kỳ identity nào.
  if not exists (
    select 1
    from public.kitchen_inventory_items k
    where k.active = true
      and k.merged_into_id is null
      and k.id <> v_item.id
      and k.canonical_material_id = v_old.id
      and public.material_master_normalize(k.name) = v_name_norm
  ) then
    update public.sku_cogs_material_aliases
    set active = false
    where material_id = v_old.id
      and normalized_alias = v_name_norm
      and active = true;

    update public.material_scoped_aliases
    set active = false
    where material_id = v_old.id
      and normalized_alias = v_name_norm
      and active = true
      and approved = true
      and supplier_id is null;
  end if;

  -- Mapping Q7 riêng của item trỏ material cũ không còn đúng; đánh dấu rejected
  -- (không xoá) để resolver không dùng lại.
  update public.q7_material_issue_material_mappings
  set approval_status = 'rejected',
      notes = concat_ws(
        ' · ',
        nullif(btrim(coalesce(notes, '')), ''),
        'Owner relink sang ' || v_target.material_code || ': ' || v_reason
      ),
      updated_by = v_actor,
      updated_at = now()
  where kitchen_inventory_item_id = v_item.id
    and canonical_material_id = v_old.id
    and approval_status = 'approved';

  insert into public.material_relinks(
    item_id, old_material_id, new_material_id, old_request_id, new_request_id,
    reason, request_id, created_by
  ) values (
    v_item.id, v_old.id, v_target.id, v_old_request_id, v_new_request_id,
    v_reason, p_request_id, v_actor
  );

  return jsonb_build_object(
    'item_id', v_item.id,
    'old_material_id', v_old.id,
    'new_material_id', v_target.id,
    'new_material_code', v_target.material_code,
    'created_material', v_created,
    'replay', false
  );
end;
$$;

revoke all on function public.relink_item_material(uuid, uuid, boolean, text, uuid)
  from public, anon;
grant execute on function public.relink_item_material(uuid, uuid, boolean, text, uuid)
  to authenticated, service_role;

-- Guard canonical-link so sánh current_user với owner của
-- link_approved_material_resolution. Các migration trước không ALTER owner nên
-- function mới thường đã cùng owner; chỉ đổi khi môi trường apply khác owner.
do $$
declare
  v_link_owner oid;
  v_relink_owner oid;
begin
  select p.proowner into v_link_owner
  from pg_proc p
  where p.oid = 'public.link_approved_material_resolution(uuid, text, uuid, uuid, text)'::regprocedure;

  select p.proowner into v_relink_owner
  from pg_proc p
  where p.oid = 'public.relink_item_material(uuid, uuid, boolean, text, uuid)'::regprocedure;

  if v_link_owner is not null and v_relink_owner is distinct from v_link_owner then
    execute format(
      'alter function public.relink_item_material(uuid, uuid, boolean, text, uuid) owner to %I',
      pg_get_userbyid(v_link_owner)
    );
  end if;
end $$;

-- ===========================================================================
-- C. Resolver: item active đã skip 'not_material' là vật tư, không phải NVL
-- ===========================================================================

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
     and exists (
       select 1
       from public.material_link_skips s
       where s.item_id = v_item.id
         and s.reason = 'not_material'
     ) then
    return query select
      v_item.id::uuid,
      v_item.unit::text,
      null::uuid,
      null::uuid,
      null::text,
      null::text,
      null::text,
      v_item.unit::text,
      1::numeric;
    -- RETURN QUERY does not leave the function; stop here so the canonical
    -- checks below never run for a not_material supply.
    return;
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

revoke all on function public.resolve_q7_canonical_inventory_item(uuid, text)
  from public, anon, authenticated, service_role;

-- record_q7_inventory_adjustment / record_q7_inventory_receipt /
-- backfill_q7_inventory_opening stay unchanged: their newest bodies write the
-- resolver's q7_mapping_id/canonical_material_id into nullable ledger columns
-- and never join/dereference those columns in a not-null write path.
