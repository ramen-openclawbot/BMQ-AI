-- 2026-10-22 — Một món kho có thể thuộc cả Kho Tân Tạo và Kho Q7.
--
-- kitchen_inventory_items.in_tan_tao means "has a place at Kho Tân Tạo";
-- pastry_q7 keeps its existing meaning "has a place at Kho Q7".  At least one
-- of the two flags must be true.  A two-kho item therefore has both true and is
-- visible, countable, receivable, learnable and COGS-mappable at both kho.
--
-- This migration writes no stock movement.  It only adds/backfills the flag,
-- installs a BEFORE INSERT default, and replaces the functions below.
--
-- Functions changed and why:
--   * public.set_item_kho_locations(uuid, boolean, boolean, uuid) — NEW owner /
--     kho-admin RPC that sets both places, with the same gate, request replay
--     table and audit row as set_item_pastry_q7.
--   * public.set_item_pastry_q7(uuid, boolean, uuid) — old single-kho callers
--     keep their meaning: in_tan_tao = not p_value.
--   * public.kho_get_items() — returns in_tan_tao next to in_q7; qty unchanged.
--   * public.kho_count_item(text, uuid, numeric, uuid) — refuses a Tân Tạo count
--     when the item does not have a place there (same item_not_in_location).
--   * public.learn_tan_tao_purchase_parameters() — learns items with
--     in_tan_tao, not every item that is not Q7.
--   * public.get_stock_ledger_overview(text, date) — pass_through is true only
--     for a Q7-only item (pastry_q7 and not in_tan_tao).
--   * public.post_stock_goods_receipt_item(uuid, stock_material_aliases) — a
--     Tân Tạo receipt line is auto-transferred to Q7 only for a Q7-only item.
--   * public.cogs_refresh_mappings() — the kho_canonical branch picks tan_tao
--     when in_tan_tao is true, otherwise q7.  Q7 PXK / BOM branches unchanged.
--   * public.cogs_decide_ingredient(...) — accepts q7 when pastry_q7 is true or
--     tan_tao when in_tan_tao is true (both accepted for a two-kho item).
--   * public.stock_count_eligible_lines(text, date) — Tân Tạo sheet follows
--     in_tan_tao instead of "pastry_q7 and zero on hand".
--   * public.material_link_counts_internal(text),
--     public.material_link_review_items_internal(text),
--     public.get_material_link_pending_factors(text) — Tân Tạo membership uses
--     in_tan_tao; Q7 membership still uses pastry_q7 / Q7 movements.
--
-- Inspected and deliberately unchanged (no Tân Tạo decision made from
-- "not pastry_q7"): get_office_order_snapshot (Tân Tạo lists all active items),
-- material_link_item_location (single-link Q7 preference), get_discontinued_
-- stock_items (Q7/in_q7 facts only), get_warehouse_game_snapshot (Tân Tạo lists
-- all active items; Q7 stays pastry/movement), material_alias_catalog_options
-- (Tân Tạo lists all active items), kho_get_item_conversions (in_q7 only).
--
-- Backfill first sets in_tan_tao = not pastry_q7 on every row, then marks the
-- active, unmerged rows with a non-zero balance at BOTH kho as two-kho rows
-- (pastry_q7_source 'rule': system-derived, the column only allows rule|owner).  Balances are the exact expressions behind
-- kho_get_items(): the Tân Tạo ledger sum and get_q7_inventory_snapshot's
-- opening + receipt/transfer_in - usage + adjustment, restricted to approved
-- Q7 material mappings.
--
-- Rollback smoke on live 22/10 (after the Maestro fix: a place at every kho
-- with stock, not only at both): single_tan_tao 104, single_q7 84, both 11
-- (Băng keo lớn/nhỏ, Cồn 70 độ, Đồ rửa chén, Giấm Minh Châu, Hộp H07, Màng bọc
-- thực phẩm, Muối, Muối sấy, Nước rửa chén Gift, Túi rác cuộn), invalid 0.

-- ===========================================================================
-- 1. Column, first backfill, two-kho backfill, trigger, constraint
-- ===========================================================================

alter table public.kitchen_inventory_items
  add column if not exists in_tan_tao boolean;

-- Every existing row keeps its old single-kho place first.
update public.kitchen_inventory_items
set in_tan_tao = not coalesce(pastry_q7, false);

-- Exact current balances behind kho_get_items().  q7_balances is restricted to
-- approved Q7 material mappings, exactly like get_q7_inventory_snapshot().
-- An item gets a place at every kho where it has stock today: a Tân Tạo item
-- with Q7 stock also gets Q7, a Q7 item with Tân Tạo stock also gets Tân Tạo
-- (otherwise it would show on that kho's count list but its count is refused).
create temp table _kho_two_place_balances on commit drop as
with q7_mapped_items as (
  select distinct on (m.kitchen_inventory_item_id)
    m.kitchen_inventory_item_id as item_id
  from public.q7_material_issue_material_mappings m
  join public.kitchen_inventory_items kii
    on kii.id = m.kitchen_inventory_item_id
   and kii.active = true
  where m.approval_status = 'approved'
  order by m.kitchen_inventory_item_id, kii.name
),
q7_latest_opening as (
  select distinct on (o.kitchen_inventory_item_id)
    o.kitchen_inventory_item_id,
    o.effective_date,
    o.opening_qty
  from public.q7_inventory_openings o
  where o.effective_date <= current_date
  order by o.kitchen_inventory_item_id, o.effective_date desc,
           o.updated_at desc, o.id desc
),
q7_movement_totals as (
  select
    m.kitchen_inventory_item_id,
    coalesce(sum(m.quantity) filter (where m.movement_type in ('receipt', 'transfer_in')), 0)::numeric as receipt_qty,
    coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0)::numeric as usage_qty,
    coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0)::numeric as adjustment_qty
  from public.q7_inventory_movements m
  left join q7_latest_opening o
    on o.kitchen_inventory_item_id = m.kitchen_inventory_item_id
  where m.movement_date <= current_date
    and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
  group by m.kitchen_inventory_item_id
),
q7_balances as (
  select
    mi.item_id,
    (coalesce(o.opening_qty, 0)
     + coalesce(mt.receipt_qty, 0)
     - coalesce(mt.usage_qty, 0)
     + coalesce(mt.adjustment_qty, 0))::numeric as balance_qty
  from q7_mapped_items mi
  left join q7_latest_opening o on o.kitchen_inventory_item_id = mi.item_id
  left join q7_movement_totals mt on mt.kitchen_inventory_item_id = mi.item_id
),
tt_balances as (
  select
    kii.id as item_id,
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
        and m.movement_date <= current_date
    ), 0)::numeric as balance_qty
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
)
select tt.item_id, tt.balance_qty as tt_balance, coalesce(q7.balance_qty, 0) as q7_balance
from tt_balances tt
left join q7_balances q7 on q7.item_id = tt.item_id;

update public.kitchen_inventory_items kii
set in_tan_tao = true,
    pastry_q7 = true,
    pastry_q7_source = 'rule',
    pastry_q7_set_at = now(),
    pastry_q7_set_by = null,
    updated_at = now()
from _kho_two_place_balances b
where kii.id = b.item_id
  and kii.active = true
  and kii.merged_into_id is null
  and (
    (coalesce(kii.pastry_q7, false) and b.tt_balance <> 0)        -- Q7 item with Tân Tạo stock
    or (not coalesce(kii.pastry_q7, false) and b.q7_balance <> 0)  -- Tân Tạo item with Q7 stock
  );

