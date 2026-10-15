-- 2026-11-01 — Ngưng dùng: dòng kiểm kê chưa đếm không còn chặn (owner 15/10).
-- 'Bột custard sư tử' nằm trong phiếu kiểm kê Tân Tạo 14/10 đang mở (109 dòng, chưa đếm dòng nào).
-- Luật mới: dòng chưa có số đếm của món trong phiếu đang mở được bỏ khỏi phiếu khi ngưng dùng;
-- dòng đã có số đếm vẫn chặn (item_in_open_count). Phần còn lại của hàm giữ nguyên bản 20261101230000.

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

revoke all on function public.discontinue_stock_item(uuid, text, uuid) from public, anon;
grant execute on function public.discontinue_stock_item(uuid, text, uuid) to authenticated, service_role;
