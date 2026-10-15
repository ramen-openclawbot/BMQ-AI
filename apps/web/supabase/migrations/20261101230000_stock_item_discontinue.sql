-- 2026-11-01 — "Ngưng dùng" (discontinue) một món NVL không còn dùng (owner 15/10).
--
-- Mục tiêu: một món NVL không còn sử dụng (ví dụ 'Bột custard sư tử') phải rời
-- khỏi kệ hàng, bộ gắn mã, phiếu kiểm kê, bàn đặt hàng robot và gợi ý, nhưng
-- vẫn có thể khôi phục từ danh sách "Đã ngưng dùng". Đồng thời thêm 'bot' vào
-- stopword của luật cùng-đơn-vị/chung-từ để 'Bột custard sư tử' không còn được
-- gợi ý ghép với 'Bột mì 888' / 'Bột Ngọt' chỉ vì chung chữ 'bột'.
--
-- Migration này do Maestro apply; nó không tự apply. Không tắt trigger nào.
--
-- ===========================================================================
-- BÁO CÁO: các hàm đọc kitchen_inventory_items có lọc active = true hay không
-- (đối chiếu trước khi viết migration, KHÔNG sửa các hàm này trừ
--  material_link_review_items_internal ở mục 5).
-- ===========================================================================
-- * public.get_warehouse_game_snapshot(text) — bản mới nhất trong
--   20261031100000_manual_stock_transfer.sql. CÓ lọc active:
--     q7:      "where kii.active = true
--                 and kii.merged_into_id is null
--                 and (kii.pastry_q7 = true or exists (...))"
--     tan_tao: "where kii.active = true
--                 and kii.merged_into_id is null"
--   (khối counts cũng dùng "where kii.active = true and kii.merged_into_id is null").
-- * public.start_stock_count(text, text) / dòng phiếu kiểm kê — bản mới nhất
--   trong 20261031100000_manual_stock_transfer.sql. CÓ lọc active:
--     q7:      "where kii.active = true
--                 and kii.merged_into_id is null
--                 and (kii.pastry_q7 = true or exists (...))
--                 and coalesce(kii.item_class, 'unclassified') <> 'non_stock'"
--     tan_tao: "where kii.active = true
--                 and kii.merged_into_id is null
--                 and coalesce(kii.item_class, 'unclassified') <> 'non_stock'"
-- * public.material_link_review_items_internal(text) — 20261101210000. CÓ lọc active:
--     "where kii.active = true
--        and kii.merged_into_id is null
--        and kii.canonical_material_id is null
--        and (...) and not exists (select 1 from public.material_link_skips ...)"
--   (linked_total/skipped/pending_factor cũng dùng
--    "where kii.active = true and kii.merged_into_id is null").
-- * public.material_link_counts_internal(text) — 20261101210000. CÓ lọc active:
--     "where kii.active = true
--        and kii.merged_into_id is null
--        and (...)".
-- * public.get_item_purchase_facts(uuid[]) — 20261101170000. KHÔNG lọc active:
--     "join public.kitchen_inventory_items kii on kii.id = u.item_id"
--   (nhận item id tường minh; món đã ngưng vẫn trả dữ liệu nếu bị gọi trực tiếp).
-- * public.get_q7_purchase_forecast(date, integer) — 20261014100000. CÓ lọc active:
--     "where kii.active = true
--        and (exists (... q7_material_issue_material_mappings ...)
--          or exists (... q7_purchase_item_settings ...)
--          or exists (... q7_inventory_movements ...))"
--   (lọc active = true nhưng KHÔNG lọc thêm merged_into_id).
-- ===========================================================================

-- ===========================================================================
-- 1. Bảng public.stock_item_discontinuations — món đã ngưng dùng
-- ===========================================================================

create table if not exists public.stock_item_discontinuations (
  item_id uuid primary key references public.kitchen_inventory_items(id),
  reason text,
  discontinued_by uuid,
  discontinued_at timestamptz not null default now()
);

alter table public.stock_item_discontinuations enable row level security;