-- New rows keep the old single-kho default until an owner sets both places.
create or replace function public.kitchen_inventory_items_fill_in_tan_tao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.in_tan_tao is null then
    new.in_tan_tao := not coalesce(new.pastry_q7, false);
  end if;
  return new;
end;
$$;

drop trigger if exists kitchen_inventory_items_fill_in_tan_tao
  on public.kitchen_inventory_items;
create trigger kitchen_inventory_items_fill_in_tan_tao
  before insert on public.kitchen_inventory_items
  for each row execute function public.kitchen_inventory_items_fill_in_tan_tao();

alter table public.kitchen_inventory_items
  alter column in_tan_tao set default true;
alter table public.kitchen_inventory_items
  alter column in_tan_tao set not null;

alter table public.kitchen_inventory_items
  drop constraint if exists kitchen_inventory_items_in_tan_tao_check;
alter table public.kitchen_inventory_items
  add constraint kitchen_inventory_items_in_tan_tao_check
  check (in_tan_tao or coalesce(pastry_q7, false));

-- ===========================================================================
-- 2. warehouse_game_requests action + new two-place RPC
-- ===========================================================================

alter table public.warehouse_game_requests
  drop constraint if exists warehouse_game_requests_action_check;
alter table public.warehouse_game_requests
  add constraint warehouse_game_requests_action_check
  check (action in (
    'rename', 'change_unit', 'set_item_pastry_q7', 'kho_save_item',
    'set_item_kho_locations'
  ));

create or replace function public.set_item_kho_locations(
  p_item_id uuid,
  p_tan_tao boolean,
  p_q7 boolean,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cached jsonb;
  v_result jsonb;
begin
  -- Same owner / Q7 stock-admin gate as set_item_pastry_q7.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'pastry_forbidden' using errcode = '42501';
    end if;
  end if;
  if p_item_id is null then
    raise exception 'item_required' using errcode = '22023';
  end if;
  if p_tan_tao is null or p_q7 is null then
    raise exception 'value_required' using errcode = '22023';
  end if;
  if not p_tan_tao and not p_q7 then
    raise exception 'kho_location_required' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'set_item_kho_locations';
    if found then
      return v_cached;
    end if;
  end if;

  if not exists (
    select 1 from public.kitchen_inventory_items k
    where k.id = p_item_id and k.active = true and k.merged_into_id is null
  ) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  update public.kitchen_inventory_items
  set pastry_q7 = p_q7,
      in_tan_tao = p_tan_tao,
      pastry_q7_source = 'owner',
      pastry_q7_set_at = now(),
      pastry_q7_set_by = v_actor,
      updated_at = now()
  where id = p_item_id;

  v_result := jsonb_build_object(
    'item_id', p_item_id,
    'in_tan_tao', p_tan_tao,
    'in_q7', p_q7
  );

  if p_request_id is not null then
    insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
    values (p_request_id, 'set_item_kho_locations', p_item_id, v_result, v_actor)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.set_item_kho_locations(uuid, boolean, boolean, uuid)
  from public, anon;
grant execute on function public.set_item_kho_locations(uuid, boolean, boolean, uuid)
  to authenticated;


-- ===========================================================================
-- 3. set_item_pastry_q7 — old single-kho callers also set the TT flag
-- ===========================================================================

create or replace function public.set_item_pastry_q7(
  p_item_id uuid,
  p_value boolean,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cached jsonb;
  v_result jsonb;
begin
  -- Owner or Q7 stock admin only.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'pastry_forbidden' using errcode = '42501';
    end if;
  end if;
  if p_item_id is null then
    raise exception 'item_required' using errcode = '22023';
  end if;
  if p_value is null then
    raise exception 'value_required' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'set_item_pastry_q7';
    if found then
      return v_cached;
    end if;
  end if;

  if not exists (
    select 1 from public.kitchen_inventory_items k
    where k.id = p_item_id and k.active = true and k.merged_into_id is null
  ) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  -- Turning the flag off only affects future transfers, never posted rows.
  update public.kitchen_inventory_items
  set pastry_q7 = p_value,
      in_tan_tao = not p_value,
      pastry_q7_source = 'owner',
      pastry_q7_set_at = now(),
      pastry_q7_set_by = v_actor,
      updated_at = now()
  where id = p_item_id;

  v_result := jsonb_build_object('item_id', p_item_id, 'pastry_q7', p_value);

  if p_request_id is not null then
    insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
    values (p_request_id, 'set_item_pastry_q7', p_item_id, v_result, v_actor)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;


revoke all on function public.set_item_pastry_q7(uuid, boolean, uuid) from public, anon;
grant execute on function public.set_item_pastry_q7(uuid, boolean, uuid) to authenticated, service_role;


-- ===========================================================================
-- 4. kho_get_items — expose in_tan_tao next to in_q7
-- ===========================================================================

create or replace function public.kho_get_items()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_tt jsonb;
  v_q7 jsonb;
  v_items jsonb;
begin
  if v_actor is null then
    raise exception 'actor_required' using errcode = '42501';
  end if;
  if not (
    public.q7_material_inventory_can_view(v_actor)
    or public.stock_count_can_view('tan_tao')
    or public.stock_count_can_view('q7')
    or public.kho_item_can_edit(v_actor)
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Exactly two ledger calls, once for the whole list.
  v_tt := public.get_stock_ledger_overview('tan_tao', current_date);
  v_q7 := public.get_stock_ledger_overview('q7', current_date);

  with tt as (
    select coalesce(jsonb_object_agg(e ->> 'item_id', e), '{}'::jsonb) as map
    from jsonb_array_elements(coalesce(v_tt -> 'materials', '[]'::jsonb)) e
    where nullif(e ->> 'item_id', '') is not null
  ),
  q7 as (
    select coalesce(jsonb_object_agg(e ->> 'item_id', e), '{}'::jsonb) as map
    from jsonb_array_elements(coalesce(v_q7 -> 'items', '[]'::jsonb)) e
    where nullif(e ->> 'item_id', '') is not null
  ),
  pending as (
    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) as map
    from (
      select distinct on (s.location, l.target_id)
        s.location || ':' || l.target_id::text as k,
        l.counted_qty as v
      from public.stock_count_lines l
      join public.stock_count_sessions s on s.id = l.session_id
      where s.status = 'open'
        and l.target_kind = 'item'
        and s.location in ('tan_tao', 'q7')
      order by s.location, l.target_id, s.opened_at desc, l.id desc
    ) x
  ),
  docs as (
    select coalesce(jsonb_object_agg(item_id, n), '{}'::jsonb) as map
    from (
      select a.kitchen_inventory_item_id as item_id,
             count(distinct gri.id)::integer as n
      from public.stock_material_aliases a
      join public.goods_receipts gr
        on gr.supplier_id is not distinct from a.supplier_id
      left join public.suppliers s on s.id = gr.supplier_id
      join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
      where a.kitchen_inventory_item_id is not null
        and a.location in ('tan_tao', 'q7')
        and a.location = coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao')
        and gr.status in ('confirmed', 'received')
        and coalesce(s.stock_exempt, false) = false
        and public.stock_line_auto_non_stock(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            ) is null
        and a.normalized_name = public.normalize_stock_item_name(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            )
      group by a.kitchen_inventory_item_id
    ) x
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', kii.id,
           'item_code', kii.item_code,
           'name', kii.name,
           'unit', kii.unit,
           'active', coalesce(kii.active, false),
           'item_class', kii.item_class,
           'in_q7', coalesce(kii.pastry_q7, false),
           'in_tan_tao', coalesce(kii.in_tan_tao, not coalesce(kii.pastry_q7, false)),
           'qty', jsonb_build_object(
             'tan_tao', case
               when tt.map ? kii.id::text
                 then (tt.map -> kii.id::text ->> 'current_qty')::numeric
               else null
             end,
             'q7', case
               when q7.map ? kii.id::text
                 then (q7.map -> kii.id::text ->> 'current_qty')::numeric
               else null
             end
           ),
           'last_count_date', jsonb_build_object(
             'tan_tao', tt.map -> kii.id::text ->> 'last_count_date',
             'q7', q7.map -> kii.id::text ->> 'last_count_date'
           ),
           'pending_count', jsonb_build_object(
             'tan_tao', pending.map -> ('tan_tao:' || kii.id::text),
             'q7', pending.map -> ('q7:' || kii.id::text)
           ),
           'doc_lines', coalesce((docs.map ->> kii.id::text)::integer, 0)
         ) order by kii.name, kii.id), '[]'::jsonb)
  into v_items
  from public.kitchen_inventory_items kii
  cross join tt
  cross join q7
  cross join pending
  cross join docs
  where kii.active = true
     or exists (
       select 1
       from public.stock_item_discontinuations d
       where d.item_id = kii.id
     );

  return jsonb_build_object(
    'can_edit', public.kho_item_can_edit(v_actor),
    'can_count', jsonb_build_object(
      'tan_tao', public.stock_count_can_edit('tan_tao'),
      'q7', public.stock_count_can_edit('q7')
    ),
    'items', v_items
  );
