-- 2026-10-31 — Phiếu chuyển kho thủ công Tân Tạo → Q7 (phần dữ liệu).
--
-- Owner operating model 2026-10-12 / task 2026-10-31:
--   * The automatic pastry transfer stays exactly as it is: posting a Tân Tạo
--     receipt line for a pastry_q7 item writes one stock transfer + a Tân Tạo
--     transfer_out + a Q7 transfer_in. The Q7 ledger still refuses stock
--     increases for items without the flag.
--   * Operators can now create a manual transfer slip of 1..30 item lines. One
--     call writes one stock_transfers row per line (source 'manual', a shared
--     slip_id / CKP-YYYYMMDD-XXXXXX slip_number), a Tân Tạo transfer_out and a
--     Q7 transfer_in per line, atomically. Every active, unmerged kitchen item
--     is allowed (no pastry_q7 flag required): only receipt-driven Q7 increases
--     stay pastry-only. The call is idempotent per p_request_id.
--
-- stock_transfers / both ledgers stay append-only. This migration never UPDATEs
-- or DELETEs a posted stock_transfers, q7_inventory_movements or
-- tan_tao_material_movements row; the only document write is the manual transfer
-- pair itself.
--
-- Readers of stock_transfers and of the two transfer movement types audited for
-- the new 'manual' rows:
--   * public.get_warehouse_game_snapshot(text)  — 'transfers' joins
--     goods_receipt_items / goods_receipts with a LEFT JOIN, so a manual row
--     simply returns receipt_number = null; sign handling already knows
--     transfer_out / transfer_in. Redefined below so the Q7 item set is active,
--     unmerged items with pastry_q7 = true OR at least one
--     q7_inventory_movements row; every other part of the function is unchanged.
--   * public.start_stock_count(text, text)      — redefined below with the same
--     Q7 item set, so a manually moved non-pastry item becomes a count line;
--     every other part of the function is unchanged.
--   * public.get_stock_transfers(integer)       — redefined below to append
--     source / slip_id / slip_number / note (existing columns and order kept).
--   * public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases)
--     — untouched auto branch; still writes source 'auto_goods_receipt' with a
--     goods_receipt_item_id.
--   * public.q7_inventory_movements_pastry_only_guard() — redefined below so a
--     transfer_in that references a manual stock_transfers row is allowed for
--     any item; receipt / opening / auto transfer_in keep requiring pastry_q7.
--   * Ledger balance readers that already classify transfer_out / transfer_in
--     (from 20261026100000 / 20261030100000) and therefore count a manual pair:
--     get_q7_inventory_snapshot, get_stock_ledger_overview,
--     record_tan_tao_material_count, apply_stock_item_merge,
--     revert_stock_item_merge, stock_item_merge_forward,
--     tan_tao_material_merge_forward, mission_evaluate.
--   * Existence / history readers never classify by movement_type:
--     stock_goods_receipt_item_is_posted, stock_unit_item_has_history.
--
-- The Maestro applies this migration; it is not applied by this change.

-- ===========================================================================
-- 1. stock_transfers: slip columns, source check, index
-- ===========================================================================

alter table public.stock_transfers
  add column if not exists slip_id uuid,
  add column if not exists slip_number text,
  add column if not exists request_id uuid;

-- No source check existed before (only the default); make the two allowed
-- writers explicit and keep the table append-only. Existing rows are always
-- 'auto_goods_receipt'.
alter table public.stock_transfers
  drop constraint if exists stock_transfers_source_check;
alter table public.stock_transfers
  add constraint stock_transfers_source_check
  check (source in ('auto_goods_receipt', 'manual'));

alter table public.stock_transfers
  drop constraint if exists stock_transfers_slip_number_check;
alter table public.stock_transfers
  add constraint stock_transfers_slip_number_check
  check (slip_number is null or slip_number ~ '^CKP-[0-9]{8}-[A-Z0-9]{6}$');

-- goods_receipt_item_id stays unique (manual rows leave it null; Postgres allows
-- many nulls under a unique constraint), so the auto replay guard is unchanged.
create index if not exists idx_stock_transfers_slip_id
  on public.stock_transfers(slip_id);

-- ===========================================================================
-- 2. stock_transfer_requests — server-only idempotency ledger
-- ===========================================================================

create table if not exists public.stock_transfer_requests (
  request_id uuid primary key,
  slip_id uuid not null,
  slip_number text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  result jsonb not null
);

alter table public.stock_transfer_requests enable row level security;

-- No client policy at all: only the security-definer RPC (and service_role)
-- touches this table.
revoke all on table public.stock_transfer_requests from public, anon, authenticated;
grant all on table public.stock_transfer_requests to service_role;

-- ===========================================================================
-- 3. create_manual_stock_transfer — one slip, 1..30 lines, atomic + idempotent
-- ===========================================================================

