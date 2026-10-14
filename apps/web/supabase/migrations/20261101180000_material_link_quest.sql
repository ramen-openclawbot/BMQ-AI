-- 2026-11-01 — Nhiệm vụ gắn mã chuẩn cho cả hai kho (Q7 + Tân Tạo).
--
-- Nền tảng không đổi giao diện: mở rộng Material Master linking từ Q7 sang kho
-- Tân Tạo, thêm bảng bỏ qua (skip) và luật nhiệm vụ 'material_links_done'.
--
-- Migration này KHÔNG viết lại logic liên kết Material Master: mọi đường ghi vẫn
-- đi qua public.q7_link_item_material_internal (Material Master controller +
-- quy đổi đơn vị). Nó chỉ:
--   A. tạo public.material_link_skips (RLS, chỉ đọc cho client);
--   B. tách lõi đọc public.material_link_review_items_internal (gate-free) và
--      bọc gate public.can_edit_material_master() ở public.material_link_review_items,
--      public.get_material_link_review(p_location); giữ nguyên hợp đồng cũ của
--      public.get_q7_material_link_review() (trả về 'q7');
--   C. mở eligibility của liên kết cho mọi item active/chưa gộp/chưa gắn/chưa
--      skip, thêm public.link_item_material + public.link_exact_materials(location);
--   D. thêm skip/unskip;
--   E. thêm luật chấm nhiệm vụ 'material_links_done', gieo 2 nhiệm vụ cho chủ và
--      public.assign_material_link_missions(p_user).
--
-- Migration này do Maestro apply; nó không tự apply.

-- ===========================================================================
-- A. Bảng bỏ qua liên kết (server ghi, client chỉ đọc)
-- ===========================================================================

create table if not exists public.material_link_skips (
  item_id uuid primary key references public.kitchen_inventory_items(id),
  reason text not null check (reason in ('not_material')),
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.material_link_skips enable row level security;

drop policy if exists material_link_skips_select on public.material_link_skips;
create policy material_link_skips_select on public.material_link_skips
  for select to authenticated using (true);

revoke all on table public.material_link_skips from public, anon, authenticated;
grant select on table public.material_link_skips to authenticated;
grant all on table public.material_link_skips to service_role;

-- ===========================================================================
-- B0. Helper: SKU đang dùng một material (theo material_code)
-- ===========================================================================

create or replace function public.material_link_material_skus(p_material_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x.product_name order by x.product_name), '[]'::jsonb)
  from (
    select distinct ps.product_name
    from public.sku_cogs_version_formulations f
    join public.sku_cogs_versions v on v.id = f.version_id
    join public.product_skus ps on ps.id = v.sku_id
    where f.material_code = p_material_code
    order by ps.product_name
    limit 6
  ) x;
$$;

revoke execute on function public.material_link_material_skus(text) from public, anon, authenticated, service_role;