end;
$$;


revoke all on function public.kho_get_items() from public, anon;
grant execute on function public.kho_get_items() to authenticated, service_role;


-- ===========================================================================
-- 5. kho_count_item — Tân Tạo guard follows in_tan_tao
-- ===========================================================================

create or replace function public.kho_count_item(
  p_location text,
  p_item_id uuid,
  p_counted_qty numeric,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_count_date date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_result jsonb;
begin
  if p_location not in ('tan_tao', 'q7') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;
  if v_actor is null then
    raise exception 'actor_required' using errcode = '42501';
  end if;
  if not public.stock_count_can_edit(p_location) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_counted_qty is null
     or p_counted_qty < 0
     or p_counted_qty::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if coalesce(v_item.active, false) = false then
    raise exception 'item_inactive' using errcode = '22023';
  end if;
  if p_location = 'q7' and coalesce(v_item.pastry_q7, false) = false then
    raise exception 'item_not_in_location' using errcode = '22023';
  end if;
  if p_location = 'tan_tao'
     and coalesce(v_item.in_tan_tao, not coalesce(v_item.pastry_q7, false)) = false then
    raise exception 'item_not_in_location' using errcode = '22023';
  end if;

  if p_location = 'q7' then
    v_result := public.record_q7_stock_count(
      p_item_id,
      p_counted_qty,
      v_count_date,
      'Đếm trong game kho',
      'kho-count:' || p_request_id::text
    );
  else
    v_result := public.record_tan_tao_material_count(
      p_item_id,
      p_counted_qty,
      v_count_date,
      'Đếm trong game kho',
      'kho-count:' || p_request_id::text
    );
  end if;

  return jsonb_build_object(
    'status', 'counted',
    'location', p_location,
    'item_id', p_item_id,
    'counted_qty', p_counted_qty,
    'result', v_result
  );
end;
$$;


revoke all on function public.kho_count_item(text, uuid, numeric, uuid) from public, anon;
grant execute on function public.kho_count_item(text, uuid, numeric, uuid) to authenticated, service_role;


-- ===========================================================================
-- 6. learn_tan_tao_purchase_parameters — learn every Tân Tạo-place item
-- ===========================================================================

create or replace function public.learn_tan_tao_purchase_parameters()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item_ids uuid[];
  v_updated integer := 0;
  v_removed integer := 0;
begin
  -- Same gate as the Q7 learner: service_role, or an owner / inventory editor.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner'::app_role)
      or public.has_module_permission(v_actor, 'inventory', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  with lines as (
    -- A single shared source: receipt lines plus approved request lines that have
    -- no receipt and no PO. Each purchase is counted exactly once.
    select l.kitchen_inventory_item_id as item_id,
           l.doc_date,
           l.supplier_id,
           l.book_qty
    from public.q7_purchase_usage_purchase_lines(current_date - 120, current_date) l
    join public.kitchen_inventory_items kii on kii.id = l.kitchen_inventory_item_id
    where l.book_qty is not null
      and l.book_qty > 0
      and kii.active is true
      and kii.merged_into_id is null
      and coalesce(kii.item_class, 'raw_material') in ('raw_material', 'packaging_supply')
      and coalesce(kii.in_tan_tao, not coalesce(kii.pastry_q7, false))
  ),
  days as (
    select item_id, doc_date, sum(book_qty) as day_qty
    from lines
    group by item_id, doc_date
  ),
  day_stats as (
    select ds.item_id,
           count(*)::integer as receipt_days,
           min(ds.doc_date) as first_date,
           max(ds.doc_date) as last_date,
           sum(ds.day_qty) as total_qty,
           percentile_cont(0.5) within group (order by ds.day_qty) as median_day_qty
    from days ds
    group by ds.item_id
    having count(distinct ds.doc_date) >= 2
  ),
  gap_days as (
    select item_id,
           doc_date - lag(doc_date) over (partition by item_id order by doc_date) as gap
    from days
  ),
  gap_stats as (
    select g.item_id,
           percentile_cont(0.5) within group (order by g.gap) as median_gap
    from gap_days g
    where g.gap is not null
    group by g.item_id
  ),
  supplier_totals as (
    select l.item_id,
           l.supplier_id,
           sum(l.book_qty) as bought_qty,
           max(l.doc_date) as latest_date
    from lines l
    where l.doc_date >= current_date - 90
      and l.supplier_id is not null
    group by l.item_id, l.supplier_id
  ),
  supplier_pick as (
    -- Largest purchased book quantity in the last 90 days; ties go to the
    -- supplier whose latest purchase is the most recent.
    select distinct on (st.item_id) st.item_id, st.supplier_id
    from supplier_totals st
    order by st.item_id, st.bought_qty desc, st.latest_date desc, st.supplier_id
  ),
  lead_stats as (
    select sp.item_id,
           percentile_cont(0.5) within group (order by (gr.receipt_date - po.order_date)) as median_lead
    from supplier_pick sp
    join public.purchase_orders po on po.supplier_id = sp.supplier_id
    join public.goods_receipts gr on gr.purchase_order_id = po.id
    where gr.receipt_date is not null
      and gr.receipt_date >= current_date - 120
      and (gr.receipt_date - po.order_date) between 0 and 30
    group by sp.item_id
  ),
  learned as (
    select ds.item_id,
           sp.supplier_id,
           (pk.pack ->> 'pack_size')::numeric as pack_size,
           pk.pack ->> 'pack_label' as pack_label,
           round(ls.median_lead::numeric)::integer as lead_time_days,
           case
             when ds.receipt_days >= 3
               then round(gs.median_gap::numeric, 1)
             else null
           end as cycle_days,
           round(ds.median_day_qty::numeric, 3) as order_qty,
           round(
             ds.total_qty / greatest(30, current_date - ds.first_date + 1),
             3
           ) as daily_usage,
           ds.receipt_days,
           ds.last_date
    from day_stats ds
    join public.kitchen_inventory_items kii on kii.id = ds.item_id
    left join gap_stats gs on gs.item_id = ds.item_id
    left join supplier_pick sp on sp.item_id = ds.item_id
    left join lead_stats ls on ls.item_id = ds.item_id
    cross join lateral (
      select public.q7_pack_from_name(kii.name, kii.unit) as pack
    ) pk
  ),
  upserted as (
    insert into public.warehouse_item_learning (
      location,
      kitchen_inventory_item_id,
      learned_supplier_id,
      learned_pack_size,
      learned_pack_label,
      learned_lead_time_days,
      learned_cycle_days,
      learned_order_qty,
      learned_daily_usage,
      receipt_days,
      last_receipt_date,
      learned_at
    )
    select 'tan_tao',
           l.item_id,
           l.supplier_id,
           l.pack_size,
           l.pack_label,
           l.lead_time_days,
           l.cycle_days,
           l.order_qty,
           l.daily_usage,
           l.receipt_days,
           l.last_date,
           now()
    from learned l
    on conflict (location, kitchen_inventory_item_id) do update set
      learned_supplier_id = excluded.learned_supplier_id,
      learned_pack_size = excluded.learned_pack_size,
      learned_pack_label = excluded.learned_pack_label,
      learned_lead_time_days = excluded.learned_lead_time_days,
      learned_cycle_days = excluded.learned_cycle_days,
      learned_order_qty = excluded.learned_order_qty,
      learned_daily_usage = excluded.learned_daily_usage,
      receipt_days = excluded.receipt_days,
      last_receipt_date = excluded.last_receipt_date,
      learned_at = now()
    returning kitchen_inventory_item_id
  )
  select coalesce(array_agg(u.kitchen_inventory_item_id), '{}'::uuid[]),
         count(*)::integer
  into v_item_ids, v_updated
  from upserted u;

  -- Drop Tân Tạo rows whose item no longer qualifies (fewer than two receipt
  -- days in the last 120 days, inactive, merged, pastry Q7 or another class).
  delete from public.warehouse_item_learning w
  where w.location = 'tan_tao'
    and not (w.kitchen_inventory_item_id = any (v_item_ids));
  get diagnostics v_removed = row_count;

  return jsonb_build_object(
    'status', 'learned',
    'location', 'tan_tao',
    'items_updated', v_updated,
    'items_removed', v_removed
  );
end;
$$;


revoke all on function public.learn_tan_tao_purchase_parameters() from public, anon;
grant execute on function public.learn_tan_tao_purchase_parameters() to authenticated, service_role;


-- ===========================================================================
-- 7. get_stock_ledger_overview — pass_through only for Q7-only goods
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
              (coalesce(kii.pastry_q7, false) and not coalesce(kii.in_tan_tao, false)) as pass_through
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


revoke all on function public.get_stock_ledger_overview(text, date) from public, anon;
grant execute on function public.get_stock_ledger_overview(text, date) to authenticated, service_role;


-- ===========================================================================
-- 8. post_stock_goods_receipt_item — no auto-transfer for a two-kho item
-- ===========================================================================

create or replace function public.post_stock_goods_receipt_item(
  p_item_id uuid,
  p_alias public.stock_material_aliases
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_cutover date;
  v_qty numeric;
  v_inserted integer := 0;
  v_sku_code text;
  v_doc_id uuid;
  v_doc_number text;
  v_transfer_id uuid;
  v_transfer_number text;
  v_pastry boolean;
begin
  if p_alias.line_class = 'non_stock' then
    return false;
  end if;

  select * into v_item from public.goods_receipt_items where id = p_item_id;
  if not found then
    return false;
  end if;
  select * into v_receipt from public.goods_receipts where id = v_item.goods_receipt_id;
  if not found then
    return false;
  end if;

  -- A kg / g / l / ml line converts by its own unit; packs use the alias factor.
  v_qty := round(
    greatest(0, coalesce(public.goods_receipt_effective_quantity(
      v_item.actual_quantity,
      v_item.quantity,
      v_item.ordered_quantity,
      v_receipt.status::text
    ), 0))
    * coalesce(
        case when p_alias.kitchen_inventory_item_id is not null then
          public.stock_unit_line_factor(
            v_item.unit,
            (select k.unit from public.kitchen_inventory_items k where k.id = p_alias.kitchen_inventory_item_id)
          )
        end,
        case when p_alias.kitchen_inventory_item_id is not null then
          public.stock_unit_pack_factor(
            coalesce(v_item.raw_product_name, v_item.product_name),
            v_item.unit,
            (select k.unit from public.kitchen_inventory_items k where k.id = p_alias.kitchen_inventory_item_id)
          )
        end,
        p_alias.conversion_factor
      ),
    3
  );
  if v_qty is null or v_qty <= 0 then
    return false;
  end if;

  if p_alias.location = 'q7' then
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_alias.kitchen_inventory_item_id, v_receipt.receipt_date, 'receipt', v_qty,
      p_alias.unit, 'goods_receipt', 'gr-item:' || p_item_id::text,
      'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
    get diagnostics v_inserted = row_count;
    return v_inserted > 0;
  end if;

  if p_alias.location = 'tan_tao' then
    -- Shared raw material: append to the Tân Tạo NVL ledger, same cutover rule.
    if p_alias.kitchen_inventory_item_id is not null then
      if public.stock_goods_receipt_item_is_posted(p_item_id) then
        return false;
      end if;
      v_cutover := public.stock_ledger_cutover_date('tan_tao');
      if v_cutover is null or v_receipt.receipt_date < v_cutover then
        return false;
      end if;
      insert into public.tan_tao_material_movements(
        kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
        source, source_ref_key, note, created_by
      ) values (
        p_alias.kitchen_inventory_item_id, v_receipt.receipt_date, 'receipt', v_qty,
        p_alias.unit, 'goods_receipt', 'gr-item:' || p_item_id::text,
        'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
      )
      on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
      get diagnostics v_inserted = row_count;

      -- A Q7-only pastry item received at Tân Tạo moves straight to Q7; a
      -- two-kho item stays at Tân Tạo as well.
      if v_inserted > 0 then
        select (coalesce(k.pastry_q7, false) and not coalesce(k.in_tan_tao, false))
          into v_pastry
        from public.kitchen_inventory_items k
        where k.id = p_alias.kitchen_inventory_item_id;

        if coalesce(v_pastry, false) then
          v_transfer_number := 'CK-'
            || to_char(coalesce(v_receipt.receipt_date, current_date), 'YYYYMMDD')
            || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

          insert into public.stock_transfers(
            transfer_number, from_location, to_location, kitchen_inventory_item_id,
            quantity, unit, transfer_date, source, goods_receipt_item_id, note, created_by
          ) values (
            v_transfer_number, 'tan_tao', 'q7', p_alias.kitchen_inventory_item_id,
            v_qty, p_alias.unit, v_receipt.receipt_date, 'auto_goods_receipt', p_item_id,
            'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
          )
          on conflict (goods_receipt_item_id) do nothing
          returning id into v_transfer_id;

          if v_transfer_id is not null then
            insert into public.tan_tao_material_movements(
              kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
              source, source_ref_key, note, created_by
            ) values (
              p_alias.kitchen_inventory_item_id, v_receipt.receipt_date, 'transfer_out', v_qty,
              p_alias.unit, 'stock_transfer', 'transfer:' || v_transfer_id::text,
              'Chuyển NVL bánh ngọt sang Q7 (phiếu nhập kho ' || v_receipt.receipt_number || ')',
              auth.uid()
            )
            on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

            insert into public.q7_inventory_movements(
              kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
              source, source_ref_key, note, created_by
            ) values (
              p_alias.kitchen_inventory_item_id, v_receipt.receipt_date, 'transfer_in', v_qty,
              p_alias.unit, 'stock_transfer', 'transfer:' || v_transfer_id::text,
              'Nhận NVL bánh ngọt từ Tân Tạo (phiếu nhập kho ' || v_receipt.receipt_number || ')',
              auth.uid()
            )
            on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
          end if;
        end if;
      end if;

      return v_inserted > 0;
    end if;

    -- Finished-goods SKU: unchanged document path.
    if public.stock_goods_receipt_item_is_posted(p_item_id) then
      return false;
    end if;
    select upper(sku_code) into v_sku_code
    from public.product_skus
    where id = p_alias.tan_tao_sku_id;
    if v_sku_code is null
       or v_sku_code not in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G') then
      return false;
    end if;

    v_doc_number := 'TT-GR-' || to_char(coalesce(v_receipt.receipt_date, current_date), 'YYYYMMDD')
      || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

    insert into public.tan_tao_warehouse_documents(
      document_number, location_code, sku_id, sku_code_snapshot, document_type, status,
      quantity, physical_quantity, source_authority, reference_type, reference_id,
      reference_label, idempotency_key, note, metadata, created_by
    ) values (
      v_doc_number, 'warehouse_tan_tao', p_alias.tan_tao_sku_id, v_sku_code, 'receipt', 'posted',
      v_qty, v_qty, 'confirmed_goods_receipt', 'goods_receipt', v_receipt.id,
      v_receipt.receipt_number, 'gr-item:' || p_item_id::text,
      'Phiếu nhập kho ' || v_receipt.receipt_number,
      jsonb_build_object('goods_receipt_id', v_receipt.id, 'goods_receipt_item_id', p_item_id, 'stock_effect', 'receipt'),
      auth.uid()
    )
    on conflict (idempotency_key) do nothing
    returning id into v_doc_id;

    if v_doc_id is null then
      return false;
    end if;

    insert into public.tan_tao_warehouse_movements(
      document_id, location_code, sku_id, sku_code_snapshot, movement_type, quantity, note, created_by
    ) values (
      v_doc_id, 'warehouse_tan_tao', p_alias.tan_tao_sku_id, v_sku_code, 'receipt', v_qty,
      'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
    );
    return true;
  end if;

  return false;
end;
$$;


revoke all on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases)
  from public, anon, authenticated;
grant execute on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases)
  to service_role;


-- ===========================================================================
-- 9. cogs_refresh_mappings — kho_canonical prefers the Tân Tạo place
-- ===========================================================================

create or replace function public.cogs_refresh_mappings()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_rec record;
  v_item_id uuid;
  v_item_name text;
  v_item_unit text;
  v_item_in_tan_tao boolean;
  v_existing public.revenue_product_sku_map%rowtype;
  v_existing_ing public.cogs_ingredient_stock_map%rowtype;
  v_sku_id uuid;
  v_map_id uuid;
  v_status text;
  v_source text;
  v_confidence numeric;
  v_evidence jsonb;
  v_name_key text;
  v_norm text;
  v_tokens text[];
  v_sizes text[];
  v_best numeric;
  v_second numeric;
  v_best_sku uuid;
  v_best_code text;
  v_best_name text;
  v_candidates jsonb;
  v_material_name text;
  v_decision public.q7_bom_line_decisions%rowtype;
  v_q7map public.q7_material_issue_material_mappings%rowtype;
  v_count integer;
  v_location text;
  v_factor numeric;
  v_has_movement boolean;
  v_action text;
  v_reason text;
begin
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or (v_actor is not null and (
      public.has_role(v_actor, 'owner')
      or public.material_alias_can_admin(v_actor)
    ))
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- -----------------------------------------------------------------------
  -- Revenue products: last 120 days of approved, positive revenue lines.
  -- -----------------------------------------------------------------------
  -- Candidate SKUs for the name rule, built once per refresh: finished
  -- goods on production orders of the last 90 days, under their own name and
  -- under the order line's name.
  create temp table if not exists pg_temp.cogs_bf_cand (
    sku_id uuid,
    sku_code text,
    name text,
    toks text[],
    sizes text[]
  ) on commit drop;
  truncate table pg_temp.cogs_bf_cand;

  insert into pg_temp.cogs_bf_cand(sku_id, sku_code, name, toks, sizes)
  with candidate_names as (
    select ps.id as sku_id, ps.sku_code, ps.product_name as name
    from public.product_skus ps
    where ps.sku_type = 'finished_good'
      and exists (
        select 1
        from public.production_order_items poi
        join public.production_orders po on po.id = poi.production_order_id
        where poi.sku_id = ps.id
          and coalesce(poi.delivery_date, po.planned_start_date, po.created_at::date)
              >= v_today - 90
      )
    union
    select distinct ps.id, ps.sku_code, poi.product_name
    from public.production_order_items poi
    join public.production_orders po on po.id = poi.production_order_id
    join public.product_skus ps on ps.id = poi.sku_id
    where ps.sku_type = 'finished_good'
      and coalesce(poi.delivery_date, po.planned_start_date, po.created_at::date)
          >= v_today - 90
  ),
  normalized as (
    select sku_id, sku_code, name,
           regexp_replace(
             coalesce(public.normalize_stock_item_name(name), ''),
             '^bmq\s*-\s*', '', 'i'
           ) as norm_name
    from candidate_names
  )
  select sku_id, sku_code, name,
         array(
           select distinct t
           from unnest(regexp_split_to_array(norm_name, '\s+')) t
           where t <> ''
             and t !~ '^[0-9]+([.,][0-9]+)?(kg|g|gr|gram|ml|l)$'
           order by t
         ),
         array(
           select distinct m[1] || m[3]
           from regexp_matches(
             norm_name,
             '([0-9]+([.,][0-9]+)?)\s*(kg|g|gr|gram|ml|l)\y',
             'g'
           ) m
           order by m[1] || m[3]
         )
  from normalized;

  for v_rec in
    with lines as (
      select l.channel,
             l.product_code,
             regexp_replace(
               coalesce(public.normalize_stock_item_name(l.product_name), ''),
               '^bmq\s*-\s*', '', 'i'
             ) as name_key,
             l.revenue_date,
             l.id,
             nullif(btrim(l.raw_payload ->> 'sku_id'), '') as payload_sku_id,
             lower(nullif(btrim(l.raw_payload ->> 'sku_code'), '')) as payload_sku_code
      from public.revenue_ledger_lines l
      where l.approval_status = 'approved'
        and l.quantity > 0
        and l.revenue_date >= v_today - 120
        and l.revenue_date <= v_today
    )
    select channel, product_code, name_key,
           (array_agg(payload_sku_id order by revenue_date desc, id desc)
              filter (where payload_sku_id is not null))[1] as payload_sku_id,
           (array_agg(payload_sku_code order by revenue_date desc, id desc)
              filter (where payload_sku_code is not null))[1] as payload_sku_code
    from lines
    group by channel, product_code, name_key
    order by channel, product_code, name_key
  loop
    v_name_key := v_rec.name_key;
    v_sku_id := null;
    v_status := null;
    v_source := 'production_name';
    v_confidence := null;
    v_evidence := '{}'::jsonb;

    v_existing := null;
    select * into v_existing
    from public.revenue_product_sku_map m
    where coalesce(m.channel, '') = coalesce(v_rec.channel, '')
      and coalesce(m.product_code, '') = coalesce(v_rec.product_code, '')
      and coalesce(m.name_key, '') = coalesce(v_name_key, '')
    limit 1;

    if found and v_existing.status in ('confirmed', 'rejected') then
      continue;
    end if;

    -- 1. exact product code
    if v_rec.product_code is not null and btrim(v_rec.product_code) <> '' then
      select ps.id into v_sku_id
      from public.product_skus ps
      where lower(btrim(ps.sku_code)) = lower(btrim(v_rec.product_code))
      order by ps.id::text
      limit 1;
      if v_sku_id is not null then
        v_status := 'auto';
        v_source := 'exact_code';
        v_confidence := 1;
      end if;
    end if;

    -- 2. the payload carries a SKU id or code
    if v_sku_id is null
       and (v_rec.payload_sku_id is not null or v_rec.payload_sku_code is not null) then
      select ps.id into v_sku_id
      from public.product_skus ps
      where ps.id::text = v_rec.payload_sku_id
         or lower(btrim(ps.sku_code)) = v_rec.payload_sku_code
      order by (ps.id::text = coalesce(v_rec.payload_sku_id, '')) desc, ps.id::text
      limit 1;
      if v_sku_id is not null then
        v_status := 'auto';
        v_source := 'payload_sku';
        v_confidence := 1;
      end if;
    end if;

    -- 3. production-order name score. Size tokens must agree when both sides
    --    carry one, so a 50g name is never mapped to a 160g SKU.
    if v_sku_id is null then
      v_norm := coalesce(v_name_key, '');
      select coalesce(array_agg(distinct t order by t), '{}'::text[])
        into v_tokens
      from unnest(regexp_split_to_array(v_norm, '\s+')) t
      where t <> ''
        and t !~ '^[0-9]+([.,][0-9]+)?(kg|g|gr|gram|ml|l)$';

      select coalesce(array_agg(distinct m[1] || m[3] order by m[1] || m[3]), '{}'::text[])
        into v_sizes
      from regexp_matches(
        v_norm,
        '([0-9]+([.,][0-9]+)?)\s*(kg|g|gr|gram|ml|l)\y',
        'g'
      ) m;

      create temp table if not exists pg_temp.cogs_bf_score (
        sku_id uuid,
        sku_code text,
        name text,
        score numeric
      ) on commit drop;
      truncate table pg_temp.cogs_bf_score;

      insert into pg_temp.cogs_bf_score(sku_id, sku_code, name, score)
      select c.sku_id, c.sku_code, c.name,
             round(
               case
                 when cardinality(c.toks) = 0 then 0
                 when cardinality(c.sizes) > 0
                      and cardinality(v_sizes) > 0
                      and c.sizes <> v_sizes then 0
                 else (
                   select count(*)::numeric
                   from unnest(c.toks) tk
                   where tk = any(v_tokens)
                 ) / greatest(cardinality(c.toks), cardinality(v_tokens), 1)
               end,
               4
             )
      from pg_temp.cogs_bf_cand c
      where cardinality(c.toks) > 0;

      v_candidates := '[]'::jsonb;
      select coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'sku_id', sku_id,
                   'sku_code', sku_code,
                   'name', name,
                   'score', score
                 )
                 order by score desc, sku_code
               ),
               '[]'::jsonb
             )
        into v_candidates
      from (
        select distinct on (sku_id) sku_id, sku_code, name, score
        from pg_temp.cogs_bf_score
        order by sku_id, score desc, sku_code
      ) deduped;

      select sku_id, sku_code, name, score
        into v_best_sku, v_best_code, v_best_name, v_best
      from (
        select distinct on (sku_id) sku_id, sku_code, name, score
        from pg_temp.cogs_bf_score
        order by sku_id, score desc, sku_code
      ) deduped
      order by score desc, sku_code
      limit 1;

      select score into v_second
      from (
        select distinct on (sku_id) sku_id, sku_code, name, score
        from pg_temp.cogs_bf_score
        order by sku_id, score desc, sku_code
      ) deduped
      order by score desc, sku_code
      offset 1 limit 1;

      if v_best is not null and v_best >= 0.85
         and (v_second is null or v_best - v_second >= 0.15) then
        v_status := 'auto';
        v_source := 'production_name';
        v_confidence := round(v_best, 4);
        v_sku_id := v_best_sku;
        v_evidence := jsonb_build_object(
          'rule', 'production_name',
          'best', jsonb_build_object(
            'sku_id', v_best_sku,
            'sku_code', v_best_code,
            'name', v_best_name,
            'score', v_best
          ),
          'candidates', v_candidates
        );
      else
        v_status := 'suggested';
        v_source := 'production_name';
        v_confidence := case when v_best is null then null else round(v_best, 4) end;
        v_sku_id := null;
        v_evidence := jsonb_build_object(
          'rule', 'production_name',
          'candidates', v_candidates
        );
      end if;
    end if;

    if v_status is null then
      v_status := 'suggested';
      v_source := 'production_name';
      v_evidence := jsonb_build_object('rule', 'production_name', 'candidates', '[]'::jsonb);
    end if;

    if v_existing.id is null then
      insert into public.revenue_product_sku_map(
        channel, product_code, name_key, sku_id, units_per_revenue_unit,
        status, source, confidence, evidence
      ) values (
        v_rec.channel, v_rec.product_code, v_name_key, v_sku_id, 1,
        v_status, v_source, v_confidence, v_evidence
      );
    else
      update public.revenue_product_sku_map
      set sku_id = v_sku_id,
          status = v_status,
          source = v_source,
          confidence = v_confidence,
          evidence = v_evidence,
          updated_at = now()
      where id = v_existing.id
        and status not in ('confirmed', 'rejected');
    end if;
  end loop;

  -- -----------------------------------------------------------------------
  -- Ingredients used by mapped finished SKUs.
  -- -----------------------------------------------------------------------
  for v_rec in
    select distinct
           f.canonical_material_id,
           public.normalize_document_unit(f.unit) as recipe_unit
    from (
      select f.canonical_material_id, f.unit, v.sku_id
      from public.sku_cogs_version_formulations f
      join public.sku_cogs_versions v on v.id = f.version_id
      where f.canonical_material_id is not null
        and v.effective_from <= v_today
        and (v.effective_to is null or v.effective_to >= v_today - 120)
        and not exists (
          select 1
          from public.sku_cogs_version_formulations child
          where child.version_id = f.version_id
            and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
        )
      union all
      select f.canonical_material_id, f.unit, f.sku_id
      from public.sku_formulations f
      where f.canonical_material_id is not null
        and not exists (
          select 1
          from public.sku_formulations child
          where child.sku_id = f.sku_id
            and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
        )
    ) f
    where f.canonical_material_id is not null
      and public.normalize_document_unit(f.unit) is not null
      and exists (
        select 1
        from public.revenue_product_sku_map m
        where m.status in ('auto', 'confirmed')
          and m.sku_id = f.sku_id
      )
    order by 1, 2
  loop
    v_existing_ing := null;
    select * into v_existing_ing
    from public.cogs_ingredient_stock_map m
    where m.canonical_material_id = v_rec.canonical_material_id
      and m.recipe_unit = v_rec.recipe_unit
    limit 1;

    if found and v_existing_ing.status in ('confirmed', 'rejected') then
      continue;
    end if;

    v_item_id := null;
    v_item_name := null;
    v_item_unit := null;
    v_item_in_tan_tao := null;
    v_action := null;
    v_location := null;
    v_factor := null;
    v_status := 'suggested';
    v_source := 'kho_canonical';
    v_reason := null;
    v_evidence := '{}'::jsonb;

    -- 1. an active Q7 BOM decision that drops the line (not_tracked /
    --    bom_error) wins. A 'remap' decision rewrites the Q7 PXK mapping row,
    --    so step 2 already follows it.
    select * into v_decision
    from public.q7_bom_line_decisions d
    where d.active = true
      and d.action in ('not_tracked', 'bom_error')
      and d.canonical_material_id = v_rec.canonical_material_id
      and lower(btrim(d.source_unit)) = lower(btrim(v_rec.recipe_unit))
    order by d.created_at desc, d.id::text
    limit 1;

    if found then
      v_source := 'q7_bom_decision';
      v_action := 'not_tracked';
      v_status := 'auto';
      v_reason := v_decision.action;
      v_evidence := jsonb_build_object(
        'decision_id', v_decision.id,
        'decision_action', v_decision.action
      );
    else
      -- 2. the approved Q7 PXK mapping: the item and factor the material
      --    issue posts with today (generate_q7_production_material_issue
      --    multiplies the recipe qty by conversion_factor).
      v_q7map := null;
      select * into v_q7map
      from public.q7_material_issue_material_mappings m
      where m.approval_status = 'approved'
        and m.canonical_material_id = v_rec.canonical_material_id
        and lower(btrim(m.source_unit)) = lower(btrim(v_rec.recipe_unit))
      order by m.id::text
      limit 1;
    end if;

    if v_action is null and v_q7map.id is not null
       and v_q7map.kitchen_inventory_item_id is not null
       and coalesce(v_q7map.conversion_factor, 0) > 0 then
      v_source := 'q7_pxk_mapping';
      v_action := 'deduct';
      v_location := 'q7';
      v_item_id := v_q7map.kitchen_inventory_item_id;
      v_factor := v_q7map.conversion_factor;
      v_status := 'auto';
      v_evidence := jsonb_build_object(
        'q7_mapping_id', v_q7map.id,
        'kitchen_unit', v_q7map.kitchen_unit
      );
    elsif v_action is null then
      -- 3. the single active kho item linked to the material.
      select count(*) into v_count
      from public.kitchen_inventory_items kii
      where kii.canonical_material_id = v_rec.canonical_material_id
        and kii.active = true
        and kii.merged_into_id is null;

      if v_count = 1 then
        select kii.id, kii.name, kii.unit, kii.in_tan_tao
          into v_item_id, v_item_name, v_item_unit, v_item_in_tan_tao
        from public.kitchen_inventory_items kii
        where kii.canonical_material_id = v_rec.canonical_material_id
          and kii.active = true
          and kii.merged_into_id is null
        order by kii.id::text
        limit 1;

        v_location := case when v_item_in_tan_tao then 'tan_tao' else 'q7' end;

        v_factor := public.stock_unit_line_factor(v_rec.recipe_unit, v_item_unit);
        -- Same count unit on both sides (cái → cái, gói → gói) is 1:1.
        if v_factor is null and lower(btrim(v_rec.recipe_unit)) = lower(btrim(v_item_unit)) then
          v_factor := 1;
        end if;
        if v_factor is null then
          select f.factor into v_factor
          from public.stock_item_unit_factors f
          where f.kitchen_inventory_item_id = v_item_id
            and lower(btrim(f.unit)) = lower(btrim(v_rec.recipe_unit))
          order by f.updated_at desc, f.id::text
          limit 1;
        end if;
        if v_factor is null then
          select c.factor into v_factor
          from public.material_unit_conversions c
          where c.material_id = v_rec.canonical_material_id
            and c.active = true
            and c.approved = true
            and c.effective_from <= v_today
            and (c.effective_to is null or v_today <= c.effective_to)
            and lower(btrim(c.from_unit)) = lower(btrim(v_rec.recipe_unit))
            and lower(btrim(c.to_unit)) = lower(btrim(v_item_unit))
          order by c.effective_from desc, c.id::text desc
          limit 1;
        end if;

        if v_location = 'q7' then
          select exists (
            select 1
            from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = v_item_id
          ) into v_has_movement;
        else
          select exists (
            select 1
            from public.tan_tao_material_movements m
            where m.kitchen_inventory_item_id = v_item_id
          ) into v_has_movement;
        end if;

        v_evidence := jsonb_build_object(
          'item_id', v_item_id,
          'item_name', v_item_name,
          'item_unit', v_item_unit,
          'has_movements', v_has_movement
        );

        if v_factor is not null and v_has_movement then
          v_action := 'deduct';
          v_status := 'auto';
          v_source := 'kho_canonical';
          v_reason := null;
        else
          v_action := case when v_factor is not null then 'deduct' else null end;
          v_status := 'suggested';
          v_source := 'kho_canonical';
          v_reason := case when v_factor is null then 'unit' else 'never_stocked' end;
        end if;
      elsif v_count = 0 then
        v_status := 'suggested';
        v_source := 'kho_canonical';
        v_reason := 'no_item';
        v_evidence := jsonb_build_object('items', '[]'::jsonb);
      else
        v_status := 'suggested';
        v_source := 'kho_canonical';
        v_reason := 'several_items';
        select coalesce(
                 jsonb_agg(jsonb_build_object(
                   'item_id', kii.id,
                   'name', kii.name,
                   'unit', kii.unit,
                   'pastry_q7', kii.pastry_q7
                 ) order by kii.name, kii.id::text),
                 '[]'::jsonb
               )
          into v_evidence
        from (
          select kii.*
          from public.kitchen_inventory_items kii
          where kii.canonical_material_id = v_rec.canonical_material_id
            and kii.active = true
            and kii.merged_into_id is null
          order by kii.name, kii.id::text
          limit 10
        ) kii;
        v_evidence := jsonb_build_object('items', v_evidence);
      end if;
    end if;

    if v_existing_ing.id is null then
      insert into public.cogs_ingredient_stock_map(
        canonical_material_id, recipe_unit, action, location,
        kitchen_inventory_item_id, factor, status, source, reason, evidence
      ) values (
        v_rec.canonical_material_id, v_rec.recipe_unit, v_action, v_location,
        v_item_id, v_factor, v_status, v_source, v_reason, v_evidence
      );
    else
      update public.cogs_ingredient_stock_map
      set action = v_action,
          location = v_location,
          kitchen_inventory_item_id = v_item_id,
          factor = v_factor,
          status = v_status,
          source = v_source,
          reason = v_reason,
          evidence = v_evidence,
          updated_at = now()
      where id = v_existing_ing.id
        and status not in ('confirmed', 'rejected');
    end if;
  end loop;

  return jsonb_build_object(
    'revenue_product',
    coalesce((
      select jsonb_object_agg(status, cnt)
      from (
        select status, count(*)::integer as cnt
        from public.revenue_product_sku_map
        group by status
      ) s
    ), '{}'::jsonb),
    'ingredient',
    coalesce((
      select jsonb_object_agg(status, cnt)
      from (
        select status, count(*)::integer as cnt
        from public.cogs_ingredient_stock_map
        group by status
      ) s
    ), '{}'::jsonb)
  );
