-- 2026-11-01 — "Gắn mã chuẩn" conflict fix (owner 15/10).
--
-- Bối cảnh (Maestro thu thập live trong transaction rollback):
--   * link_item_material gặp 409 material_name_conflict khi tên món kho
--     material_master_normalize(name) trùng normalized_name của MỘT material
--     active KHÁC với material chủ đã chọn, và material_alias_conflict khi tên
--     đó là alias toàn cục của material khác. 15 cặp món/ứng viên đang fail.
--   * link_exact_materials(p_location, p_request_id) luôn fail
--     'cannot extract elements from an object' vì FOR chạy trên
--     jsonb_array_elements(cả object review) thay vì -> 'items'.
--   * Ứng viên rác từ luật "cùng đơn vị + chung một từ": 'Phô mai 84 lát ...'
--     nhận 'Bánh mì tươi', 'Bao xốp', 'Bột lúa mạch đen 567gr'; 'Dầu Hướng
--     Dương…' nhận 'Đường', 'SỮA ĐC ĐƯỜNG…'; 'Nước rửa chén Gift 3.8l' nhận
--     'NƯỚC ĐÁ', 'Nước uống Vĩnh Hảo'.
--   * get_my_missions mất 3.8 s vì mission_evaluate(material_links_done) tính
--     lại cả review hai lần.
--
-- Migration này:
--   A. resolve_canonical_material — thêm cờ giao dịch
--      material_master.force_material_id. Khi cờ bật (chỉ q7 bật, chỉ trong
--      nhánh alias_skipped), trả thẳng material chủ đã chọn là resolved_exact
--      để request đi thẳng trạng thái resolved_existing; confirm bỏ qua tạo
--      alias (early-return) và không còn gửi tên món làm bằng chứng alias.
--      Khi cờ tắt, hành vi giữ nguyên tuyệt đối cho mọi caller khác.
--   B. q7_link_item_material_internal — nhánh v_target.normalized_name <>
--      v_master_norm KHÔNG còn raise material_name_conflict /
--      material_alias_conflict. Thay bằng alias_skipped = true +
--      alias_owner_material_code (material_code của material đang giữ tên) và
--      KHÔNG ghi alias toàn cục cho tên đó. Kết quả jsonb thêm alias_skipped +
--      alias_owner_material_code.
--   C. link_exact_materials — duyệt jsonb_array_elements(v_review -> 'items').
--   D. material_link_review_items_internal — luật "cùng đơn vị + chung từ"
--      dùng token accent-free chữ thường dài >= 2 sau khi gộp cụm
--      'huong duong' thành 'huongduong', bỏ stopword và token toàn số /
--      số+đơn vị; chỉ nhận ứng viên cùng đơn vị khi (chung >= 1 token nghĩa và
--      score >= 0.1) HOẶC chung >= 2 token nghĩa. Thêm material active có
--      normalized_name = material_master_normalize(item.name) vào ứng viên nếu
--      chưa có (thay ứng viên cuối khi đã đủ 3).
--   E. material_link_counts_internal — đếm set-based cho mission_evaluate;
--      mission_evaluate(material_links_done) dùng nó thay vì tính lại review.
--
-- Migration này do Maestro apply; nó không tự apply.

-- ===========================================================================
-- A. resolve_canonical_material — cờ force (chỉ q7 bật, mặc định tắt)
-- ===========================================================================

