-- Rollback-only production smoke for migration
-- 20261026100000_central_warehouse_flow.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_central_warehouse_flow.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_central_warehouse_flow.sql).
--
-- The file opens one transaction, applies the migration SQL inline, then checks
-- the pastry seed, the Tân Tạo central-receiving move, the q7 alias twins, the
-- automatic Tân Tạo -> Q7 transfer for a pastry receipt line and every redefined
-- balance reader. The final RAISE aborts the transaction, so every change rolls
-- back.
begin;

-- 2026-10-26 — Kho tổng Tân Tạo + tự chuyển NVL bánh ngọt sang Q7 (phần dữ liệu).
--
-- Owner operating model 2026-10-12:
--   * Tân Tạo is the central warehouse and every goods receipt lands there.
--   * Kitchen items carry a pastry_q7 flag. Posting a Tân Tạo receipt line for a
--     flagged item writes one stock transfer Tân Tạo -> Q7 for the full posted
--     quantity (Tân Tạo ledger transfer_out, Q7 ledger transfer_in), idempotent
--     per receipt line. The Q7 ledger refuses stock increases for items without
--     the flag.
--   * Historical q7-stamped receipts, supplier defaults and q7 aliases move to
--     Tân Tạo without rewriting posted ledger rows.
--
-- Ledger readers audited for the two new movement types. Every one is redefined
-- below with the new sign handling (transfer_in counts as Q7 in / balance up,
-- transfer_out counts as Tân Tạo out / balance down); signatures and output
-- columns are unchanged:
--   * public.get_q7_inventory_snapshot(date)                 — receipt_qty / balance_qty
--   * public.get_stock_ledger_overview(text, date)           — in_qty_7d / out_qty_7d / balance
--   * public.get_warehouse_game_snapshot(text)               — on_hand / transfers
--   * public.record_tan_tao_material_count(uuid, numeric, date, text, text)
--   * public.apply_stock_item_merge(uuid, uuid, numeric, uuid)  — Q7 + Tân Tạo balances
--   * public.revert_stock_item_merge(uuid)                   — reverses both ledgers
--   * public.stock_item_merge_forward()                      — Q7 after-insert forward trigger
--   * public.tan_tao_material_merge_forward()                — Tân Tạo after-insert forward trigger
--   * public.mission_evaluate(uuid)                          — duplicate-resolution on_hand
-- Read-only existence / count readers never classify by movement_type and are
-- left untouched: stock_goods_receipt_item_is_posted, stock_unit_item_has_history,
-- get_stock_catalog_candidates, get_stock_catalog_review, q7_purchase_daily_usage
-- (usage is built from issue lines) and get_q7_purchase_forecast (its on-hand is
-- the redefined snapshot).
--
-- Nothing here updates or deletes a posted q7_inventory_movements,
-- tan_tao_material_movements or tan_tao_warehouse_movements row: both ledgers stay
-- append-only. The only document writes are receiving_location / supplier default
-- moves and the append-only stock_location_moves audit rows.

-- ===========================================================================
-- 1. kitchen_inventory_items.pastry_q7 and the rule seed
-- ===========================================================================

alter table public.kitchen_inventory_items
  add column if not exists pastry_q7 boolean not null default false,
  add column if not exists pastry_q7_source text,
  add column if not exists pastry_q7_set_at timestamptz,
  add column if not exists pastry_q7_set_by uuid references auth.users(id) on delete set null;

alter table public.kitchen_inventory_items
  drop constraint if exists kitchen_inventory_items_pastry_q7_source_check;
alter table public.kitchen_inventory_items
  add constraint kitchen_inventory_items_pastry_q7_source_check
  check (pastry_q7_source is null or pastry_q7_source in ('rule', 'owner'));

create index if not exists idx_kitchen_inventory_items_pastry_q7
  on public.kitchen_inventory_items(pastry_q7)
  where pastry_q7 = true;

-- Rule seed: active, unmerged items that are not a meat-filling / service
-- material and are either already used at Q7 (alias, movement) or map to one of
-- the pastry raw-material categories.
do $$
declare
  v_seeded integer := 0;
begin
  update public.kitchen_inventory_items kii
  set pastry_q7 = true,
      pastry_q7_source = 'rule',
      pastry_q7_set_at = now(),
      pastry_q7_set_by = null
  where kii.pastry_q7 = false
    and kii.active = true
    and kii.merged_into_id is null
    and (
      kii.canonical_material_id is null
      or not exists (
        select 1
        from public.sku_cogs_materials scm
        where scm.id = kii.canonical_material_id
          and scm.category in ('meat_filling', 'service')
      )
    )
    and (
      exists (
        select 1 from public.stock_material_aliases a
        where a.kitchen_inventory_item_id = kii.id and a.location = 'q7'
      )
      or exists (
        select 1 from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = kii.id
      )
      or exists (
        select 1 from public.sku_cogs_materials scm
        where scm.id = kii.canonical_material_id
          and scm.category in ('flour', 'dairy_fat', 'eggs', 'sugar_additives', 'cheese')
      )
    );
  get diagnostics v_seeded = row_count;
  raise notice 'central_warehouse_flow: seeded % pastry_q7 items with source rule', v_seeded;
end $$;

-- ===========================================================================
-- 2. stock_transfers (append-only) and stock_location_moves (audit, append-only)
-- ===========================================================================