end;
$$;


revoke all on function public.cogs_refresh_mappings() from public, anon;
grant execute on function public.cogs_refresh_mappings() to authenticated, service_role;


-- ===========================================================================
-- 10. cogs_decide_ingredient — accept either place the item belongs to
-- ===========================================================================

create or replace function public.cogs_decide_ingredient(
  p_canonical_material_id uuid,
  p_recipe_unit text,
  p_action text,
  p_location text,
  p_item_id uuid,
  p_factor numeric,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_unit text;
  v_map public.cogs_ingredient_stock_map%rowtype;
  v_before jsonb;
  v_event public.cogs_mapping_events%rowtype;
  v_item public.kitchen_inventory_items%rowtype;
begin
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or (v_actor is not null and (
      public.has_role(v_actor, 'owner')
      or public.material_alias_can_admin(v_actor)
    ))
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('cogs_decide_ingredient:' || p_request_id::text));

  select * into v_event
  from public.cogs_mapping_events e
  where e.request_id = p_request_id;
  if found then
    if v_event.kind <> 'ingredient' then
      raise exception 'request_id_reused' using errcode = '22023';
    end if;
    return coalesce(v_event.after, '{}'::jsonb)
      || jsonb_build_object('status', 'replayed');
  end if;

  if p_canonical_material_id is null then
    raise exception 'canonical_material_required' using errcode = '22023';
  end if;
  v_unit := public.normalize_document_unit(p_recipe_unit);
  if v_unit is null then
    raise exception 'recipe_unit_required' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('deduct', 'not_tracked', 'finished_goods_ledger') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.sku_cogs_materials m
    where m.id = p_canonical_material_id
  ) then
    raise exception 'canonical_material_not_found' using errcode = 'P0002';
  end if;

  if p_action = 'deduct' then
    if p_item_id is null then
      raise exception 'item_required' using errcode = '22023';
    end if;
    if p_factor is null
       or p_factor <= 0
       or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'factor_required' using errcode = '22023';
    end if;
    select * into v_item
    from public.kitchen_inventory_items kii
    where kii.id = p_item_id;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;
    if v_item.active is not true or v_item.merged_into_id is not null then
      raise exception 'item_not_active' using errcode = '22023';
    end if;
    if p_location = 'q7' then
      if not coalesce(v_item.pastry_q7, false) then
        raise exception 'location_mismatch' using errcode = '22023';
      end if;
    elsif p_location = 'tan_tao' then
      if not coalesce(v_item.in_tan_tao, false) then
        raise exception 'location_mismatch' using errcode = '22023';
      end if;
    else
      raise exception 'location_mismatch' using errcode = '22023';
    end if;
  end if;

  select * into v_map
  from public.cogs_ingredient_stock_map m
  where m.canonical_material_id = p_canonical_material_id
    and m.recipe_unit = v_unit
  for update;

  if found then
    v_before := to_jsonb(v_map);
    update public.cogs_ingredient_stock_map
    set action = p_action,
        location = case when p_action = 'deduct' then p_location else null end,
        kitchen_inventory_item_id = case when p_action = 'deduct' then p_item_id else null end,
        factor = case when p_action = 'deduct' then p_factor else null end,
        status = 'confirmed',
        source = 'manual',
        reason = null,
        decided_by = v_actor,
        decided_at = now(),
        updated_at = now()
    where id = v_map.id
    returning * into v_map;
  else
    v_before := null;
    insert into public.cogs_ingredient_stock_map(
      canonical_material_id, recipe_unit, action, location,
      kitchen_inventory_item_id, factor, status, source, reason,
      decided_by, decided_at
    ) values (
      p_canonical_material_id, v_unit, p_action,
      case when p_action = 'deduct' then p_location else null end,
      case when p_action = 'deduct' then p_item_id else null end,
      case when p_action = 'deduct' then p_factor else null end,
      'confirmed', 'manual', null, v_actor, now()
    ) returning * into v_map;
  end if;

  insert into public.cogs_mapping_events(
    kind, map_id, action, before, after, actor_id, request_id
  ) values (
    'ingredient', v_map.id, p_action, v_before, to_jsonb(v_map), v_actor, p_request_id
  );

  return to_jsonb(v_map);