create or replace function public.resolve_canonical_material(
  p_raw_name text,
  p_raw_code text default null,
  p_raw_unit text default null,
  p_supplier_id uuid default null,
  p_source_type text default null,
  p_effective_date date default current_date,
  p_required_capabilities text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text := public.material_master_normalize(p_raw_name);
  v_source_type text := nullif(lower(btrim(coalesce(p_source_type, ''))), '');
  v_match public.sku_cogs_materials%rowtype;
  v_source text;
  v_ready jsonb;
  v_blockers text[];
  v_candidates uuid[];
  v_force text := nullif(current_setting('material_master.force_material_id', true), '');
  v_forced public.sku_cogs_materials%rowtype;
begin
  -- Forced material (transaction-local, only set by q7_link_item_material_internal
  -- when the picked material does not own the item name). This keeps the
  -- controller path: the request is created already resolved_existing so
  -- confirm_material_resolution early-returns and never writes the conflicting
  -- name/alias. When the flag is unset behaviour is untouched.
  if v_force is not null
     and v_force ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_forced
    from public.sku_cogs_materials m
    where m.id = v_force::uuid
    limit 1;
    if found and v_forced.active then
      return jsonb_build_object(
        'status', 'resolved_exact',
        'resolved_exact', true,
        'match_source', 'forced',
        'material_id', v_forced.id,
        'material_code', v_forced.material_code,
        'canonical_name', v_forced.canonical_name,
        'default_unit', v_forced.default_unit
      );
    end if;
  end if;

  -- match_source precedence markers: material_code, normalized_name, approved_supplier_alias, approved_source_alias, approved_global_alias.
  -- fuzzy / ai_candidate suggestions are intentionally candidate-only and fail-closed:
  -- they may return confirmation_needed/ambiguous/not_found but never resolved_exact.
  if nullif(btrim(coalesce(p_raw_code, '')), '') is not null then
    select * into v_match from public.sku_cogs_materials m where lower(btrim(m.material_code)) = lower(btrim(p_raw_code)) order by m.active desc limit 1;
    if found then v_source := 'material_code'; end if;
  end if;
  if v_match.id is null and v_norm <> '' then
    select * into v_match from public.sku_cogs_materials m where m.normalized_name = v_norm order by m.active desc limit 1;
    if found then v_source := 'normalized_name'; end if;
  end if;
  if v_match.id is null and p_supplier_id is not null and v_norm <> '' then
    select m.* into v_match
    from public.material_scoped_aliases a join public.sku_cogs_materials m on m.id = a.material_id
    where a.supplier_id = p_supplier_id and a.normalized_alias = v_norm and a.active = true and a.approved = true
    order by m.active desc, a.created_at desc limit 1;
    if found then v_source := 'approved_supplier_alias'; end if;
  end if;
  if v_match.id is null and p_supplier_id is null and v_source_type is not null and v_norm <> '' then
    select m.* into v_match
    from public.material_scoped_aliases a join public.sku_cogs_materials m on m.id = a.material_id
    where a.supplier_id is null and a.source_type = v_source_type and a.normalized_alias = v_norm and a.active = true and a.approved = true
    order by m.active desc, a.created_at desc limit 1;
    if found then v_source := 'approved_source_alias'; end if;
  end if;
  if v_match.id is null and v_norm <> '' then
    select m.* into v_match
    from public.sku_cogs_material_aliases a join public.sku_cogs_materials m on m.id = a.material_id
    where a.normalized_alias = v_norm and a.active = true and a.source in ('canonical_name','existing_cogs','approved_peerless_alias','approved_global_alias','approved')
    order by m.active desc, a.created_at desc limit 1;
    if found then v_source := 'approved_global_alias'; end if;
  end if;

  if v_match.id is not null then
    if not v_match.active then
      return jsonb_build_object('status','inactive','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'material_code',v_match.material_code);
    end if;
    v_ready := public.assert_material_ready(v_match.id, coalesce(p_required_capabilities, '{}'::text[]), p_supplier_id, p_raw_unit, p_effective_date);
    v_blockers := array(select jsonb_array_elements_text(v_ready->'blockers'));
    if 'unit_unmapped' = any(v_blockers) then
      return jsonb_build_object('status','unit_unmapped','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'blockers',v_ready->'blockers');
    end if;
    if 'supplier_unmapped' = any(v_blockers) then
      return jsonb_build_object('status','supplier_unmapped','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'blockers',v_ready->'blockers');
    end if;
    if (v_ready->>'ready')::boolean is false then
      return jsonb_build_object('status','confirmation_needed','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'blockers',v_ready->'blockers');
    end if;
    return jsonb_build_object('status','resolved_exact','resolved_exact',true,'match_source',v_source,'material_id',v_match.id,'material_code',v_match.material_code,'canonical_name',v_match.canonical_name,'default_unit',v_match.default_unit);
  end if;

  select coalesce(array_agg(id order by canonical_name), '{}'::uuid[]) into v_candidates
  from public.sku_cogs_materials
  where v_norm <> '' and active = true and normalized_name like v_norm || '%';
  if cardinality(v_candidates) > 1 then
    return jsonb_build_object('status','ambiguous','resolved_exact',false,'candidates',v_candidates,'fail_closed',true);
  elsif cardinality(v_candidates) = 1 then
    return jsonb_build_object('status','confirmation_needed','resolved_exact',false,'candidates',v_candidates,'fail_closed',true);
  end if;
  return jsonb_build_object('status','not_found','resolved_exact',false,'candidates','[]'::jsonb,'fail_closed',true);
end;
$$;

revoke execute on function public.resolve_canonical_material(text, text, text, uuid, text, date, text[]) from public, anon;
grant execute on function public.resolve_canonical_material(text, text, text, uuid, text, date, text[]) to authenticated, service_role;

-- ===========================================================================
-- B. q7_link_item_material_internal — không còn raise conflict, ghi nhận alias
--    bị bỏ qua và ép controller resolve đúng material chủ đã chọn
-- ===========================================================================

create or replace function public.q7_link_item_material_internal(
  p_item_id uuid,
  p_material_id uuid,
  p_create_new boolean,
  p_request_id uuid,
  p_unit_factor numeric default null,
  p_defer_factor boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_target public.sku_cogs_materials%rowtype;
  v_master_norm text;
  v_candidate_source text;
  v_created boolean := false;
  v_created_json jsonb;
  v_apply jsonb;
  v_existing_alias public.sku_cogs_material_aliases%rowtype;
  v_reason text := 'Liên kết NVL Q7 với Material Master';
  v_item_unit text;
  v_mat_unit text;
  v_conv_factor numeric;
  v_conv_source text;
  v_defer boolean := false;
  v_alias_skipped boolean := false;
  v_alias_owner text;
  v_alias_owner_id uuid;
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
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

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id
  for update;
  if not found then
    raise exception 'item_not_eligible' using errcode = '22023';
  end if;
  if v_item.active is not true
     or v_item.merged_into_id is not null
     or v_item.canonical_material_id is not null then
    raise exception 'item_not_eligible' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.material_link_skips s where s.item_id = v_item.id
  ) then
    raise exception 'item_not_eligible' using errcode = '22023';
  end if;

  v_master_norm := public.material_master_normalize(v_item.name);
  if v_master_norm is null or v_master_norm = '' then
    raise exception 'item_name_required' using errcode = '22023';
  end if;

  -- Tạo mới qua controller chuẩn; nếu tên đã tồn tại thì tái dùng vật liệu đang có.
  if coalesce(p_create_new, false) then
    begin
      v_created_json := public.create_canonical_material(
        null, v_item.name, v_item.unit, null, null, null, v_reason, null  -- audit request_id must reference material_resolution_requests
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
      where normalized_name = v_master_norm
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
    select * into v_target from public.sku_cogs_materials where id = p_material_id;
    if not found then
      raise exception 'material_not_found' using errcode = 'P0002';
    end if;
    if v_target.active is not true then
      raise exception 'material_inactive' using errcode = '23514';
    end if;
  end if;

  if v_item.canonical_material_id is not null then
    if v_item.canonical_material_id = v_target.id then
      return jsonb_build_object(
        'item_id', v_item.id,
        'material_id', v_target.id,
        'material_code', v_target.material_code,
        'canonical_name', v_target.canonical_name,
        'created_material', false,
        'factor_pending', public.material_link_is_factor_pending(v_item.id),
        'request_id', v_item.material_resolution_request_id,
        'alias_skipped', false,
        'alias_owner_material_code', null
      );
    end if;
    raise exception 'item_already_linked' using errcode = '23505';
  end if;

  if v_target.normalized_name = v_master_norm then
    v_candidate_source := 'normalized_canonical_name';
  else
    -- Material chủ đã chọn KHÔNG giữ tên của món. Tên đó có thể thuộc một
    -- material active khác, một alias "source" (supplier null) khác, hoặc một
    -- alias toàn cục khác. Trước đây nhánh này raise 409; giờ ghi nhận chủ sở
    -- hữu tên (alias_owner_material_code) và KHÔNG ghi alias toàn cục cho tên
    -- này. Controller vẫn chạy nhưng được ép resolve đúng material chủ đã chọn
    -- qua material_master.force_material_id nên confirm không ghi alias.
    select m.id, m.material_code into v_alias_owner_id, v_alias_owner
    from public.sku_cogs_materials m
    where m.active = true
      and m.normalized_name = v_master_norm
      and m.id <> v_target.id
    order by m.created_at, m.id
    limit 1;

    if v_alias_owner_id is null then
      select a.material_id into v_alias_owner_id
      from public.material_scoped_aliases a
      where a.supplier_id is null
        and a.active = true
        and a.approved = true
        and a.normalized_alias = v_master_norm
        and a.material_id <> v_target.id
      order by a.created_at, a.id
      limit 1;
    end if;

    if v_alias_owner_id is null then
      select a.material_id into v_alias_owner_id
      from public.sku_cogs_material_aliases a
      where a.normalized_alias = v_master_norm
        and a.material_id <> v_target.id
      order by a.created_at, a.id
      limit 1;
    end if;

    if v_alias_owner_id is not null then
      v_alias_skipped := true;
      if v_alias_owner is null then
        select m.material_code into v_alias_owner
        from public.sku_cogs_materials m
        where m.id = v_alias_owner_id;
      end if;
    else
      select * into v_existing_alias
      from public.sku_cogs_material_aliases a
      where a.normalized_alias = v_master_norm;
      if found then
        if v_existing_alias.material_id <> v_target.id then
          -- Should not be reachable: the owner scan above already caught this.
          v_alias_skipped := true;
          select m.material_code into v_alias_owner
          from public.sku_cogs_materials m
          where m.id = v_existing_alias.material_id;
        end if;
      else
        insert into public.sku_cogs_material_aliases(
          material_id, alias_name, normalized_alias, source, active, created_by
        ) values (
          v_target.id, btrim(v_item.name), v_master_norm, 'approved_global_alias', true, v_actor
        );
      end if;
    end if;
    v_candidate_source := 'approved_global_alias';
  end if;

  -- Bảo đảm Material Master thấy được quy đổi đơn vị kho → đơn vị chuẩn trước khi
  -- liên kết. Cùng đơn vị → không cần quy đổi. Cặp chuẩn g/kg, ml/l → tự tính hệ
  -- số. Cặp khác → cần p_unit_factor > 0; nếu chủ chọn "để sau" (p_defer_factor =
  -- true) thì KHÔNG ghi public.material_unit_conversions mà ghi pending.
  v_item_unit := lower(btrim(coalesce(v_item.unit, '')));
  v_mat_unit := lower(btrim(coalesce(v_target.default_unit, '')));
  if v_item_unit <> '' and v_mat_unit <> '' and v_item_unit <> v_mat_unit then
    v_conv_factor := public.q7_unit_factor(v_item.unit, v_target.default_unit);
    if v_conv_factor is not null then
      v_conv_source := 'standard_auto';
    elsif p_unit_factor is not null
          and p_unit_factor > 0
          and p_unit_factor::text not in ('NaN', 'Infinity', '-Infinity') then
      v_conv_factor := p_unit_factor;
      v_conv_source := 'owner_factor';
    elsif coalesce(p_defer_factor, false) then
      -- Defer: bỏ qua ghi quy đổi và bỏ qua unit_factor_required. Controller
      -- Material Master vẫn cần một dòng quy đổi để assert_material_ready đi qua,
      -- nên mở cờ giao dịch đúng trong lúc gọi apply rồi tắt ngay sau đó.
      v_defer := true;
      v_conv_source := 'owner_factor_deferred';
    else
      raise exception 'unit_factor_required' using errcode = '22023';
    end if;

    if v_conv_factor is not null and not v_defer then
      if not exists (
        select 1 from public.material_unit_conversions c
        where c.material_id = v_target.id
          and c.active = true
          and c.approved = true
          and lower(btrim(c.from_unit)) = v_item_unit
          and lower(btrim(c.to_unit)) = v_mat_unit
          and c.effective_from <= current_date
          and (c.effective_to is null or c.effective_to >= current_date)
      ) then
        insert into public.material_unit_conversions (
          material_id, from_unit, to_unit, factor, effective_from,
          source_type, source_id, approved, approved_by, approved_at,
          active, metadata, created_by
        ) values (
          v_target.id, btrim(v_item.unit), btrim(v_target.default_unit), v_conv_factor, current_date,
          'q7_material_link', v_item.id,
          true, v_actor, now(), true,
          jsonb_build_object(
            'reason', v_reason,
            'item_id', v_item.id,
            'item_unit', v_item.unit,
            'material_unit', v_target.default_unit,
            'factor_source', v_conv_source
          ),
          v_actor
        );
      end if;
    end if;
  end if;

  -- request resolved_existing + link đi qua controller Material Master hiện hữu.
  -- Khi tên món thuộc material khác (alias_skipped), ép resolve về material chủ
  -- đã chọn; request được tạo thẳng resolved_existing nên confirm early-return,
  -- không ghi tên món thành alias và không chạm conflict cũ.
  if v_defer then
    perform set_config('material_master.defer_unit', 'on', true);
  end if;
  if v_alias_skipped then
    perform set_config('material_master.force_material_id', v_target.id::text, true);
  end if;
  begin
    v_apply := public.apply_approved_material_reconciliation(
      'kitchen_inventory',
      'kitchen_inventory_items',
      v_item.id,
      v_item.name,
      v_item.item_code,
      v_item.unit,
      null,
      v_target.id,
      v_candidate_source,
      v_reason
    );
  exception when others then
    if v_defer then
      perform set_config('material_master.defer_unit', '', true);
    end if;
    if v_alias_skipped then
      perform set_config('material_master.force_material_id', '', true);
    end if;
    raise;
  end;
  if v_defer then
    perform set_config('material_master.defer_unit', '', true);
  end if;
  if v_alias_skipped then
    perform set_config('material_master.force_material_id', '', true);
  end if;

  if coalesce(v_apply ->> 'status', '') not in ('linked', 'linked_unchanged')
     or (v_apply ->> 'material_id')::uuid is distinct from v_target.id then
    raise exception 'q7_material_link_failed' using errcode = '23514';
  end if;

  if v_defer then
    insert into public.material_link_pending_factors (item_id, material_id, created_by, created_at)
    values (v_item.id, v_target.id, v_actor, now())
    on conflict (item_id) do update
      set material_id = excluded.material_id,
          created_by = excluded.created_by,
          created_at = excluded.created_at;
  else
    -- Có hệ số (chủ nhập hoặc tự tính) hoặc cùng đơn vị → không còn pending.
    delete from public.material_link_pending_factors where item_id = v_item.id;
  end if;

  return jsonb_build_object(
    'item_id', v_item.id,
    'material_id', v_target.id,
    'material_code', v_target.material_code,
    'canonical_name', v_target.canonical_name,
    'created_material', v_created,
    'factor_pending', v_defer,
    'request_id', (v_apply ->> 'request_id')::uuid,
    'alias_skipped', v_alias_skipped,
    'alias_owner_material_code', case when v_alias_skipped then v_alias_owner else null end
  );
end;
$$;

revoke execute on function public.q7_link_item_material_internal(uuid, uuid, boolean, uuid, numeric, boolean) from public, anon, authenticated, service_role;

-- ===========================================================================
-- C. link_exact_materials — duyệt đúng jsonb_array_elements(v_review -> 'items')
-- ===========================================================================

create or replace function public.link_exact_materials(p_location text, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.q7_material_link_requests%rowtype;
  v_review jsonb;
  v_item record;
  v_linked integer := 0;
  v_needs_factor jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_result jsonb;
  v_inserted uuid;
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  if lower(btrim(coalesce(p_location, ''))) not in ('q7', 'tan_tao') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;
  select * into v_existing
  from public.q7_material_link_requests
  where request_id = p_request_id;
  if found then
    return v_existing.result;
  end if;

  v_review := public.material_link_review_items_internal(p_location);

  for v_item in
    select e ->> 'item_id' as item_id,
           e ->> 'name' as name,
           e ->> 'unit' as unit,
           (e -> 'exact_material' ->> 'id')::uuid as material_id,
           e -> 'exact_material' ->> 'default_unit' as material_unit,
           e ->> 'unit_status' as unit_status,
           nullif(e ->> 'factor_suggestion', '')::numeric as factor_suggestion
    from jsonb_array_elements(v_review -> 'items') e
    where e -> 'exact_material' is not null
      and e -> 'exact_material' <> 'null'::jsonb
    order by e ->> 'name', e ->> 'item_id'
  loop
    if v_item.material_id is null then
      continue;
    end if;
    if v_item.unit_status = 'needs_factor' then
      v_needs_factor := v_needs_factor || jsonb_build_array(
        jsonb_build_object(
          'item_id', v_item.item_id,
          'name', v_item.name,
          'unit', v_item.unit,
          'material_unit', v_item.material_unit,
          'factor_suggestion', v_item.factor_suggestion
        )
      );
      continue;
    end if;

    begin
      perform public.q7_link_item_material_internal(
        v_item.item_id::uuid, v_item.material_id, false, p_request_id, null, false
      );
      v_linked := v_linked + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_array(
        jsonb_build_object('item_id', v_item.item_id, 'name', v_item.name, 'error', sqlerrm)
      );
    end;
  end loop;

  v_result := jsonb_build_object(
    'linked', v_linked,
    'needs_factor', v_needs_factor,
    'failed', v_failed
  );
  insert into public.q7_material_link_requests(request_id, actor_id, item_id, material_id, result)
  values (p_request_id, v_actor, null, null, v_result)
  on conflict (request_id) do nothing
  returning request_id into v_inserted;
  if v_inserted is null then
    select * into v_existing
    from public.q7_material_link_requests
    where request_id = p_request_id;
    if found then
      return v_existing.result;
    end if;
  end if;
  return v_result;
end;
$$;

revoke execute on function public.link_exact_materials(text, uuid) from public, anon;
grant execute on function public.link_exact_materials(text, uuid) to authenticated, service_role;

-- ===========================================================================
-- D. material_link_review_items_internal — luật "cùng đơn vị + chung từ"
--    theo token nghĩa, và luôn kèm material trùng normalized_name của món
-- ===========================================================================

create or replace function public.material_link_review_items_internal(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_location text := lower(btrim(coalesce(p_location, '')));
  v_item_ids uuid[];
  v_item_codes text[];
  v_item_names text[];
  v_item_units text[];
  v_item_count integer;
  v_i integer;
  v_item_id uuid;
  v_item_code text;
  v_item_name text;
  v_item_unit text;
  v_item_words text[];
  v_uid text;
  v_norm text;
  v_master_norm text;
  v_mat_ids uuid[];
  v_mat_codes text[];
  v_mat_names text[];
  v_mat_units text[];
  v_mat_norms text[];
  v_mat_words jsonb[];
  v_mat_skus jsonb[];
  v_unit_map jsonb := '{}'::jsonb;
  v_exact_count integer;
  v_material_unit text;
  v_unit_status text;
  v_auto_factor numeric;
  v_factor_suggestion numeric;
  v_exact_material jsonb;
  v_master_exact jsonb;
  v_candidates jsonb;
  v_items jsonb := '[]'::jsonb;
  v_total integer := 0;
  v_exact integer := 0;
  v_auto integer := 0;
  v_needs_factor integer := 0;
  v_none integer := 0;
  v_linked_total integer := 0;
  v_skipped integer := 0;
  v_pending_factor integer := 0;
begin
  if v_location not in ('q7', 'tan_tao') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;

  -- (1) Material set, computed once per call: canonical name, stored accent-free
  --     normalized name, meaningful name tokens and fed SKUs are materialized
  --     here so the item loop never recomputes them.
  select
    array_agg(m.id order by m.id),
    array_agg(m.material_code order by m.id),
    array_agg(m.canonical_name order by m.id),
    array_agg(m.default_unit order by m.id),
    array_agg(m.normalized_name order by m.id),
    array_agg(to_jsonb(coalesce((
      select array_agg(distinct w order by w)
      from unnest(regexp_split_to_array(
             regexp_replace(lower(extensions.unaccent(coalesce(m.canonical_name, ''))), 'huong\s+duong', 'huongduong', 'g'),
             '[^a-z0-9]+'
           )) w
      where length(w) >= 2
        and w <> all (array['thung','khoi','goi','hop','chai','binh','bich','tui','bao','can','cay','cuon','lon','hu','kg','gr','gram','ml','lit','l','g','cai','chiec','loai','dac','biet','nhap','khau','nuoc','x','va','voi','cho','lam','banh','mi','lat','trang','den','tuoi','xop']::text[])
        and w !~ '^[0-9]'
    ), '{}'::text[])) order by m.id),
    array_agg(public.material_link_material_skus(m.material_code) order by m.id)
  into v_mat_ids, v_mat_codes, v_mat_names, v_mat_units, v_mat_norms, v_mat_words, v_mat_skus
  from public.sku_cogs_materials m
  where m.active = true;

  v_mat_ids := coalesce(v_mat_ids, '{}'::uuid[]);
  v_mat_codes := coalesce(v_mat_codes, '{}'::text[]);
  v_mat_names := coalesce(v_mat_names, '{}'::text[]);
  v_mat_units := coalesce(v_mat_units, '{}'::text[]);
  v_mat_norms := coalesce(v_mat_norms, '{}'::text[]);
  v_mat_words := coalesce(v_mat_words, '{}'::jsonb[]);
  v_mat_skus := coalesce(v_mat_skus, '{}'::jsonb[]);

  -- (2) Item set for the location, computed once per call.
  select
    array_agg(kii.id order by kii.name, kii.id),
    array_agg(kii.item_code order by kii.name, kii.id),
    array_agg(kii.name order by kii.name, kii.id),
    array_agg(kii.unit order by kii.name, kii.id)
  into v_item_ids, v_item_codes, v_item_names, v_item_units
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.canonical_material_id is null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    )
    and not exists (
      select 1 from public.material_link_skips s where s.item_id = kii.id
    );

  v_item_ids := coalesce(v_item_ids, '{}'::uuid[]);
  v_item_codes := coalesce(v_item_codes, '{}'::text[]);
  v_item_names := coalesce(v_item_names, '{}'::text[]);
  v_item_units := coalesce(v_item_units, '{}'::text[]);
  v_item_count := coalesce(array_length(v_item_ids, 1), 0);

  -- (3) Unit-status map: one call per (distinct item unit × distinct material
  --     default_unit) pair, keyed by the normalized units used everywhere below.
  select coalesce(jsonb_object_agg(p.pair_key, p.unit_status), '{}'::jsonb)
  into v_unit_map
  from (
    select iu.unit_norm || '|' || mu.unit_norm as pair_key,
           public.q7_unit_status(iu.unit_norm, mu.unit_norm) as unit_status
    from (
      select distinct lower(btrim(coalesce(u, ''))) as unit_norm
      from unnest(v_item_units) u
    ) iu
    cross join (
      select distinct lower(btrim(coalesce(m.default_unit, ''))) as unit_norm
      from public.sku_cogs_materials m
      where m.active = true
    ) mu
  ) p;

  for v_i in 1 .. v_item_count loop
    v_item_id := v_item_ids[v_i];
    v_item_code := v_item_codes[v_i];
    v_item_name := v_item_names[v_i];
    v_item_unit := v_item_units[v_i];
    v_uid := lower(btrim(coalesce(v_item_unit, '')));
    v_norm := public.normalize_stock_item_name(v_item_name);
    v_master_norm := public.material_master_normalize(v_item_name);

    -- Token nghĩa: accent-free, chữ thường, >= 2 ký tự, sau khi gộp cụm
    -- 'huong duong' thành 'huongduong'; bỏ stopword và token toàn số / số+đơn vị
    -- (2l, 567gr, 3.8l, 1kg…). Chỉ dùng cho luật cùng đơn vị + chung từ.
    v_item_words := coalesce((
      select array_agg(distinct w order by w)
      from unnest(regexp_split_to_array(
             regexp_replace(lower(extensions.unaccent(coalesce(v_item_name, ''))), 'huong\s+duong', 'huongduong', 'g'),
             '[^a-z0-9]+'
           )) w
      where length(w) >= 2
        and w <> all (array['thung','khoi','goi','hop','chai','binh','bich','tui','bao','can','cay','cuon','lon','hu','kg','gr','gram','ml','lit','l','g','cai','chiec','loai','dac','biet','nhap','khau','nuoc','x','va','voi','cho','lam','banh','mi','lat','trang','den','tuoi','xop']::text[])
        and w !~ '^[0-9]'
    ), '{}'::text[]);

    v_exact_material := null;
    v_master_exact := null;
    v_material_unit := null;
    v_unit_status := null;
    v_auto_factor := null;
    v_factor_suggestion := null;

    -- (4) One pass over the material set: the name similarity is evaluated once
    --     per material here, then the exact pair, the score-ranked candidates and
    --     the same-unit meaningful-word candidates are all derived from these
    --     rows (dedupe by material with max(score)).
    select s.exact_count, s.exact_material, s.master_exact, s.candidates
    into v_exact_count, v_exact_material, v_master_exact, v_candidates
    from (
      with base as materialized (
        select
          mm.id,
          mm.material_code,
          mm.canonical_name,
          mm.default_unit,
          mm.skus,
          st.unit_status,
          (v_norm is not null and mm.norm = v_norm) as is_exact,
          (v_master_norm is not null and mm.norm = v_master_norm) as is_master_exact,
          case
            when v_norm is not null and mm.norm = v_norm then 1::numeric
            else public.q7_material_name_similarity(v_item_name, mm.canonical_name)
          end as score,
          (select count(*)::int
             from unnest(v_item_words) w
            where w in (select jsonb_array_elements_text(mm.words))) as shared_words
        from unnest(
          v_mat_ids, v_mat_codes, v_mat_names, v_mat_units, v_mat_norms, v_mat_words, v_mat_skus
        ) as mm(id, material_code, canonical_name, default_unit, norm, words, skus)
        cross join lateral (
          select v_unit_map ->> (v_uid || '|' || lower(btrim(coalesce(mm.default_unit, '')))) as unit_status
        ) st
      ),
      candidates as (
        select
          g.id, g.material_code, g.canonical_name, g.default_unit, g.unit_status, g.score
        from (
          select
            u.id, u.material_code, u.canonical_name, u.default_unit, u.unit_status,
            max(u.score) as score, max(u.shared_words) as shared_words
          from (
            select id, material_code, canonical_name, default_unit, unit_status, score, shared_words
            from base
            where is_exact
            union all
            select id, material_code, canonical_name, default_unit, unit_status, score, shared_words
            from base
          ) u
          group by u.id, u.material_code, u.canonical_name, u.default_unit, u.unit_status
        ) g
        where g.score >= 0.3
           or (g.unit_status = 'same' and g.shared_words >= 2)
           or (g.unit_status = 'same' and g.shared_words >= 1 and g.score >= 0.1)
      )
      select
        (select count(*) from base where is_exact) as exact_count,
        (select jsonb_build_object(
                  'id', b.id,
                  'material_code', b.material_code,
                  'canonical_name', b.canonical_name,
                  'default_unit', b.default_unit,
                  'skus', b.skus
                )
           from base b
          where b.is_exact
          order by b.canonical_name, b.id
          limit 1) as exact_material,
        (select jsonb_build_object(
                  'id', b.id,
                  'material_code', b.material_code,
                  'canonical_name', b.canonical_name,
                  'default_unit', b.default_unit,
                  'unit_status', b.unit_status,
                  'score', b.score,
                  'skus', b.skus
                )
           from base b
          where b.is_master_exact
          order by b.canonical_name, b.id
          limit 1) as master_exact,
        (select coalesce(jsonb_agg(
                  jsonb_build_object(
                    'id', c.id,
                    'material_code', c.material_code,
                    'canonical_name', c.canonical_name,
                    'default_unit', c.default_unit,
                    'unit_status', c.unit_status,
                    'score', c.score,
                    'skus', b.skus
                  ) order by case c.unit_status when 'same' then 0 when 'auto' then 1 else 2 end,
                             c.score desc, c.canonical_name, c.id
                ), '[]'::jsonb)
           from (
             select *
             from candidates
             order by case unit_status when 'same' then 0 when 'auto' then 1 else 2 end,
                      score desc, canonical_name, id
             limit 3
           ) c
           join base b on b.id = c.id) as candidates
    ) s;

    -- Nếu material active trùng normalized_name của món chưa nằm trong ứng viên,
    -- thêm nó (thay ứng viên cuối khi đã đủ 3), giữ nguyên unit_status/score/skus.
    if v_master_exact is not null and v_master_exact <> 'null'::jsonb then
      if not exists (
        select 1
        from jsonb_array_elements(coalesce(v_candidates, '[]'::jsonb)) c
        where c ->> 'id' = v_master_exact ->> 'id'
      ) then
        if jsonb_array_length(coalesce(v_candidates, '[]'::jsonb)) >= 3 then
          v_candidates := (v_candidates - (jsonb_array_length(v_candidates) - 1))
                          || jsonb_build_array(v_master_exact);
        else
          v_candidates := coalesce(v_candidates, '[]'::jsonb)
                          || jsonb_build_array(v_master_exact);
        end if;
      end if;
    end if;

    select coalesce(jsonb_agg(
             c order by case c ->> 'unit_status' when 'same' then 0 when 'auto' then 1 else 2 end,
                        (c ->> 'score')::numeric desc, c ->> 'canonical_name', c ->> 'id'
           ), '[]'::jsonb)
    into v_candidates
    from jsonb_array_elements(coalesce(v_candidates, '[]'::jsonb)) c;

    if v_exact_count = 1 then
      v_material_unit := v_exact_material ->> 'default_unit';
      v_unit_status := v_unit_map ->> (v_uid || '|' || lower(btrim(coalesce(v_material_unit, ''))));
      if v_unit_status = 'auto' then
        v_auto_factor := public.q7_unit_factor(v_item_unit, v_material_unit);
      elsif v_unit_status = 'needs_factor' then
        v_factor_suggestion := public.q7_unit_factor_suggestion(
          v_item_name, v_item_unit, v_material_unit
        );
      end if;

      v_exact := v_exact + 1;
      if v_unit_status = 'auto' then
        v_auto := v_auto + 1;
      elsif v_unit_status = 'needs_factor' then
        v_needs_factor := v_needs_factor + 1;
      end if;
    else
      v_exact_material := null;
    end if;

    if v_exact_material is null and jsonb_array_length(coalesce(v_candidates, '[]'::jsonb)) = 0 then
      v_none := v_none + 1;
    end if;

    v_items := v_items || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_item_id,
        'item_code', v_item_code,
        'name', v_item_name,
        'unit', v_item_unit,
        'exact_material', v_exact_material,
        'material_unit', v_material_unit,
        'unit_status', v_unit_status,
        'auto_factor', v_auto_factor,
        'factor_suggestion', v_factor_suggestion,
        'candidates', coalesce(v_candidates, '[]'::jsonb),
        'last_buy', public.material_link_last_buy(v_item_id),
        'last_purchase_line', public.material_link_last_purchase_line(v_item_id),
        'receipt_photo_count', public.material_link_receipt_photo_count(v_item_id)
      )
    );
    v_total := v_total + 1;
  end loop;

  -- Thứ tự: exact trước, rồi có ứng viên, rồi không; trong nhóm xếp theo tên.
  select coalesce(jsonb_agg(e order by grp, name, item_id), '[]'::jsonb)
  into v_items
  from (
    select e,
           case
             when e -> 'exact_material' is not null
              and e -> 'exact_material' <> 'null'::jsonb then 0
             when jsonb_array_length(coalesce(e -> 'candidates', '[]'::jsonb)) > 0 then 1
             else 2
           end as grp,
           e ->> 'name' as name,
           e ->> 'item_id' as item_id
    from jsonb_array_elements(v_items) e
  ) t;

  select count(*) into v_linked_total
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.canonical_material_id is not null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  select count(*) into v_skipped
  from public.material_link_skips s
  join public.kitchen_inventory_items kii on kii.id = s.item_id
  where kii.active = true
    and kii.merged_into_id is null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  -- Pending là các item ĐÃ nối (nằm ngoài `items`) nhưng còn thiếu hệ số.
  select count(*) into v_pending_factor
  from public.material_link_pending_factors pf
  join public.kitchen_inventory_items kii on kii.id = pf.item_id
  where kii.active = true
    and kii.merged_into_id is null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  return jsonb_build_object(
    'items', v_items,
    'counts', jsonb_build_object(
      'total', v_total,
      'exact', v_exact,
      'auto', v_auto,
      'needs_factor', v_needs_factor,
      'none', v_none,
      'linked_total', v_linked_total,
      'skipped', v_skipped,
      'pending_factor', v_pending_factor
    )
  );
end;
$$;

revoke execute on function public.material_link_review_items_internal(text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- E. material_link_counts_internal — đếm set-based cho mission_evaluate
-- ===========================================================================

create or replace function public.material_link_counts_internal(p_location text)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with loc as (
    select lower(btrim(coalesce(p_location, ''))) as location
  ),
  base as (
    select kii.id, kii.name, kii.canonical_material_id
    from public.kitchen_inventory_items kii
    cross join loc
    where kii.active = true
      and kii.merged_into_id is null
      and (
        (loc.location = 'q7' and (
          kii.pastry_q7 = true
          or exists (
            select 1 from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = kii.id
          )
        ))
        or
        (loc.location = 'tan_tao' and not (
          kii.pastry_q7 = true
          or exists (
            select 1 from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = kii.id
          )
        ))
      )
  ),
  unlinked as (
    select b.id, b.name
    from base b
    where b.canonical_material_id is null
      and not exists (
        select 1 from public.material_link_skips s where s.item_id = b.id
      )
  )
  select jsonb_build_object(
    'total', (select count(*) from unlinked),
    'linked_total', (select count(*) from base where canonical_material_id is not null),
    'exact', (
      select count(*)
      from unlinked u
      where exists (
        select 1
        from public.sku_cogs_materials m
        where m.active = true
          and m.normalized_name = public.material_master_normalize(u.name)
      )
    ),
    'skipped', (
      select count(*)
      from base b
      join public.material_link_skips s on s.item_id = b.id
    )
  );
$$;

revoke execute on function public.material_link_counts_internal(text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- F. mission_evaluate — chỉ nhánh material_links_done dùng counts set-based
-- ===========================================================================

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
