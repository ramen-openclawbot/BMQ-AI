-- 2026-10-21 — Công tắc ON/OFF cho từng món kho (owner 21/10).
--
-- Owner request 21/10: mỗi món kho có một công tắc ON/OFF. Được phép ngưng dùng
-- một món NGAY CẢ KHI còn tồn (ví dụ món đã hết dùng nhưng sổ còn số dư): lần
-- ngưng ghi lại tồn Tân Tạo/Q7 tại thời điểm ngưng vào
-- stock_item_discontinuations.tan_tao_qty_at_stop / q7_qty_at_stop, để màn hình
-- "Đã ngưng dùng" vẫn hiển thị đúng kệ/kho. Bật lại dùng reactivate_stock_item.
--
-- Quyền: giữ nguyên cửa cũ (q7_material_inventory_can_edit /
-- can_edit_material_master) và MỞ THÊM cho người có quyền sửa module 'inventory'
-- (has_module_permission(actor, 'inventory', 'edit')) ở cả ngưng lẫn bật lại.
--
-- get_discontinued_stock_items trả thêm item_class, tồn hiện tại (tan_tao_qty,
-- q7_qty), in_q7, used_7d và tồn tại thời điểm ngưng; get_stock_ledger_overview
-- đánh dấu 'active' và không bao giờ báo "sắp hết" cho món đã ngưng.
--
-- Migration này do Maestro apply; nó không tự apply. Không tắt trigger nào.

-- ===========================================================================
-- 1. Tồn tại thời điểm ngưng
-- ===========================================================================

alter table public.stock_item_discontinuations
  add column if not exists tan_tao_qty_at_stop numeric,
  add column if not exists q7_qty_at_stop numeric;

-- ===========================================================================
-- 2. discontinue_stock_item — ngưng một món, cho phép còn tồn
--    (copy từ bản mới nhất 20261101240000; bỏ chặn item_has_stock, ghi tồn
--     tại thời điểm ngưng, mở thêm quyền sửa module 'inventory')
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
    or public.has_module_permission(v_actor, 'inventory', 'edit')
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

  -- Owner 21/10: ngưng được cả khi còn tồn; tồn được ghi lại bên dưới.

  -- Owner 15/10: an uncounted line in an open count is simply dropped from that
  -- sheet; only a line that already has a counted quantity blocks the stop.
  if exists (
    select 1
    from public.stock_count_lines l
    join public.stock_count_sessions s on s.id = l.session_id
    where l.target_kind = 'item'
      and l.target_id = v_item.id
      and s.status = 'open'
      and l.counted_qty is not null
  ) then
    raise exception 'item_in_open_count' using errcode = '22023';
  end if;
  delete from public.stock_count_lines l
  using public.stock_count_sessions s
  where s.id = l.session_id
    and s.status = 'open'
    and l.target_kind = 'item'
    and l.target_id = v_item.id
    and l.counted_qty is null;

  -- Trigger kitchen_inventory_items_unit_guard chạy khi update cột active nhưng
  -- bỏ qua kiểm tra trùng tên vì new.active = false, nên không cần tắt trigger.
  update public.kitchen_inventory_items
  set active = false
  where id = v_item.id;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  insert into public.stock_item_discontinuations(
    item_id, reason, discontinued_by, discontinued_at,
    tan_tao_qty_at_stop, q7_qty_at_stop
  )
  values (v_item.id, v_reason, v_actor, now(), v_tan_tao, v_q7)
  on conflict (item_id) do update
    set reason = excluded.reason,
        discontinued_by = excluded.discontinued_by,
        discontinued_at = excluded.discontinued_at,
        tan_tao_qty_at_stop = excluded.tan_tao_qty_at_stop,
        q7_qty_at_stop = excluded.q7_qty_at_stop;

  delete from public.material_link_skips where item_id = v_item.id;
  delete from public.material_link_pending_factors where item_id = v_item.id;

  return jsonb_build_object('item_id', v_item.id, 'name', v_item.name, 'active', false);
end;
$$;