end;
$$;


revoke all on function public.cogs_decide_ingredient(uuid, text, text, text, uuid, numeric, uuid)
  from public, anon;
grant execute on function public.cogs_decide_ingredient(uuid, text, text, text, uuid, numeric, uuid)
  to authenticated, service_role;


-- ===========================================================================
-- 11. stock_count_eligible_lines — Tân Tạo sheet follows in_tan_tao
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.stock_count_eligible_lines(p_location text, p_as_of date)
 RETURNS TABLE(target_kind text, target_id uuid, target_code text, target_name text, unit text, book_qty numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
             coalesce(kii.in_tan_tao, not coalesce(kii.pastry_q7, false)) as in_tan_tao,
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
    ) x
    -- Tân Tạo counts every item that has a place there; Q7-only goods are
    -- counted on the Q7 sheet.
    where x.in_tan_tao;

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
$function$;


revoke all on function public.stock_count_eligible_lines(text, date)
  from public, anon, authenticated;
grant execute on function public.stock_count_eligible_lines(text, date) to service_role;


-- ===========================================================================
-- 12. material_link_counts_internal — Tân Tạo count follows in_tan_tao
-- ===========================================================================

create or replace function public.material_link_counts_internal(p_location text)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with loc as (
    select lower(btrim(coalesce(p_location, ''))) as location
  ),
  base as (
    select kii.id, kii.name, kii.canonical_material_id
    from public.kitchen_inventory_items kii
    cross join loc
    where kii.active = true
      and kii.merged_into_id is null
      and (
        (loc.location = 'q7' and (
          kii.pastry_q7 = true
          or exists (
            select 1 from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = kii.id
          )
        ))
        or
        (loc.location = 'tan_tao' and coalesce(
          kii.in_tan_tao, not coalesce(kii.pastry_q7, false)
        ))
      )
  ),
  unlinked as (
    select b.id, b.name
    from base b
    where b.canonical_material_id is null
      and not exists (
        select 1 from public.material_link_skips s where s.item_id = b.id
      )
  )
  select jsonb_build_object(
    'total', (select count(*) from unlinked),
    'linked_total', (select count(*) from base where canonical_material_id is not null),
    'exact', (
      select count(*)
      from unlinked u
      where exists (
        select 1
        from public.sku_cogs_materials m
        where m.active = true
          and m.normalized_name = public.material_master_normalize(u.name)
      )
    ),
    'skipped', (
      select count(*)
      from base b
      join public.material_link_skips s on s.item_id = b.id
    )
  );
