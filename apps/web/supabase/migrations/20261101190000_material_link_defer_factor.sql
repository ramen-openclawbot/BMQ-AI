-- 2026-11-01 — "Gắn mã chuẩn" defer-factor (owner 15/10).
--
-- Bối cảnh: thẻ "Gắn mã chuẩn" hỏi "1 g = ? bình" cho món "Nước uống Vĩnh Hảo"
-- (đơn vị kho bình) khi nối với nguyên liệu "Nước uống Vĩnh Hảo" (default_unit g).
-- Chủ không đọc được dung tích từ phiếu giao hàng, không nhập được quy đổi nên bị
-- chặn. Migration này cho phép LIÊN KẾT TRƯỚC, HỎI HỆ SỐ SAU:
--
--   A. public.material_link_pending_factors — item đã nối nhưng thiếu hệ số;
--   B. q7_link_item_material_internal thêm p_defer_factor: khi cặp đơn vị cần hệ
--      số mà chưa có, bỏ qua việc ghi public.material_unit_conversions và ghi
--      pending; link vẫn đi đúng controller Material Master. link_item_material
--      (6 tham số) nhận p_defer_factor; link_q7_item_material giữ đúng 5 tham số
--      và luôn gọi lõi với false; link_exact_materials gọi lõi với false;
--   C. public.set_item_material_factor — chủ/material-master sửa / xoá hệ số của
--      một item đã nối bất cứ lúc nào;
--   D. material_link_review_items_internal — xếp hạng theo unit_status rồi score,
--      bỏ ứng viên score < 0.3 trừ khi cùng đơn vị, kéo thêm material cùng đơn vị
--      có chung từ khoá, kèm last_purchase_line + counts.pending_factor; thêm
--      public.get_material_link_pending_factors(text).
--
-- Convention đã có của public.material_unit_conversions (không đổi):
--   from_unit = đơn vị kho (item), to_unit = default_unit (material),
--   factor = số đơn vị material trên MỘT đơn vị item.
-- Vì vậy set_item_material_factor(p_item_id, p_factor) lưu thẳng p_factor.
--
-- Vì sao cần bypass assert_material_ready: Material Master controller
-- (request_material_resolution -> resolve_canonical_material ->
-- link_approved_material_resolution) từ chối nối khi thiếu một dòng quy đổi đã
-- duyệt (unit_unmapped). Khi defer, ta KHÔNG ghi quy đổi, nên đặt cờ giao dịch
-- material_master.defer_unit = 'on' đúng trong lúc gọi controller rồi tắt ngay.
-- Cờ chỉ nới đúng kiểm tra đơn vị; mọi kiểm tra material active / quyền giữ nguyên.
--
-- Migration này do Maestro apply; nó không tự apply.

-- ===========================================================================
-- A. Bảng pending factor (server ghi, client chỉ đọc)
-- ===========================================================================