create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_number text not null unique,
  from_location text not null default 'tan_tao',
  to_location text not null default 'q7',
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  quantity numeric(15, 3) not null,
  unit text not null,
  transfer_date date not null,
  source text not null default 'auto_goods_receipt',
  goods_receipt_item_id uuid unique,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint stock_transfers_number_check check (transfer_number ~ '^CK-[0-9]{8}-[A-Z0-9]{6}$'),
  constraint stock_transfers_from_location_check check (from_location = 'tan_tao'),
  constraint stock_transfers_to_location_check check (to_location = 'q7'),
  constraint stock_transfers_quantity_check check (
    quantity > 0 and quantity::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

create index if not exists idx_stock_transfers_created_at
  on public.stock_transfers(created_at desc, id desc);
create index if not exists idx_stock_transfers_item_date
  on public.stock_transfers(kitchen_inventory_item_id, transfer_date, created_at, id);

alter table public.stock_transfers enable row level security;

drop policy if exists stock_transfers_select on public.stock_transfers;
create policy stock_transfers_select on public.stock_transfers
  for select to authenticated
  using (
    public.q7_material_inventory_can_view((select auth.uid()))
    or public.can_view_tan_tao_warehouse()
  );

revoke all on table public.stock_transfers from public, anon, authenticated;
grant select on table public.stock_transfers to authenticated, service_role;
grant insert on table public.stock_transfers to service_role;

create or replace function public.stock_transfers_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'stock_transfers are append-only';
end;
$$;

drop trigger if exists stock_transfers_append_only on public.stock_transfers;
create trigger stock_transfers_append_only
  before update or delete on public.stock_transfers
  for each row execute function public.stock_transfers_append_only();

create table if not exists public.stock_location_moves (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid not null,
  from_location text not null,
  to_location text not null,
  reason text not null default 'central_warehouse_2026_10_12',
  moved_at timestamptz not null default now()
);

create index if not exists idx_stock_location_moves_receipt
  on public.stock_location_moves(goods_receipt_id, moved_at desc, id desc);

alter table public.stock_location_moves enable row level security;

drop policy if exists stock_location_moves_select on public.stock_location_moves;
create policy stock_location_moves_select on public.stock_location_moves
  for select to authenticated
  using (
    public.material_alias_can_admin((select auth.uid()))
    or public.can_view_tan_tao_warehouse()
  );

revoke all on table public.stock_location_moves from public, anon, authenticated;
grant select on table public.stock_location_moves to authenticated, service_role;
grant insert on table public.stock_location_moves to service_role;

create or replace function public.stock_location_moves_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'stock_location_moves are append-only';
end;
$$;

drop trigger if exists stock_location_moves_append_only on public.stock_location_moves;
create trigger stock_location_moves_append_only
  before update or delete on public.stock_location_moves
  for each row execute function public.stock_location_moves_append_only();

-- ===========================================================================
-- 3. Movement types: transfer_in (Q7) and transfer_out (Tân Tạo)
-- ===========================================================================

alter table public.q7_inventory_movements
  drop constraint if exists q7_inventory_movements_movement_type_check;
alter table public.q7_inventory_movements
  add constraint q7_inventory_movements_movement_type_check
  check (movement_type in ('receipt', 'production_usage', 'adjustment', 'transfer_in'));

alter table public.q7_inventory_movements
  drop constraint if exists q7_inventory_movements_quantity_check;
alter table public.q7_inventory_movements
  add constraint q7_inventory_movements_quantity_check
  check (
    (movement_type in ('receipt', 'production_usage', 'transfer_in') and quantity > 0)
    or (movement_type = 'adjustment' and quantity <> 0)
  );

alter table public.q7_inventory_movements
  drop constraint if exists q7_inventory_movements_source_check;
alter table public.q7_inventory_movements
  add constraint q7_inventory_movements_source_check
  check (source in (
    'manual_receipt', 'signed_q7_issue', 'manual_adjustment',
    'goods_receipt', 'production_material_issue', 'production_material_issue_reversal',
    'item_merge', 'item_merge_revert', 'stock_transfer'
  ));

alter table public.tan_tao_material_movements
  drop constraint if exists tan_tao_material_movements_movement_type_check;
alter table public.tan_tao_material_movements
  add constraint tan_tao_material_movements_movement_type_check
  check (movement_type in ('receipt', 'production_usage', 'adjustment', 'opening', 'transfer_out'));

alter table public.tan_tao_material_movements
  drop constraint if exists tan_tao_material_movements_quantity_check;
alter table public.tan_tao_material_movements
  add constraint tan_tao_material_movements_quantity_check
  check (
    (movement_type in ('receipt', 'production_usage', 'opening', 'transfer_out') and quantity > 0)
    or (movement_type = 'adjustment' and quantity <> 0)
  );

alter table public.tan_tao_material_movements
  drop constraint if exists tan_tao_material_movements_source_check;
alter table public.tan_tao_material_movements
  add constraint tan_tao_material_movements_source_check
  check (source in (
    'goods_receipt', 'manual_adjustment', 'item_merge', 'item_merge_revert', 'stock_transfer'
  ));

-- ===========================================================================
-- 4. Q7 pastry-only guard
-- ===========================================================================

create or replace function public.q7_inventory_movements_pastry_only_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pastry boolean;
begin
  if new.movement_type in ('receipt', 'transfer_in', 'opening') then
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
-- 5. Receiving always lands at Tân Tạo
-- ===========================================================================

create or replace function public.goods_receipts_central_receiving_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.receiving_location = 'q7' then
    new.receiving_location := 'tan_tao';
  end if;
  return new;
end;
$$;

drop trigger if exists goods_receipts_central_receiving_guard on public.goods_receipts;
create trigger goods_receipts_central_receiving_guard
  before insert or update of receiving_location on public.goods_receipts
  for each row execute function public.goods_receipts_central_receiving_guard();
create or replace function public.get_q7_inventory_snapshot(p_as_of_date date default null)
returns table (
  kitchen_inventory_item_id uuid,
  item_name text,
  unit text,
  opening_qty numeric,
  receipt_qty numeric,
  usage_qty numeric,
  adjustment_qty numeric,
  balance_qty numeric,
  is_negative boolean,
  opening_audited boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_as_of_date date := coalesce(p_as_of_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor_id) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  end if;

  return query
  with mapped_items as (
    select distinct on (m.kitchen_inventory_item_id)
      m.kitchen_inventory_item_id,
      kii.name as item_name,
      kii.unit
    from public.q7_material_issue_material_mappings m
    join public.kitchen_inventory_items kii
      on kii.id = m.kitchen_inventory_item_id
     and kii.active = true
    where m.approval_status = 'approved'
    order by m.kitchen_inventory_item_id, kii.name
  ), latest_opening as (
    select distinct on (o.kitchen_inventory_item_id)
      o.kitchen_inventory_item_id,
      o.effective_date,
      o.opening_qty,
      (o.opening_qty is not null and o.audit_actor is not null) as opening_audited
    from public.q7_inventory_openings o
    where o.effective_date <= v_as_of_date
    order by o.kitchen_inventory_item_id, o.effective_date desc, o.updated_at desc, o.id desc
  ), movement_totals as (
    select
      m.kitchen_inventory_item_id,
      coalesce(sum(m.quantity) filter (where m.movement_type in ('receipt', 'transfer_in')), 0)::numeric(15, 3) as receipt_qty,
      coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0)::numeric(15, 3) as usage_qty,
      coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0)::numeric(15, 3) as adjustment_qty
    from public.q7_inventory_movements m
    left join latest_opening o on o.kitchen_inventory_item_id = m.kitchen_inventory_item_id
    where m.movement_date <= v_as_of_date
      and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
    group by m.kitchen_inventory_item_id
  )
  select
    mi.kitchen_inventory_item_id,
    mi.item_name,
    mi.unit,
    o.opening_qty,
    coalesce(mt.receipt_qty, 0)::numeric(15, 3) as receipt_qty,
    coalesce(mt.usage_qty, 0)::numeric(15, 3) as usage_qty,
    coalesce(mt.adjustment_qty, 0)::numeric(15, 3) as adjustment_qty,
    (coalesce(o.opening_qty, 0) + coalesce(mt.receipt_qty, 0) - coalesce(mt.usage_qty, 0) + coalesce(mt.adjustment_qty, 0))::numeric(15, 3) as balance_qty,
    ((coalesce(o.opening_qty, 0) + coalesce(mt.receipt_qty, 0) - coalesce(mt.usage_qty, 0) + coalesce(mt.adjustment_qty, 0)) < 0) as is_negative,
    coalesce(o.opening_audited, false) as opening_audited
  from mapped_items mi
  left join latest_opening o on o.kitchen_inventory_item_id = mi.kitchen_inventory_item_id
  left join movement_totals mt on mt.kitchen_inventory_item_id = mi.kitchen_inventory_item_id
  order by mi.item_name, mi.kitchen_inventory_item_id;