$$;


revoke execute on function public.material_link_counts_internal(text)
  from public, anon, authenticated, service_role;


-- ===========================================================================
-- 13. material_link_review_items_internal — Tân Tạo review follows in_tan_tao
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
      (v_location = 'tan_tao' and coalesce(
        kii.in_tan_tao, not coalesce(kii.pastry_q7, false)
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
      (v_location = 'tan_tao' and coalesce(
        kii.in_tan_tao, not coalesce(kii.pastry_q7, false)
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
      (v_location = 'tan_tao' and coalesce(
        kii.in_tan_tao, not coalesce(kii.pastry_q7, false)
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
      (v_location = 'tan_tao' and coalesce(
        kii.in_tan_tao, not coalesce(kii.pastry_q7, false)
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


revoke execute on function public.material_link_review_items_internal(text)
  from public, anon, authenticated, service_role;


-- ===========================================================================
-- 14. get_material_link_pending_factors — Tân Tạo pending follows in_tan_tao
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
      (v_location = 'tan_tao' and coalesce(
        kii.in_tan_tao, not coalesce(kii.pastry_q7, false)
      ))
    );

  return jsonb_build_object('items', v_items);
end;
$$;


revoke execute on function public.get_material_link_pending_factors(text) from public, anon;
grant execute on function public.get_material_link_pending_factors(text) to authenticated, service_role;
