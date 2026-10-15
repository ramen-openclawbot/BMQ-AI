-- Rollback-only production smoke for migration
-- 20261101270000_stock_count_sync_open_lines.sql.
--
-- Run as one file (from apps/web):
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_stock_count_sync.sql
--
-- The file opens one transaction, applies the migration SQL inline (the
-- migration is intentionally NOT pushed to production), then exercises
-- start_stock_count as the real owner ramen@bmq.vn (from auth.users) by setting
-- request.jwt.claims with role=authenticated. Every check raises SMOKE_FAIL on a
-- mismatch; the final success RAISE aborts the transaction, so every change
-- rolls back and the live database is untouched.

begin;

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

-- ===========================================================================
-- Smoke checks (all inside the rollback-only transaction)
-- ===========================================================================
do $smoke$
declare
  v_owner uuid;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_q7 jsonb;
  v_tt jsonb;
  v_q7_id uuid;
  v_tt_id uuid;
  v_count_line_id uuid;
  v_count_item_id uuid;
  v_remove_line_id uuid;
  v_remove_item_id uuid;
  v_saved_qty numeric := 7;
  v_counted numeric;
  v_diff integer;
  v_cancel jsonb;
  v_new jsonb;
  v_new_count integer;
  v_elig_count integer;
begin
  -- Real owner, simulated role authenticated.
  select u.id into v_owner
  from auth.users u
  where lower(u.email) = 'ramen@bmq.vn';
  if v_owner is null then
    raise exception 'SMOKE_FAIL: (0) ramen@bmq.vn not found in auth.users';
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- Clean slate inside the transaction so start_stock_count creates fresh sheets.
  update public.stock_count_sessions set status = 'cancelled' where status = 'open';

  -- -------------------------------------------------------------------------
  -- (1) Fresh sheets have exactly the uncounted lines of
  --     stock_count_eligible_lines at this moment.
  -- -------------------------------------------------------------------------
  v_q7 := public.start_stock_count('q7', 'smoke-sync-q7-1');
  v_tt := public.start_stock_count('tan_tao', 'smoke-sync-tt-1');
  if (v_q7 ->> 'status') <> 'open' or (v_tt ->> 'status') <> 'open' then
    raise exception 'SMOKE_FAIL: (1) sheets not open q7=% tt=%', v_q7 ->> 'status', v_tt ->> 'status';
  end if;
  v_q7_id := (v_q7 ->> 'id')::uuid;
  v_tt_id := (v_tt ->> 'id')::uuid;
  if jsonb_array_length(v_q7 -> 'lines') = 0 or jsonb_array_length(v_tt -> 'lines') = 0 then
    raise exception 'SMOKE_FAIL: (1) empty sheet lines';
  end if;

  select count(*) into v_diff from (
    (select target_kind, target_id, target_code, target_name, unit, book_qty
       from public.stock_count_lines
      where session_id = v_q7_id and counted_qty is null
     except
     select e.target_kind, e.target_id, e.target_code, e.target_name, e.unit, e.book_qty
       from public.stock_count_eligible_lines('q7', v_today) e)
    union all
    (select e.target_kind, e.target_id, e.target_code, e.target_name, e.unit, e.book_qty
       from public.stock_count_eligible_lines('q7', v_today) e
     except
     select target_kind, target_id, target_code, target_name, unit, book_qty
       from public.stock_count_lines
      where session_id = v_q7_id and counted_qty is null)
  ) d;
  if v_diff <> 0 then
    raise exception 'SMOKE_FAIL: (1) q7 uncounted lines differ from eligible by %', v_diff;
  end if;

  select count(*) into v_diff from (
    (select target_kind, target_id, target_code, target_name, unit, book_qty
       from public.stock_count_lines
      where session_id = v_tt_id and counted_qty is null
     except
     select e.target_kind, e.target_id, e.target_code, e.target_name, e.unit, e.book_qty
       from public.stock_count_eligible_lines('tan_tao', v_today) e)
    union all
    (select e.target_kind, e.target_id, e.target_code, e.target_name, e.unit, e.book_qty
       from public.stock_count_eligible_lines('tan_tao', v_today) e
     except
     select target_kind, target_id, target_code, target_name, unit, book_qty
       from public.stock_count_lines
      where session_id = v_tt_id and counted_qty is null)
  ) d;
  if v_diff <> 0 then
    raise exception 'SMOKE_FAIL: (1) tan_tao uncounted lines differ from eligible by %', v_diff;
  end if;

  -- -------------------------------------------------------------------------
  -- (2) Count one q7 line, then turn pastry_q7 off for it and for a still
  --     uncounted item that has no q7 movements. After start_stock_count the
  --     counted line stays and the ineligible uncounted line is gone.
  -- -------------------------------------------------------------------------
  select l.id, l.target_id into v_remove_line_id, v_remove_item_id
  from public.stock_count_lines l
  where l.session_id = v_q7_id
    and l.counted_qty is null
    and not exists (
      select 1 from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = l.target_id
    )
  order by l.target_name, l.target_id
  limit 1;

  select l.id, l.target_id into v_count_line_id, v_count_item_id
  from public.stock_count_lines l
  where l.session_id = v_q7_id
    and l.counted_qty is null
    and l.target_id <> v_remove_item_id
  order by l.target_name, l.target_id
  limit 1;

  if v_remove_line_id is null or v_count_line_id is null then
    raise exception 'SMOKE_FAIL: (2) no eligible q7 targets (remove=%, count=%)',
      v_remove_line_id, v_count_line_id;
  end if;

  perform public.save_stock_count_line(v_q7_id, v_count_line_id, v_saved_qty, 'smoke sync');

  update public.kitchen_inventory_items
  set pastry_q7 = false
  where id in (v_count_item_id, v_remove_item_id);

  v_q7 := public.start_stock_count('q7', 'smoke-sync-q7-2');
  if (v_q7 ->> 'id')::uuid <> v_q7_id then
    raise exception 'SMOKE_FAIL: (2) open sheet id changed';
  end if;

  select l.counted_qty into v_counted
  from public.stock_count_lines l
  where l.session_id = v_q7_id and l.id = v_count_line_id;
  if v_counted is null or v_counted <> v_saved_qty then
    raise exception 'SMOKE_FAIL: (2) counted line lost or changed: %', v_counted;
  end if;
  if exists (
    select 1 from public.stock_count_lines l
    where l.session_id = v_q7_id and l.id = v_remove_line_id
  ) then
    raise exception 'SMOKE_FAIL: (2) ineligible uncounted line was not removed';
  end if;

  -- -------------------------------------------------------------------------
  -- (3) Turn pastry_q7 back on for an active item missing from the sheet; the
  --     next sync must add its line.
  -- -------------------------------------------------------------------------
  update public.kitchen_inventory_items
  set pastry_q7 = true
  where id = v_remove_item_id;

  v_q7 := public.start_stock_count('q7', 'smoke-sync-q7-3');
  if not exists (
    select 1 from public.stock_count_lines l
    where l.session_id = v_q7_id
      and l.target_kind = 'item'
      and l.target_id = v_remove_item_id
  ) then
    raise exception 'SMOKE_FAIL: (3) re-enabled item did not reappear';
  end if;

  -- -------------------------------------------------------------------------
  -- (4) A sheet with no counted line gets count_date = today on the next sync.
  -- -------------------------------------------------------------------------
  update public.stock_count_sessions set count_date = v_today - 30 where id = v_tt_id;
  v_tt := public.start_stock_count('tan_tao', 'smoke-sync-tt-4');
  if (v_tt ->> 'count_date')::date <> v_today then
    raise exception 'SMOKE_FAIL: (4) count_date=% expected %', v_tt ->> 'count_date', v_today;
  end if;
  if exists (
    select 1 from public.stock_count_lines l
    where l.session_id = v_tt_id and l.counted_qty is not null
  ) then
    raise exception 'SMOKE_FAIL: (4) tan_tao sheet unexpectedly has counted lines';
  end if;

  -- -------------------------------------------------------------------------
  -- (5) Cancel the q7 sheet; the newly created sheet matches the eligible set.
  -- -------------------------------------------------------------------------
  v_cancel := public.cancel_stock_count(v_q7_id);
  if (v_cancel ->> 'status') <> 'cancelled' then
    raise exception 'SMOKE_FAIL: (5) cancel status=%', v_cancel ->> 'status';
  end if;
  v_new := public.start_stock_count('q7', 'smoke-sync-q7-5');
  v_new_count := jsonb_array_length(v_new -> 'lines');
  select count(*) into v_elig_count
  from public.stock_count_eligible_lines('q7', v_today);
  if v_new_count <> v_elig_count then
    raise exception 'SMOKE_FAIL: (5) new sheet lines=% eligible=%', v_new_count, v_elig_count;
  end if;

  raise exception 'SMOKE_RESULT PASS: (1) eligible_sync (2) counted_kept_ineligible_dropped (3) reenabled_added (4) count_date_reset (5) fresh_after_cancel';
end;
$smoke$;

rollback;