create table if not exists public.material_link_pending_factors (
  item_id uuid primary key references public.kitchen_inventory_items(id),
  material_id uuid not null references public.sku_cogs_materials(id),
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.material_link_pending_factors enable row level security;

drop policy if exists material_link_pending_factors_select on public.material_link_pending_factors;
create policy material_link_pending_factors_select on public.material_link_pending_factors
  for select to authenticated using (true);

revoke all on table public.material_link_pending_factors from public, anon, authenticated;
grant select on table public.material_link_pending_factors to authenticated;
grant all on table public.material_link_pending_factors to service_role;

-- ===========================================================================
-- B0. Helper: từ khoá tên (accent-free, length >= 3) + dòng mua gần nhất
-- ===========================================================================

create or replace function public.material_link_name_words(p_name text)
returns text[]
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(array_agg(distinct w order by w), '{}'::text[])
  from unnest(
    regexp_split_to_array(lower(extensions.unaccent(coalesce(p_name, ''))), '\s+')
  ) w
  where length(w) >= 3;
$$;

revoke execute on function public.material_link_name_words(text) from public, anon, authenticated, service_role;

-- Dòng mua gần nhất (PO hoặc phiếu nhận) khớp alias của item hoặc chính tên item.
-- Trả jsonb {doc_kind 'po'|'gr', doc_number, date, supplier_name, raw_name,
-- quantity, unit, unit_price} hoặc null.
create or replace function public.material_link_last_purchase_line(p_item_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with item as (
    select kii.id, lower(extensions.unaccent(kii.name)) as item_norm
    from public.kitchen_inventory_items kii
    where kii.id = p_item_id
  ),
  names as (
    select distinct n
    from (
      select lower(extensions.unaccent(a.normalized_name)) as n
      from public.stock_material_aliases a
      where a.kitchen_inventory_item_id = p_item_id
      union all
      select item.item_norm from item
    ) x
    where n is not null and n <> ''
  ),
  lines as (
    select
      'po'::text as doc_kind,
      po.po_number as doc_number,
      coalesce(po.order_date, po.created_at::date) as doc_date,
      poi.created_at as created_at,
      poi.id as line_id,
      s.name as supplier_name,
      poi.product_name as raw_name,
      poi.quantity as quantity,
      poi.unit as unit,
      poi.unit_price as unit_price
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    left join public.suppliers s on s.id = po.supplier_id
    where po.status <> 'cancelled'
      and lower(extensions.unaccent(poi.product_name)) in (select n from names)
    union all
    select
      'gr'::text,
      gr.receipt_number,
      gr.receipt_date,
      gri.created_at,
      gri.id,
      s.name,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name),
      gri.quantity,
      gri.unit,
      gri.unit_price
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    left join public.suppliers s on s.id = gr.supplier_id
    where lower(
      extensions.unaccent(coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name))
    ) in (select n from names)
  )
  select jsonb_build_object(
           'doc_kind', l.doc_kind,
           'doc_number', l.doc_number,
           'date', l.doc_date,
           'supplier_name', l.supplier_name,
           'raw_name', l.raw_name,
           'quantity', l.quantity,
           'unit', l.unit,
           'unit_price', l.unit_price
         )
  from lines l
  order by l.doc_date desc nulls last, l.created_at desc nulls last, l.line_id desc
  limit 1;
$$;

