-- Phiếu kiểm kê chưa đếm tự cập nhật danh sách món.
--
-- Lý do: chủ phiếu ngày 15/10 mở phiếu Q7 (tạo từ ngày 14/10) và vẫn còn thấy
-- những món đã bị bỏ khỏi kho (ngưng dùng / tắt cờ pastry_q7) nằm trong danh
-- sách chưa đếm. Từ nay mỗi lần start_stock_count trả lại phiếu đang mở, các
-- dòng CHƯA đếm của phiếu được đối chiếu lại với danh sách món đủ điều kiện tại
-- thời điểm gọi: bỏ món không còn đủ điều kiện, cập nhật mã/tên/đơn vị/số sổ, và
-- thêm món mới đủ điều kiện. Dòng đã có counted_qty không bao giờ bị đổi, kể cả
-- khi món đó không còn đủ điều kiện. Nếu sau khi đồng bộ phiếu không còn dòng
-- nào đã đếm thì count_date = hôm nay (Asia/Ho_Chi_Minh). Phiếu mới tạo vẫn lấy
-- dòng từ đúng nguồn cũ nên kết quả không đổi.

-- ---------------------------------------------------------------------------
-- 1. stock_count_eligible_lines — nguồn dòng đủ điều kiện dùng chung
-- ---------------------------------------------------------------------------
-- Tách nguyên phần SELECT tạo dòng của start_stock_count (nhánh q7 và Tân Tạo,
-- cùng công thức số sổ) để phiếu mới và bước đồng bộ dùng chung một nguồn.

create or replace function public.stock_count_eligible_lines(
  p_location text,
  p_as_of date
)
returns table (
  target_kind text,
  target_id uuid,
  target_code text,
  target_name text,
  unit text,
  book_qty numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;

  if p_location = 'q7' then
    -- Same live-item source and on_hand formula as get_warehouse_game_snapshot('q7'):
    -- the Q7 ledger only ever receives pastry items, so the count mirrors that set.
    -- item_class = 'non_stock' is not a stock-tracked item and is left out.
    return query
    select 'item'::text, x.id, x.item_code, x.name, x.unit, x.on_hand
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
             (
               coalesce(o.opening_qty, 0)
               + coalesce(mt.receipt_qty, 0)
               - coalesce(mt.usage_qty, 0)
               + coalesce(mt.adjustment_qty, 0)
             ) as on_hand
      from public.kitchen_inventory_items kii
      left join lateral (
        select o2.opening_qty, o2.effective_date
        from public.q7_inventory_openings o2
        where o2.kitchen_inventory_item_id = kii.id
          and o2.effective_date <= p_as_of
        order by o2.effective_date desc, o2.updated_at desc, o2.id desc
        limit 1
      ) o on true
      left join lateral (
        select coalesce(sum(m.quantity) filter (where m.movement_type in ('receipt', 'transfer_in')), 0) as receipt_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0) as usage_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0) as adjustment_qty
        from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = kii.id
          and m.movement_date <= p_as_of
          and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
      ) mt on true
      where kii.active = true
        and kii.merged_into_id is null
        and (kii.pastry_q7 = true or exists (select 1 from public.q7_inventory_movements qm where qm.kitchen_inventory_item_id = kii.id))
        and coalesce(kii.item_class, 'unclassified') <> 'non_stock'
    ) x;
  else
    -- Tân Tạo shares the whole live NVL catalog; the on_hand formula matches
    -- get_warehouse_game_snapshot('tan_tao').
    return query
    select 'item'::text, x.id, x.item_code, x.name, x.unit, x.on_hand
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
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
                 and m.movement_date <= p_as_of
             ), 0) as on_hand
      from public.kitchen_inventory_items kii
      where kii.active = true
        and kii.merged_into_id is null
        and coalesce(kii.item_class, 'unclassified') <> 'non_stock'
    ) x;

    -- Finished-goods SKUs from the get_tan_tao_warehouse_snapshot source: the four
    -- quantity-tracked SKUs of the Tân Tạo warehouse, with the same on_hand total.
    return query
    select 'sku'::text, ps.id, ps.sku_code, ps.product_name, ps.unit,
           coalesce((
             select sum(m.quantity)
             from public.tan_tao_warehouse_movements m
             where m.sku_id = ps.id
               and m.location_code = 'warehouse_tan_tao'
           ), 0)
    from public.product_skus ps
    where upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');
  end if;