create or replace function public.create_manual_stock_transfer(
  p_lines jsonb,
  p_note text default null,
  p_request_id uuid default null,
  p_transfer_date date default null
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
  v_transfer_date date;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_cutover_tt date;
  v_cutover_q7 date;
  v_line_count integer;
  v_distinct_count integer;
  v_found integer;
  v_slip_id uuid := gen_random_uuid();
  v_slip_number text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_item_ids uuid[] := '{}';
  v_ele record;
  v_id uuid;
  v_id_text text;
  v_qty numeric;
  v_on_hand numeric;
  v_item public.kitchen_inventory_items%rowtype;
  v_transfer_id uuid;
  v_transfer_number text;
  v_lines jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  -- Actor + permission: service_role bypasses, everyone else needs the Tân Tạo
  -- manage permission, the owner role or the Q7 material admin permission.
  if not v_is_service then
    if v_actor is null then
      raise exception 'transfer_forbidden' using errcode = '42501';
    end if;
    if not (
      public.can_manage_tan_tao_warehouse()
      or public.has_role(v_actor, 'owner')
      or public.material_alias_can_admin(v_actor)
    ) then
      raise exception 'transfer_forbidden' using errcode = '42501';
    end if;
  end if;

  if v_request is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  -- Idempotency: the same request returns the stored result unchanged. The
  -- advisory lock serialises concurrent retries of the same request.
  perform pg_advisory_xact_lock(
    hashtextextended('manual_stock_transfer_request:' || v_request::text, 0)
  );
  select r.result into v_existing
  from public.stock_transfer_requests r
  where r.request_id = v_request;
  if found then
    return v_existing;
  end if;

  -- 1..30 lines.
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines_required' using errcode = '22023';
  end if;
  v_line_count := jsonb_array_length(p_lines);
  if v_line_count = 0 then
    raise exception 'lines_required' using errcode = '22023';
  end if;
  if v_line_count > 30 then
    raise exception 'too_many_lines' using errcode = '22023';
  end if;

  -- Item ids first: malformed id is item_invalid, duplicates are duplicate_item.
  for v_ele in
    select value as raw, ordinality as ord
    from jsonb_array_elements(p_lines) with ordinality
  loop
    if jsonb_typeof(v_ele.raw) <> 'object' then
      raise exception 'item_invalid' using errcode = '22023';
    end if;
    v_id_text := nullif(btrim(v_ele.raw ->> 'item_id'), '');
    if v_id_text is null
       or v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'item_invalid' using errcode = '22023';
    end if;
    v_item_ids := v_item_ids || v_id_text::uuid;
  end loop;

  select count(distinct id) into v_distinct_count
  from unnest(v_item_ids) as id;
  if v_distinct_count <> array_length(v_item_ids, 1) then
    raise exception 'duplicate_item' using errcode = '22023';
  end if;

  -- Quantities: a JSON number, finite and strictly positive.
  for v_ele in
    select value as raw
    from jsonb_array_elements(p_lines) with ordinality
  loop
    if jsonb_typeof(v_ele.raw -> 'quantity') is distinct from 'number' then
      raise exception 'quantity_invalid' using errcode = '22023';
    end if;
    v_qty := (v_ele.raw ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0
       or v_qty::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'quantity_invalid' using errcode = '22023';
    end if;
  end loop;

  -- Every item must be a live, unmerged kitchen item.
  select count(*) into v_found
  from public.kitchen_inventory_items k
  where k.id = any (v_item_ids)
    and k.active = true
    and k.merged_into_id is null;
  if v_found <> array_length(v_item_ids, 1) then
    raise exception 'item_invalid' using errcode = '22023';
  end if;

  -- Transfer date: Vietnam today by default, never in the future.
  v_transfer_date := coalesce(p_transfer_date, v_today);
  if v_transfer_date > v_today then
    raise exception 'date_invalid' using errcode = '22023';
  end if;

  -- Both ledgers must have started and cover the transfer date.
  v_cutover_tt := public.stock_ledger_cutover_date('tan_tao');
  v_cutover_q7 := public.stock_ledger_cutover_date('q7');
  if v_cutover_tt is null or v_cutover_q7 is null
     or v_transfer_date < v_cutover_tt
     or v_transfer_date < v_cutover_q7 then
    raise exception 'ledger_not_started' using errcode = '22023';
  end if;

  -- Lock every item once, in sorted order, so concurrent slips cannot deadlock
  -- and a concurrent receipt / count for the same item sees the check below.
  for v_id in
    select distinct id from unnest(v_item_ids) as id order by id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('manual_stock_transfer_item:' || v_id::text, 0)
    );
  end loop;

  v_slip_number := 'CKP-'
    || to_char(v_transfer_date, 'YYYYMMDD')
    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  for v_ele in
    select value as raw, ordinality as ord
    from jsonb_array_elements(p_lines) with ordinality
    order by ord
  loop
    v_id := (v_ele.raw ->> 'item_id')::uuid;
    v_qty := (v_ele.raw ->> 'quantity')::numeric;

    select * into v_item
    from public.kitchen_inventory_items
    where id = v_id;

    -- Tân Tạo on-hand exactly as the existing readers sum it: receipt / opening
    -- positive, production_usage / transfer_out negative, adjustment signed.
    select coalesce(sum(case m.movement_type
                          when 'receipt' then m.quantity
                          when 'opening' then m.quantity
                          when 'production_usage' then -m.quantity
                          when 'adjustment' then m.quantity
                          when 'transfer_out' then -m.quantity
                          else 0 end), 0)
      into v_on_hand
    from public.tan_tao_material_movements m
    where m.kitchen_inventory_item_id = v_id
      and m.movement_date <= v_transfer_date;

    if v_qty > v_on_hand then
      raise exception 'stock_insufficient: % chỉ còn % %',
        v_item.name, v_on_hand, v_item.unit
        using errcode = '22023',
              detail = jsonb_build_object(
                'item_id', v_id,
                'item_name', v_item.name,
                'on_hand', v_on_hand,
                'requested', v_qty,
                'unit', v_item.unit
              )::text;
    end if;

    v_transfer_number := 'CK-'
      || to_char(v_transfer_date, 'YYYYMMDD')
      || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

    insert into public.stock_transfers(
      transfer_number, from_location, to_location, kitchen_inventory_item_id,
      quantity, unit, transfer_date, source, goods_receipt_item_id,
      slip_id, slip_number, request_id, note, created_by
    ) values (
      v_transfer_number, 'tan_tao', 'q7', v_id,
      v_qty, v_item.unit, v_transfer_date, 'manual', null,
      v_slip_id, v_slip_number, v_request, v_note, v_actor
    )
    returning id into v_transfer_id;

    insert into public.tan_tao_material_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      v_id, v_transfer_date, 'transfer_out', v_qty, v_item.unit,
      'stock_transfer', 'transfer:' || v_transfer_id::text,
      coalesce(v_note, 'Chuyển kho thủ công Tân Tạo → Q7 (' || v_slip_number || ')'),
      v_actor
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      v_id, v_transfer_date, 'transfer_in', v_qty, v_item.unit,
      'stock_transfer', 'transfer:' || v_transfer_id::text,
      coalesce(v_note, 'Nhận kho thủ công từ Tân Tạo (' || v_slip_number || ')'),
      v_actor
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

    v_lines := v_lines || jsonb_build_object(
      'transfer_id', v_transfer_id,
      'transfer_number', v_transfer_number,
      'item_id', v_id,
      'item_name', v_item.name,
      'quantity', v_qty,
      'unit', v_item.unit
    );
  end loop;

  v_result := jsonb_build_object(
    'slip_id', v_slip_id,
    'slip_number', v_slip_number,
    'transfer_date', v_transfer_date,
    'lines', v_lines
  );

  insert into public.stock_transfer_requests(
    request_id, slip_id, slip_number, created_by, result
  ) values (
    v_request, v_slip_id, v_slip_number, v_actor, v_result
  )
  on conflict (request_id) do nothing;

  return v_result;
end;
$$;

-- ===========================================================================
-- 4. Q7 pastry-only guard: manual transfer_in is allowed for any item
-- ===========================================================================

create or replace function public.q7_inventory_movements_pastry_only_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pastry boolean;
  v_is_manual_transfer boolean := false;
begin
  if new.movement_type in ('receipt', 'transfer_in', 'opening') then
    -- Only a transfer_in that references a stock_transfers row with
    -- source = 'manual' is exempt; every other increase still needs pastry_q7.
    if new.movement_type = 'transfer_in' then
      select exists (
        select 1
        from public.stock_transfers st
        where st.source = 'manual'
          and new.source = 'stock_transfer'
          and new.source_ref_key = 'transfer:' || st.id::text
      ) into v_is_manual_transfer;
    end if;

    if v_is_manual_transfer then
      return new;
    end if;

    select k.pastry_q7 into v_pastry
    from public.kitchen_inventory_items k
    where k.id = new.kitchen_inventory_item_id;
    if coalesce(v_pastry, false) is not true then
      raise exception 'q7_pastry_only' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists q7_inventory_movements_pastry_only_guard on public.q7_inventory_movements;
create trigger q7_inventory_movements_pastry_only_guard
  before insert on public.q7_inventory_movements
  for each row execute function public.q7_inventory_movements_pastry_only_guard();

-- ===========================================================================
-- 5. get_stock_transfers: append source / slip_id / slip_number / note
-- ===========================================================================

create or replace function public.get_stock_transfers(p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 200));
  v_result jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not (public.q7_material_inventory_can_view(v_actor) or public.can_view_tan_tao_warehouse()) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'transfer_number', x.transfer_number,
           'transfer_date', x.transfer_date,
           'item_id', x.kitchen_inventory_item_id,
           'item_name', x.item_name,
           'quantity', x.quantity,
           'unit', x.unit,
           'receipt_number', x.receipt_number,
           'source', x.source,
           'slip_id', x.slip_id,
           'slip_number', x.slip_number,
           'note', x.note
         ) order by x.created_at desc, x.id desc), '[]'::jsonb)
  into v_result
  from (
    select t.*, kii.name as item_name, gr.receipt_number
    from public.stock_transfers t
    join public.kitchen_inventory_items kii on kii.id = t.kitchen_inventory_item_id
    left join public.goods_receipt_items gri on gri.id = t.goods_receipt_item_id
    left join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    order by t.created_at desc, t.id desc
    limit v_limit
  ) x;

  return v_result;