end;
$$;
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
             'is_low_stock', (x.out_qty_7d > 0 and x.balance_qty < (x.out_qty_7d / 7.0) * 3)
           ) order by x.item_name), '[]'::jsonb)
    into v_items
    from (
      select s.kitchen_inventory_item_id as item_id,
             kii.item_code,
             s.item_name,
             s.unit,
             s.balance_qty,
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
             'is_low_stock', (x.out_qty_7d > 0 and x.balance_qty < (x.out_qty_7d / 7.0) * 3)
           ) order by x.item_name), '[]'::jsonb)
    into v_materials
    from (
      select kii.id as item_id,
             kii.item_code,
             kii.name as item_name,
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
             ) as last_count_difference
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
      select gri.id as goods_receipt_item_id,
             gr.receipt_number,
             sup.name as supplier_name,
             gri.product_name,
             ra.normalized_name,
             greatest(0, coalesce(gri.actual_quantity, gri.quantity, 0))::numeric as quantity,
             gr.receipt_date
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      left join public.suppliers sup on sup.id = gr.supplier_id
      left join lateral (
        select
          public.normalize_stock_item_name(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) as normalized_name,
          a.id as alias_id,
          a.line_class as line_class
        from public.resolve_stock_material_alias(
               gr.supplier_id,
               public.normalize_stock_item_name(
                 coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
               ),
               p_location
             ) a
      ) ra on true
      where gr.receiving_location = p_location
        and gr.status in ('confirmed', 'received')
        and gr.receipt_date >= v_cutover
        and coalesce(sup.stock_exempt, false) = false
        and ra.alias_id is null
        and coalesce(ra.line_class, 'stock') <> 'non_stock'
        and public.stock_line_auto_non_stock(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            ) is null
        and not public.stock_goods_receipt_item_is_posted(gri.id)
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
        and kii.pastry_q7 = true
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
create or replace function public.record_tan_tao_material_count(
  p_kitchen_inventory_item_id uuid,
  p_counted_qty numeric,
  p_count_date date,
  p_note text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_count_date date := coalesce(p_count_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_book numeric := 0;
  v_diff numeric := 0;
  v_source_key text;
  v_inserted integer := 0;
begin
  if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not public.can_manage_tan_tao_warehouse() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_counted_qty is null or p_counted_qty < 0
     or p_counted_qty::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_counted_qty' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_kitchen_inventory_item_id and active = true
    and merged_into_id is null;
  if not found then raise exception 'tan_tao_item_not_found' using errcode = 'P0002'; end if;

  update public.stock_ledger_settings
  set tan_tao_cutover_date = coalesce(tan_tao_cutover_date, v_count_date),
      updated_at = now()
  where id = 1 and tan_tao_cutover_date is null;

  select coalesce(sum(case m.movement_type
                        when 'receipt' then m.quantity
                        when 'opening' then m.quantity
                        when 'production_usage' then -m.quantity
                        when 'adjustment' then m.quantity
                        when 'transfer_out' then -m.quantity
                        else 0 end), 0)
    into v_book
  from public.tan_tao_material_movements m
  where m.kitchen_inventory_item_id = v_item.id
    and m.movement_date <= v_count_date;
  v_diff := p_counted_qty - v_book;

  if v_diff <> 0 then
    v_source_key := 'tt-material-count:' || btrim(p_idempotency_key);
    insert into public.tan_tao_material_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      v_item.id, v_count_date, 'adjustment', v_diff, v_item.unit,
      'manual_adjustment', v_source_key,
      coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Kiểm kê NVL Tân Tạo'),
      v_actor
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
    get diagnostics v_inserted = row_count;
  end if;

  return jsonb_build_object(
    'status', 'recorded',
    'location', 'tan_tao',
    'kitchen_inventory_item_id', v_item.id,
    'count_date', v_count_date,
    'system_qty', v_book,
    'counted_qty', p_counted_qty,
    'difference_qty', v_diff,
    'idempotency_key', btrim(p_idempotency_key),
    'adjustment_written', v_inserted > 0
  );
end;
$$;
create or replace function public.apply_stock_item_merge(
  p_source uuid,
  p_target uuid,
  p_factor numeric,
  p_suggestion uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_source public.kitchen_inventory_items%rowtype;
  v_target public.kitchen_inventory_items%rowtype;
  v_target_unit text;
  v_merge_id uuid;
  v_rows integer := 0;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_source_balance numeric;
  v_tt_balance numeric;
  v_old jsonb;
  v_new jsonb;
  v_existing_setting public.q7_purchase_item_settings%rowtype;
  r record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_source is null or p_target is null then
    raise exception 'merge_source_and_target_required' using errcode = '22023';
  end if;
  if p_source = p_target then
    raise exception 'merge_source_equals_target' using errcode = '22023';
  end if;
  if p_factor is null or p_factor <= 0 or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'merge_factor_invalid' using errcode = '22023';
  end if;

  select * into v_source from public.kitchen_inventory_items where id = p_source for update;
  if not found then raise exception 'merge_source_not_found' using errcode = 'P0002'; end if;
  select * into v_target from public.kitchen_inventory_items where id = p_target for update;
  if not found then raise exception 'merge_target_not_found' using errcode = 'P0002'; end if;

  if v_source.active is not true then
    raise exception 'merge_source_inactive: item % is already inactive or merged', p_source using errcode = '23514';
  end if;
  if v_target.active is not true then
    raise exception 'merge_target_inactive: target item % is inactive', p_target using errcode = '23514';
  end if;
  if v_source.item_type is distinct from v_target.item_type then
    raise exception 'merge_item_type_mismatch: % vs %', v_source.item_type, v_target.item_type using errcode = '23514';
  end if;
  if v_target.merged_into_id is not null then
    raise exception 'merge_target_already_merged: target % is already merged into another item', p_target using errcode = '23514';
  end if;
  if exists (
    select 1 from public.stock_item_merges sm
    where sm.target_id = p_source and sm.status = 'applied'
  ) then
    raise exception 'merge_source_was_target: item % received an active merge and cannot become a source', p_source using errcode = '23514';
  end if;

  v_target_unit := v_target.unit;

  insert into public.stock_item_merges(source_id, target_id, factor, status, applied_by, applied_at, suggestion_id)
  values (p_source, p_target, p_factor, 'applied', v_actor_id, now(), p_suggestion)
  returning id into v_merge_id;

  select s.balance_qty
    into v_source_balance
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id = p_source;
  v_source_balance := coalesce(v_source_balance, 0);

  if v_source_balance <> 0 then
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_source, v_today, 'adjustment', -v_source_balance, v_source.unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':out',
      'Bút toán chuyển tồn khi gộp mặt hàng ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_target, v_today, 'adjustment', v_source_balance * p_factor, v_target_unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':in',
      'Bút toán nhận tồn khi gộp mặt hàng ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
  end if;

  -- Tân Tạo NVL ledger: the same append-only transfer pair for shared raw items.
  select coalesce(sum(case m.movement_type
                        when 'receipt' then m.quantity
                        when 'opening' then m.quantity
                        when 'production_usage' then -m.quantity
                        when 'adjustment' then m.quantity
                        when 'transfer_out' then -m.quantity
                        else 0 end), 0)
    into v_tt_balance
  from public.tan_tao_material_movements m
  where m.kitchen_inventory_item_id = p_source;

  if v_tt_balance <> 0 then
    insert into public.tan_tao_material_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_source, v_today, 'adjustment', -v_tt_balance, v_source.unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':tt:out',
      'Bút toán chuyển tồn sổ NVL Tân Tạo khi gộp ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

    insert into public.tan_tao_material_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_target, v_today, 'adjustment', v_tt_balance * p_factor, v_target_unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':tt:in',
      'Bút toán nhận tồn sổ NVL Tân Tạo khi gộp ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
  end if;

  for r in select * from public.production_material_issue_items where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    update public.production_material_issue_items as t
      set kitchen_inventory_item_id = p_target,
          required_qty = r.required_qty * p_factor,
          unit = v_target_unit,
          conversion_factor = case
            when r.conversion_factor is null then null
            else r.conversion_factor * p_factor
          end,
          updated_at = now()
      where t.id = r.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'production_material_issue_items', r.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  for r in select * from public.q7_material_issue_material_mappings where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    update public.q7_material_issue_material_mappings as t
      set kitchen_inventory_item_id = p_target,
          conversion_factor = r.conversion_factor * p_factor,
          kitchen_unit = v_target_unit,
          updated_at = now()
      where t.id = r.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'q7_material_issue_material_mappings', r.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  for r in select * from public.stock_material_aliases where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    update public.stock_material_aliases as t
      set kitchen_inventory_item_id = p_target,
          conversion_factor = r.conversion_factor * p_factor,
          unit = v_target_unit,
          updated_at = now()
      where t.id = r.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'stock_material_aliases', r.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  for r in select * from public.q7_purchase_item_settings where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    select * into v_existing_setting
    from public.q7_purchase_item_settings
    where kitchen_inventory_item_id = p_target
    for update;
    if found then
      delete from public.q7_purchase_item_settings where id = r.id;
      insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
      values (v_merge_id, 'q7_purchase_item_settings', r.id, v_old, null);
    else
      update public.q7_purchase_item_settings as t
        set kitchen_inventory_item_id = p_target,
            updated_at = now()
        where t.id = r.id
        returning to_jsonb(t.*) into v_new;
      insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
      values (v_merge_id, 'q7_purchase_item_settings', r.id, v_old, v_new);
    end if;
    v_rows := v_rows + 1;
  end loop;

  update public.kitchen_inventory_items
    set active = false,
        merged_into_id = p_target,
        merged_factor = p_factor,
        merged_at = now()
    where id = p_source;

  if p_suggestion is not null then
    update public.stock_catalog_suggestions
      set status = 'applied',
          decided_by = coalesce(decided_by, v_actor_id),
          decided_at = coalesce(decided_at, now())
      where id = p_suggestion and status in ('pending', 'approved');
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'merge_id', v_merge_id,
    'source_id', p_source,
    'target_id', p_target,
    'factor', p_factor,
    'rows_logged', v_rows
  );
end;
$$;
create or replace function public.revert_stock_item_merge(p_merge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_merge public.stock_item_merges%rowtype;
  v_columns text;
  v_rows integer := 0;
  v_movements integer := 0;
  v_tt_movements integer := 0;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_delta numeric;
  r record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_merge from public.stock_item_merges where id = p_merge_id for update;
  if not found then raise exception 'merge_not_found' using errcode = 'P0002'; end if;
  if v_merge.status = 'reverted' then
    return jsonb_build_object('status', 'already_reverted', 'merge_id', p_merge_id);
  end if;
  if v_merge.status <> 'applied' then
    raise exception 'merge_not_applied' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.stock_item_merges m
    where m.status = 'applied'
      and m.id <> p_merge_id
      and (m.target_id = v_merge.target_id or m.source_id = v_merge.target_id)
      and (m.applied_at, m.id) > (v_merge.applied_at, v_merge.id)
  ) then
    raise exception 'revert_blocked_by_newer_merge: target % has a newer active merge', v_merge.target_id
      using errcode = '23514';
  end if;

  for r in select * from public.stock_item_merge_rows where merge_id = p_merge_id order by created_at, id loop
    if r.table_name not in (
      'production_material_issue_items',
      'q7_material_issue_material_mappings',
      'stock_material_aliases',
      'q7_purchase_item_settings'
    ) then
      raise exception 'merge_revert_unsupported_table: %', r.table_name using errcode = '23514';
    end if;
    if r.new_values is null then
      execute format(
        'insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)',
        r.table_name, r.table_name
      ) using r.old_values;
    else
      select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
        into v_columns
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = r.table_name
        and a.attnum > 0
        and a.attisdropped = false
        and a.attgenerated = '';
      execute format(
        'update public.%I t set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1) x) where t.id = $2',
        r.table_name, v_columns, v_columns, r.table_name
      ) using r.old_values, r.row_id;
    end if;
    v_rows := v_rows + 1;
  end loop;

  for r in
    select m.id, m.kitchen_inventory_item_id, m.movement_type, m.quantity, m.unit
    from public.q7_inventory_movements m
    where m.source_ref_key like 'item-merge:' || p_merge_id::text || ':%'
    order by m.created_at, m.id
  loop
    v_delta := case r.movement_type
      when 'receipt' then r.quantity
      when 'adjustment' then r.quantity
      when 'production_usage' then -r.quantity
      when 'transfer_in' then r.quantity
      else 0
    end;
    if v_delta <> 0 then
      insert into public.q7_inventory_movements(
        kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
        source, source_ref_key, note, created_by
      ) values (
        r.kitchen_inventory_item_id, v_today, 'adjustment', -v_delta, r.unit,
        'item_merge_revert',
        'item-merge-revert:' || p_merge_id::text || ':' || r.id::text,
        'Bút toán hoàn tác gộp mặt hàng: đảo dòng ' || r.id::text,
        v_actor_id
      )
      on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
      v_movements := v_movements + 1;
    end if;
  end loop;

  -- Reverse the Tân Tạo NVL transfer pair and every forwarded row.
  for r in
    select m.id, m.kitchen_inventory_item_id, m.movement_type, m.quantity, m.unit
    from public.tan_tao_material_movements m
    where m.source_ref_key like 'item-merge:' || p_merge_id::text || ':%'
    order by m.created_at, m.id
  loop
    v_delta := case r.movement_type
      when 'receipt' then r.quantity
      when 'opening' then r.quantity
      when 'adjustment' then r.quantity
      when 'production_usage' then -r.quantity
      when 'transfer_out' then -r.quantity
      else 0
    end;
    if v_delta <> 0 then
      insert into public.tan_tao_material_movements(
        kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
        source, source_ref_key, note, created_by
      ) values (
        r.kitchen_inventory_item_id, v_today, 'adjustment', -v_delta, r.unit,
        'item_merge_revert',
        'item-merge-revert:' || p_merge_id::text || ':tt:' || r.id::text,
        'Bút toán hoàn tác gộp sổ NVL Tân Tạo: đảo dòng ' || r.id::text,
        v_actor_id
      )
      on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
      v_tt_movements := v_tt_movements + 1;
    end if;
  end loop;

  update public.kitchen_inventory_items
    set active = true,
        merged_into_id = null,
        merged_factor = null,
        merged_at = null
    where id = v_merge.source_id;

  update public.stock_item_merges
    set status = 'reverted', reverted_by = v_actor_id, reverted_at = now()
    where id = p_merge_id;

  if v_merge.suggestion_id is not null then
    update public.stock_catalog_suggestions
      set status = 'reverted',
          decided_by = coalesce(decided_by, v_actor_id),
          decided_at = coalesce(decided_at, now())
      where id = v_merge.suggestion_id and status = 'applied';
  end if;

  return jsonb_build_object(
    'status', 'reverted',
    'merge_id', p_merge_id,
    'source_id', v_merge.source_id,
    'target_id', v_merge.target_id,
    'rows_restored', v_rows,
    'movements_reversed', v_movements,
    'tan_tao_movements_reversed', v_tt_movements
  );
end;
$$;
create or replace function public.stock_item_merge_forward()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_id uuid;
  v_factor numeric;
  v_merge_id uuid;
  v_target_unit text;
  v_delta numeric;
begin
  if new.source in ('item_merge', 'item_merge_revert') then
    return new;
  end if;
  if new.kitchen_inventory_item_id is null then
    return new;
  end if;

  select r.target_id, r.factor
    into v_target_id, v_factor
  from public.stock_item_merge_resolve(new.kitchen_inventory_item_id) r;

  if v_target_id is null or v_target_id = new.kitchen_inventory_item_id then
    return new;
  end if;

  select sm.id
    into v_merge_id
  from public.stock_item_merges sm
  where sm.source_id = new.kitchen_inventory_item_id
    and sm.status = 'applied'
  order by sm.applied_at desc, sm.id desc
  limit 1;
  if v_merge_id is null then
    return new;
  end if;

  select kii.unit
    into v_target_unit
  from public.kitchen_inventory_items kii
  where kii.id = v_target_id;
  if v_target_unit is null then
    return new;
  end if;

  -- get_q7_inventory_snapshot adds receipt/adjustment quantity and subtracts
  -- production usage, so mirror that sign before writing the offsetting pair.
  v_delta := case new.movement_type
    when 'receipt' then new.quantity
    when 'adjustment' then new.quantity
    when 'production_usage' then -new.quantity
    when 'transfer_in' then new.quantity
    else 0
  end;
  if v_delta = 0 then
    return new;
  end if;

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_key, note, created_by
  ) values (
    new.kitchen_inventory_item_id, new.movement_date, 'adjustment', -v_delta, new.unit,
    'item_merge',
    'item-merge:' || v_merge_id::text || ':fwd:' || new.id::text || ':out',
    'Bút toán chuyển tiếp khi mặt hàng đã gộp: bù trừ dòng gốc ' || new.id::text,
    new.created_by
  )
  on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_key, note, created_by
  ) values (
    v_target_id, new.movement_date, 'adjustment', v_delta * v_factor, v_target_unit,
    'item_merge',
    'item-merge:' || v_merge_id::text || ':fwd:' || new.id::text || ':in',
    'Bút toán chuyển tiếp khi mặt hàng đã gộp: nhận từ dòng gốc ' || new.id::text,
    new.created_by
  )
  on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

  return new;