-- ===========================================================================
-- 3. reactivate_stock_item — khôi phục một món đã ngưng
--    (copy từ 20261101230000; chỉ mở thêm quyền sửa module 'inventory')
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
    or public.has_module_permission(v_actor, 'inventory', 'edit')
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
--    (copy từ 20261101230000; thêm item_class, tồn hiện tại, in_q7, used_7d
--     và tồn tại thời điểm ngưng)
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
  v_as_of date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
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
           'item_class', kii.item_class,
           'pastry_q7', kii.pastry_q7,
           -- Tồn hiện tại, cùng công thức discontinue_stock_item.
           'tan_tao_qty', (
             select coalesce(sum(case m.movement_type
                                  when 'receipt' then m.quantity
                                  when 'opening' then m.quantity
                                  when 'production_usage' then -m.quantity
                                  when 'adjustment' then m.quantity
                                  when 'transfer_out' then -m.quantity
                                  else 0 end), 0)
             from public.tan_tao_material_movements m
             where m.kitchen_inventory_item_id = kii.id
               and m.movement_date <= v_as_of
           ),
           'q7_qty', (
             select coalesce(o.opening_qty, 0)
                    + coalesce(mt.receipt_qty, 0)
                    - coalesce(mt.usage_qty, 0)
                    + coalesce(mt.adjustment_qty, 0)
             from (select kii.id as id) base
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
             ) mt on true
           ),
           -- Ở Q7 khi cờ pastry_q7 bật hoặc món đã từng có movement Q7.
           'in_q7', (
             coalesce(kii.pastry_q7, false)
             or exists (
               select 1 from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = kii.id
             )
           ),
           -- Có dùng thực tế trong 7 ngày Việt Nam gần nhất ở một trong hai kho.
           'used_7d', (
             exists (
               select 1 from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.movement_type = 'production_usage'
                 and m.movement_date between v_as_of - 6 and v_as_of
             )
             or exists (
               select 1 from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.movement_type = 'production_usage'
                 and m.movement_date between v_as_of - 6 and v_as_of
             )
           ),
           'tan_tao_qty_at_stop', d.tan_tao_qty_at_stop,
           'q7_qty_at_stop', d.q7_qty_at_stop,
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

-- ===========================================================================
-- 5. get_stock_ledger_overview — 'active' + không báo "sắp hết" khi đã ngưng
--    (copy từ 20261102410000, giữ nguyên materialized pending-alias CTE và
--     pass_through; chỉ thêm 'active' và ghép vào is_low_stock)
-- ===========================================================================