end;
$$;

-- Internal helper: only the security-definer RPCs above need it.
revoke all on function public.stock_count_eligible_lines(text, date) from public, anon, authenticated;
grant execute on function public.stock_count_eligible_lines(text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 2. stock_count_sync_open_lines — refresh the uncounted lines of an open sheet
-- ---------------------------------------------------------------------------

create or replace function public.stock_count_sync_open_lines(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.stock_count_sessions%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_has_counted boolean;
begin
  select * into v_session
  from public.stock_count_sessions
  where id = p_session_id
  for update;
  if not found then
    return;
  end if;
  -- Only an open sheet is synced; submitted / cancelled sheets are history.
  if v_session.status <> 'open' then
    return;
  end if;

  -- (a) Bỏ dòng chưa đếm mà món không còn đủ điều kiện.
  delete from public.stock_count_lines l
  where l.session_id = v_session.id
    and l.counted_qty is null
    and not exists (
      select 1
      from public.stock_count_eligible_lines(v_session.location, v_today) e
      where e.target_kind = l.target_kind
        and e.target_id = l.target_id
    );

  -- (b) Cập nhật mã / tên / đơn vị / số sổ hiện tại cho dòng chưa đếm.
  update public.stock_count_lines l
  set target_code = e.target_code,
      target_name = e.target_name,
      unit = e.unit,
      book_qty = e.book_qty
  from public.stock_count_eligible_lines(v_session.location, v_today) e
  where l.session_id = v_session.id
    and l.counted_qty is null
    and e.target_kind = l.target_kind
    and e.target_id = l.target_id;

  -- (c) Thêm món đủ điều kiện mà phiếu chưa có dòng nào.
  insert into public.stock_count_lines(
    session_id, target_kind, target_id, target_code, target_name, unit, book_qty
  )
  select v_session.id, e.target_kind, e.target_id, e.target_code, e.target_name, e.unit, e.book_qty
  from public.stock_count_eligible_lines(v_session.location, v_today) e
  where not exists (
    select 1
    from public.stock_count_lines l
    where l.session_id = v_session.id
      and l.target_kind = e.target_kind
      and l.target_id = e.target_id
  );

  -- Không còn dòng nào đã đếm: phiếu bắt đầu lại từ hôm nay.
  select exists (
    select 1
    from public.stock_count_lines l
    where l.session_id = v_session.id
      and l.counted_qty is not null
  ) into v_has_counted;

  if not v_has_counted then
    update public.stock_count_sessions
    set count_date = v_today
    where id = v_session.id;
  end if;
end;
$$;

revoke all on function public.stock_count_sync_open_lines(uuid) from public, anon, authenticated;
grant execute on function public.stock_count_sync_open_lines(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. start_stock_count — new sheets read the shared source; open sheets sync
-- ---------------------------------------------------------------------------

create or replace function public.start_stock_count(
  p_location text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.stock_count_sessions%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.stock_count_can_edit(p_location) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  -- Retry of the exact same request returns its session, whatever its status.
  if v_key is not null then
    select * into v_session
    from public.stock_count_sessions
    where idempotency_key = v_key;
    if found then
      return public.stock_count_session_json(v_session, true);
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('stock_count:' || p_location, 0));

  -- An open session already exists: refresh its uncounted lines, then reuse it.
  select * into v_session
  from public.stock_count_sessions
  where location = p_location and status = 'open'
  order by opened_at asc, id asc
  limit 1;
  if found then
    perform public.stock_count_sync_open_lines(v_session.id);
    select * into v_session
    from public.stock_count_sessions
    where id = v_session.id;
    return public.stock_count_session_json(v_session, true);
  end if;

  insert into public.stock_count_sessions(
    location, count_date, status, opened_by, opened_at, idempotency_key
  ) values (
    p_location, v_today, 'open', v_actor, now(), v_key
  )
  returning * into v_session;

  -- Same line set as before, now read from the shared source.
  insert into public.stock_count_lines(
    session_id, target_kind, target_id, target_code, target_name, unit, book_qty
  )
  select v_session.id, e.target_kind, e.target_id, e.target_code, e.target_name, e.unit, e.book_qty
  from public.stock_count_eligible_lines(p_location, v_today) e;

  return public.stock_count_session_json(v_session, true);
end;
$$;

revoke all on function public.start_stock_count(text, text) from public, anon;
grant execute on function public.start_stock_count(text, text) to authenticated, service_role;