end;
$$;
create or replace function public.tan_tao_material_merge_forward()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_id uuid;
  v_factor numeric;
  v_merge_id uuid;
  v_target_unit text;
  v_delta numeric;
begin
  if new.source in ('item_merge', 'item_merge_revert') then
    return new;
  end if;
  if new.kitchen_inventory_item_id is null then
    return new;
  end if;

  select r.target_id, r.factor
    into v_target_id, v_factor
  from public.stock_item_merge_resolve(new.kitchen_inventory_item_id) r;

  if v_target_id is null or v_target_id = new.kitchen_inventory_item_id then
    return new;
  end if;

  select sm.id
    into v_merge_id
  from public.stock_item_merges sm
  where sm.source_id = new.kitchen_inventory_item_id
    and sm.status = 'applied'
  order by sm.applied_at desc, sm.id desc
  limit 1;
  if v_merge_id is null then
    return new;
  end if;

  select kii.unit into v_target_unit
  from public.kitchen_inventory_items kii
  where kii.id = v_target_id;
  if v_target_unit is null then
    return new;
  end if;

  v_delta := case new.movement_type
    when 'receipt' then new.quantity
    when 'opening' then new.quantity
    when 'adjustment' then new.quantity
    when 'production_usage' then -new.quantity
    when 'transfer_out' then -new.quantity
    else 0
  end;
  if v_delta = 0 then
    return new;
  end if;

  insert into public.tan_tao_material_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_key, note, created_by
  ) values (
    new.kitchen_inventory_item_id, new.movement_date, 'adjustment', -v_delta, new.unit,
    'item_merge',
    'item-merge:' || v_merge_id::text || ':fwd:' || new.id::text || ':tt:out',
    'Bút toán chuyển tiếp sổ NVL Tân Tạo: bù trừ dòng gốc ' || new.id::text,
    new.created_by
  )
  on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

  insert into public.tan_tao_material_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_key, note, created_by
  ) values (
    v_target_id, new.movement_date, 'adjustment', v_delta * v_factor, v_target_unit,
    'item_merge',
    'item-merge:' || v_merge_id::text || ':fwd:' || new.id::text || ':tt:in',
    'Bút toán chuyển tiếp sổ NVL Tân Tạo: nhận từ dòng gốc ' || new.id::text,
    new.created_by
  )
  on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

  return new;
