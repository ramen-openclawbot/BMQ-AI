-- 2026-11-01 — Sổ thành phẩm Q7 + phiếu nhập/xuất thành phẩm (phần dữ liệu).
--
-- Owner operating model 2026-11-01:
--   * Q7 keeps an append-only finished-goods ledger per SKU
--     (public.q7_finished_goods_movements). A row is written only by the two
--     security-definer RPCs below, never updated and never deleted.
--   * Operators can receive finished goods from production in 1..30 lines
--     (shared slip_id / NTP-YYYYMMDD-XXXXXX slip_number) and issue them as a
--     dispatch or a write-off (shared slip_id / XTP-YYYYMMDD-XXXXXX). Both calls
--     are idempotent per p_request_id, take an advisory lock per SKU and never
--     touch production_order_items.actual_qty or any other existing row.
--   * An issue may never push a SKU below zero: the current on-hand is the sum
--     of the SKU's ledger rows.
--
-- This migration never UPDATEs or DELETEs a posted
-- q7_finished_goods_movements, production_order_items, q7_inventory_movements
-- or tan_tao_warehouse_movements row. The only writes are the new ledger rows
-- and the service-only idempotency row.
--
-- Readers audited for the new ledger:
--   * public.get_warehouse_game_snapshot(text) — redefined below. The Tân Tạo
--     branch is byte-for-byte unchanged; the Q7 branch now returns finished-goods
--     SKUs with at least one q7_finished_goods_movements row or a q7 production
--     order line in the last 30 days, with on_hand = sum of ledger rows.
--   * public.get_q7_finished_goods_planned(date) — new reader for the day's Q7
--     production plan lines and how much was already received against each.
--   * public.create_q7_finished_goods_receipt / public.create_q7_finished_goods_issue
--     — new writers; the only callers allowed to insert into the ledger.
--   * public.get_q7_inventory_snapshot, get_stock_ledger_overview,
--     record_tan_tao_material_count, apply_stock_item_merge,
--     revert_stock_item_merge, stock_item_merge_forward,
--     tan_tao_material_merge_forward, mission_evaluate — do not read this ledger.
--
-- The Maestro applies this migration; it is not applied by this change.

-- ===========================================================================
-- 1. q7_finished_goods_movements — append-only finished-goods ledger per SKU
-- ===========================================================================

create table if not exists public.q7_finished_goods_movements (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.product_skus(id) on delete restrict,
  sku_code_snapshot text not null,
  movement_type text not null,
  quantity numeric not null,
  movement_date date not null,
  slip_id uuid not null,
  slip_number text not null,
  production_order_item_id uuid references public.production_order_items(id) on delete restrict,
  request_id uuid not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint q7_finished_goods_movements_type_check
    check (movement_type in ('production_receipt', 'dispatch', 'write_off', 'adjustment')),
  constraint q7_finished_goods_movements_quantity_nonzero_check
    check (quantity <> 0),
  constraint q7_finished_goods_movements_sign_check
    check (
      (movement_type = 'production_receipt' and quantity > 0)
      or (movement_type in ('dispatch', 'write_off') and quantity < 0)
      or movement_type = 'adjustment'
    ),
  constraint q7_finished_goods_movements_slip_number_check
    check (
      (movement_type = 'production_receipt' and slip_number ~ '^NTP-[0-9]{8}-[A-Z0-9]{6}$')
      or (movement_type in ('dispatch', 'write_off') and slip_number ~ '^XTP-[0-9]{8}-[A-Z0-9]{6}$')
      or movement_type = 'adjustment'
    )
);

create index if not exists idx_q7_finished_goods_movements_sku_date
  on public.q7_finished_goods_movements(sku_id, movement_date);

create index if not exists idx_q7_finished_goods_movements_slip_id
  on public.q7_finished_goods_movements(slip_id);

alter table public.q7_finished_goods_movements enable row level security;

-- Same reader gate as get_warehouse_game_snapshot('q7'): Q7 stock viewers only.
drop policy if exists q7_finished_goods_movements_select on public.q7_finished_goods_movements;
create policy q7_finished_goods_movements_select
  on public.q7_finished_goods_movements for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