end;
$$;

-- ===========================================================================
-- 6. Grants (same shape as the existing warehouse functions)
-- ===========================================================================

revoke all on function public.create_manual_stock_transfer(jsonb, text, uuid, date) from public, anon;
grant execute on function public.create_manual_stock_transfer(jsonb, text, uuid, date) to authenticated, service_role;

revoke all on function public.q7_inventory_movements_pastry_only_guard() from public, anon, authenticated;

revoke all on function public.get_stock_transfers(integer) from public, anon;
grant execute on function public.get_stock_transfers(integer) to authenticated, service_role;

-- ===========================================================================
-- 7. get_warehouse_game_snapshot: the Q7 item set includes manually moved items
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

    -- Finished-goods SKUs only exist at Tân Tạo.
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

-- ===========================================================================
-- 8. start_stock_count: the Q7 count sheet uses the same item set
-- ===========================================================================

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

  -- An open session already exists: reuse it instead of creating a second one.
  select * into v_session
  from public.stock_count_sessions
  where location = p_location and status = 'open'
  order by opened_at asc, id asc
  limit 1;
  if found then
    return public.stock_count_session_json(v_session, true);
  end if;

  insert into public.stock_count_sessions(
    location, count_date, status, opened_by, opened_at, idempotency_key
  ) values (
    p_location, v_today, 'open', v_actor, now(), v_key
  )
  returning * into v_session;

  if p_location = 'q7' then
    -- Same live-item source and on_hand formula as get_warehouse_game_snapshot('q7'):
    -- the Q7 ledger only ever receives pastry items, so the count mirrors that set.
    -- item_class = 'non_stock' is not a stock-tracked item and is left out.
    insert into public.stock_count_lines(
      session_id, target_kind, target_id, target_code, target_name, unit, book_qty
    )
    select v_session.id, 'item', x.id, x.item_code, x.name, x.unit, x.on_hand
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
          and o2.effective_date <= v_today
        order by o2.effective_date desc, o2.updated_at desc, o2.id desc
        limit 1
      ) o on true
      left join lateral (
        select coalesce(sum(m.quantity) filter (where m.movement_type in ('receipt', 'transfer_in')), 0) as receipt_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0) as usage_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0) as adjustment_qty
        from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = kii.id
          and m.movement_date <= v_today
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
    insert into public.stock_count_lines(
      session_id, target_kind, target_id, target_code, target_name, unit, book_qty
    )
    select v_session.id, 'item', x.id, x.item_code, x.name, x.unit, x.on_hand
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
                 and m.movement_date <= v_today
             ), 0) as on_hand
      from public.kitchen_inventory_items kii
      where kii.active = true
        and kii.merged_into_id is null
        and coalesce(kii.item_class, 'unclassified') <> 'non_stock'
    ) x;

    -- Finished-goods SKUs from the get_tan_tao_warehouse_snapshot source: the four
    -- quantity-tracked SKUs of the Tân Tạo warehouse, with the same on_hand total.
    insert into public.stock_count_lines(
      session_id, target_kind, target_id, target_code, target_name, unit, book_qty
    )
    select v_session.id, 'sku', ps.id, ps.sku_code, ps.product_name, ps.unit,
           coalesce((
             select sum(m.quantity)
             from public.tan_tao_warehouse_movements m
             where m.sku_id = ps.id
               and m.location_code = 'warehouse_tan_tao'
           ), 0)
    from public.product_skus ps
    where upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');
  end if;

  return public.stock_count_session_json(v_session, true);
end;
$$;

revoke all on function public.start_stock_count(text, text) from public, anon;
grant execute on function public.start_stock_count(text, text) to authenticated, service_role;