end;
$$;
create or replace function public.mission_evaluate(p_mission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mission public.missions%rowtype;
  v_done boolean := false;
  v_total integer := 0;
  v_left integer := 0;
  v_detail jsonb := '[]'::jsonb;
  v_alias_id uuid;
  v_bad_factor numeric;
  v_bad_item uuid;
  v_alias public.stock_material_aliases%rowtype;
  v_alias_found boolean;
  v_item_name text;
  v_item_unit text;
  v_fixed boolean;
  v_rows jsonb;
  v_index integer;
  v_active integer;
  v_name_changed boolean;
  v_pair boolean;
  v_a uuid;
  v_b uuid;
  v_row public.kitchen_inventory_items%rowtype;
  v_days integer;
  v_initial integer;
  v_groups integer;
  v_ignored integer;
begin
  select * into v_mission from public.missions where id = p_mission_id;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if v_mission.check_rule = 'stock_alias_factor_fixed' then
    v_rows := coalesce(v_mission.check_params -> 'aliases', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_alias_id := (v_rows -> v_index ->> 'id')::uuid;
      v_bad_factor := (v_rows -> v_index ->> 'bad_factor')::numeric;
      v_bad_item := (v_rows -> v_index ->> 'bad_item_id')::uuid;

      select * into v_alias from public.stock_material_aliases a where a.id = v_alias_id;
      v_alias_found := found;

      if not v_alias_found then
        v_fixed := true;
        v_item_name := null;
        v_item_unit := null;
      else
        select k.name, k.unit into v_item_name, v_item_unit
        from public.kitchen_inventory_items k
        where k.id = v_alias.kitchen_inventory_item_id;

        v_fixed := (v_alias.conversion_factor is distinct from v_bad_factor)
          or (v_alias.kitchen_inventory_item_id is distinct from v_bad_item);
      end if;

      if not v_fixed then
        v_left := v_left + 1;
      end if;

      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'id', v_alias_id,
        'name', case when v_alias_found then v_alias.normalized_name else null end,
        'unit', case when v_alias_found then v_alias.unit else null end,
        'factor', case when v_alias_found then v_alias.conversion_factor else null end,
        'item_name', v_item_name,
        'item_unit', v_item_unit,
        'fixed', v_fixed
      ));
    end loop;
    v_done := (v_left = 0);

  elsif v_mission.check_rule = 'stock_duplicate_resolved' then
    v_rows := coalesce(v_mission.check_params -> 'items', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    v_active := 0;
    v_name_changed := false;
    v_pair := false;

    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_a := (v_rows -> v_index ->> 'id')::uuid;
      select * into v_row from public.kitchen_inventory_items k where k.id = v_a;
      if not found then
        v_name_changed := true;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_a,
          'code', null,
          'name', null,
          'unit', null,
          'active', false,
          'on_hand', 0,
          'alias_count', 0
        ));
      else
        if coalesce(v_row.active, false) then
          v_active := v_active + 1;
        end if;
        if v_row.name is distinct from (v_rows -> v_index ->> 'name') then
          v_name_changed := true;
        end if;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_row.id,
          'code', v_row.item_code,
          'name', v_row.name,
          'unit', v_row.unit,
          'active', coalesce(v_row.active, false),
          'on_hand', coalesce((
            select sum(case m.movement_type
                         when 'receipt' then m.quantity
                         when 'production_usage' then -m.quantity
                         when 'adjustment' then m.quantity
                         when 'transfer_in' then m.quantity
                         else 0 end)
            from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = v_row.id
          ), 0),
          'alias_count', (
            select count(*)
            from public.stock_material_aliases a
            where a.kitchen_inventory_item_id = v_row.id
          )
        ));
      end if;
    end loop;

    if v_total = 2 then
      v_a := (v_rows -> 0 ->> 'id')::uuid;
      v_b := (v_rows -> 1 ->> 'id')::uuid;
      select exists (
        select 1 from public.stock_item_distinct_pairs p
        where p.item_a = least(v_a, v_b)
          and p.item_b = greatest(v_a, v_b)
      ) into v_pair;
    end if;

    v_done := (v_active < 2) or v_name_changed or v_pair;
    v_left := case when v_done then 0 else 1 end;

  elsif v_mission.check_rule = 'stock_unknown_units_cleared' then
    v_days := coalesce((v_mission.check_params ->> 'days')::integer, 60);
    v_initial := coalesce((v_mission.check_params ->> 'initial')::integer, 0);
    v_total := v_initial;

    select count(distinct lower(btrim(r.unit)))::integer into v_groups
    from public.stock_unknown_purchase_unit_rows(v_days) r;

    select count(*)::integer into v_ignored
    from public.stock_unit_ignored_variants g
    where exists (
      select 1
      from public.stock_unknown_purchase_unit_rows(v_days) r
      where g.variant = lower(btrim(r.unit))
    );

    v_left := greatest(coalesce(v_groups, 0) - coalesce(v_ignored, 0), 0);
    v_done := (v_left = 0);

    select coalesce(jsonb_agg(jsonb_build_object(
             'unit', r.unit,
             'line_count', r.line_count,
             'example_name', r.example_name,
             'source_table', r.source_table
           ) order by r.line_count desc, r.unit asc, r.source_table asc), '[]'::jsonb)
    into v_detail
    from public.stock_unknown_purchase_unit_rows(v_days) r;

  else
    raise exception 'unknown_check_rule' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'done', v_done,
    'total', v_total,
    'left', v_left,
    'detail', v_detail
  );