revoke execute on function public.material_link_last_purchase_line(uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- B1. Nới kiểm tra đơn vị của assert_material_ready cho cờ defer (transaction
-- local). Mọi hành vi khác giữ nguyên bản gốc.
-- ===========================================================================

create or replace function public.assert_material_ready(
  p_material_id uuid,
  p_required_capabilities text[] default '{}'::text[],
  p_supplier_id uuid default null,
  p_unit text default null,
  p_effective_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_material public.sku_cogs_materials%rowtype;
  v_blockers text[] := '{}'::text[];
  v_cap text;
  v_unit text := nullif(lower(btrim(coalesce(p_unit, ''))), '');
  v_defer_unit boolean := coalesce(current_setting('material_master.defer_unit', true), '') = 'on';
begin
  select * into v_material from public.sku_cogs_materials where id = p_material_id;
  if not found then
    return jsonb_build_object('ready', false, 'status', 'blocked', 'material_id', p_material_id, 'blockers', jsonb_build_array('material_not_found'));
  end if;
  if not v_material.active then
    v_blockers := array_append(v_blockers, 'inactive');
  end if;

  foreach v_cap in array coalesce(p_required_capabilities, '{}'::text[]) loop
    v_cap := lower(btrim(coalesce(v_cap, '')));
    if v_cap in ('supplier_product','supplier') then
      if p_supplier_id is null then
        v_blockers := array_append(v_blockers, 'supplier_unmapped');
      elsif not exists (
        select 1 from public.material_supplier_products sp
        where sp.material_id = p_material_id and sp.supplier_id = p_supplier_id and sp.active = true and sp.approved = true
      ) then
        v_blockers := array_append(v_blockers, 'supplier_unmapped');
      end if;
    elsif v_cap in ('unit','unit_conversion') then
      if v_unit is null then
        v_blockers := array_append(v_blockers, 'unit_unmapped');
      elsif v_unit <> lower(btrim(v_material.default_unit)) and not v_defer_unit and not exists (
        select 1 from public.material_unit_conversions c
        where c.material_id = p_material_id and c.active = true and c.approved = true
          and lower(btrim(c.from_unit)) = v_unit
          and lower(btrim(c.to_unit)) = lower(btrim(v_material.default_unit))
          and c.effective_from <= coalesce(p_effective_date, current_date)
          and (c.effective_to is null or c.effective_to >= coalesce(p_effective_date, current_date))
      ) then
        v_blockers := array_append(v_blockers, 'unit_unmapped');
      end if;
    elsif v_cap in ('price','standard_cost','purchase_price') then
      if not exists (
        select 1
        from public.material_price_history ph
        where ph.material_id = p_material_id
          and ph.approved = true
          and ph.price_type = case when v_cap = 'purchase_price' then 'purchase_price' else 'standard_cost' end
          and ph.effective_from <= coalesce(p_effective_date, current_date)
          and (ph.effective_to is null or ph.effective_to >= coalesce(p_effective_date, current_date))
          and (
            ph.supplier_product_id is null
            or (
              p_supplier_id is not null
              and exists (
                select 1
                from public.material_supplier_products sp
                where sp.id = ph.supplier_product_id
                  and sp.material_id = p_material_id
                  and sp.supplier_id = p_supplier_id
                  and sp.active = true
                  and sp.approved = true
              )
            )
          )
      ) then
        v_blockers := array_append(v_blockers, case when v_cap = 'purchase_price' then 'missing_purchase_price' else 'missing_standard_cost' end);
      end if;
    elsif v_cap = 'q7_mapping' then
      if not exists (
        select 1
        from public.q7_material_issue_material_mappings q7m
        where q7m.canonical_material_id = p_material_id
          and q7m.approval_status = 'approved'
          and (v_unit is null or lower(btrim(q7m.source_unit)) = v_unit)
      ) then
        v_blockers := array_append(v_blockers, 'missing_q7_mapping');
      end if;
    elsif v_cap = 'active' or v_cap = '' then
      null;
    else
      v_blockers := array_append(v_blockers, 'unsupported_capability');
    end if;
  end loop;

  if v_unit is not null
     and v_unit <> lower(btrim(v_material.default_unit))
     and not v_defer_unit
     and not exists (
       select 1 from public.material_unit_conversions c
       where c.material_id = p_material_id and c.active = true and c.approved = true
         and lower(btrim(c.from_unit)) = v_unit
         and lower(btrim(c.to_unit)) = lower(btrim(v_material.default_unit))
         and c.effective_from <= coalesce(p_effective_date, current_date)
         and (c.effective_to is null or c.effective_to >= coalesce(p_effective_date, current_date))
     ) then
    v_blockers := array_append(v_blockers, 'unit_unmapped');
  end if;

  select coalesce(array_agg(distinct b order by b), '{}'::text[]) into v_blockers from unnest(v_blockers) b;
  return jsonb_build_object('ready', cardinality(v_blockers) = 0, 'status', case when cardinality(v_blockers)=0 then 'ready' else 'blocked' end, 'material_id', p_material_id, 'blockers', to_jsonb(v_blockers));
end;
$$;

-- ===========================================================================
-- B2. Lõi nối item — thêm p_defer_factor (drop signature cũ 5 tham số)
-- ===========================================================================

drop function if exists public.q7_link_item_material_internal(uuid, uuid, boolean, uuid, numeric);

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
  if v_defer then
    perform set_config('material_master.defer_unit', 'on', true);
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
    raise;
  end;
  if v_defer then
    perform set_config('material_master.defer_unit', '', true);
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
    'request_id', (v_apply ->> 'request_id')::uuid
  );
end;
$$;

revoke execute on function public.q7_link_item_material_internal(uuid, uuid, boolean, uuid, numeric, boolean) from public, anon, authenticated, service_role;

-- Tiện ích nhỏ: item có đang pending hệ số không (dùng cho nhánh đã-nối-sẵn).
create or replace function public.material_link_is_factor_pending(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.material_link_pending_factors pf where pf.item_id = p_item_id
  );
$$;

revoke execute on function public.material_link_is_factor_pending(uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- B3. Wrapper theo kho — link_q7_item_material giữ đúng 5 tham số (false)
-- ===========================================================================

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
    p_item_id, p_material_id, p_create_new, p_request_id, p_unit_factor, false
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

-- ===========================================================================
-- B4. link_item_material — 6 tham số, nhận p_defer_factor, idempotent như cũ
-- ===========================================================================

drop function if exists public.link_item_material(uuid, uuid, boolean, uuid, numeric);

create or replace function public.link_item_material(
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
    p_item_id, p_material_id, p_create_new, p_request_id, p_unit_factor,
    coalesce(p_defer_factor, false)
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

-- ===========================================================================
-- B5. link_exact_materials — vẫn gọi lõi với false
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

-- ===========================================================================
-- C. set_item_material_factor — đặt / đổi / xoá hệ số của item đã nối
-- ===========================================================================

create or replace function public.set_item_material_factor(
  p_item_id uuid,
  p_factor numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_material public.sku_cogs_materials%rowtype;
  v_item_unit text;
  v_mat_unit text;
  v_pending boolean;
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_item_id is null then
    raise exception 'item_not_linked' using errcode = '22023';
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id
  for update;
  if not found or v_item.canonical_material_id is null then
    raise exception 'item_not_linked' using errcode = '22023';
  end if;

  select * into v_material
  from public.sku_cogs_materials
  where id = v_item.canonical_material_id;
  if not found then
    raise exception 'item_not_linked' using errcode = '22023';
  end if;

  if p_factor is not null
     and (
       p_factor <= 0
       or p_factor::text in ('NaN', 'Infinity', '-Infinity')
     ) then
    raise exception 'invalid_factor' using errcode = '22023';
  end if;

  v_item_unit := lower(btrim(coalesce(v_item.unit, '')));
  v_mat_unit := lower(btrim(coalesce(v_material.default_unit, '')));

  -- Cùng đơn vị: hệ số luôn là 1, không cần dòng quy đổi.
  if v_item_unit = v_mat_unit then
    if p_factor is null then
      insert into public.material_link_pending_factors (item_id, material_id, created_by, created_at)
      values (v_item.id, v_material.id, v_actor, now())
      on conflict (item_id) do update
        set material_id = excluded.material_id,
            created_by = excluded.created_by,
            created_at = excluded.created_at;
      v_pending := true;
    else
      delete from public.material_link_pending_factors where item_id = v_item.id;
      v_pending := false;
    end if;

    return jsonb_build_object(
      'item_id', v_item.id,
      'material_id', v_material.id,
      'item_unit', v_item.unit,
      'material_unit', v_material.default_unit,
      'factor', p_factor,
      'pending', v_pending
    );
  end if;

  -- Luôn tắt dòng quy đổi đang hiệu lực cho đúng cặp (material, item_unit ->
  -- material_unit) trước khi ghi dòng mới, đúng cơ chế đường nối đang dùng.
  update public.material_unit_conversions
  set active = false,
      updated_at = now()
  where material_id = v_material.id
    and lower(btrim(from_unit)) = v_item_unit
    and lower(btrim(to_unit)) = v_mat_unit
    and active = true;

  if p_factor is null then
    -- Xoá hệ số: item quay lại chờ chủ nhập.
    insert into public.material_link_pending_factors (item_id, material_id, created_by, created_at)
    values (v_item.id, v_material.id, v_actor, now())
    on conflict (item_id) do update
      set material_id = excluded.material_id,
          created_by = excluded.created_by,
          created_at = excluded.created_at;
    v_pending := true;
  else
    insert into public.material_unit_conversions (
      material_id, from_unit, to_unit, factor, effective_from,
      source_type, source_id, approved, approved_by, approved_at,
      active, metadata, created_by
    ) values (
      v_material.id, btrim(v_item.unit), btrim(v_material.default_unit), p_factor, current_date,
      'q7_material_link', v_item.id,
      true, v_actor, now(), true,
      jsonb_build_object(
        'reason', 'Chủ nhập hệ số quy đổi',
        'item_id', v_item.id,
        'item_unit', v_item.unit,
        'material_unit', v_material.default_unit,
        'factor_source', 'owner_factor_manual'
      ),
      v_actor
    );
    delete from public.material_link_pending_factors where item_id = v_item.id;
    v_pending := false;
  end if;

  return jsonb_build_object(
    'item_id', v_item.id,
    'material_id', v_material.id,
    'item_unit', v_item.unit,
    'material_unit', v_material.default_unit,
    'factor', p_factor,
    'pending', v_pending
  );
end;
$$;

revoke execute on function public.set_item_material_factor(uuid, numeric) from public, anon;
grant execute on function public.set_item_material_factor(uuid, numeric) to authenticated, service_role;

-- ===========================================================================
-- D. Đọc lại review: xếp hạng theo đơn vị, lọc score, last_purchase_line
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
  v_pending_factor integer := 0;
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

    -- Ứng viên: exact name (1), gần giống, và material cùng đơn vị có chung từ
    -- khoá. Xếp theo unit_status (same > auto > needs_factor) rồi score; bỏ
    -- score < 0.3 trừ khi cùng đơn vị; tối đa 3.
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'id', c.id,
               'material_code', c.material_code,
               'canonical_name', c.canonical_name,
               'default_unit', c.default_unit,
               'unit_status', c.unit_status,
               'score', c.score,
               'skus', public.material_link_material_skus(c.material_code)
             ) order by c.unit_rank, c.score desc, c.canonical_name, c.id
           ), '[]'::jsonb)
    into v_candidates
    from (
      select g.id, g.material_code, g.canonical_name, g.default_unit, g.unit_status,
             case g.unit_status when 'same' then 0 when 'auto' then 1 else 2 end as unit_rank,
             g.score
      from (
        select u.id, u.material_code, u.canonical_name, u.default_unit,
               u.unit_status, max(u.score) as score
        from (
          select m.id, m.material_code, m.canonical_name, m.default_unit,
                 public.q7_unit_status(v_item.unit, m.default_unit) as unit_status,
                 1::numeric as score
          from public.sku_cogs_materials m
          where m.active = true
            and v_norm is not null
            and m.normalized_name = v_norm
          union all
          select m.id, m.material_code, m.canonical_name, m.default_unit,
                 public.q7_unit_status(v_item.unit, m.default_unit) as unit_status,
                 public.q7_material_name_similarity(v_item.name, m.canonical_name) as score
          from public.sku_cogs_materials m
          where m.active = true
          union all
          select m.id, m.material_code, m.canonical_name, m.default_unit,
                 'same'::text as unit_status,
                 public.q7_material_name_similarity(v_item.name, m.canonical_name) as score
          from public.sku_cogs_materials m
          where m.active = true
            and public.q7_unit_status(v_item.unit, m.default_unit) = 'same'
            and exists (
              select 1
              from unnest(public.material_link_name_words(v_item.name)) w
              where w = any (public.material_link_name_words(m.canonical_name))
            )
        ) u
        group by u.id, u.material_code, u.canonical_name, u.default_unit, u.unit_status
      ) g
      where g.unit_status = 'same' or g.score >= 0.3
      order by case g.unit_status when 'same' then 0 when 'auto' then 1 else 2 end,
               g.score desc, g.canonical_name, g.id
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
        'last_purchase_line', public.material_link_last_purchase_line(v_item.id),
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
-- D2. get_material_link_pending_factors — danh sách chờ hệ số theo kho
-- ===========================================================================

create or replace function public.get_material_link_pending_factors(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_location text := lower(btrim(coalesce(p_location, '')));
  v_items jsonb := '[]'::jsonb;
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_location not in ('q7', 'tan_tao') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'item_id', kii.id,
             'name', kii.name,
             'unit', kii.unit,
             'material_id', m.id,
             'material_code', m.material_code,
             'canonical_name', m.canonical_name,
             'material_unit', m.default_unit,
             'last_purchase_line', public.material_link_last_purchase_line(kii.id)
           ) order by kii.name, kii.id
         ), '[]'::jsonb)
  into v_items
  from public.material_link_pending_factors pf
  join public.kitchen_inventory_items kii on kii.id = pf.item_id
  join public.sku_cogs_materials m on m.id = pf.material_id
  where kii.active = true
    and kii.merged_into_id is null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements qm
          where qm.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements qm
          where qm.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  return jsonb_build_object('items', v_items);
end;
$$;

revoke execute on function public.get_material_link_pending_factors(text) from public, anon;
grant execute on function public.get_material_link_pending_factors(text) to authenticated, service_role;

-- ===========================================================================
-- E. ACL đường ghi
-- ===========================================================================

revoke execute on function public.link_q7_item_material(uuid, uuid, boolean, uuid, numeric) from public, anon;
grant execute on function public.link_q7_item_material(uuid, uuid, boolean, uuid, numeric) to authenticated, service_role;

revoke execute on function public.link_item_material(uuid, uuid, boolean, uuid, numeric, boolean) from public, anon;
grant execute on function public.link_item_material(uuid, uuid, boolean, uuid, numeric, boolean) to authenticated, service_role;

revoke execute on function public.link_exact_materials(text, uuid) from public, anon;
grant execute on function public.link_exact_materials(text, uuid) to authenticated, service_role;