drop policy if exists stock_item_discontinuations_select on public.stock_item_discontinuations;
create policy stock_item_discontinuations_select on public.stock_item_discontinuations
  for select to authenticated using (true);

-- Chỉ server ghi (security definer RPC); client chỉ đọc.
revoke all on table public.stock_item_discontinuations from public, anon, authenticated;
grant select on table public.stock_item_discontinuations to authenticated;
grant all on table public.stock_item_discontinuations to service_role;

-- ===========================================================================
-- 2. discontinue_stock_item — ngưng một món, chỉ khi nó không còn tồn
-- ===========================================================================

create or replace function public.discontinue_stock_item(
  p_item_id uuid,
  p_reason text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_as_of date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_tan_tao numeric;
  v_q7 numeric;
  v_reason text;
begin
  if not (
    public.q7_material_inventory_can_edit(v_actor)
    or public.can_edit_material_master()
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if v_item.merged_into_id is not null then
    raise exception 'item_merged' using errcode = '22023';
  end if;

  -- Serialize hai lần bấm đồng thời trên cùng một món (idempotency theo khoá hàm);
  -- p_request_id của client được nhận để giữ hợp đồng, khoá theo item là đủ.
  perform pg_advisory_xact_lock(hashtextextended('stock_item_discontinue:' || p_item_id::text, 0));

  -- Đọc lại dưới khoá: một lần bấm song song đã ngưng món thì thấy ngay.
  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id;

  -- Đã ngưng rồi: trả nguyên trạng thái, không ghi lại (idempotent).
  if v_item.active = false then
    return jsonb_build_object('item_id', v_item.id, 'name', v_item.name, 'active', false);
  end if;

  -- on_hand Tân Tạo, đúng công thức get_warehouse_game_snapshot('tan_tao').
  -- Sổ chưa ghi gì thì sum rỗng -> coalesce 0.
  select coalesce(sum(case m.movement_type
                       when 'receipt' then m.quantity
                       when 'opening' then m.quantity
                       when 'production_usage' then -m.quantity
                       when 'adjustment' then m.quantity
                       when 'transfer_out' then -m.quantity
                       else 0 end), 0)
  into v_tan_tao
  from public.tan_tao_material_movements m
  where m.kitchen_inventory_item_id = v_item.id
    and m.movement_date <= v_as_of;

  -- on_hand Q7, đúng công thức get_warehouse_game_snapshot('q7') (lateral openings
  -- rồi cộng receipt/transfer_in - production_usage + adjustment). Không có
  -- opening cũng như movement -> 0.
  select coalesce(o.opening_qty, 0)
         + coalesce(mt.receipt_qty, 0)
         - coalesce(mt.usage_qty, 0)
         + coalesce(mt.adjustment_qty, 0)
  into v_q7
  from (select v_item.id as id) base
  left join lateral (
    select o2.opening_qty, o2.effective_date
    from public.q7_inventory_openings o2
    where o2.kitchen_inventory_item_id = base.id
      and o2.effective_date <= v_as_of
    order by o2.effective_date desc, o2.updated_at desc, o2.id desc
    limit 1
  ) o on true
  left join lateral (
    select coalesce(sum(m.quantity) filter (where m.movement_type in ('receipt', 'transfer_in')), 0) as receipt_qty,
           coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0) as usage_qty,
           coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0) as adjustment_qty
    from public.q7_inventory_movements m
    where m.kitchen_inventory_item_id = base.id
      and m.movement_date <= v_as_of
      and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
  ) mt on true;

  if v_tan_tao <> 0 or v_q7 <> 0 then
    raise exception 'item_has_stock' using errcode = '22023',
      detail = jsonb_build_object('tan_tao', v_tan_tao, 'q7', v_q7)::text;
  end if;

  if exists (
    select 1
    from public.stock_count_lines l
    join public.stock_count_sessions s on s.id = l.session_id
    where l.target_kind = 'item'
      and l.target_id = v_item.id
      and s.status = 'open'
  ) then
    raise exception 'item_in_open_count' using errcode = '22023';
  end if;

  -- Trigger kitchen_inventory_items_unit_guard chạy khi update cột active nhưng
  -- bỏ qua kiểm tra trùng tên vì new.active = false, nên không cần tắt trigger.
  update public.kitchen_inventory_items
  set active = false
  where id = v_item.id;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  insert into public.stock_item_discontinuations(item_id, reason, discontinued_by, discontinued_at)
  values (v_item.id, v_reason, v_actor, now())
  on conflict (item_id) do update
    set reason = excluded.reason,
        discontinued_by = excluded.discontinued_by,
        discontinued_at = excluded.discontinued_at;

  delete from public.material_link_skips where item_id = v_item.id;
  delete from public.material_link_pending_factors where item_id = v_item.id;

  return jsonb_build_object('item_id', v_item.id, 'name', v_item.name, 'active', false);