end;
$$;
create or replace function public.set_goods_receipt_receiving_location(
  p_receipt_id uuid,
  p_location text,
  p_remember_for_supplier boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_supplier_id uuid;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if p_location = 'tan_tao' then
      if not public.can_manage_tan_tao_warehouse() then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    elsif not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  -- Owner rule 2026-10-12: q7 is no longer a receiving warehouse.
  if p_location = 'q7' then
    p_location := 'tan_tao';
  end if;

  update public.goods_receipts
  set receiving_location = p_location
  where id = p_receipt_id
  returning supplier_id into v_supplier_id;
  if not found then raise exception 'goods_receipt_not_found' using errcode = 'P0002'; end if;

  if p_remember_for_supplier and v_supplier_id is not null then
    update public.suppliers
    set default_receiving_location = p_location
    where id = v_supplier_id;
  end if;

  return jsonb_build_object('status', 'updated', 'receipt_id', p_receipt_id, 'receiving_location', p_location);
end;
$$;
create or replace function public.apply_supplier_routing(
  p_supplier_id uuid,
  p_location text,
  p_source text,
  p_suggestion uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_supplier public.suppliers%rowtype;
  v_prev_location text;
  v_prev_exempt boolean;
  v_cutover date;
  v_filled integer := 0;
begin
  if p_location not in ('q7', 'tan_tao', 'non_stock') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if p_source not in ('manual', 'jev', 'rule') then
    raise exception 'unsupported_source' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  -- Owner rule 2026-10-12: q7 is no longer a receiving warehouse.
  if p_location = 'q7' then
    p_location := 'tan_tao';
  end if;

  select * into v_supplier from public.suppliers where id = p_supplier_id for update;
  if not found then raise exception 'supplier_not_found' using errcode = 'P0002'; end if;
  v_prev_location := v_supplier.default_receiving_location;
  v_prev_exempt := v_supplier.stock_exempt;

  if p_suggestion is not null then
    update public.supplier_routing_suggestions s
    set previous_location = coalesce(s.previous_location, v_prev_location),
        previous_exempt = coalesce(s.previous_exempt, v_prev_exempt),
        proposed_location = p_location,
        status = 'applied',
        applied_by = v_actor,
        applied_at = now()
    where s.id = p_suggestion;
  end if;

  if p_location = 'non_stock' then
    update public.suppliers
    set stock_exempt = true,
        default_receiving_location = null,
        receiving_location_source = p_source,
        receiving_location_set_at = now(),
        updated_at = now()
    where id = p_supplier_id;
    return jsonb_build_object(
      'status', 'applied',
      'supplier_id', p_supplier_id,
      'location', 'non_stock',
      'receipts_filled', 0,
      'previous_location', v_prev_location,
      'previous_exempt', v_prev_exempt
    );
  end if;

  update public.suppliers
  set default_receiving_location = p_location,
      stock_exempt = false,
      receiving_location_source = p_source,
      receiving_location_set_at = now(),
      updated_at = now()
  where id = p_supplier_id;

  v_cutover := public.stock_ledger_cutover_date(p_location);

  -- The goods_receipts update trigger then calls post_goods_receipt_to_stock.
  update public.goods_receipts gr
  set receiving_location = p_location
  where gr.supplier_id = p_supplier_id
    and gr.status in ('confirmed', 'received')
    and gr.receiving_location is null
    and (v_cutover is null or gr.receipt_date >= v_cutover);
  get diagnostics v_filled = row_count;

  return jsonb_build_object(
    'status', 'applied',
    'supplier_id', p_supplier_id,
    'location', p_location,
    'receipts_filled', v_filled,
    'previous_location', v_prev_location,
    'previous_exempt', v_prev_exempt
  );
end;
$$;
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
    greatest(0, coalesce(v_item.actual_quantity, v_item.quantity, 0))
    * coalesce(
        case when p_alias.kitchen_inventory_item_id is not null then
          public.stock_unit_line_factor(
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

      -- Owner 2026-10-12: a pastry item received at Tân Tạo moves straight to Q7.
      if v_inserted > 0 then
        select k.pastry_q7 into v_pastry
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

-- ===========================================================================
-- 6. RPCs: pastry flag, transfer list
-- ===========================================================================

alter table public.warehouse_game_requests
  drop constraint if exists warehouse_game_requests_action_check;
alter table public.warehouse_game_requests
  add constraint warehouse_game_requests_action_check
  check (action in ('rename', 'change_unit', 'set_item_pastry_q7'));

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
           'receipt_number', x.receipt_number
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
-- 7. One-off data move to the central warehouse
-- ===========================================================================

do $$
declare
  v_moved integer := 0;
  v_remaining integer := 0;
  v_suppliers integer := 0;
  v_aliases integer := 0;
begin
  -- Move every q7 receipt that never posted to the Q7 ledger. A receipt that
  -- already wrote a q7 'goods_receipt' row stays untouched so no posted stock
  -- is moved twice; it is reported instead.
  with moved as (
    update public.goods_receipts gr
    set receiving_location = 'tan_tao'
    where gr.receiving_location = 'q7'
      and not exists (
        select 1
        from public.goods_receipt_items gri
        join public.q7_inventory_movements m
          on m.source = 'goods_receipt'
         and m.source_ref_key = 'gr-item:' || gri.id::text
        where gri.goods_receipt_id = gr.id
      )
    returning gr.id
  )
  insert into public.stock_location_moves (
    goods_receipt_id, from_location, to_location, reason, moved_at
  )
  select id, 'q7', 'tan_tao', 'central_warehouse_2026_10_12', now()
  from moved;
  get diagnostics v_moved = row_count;

  select count(*) into v_remaining
  from public.goods_receipts gr
  where gr.receiving_location = 'q7';

  update public.suppliers
  set default_receiving_location = 'tan_tao',
      receiving_location_source = 'rule',
      receiving_location_set_at = now(),
      updated_at = now()
  where default_receiving_location = 'q7';
  get diagnostics v_suppliers = row_count;

  -- Keep the q7 alias and add the Tân Tạo twin with the same target / factor.
  insert into public.stock_material_aliases (
    supplier_id, normalized_name, location, kitchen_inventory_item_id, tan_tao_sku_id,
    conversion_factor, unit, created_by, created_at, updated_at,
    confirm_count, confirmers, status, pack_label, last_confirmed_at,
    jev_item_id, jev_probability, jev_disagreed, line_class
  )
  select a.supplier_id, a.normalized_name, 'tan_tao', a.kitchen_inventory_item_id, a.tan_tao_sku_id,
         a.conversion_factor, a.unit, a.created_by, a.created_at, a.updated_at,
         a.confirm_count, a.confirmers, a.status, a.pack_label, a.last_confirmed_at,
         a.jev_item_id, a.jev_probability, a.jev_disagreed, a.line_class
  from public.stock_material_aliases a
  where a.location = 'q7'
  on conflict do nothing;
  get diagnostics v_aliases = row_count;

  raise notice 'central_warehouse_flow: receipts moved=%, q7 receipts left (already posted)=%, suppliers moved=%, alias twins inserted=%',
    v_moved, v_remaining, v_suppliers, v_aliases;
end $$;

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

revoke all on function public.stock_transfers_append_only() from public, anon, authenticated;
revoke all on function public.stock_location_moves_append_only() from public, anon, authenticated;
revoke all on function public.q7_inventory_movements_pastry_only_guard() from public, anon, authenticated;
revoke all on function public.goods_receipts_central_receiving_guard() from public, anon, authenticated;

revoke all on function public.get_q7_inventory_snapshot(date) from public, anon;
grant execute on function public.get_q7_inventory_snapshot(date) to authenticated, service_role;

revoke all on function public.get_stock_ledger_overview(text, date) from public, anon;
grant execute on function public.get_stock_ledger_overview(text, date) to authenticated, service_role;

revoke all on function public.get_warehouse_game_snapshot(text) from public, anon;
grant execute on function public.get_warehouse_game_snapshot(text) to authenticated, service_role;

revoke all on function public.record_tan_tao_material_count(uuid, numeric, date, text, text) from public, anon;
grant execute on function public.record_tan_tao_material_count(uuid, numeric, date, text, text) to authenticated, service_role;

revoke all on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid) from public, anon;
grant execute on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid) to authenticated, service_role;

revoke all on function public.revert_stock_item_merge(uuid) from public, anon;
grant execute on function public.revert_stock_item_merge(uuid) to authenticated, service_role;

revoke all on function public.stock_item_merge_forward() from public, anon, authenticated;
revoke all on function public.tan_tao_material_merge_forward() from public, anon, authenticated;

revoke all on function public.mission_evaluate(uuid) from public, anon, authenticated;
grant execute on function public.mission_evaluate(uuid) to service_role;

revoke all on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) from public, anon, authenticated;
grant execute on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) to service_role;

revoke all on function public.set_goods_receipt_receiving_location(uuid, text, boolean) from public, anon;
grant execute on function public.set_goods_receipt_receiving_location(uuid, text, boolean) to authenticated, service_role;

revoke all on function public.apply_supplier_routing(uuid, text, text, uuid) from public, anon;
grant execute on function public.apply_supplier_routing(uuid, text, text, uuid) to authenticated, service_role;

revoke all on function public.set_item_pastry_q7(uuid, boolean, uuid) from public, anon;
grant execute on function public.set_item_pastry_q7(uuid, boolean, uuid) to authenticated, service_role;

revoke all on function public.get_stock_transfers(integer) from public, anon;
grant execute on function public.get_stock_transfers(integer) to authenticated, service_role;

do $smoke$
declare
  v_owner uuid;
  v_emp uuid;
  v_seeded integer;
  v_bad integer;
  v_q7_left integer;
  v_no_twin integer;
  v_coerced text;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_supplier uuid;
  v_receipt uuid;
  v_line_pastry uuid;
  v_line_plain uuid;
  v_item_pastry uuid;
  v_item_plain uuid;
  v_item_p2 uuid;
  v_item_t2 uuid;
  v_mat uuid;
  v_mat2 uuid;
  v_qty numeric := 7;
  v_tt_before numeric;
  v_tt_after numeric;
  v_q7_before numeric;
  v_q7_after numeric;
  v_transfers integer;
  v_transfers_plain integer;
  v_snap jsonb;
  v_overview jsonb;
  v_result jsonb;
  v_merge jsonb;
  v_merge_id uuid;
  v_probe integer;
  v_count integer;
  v_movements integer;