revoke all on table public.q7_finished_goods_movements from public, anon, authenticated;
grant select on table public.q7_finished_goods_movements to authenticated;
grant all on table public.q7_finished_goods_movements to service_role;

-- Append-only: any UPDATE / DELETE raises, so the ledger can only grow.
create or replace function public.q7_finished_goods_movements_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'q7_finished_goods_movements are append-only' using errcode = '23514';
end;
$$;

drop trigger if exists q7_finished_goods_movements_append_only on public.q7_finished_goods_movements;
create trigger q7_finished_goods_movements_append_only
  before update or delete on public.q7_finished_goods_movements
  for each row execute function public.q7_finished_goods_movements_append_only();

revoke all on function public.q7_finished_goods_movements_append_only() from public, anon, authenticated;

-- ===========================================================================
-- 2. q7_finished_goods_requests — service-only idempotency ledger
-- ===========================================================================

create table if not exists public.q7_finished_goods_requests (
  request_id uuid primary key,
  kind text not null,
  slip_id uuid not null,
  slip_number text not null,
  result jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.q7_finished_goods_requests enable row level security;

-- No client policy at all: only the security-definer RPCs (and service_role)
-- touch this table.
revoke all on table public.q7_finished_goods_requests from public, anon, authenticated;
grant all on table public.q7_finished_goods_requests to service_role;

-- ===========================================================================
-- 3. create_q7_finished_goods_receipt — one slip, 1..30 lines, atomic
-- ===========================================================================

create or replace function public.create_q7_finished_goods_receipt(
  p_lines jsonb,
  p_note text,
  p_request_id uuid,
  p_date date default (now() at time zone 'Asia/Ho_Chi_Minh')::date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request uuid := p_request_id;
  v_date date;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_line_count integer;
  v_sku_ids uuid[] := '{}';
  v_ele record;
  v_id_text text;
  v_sku_id uuid;
  v_poi_id uuid;
  v_qty numeric;
  v_found integer;
  v_sku public.product_skus%rowtype;
  v_slip_id uuid := gen_random_uuid();
  v_slip_number text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_lines jsonb := '[]'::jsonb;
  v_on_hand numeric;
  v_lock_sku uuid;
  v_result jsonb;
begin
  -- Actor + permission: service_role bypasses, everyone else needs the Tân Tạo
  -- manage permission, the owner role or the Q7 material admin permission.
  if not v_is_service then
    if v_actor is null then
      raise exception 'finished_goods_forbidden: Cần đăng nhập để nhập/xuất thành phẩm Q7.' using errcode = '42501';
    end if;
    if not (
      public.can_manage_tan_tao_warehouse()
      or public.has_role(v_actor, 'owner')
      or public.material_alias_can_admin(v_actor)
    ) then
      raise exception 'finished_goods_forbidden: Tài khoản chưa có quyền nhập/xuất thành phẩm Q7.' using errcode = '42501';
    end if;
  end if;

  if v_request is null then
    raise exception 'request_id_required: Thiếu mã yêu cầu.' using errcode = '22023';
  end if;

  -- Idempotency: the same request returns the stored result unchanged. The
  -- advisory lock serialises concurrent retries of the same request.
  perform pg_advisory_xact_lock(
    hashtextextended('q7_finished_goods_request:' || v_request::text, 0)
  );
  select r.result into v_existing
  from public.q7_finished_goods_requests r
  where r.request_id = v_request;
  if found then
    return v_existing;
  end if;

  -- 1..30 lines.
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines_required: Phiếu nhập phải có ít nhất 1 dòng.' using errcode = '22023';
  end if;
  v_line_count := jsonb_array_length(p_lines);
  if v_line_count = 0 then
    raise exception 'lines_required: Phiếu nhập phải có ít nhất 1 dòng.' using errcode = '22023';
  end if;
  if v_line_count > 30 then
    raise exception 'too_many_lines: Phiếu nhập chỉ được tối đa 30 dòng.' using errcode = '22023';
  end if;

  -- Every line needs a real SKU, a positive number and (when given) a Q7
  -- production-order item that carries the same SKU.
  for v_ele in
    select value as raw, ordinality as ord
    from jsonb_array_elements(p_lines) with ordinality
  loop
    if jsonb_typeof(v_ele.raw) <> 'object' then
      raise exception 'line_invalid: Dòng thành phẩm không hợp lệ.' using errcode = '22023';
    end if;

    v_id_text := nullif(btrim(v_ele.raw ->> 'sku_id'), '');
    if v_id_text is null
       or v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'sku_invalid: Mã SKU không hợp lệ.' using errcode = '22023';
    end if;
    v_sku_id := v_id_text::uuid;

    if not exists (select 1 from public.product_skus ps where ps.id = v_sku_id) then
      raise exception 'sku_invalid: SKU không tồn tại.' using errcode = '22023';
    end if;
    v_sku_ids := v_sku_ids || v_sku_id;

    if jsonb_typeof(v_ele.raw -> 'quantity') is distinct from 'number' then
      raise exception 'quantity_invalid: Số lượng nhập phải là số lớn hơn 0.' using errcode = '22023';
    end if;
    v_qty := (v_ele.raw ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0
       or v_qty::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'quantity_invalid: Số lượng nhập phải là số lớn hơn 0.' using errcode = '22023';
    end if;

    v_id_text := nullif(btrim(coalesce(v_ele.raw ->> 'production_order_item_id', '')), '');
    if v_id_text is not null then
      if v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'production_order_item_invalid: Dòng lệnh sản xuất không hợp lệ.' using errcode = '22023';
      end if;
      v_poi_id := v_id_text::uuid;
      select count(*) into v_found
      from public.production_order_items poi
      join public.production_orders po on po.id = poi.production_order_id
      where poi.id = v_poi_id
        and poi.sku_id = v_sku_id
        and po.location_code = 'q7';
      if v_found = 0 then
        raise exception 'production_order_item_invalid: Dòng lệnh sản xuất không thuộc Q7 hoặc không đúng SKU.' using errcode = '22023';
      end if;
    end if;
  end loop;

  -- Receipt date: Vietnam today by default, never in the future.
  v_date := coalesce(p_date, v_today);
  if v_date > v_today then
    raise exception 'date_invalid: Ngày nhập không được ở tương lai.' using errcode = '22023';
  end if;

  -- Lock every SKU once, in sorted order, so concurrent slips cannot deadlock
  -- and an issue for the same SKU sees the receipt.
  for v_lock_sku in
    select distinct id from unnest(v_sku_ids) as id order by id
  loop
    perform pg_advisory_xact_lock(hashtext('q7_fg:' || v_lock_sku::text));
  end loop;

  v_slip_number := 'NTP-'
    || to_char(v_date, 'YYYYMMDD')
    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  for v_ele in
    select value as raw, ordinality as ord
    from jsonb_array_elements(p_lines) with ordinality
    order by ord
  loop
    v_sku_id := (v_ele.raw ->> 'sku_id')::uuid;
    v_qty := (v_ele.raw ->> 'quantity')::numeric;
    v_poi_id := nullif(btrim(coalesce(v_ele.raw ->> 'production_order_item_id', '')), '')::uuid;

    select * into v_sku
    from public.product_skus
    where id = v_sku_id;

    insert into public.q7_finished_goods_movements(
      sku_id, sku_code_snapshot, movement_type, quantity, movement_date,
      slip_id, slip_number, production_order_item_id, request_id, note, created_by
    ) values (
      v_sku_id, v_sku.sku_code, 'production_receipt', v_qty, v_date,
      v_slip_id, v_slip_number, v_poi_id, v_request, v_note, v_actor
    );

    select coalesce(sum(m.quantity), 0) into v_on_hand
    from public.q7_finished_goods_movements m
    where m.sku_id = v_sku_id;

    v_lines := v_lines || jsonb_build_object(
      'sku_id', v_sku_id,
      'quantity', v_qty,
      'on_hand_after', v_on_hand
    );
  end loop;

  v_result := jsonb_build_object(
    'slip_id', v_slip_id,
    'slip_number', v_slip_number,
    'lines', v_lines
  );

  insert into public.q7_finished_goods_requests(
    request_id, kind, slip_id, slip_number, result, created_by
  ) values (
    v_request, 'production_receipt', v_slip_id, v_slip_number, v_result, v_actor
  )
  on conflict (request_id) do nothing;

  return v_result;
end;
$$;

revoke all on function public.create_q7_finished_goods_receipt(jsonb, text, uuid, date) from public, anon;
grant execute on function public.create_q7_finished_goods_receipt(jsonb, text, uuid, date) to authenticated, service_role;

-- ===========================================================================
-- 4. create_q7_finished_goods_issue — dispatch / write-off, never below zero
-- ===========================================================================

create or replace function public.create_q7_finished_goods_issue(
  p_lines jsonb,
  p_reason text,
  p_note text,
  p_request_id uuid,
  p_date date default (now() at time zone 'Asia/Ho_Chi_Minh')::date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request uuid := p_request_id;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_date date;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_line_count integer;
  v_sku_ids uuid[] := '{}';
  v_ele record;
  v_id_text text;
  v_sku_id uuid;
  v_qty numeric;
  v_sku public.product_skus%rowtype;
  v_slip_id uuid := gen_random_uuid();
  v_slip_number text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_lines jsonb := '[]'::jsonb;
  v_on_hand numeric;
  v_requested numeric;
  v_lock_sku uuid;
  v_result jsonb;
begin
  if not v_is_service then
    if v_actor is null then
      raise exception 'finished_goods_forbidden: Cần đăng nhập để nhập/xuất thành phẩm Q7.' using errcode = '42501';
    end if;
    if not (
      public.can_manage_tan_tao_warehouse()
      or public.has_role(v_actor, 'owner')
      or public.material_alias_can_admin(v_actor)
    ) then
      raise exception 'finished_goods_forbidden: Tài khoản chưa có quyền nhập/xuất thành phẩm Q7.' using errcode = '42501';
    end if;
  end if;

  if v_request is null then
    raise exception 'request_id_required: Thiếu mã yêu cầu.' using errcode = '22023';
  end if;

  if v_reason is null or v_reason not in ('dispatch', 'write_off') then
    raise exception 'reason_invalid: Lý do xuất phải là xuất kho hoặc xuất hủy.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('q7_finished_goods_request:' || v_request::text, 0)
  );
  select r.result into v_existing
  from public.q7_finished_goods_requests r
  where r.request_id = v_request;
  if found then
    return v_existing;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines_required: Phiếu xuất phải có ít nhất 1 dòng.' using errcode = '22023';
  end if;
  v_line_count := jsonb_array_length(p_lines);
  if v_line_count = 0 then
    raise exception 'lines_required: Phiếu xuất phải có ít nhất 1 dòng.' using errcode = '22023';
  end if;
  if v_line_count > 30 then
    raise exception 'too_many_lines: Phiếu xuất chỉ được tối đa 30 dòng.' using errcode = '22023';
  end if;

  for v_ele in
    select value as raw, ordinality as ord
    from jsonb_array_elements(p_lines) with ordinality
  loop
    if jsonb_typeof(v_ele.raw) <> 'object' then
      raise exception 'line_invalid: Dòng thành phẩm không hợp lệ.' using errcode = '22023';
    end if;

    v_id_text := nullif(btrim(v_ele.raw ->> 'sku_id'), '');
    if v_id_text is null
       or v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'sku_invalid: Mã SKU không hợp lệ.' using errcode = '22023';
    end if;
    v_sku_id := v_id_text::uuid;

    if not exists (select 1 from public.product_skus ps where ps.id = v_sku_id) then
      raise exception 'sku_invalid: SKU không tồn tại.' using errcode = '22023';
    end if;
    v_sku_ids := v_sku_ids || v_sku_id;

    if jsonb_typeof(v_ele.raw -> 'quantity') is distinct from 'number' then
      raise exception 'quantity_invalid: Số lượng xuất phải là số lớn hơn 0.' using errcode = '22023';
    end if;
    v_qty := (v_ele.raw ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0
       or v_qty::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'quantity_invalid: Số lượng xuất phải là số lớn hơn 0.' using errcode = '22023';
    end if;
  end loop;

  v_date := coalesce(p_date, v_today);
  if v_date > v_today then
    raise exception 'date_invalid: Ngày xuất không được ở tương lai.' using errcode = '22023';
  end if;

  -- Lock each SKU once in sorted order, then reject any SKU whose requested
  -- total exceeds its current ledger on-hand.
  for v_lock_sku in
    select distinct id from unnest(v_sku_ids) as id order by id
  loop
    perform pg_advisory_xact_lock(hashtext('q7_fg:' || v_lock_sku::text));

    select coalesce(sum(m.quantity), 0) into v_on_hand
    from public.q7_finished_goods_movements m
    where m.sku_id = v_lock_sku;

    select coalesce(sum((raw ->> 'quantity')::numeric), 0) into v_requested
    from jsonb_array_elements(p_lines) as raw
    where (raw ->> 'sku_id')::uuid = v_lock_sku;

    if v_requested > v_on_hand then
      select * into v_sku from public.product_skus where id = v_lock_sku;
      raise exception 'finished_goods_insufficient: % chỉ còn % %',
        v_sku.sku_code, v_on_hand, v_sku.unit
        using errcode = '22023',
              detail = jsonb_build_object(
                'sku_id', v_lock_sku,
                'sku_code', v_sku.sku_code,
                'on_hand', v_on_hand,
                'requested', v_requested,
                'unit', v_sku.unit
              )::text;
    end if;
  end loop;

  v_slip_number := 'XTP-'
    || to_char(v_date, 'YYYYMMDD')
    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  for v_ele in
    select value as raw, ordinality as ord
    from jsonb_array_elements(p_lines) with ordinality
    order by ord
  loop
    v_sku_id := (v_ele.raw ->> 'sku_id')::uuid;
    v_qty := (v_ele.raw ->> 'quantity')::numeric;

    select * into v_sku
    from public.product_skus
    where id = v_sku_id;

    insert into public.q7_finished_goods_movements(
      sku_id, sku_code_snapshot, movement_type, quantity, movement_date,
      slip_id, slip_number, production_order_item_id, request_id, note, created_by
    ) values (
      v_sku_id, v_sku.sku_code, v_reason, -v_qty, v_date,
      v_slip_id, v_slip_number, null, v_request, v_note, v_actor
    );

    select coalesce(sum(m.quantity), 0) into v_on_hand
    from public.q7_finished_goods_movements m
    where m.sku_id = v_sku_id;

    v_lines := v_lines || jsonb_build_object(
      'sku_id', v_sku_id,
      'quantity', v_qty,
      'on_hand_after', v_on_hand
    );
  end loop;

  v_result := jsonb_build_object(
    'slip_id', v_slip_id,
    'slip_number', v_slip_number,
    'lines', v_lines
  );

  insert into public.q7_finished_goods_requests(
    request_id, kind, slip_id, slip_number, result, created_by
  ) values (
    v_request, 'issue', v_slip_id, v_slip_number, v_result, v_actor
  )
  on conflict (request_id) do nothing;

  return v_result;
end;
$$;

revoke all on function public.create_q7_finished_goods_issue(jsonb, text, text, uuid, date) from public, anon;
grant execute on function public.create_q7_finished_goods_issue(jsonb, text, text, uuid, date) to authenticated, service_role;

-- ===========================================================================
-- 5. get_q7_finished_goods_planned — the day's Q7 plan lines + received qty
-- ===========================================================================

create or replace function public.get_q7_finished_goods_planned(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb := '[]'::jsonb;
begin
  -- Same reader gate as get_warehouse_game_snapshot('q7').
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'production_order_item_id', x.production_order_item_id,
           'sku_id', x.sku_id,
           'sku_code', x.sku_code,
           'product_name', x.product_name,
           'unit', x.unit,
           'planned_qty', x.planned_qty,
           'already_received', x.already_received
         ) order by x.sku_code, x.production_order_item_id), '[]'::jsonb)
  into v_result
  from (
    select poi.id as production_order_item_id,
           poi.sku_id,
           ps.sku_code,
           coalesce(nullif(poi.product_name, ''), ps.product_name) as product_name,
           poi.unit,
           poi.planned_qty,
           coalesce((
             select sum(m.quantity)
             from public.q7_finished_goods_movements m
             where m.production_order_item_id = poi.id
               and m.movement_type = 'production_receipt'
           ), 0) as already_received
    from public.production_order_items poi
    join public.production_orders po on po.id = poi.production_order_id
    join public.product_skus ps on ps.id = poi.sku_id
    where po.location_code = 'q7'
      and po.planned_start_date = p_date
      and po.status::text <> 'cancelled'
      and poi.sku_id is not null
  ) x;

  return v_result;
end;
$$;

revoke all on function public.get_q7_finished_goods_planned(date) from public, anon;
grant execute on function public.get_q7_finished_goods_planned(date) to authenticated, service_role;

-- ===========================================================================
-- 6. get_warehouse_game_snapshot: Q7 finished-goods SKUs for the shelf
-- ===========================================================================

create or replace function public.get_warehouse_game_snapshot(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_cutover date;
  v_items jsonb := '[]'::jsonb;
  v_skus jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_transfers jsonb := '[]'::jsonb;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;

  -- Same reader gate as public.get_stock_ledger_overview(p_location).
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

  -- The shared catalog: every live item, for both warehouses.
  if p_location = 'q7' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id,
             'code', x.item_code,
             'name', x.name,
             'unit', x.unit,
             'item_class', x.item_class,
             'on_hand', x.on_hand,
             'last_count_date', x.last_count_date,
             'aliases', x.aliases,
             'pastry_q7', x.pastry_q7
           ) order by x.name), '[]'::jsonb)
    into v_items
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
             coalesce(kii.item_class, 'unclassified') as item_class,
             kii.pastry_q7,
             (
               coalesce(o.opening_qty, 0)
               + coalesce(mt.receipt_qty, 0)
               - coalesce(mt.usage_qty, 0)
               + coalesce(mt.adjustment_qty, 0)
             ) as on_hand,
             (
               select max(m.movement_date)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'q7-stock-count:%'
                 and m.movement_date <= v_as_of
             ) as last_count_date,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'normalized_name', a.normalized_name,
                        'status', a.status,
                        'line_class', a.line_class,
                        'supplier_name', sup.name
                      ) order by a.normalized_name)
               from public.stock_material_aliases a
               left join public.suppliers sup on sup.id = a.supplier_id
               where a.kitchen_inventory_item_id = kii.id
                 and a.location = p_location
             ), '[]'::jsonb) as aliases
      from public.kitchen_inventory_items kii
      left join lateral (
        select o2.opening_qty, o2.effective_date
        from public.q7_inventory_openings o2
        where o2.kitchen_inventory_item_id = kii.id
          and o2.effective_date <= v_as_of
        order by o2.effective_date desc, o2.updated_at desc, o2.id desc
        limit 1
      ) o on true
      left join lateral (
        select coalesce(sum(m.quantity) filter (where m.movement_type in ('receipt', 'transfer_in')), 0) as receipt_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0) as usage_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0) as adjustment_qty
        from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = kii.id
          and m.movement_date <= v_as_of
          and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
      ) mt on true
      where kii.active = true
        and kii.merged_into_id is null
        and (kii.pastry_q7 = true or exists (select 1 from public.q7_inventory_movements qm where qm.kitchen_inventory_item_id = kii.id))
    ) x;

    -- Finished-goods SKUs at Q7: a ledger row already exists, or the SKU sits on
    -- a Q7 production order line planned within the last 30 days. on_hand is the
    -- sum of the SKU's finished-goods ledger rows.
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', ps.id,
             'sku_code', ps.sku_code,
             'product_name', ps.product_name,
             'unit', ps.unit,
             'on_hand', coalesce((
               select sum(m.quantity)
               from public.q7_finished_goods_movements m
               where m.sku_id = ps.id
             ), 0)
           ) order by ps.sku_code), '[]'::jsonb)
    into v_skus
    from public.product_skus ps
    where exists (
        select 1
        from public.q7_finished_goods_movements m
        where m.sku_id = ps.id
      )
      or exists (
        select 1
        from public.production_order_items poi
        join public.production_orders po on po.id = poi.production_order_id
        where poi.sku_id = ps.id
          and po.location_code = 'q7'
          and po.status::text <> 'cancelled'
          and coalesce(po.planned_start_date, po.planned_end_date)
              between v_as_of - 30 and v_as_of
      );
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id,
             'code', x.item_code,
             'name', x.name,
             'unit', x.unit,
             'item_class', x.item_class,
             'on_hand', x.on_hand,
             'last_count_date', x.last_count_date,
             'aliases', x.aliases,
             'pastry_q7', x.pastry_q7
           ) order by x.name), '[]'::jsonb)
    into v_items
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
             coalesce(kii.item_class, 'unclassified') as item_class,
             kii.pastry_q7,
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
             ), 0) as on_hand,
             (
               select max(m.movement_date)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'tt-material-count:%'
                 and m.movement_date <= v_as_of
             ) as last_count_date,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'normalized_name', a.normalized_name,
                        'status', a.status,
                        'line_class', a.line_class,
                        'supplier_name', sup.name
                      ) order by a.normalized_name)
               from public.stock_material_aliases a
               left join public.suppliers sup on sup.id = a.supplier_id
               where a.kitchen_inventory_item_id = kii.id
                 and a.location = p_location
             ), '[]'::jsonb) as aliases
      from public.kitchen_inventory_items kii
      where kii.active = true
        and kii.merged_into_id is null
    ) x;

    -- Finished-goods SKUs at Tân Tạo (the Q7 branch above builds its own list).
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', ps.id,
             'sku_code', ps.sku_code,
             'product_name', ps.product_name,
             'unit', ps.unit,
             'on_hand', coalesce((
               select sum(m.quantity)
               from public.tan_tao_warehouse_movements m
               where m.sku_id = ps.id
                 and m.location_code = 'warehouse_tan_tao'
             ), 0)
           ) order by ps.sku_code), '[]'::jsonb)
    into v_skus
    from public.product_skus ps
    where ps.sku_type::text = 'finished_good';
  end if;

  -- The backlog review is owner / Q7-admin only. A plain warehouse viewer still
  -- gets the whole snapshot, just with an empty pending list.
  begin
    select coalesce(jsonb_agg(to_jsonb(p) order by p.line_count desc, p.normalized_name, p.supplier_id), '[]'::jsonb)
    into v_pending
    from public.get_material_alias_backlog_review(p_location, 200) p;
  exception when insufficient_privilege then
    v_pending := '[]'::jsonb;
  end;

  select coalesce(jsonb_object_agg(g.cls, g.n), '{}'::jsonb)
  into v_counts
  from (
    select coalesce(kii.item_class, 'unclassified') as cls, count(*)::numeric as n
    from public.kitchen_inventory_items kii
    where kii.active = true
      and kii.merged_into_id is null
    group by 1
  ) g;

  select coalesce(jsonb_agg(jsonb_build_object(
           'transfer_number', t.transfer_number,
           'transfer_date', t.transfer_date,
           'item_id', t.kitchen_inventory_item_id,
           'item_name', kii.name,
           'quantity', t.quantity,
           'unit', t.unit,
           'receipt_number', gr.receipt_number
         ) order by t.created_at desc, t.id desc), '[]'::jsonb)
  into v_transfers
  from (
    select st.*
    from public.stock_transfers st
    order by st.created_at desc, st.id desc
    limit 20
  ) t
  join public.kitchen_inventory_items kii on kii.id = t.kitchen_inventory_item_id
  left join public.goods_receipt_items gri on gri.id = t.goods_receipt_item_id
  left join public.goods_receipts gr on gr.id = gri.goods_receipt_id;

  return jsonb_build_object(
    'location', p_location,
    'cutover_date', v_cutover,
    'items', v_items,
    'skus', v_skus,
    'pending', v_pending,
    'counts', v_counts,
    'transfers', v_transfers,
    'can_edit', public.q7_material_inventory_can_edit(v_actor)
  );
end;
$$;

revoke all on function public.get_warehouse_game_snapshot(text) from public, anon;
grant execute on function public.get_warehouse_game_snapshot(text) to authenticated, service_role;
