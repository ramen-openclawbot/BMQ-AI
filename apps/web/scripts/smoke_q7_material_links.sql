-- Rollback-only production smoke for migration
-- 20261031140000_q7_material_links.sql.
--
-- Run as one file (from apps/web):
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_q7_material_links.sql
--
-- The file opens one transaction, applies the migration SQL inline (the migration
-- is intentionally NOT pushed to production), exercises the three RPCs as the real
-- owner (public.user_roles) and a real user without Material Master permission,
-- then raises SMOKE_RESULT PASS. The final RAISE aborts the transaction, so every
-- change rolls back and the live database is untouched.
begin;

-- == BEGIN INLINE MIGRATION 20261031140000_q7_material_links.sql ==
-- 2026-10-31 — Liên kết NVL Q7 với Material Master (phần dữ liệu).
--
-- Mục tiêu: mở khoá kiểm kê NVL Q7 bằng cách liên kết mọi kitchen item Q7 đang
-- hoạt động, chưa gộp, chưa có canonical_material_id với một dòng
-- public.sku_cogs_materials đang hoạt động. Toàn bộ đường ghi đi qua Material
-- Master controller hiện hữu; migration này KHÔNG tắt trigger, KHÔNG bỏ qua
-- guard Material Master và KHÔNG tự UPDATE
-- public.kitchen_inventory_items.canonical_material_id — việc liên kết chỉ xảy ra
-- bên trong public.link_approved_material_resolution (được gọi gián tiếp qua
-- public.apply_approved_material_reconciliation).
--
-- Quy đổi đơn vị: public.assert_material_ready / public.resolve_canonical_material
-- chỉ chấp nhận đơn vị kho khi đơn vị đó bằng default_unit của nguyên liệu, hoặc
-- có một dòng public.material_unit_conversions đã duyệt, đang hoạt động, với
-- from_unit = đơn vị kho và to_unit = default_unit (so khớp lower/trim). Vì vậy
-- khi đơn vị kho khác default_unit, đường liên kết phải tạo trước quy đổi đã
-- duyệt:
--   * cùng đơn vị (khác hoa/thường/khoảng trắng, hoặc cùng mã qua
--     public.stock_unit_code)                      → liên kết như cũ;
--   * cặp khối lượng/thể tích chuẩn (g/kg, ml/l)   → tự tính hệ số đã duyệt;
--   * cặp khác (bao/quả/bình/...)                  → cần p_unit_factor > 0 do
--     chủ sở hữu cung cấp, rồi mới tạo quy đổi.
-- Hệ số quy đổi là số đơn vị chuẩn (default_unit) tương ứng với MỘT đơn vị kho;
-- ví dụ item đơn vị "bao", default_unit "g", 25 kg/bao → factor = 25000.
--
-- Bối cảnh sử dụng:
--   * public.get_q7_material_link_review()  — đọc danh sách item còn thiếu liên
--     kết, gợi ý material khớp chính xác, unit_status và các ứng viên gần giống.
--   * public.link_q7_item_material(...)      — liên kết một item (khớp exact, chọn
--     material có sẵn, hoặc tạo material mới), có thể kèm hệ số quy đổi.
--   * public.link_q7_exact_materials(...)    — liên kết hàng loạt các item có đúng
--     một material khớp exact và đơn vị same/auto; item needs_factor được trả về
--     riêng, lỗi từng dòng được gom lại, không abort cả batch.
--
-- Idempotency được lưu ở bảng server-only public.q7_material_link_requests
-- (RLS bật, không policy cho client, chỉ cấp cho service_role).
--
-- RPC exact match dùng public.normalize_stock_item_name(item.name) giống
-- public.get_stock_count_review/start_stock_count. Đường ghi dùng
-- public.material_master_normalize(...) — đúng chuẩn hoá mà
-- public.resolve_canonical_material / public.apply_approved_material_reconciliation
-- dùng — nên khi hai chuẩn hoá khác nhau, RPC ghi tạo approved global alias cho
-- tên item rồi dùng candidate_source 'approved_global_alias'.
--
-- Migration này do Maestro apply; nó không tự apply.

-- ===========================================================================
-- 1. Bảng idempotency server-only
-- ===========================================================================