begin
  -- Real owner and, when available, a real non-admin user.
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;

  select ur.user_id into v_emp
  from public.user_roles ur
  where not public.material_alias_can_admin(ur.user_id)
  order by ur.created_at, ur.user_id
  limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  ------------------------------------------------------------------
  -- (1) seed exists and never lands on a meat-filling material
  ------------------------------------------------------------------
  select count(*) into v_seeded
  from public.kitchen_inventory_items k
  where k.pastry_q7 = true and k.pastry_q7_source = 'rule';
  if v_seeded <= 0 then
    raise exception 'SMOKE_RESULT FAIL seed_count';
  end if;

  select count(*) into v_bad
  from public.kitchen_inventory_items k
  join public.sku_cogs_materials scm on scm.id = k.canonical_material_id
  where k.pastry_q7 = true and k.pastry_q7_source = 'rule'
    and scm.category = 'meat_filling';
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL seeded_meat_filling %', v_bad;
  end if;

  ------------------------------------------------------------------
  -- (2) no q7 receipt left unless it already posted to the Q7 ledger
  ------------------------------------------------------------------
  select count(*) into v_q7_left
  from public.goods_receipts gr
  where gr.receiving_location = 'q7'
    and not exists (
      select 1
      from public.goods_receipt_items gri
      join public.q7_inventory_movements m
        on m.source = 'goods_receipt'
       and m.source_ref_key = 'gr-item:' || gri.id::text
      where gri.goods_receipt_id = gr.id
    );
  if v_q7_left <> 0 then
    raise exception 'SMOKE_RESULT FAIL q7_receipts_left %', v_q7_left;
  end if;

  ------------------------------------------------------------------
  -- (3) every q7 alias has a tan_tao twin
  ------------------------------------------------------------------
  select count(*) into v_no_twin
  from public.stock_material_aliases a
  where a.location = 'q7'
    and not exists (
      select 1 from public.stock_material_aliases b
      where b.location = 'tan_tao'
        and b.supplier_id is not distinct from a.supplier_id
        and b.normalized_name = a.normalized_name
    );
  if v_no_twin <> 0 then
    raise exception 'SMOKE_RESULT FAIL alias_twin_missing %', v_no_twin;
  end if;

  ------------------------------------------------------------------
  -- Temporary cutover for both ledgers (rolls back with the transaction)
  ------------------------------------------------------------------
  update public.stock_ledger_settings
  set q7_cutover_date = current_date - 120,
      tan_tao_cutover_date = current_date - 120,
      updated_at = now()
  where id = 1;
  if public.stock_ledger_cutover_date('q7') is null
     or public.stock_ledger_cutover_date('tan_tao') is null then
    raise exception 'SMOKE_RESULT FAIL cutover_not_set';
  end if;

  ------------------------------------------------------------------
  -- Temporary supplier / receipt / two lines
  ------------------------------------------------------------------
  insert into public.suppliers (name)
  values ('SMOKE central ' || v_suffix)
  returning id into v_supplier;

  -- A fresh insert asking for q7 must be stored as tan_tao.
  insert into public.goods_receipts
    (receipt_number, receipt_date, supplier_id, status, payable_status, receiving_location)
  values ('SMOKE-CEN-' || v_suffix, current_date, v_supplier, 'confirmed', 'not_generated', 'q7')
  returning id into v_receipt;

  select gr.receiving_location into v_coerced
  from public.goods_receipts gr where gr.id = v_receipt;
  if v_coerced is distinct from 'tan_tao' then
    raise exception 'SMOKE_RESULT FAIL receiving_coercion %', v_coerced;
  end if;

  insert into public.sku_cogs_materials
    (material_code, canonical_name, normalized_name, default_unit, category)
  values ('SMOKE-CEN-MAT-' || v_suffix, 'Bột smoke central ' || v_suffix,
          public.normalize_stock_item_name('Bột smoke central ' || v_suffix), 'g', 'flour')
  returning id into v_mat;

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit, standard_unit_cost, active, canonical_material_id)
  values ('SMOKE-CEN-P-' || v_suffix, 'smoke-cen-p-' || v_suffix, 'ingredient',
          'Bột smoke pastry ' || v_suffix, 'g', 0, true, v_mat)
  returning id into v_item_pastry;

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit, standard_unit_cost, active)
  values ('SMOKE-CEN-N-' || v_suffix, 'smoke-cen-n-' || v_suffix, 'ingredient',
          'Bột smoke plain ' || v_suffix, 'g', 0, true)
  returning id into v_item_plain;

  -- An approved Q7 mapping makes get_q7_inventory_snapshot list the pastry item.
  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit,
     conversion_factor, approval_status, approved_by, approved_at)
  values (v_mat, 'g', v_item_pastry, 'g', 1, 'approved', v_owner, now());

  -- Flag the pastry item through the real RPC.
  v_result := public.set_item_pastry_q7(v_item_pastry, true, gen_random_uuid());
  if (v_result ->> 'pastry_q7')::boolean is not true then
    raise exception 'SMOKE_RESULT FAIL set_pastry result=%', v_result;
  end if;
  if not exists (
    select 1 from public.kitchen_inventory_items k
    where k.id = v_item_pastry and k.pastry_q7 = true and k.pastry_q7_source = 'owner'
  ) then
    raise exception 'SMOKE_RESULT FAIL set_pastry_store';
  end if;

  insert into public.stock_material_aliases
    (supplier_id, normalized_name, location, kitchen_inventory_item_id, conversion_factor, unit,
     created_by, line_class, status, confirm_count)
  values
    (v_supplier, public.normalize_stock_item_name('Bột smoke pastry ' || v_suffix), 'tan_tao',
     v_item_pastry, 1, 'g', v_owner, 'stock', 'auto', 3),
    (v_supplier, public.normalize_stock_item_name('Bột smoke plain ' || v_suffix), 'tan_tao',
     v_item_plain, 1, 'g', v_owner, 'stock', 'auto', 3);

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt, 'Bột smoke pastry ' || v_suffix, 'Bột smoke pastry ' || v_suffix, v_qty, v_qty, 'g')
  returning id into v_line_pastry;
  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt, 'Bột smoke plain ' || v_suffix, 'Bột smoke plain ' || v_suffix, v_qty, v_qty, 'g')
  returning id into v_line_plain;

  -- Balances before posting.
  v_tt_before := coalesce((
    select sum(case m.movement_type
                 when 'receipt' then m.quantity
                 when 'opening' then m.quantity
                 when 'production_usage' then -m.quantity
                 when 'adjustment' then m.quantity
                 when 'transfer_out' then -m.quantity
                 else 0 end)
    from public.tan_tao_material_movements m
    where m.kitchen_inventory_item_id = v_item_pastry
  ), 0);
  select s.balance_qty into v_q7_before
  from public.get_q7_inventory_snapshot(current_date) s
  where s.kitchen_inventory_item_id = v_item_pastry;
  v_q7_before := coalesce(v_q7_before, 0);

  ------------------------------------------------------------------
  -- Post through the real posting path
  ------------------------------------------------------------------
  v_result := public.post_goods_receipt_to_stock(v_receipt);
  if (v_result ->> 'status') is distinct from 'posted' then
    raise exception 'SMOKE_RESULT FAIL post_status %', v_result;
  end if;

  select count(*) into v_transfers
  from public.stock_transfers where goods_receipt_item_id = v_line_pastry;
  if v_transfers <> 1 then
    raise exception 'SMOKE_RESULT FAIL transfer_count %', v_transfers;
  end if;

  select count(*) into v_transfers_plain
  from public.stock_transfers where goods_receipt_item_id = v_line_plain;
  if v_transfers_plain <> 0 then
    raise exception 'SMOKE_RESULT FAIL plain_transfer %', v_transfers_plain;
  end if;

  select count(*) into v_movements
  from public.tan_tao_material_movements m
  where m.kitchen_inventory_item_id = v_item_pastry
    and m.movement_type = 'transfer_out' and m.quantity = v_qty;
  if v_movements <> 1 then
    raise exception 'SMOKE_RESULT FAIL transfer_out_count %', v_movements;
  end if;

  select count(*) into v_movements
  from public.q7_inventory_movements m
  where m.kitchen_inventory_item_id = v_item_pastry
    and m.movement_type = 'transfer_in' and m.quantity = v_qty;
  if v_movements <> 1 then
    raise exception 'SMOKE_RESULT FAIL transfer_in_count %', v_movements;
  end if;

  -- Tân Tạo balance returns to its prior value; Q7 rises by the quantity.
  v_tt_after := coalesce((
    select sum(case m.movement_type
                 when 'receipt' then m.quantity
                 when 'opening' then m.quantity
                 when 'production_usage' then -m.quantity
                 when 'adjustment' then m.quantity
                 when 'transfer_out' then -m.quantity
                 else 0 end)
    from public.tan_tao_material_movements m
    where m.kitchen_inventory_item_id = v_item_pastry
  ), 0);
  if v_tt_after is distinct from v_tt_before then
    raise exception 'SMOKE_RESULT FAIL tt_balance before=% after=%', v_tt_before, v_tt_after;
  end if;
  if v_tt_after <> 0 then
    raise exception 'SMOKE_RESULT FAIL tt_balance_not_zero %', v_tt_after;
  end if;

  select s.balance_qty into v_q7_after
  from public.get_q7_inventory_snapshot(current_date) s
  where s.kitchen_inventory_item_id = v_item_pastry;
  if v_q7_after is distinct from v_q7_before + v_qty then
    raise exception 'SMOKE_RESULT FAIL q7_snapshot before=% after=%', v_q7_before, v_q7_after;
  end if;

  -- A replay writes nothing new.
  v_result := public.post_goods_receipt_to_stock(v_receipt);
  if (v_result ->> 'status') is distinct from 'posted' then
    raise exception 'SMOKE_RESULT FAIL replay_status %', v_result;
  end if;
  select count(*) into v_count
  from public.stock_transfers where goods_receipt_item_id = v_line_pastry;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL replay_transfer %', v_count;
  end if;
  select count(*) into v_count
  from public.q7_inventory_movements m
  where m.kitchen_inventory_item_id = v_item_pastry and m.movement_type = 'transfer_in';
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL replay_transfer_in %', v_count;
  end if;

  ------------------------------------------------------------------
  -- Redefined balance readers
  ------------------------------------------------------------------
  v_overview := public.get_stock_ledger_overview('q7');
  if not exists (
    select 1 from jsonb_array_elements(v_overview -> 'items') e
    where e ->> 'item_id' = v_item_pastry::text
      and (e ->> 'current_qty')::numeric = v_q7_after
      and (e ->> 'in_qty_7d')::numeric >= v_qty
  ) then
    raise exception 'SMOKE_RESULT FAIL overview_q7 %', v_overview -> 'items';
  end if;

  v_overview := public.get_stock_ledger_overview('tan_tao', current_date);
  if not exists (
    select 1 from jsonb_array_elements(v_overview -> 'materials') e
    where e ->> 'item_id' = v_item_pastry::text
      and (e ->> 'current_qty')::numeric = v_tt_after
      and (e ->> 'out_qty_7d')::numeric >= v_qty
  ) then
    raise exception 'SMOKE_RESULT FAIL overview_tan_tao %', v_overview -> 'materials';
  end if;

  -- Q7 snapshot lists only the pastry item, transfers array is present.
  v_snap := public.get_warehouse_game_snapshot('q7');
  if not exists (
    select 1 from jsonb_array_elements(v_snap -> 'items') e
    where e ->> 'id' = v_item_pastry::text and (e ->> 'pastry_q7')::boolean is true
  ) then
    raise exception 'SMOKE_RESULT FAIL snapshot_q7_pastry';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_snap -> 'items') e
    where (e ->> 'pastry_q7')::boolean is not true
  ) then
    raise exception 'SMOKE_RESULT FAIL snapshot_q7_nonpastry';
  end if;
  if jsonb_array_length(v_snap -> 'transfers') < 1 then
    raise exception 'SMOKE_RESULT FAIL snapshot_transfers';
  end if;

  v_snap := public.get_warehouse_game_snapshot('tan_tao');
  if not exists (
    select 1 from jsonb_array_elements(v_snap -> 'items') e
    where e ->> 'id' = v_item_plain::text and (e ->> 'pastry_q7')::boolean is false
  ) then
    raise exception 'SMOKE_RESULT FAIL snapshot_tan_tao_plain';
  end if;

  if jsonb_array_length(public.get_stock_transfers(30)) < 1 then
    raise exception 'SMOKE_RESULT FAIL get_stock_transfers';
  end if;

  -- The Tân Tạo count reads the transfer_out: book balance is zero.
  v_result := public.record_tan_tao_material_count(
    v_item_pastry, 0, current_date, 'smoke central', 'smoke-central-' || v_suffix);
  if (v_result ->> 'system_qty')::numeric is distinct from v_tt_after then
    raise exception 'SMOKE_RESULT FAIL tt_count system=% expected=%',
      v_result ->> 'system_qty', v_tt_after;
  end if;

  ------------------------------------------------------------------
  -- Merge engine reads the Q7 transfer_in balance
  ------------------------------------------------------------------
  insert into public.sku_cogs_materials
    (material_code, canonical_name, normalized_name, default_unit, category)
  values ('SMOKE-CEN-MAT2-' || v_suffix, 'Bột smoke merge ' || v_suffix,
          public.normalize_stock_item_name('Bột smoke merge ' || v_suffix), 'g', 'dairy_fat')
  returning id into v_mat2;

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit, standard_unit_cost, active,
     canonical_material_id, pastry_q7, pastry_q7_source)
  values ('SMOKE-CEN-P2-' || v_suffix, 'smoke-cen-p2-' || v_suffix, 'ingredient',
          'Bột smoke p2 ' || v_suffix, 'g', 0, true, v_mat2, true, 'owner')
  returning id into v_item_p2;

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit, standard_unit_cost, active)
  values ('SMOKE-CEN-T2-' || v_suffix, 'smoke-cen-t2-' || v_suffix, 'ingredient',
          'Bột smoke t2 ' || v_suffix, 'g', 0, true)
  returning id into v_item_t2;

  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit,
     conversion_factor, approval_status, approved_by, approved_at)
  values (v_mat2, 'g', v_item_p2, 'g', 1, 'approved', v_owner, now());

  insert into public.q7_inventory_movements
    (kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
     source, source_ref_key, created_by)
  values (v_item_p2, current_date, 'transfer_in', 3, 'g',
          'stock_transfer', 'smoke-merge-in:' || v_suffix, v_owner);

  v_merge := public.apply_stock_item_merge(v_item_p2, v_item_t2, 1, null);
  v_merge_id := nullif(v_merge ->> 'merge_id', '')::uuid;
  if v_merge_id is null then
    raise exception 'SMOKE_RESULT FAIL merge_no_id %', v_merge;
  end if;
  select count(*) into v_count
  from public.q7_inventory_movements m
  where m.kitchen_inventory_item_id = v_item_p2
    and m.source = 'item_merge' and m.movement_type = 'adjustment' and m.quantity = -3;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL merge_source_out %', v_count;
  end if;
  select count(*) into v_count
  from public.q7_inventory_movements m
  where m.kitchen_inventory_item_id = v_item_t2
    and m.source = 'item_merge' and m.movement_type = 'adjustment' and m.quantity = 3;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL merge_target_in %', v_count;
  end if;

  v_merge := public.revert_stock_item_merge(v_merge_id);
  if (v_merge ->> 'status') is distinct from 'reverted' then
    raise exception 'SMOKE_RESULT FAIL merge_revert %', v_merge;
  end if;

  ------------------------------------------------------------------
  -- Q7 pastry-only guard
  ------------------------------------------------------------------
  v_probe := 0;
  begin
    insert into public.q7_inventory_movements (
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, created_by
    ) values (
      v_item_plain, current_date, 'receipt', 1, 'g',
      'manual_receipt', 'smoke-central-guard:' || v_suffix, v_owner
    );
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%q7_pastry_only%' then
      raise exception 'SMOKE_RESULT FAIL guard_error: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL guard_accepted';
  end if;

  ------------------------------------------------------------------
  -- set_item_pastry_q7 refuses a non-admin user (skip when none)
  ------------------------------------------------------------------
  if v_emp is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_emp, 'role', 'authenticated')::text, true);
    v_probe := 0;
    begin
      perform public.set_item_pastry_q7(v_item_plain, true, gen_random_uuid());
      v_probe := 1;
    exception when others then
      if sqlerrm not like '%pastry_forbidden%' then
        raise exception 'SMOKE_RESULT FAIL pastry_forbidden: %', sqlerrm;
      end if;
    end;
    if v_probe <> 0 then
      raise exception 'SMOKE_RESULT FAIL pastry_forbidden_accepted';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  else
    raise notice 'SMOKE central: no non-admin user, set_item_pastry_q7 refusal skipped';
  end if;

  raise exception 'SMOKE_RESULT PASS: central warehouse flow';
end;
$smoke$;