end;
$$;

-- ===========================================================================
-- 3. reactivate_stock_item — khôi phục một món đã ngưng
-- ===========================================================================

create or replace function public.reactivate_stock_item(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
begin
  if not (
    public.q7_material_inventory_can_edit(v_actor)
    or public.can_edit_material_master()
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if v_item.merged_into_id is not null then
    raise exception 'item_merged' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('stock_item_discontinue:' || p_item_id::text, 0));

  update public.kitchen_inventory_items
  set active = true
  where id = v_item.id;

  delete from public.stock_item_discontinuations where item_id = v_item.id;

  return jsonb_build_object('item_id', v_item.id, 'name', v_item.name, 'active', true);
end;
$$;

-- ===========================================================================
-- 4. get_discontinued_stock_items — danh sách "Đã ngưng dùng"
-- ===========================================================================

create or replace function public.get_discontinued_stock_items()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_items jsonb := '[]'::jsonb;
begin
  if not (
    public.q7_material_inventory_can_view(v_actor)
    or public.can_view_tan_tao_warehouse()
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', kii.id,
           'item_code', kii.item_code,
           'name', kii.name,
           'unit', kii.unit,
           'pastry_q7', kii.pastry_q7,
           'reason', d.reason,
           'discontinued_by_name', (
             select coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), u.email)
             from auth.users u
             where u.id = d.discontinued_by
           ),
           'discontinued_at', d.discontinued_at
         ) order by d.discontinued_at desc, kii.id), '[]'::jsonb)
  into v_items
  from public.stock_item_discontinuations d
  join public.kitchen_inventory_items kii on kii.id = d.item_id
  where kii.active = false;

  return v_items;
end;
$$;

revoke all on function public.discontinue_stock_item(uuid, text, uuid) from public, anon;
revoke all on function public.reactivate_stock_item(uuid) from public, anon;
revoke all on function public.get_discontinued_stock_items() from public, anon;

grant execute on function public.discontinue_stock_item(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.reactivate_stock_item(uuid) to authenticated, service_role;
grant execute on function public.get_discontinued_stock_items() to authenticated, service_role;

-- ===========================================================================
-- 5. material_link_review_items_internal — thêm 'bot' vào stopword
--    (copy byte-for-byte từ 20261101210000, chỉ thêm 'bot' vào danh sách
--     stopword của luật cùng-đơn-vị/chung-từ; giữ nguyên revoke).
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
        and w <> all (array['thung','khoi','goi','hop','chai','binh','bich','tui','bao','can','cay','cuon','lon','hu','kg','gr','gram','ml','lit','l','g','cai','chiec','loai','dac','biet','bot','nhap','khau','nuoc','x','va','voi','cho','lam','banh','mi','lat','trang','den','tuoi','xop']::text[])
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
        and w <> all (array['thung','khoi','goi','hop','chai','binh','bich','tui','bao','can','cay','cuon','lon','hu','kg','gr','gram','ml','lit','l','g','cai','chiec','loai','dac','biet','bot','nhap','khau','nuoc','x','va','voi','cho','lam','banh','mi','lat','trang','den','tuoi','xop']::text[])
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