create table if not exists public.q7_material_link_requests (
  request_id uuid primary key,
  actor_id uuid references auth.users(id) on delete set null,
  item_id uuid references public.kitchen_inventory_items(id) on delete set null,
  material_id uuid references public.sku_cogs_materials(id) on delete set null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.q7_material_link_requests enable row level security;

-- Không policy nào cho client; chỉ service_role được chạm trực tiếp.
revoke all on public.q7_material_link_requests from public, anon, authenticated;
grant select, insert, update on public.q7_material_link_requests to service_role;

-- ===========================================================================
-- 2. Helper so khớp tên (pg_trgm nếu có, fallback token chung)
-- ===========================================================================

create or replace function public.q7_material_name_similarity(p_left text, p_right text)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_left text := public.normalize_stock_item_name(p_left);
  v_right text := public.normalize_stock_item_name(p_right);
  v_score numeric;
begin
  if v_left is null or v_right is null or v_left = '' or v_right = '' then
    return 0;
  end if;
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_trgm') then
    begin
      execute 'select similarity($1, $2)' into v_score using v_left, v_right;
    exception when others then
      v_score := null;
    end;
    if v_score is null then
      begin
        execute 'select extensions.similarity($1, $2)' into v_score using v_left, v_right;
      exception when others then
        v_score := null;
      end;
    end if;
    if v_score is not null then
      return greatest(0::numeric, least(1::numeric, v_score));
    end if;
  end if;
  -- Fallback: Jaccard trên token đã chuẩn hoá.
  select case
           when cardinality(a.tokens) = 0 or cardinality(b.tokens) = 0 then 0::numeric
           else cardinality(array(select unnest(a.tokens) intersect select unnest(b.tokens)))::numeric
                / greatest(1, cardinality(array(select unnest(a.tokens) union select unnest(b.tokens))))
         end
  into v_score
  from (select array(select distinct t from unnest(regexp_split_to_array(v_left, '\s+')) t where t <> '') as tokens) a
  cross join (select array(select distinct t from unnest(regexp_split_to_array(v_right, '\s+')) t where t <> '') as tokens) b;
  return coalesce(v_score, 0);
end;
$$;

revoke execute on function public.q7_material_name_similarity(text, text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 3. Helper đơn vị: trạng thái quy đổi, hệ số chuẩn và gợi ý hệ số
-- ===========================================================================

-- Base code (g / ml) của một đơn vị khối lượng hoặc thể tích; null cho đơn vị
-- đếm (bao, quả, bình...) hoặc đơn vị không nhận diện được.
create or replace function public.q7_unit_base(p_unit text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select u.base_code
  from public.stock_units u
  where u.code = public.stock_unit_code(p_unit)
    and u.kind in ('weight', 'volume');
$$;

revoke execute on function public.q7_unit_base(text) from public, anon, authenticated, service_role;

-- 'same' | 'auto' | 'needs_factor' cho cặp (đơn vị kho, đơn vị chuẩn).
create or replace function public.q7_unit_status(p_item_unit text, p_material_unit text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_item_raw text := lower(btrim(coalesce(p_item_unit, '')));
  v_mat_raw text := lower(btrim(coalesce(p_material_unit, '')));
  v_item_code text;
  v_mat_code text;
  v_item_base text;
  v_mat_base text;
begin
  if v_item_raw <> '' and v_item_raw = v_mat_raw then
    return 'same';
  end if;
  v_item_code := public.stock_unit_code(p_item_unit);
  v_mat_code := public.stock_unit_code(p_material_unit);
  if v_item_code is not null and v_item_code = v_mat_code then
    -- Cùng đơn vị nhưng khác cách viết (gr / g, lít / l): vẫn là "same"; đường
    -- ghi sẽ tạo quy đổi hệ số 1 nếu assert_material_ready cần đúng chính tả.
    return 'same';
  end if;
  v_item_base := public.q7_unit_base(p_item_unit);
  v_mat_base := public.q7_unit_base(p_material_unit);
  if v_item_base is not null and v_mat_base is not null and v_item_base = v_mat_base then
    return 'auto';
  end if;
  return 'needs_factor';
end;
$$;

revoke execute on function public.q7_unit_status(text, text) from public, anon, authenticated, service_role;

-- Hệ số đã duyệt cho cặp chuẩn khối lượng/thể tích: số đơn vị chuẩn (đơn vị
-- material) trên MỘT đơn vị kho. Ví dụ g → kg = 0.001; kg → g = 1000.
-- Null khi không phải cặp cùng nhóm khối lượng/thể tích.
create or replace function public.q7_unit_factor(p_item_unit text, p_material_unit text)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select case
           when a.base_code is null or b.base_code is null then null
           when a.base_code <> b.base_code then null
           else a.to_base / b.to_base
         end
  from public.stock_units a
  cross join public.stock_units b
  where a.code = public.stock_unit_code(p_item_unit)
    and b.code = public.stock_unit_code(p_material_unit);
$$;

revoke execute on function public.q7_unit_factor(text, text) from public, anon, authenticated, service_role;

-- Gợi ý hệ số đọc từ tên item (ví dụ 'Bột mì 25kg' → 25000 g/bao). Chỉ là gợi ý,
-- không tự ghi. Coi 1 ml ~ 1 g khi tên ghi đơn vị thể tích nhưng đơn vị chuẩn là
-- khối lượng (và ngược lại), đúng như yêu cầu nghiệp vụ.
create or replace function public.q7_unit_factor_suggestion(
  p_name text,
  p_item_unit text,
  p_material_unit text
)
returns numeric
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_match text[];
  v_qty numeric;
  v_parsed public.stock_units%rowtype;
  v_mat public.stock_units%rowtype;
begin
  if coalesce(p_name, '') = '' then
    return null;
  end if;
  v_match := regexp_match(
    lower(p_name),
    '([0-9]+(?:[.,][0-9]+)?)\s*(kgs?|gram|gr|kg|ký|kí|lít|lit|ml|l|g)\y'
  );
  if v_match is null then
    return null;
  end if;
  v_qty := replace(v_match[1], ',', '.')::numeric;
  select * into v_parsed
  from public.stock_units
  where code = public.stock_unit_code(v_match[2])
    and kind in ('weight', 'volume');
  if not found then
    return null;
  end if;
  select * into v_mat
  from public.stock_units
  where code = public.stock_unit_code(p_material_unit)
    and kind in ('weight', 'volume');
  if not found then
    return null;
  end if;
  return round((v_qty * v_parsed.to_base) / v_mat.to_base, 6);
end;
$$;

revoke execute on function public.q7_unit_factor_suggestion(text, text, text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 4. Read RPC: danh sách item Q7 cần liên kết
-- ===========================================================================

create or replace function public.get_q7_material_link_review()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
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
  v_linked_total integer := 0;
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  for v_item in
    select kii.id, kii.item_code, kii.name, kii.unit
    from public.kitchen_inventory_items kii
    where kii.active = true
      and kii.merged_into_id is null
      and kii.canonical_material_id is null
      and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
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
               'default_unit', m.default_unit
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
               'score', c.score
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
      limit 5
    ) c;

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
        'candidates', coalesce(v_candidates, '[]'::jsonb)
      )
    );
    v_total := v_total + 1;
  end loop;

  select count(*) into v_linked_total
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.canonical_material_id is not null
    and (
      kii.pastry_q7 = true
      or exists (
        select 1 from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = kii.id
      )
    );

  return jsonb_build_object(
    'items', v_items,
    'counts', jsonb_build_object(
      'total', v_total,
      'exact', v_exact,
      'auto', v_auto,
      'needs_factor', v_needs_factor,
      'linked_total', v_linked_total
    )
  );
end;
$$;

-- ===========================================================================
-- 5. Đường liên kết dùng chung (nội bộ)
-- ===========================================================================

drop function if exists public.q7_link_item_material_internal(uuid, uuid, boolean, uuid);

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
  if v_item.active is not true or v_item.merged_into_id is not null then
    raise exception 'item_not_eligible' using errcode = '22023';
  end if;
  if not (
    v_item.pastry_q7 = true
    or exists (
      select 1 from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = v_item.id
    )
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

-- ===========================================================================
-- 6. Write RPC: liên kết một item (idempotent theo p_request_id)
-- ===========================================================================

-- Phiên bản 4 tham số chưa từng được apply; bỏ để không còn overload cũ.
drop function if exists public.link_q7_item_material(uuid, uuid, boolean, uuid);

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
    return v_existing.result;
  end if;

  v_result := public.q7_link_item_material_internal(
    p_item_id, p_material_id, p_create_new, p_request_id, p_unit_factor
  );

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

-- ===========================================================================
-- 7. Write RPC: liên kết hàng loạt exact match (same + auto; còn lại needs_factor)
-- ===========================================================================

create or replace function public.link_q7_exact_materials(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.q7_material_link_requests%rowtype;
  v_item record;
  v_norm text;
  v_exact_count integer;
  v_exact_id uuid;
  v_material_unit text;
  v_unit_status text;
  v_factor_suggestion numeric;
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
  select * into v_existing
  from public.q7_material_link_requests
  where request_id = p_request_id;
  if found then
    return v_existing.result;
  end if;

  for v_item in
    select kii.id, kii.name, kii.unit
    from public.kitchen_inventory_items kii
    where kii.active = true
      and kii.merged_into_id is null
      and kii.canonical_material_id is null
      and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      )
    order by kii.name, kii.id
  loop
    v_norm := public.normalize_stock_item_name(v_item.name);
    if v_norm is null then
      continue;
    end if;
    select count(*) into v_exact_count
    from public.sku_cogs_materials m
    where m.active = true and m.normalized_name = v_norm;
    if v_exact_count <> 1 then
      continue;
    end if;
    select m.id, m.default_unit into v_exact_id, v_material_unit
    from public.sku_cogs_materials m
    where m.active = true and m.normalized_name = v_norm
    limit 1;

    v_unit_status := public.q7_unit_status(v_item.unit, v_material_unit);
    if v_unit_status = 'needs_factor' then
      v_factor_suggestion := public.q7_unit_factor_suggestion(
        v_item.name, v_item.unit, v_material_unit
      );
      v_needs_factor := v_needs_factor || jsonb_build_array(
        jsonb_build_object(
          'item_id', v_item.id,
          'name', v_item.name,
          'unit', v_item.unit,
          'material_unit', v_material_unit,
          'factor_suggestion', v_factor_suggestion
        )
      );
      continue;
    end if;

    begin
      perform public.q7_link_item_material_internal(v_item.id, v_exact_id, false, p_request_id, null);
      v_linked := v_linked + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_array(
        jsonb_build_object('item_id', v_item.id, 'name', v_item.name, 'error', sqlerrm)
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

-- ===========================================================================
-- 8. ACL
-- ===========================================================================

revoke execute on function public.get_q7_material_link_review() from public, anon;
grant execute on function public.get_q7_material_link_review() to authenticated, service_role;

revoke execute on function public.link_q7_item_material(uuid, uuid, boolean, uuid, numeric) from public, anon;
grant execute on function public.link_q7_item_material(uuid, uuid, boolean, uuid, numeric) to authenticated, service_role;

revoke execute on function public.link_q7_exact_materials(uuid) from public, anon;
grant execute on function public.link_q7_exact_materials(uuid) to authenticated, service_role;
-- == END INLINE MIGRATION 20261031140000_q7_material_links.sql ==

-- ===========================================================================
-- Smoke body: run as the real owner, then roll back via the final RAISE.
-- ===========================================================================

do $smoke$
declare
  v_owner uuid;
  v_viewer uuid;
  v_review jsonb;
  v_items jsonb;
  v_counts jsonb;
  v_expected_exact integer;
  v_expected_linkable integer;
  v_expected_needs integer;
  v_review_same integer;
  v_review_auto integer;
  v_review_needs integer;
  v_batch jsonb;
  v_batch_linked integer;
  v_batch_needs jsonb;
  v_needs_item_id uuid;
  v_needs_item_name text;
  v_needs_item_unit text;
  v_needs_material_id uuid;
  v_needs_material_unit text;
  v_needs_factor numeric;
  v_needs_result jsonb;
  v_request uuid;
  v_link_result jsonb;
  v_link_replay jsonb;
  v_link_rows integer;
  v_alias_item_id uuid;
  v_alias_item_name text;
  v_alias_item_unit text;
  v_alias_material_id uuid;
  v_create_item_id uuid;
  v_create_item_name text;
  v_count_item_id uuid;
  v_count_unit text;
  v_book numeric;
  v_count_result jsonb;
  v_probe integer;
  v_probe_request uuid;
  v_exact_left integer;
  v_review_item jsonb;
begin
  -- A real owner (Material Master edit) and a real viewer without it.
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL (0) no_owner';
  end if;

  select ur.user_id into v_viewer
  from public.user_roles ur
  where ur.role::text = 'viewer'
    and not public.has_role(ur.user_id, 'owner')
    and not public.has_module_permission(ur.user_id, 'material_master', 'edit')
  order by ur.created_at, ur.user_id
  limit 1;
  if v_viewer is null then
    raise exception 'SMOKE_RESULT FAIL (0) no_viewer';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- (1) review returns >= 1 item and exact count matches an independent count.
  v_review := public.get_q7_material_link_review();
  if v_review is null or jsonb_typeof(v_review -> 'items') <> 'array' then
    raise exception 'SMOKE_RESULT FAIL (1) review_shape %', v_review;
  end if;
  v_items := v_review -> 'items';
  v_counts := v_review -> 'counts';
  if jsonb_array_length(v_items) < 1 then
    raise exception 'SMOKE_RESULT FAIL (1) no_items';
  end if;

  select count(*) into v_expected_exact
  from (
    select kii.id, kii.name
    from public.kitchen_inventory_items kii
    where kii.active = true
      and kii.merged_into_id is null
      and kii.canonical_material_id is null
      and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      )
  ) i
  where (
    select count(*)
    from public.sku_cogs_materials m
    where m.active = true
      and public.normalize_stock_item_name(i.name) is not null
      and m.normalized_name = public.normalize_stock_item_name(i.name)
  ) = 1;

  -- Independently compute how many exact items are same-unit or a standard
  -- weight/volume pair (linkable by the bulk) versus needs_factor.
  select count(*) into v_expected_linkable
  from (
    select kii.id, kii.name, kii.unit,
           (
             select m.default_unit
             from public.sku_cogs_materials m
             where m.active = true
               and m.normalized_name = public.normalize_stock_item_name(kii.name)
             order by m.canonical_name, m.id
             limit 1
           ) as material_unit
    from public.kitchen_inventory_items kii
    where kii.active = true
      and kii.merged_into_id is null
      and kii.canonical_material_id is null
      and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      )
  ) i
  where (
    select count(*)
    from public.sku_cogs_materials m
    where m.active = true
      and public.normalize_stock_item_name(i.name) is not null
      and m.normalized_name = public.normalize_stock_item_name(i.name)
  ) = 1
  and (
    lower(btrim(i.unit)) = lower(btrim(i.material_unit))
    or (
      public.stock_unit_code(i.unit) is not null
      and public.stock_unit_code(i.material_unit) is not null
      and (
        select a.base_code from public.stock_units a
        where a.code = public.stock_unit_code(i.unit)
      ) = (
        select b.base_code from public.stock_units b
        where b.code = public.stock_unit_code(i.material_unit)
      )
    )
  );
  v_expected_needs := v_expected_exact - v_expected_linkable;

  select
    count(*) filter (where x ->> 'unit_status' = 'same'),
    count(*) filter (where x ->> 'unit_status' = 'auto'),
    count(*) filter (where x ->> 'unit_status' = 'needs_factor')
  into v_review_same, v_review_auto, v_review_needs
  from jsonb_array_elements(v_items) x
  where x -> 'exact_material' is not null;

  if (v_counts ->> 'total')::integer <> jsonb_array_length(v_items) then
    raise exception 'SMOKE_RESULT FAIL (1) total mismatch % vs %',
      (v_counts ->> 'total'), jsonb_array_length(v_items);
  end if;
  if (v_counts ->> 'exact')::integer <> v_expected_exact then
    raise exception 'SMOKE_RESULT FAIL (1) exact mismatch % vs %',
      (v_counts ->> 'exact'), v_expected_exact;
  end if;
  if v_review_same + v_review_auto + v_review_needs <> v_expected_exact then
    raise exception 'SMOKE_RESULT FAIL (1) status_sum % vs exact %',
      v_review_same + v_review_auto + v_review_needs, v_expected_exact;
  end if;
  if (v_counts ->> 'auto')::integer <> v_review_auto then
    raise exception 'SMOKE_RESULT FAIL (1) auto mismatch % vs %',
      (v_counts ->> 'auto'), v_review_auto;
  end if;
  if (v_counts ->> 'needs_factor')::integer <> v_review_needs then
    raise exception 'SMOKE_RESULT FAIL (1) needs_factor mismatch % vs %',
      (v_counts ->> 'needs_factor'), v_review_needs;
  end if;
  if v_review_same + v_review_auto <> v_expected_linkable then
    raise exception 'SMOKE_RESULT FAIL (1) linkable mismatch % vs %',
      v_review_same + v_review_auto, v_expected_linkable;
  end if;
  if v_review_needs <> v_expected_needs then
    raise exception 'SMOKE_RESULT FAIL (1) needs mismatch % vs %',
      v_review_needs, v_expected_needs;
  end if;

  -- (2) bulk link every unique exact match whose unit is same or auto.
  v_request := gen_random_uuid();
  v_batch := public.link_q7_exact_materials(v_request);
  if v_batch is null or coalesce(v_batch ->> 'linked', '') = '' then
    raise exception 'SMOKE_RESULT FAIL (2) batch_shape %', v_batch;
  end if;
  v_batch_linked := (v_batch ->> 'linked')::integer;
  v_batch_needs := coalesce(v_batch -> 'needs_factor', '[]'::jsonb);
  if v_batch_linked <> v_expected_linkable then
    raise exception 'SMOKE_RESULT FAIL (2) linked % <> linkable %',
      v_batch_linked, v_expected_linkable;
  end if;
  if jsonb_array_length(coalesce(v_batch -> 'failed', '[]'::jsonb)) <> 0 then
    raise exception 'SMOKE_RESULT FAIL (2) failed %', v_batch -> 'failed';
  end if;
  if jsonb_array_length(v_batch_needs) <> v_expected_needs then
    raise exception 'SMOKE_RESULT FAIL (2) needs_factor % <> %',
      jsonb_array_length(v_batch_needs), v_expected_needs;
  end if;

  -- Every same/auto exact item the review flagged must now be linked with a
  -- resolved request. needs_factor items stay unlinked until an owner gives a factor.
  v_exact_left := 0;
  for v_review_item in
    select x from jsonb_array_elements(v_items) x
    where x -> 'exact_material' is not null
      and x ->> 'unit_status' in ('same', 'auto')
  loop
    if not exists (
      select 1
      from public.kitchen_inventory_items k
      join public.material_resolution_requests r on r.id = k.material_resolution_request_id
      where k.id = (v_review_item ->> 'item_id')::uuid
        and k.canonical_material_id is not null
        and k.material_resolution_status = 'linked'
        and r.status = 'resolved_existing'
    ) then
      v_exact_left := v_exact_left + 1;
    end if;
  end loop;
  if v_exact_left <> 0 then
    raise exception 'SMOKE_RESULT FAIL (2) exact_items_not_linked %', v_exact_left;
  end if;

  -- (3) bulk is idempotent per request id.
  v_link_replay := public.link_q7_exact_materials(v_request);
  if v_link_replay is distinct from v_batch then
    raise exception 'SMOKE_RESULT FAIL (3) batch_not_idempotent';
  end if;
  select count(*) into v_link_rows
  from public.q7_material_link_requests where request_id = v_request;
  if v_link_rows <> 1 then
    raise exception 'SMOKE_RESULT FAIL (3) batch_rows %', v_link_rows;
  end if;

  -- (3b) a needs_factor item: without a factor the single link must raise
  --      unit_factor_required (22023); with its suggested factor it links and an
  --      approved, active material_unit_conversions row exists for the pair.
  if jsonb_array_length(v_batch_needs) < 1 then
    raise exception 'SMOKE_RESULT FAIL (3b) no_needs_factor_item';
  end if;

  select (x ->> 'item_id')::uuid, x ->> 'name', x ->> 'unit',
         x ->> 'material_unit', nullif(x ->> 'factor_suggestion', '')::numeric
  into v_needs_item_id, v_needs_item_name, v_needs_item_unit,
       v_needs_material_unit, v_needs_factor
  from jsonb_array_elements(v_batch_needs) x
  limit 1;

  if v_needs_factor is null or v_needs_factor <= 0 then
    v_needs_factor := 1000;
  end if;

  select m.id into v_needs_material_id
  from public.sku_cogs_materials m
  where m.active = true
    and m.normalized_name = public.normalize_stock_item_name(v_needs_item_name)
  order by m.canonical_name, m.id
  limit 1;
  if v_needs_material_id is null then
    raise exception 'SMOKE_RESULT FAIL (3b) needs_material_missing %', v_needs_item_name;
  end if;

  v_request := gen_random_uuid();
  v_probe := 0;
  begin
    perform public.link_q7_item_material(
      v_needs_item_id, v_needs_material_id, false, v_request, null
    );
    v_probe := 1;
  exception when others then
    if sqlstate <> '22023' or sqlerrm not like '%unit_factor_required%' then
      raise exception 'SMOKE_RESULT FAIL (3b) wrong_error % %', sqlstate, sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL (3b) factor_not_required';
  end if;

  v_request := gen_random_uuid();
  v_needs_result := public.link_q7_item_material(
    v_needs_item_id, v_needs_material_id, false, v_request, v_needs_factor
  );
  if (v_needs_result ->> 'material_id')::uuid is distinct from v_needs_material_id then
    raise exception 'SMOKE_RESULT FAIL (3b) needs_link %', v_needs_result;
  end if;
  if not exists (
    select 1 from public.material_unit_conversions c
    where c.material_id = v_needs_material_id
      and c.active = true
      and c.approved = true
      and lower(btrim(c.from_unit)) = lower(btrim(v_needs_item_unit))
      and lower(btrim(c.to_unit)) = lower(btrim(v_needs_material_unit))
      and c.effective_from <= current_date
      and (c.effective_to is null or c.effective_to >= current_date)
  ) then
    raise exception 'SMOKE_RESULT FAIL (3b) conversion_missing % %',
      v_needs_item_unit, v_needs_material_unit;
  end if;
  if not exists (
    select 1 from public.material_unit_conversions c
    where c.material_id = v_needs_material_id
      and c.source_type = 'q7_material_link'
      and c.source_id = v_needs_item_id
      and c.approved = true
      and c.active = true
  ) then
    raise exception 'SMOKE_RESULT FAIL (3b) conversion_provenance_missing';
  end if;
  if not exists (
    select 1 from public.kitchen_inventory_items k
    where k.id = v_needs_item_id
      and k.canonical_material_id = v_needs_material_id
      and k.material_resolution_status = 'linked'
  ) then
    raise exception 'SMOKE_RESULT FAIL (3b) needs_not_linked';
  end if;

  -- (4) one remaining unlinked item -> existing non-exact material (alias path).
  select i.item_id, i.name, i.unit, m.id
  into v_alias_item_id, v_alias_item_name, v_alias_item_unit, v_alias_material_id
  from (
    select (x ->> 'item_id')::uuid as item_id, x ->> 'name' as name, x ->> 'unit' as unit
    from jsonb_array_elements(v_items) x
    join public.kitchen_inventory_items k on k.id = (x ->> 'item_id')::uuid
    where k.canonical_material_id is null
  ) i
  join lateral (
    select mm.id
    from public.sku_cogs_materials mm
    where mm.active = true
      and mm.default_unit = i.unit
      and mm.normalized_name <> public.material_master_normalize(i.name)
    order by public.q7_material_name_similarity(i.name, mm.canonical_name) desc, mm.canonical_name
    limit 1
  ) m on true
  where not exists (
    select 1 from public.sku_cogs_materials mx
    where mx.active = true and mx.normalized_name = public.material_master_normalize(i.name)
  )
  and not exists (
    select 1 from public.sku_cogs_material_aliases a
    where a.normalized_alias = public.material_master_normalize(i.name)
  )
  and not exists (
    select 1 from public.material_scoped_aliases a
    where a.supplier_id is null
      and a.active = true
      and a.approved = true
      and a.normalized_alias = public.material_master_normalize(i.name)
  )
  order by i.name, i.item_id
  limit 1;

  if v_alias_item_id is null then
    raise exception 'SMOKE_RESULT FAIL (4) no_alias_candidate';
  end if;

  v_request := gen_random_uuid();
  v_link_result := public.link_q7_item_material(v_alias_item_id, v_alias_material_id, false, v_request);
  if (v_link_result ->> 'material_id')::uuid is distinct from v_alias_material_id then
    raise exception 'SMOKE_RESULT FAIL (4) alias_link %', v_link_result;
  end if;
  if not exists (
    select 1 from public.sku_cogs_material_aliases a
    where a.material_id = v_alias_material_id
      and a.source = 'approved_global_alias'
      and a.active = true
      and a.normalized_alias = public.material_master_normalize(v_alias_item_name)
  ) then
    raise exception 'SMOKE_RESULT FAIL (4) global_alias_missing';
  end if;
  if not exists (
    select 1
    from public.kitchen_inventory_items k
    join public.material_resolution_requests r on r.id = k.material_resolution_request_id
    where k.id = v_alias_item_id
      and k.canonical_material_id = v_alias_material_id
      and k.material_resolution_status = 'linked'
      and r.status = 'resolved_existing'
      and r.safe_payload ->> 'candidate_source' = 'approved_global_alias'
  ) then
    raise exception 'SMOKE_RESULT FAIL (4) alias_request_missing';
  end if;

  -- (5) another remaining unlinked item -> create a new canonical material.
  select (x ->> 'item_id')::uuid, x ->> 'name'
  into v_create_item_id, v_create_item_name
  from jsonb_array_elements(v_items) x
  join public.kitchen_inventory_items k on k.id = (x ->> 'item_id')::uuid
  where k.canonical_material_id is null
    and not exists (
      select 1 from public.sku_cogs_materials m
      where m.normalized_name = public.material_master_normalize(x ->> 'name')
    )
  order by x ->> 'name'
  limit 1;

  if v_create_item_id is null then
    raise exception 'SMOKE_RESULT FAIL (5) no_create_candidate';
  end if;

  v_request := gen_random_uuid();
  v_link_result := public.link_q7_item_material(v_create_item_id, null, true, v_request);
  if (v_link_result ->> 'created_material')::boolean is not true
     or (v_link_result ->> 'material_id') is null then
    raise exception 'SMOKE_RESULT FAIL (5) create_link %', v_link_result;
  end if;
  if not exists (
    select 1
    from public.kitchen_inventory_items k
    join public.material_resolution_requests r on r.id = k.material_resolution_request_id
    where k.id = v_create_item_id
      and k.canonical_material_id = (v_link_result ->> 'material_id')::uuid
      and k.material_resolution_status = 'linked'
      and r.status = 'resolved_existing'
      and r.safe_payload ->> 'candidate_source' = 'normalized_canonical_name'
  ) then
    raise exception 'SMOKE_RESULT FAIL (5) create_request_missing';
  end if;

  -- (6) repeat a single request id -> same result, no duplicate row.
  v_link_replay := public.link_q7_item_material(v_create_item_id, null, true, v_request);
  if v_link_replay is distinct from v_link_result then
    raise exception 'SMOKE_RESULT FAIL (6) item_not_idempotent';
  end if;
  select count(*) into v_link_rows
  from public.q7_material_link_requests where request_id = v_request;
  if v_link_rows <> 1 then
    raise exception 'SMOKE_RESULT FAIL (6) item_rows %', v_link_rows;
  end if;

  -- (7) a random authenticated user is refused 42501.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_viewer, 'role', 'authenticated')::text, true);
  v_probe := 0;
  begin
    perform public.get_q7_material_link_review();
    v_probe := 1;
  exception when others then
    if sqlstate <> '42501' then
      raise exception 'SMOKE_RESULT FAIL (7) wrong_error % %', sqlstate, sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL (7) unauthorized_accepted';
  end if;

  -- (8) for a linked item, record_q7_stock_count must not raise
  --     q7_canonical_link_required (a different q7 guard may still block).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  select kii.id, kii.unit
  into v_count_item_id, v_count_unit
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.canonical_material_id is not null
    and kii.material_resolution_status = 'linked'
    and exists (
      select 1 from public.q7_material_issue_material_mappings m
      where m.approval_status = 'approved'
        and m.kitchen_inventory_item_id = kii.id
        and m.canonical_material_id = kii.canonical_material_id
        and lower(btrim(m.kitchen_unit)) = lower(btrim(kii.unit))
    )
  order by kii.name, kii.id
  limit 1;

  if v_count_item_id is null then
    select kii.id, kii.unit
    into v_count_item_id, v_count_unit
    from public.kitchen_inventory_items kii
    where kii.active = true
      and kii.canonical_material_id is not null
      and kii.material_resolution_status = 'linked'
    order by kii.name, kii.id
    limit 1;
  end if;

  if v_count_item_id is null then
    raise exception 'SMOKE_RESULT FAIL (8) no_linked_item';
  end if;

  select coalesce(max(s.balance_qty), 0)
  into v_book
  from public.get_q7_inventory_snapshot(current_date) s
  where s.kitchen_inventory_item_id = v_count_item_id;

  v_probe_request := gen_random_uuid();
  v_probe := 0;
  begin
    v_count_result := public.record_q7_stock_count(
      v_count_item_id, abs(coalesce(v_book, 0)) + 3, current_date,
      'smoke q7 material links', v_probe_request::text
    );
    v_probe := 1;
  exception when others then
    if sqlerrm like '%q7_canonical_link_required%' then
      raise exception 'SMOKE_RESULT FAIL (8) canonical_link_still_required';
    end if;
    -- Report any other blocker instead of swallowing it so the Maestro sees it.
    raise exception 'SMOKE_RESULT FAIL (8) record_q7_stock_count_error %: %',
      sqlstate, sqlerrm;
  end;
  if v_probe = 1 and (v_count_result ->> 'status') <> 'recorded' then
    raise exception 'SMOKE_RESULT FAIL (8) unexpected_status %', v_count_result;
  end if;

  raise exception 'SMOKE_RESULT PASS: q7 material links';
end;
$smoke$;

rollback;