-- Lần mua gần nhất của một item: alias -> dòng phiếu nhận -> nhà cung cấp.
create or replace function public.material_link_last_buy(p_item_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object('supplier_name', s.name, 'date', gr.receipt_date)
  from public.stock_material_aliases a
  join public.goods_receipt_items gri
    on lower(extensions.unaccent(coalesce(gri.raw_product_name, gri.product_name))) = a.normalized_name
  join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  left join public.suppliers s on s.id = gr.supplier_id
  where a.kitchen_inventory_item_id = p_item_id
  order by gr.receipt_date desc, gr.created_at desc, gr.id desc
  limit 1;
$$;

revoke execute on function public.material_link_last_buy(uuid) from public, anon, authenticated, service_role;

-- Số phiếu nhận có ảnh trong 90 ngày gần nhất của một item.
create or replace function public.material_link_receipt_photo_count(p_item_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select count(distinct gr.id)::integer
  from public.stock_material_aliases a
  join public.goods_receipt_items gri
    on lower(extensions.unaccent(coalesce(gri.raw_product_name, gri.product_name))) = a.normalized_name
  join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  where a.kitchen_inventory_item_id = p_item_id
    and gr.image_url is not null
    and gr.receipt_date >= current_date - 90;
$$;

revoke execute on function public.material_link_receipt_photo_count(uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- B. Lõi đọc review cho một kho (gate-free) + RPC có gate
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
  v_item record;
  v_norm text;
  v_exact_count integer;
  v_exact_id uuid;
  v_material_unit text;
  v_unit_status text;
  v_auto_factor numeric;
  v_factor_suggestion numeric;
  v_exact_material jsonb;
  v_candidates jsonb;
  v_items jsonb := '[]'::jsonb;
  v_total integer := 0;
  v_exact integer := 0;
  v_auto integer := 0;
  v_needs_factor integer := 0;
  v_none integer := 0;
  v_linked_total integer := 0;
  v_skipped integer := 0;
begin
  if v_location not in ('q7', 'tan_tao') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;

  for v_item in
    select kii.id, kii.item_code, kii.name, kii.unit
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
      )
    order by kii.name, kii.id
  loop
    v_norm := public.normalize_stock_item_name(v_item.name);
    v_exact_material := null;
    v_exact_id := null;
    v_material_unit := null;
    v_unit_status := null;
    v_auto_factor := null;
    v_factor_suggestion := null;

    select count(*) into v_exact_count
    from public.sku_cogs_materials m
    where m.active = true
      and v_norm is not null
      and m.normalized_name = v_norm;

    if v_exact_count = 1 then
      select jsonb_build_object(
               'id', m.id,
               'material_code', m.material_code,
               'canonical_name', m.canonical_name,
               'default_unit', m.default_unit,
               'skus', public.material_link_material_skus(m.material_code)
             ), m.id, m.default_unit
      into v_exact_material, v_exact_id, v_material_unit
      from public.sku_cogs_materials m
      where m.active = true and m.normalized_name = v_norm
      order by m.canonical_name, m.id
      limit 1;

      v_unit_status := public.q7_unit_status(v_item.unit, v_material_unit);
      if v_unit_status = 'auto' then
        v_auto_factor := public.q7_unit_factor(v_item.unit, v_material_unit);
      elsif v_unit_status = 'needs_factor' then
        v_factor_suggestion := public.q7_unit_factor_suggestion(
          v_item.name, v_item.unit, v_material_unit
        );
      end if;

      v_exact := v_exact + 1;
      if v_unit_status = 'auto' then
        v_auto := v_auto + 1;
      elsif v_unit_status = 'needs_factor' then
        v_needs_factor := v_needs_factor + 1;
      end if;
    end if;

    select coalesce(jsonb_agg(
             jsonb_build_object(
               'id', c.id,
               'material_code', c.material_code,
               'canonical_name', c.canonical_name,
               'default_unit', c.default_unit,
               'unit_status', public.q7_unit_status(v_item.unit, c.default_unit),
               'score', c.score,
               'skus', public.material_link_material_skus(c.material_code)
             ) order by c.score desc, c.canonical_name, c.id
           ), '[]'::jsonb)
    into v_candidates
    from (
      select g.id, g.material_code, g.canonical_name, g.default_unit, g.score
      from (
        select u.id, u.material_code, u.canonical_name, u.default_unit, max(u.score) as score
        from (
          select m.id, m.material_code, m.canonical_name, m.default_unit, 1::numeric as score
          from public.sku_cogs_materials m
          where m.active = true
            and v_norm is not null
            and m.normalized_name = v_norm
          union all
          select m.id, m.material_code, m.canonical_name, m.default_unit,
                 public.q7_material_name_similarity(v_item.name, m.canonical_name) as score
          from public.sku_cogs_materials m
          where m.active = true
        ) u
        group by u.id, u.material_code, u.canonical_name, u.default_unit
      ) g
      order by g.score desc, g.canonical_name, g.id
      limit 3
    ) c;

    if v_exact_material is null and jsonb_array_length(coalesce(v_candidates, '[]'::jsonb)) = 0 then
      v_none := v_none + 1;
    end if;

    v_items := v_items || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_item.id,
        'item_code', v_item.item_code,
        'name', v_item.name,
        'unit', v_item.unit,
        'exact_material', v_exact_material,
        'material_unit', v_material_unit,
        'unit_status', v_unit_status,
        'auto_factor', v_auto_factor,
        'factor_suggestion', v_factor_suggestion,
        'candidates', coalesce(v_candidates, '[]'::jsonb),
        'last_buy', public.material_link_last_buy(v_item.id),
        'receipt_photo_count', public.material_link_receipt_photo_count(v_item.id)
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

  return jsonb_build_object(
    'items', v_items,
    'counts', jsonb_build_object(
      'total', v_total,
      'exact', v_exact,
      'auto', v_auto,
      'needs_factor', v_needs_factor,
      'none', v_none,
      'linked_total', v_linked_total,
      'skipped', v_skipped
    )
  );
end;
$$;

revoke execute on function public.material_link_review_items_internal(text) from public, anon, authenticated, service_role;

create or replace function public.material_link_review_items(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  return public.material_link_review_items_internal(p_location);
end;
$$;

create or replace function public.get_material_link_review(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return public.material_link_review_items(p_location);
end;
$$;

-- Giữ nguyên hợp đồng cũ: không tham số, trả về tập Q7.
create or replace function public.get_q7_material_link_review()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return public.material_link_review_items('q7');
end;
$$;

revoke execute on function public.material_link_review_items(text) from public, anon;
grant execute on function public.material_link_review_items(text) to authenticated, service_role;

revoke execute on function public.get_material_link_review(text) from public, anon;
grant execute on function public.get_material_link_review(text) to authenticated, service_role;

revoke execute on function public.get_q7_material_link_review() from public, anon;
grant execute on function public.get_q7_material_link_review() to authenticated, service_role;

-- ===========================================================================
-- C. Đường liên kết dùng chung: mở eligibility + RPC theo kho
-- ===========================================================================

create or replace function public.q7_link_item_material_internal(
  p_item_id uuid,
  p_material_id uuid,
  p_create_new boolean,
  p_request_id uuid,
  p_unit_factor numeric default null
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
        'request_id', v_item.material_resolution_request_id
      );
    end if;
    raise exception 'item_already_linked' using errcode = '23505';
  end if;

  if v_target.normalized_name = v_master_norm then
    v_candidate_source := 'normalized_canonical_name';
  else
    if exists (
      select 1 from public.sku_cogs_materials m
      where m.active = true and m.normalized_name = v_master_norm and m.id <> v_target.id
    ) then
      raise exception 'material_name_conflict' using errcode = '23505';
    end if;
    if exists (
      select 1 from public.material_scoped_aliases a
      where a.supplier_id is null
        and a.active = true
        and a.approved = true
        and a.normalized_alias = v_master_norm
        and a.material_id <> v_target.id
    ) then
      raise exception 'material_alias_conflict' using errcode = '23505';
    end if;
    -- Alias toàn cục: controller confirm_material_resolution chỉ tạo alias toàn
    -- cục khi request không có supplier và source_type rỗng, nhưng
    -- request_material_resolution bắt buộc source_type khác rỗng. Vì vậy nhánh
    -- toàn cục không tới được với nguồn kitchen; ở đây ghi trực tiếp cùng ngữ
    -- nghĩa (source='approved_global_alias', approved_by = owner) và không có
    -- guard nào trên public.sku_cogs_material_aliases cấm.
    select * into v_existing_alias
    from public.sku_cogs_material_aliases a
    where a.normalized_alias = v_master_norm;
    if found then
      if v_existing_alias.material_id <> v_target.id then
        raise exception 'material_alias_conflict' using errcode = '23505';
      end if;
    else
      insert into public.sku_cogs_material_aliases(
        material_id, alias_name, normalized_alias, source, active, created_by
      ) values (
        v_target.id, btrim(v_item.name), v_master_norm, 'approved_global_alias', true, v_actor
      );
    end if;
    v_candidate_source := 'approved_global_alias';
  end if;

  -- Bảo đảm Material Master thấy được quy đổi đơn vị kho → đơn vị chuẩn trước khi
  -- liên kết. assert_material_ready yêu cầu đúng from_unit = đơn vị kho và
  -- to_unit = default_unit (lower/trim), đã duyệt, đang hoạt động, còn hiệu lực.
  -- Cùng đơn vị → không cần quy đổi. Cặp chuẩn g/kg, ml/l → tự tính hệ số. Cặp
  -- khác → bắt buộc p_unit_factor > 0 hữu hạn.
  v_item_unit := lower(btrim(coalesce(v_item.unit, '')));
  v_mat_unit := lower(btrim(coalesce(v_target.default_unit, '')));
  if v_item_unit <> '' and v_mat_unit <> '' and v_item_unit <> v_mat_unit then
    v_conv_factor := public.q7_unit_factor(v_item.unit, v_target.default_unit);
    if v_conv_factor is not null then
      v_conv_source := 'standard_auto';
    else
      if p_unit_factor is null
         or p_unit_factor <= 0
         or p_unit_factor::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'unit_factor_required' using errcode = '22023';
      end if;
      v_conv_factor := p_unit_factor;
      v_conv_source := 'owner_factor';
    end if;

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

  -- request resolved_existing + link đi qua controller Material Master hiện hữu.
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

  if coalesce(v_apply ->> 'status', '') not in ('linked', 'linked_unchanged')
     or (v_apply ->> 'material_id')::uuid is distinct from v_target.id then
    raise exception 'q7_material_link_failed' using errcode = '23514';
  end if;

  return jsonb_build_object(
    'item_id', v_item.id,
    'material_id', v_target.id,
    'material_code', v_target.material_code,
    'canonical_name', v_target.canonical_name,
    'created_material', v_created,
    'request_id', (v_apply ->> 'request_id')::uuid
  );
end;
$$;

revoke execute on function public.q7_link_item_material_internal(uuid, uuid, boolean, uuid, numeric) from public, anon, authenticated, service_role;

drop function if exists public.link_q7_item_material(uuid, uuid, boolean, uuid);

create or replace function public.material_link_item_location(p_item_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (
      select 1 from public.kitchen_inventory_items k
      where k.id = p_item_id
        and (k.pastry_q7 = true or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = k.id
        ))
    ) then 'q7'
    else 'tan_tao'
  end;
$$;

revoke execute on function public.material_link_item_location(uuid) from public, anon, authenticated, service_role;

create or replace function public.link_q7_item_material(
  p_item_id uuid,
  p_material_id uuid,
  p_create_new boolean,
  p_request_id uuid,
  p_unit_factor numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.q7_material_link_requests%rowtype;
  v_result jsonb;
  v_inserted uuid;
  v_location text;
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  select * into v_existing
  from public.q7_material_link_requests
  where request_id = p_request_id;
  if found then
    if (v_existing.result ->> 'item_id')::uuid is distinct from p_item_id then
      raise exception 'request_id_conflict' using errcode = '23505';
    end if;
    return v_existing.result || jsonb_build_object(
      'location', public.material_link_item_location(p_item_id)
    );
  end if;

  v_result := public.q7_link_item_material_internal(
    p_item_id, p_material_id, p_create_new, p_request_id, p_unit_factor
  );

  v_location := public.material_link_item_location(p_item_id);
  v_result := v_result || jsonb_build_object('location', v_location);

  insert into public.q7_material_link_requests(request_id, actor_id, item_id, material_id, result)
  values (p_request_id, v_actor, p_item_id, (v_result ->> 'material_id')::uuid, v_result)
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

create or replace function public.link_item_material(
  p_item_id uuid,
  p_material_id uuid,
  p_create_new boolean,
  p_request_id uuid,
  p_unit_factor numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.link_q7_item_material(
    p_item_id, p_material_id, p_create_new, p_request_id, p_unit_factor
  );
end;
$$;

create or replace function public.link_exact_materials(p_location text, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.q7_material_link_requests%rowtype;
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

  for v_item in
    select e ->> 'item_id' as item_id,
           e ->> 'name' as name,
           e ->> 'unit' as unit,
           (e -> 'exact_material' ->> 'id')::uuid as material_id,
           e -> 'exact_material' ->> 'default_unit' as material_unit,
           e ->> 'unit_status' as unit_status,
           nullif(e ->> 'factor_suggestion', '')::numeric as factor_suggestion
    from jsonb_array_elements(
      public.material_link_review_items_internal(p_location)
    ) e
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
        v_item.item_id::uuid, v_item.material_id, false, p_request_id, null
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

create or replace function public.link_q7_exact_materials(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.link_exact_materials('q7', p_request_id);
end;
$$;

-- ===========================================================================
-- D. Skip / unskip liên kết
-- ===========================================================================

create or replace function public.skip_item_material_link(
  p_item_id uuid,
  p_reason text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_item_id is null then
    raise exception 'item_required' using errcode = '22023';
  end if;
  if p_reason is distinct from 'not_material' then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id
  for update;
  if not found
     or v_item.active is not true
     or v_item.merged_into_id is not null
     or v_item.canonical_material_id is not null then
    raise exception 'item_not_eligible' using errcode = '22023';
  end if;

  insert into public.material_link_skips (item_id, reason, note, created_by, created_at)
  values (p_item_id, p_reason, p_note, v_actor, now())
  on conflict (item_id) do update
    set reason = excluded.reason,
        note = excluded.note,
        created_by = excluded.created_by,
        created_at = excluded.created_at;

  return jsonb_build_object('item_id', p_item_id, 'skipped', true);
end;
$$;

create or replace function public.unskip_item_material_link(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_item_id is null then
    raise exception 'item_required' using errcode = '22023';
  end if;

  delete from public.material_link_skips where item_id = p_item_id;
  return jsonb_build_object('item_id', p_item_id, 'skipped', false);
end;
$$;

-- ===========================================================================
-- ACL cho đường ghi
-- ===========================================================================

revoke execute on function public.link_q7_item_material(uuid, uuid, boolean, uuid, numeric) from public, anon;
grant execute on function public.link_q7_item_material(uuid, uuid, boolean, uuid, numeric) to authenticated, service_role;

revoke execute on function public.link_item_material(uuid, uuid, boolean, uuid, numeric) from public, anon;
grant execute on function public.link_item_material(uuid, uuid, boolean, uuid, numeric) to authenticated, service_role;

revoke execute on function public.link_exact_materials(text, uuid) from public, anon;
grant execute on function public.link_exact_materials(text, uuid) to authenticated, service_role;

revoke execute on function public.link_q7_exact_materials(uuid) from public, anon;
grant execute on function public.link_q7_exact_materials(uuid) to authenticated, service_role;

revoke execute on function public.skip_item_material_link(uuid, text, text) from public, anon;
grant execute on function public.skip_item_material_link(uuid, text, text) to authenticated, service_role;

revoke execute on function public.unskip_item_material_link(uuid) from public, anon;
grant execute on function public.unskip_item_material_link(uuid) to authenticated, service_role;

-- ===========================================================================
-- E. Luật nhiệm vụ 'material_links_done' + gieo nhiệm vụ + gán nhiệm vụ
-- ===========================================================================

alter table public.missions drop constraint if exists missions_check_rule_check;
alter table public.missions add constraint missions_check_rule_check check (
  check_rule in (
    'stock_alias_factor_fixed',
    'stock_duplicate_resolved',
    'stock_unknown_units_cleared',
    'material_links_done'
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
    v_review := public.material_link_review_items_internal(v_location);
    v_left := coalesce((v_review -> 'counts' ->> 'total')::int, 0);
    v_linked := coalesce((v_review -> 'counts' ->> 'linked_total')::int, 0);
    v_total := v_left + v_linked;
    v_done := (v_left = 0 and v_total > 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'location', v_location,
      'remaining', v_left,
      'linked', v_linked,
      'exact', coalesce((v_review -> 'counts' ->> 'exact')::int, 0),
      'skipped', coalesce((v_review -> 'counts' ->> 'skipped')::int, 0)
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

-- Gieo 2 nhiệm vụ gắn mã chuẩn cho chủ sở hữu (tra theo dữ liệu, không hard-code).
do $seed_material_link_missions$
declare
  v_owner uuid;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  if v_owner is null then
    raise notice 'material link missions seed skipped: no owner role';
    return;
  end if;

  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, created_by
  ) values (
    'wh-link-q7', 'warehouse', 'Gắn mã chuẩn Kho Q7',
    'Mỗi món Q7 cần một mã nguyên liệu chuẩn thì kiểm kê Q7 mới chốt được. Lật từng thẻ, chọn mã Jev gợi ý hoặc tạo mã mới.',
    v_owner, 'material_links_done', jsonb_build_object('location', 'q7'),
    'cham_chi', 4, v_owner
  )
  on conflict (code) do nothing;

  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, created_by
  ) values (
    'wh-link-tan-tao', 'warehouse', 'Gắn mã chuẩn Kho Tân Tạo',
    'Nối nguyên liệu kho tổng với các SKU đang bán để giá vốn tính đúng.',
    v_owner, 'material_links_done', jsonb_build_object('location', 'tan_tao'),
    'cham_chi', 5, v_owner
  )
  on conflict (code) do nothing;
end;
$seed_material_link_missions$;

create or replace function public.assign_material_link_missions(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_created integer := 0;
  v_added integer := 0;
  v_code_q7 text;
  v_code_tan_tao text;
begin
  if p_user is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not public.has_role(v_actor, 'owner') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_code_q7 := 'wh-link-q7-' || left(p_user::text, 8);
  v_code_tan_tao := 'wh-link-tan-tao-' || left(p_user::text, 8);

  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, created_by
  ) values (
    v_code_q7, 'warehouse', 'Gắn mã chuẩn Kho Q7',
    'Mỗi món Q7 cần một mã nguyên liệu chuẩn thì kiểm kê Q7 mới chốt được. Lật từng thẻ, chọn mã Jev gợi ý hoặc tạo mã mới.',
    p_user, 'material_links_done', jsonb_build_object('location', 'q7'),
    'cham_chi', 4, v_actor
  )
  on conflict (code) do nothing;
  get diagnostics v_added = row_count;
  v_created := v_created + v_added;

  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, created_by
  ) values (
    v_code_tan_tao, 'warehouse', 'Gắn mã chuẩn Kho Tân Tạo',
    'Nối nguyên liệu kho tổng với các SKU đang bán để giá vốn tính đúng.',
    p_user, 'material_links_done', jsonb_build_object('location', 'tan_tao'),
    'cham_chi', 5, v_actor
  )
  on conflict (code) do nothing;
  get diagnostics v_added = row_count;
  v_created := v_created + v_added;

  return jsonb_build_object('created', v_created);
end;
$$;

revoke execute on function public.assign_material_link_missions(uuid) from public, anon;
grant execute on function public.assign_material_link_missions(uuid) to authenticated, service_role;