create or replace function public.get_stock_ledger_overview(
  p_location text,
  p_as_of date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_cutover date;
  v_location_name text;
  v_items jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_materials jsonb := '[]'::jsonb;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if p_location = 'q7' then
      if not public.q7_material_inventory_can_view(v_actor) then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    else
      if not public.can_view_tan_tao_warehouse() then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    end if;
  end if;

  v_cutover := public.stock_ledger_cutover_date(p_location);

  if p_location = 'q7' then
    v_location_name := 'Kho NVL Q7';
    select coalesce(jsonb_agg(jsonb_build_object(
             'item_id', x.item_id,
             'item_code', x.item_code,
             'item_name', x.item_name,
             'unit', x.unit,
             'current_qty', x.balance_qty,
             'in_qty_7d', x.in_qty_7d,
             'out_qty_7d', x.out_qty_7d,
             'last_count_date', x.last_count_date,
             'last_count_difference', x.last_count_difference,
             'active', coalesce(x.active, true),
             'is_low_stock', (coalesce(x.active, true) and x.out_qty_7d > 0 and x.balance_qty < (x.out_qty_7d / 7.0) * 3)
           ) order by x.item_name), '[]'::jsonb)
    into v_items
    from (
      select s.kitchen_inventory_item_id as item_id,
             kii.item_code,
             s.item_name,
             s.unit,
             s.balance_qty,
             kii.active,
             coalesce((
               select sum(m.quantity)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = s.kitchen_inventory_item_id
                 and m.movement_type in ('receipt', 'transfer_in')
                 and m.movement_date between v_as_of - 6 and v_as_of
             ), 0)::numeric as in_qty_7d,
             coalesce((
               select sum(m.quantity)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = s.kitchen_inventory_item_id
                 and m.movement_type = 'production_usage'
                 and m.movement_date between v_as_of - 6 and v_as_of
             ), 0)::numeric as out_qty_7d,
             (
               select max(m.movement_date)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = s.kitchen_inventory_item_id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'q7-stock-count:%'
                 and m.movement_date <= v_as_of
             ) as last_count_date,
             (
               select m.quantity
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = s.kitchen_inventory_item_id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'q7-stock-count:%'
                 and m.movement_date <= v_as_of
               order by m.movement_date desc, m.created_at desc, m.id desc
               limit 1
             ) as last_count_difference
      from public.get_q7_inventory_snapshot(v_as_of) s
      join public.kitchen_inventory_items kii on kii.id = s.kitchen_inventory_item_id
    ) x;
  else
    v_location_name := 'Kho Tân Tạo';
    select coalesce(jsonb_agg(jsonb_build_object(
             'item_id', x.item_id,
             'item_code', x.item_code,
             'item_name', x.item_name,
             'unit', x.unit,
             'current_qty', x.balance_qty,
             'in_qty_7d', x.in_qty_7d,
             'out_qty_7d', x.out_qty_7d,
             'last_count_date', x.last_count_date,
             'last_count_difference', x.last_count_difference,
             'active', true,
             'is_low_stock', (x.out_qty_7d > 0 and x.balance_qty < (x.out_qty_7d / 7.0) * 3)
           ) order by x.item_name), '[]'::jsonb)
    into v_items
    from (
      select (it ->> 'sku_id') as item_id,
             (it ->> 'sku_code') as item_code,
             (it ->> 'product_name') as item_name,
             (it ->> 'unit') as unit,
             coalesce((it ->> 'on_hand_quantity')::numeric, 0) as balance_qty,
             coalesce((
               select sum(m.quantity)
               from public.tan_tao_warehouse_movements m
               where m.sku_id = (it ->> 'sku_id')::uuid
                 and m.movement_type in ('receipt', 'opening')
                 and m.created_at >= (v_as_of - 6)::timestamptz
                 and m.created_at < (v_as_of + 1)::timestamptz
             ), 0)::numeric as in_qty_7d,
             coalesce((
               select sum(-m.quantity)
               from public.tan_tao_warehouse_movements m
               where m.sku_id = (it ->> 'sku_id')::uuid
                 and m.movement_type = 'dispatch'
                 and m.created_at >= (v_as_of - 6)::timestamptz
                 and m.created_at < (v_as_of + 1)::timestamptz
             ), 0)::numeric as out_qty_7d,
             (
               select (d.created_at at time zone 'Asia/Ho_Chi_Minh')::date
               from public.tan_tao_warehouse_documents d
               where d.sku_id = (it ->> 'sku_id')::uuid
                 and d.document_type = 'stock_count'
               order by d.created_at desc
               limit 1
             ) as last_count_date,
             (
               select coalesce(nullif(d.metadata ->> 'adjustment_quantity', '')::numeric, 0)
               from public.tan_tao_warehouse_documents d
               where d.sku_id = (it ->> 'sku_id')::uuid
                 and d.document_type = 'stock_count'
               order by d.created_at desc
               limit 1
             ) as last_count_difference
      from jsonb_array_elements(public.get_tan_tao_warehouse_snapshot() -> 'items') it
      where it ->> 'sku_id' is not null
    ) x;

    -- Shared NVL items that have moved at Tân Tạo.
    select coalesce(jsonb_agg(jsonb_build_object(
             'item_id', x.item_id,
             'item_code', x.item_code,
             'item_name', x.item_name,
             'unit', x.unit,
             'current_qty', x.balance_qty,
             'in_qty_7d', x.in_qty_7d,
             'out_qty_7d', x.out_qty_7d,
             'last_count_date', x.last_count_date,
             'last_count_difference', x.last_count_difference,
             'pass_through', x.pass_through,
             'active', coalesce(x.active, true),
             'is_low_stock', (not x.pass_through and coalesce(x.active, true) and x.out_qty_7d > 0 and x.balance_qty < (x.out_qty_7d / 7.0) * 3)
           ) order by x.item_name), '[]'::jsonb)
    into v_materials
    from (
      select kii.id as item_id,
             kii.item_code,
             kii.name as item_name,
             kii.unit,
             kii.active,
             coalesce((
               select sum(case m.movement_type
                            when 'receipt' then m.quantity
                            when 'opening' then m.quantity
                            when 'production_usage' then -m.quantity
                            when 'adjustment' then m.quantity
                            when 'transfer_out' then -m.quantity
                            else 0 end)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.movement_date <= v_as_of
             ), 0)::numeric as balance_qty,
             coalesce((
               select sum(m.quantity)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.movement_type in ('receipt', 'opening')
                 and m.movement_date between v_as_of - 6 and v_as_of
             ), 0)::numeric as in_qty_7d,
             coalesce((
               select sum(m.quantity)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.movement_type in ('production_usage', 'transfer_out')
                 and m.movement_date between v_as_of - 6 and v_as_of
             ), 0)::numeric as out_qty_7d,
             (
               select max(m.movement_date)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'tt-material-count:%'
                 and m.movement_date <= v_as_of
             ) as last_count_date,
             (
               select m.quantity
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'tt-material-count:%'
                 and m.movement_date <= v_as_of
               order by m.movement_date desc, m.created_at desc, m.id desc
               limit 1
             ) as last_count_difference,
              coalesce(kii.pastry_q7, false) as pass_through
      from public.kitchen_inventory_items kii
      where kii.merged_into_id is null
        and exists (
          select 1 from public.tan_tao_material_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
    ) x;
  end if;

  if v_cutover is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'goods_receipt_item_id', p.goods_receipt_item_id,
             'receipt_number', p.receipt_number,
             'supplier', p.supplier_name,
             'product_name', p.product_name,
             'normalized_name', p.normalized_name,
             'quantity', p.quantity,
             'receipt_date', p.receipt_date
           ) order by p.receipt_date, p.receipt_number), '[]'::jsonb)
    into v_pending
    from (
      -- Only this location's confirmed receipts since the cutover reach the per-line checks.
      -- Before 20/10 the planner ran stock_line_auto_non_stock / stock_goods_receipt_item_is_posted
      -- over every goods_receipt_items row once per matching receipt (≈50 s at Tân Tạo, statement timeout).
      with lines as materialized (
        select gri.id,
               gri.product_name,
               coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as source_name,
               coalesce(gri.actual_quantity, gri.quantity, 0) as raw_quantity,
               gr.receipt_number,
               gr.receipt_date,
               gr.supplier_id
        from public.goods_receipts gr
        join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
        where gr.receiving_location = p_location
          and gr.status in ('confirmed', 'received')
          and gr.receipt_date >= v_cutover
      )
      select l.id as goods_receipt_item_id,
             l.receipt_number,
             sup.name as supplier_name,
             l.product_name,
             ra.normalized_name,
             greatest(0, l.raw_quantity)::numeric as quantity,
             l.receipt_date
      from lines l
      left join public.suppliers sup on sup.id = l.supplier_id
      left join lateral (
        select
          public.normalize_stock_item_name(l.source_name) as normalized_name,
          a.id as alias_id,
          a.line_class as line_class
        from public.resolve_stock_material_alias(
               l.supplier_id,
               public.normalize_stock_item_name(l.source_name),
               p_location
             ) a
      ) ra on true
      where coalesce(sup.stock_exempt, false) = false
        and ra.alias_id is null
        and coalesce(ra.line_class, 'stock') <> 'non_stock'
        and public.stock_line_auto_non_stock(l.source_name) is null
        and not public.stock_goods_receipt_item_is_posted(l.id)
    ) p;
  end if;

  return jsonb_build_object(
    'location', p_location,
    'location_name', v_location_name,
    'as_of', v_as_of,
    'cutover_date', v_cutover,
    'items', v_items,
    'materials', v_materials,
    'pending_aliases', v_pending
  );
end;
$$;

-- ===========================================================================
-- 6. Quyền thực thi: giữ nguyên hợp đồng cũ cho mọi hàm được định nghĩa lại
-- ===========================================================================

revoke all on function public.discontinue_stock_item(uuid, text, uuid) from public, anon;
revoke all on function public.reactivate_stock_item(uuid) from public, anon;
revoke all on function public.get_discontinued_stock_items() from public, anon;
revoke all on function public.get_stock_ledger_overview(text, date) from public, anon;

grant execute on function public.discontinue_stock_item(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.reactivate_stock_item(uuid) to authenticated, service_role;
grant execute on function public.get_discontinued_stock_items() to authenticated, service_role;
grant execute on function public.get_stock_ledger_overview(text, date) to authenticated, service_role;
