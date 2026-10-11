-- 2026-10-22 — Danh mục NVL chung 2 kho, chốt đơn vị chuẩn và tên, sổ NVL Tân Tạo,
-- quét hàng mới chạy nền.
--
-- Additive migration on top of 20261013100000 + 20261015100000 + 20261016100000 +
-- 20261017100000 + 20261018100000 + 20261019100000 + 20261020100000 +
-- 20261021100000. It does four things:
--   1. public.stock_units / public.stock_unit_aliases + public.normalize_stock_unit.
--   2. Converts every active kitchen item to a standard unit (Gr -> g; Kg -> g and
--      L -> ml with the alias conversion factor x1000 and cost /1000, by moving the
--      old item into a new base-unit item when it already has ledger history).
--   3. Guards the kitchen item unit / name and the unit column of the three
--      document line tables, backfills the last 60 days of `unit` only and exposes
--      public.list_unknown_purchase_units.
--   4. Gives Tân Tạo the shared kitchen_inventory_items catalog (candidates,
--      confirm, new-name backlog, create item, new-item scan), an append-only
--      Tân Tạo NVL ledger fed by Tân Tạo goods receipts, and a background run
--      table for the new-item scan.
--
-- Nothing here updates or deletes purchase_orders, payment_requests, goods_receipts,
-- q7_inventory_movements or tan_tao_warehouse_movements. The only document write is
-- the single `unit` column of the three line tables. No quantity, price, total or
-- status column is touched. All ledger writes are append-only inserts.

-- ===========================================================================
-- 1. Standard units
-- ===========================================================================

create table if not exists public.stock_units (
  code text primary key,
  label text not null,
  kind text not null,
  base_code text not null references public.stock_units(code),
  to_base numeric not null,
  created_at timestamptz not null default now(),
  constraint stock_units_kind_check check (kind in ('weight', 'volume', 'count')),
  constraint stock_units_code_check check (btrim(code) <> '' and code = lower(btrim(code))),
  constraint stock_units_label_check check (btrim(label) <> ''),
  constraint stock_units_to_base_check check (
    to_base > 0 and to_base::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

create table if not exists public.stock_unit_aliases (
  variant text primary key,
  code text not null references public.stock_units(code),
  created_at timestamptz not null default now(),
  constraint stock_unit_aliases_variant_check check (
    btrim(variant) <> '' and variant = lower(btrim(variant))
  )
);

-- Seed the base and counting units first so the self-reference resolves, then the
-- composite units that point at g / ml.
insert into public.stock_units (code, label, kind, base_code, to_base) values
  ('g', 'g', 'weight', 'g', 1),
  ('ml', 'ml', 'volume', 'ml', 1),
  ('cái', 'cái', 'count', 'cái', 1),
  ('hộp', 'hộp', 'count', 'hộp', 1),
  ('cuộn', 'cuộn', 'count', 'cuộn', 1),
  ('chai', 'chai', 'count', 'chai', 1),
  ('bịch', 'bịch', 'count', 'bịch', 1),
  ('gói', 'gói', 'count', 'gói', 1),
  ('can', 'can', 'count', 'can', 1),
  ('bao', 'bao', 'count', 'bao', 1),
  ('quả', 'quả', 'count', 'quả', 1),
  ('tờ', 'tờ', 'count', 'tờ', 1),
  ('con', 'con', 'count', 'con', 1),
  ('cây', 'cây', 'count', 'cây', 1),
  ('thùng', 'thùng', 'count', 'thùng', 1),
  ('khối', 'khối', 'count', 'khối', 1),
  ('bình', 'bình', 'count', 'bình', 1),
  ('nắp', 'nắp', 'count', 'nắp', 1)
on conflict (code) do update
  set label = excluded.label, kind = excluded.kind,
      base_code = excluded.base_code, to_base = excluded.to_base;

insert into public.stock_units (code, label, kind, base_code, to_base) values
  ('kg', 'kg', 'weight', 'g', 1000),
  ('l', 'l', 'volume', 'ml', 1000)
on conflict (code) do update
  set label = excluded.label, kind = excluded.kind,
      base_code = excluded.base_code, to_base = excluded.to_base;

-- Real receipt spellings, lowercased and trimmed. Ambiguous strings (pack,
-- 'cối (pack)', định, đệnh, lần) are deliberately NOT seeded: an unknown unit is
-- kept on the document line and never guessed.
insert into public.stock_unit_aliases (variant, code) values
  ('gr', 'g'), ('gram', 'g'),
  ('kí', 'kg'), ('ký', 'kg'), ('kgs', 'kg'),
  ('lit', 'l'), ('lít', 'l'),
  ('cuôn', 'cuộn'), ('cuốn', 'cuộn'),
  ('hôp', 'hộp'),
  ('từ', 'tờ'),
  ('cai', 'cái'), ('c', 'cái'), ('chiếc', 'cái'),
  ('bich', 'bịch'),
  ('goi', 'gói'),
  ('can lớn', 'can')
on conflict (variant) do update set code = excluded.code;

alter table public.stock_units enable row level security;
alter table public.stock_unit_aliases enable row level security;

drop policy if exists stock_units_select on public.stock_units;
create policy stock_units_select on public.stock_units
  for select to authenticated using (true);

drop policy if exists stock_unit_aliases_select on public.stock_unit_aliases;
create policy stock_unit_aliases_select on public.stock_unit_aliases
  for select to authenticated using (true);

revoke all on table public.stock_units from public, anon, authenticated;
grant select on table public.stock_units to authenticated, service_role;
grant insert, update, delete on table public.stock_units to service_role;

revoke all on table public.stock_unit_aliases from public, anon, authenticated;
grant select on table public.stock_unit_aliases to authenticated, service_role;
grant insert, update, delete on table public.stock_unit_aliases to service_role;

-- The alias/code spelling of a unit, before collapsing a composite unit to its
-- base (kg -> g, l -> ml). Used only inside this migration.
create or replace function public.stock_unit_code(p_unit text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  with n as (select lower(btrim(coalesce(p_unit, ''))) as v)
  select coalesce(
    (select a.code from public.stock_unit_aliases a where a.variant = n.v),
    (select u.code from public.stock_units u where lower(u.code) = n.v or lower(u.label) = n.v limit 1)
  )
  from n;
$$;

-- Lowercase + trim, then an alias or a standard code / label, then collapse a
-- composite unit to its base (kg -> g, l -> ml). Returns null when the text is
-- not a known unit. Mirrors src/lib/stock-units.ts.
create or replace function public.normalize_stock_unit(p_unit text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select u_base.base_code
  from public.stock_units u_base
  where u_base.code = public.stock_unit_code(p_unit);
$$;

revoke all on function public.stock_unit_code(text) from public, anon;
grant execute on function public.stock_unit_code(text) to authenticated, service_role;

revoke all on function public.normalize_stock_unit(text) from public, anon;
grant execute on function public.normalize_stock_unit(text) to authenticated, service_role;

-- ===========================================================================
-- 2. Unit conversion audit + the item-unit standardized pass
-- ===========================================================================

create table if not exists public.stock_unit_conversions (
  id uuid primary key default gen_random_uuid(),
  old_item_id uuid references public.kitchen_inventory_items(id) on delete set null,
  new_item_id uuid references public.kitchen_inventory_items(id) on delete set null,
  old_unit text,
  new_unit text,
  factor numeric(18, 8) not null,
  merge_id uuid references public.stock_item_merges(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  constraint stock_unit_conversions_factor_check check (
    factor > 0 and factor::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

alter table public.stock_unit_conversions enable row level security;
drop policy if exists stock_unit_conversions_select on public.stock_unit_conversions;
create policy stock_unit_conversions_select on public.stock_unit_conversions
  for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

revoke all on table public.stock_unit_conversions from public, anon, authenticated;
grant select on table public.stock_unit_conversions to authenticated, service_role;
grant insert, update, delete on table public.stock_unit_conversions to service_role;

-- Records the counts of the 60-day `unit` backfill so the smoke test can report
-- what the applied migration did without re-running it.
create table if not exists public.stock_unit_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  days integer not null,
  updated integer not null default 0,
  blocked integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.stock_unit_backfill_runs enable row level security;
drop policy if exists stock_unit_backfill_runs_select on public.stock_unit_backfill_runs;
create policy stock_unit_backfill_runs_select on public.stock_unit_backfill_runs
  for select to authenticated
  using (public.material_alias_can_admin((select auth.uid())));

revoke all on table public.stock_unit_backfill_runs from public, anon, authenticated;
grant select on table public.stock_unit_backfill_runs to authenticated, service_role;
grant insert, update, delete on table public.stock_unit_backfill_runs to service_role;

-- Decide the standard unit of an item, the factor to apply to its quantities and
-- its cost. Returns null when the current unit is already the standard one.
create or replace function public.stock_unit_item_conversion(p_unit text)
returns table (new_unit text, factor numeric)
language sql
immutable
set search_path = public, pg_temp
as $$
  with c as (select public.stock_unit_code(p_unit) as code)
  select u.base_code,
         case
           when u.code = u.base_code then 1::numeric
           else u.to_base
         end
  from public.stock_units u
  join c on c.code = u.code
  where btrim(coalesce(p_unit, '')) <> u.base_code;
$$;

revoke all on function public.stock_unit_item_conversion(text) from public, anon;
grant execute on function public.stock_unit_item_conversion(text) to authenticated, service_role;

-- True when the item already has any ledger / opening / count history.
create or replace function public.stock_unit_item_has_history(p_item_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return exists (
    select 1 from public.q7_inventory_movements m where m.kitchen_inventory_item_id = p_item_id
    union all
    select 1 from public.q7_inventory_openings o where o.kitchen_inventory_item_id = p_item_id
    union all
    select 1 from public.tan_tao_material_movements t where t.kitchen_inventory_item_id = p_item_id
  );
end;
$$;

revoke all on function public.stock_unit_item_has_history(uuid) from public, anon;
grant execute on function public.stock_unit_item_has_history(uuid) to authenticated, service_role;

-- Generate the next NVL item code.
create or replace function public.stock_unit_next_item_code()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_counter integer;
  v_code text;
begin
  select count(*) filter (where kii.item_type = 'ingredient') into v_counter
  from public.kitchen_inventory_items kii;
  loop
    v_counter := v_counter + 1;
    v_code := 'NVL-' || lpad(v_counter::text, 3, '0');
    exit when not exists (
      select 1 from public.kitchen_inventory_items kii where kii.item_code = v_code
    );
  end loop;
  return v_code;
end;
$$;

revoke all on function public.stock_unit_next_item_code() from public, anon, authenticated;
grant execute on function public.stock_unit_next_item_code() to service_role;

-- Convert every active, unmerged item to its standard unit. An item with no
-- ledger history is updated in place; an item that already has history gets a new
-- base-unit sibling and is merged into it with the conversion factor.
create or replace function public.standardize_stock_item_units()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.kitchen_inventory_items%rowtype;
  v_new_unit text;
  v_factor numeric;
  v_code text;
  v_key text;
  v_item_id uuid;
  v_new_item_id uuid;
  v_merge_id uuid;
  v_merge jsonb;
  v_converted integer := 0;
  v_merged integer := 0;
begin
  -- The migration is allowed to rewrite the catalog: this is the one place the
  -- duplicate-name guard and the editor permission are bypassed on purpose.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('stock_catalog.unit_migration', 'on', true);

  for v_item in
    select *
    from public.kitchen_inventory_items
    where active = true
      and merged_into_id is null
      and unit is not null
    order by created_at asc, id asc
  loop
    select c.new_unit, c.factor into v_new_unit, v_factor
    from public.stock_unit_item_conversion(v_item.unit) c;
    if v_new_unit is null or v_factor is null then
      continue;
    end if;

    if public.stock_unit_item_has_history(v_item.id) then
      -- New sibling in the standard unit; the merge moves balance, aliases and
      -- issue mappings and leaves the append-only ledgers untouched.
      v_code := public.stock_unit_next_item_code();
      v_key := v_item.normalized_key || ':unit:' || v_new_unit;
      while exists (
        select 1 from public.kitchen_inventory_items k where k.normalized_key = v_key
      ) loop
        v_key := v_key || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);
      end loop;

      insert into public.kitchen_inventory_items (
        item_code, normalized_key, item_type, name, unit, standard_unit_cost, active
      ) values (
        v_code, v_key, v_item.item_type, v_item.name, v_new_unit,
        round(v_item.standard_unit_cost / v_factor, 8), true
      )
      returning id into v_new_item_id;

      v_merge := public.apply_stock_item_merge(v_item.id, v_new_item_id, v_factor, null);
      v_merge_id := nullif(v_merge ->> 'merge_id', '')::uuid;
      v_merged := v_merged + 1;
      insert into public.stock_unit_conversions (
        old_item_id, new_item_id, old_unit, new_unit, factor, merge_id, note
      ) values (
        v_item.id, v_new_item_id, v_item.unit, v_new_unit, v_factor, v_merge_id,
        'merged_into_base_unit'
      );
    else
      update public.kitchen_inventory_items
        set unit = v_new_unit,
            standard_unit_cost = round(standard_unit_cost / v_factor, 8),
            updated_at = now()
        where id = v_item.id;

      update public.stock_material_aliases
        set unit = v_new_unit,
            conversion_factor = conversion_factor * v_factor,
            updated_at = now()
        where kitchen_inventory_item_id = v_item.id;

      insert into public.stock_unit_conversions (
        old_item_id, new_item_id, old_unit, new_unit, factor, merge_id, note
      ) values (
        v_item.id, v_item.id, v_item.unit, v_new_unit, v_factor, null,
        'in_place'
      );
      v_converted := v_converted + 1;
    end if;
  end loop;

  perform set_config('stock_catalog.unit_migration', 'off', true);
  return jsonb_build_object('in_place', v_converted, 'merged', v_merged);
end;
$$;

revoke all on function public.standardize_stock_item_units() from public, anon, authenticated;
grant execute on function public.standardize_stock_item_units() to service_role;

-- ===========================================================================
-- 3. kitchen_inventory_items unit + duplicate-name guard
-- ===========================================================================

create or replace function public.kitchen_inventory_items_unit_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text;
  v_name text;
  v_skip_duplicate boolean;
begin
  -- Normalize the unit and refuse anything outside the standard table. A merged
  -- row keeps its historical unit because it is no longer part of the live
  -- catalog and apply_stock_item_merge may set it in the same statement.
  if new.unit is not null then
    v_norm := public.normalize_stock_unit(new.unit);
    if v_norm is null then
      raise exception 'unit_not_allowed' using errcode = '23514';
    end if;
    new.unit := v_norm;
  end if;

  -- Only an active, unmerged row can collide with another live item name. A
  -- merge, an undo of a merge and a row that is already retired never trip the
  -- guard; the catalog migration bypasses it explicitly.
  v_skip_duplicate := coalesce(current_setting('stock_catalog.unit_migration', true), '') = 'on'
    or coalesce(new.active, true) = false
    or new.merged_into_id is not null;
  if tg_op = 'UPDATE' and old.merged_into_id is not null then
    v_skip_duplicate := true;
  end if;

  if not v_skip_duplicate then
    v_name := public.normalize_stock_item_name(new.name);
    if v_name is not null and exists (
      select 1
      from public.kitchen_inventory_items k
      where k.id <> new.id
        and k.active = true
        and k.merged_into_id is null
        and public.normalize_stock_item_name(k.name) = v_name
    ) then
      raise exception 'item_name_duplicate' using errcode = '23505';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists kitchen_inventory_items_unit_guard on public.kitchen_inventory_items;
create trigger kitchen_inventory_items_unit_guard
  before insert or update of name, unit, active on public.kitchen_inventory_items
  for each row execute function public.kitchen_inventory_items_unit_guard();

-- ===========================================================================
-- 4. Document line unit guard + 60-day backfill + unknown-unit RPC
-- ===========================================================================

-- Set NEW.unit to the standard lowercase label when the spelling is known; keep
-- the raw text untouched otherwise. Only the unit column is ever written.
-- A document line keeps its own unit: only the spelling is fixed (KG -> kg,
-- Cuôn -> cuộn, Gr -> g). It is never collapsed to the base unit, because the
-- line quantity and price are stated in the unit written on the document.
create or replace function public.stock_document_line_normalize_unit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_label text;
begin
  if new.unit is not null then
    v_code := public.stock_unit_code(new.unit);
    if v_code is not null then
      select u.label into v_label from public.stock_units u where u.code = v_code;
      if v_label is not null then
        new.unit := v_label;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists purchase_order_items_normalize_unit on public.purchase_order_items;
create trigger purchase_order_items_normalize_unit
  before insert or update of unit on public.purchase_order_items
  for each row execute function public.stock_document_line_normalize_unit();

drop trigger if exists payment_request_items_normalize_unit on public.payment_request_items;
create trigger payment_request_items_normalize_unit
  before insert or update of unit on public.payment_request_items
  for each row execute function public.stock_document_line_normalize_unit();

drop trigger if exists goods_receipt_items_normalize_unit on public.goods_receipt_items;
create trigger goods_receipt_items_normalize_unit
  before insert or update of unit on public.goods_receipt_items
  for each row execute function public.stock_document_line_normalize_unit();

-- Backfill the last N days of `unit` on the three line tables. Only rows whose
-- normalized label differs from the stored text are touched, and a row whose
-- existing source-identity guard refuses the unit change is skipped and counted.
create or replace function public.backfill_stock_document_units(p_days integer default 60)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 60), 365));
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_updated integer := 0;
  v_blocked integer := 0;
  v_label text;
  v_code text;
  r record;
begin
  if coalesce(current_setting('stock_catalog.unit_migration', true), '') <> 'on'
     and coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null or not public.material_alias_can_admin(auth.uid()) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  for r in
    select 'purchase_order_items'::text as tbl, i.id as row_id, i.unit
    from public.purchase_order_items i
    join public.purchase_orders p on p.id = i.purchase_order_id
    where coalesce(p.order_date, p.created_at::date) >= v_today - v_days
      and i.unit is not null
    union all
    select 'payment_request_items', i.id, i.unit
    from public.payment_request_items i
    join public.payment_requests pr on pr.id = i.payment_request_id
    where pr.created_at >= now() - (v_days || ' days')::interval
      and i.unit is not null
    union all
    select 'goods_receipt_items', i.id, i.unit
    from public.goods_receipt_items i
    join public.goods_receipts g on g.id = i.goods_receipt_id
    where g.receipt_date >= v_today - v_days
      and i.unit is not null
  loop
    v_code := public.stock_unit_code(r.unit);
    if v_code is null then
      continue;
    end if;
    select u.label into v_label from public.stock_units u where u.code = v_code;
    if v_label is null or v_label = r.unit then
      continue;
    end if;
    begin
      execute format('update public.%I set unit = $1 where id = $2', r.tbl)
        using v_label, r.row_id;
      v_updated := v_updated + 1;
    exception when others then
      v_blocked := v_blocked + 1;
    end;
  end loop;

  insert into public.stock_unit_backfill_runs (days, updated, blocked)
  values (v_days, v_updated, v_blocked);

  return jsonb_build_object('days', v_days, 'updated', v_updated, 'blocked', v_blocked);
end;
$$;

revoke all on function public.backfill_stock_document_units(integer) from public, anon;
grant execute on function public.backfill_stock_document_units(integer) to authenticated, service_role;

-- Alias spellings that still do not resolve, grouped by source table.
create or replace function public.list_unknown_purchase_units(p_days integer default 60)
returns table (
  unit text,
  line_count bigint,
  example_name text,
  source_table text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 60), 365));
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null or not public.material_alias_can_admin(auth.uid()) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  return query
  with units as (
    select 'purchase_order_items'::text as source_table, i.unit, i.product_name
    from public.purchase_order_items i
    join public.purchase_orders p on p.id = i.purchase_order_id
    where coalesce(p.order_date, p.created_at::date) >= v_today - v_days
      and i.unit is not null and public.normalize_stock_unit(i.unit) is null
    union all
    select 'payment_request_items', i.unit, i.product_name
    from public.payment_request_items i
    join public.payment_requests pr on pr.id = i.payment_request_id
    where pr.created_at >= now() - (v_days || ' days')::interval
      and i.unit is not null and public.normalize_stock_unit(i.unit) is null
    union all
    select 'goods_receipt_items', i.unit, i.product_name
    from public.goods_receipt_items i
    join public.goods_receipts g on g.id = i.goods_receipt_id
    where g.receipt_date >= v_today - v_days
      and i.unit is not null and public.normalize_stock_unit(i.unit) is null
  )
  select u.unit, count(*)::bigint, min(u.product_name), u.source_table
  from units u
  group by u.unit, u.source_table
  order by count(*) desc, u.unit asc, u.source_table asc;
end;
$$;

revoke all on function public.list_unknown_purchase_units(integer) from public, anon;
grant execute on function public.list_unknown_purchase_units(integer) to authenticated, service_role;

-- ===========================================================================
-- 5. Shared catalog for Tân Tạo
-- ===========================================================================

-- Tân Tạo may now point at a shared kitchen_inventory_items row (a raw material)
-- as well as at a finished-goods SKU; q7 keeps a kitchen item only.
alter table public.stock_material_aliases
  drop constraint if exists stock_material_aliases_location_item_check;
alter table public.stock_material_aliases
  add constraint stock_material_aliases_location_item_check check (
    (line_class = 'non_stock' and kitchen_inventory_item_id is null and tan_tao_sku_id is null)
    or (
      line_class = 'stock'
      and (
        (kitchen_inventory_item_id is not null and tan_tao_sku_id is null)
        or (kitchen_inventory_item_id is null and tan_tao_sku_id is not null)
      )
    )
  );

-- For 'tan_tao' the candidate list is the shared kitchen_inventory_items catalog
-- (item_id set, sku_id null) plus the finished-goods SKUs (sku_id set, item_id
-- null), ranked together. Every SKU candidate carries a '+sku' reason suffix so
-- the UI and Jev can tell a raw material from a finished product.
create or replace function public.material_alias_candidates(
  p_name text,
  p_location text,
  p_limit integer default 5
)
returns table (
  item_id uuid,
  sku_id uuid,
  name text,
  unit text,
  score numeric,
  reason text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with base as (
    select coalesce(public.material_alias_clean_name(p_name), '') as clean_name
  ),
  parts as (
    select
      part,
      public.normalize_stock_item_name(part) as part_norm,
      public.material_alias_match_tokens(part) as part_tokens
    from base
    cross join lateral unnest(regexp_split_to_array(base.clean_name, '/')) as part
  ),
  item_raw as (
    select
      p_location::text as src,
      'item'::text as kind,
      kii.id as item_id,
      null::uuid as sku_id,
      kii.name::text as name,
      kii.unit::text as unit,
      p.part_norm,
      p.part_tokens,
      public.normalize_stock_item_name(kii.name) as cand_norm,
      public.material_alias_match_tokens(kii.name) as cand_tokens
    from public.kitchen_inventory_items kii
    cross join parts p
    where p_location in ('q7', 'tan_tao')
      and kii.active = true
      and kii.merged_into_id is null
    union all
    select
      'tan_tao'::text,
      'sku'::text,
      null::uuid,
      ps.id,
      ps.product_name::text,
      ps.unit::text,
      p.part_norm,
      p.part_tokens,
      public.normalize_stock_item_name(ps.product_name),
      public.material_alias_match_tokens(ps.product_name)
    from public.product_skus ps
    cross join parts p
    where p_location = 'tan_tao'
      and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G')
  ),
  scored as (
    select
      ir.*,
      (
        select count(*)
        from unnest(ir.part_tokens) rt
        where exists (
          select 1 from unnest(ir.cand_tokens) ct
          where public.material_alias_tokens_match(rt, ct)
        )
      ) as matched,
      cardinality(ir.part_tokens) as raw_count
    from item_raw ir
  ),
  part_scored as (
    select
      s.*,
      (s.part_norm is not null and s.part_norm = s.cand_norm) as is_exact,
      (s.raw_count > 0 and s.matched = s.raw_count) as contains_all
    from scored s
  ),
  part_final as (
    select
      p.src,
      p.kind,
      p.item_id,
      p.sku_id,
      p.name,
      p.unit,
      coalesce(p.item_id, p.sku_id) as cand_key,
      case
        when p.is_exact then 1.000000::numeric
        when p.contains_all then 0.900000::numeric
        when p.matched > 0 then 0.500000::numeric + 0.400000::numeric * p.matched::numeric / greatest(p.raw_count, 1)
        else 0.000000::numeric
      end as score_part,
      case
        when p.is_exact then 0
        when p.contains_all then 1
        when p.matched > 0 then 2
        else 3
      end as priority,
      case
        when p.is_exact then 'name_exact'
        when p.contains_all then 'name_contains'
        else 'token'
      end as base_reason
    from part_scored p
    where p.matched > 0 or p.is_exact
  ),
  best as (
    select distinct on (src, kind, cand_key)
      src, kind, item_id, sku_id, name, unit, score_part, base_reason
    from part_final
    order by src, kind, cand_key, score_part desc, priority asc, name asc
  ),
  final as (
    select
      b.src,
      b.kind,
      b.item_id,
      b.sku_id,
      b.name,
      b.unit,
      b.score_part as score,
      b.base_reason
        || case when (
          n.n is not null and exists (
            select 1
            from public.stock_material_aliases a
            where a.location = b.src
              and a.supplier_id is null
              and a.normalized_name = n.n
              and case
                when b.kind = 'item' then a.kitchen_inventory_item_id = b.item_id
                else a.tan_tao_sku_id = b.sku_id
              end
          )
        ) then '+shared_alias' else '' end
        || case when b.kind = 'sku' then '+sku' else '' end as reason
    from best b
    cross join lateral (
      select public.normalize_stock_item_name(public.material_alias_clean_name(p_name)) as n
    ) n
  )
  select f.item_id, f.sku_id, f.name, f.unit, f.score, f.reason
  from final f
  order by f.score desc, f.name asc, f.item_id asc nulls last, f.sku_id asc nulls last
  limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;

revoke all on function public.material_alias_candidates(text, text, integer) from public, anon;
grant execute on function public.material_alias_candidates(text, text, integer) to authenticated, service_role;

-- confirm_material_alias: for 'tan_tao' accept exactly one of a shared kitchen
-- item or a finished-goods SKU. Everything else (auto after 3 confirmations,
-- admin auto-promote, non_stock, replay over confirmed receipt lines) is kept.
create or replace function public.confirm_material_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric,
  p_source_table text,
  p_source_id uuid,
  p_line_class text default 'stock'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_array uuid[];
  v_norm text;
  v_unit text;
  v_factor numeric;
  v_pack_label text;
  v_alias public.stock_material_aliases%rowtype;
  v_same boolean;
  v_action text;
  v_jev_disagreed boolean;
  v_new_item uuid;
  v_new_sku uuid;
  v_chosen uuid;
  v_confirmers uuid[];
  v_distinct integer;
  v_cutover date;
  v_target record;
  v_applied integer := 0;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if p_line_class not in ('stock', 'non_stock') then
    raise exception 'line_class_invalid' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_line_class = 'non_stock'
     and public.stock_line_auto_non_stock(p_raw_name) is null
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.material_alias_can_admin(v_actor) then
    raise exception 'non_stock_requires_admin' using errcode = '42501';
  end if;

  v_actor_array := case when v_actor is null then '{}'::uuid[] else array[v_actor] end;
  v_norm := public.normalize_stock_item_name(p_raw_name);
  if v_norm is null then raise exception 'item_name_required' using errcode = '22023'; end if;

  if p_line_class = 'non_stock' then
    v_new_item := null;
    v_new_sku := null;
    v_factor := 1;
    v_unit := coalesce(nullif(btrim(p_raw_unit), ''), '-');
  else
    if p_conversion_factor is null or p_conversion_factor <= 0
       or p_conversion_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_conversion_factor' using errcode = '22023';
    end if;
    v_factor := p_conversion_factor;

    if p_location = 'q7' then
      if p_kitchen_inventory_item_id is null or p_tan_tao_sku_id is not null then
        raise exception 'kitchen_inventory_item_required' using errcode = '22023';
      end if;
      select kii.unit into v_unit
      from public.kitchen_inventory_items kii
      where kii.id = p_kitchen_inventory_item_id
        and kii.active = true
        and kii.merged_into_id is null;
      if v_unit is null then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;
      v_new_item := p_kitchen_inventory_item_id;
      v_new_sku := null;
    else
      -- Tân Tạo: exactly one target, a shared NVL item or a finished-goods SKU.
      if (p_kitchen_inventory_item_id is null) = (p_tan_tao_sku_id is null) then
        raise exception 'tan_tao_target_required' using errcode = '22023';
      end if;
      if p_kitchen_inventory_item_id is not null then
        select kii.unit into v_unit
        from public.kitchen_inventory_items kii
        where kii.id = p_kitchen_inventory_item_id
          and kii.active = true
          and kii.merged_into_id is null;
        if v_unit is null then raise exception 'tan_tao_item_not_found' using errcode = 'P0002'; end if;
        v_new_item := p_kitchen_inventory_item_id;
        v_new_sku := null;
      else
        select ps.unit into v_unit
        from public.product_skus ps
        where ps.id = p_tan_tao_sku_id
          and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');
        if v_unit is null then raise exception 'tan_tao_sku_not_found' using errcode = 'P0002'; end if;
        v_new_item := null;
        v_new_sku := p_tan_tao_sku_id;
      end if;
    end if;
  end if;

  v_pack_label := nullif(btrim(coalesce(p_entered_unit_label, '')), '');
  if v_pack_label is null then
    v_pack_label := public.q7_pack_from_name(p_raw_name, p_raw_unit) ->> 'pack_label';
  end if;

  v_chosen := coalesce(v_new_item, v_new_sku);
  v_jev_disagreed := p_jev_item_id is not null
    and p_jev_item_id is distinct from v_chosen
    and coalesce(p_jev_probability, 0) >= 0.9;

  select * into v_alias
  from public.stock_material_aliases a
  where a.location = p_location
    and a.normalized_name = v_norm
    and a.supplier_id is not distinct from p_supplier_id
  for update;

  if not found then
    insert into public.stock_material_aliases(
      supplier_id, normalized_name, location, kitchen_inventory_item_id,
      tan_tao_sku_id, conversion_factor, unit, created_by,
      confirm_count, confirmers, status, pack_label, last_confirmed_at,
      jev_item_id, jev_probability, jev_disagreed, line_class
    ) values (
      p_supplier_id, v_norm, p_location, v_new_item,
      v_new_sku, v_factor, v_unit, v_actor,
      1, v_actor_array, 'learning', v_pack_label, now(),
      p_jev_item_id, p_jev_probability, v_jev_disagreed, p_line_class
    )
    returning * into v_alias;
    v_action := 'confirm';
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
    ) values (
      v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
    );
  else
    v_same := (v_alias.line_class is not distinct from p_line_class)
      and (v_alias.kitchen_inventory_item_id is not distinct from v_new_item)
      and (v_alias.tan_tao_sku_id is not distinct from v_new_sku)
      and (v_alias.conversion_factor = v_factor);

    if v_same then
      v_confirmers := coalesce(v_alias.confirmers, '{}'::uuid[]);
      if v_actor is not null and not (v_actor = any (v_confirmers)) then
        v_confirmers := v_confirmers || v_actor;
      end if;
      update public.stock_material_aliases
        set confirm_count = v_alias.confirm_count + 1,
            confirmers = v_confirmers,
            last_confirmed_at = now(),
            pack_label = coalesce(v_pack_label, pack_label),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
      v_action := 'confirm';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
      );
    else
      v_action := 'correct';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        previous_item_id, previous_sku_id, previous_factor, previous_line_class,
        new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'correct', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
        v_alias.line_class,
        v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
      );
      update public.stock_material_aliases
        set kitchen_inventory_item_id = v_new_item,
            tan_tao_sku_id = v_new_sku,
            conversion_factor = v_factor,
            unit = v_unit,
            line_class = p_line_class,
            pack_label = v_pack_label,
            confirm_count = 1,
            confirmers = v_actor_array,
            status = 'learning',
            last_confirmed_at = now(),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
    end if;
  end if;

  select count(distinct c) into v_distinct
  from unnest(coalesce(v_alias.confirmers, '{}'::uuid[])) c;
  if (v_alias.confirm_count >= 3 or v_distinct >= 2) and v_alias.status <> 'auto' then
    update public.stock_material_aliases
      set status = 'auto', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class
    ) values (
      v_alias.id, 'auto_promoted', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
      v_alias.line_class
    );
  end if;

  if v_alias.status <> 'auto' and public.material_alias_can_admin(v_actor) then
    update public.stock_material_aliases
      set status = 'auto', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class
    ) values (
      v_alias.id, 'auto_promoted', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
      v_alias.line_class
    );
  end if;

  if p_line_class = 'stock' then
    v_cutover := public.stock_ledger_cutover_date(p_location);
    for v_target in
      select gri.id
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      where gr.supplier_id is not distinct from p_supplier_id
        and gr.receiving_location = p_location
        and gr.status in ('confirmed', 'received')
        and (v_cutover is null or gr.receipt_date >= v_cutover)
        and public.normalize_stock_item_name(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            ) = v_norm
      order by gr.receipt_date asc, gri.created_at asc, gri.id asc
    loop
      if not public.stock_goods_receipt_item_is_posted(v_target.id) then
        if public.post_stock_goods_receipt_item(v_target.id, v_alias) then
          v_applied := v_applied + 1;
        end if;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'status', v_action,
    'alias', to_jsonb(v_alias),
    'applied_lines', v_applied,
    'promoted', v_alias.status = 'auto'
  );
end;
$$;

revoke all on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid, text) from public, anon;
grant execute on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid, text) to authenticated, service_role;

create or replace function public.confirm_material_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric,
  p_source_table text,
  p_source_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.confirm_material_alias(
    p_supplier_id,
    p_location,
    p_raw_name,
    p_raw_unit,
    p_kitchen_inventory_item_id,
    p_tan_tao_sku_id,
    p_entered_unit_label,
    p_conversion_factor,
    p_jev_item_id,
    p_jev_probability,
    p_source_table,
    p_source_id,
    'stock'
  );
end;
$$;

revoke all on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid) from public, anon;
grant execute on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid) to authenticated, service_role;

-- create_stock_material_item: the shared item is always a kitchen_inventory_items
-- row, the unit is normalized to the standard table first and the location may be
-- q7 or Tân Tạo.
create or replace function public.create_stock_material_item(
  p_name text,
  p_unit text,
  p_location text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_unit text;
  v_norm text;
  v_item uuid;
  v_existing uuid;
  v_code text;
  v_counter integer;
  v_key text;
  v_created boolean := false;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or (not public.q7_material_inventory_can_edit(v_actor)
           and not public.material_alias_can_admin(v_actor)) then
      raise exception 'create_item_forbidden' using errcode = '42501';
    end if;
  end if;

  if v_name = '' then raise exception 'item_name_required' using errcode = '22023'; end if;
  v_unit := public.normalize_stock_unit(p_unit);
  if v_unit is null then
    raise exception 'unit_not_allowed' using errcode = '23514';
  end if;

  v_norm := public.normalize_stock_item_name(v_name);
  if v_norm is null then v_norm := lower(v_name); end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('material_alias_item:' || p_request_id::text));
    select r.item_id into v_existing
    from public.material_alias_item_requests r
    where r.request_id = p_request_id;
    if v_existing is not null then
      return jsonb_build_object('item_id', v_existing, 'created', false);
    end if;
  end if;

  select kii.id into v_existing
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and public.normalize_stock_item_name(kii.name) = v_norm
  order by kii.created_at asc, kii.id asc
  limit 1;
  if v_existing is not null then
    v_item := v_existing;
  else
    select count(*) filter (where kii.item_type = 'ingredient') into v_counter
    from public.kitchen_inventory_items kii;
    loop
      v_counter := v_counter + 1;
      v_code := 'NVL-' || lpad(v_counter::text, 3, '0');
      exit when not exists (
        select 1 from public.kitchen_inventory_items kii where kii.item_code = v_code
      );
    end loop;

    v_key := 'manual:' || v_norm;
    if exists (select 1 from public.kitchen_inventory_items kii where kii.normalized_key = v_key) then
      v_key := v_key || ':' || lower(v_code);
    end if;

    insert into public.kitchen_inventory_items (
      item_code, normalized_key, item_type, name, unit, standard_unit_cost, active
    ) values (
      v_code, v_key, 'ingredient', v_name, v_unit, 0, true
    )
    returning id into v_item;
    v_created := true;
  end if;

  if p_request_id is not null then
    insert into public.material_alias_item_requests (request_id, item_id, created_by)
    values (p_request_id, v_item, v_actor)
    on conflict (request_id) do update
      set item_id = public.material_alias_item_requests.item_id;
  end if;

  return jsonb_build_object('item_id', v_item, 'created', v_created);
end;
$$;

revoke all on function public.create_stock_material_item(text, text, text, uuid) from public, anon;
grant execute on function public.create_stock_material_item(text, text, text, uuid) to authenticated, service_role;

-- ===========================================================================
-- 6. Tân Tạo NVL ledger (append-only, shared catalog items)
-- ===========================================================================

create table if not exists public.tan_tao_material_movements (
  id uuid primary key default gen_random_uuid(),
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  movement_date date not null,
  movement_type text not null check (movement_type in ('receipt', 'production_usage', 'adjustment', 'opening')),
  quantity numeric(15, 3) not null,
  unit text not null,
  source text not null check (source in (
    'goods_receipt', 'manual_adjustment', 'item_merge', 'item_merge_revert'
  )),
  source_ref_id uuid,
  source_ref_key text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tan_tao_material_movements_quantity_check check (
    (movement_type in ('receipt', 'production_usage', 'opening') and quantity > 0)
    or (movement_type = 'adjustment' and quantity <> 0)
  ),
  constraint tan_tao_material_movements_quantity_finite_check check (
    quantity::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

create index if not exists idx_tan_tao_material_movements_item_date
  on public.tan_tao_material_movements(kitchen_inventory_item_id, movement_date, created_at, id);

create unique index if not exists tan_tao_material_movements_source_ref_key_uidx
  on public.tan_tao_material_movements(source, source_ref_key)
  where source_ref_key is not null;

alter table public.tan_tao_material_movements enable row level security;
drop policy if exists tan_tao_material_movements_select on public.tan_tao_material_movements;
create policy tan_tao_material_movements_select on public.tan_tao_material_movements
  for select to authenticated
  using (public.can_view_tan_tao_warehouse());

revoke all on table public.tan_tao_material_movements from public, anon, authenticated;
grant select on table public.tan_tao_material_movements to authenticated, service_role;
grant insert, update, delete on table public.tan_tao_material_movements to service_role;

create or replace function public.tan_tao_prevent_material_movement_rewrite()
returns trigger
language plpgsql
as $$
begin
  raise exception 'tan_tao_material_movements are append-only';
end;
$$;

drop trigger if exists tan_tao_material_movements_immutable on public.tan_tao_material_movements;
create trigger tan_tao_material_movements_immutable
  before update or delete on public.tan_tao_material_movements
  for each row execute function public.tan_tao_prevent_material_movement_rewrite();

-- One posted receipt line is counted once, across the Q7 ledger, the SKU
-- warehouse documents and the new Tân Tạo NVL ledger.
create or replace function public.stock_goods_receipt_item_is_posted(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.q7_inventory_movements m
    where m.source = 'goods_receipt' and m.source_ref_key = 'gr-item:' || p_item_id::text
    union all
    select 1 from public.tan_tao_warehouse_documents d
    where d.idempotency_key = 'gr-item:' || p_item_id::text
    union all
    select 1 from public.tan_tao_material_movements t
    where t.source = 'goods_receipt' and t.source_ref_key = 'gr-item:' || p_item_id::text
  );
$$;

-- post_stock_goods_receipt_item: a Tân Tạo alias that points at a shared NVL item
-- (kitchen_inventory_item_id set) writes the append-only Tân Tạo NVL ledger. A
-- Tân Tạo alias that points at a finished-goods SKU keeps the existing document
-- path, and q7 keeps the q7 ledger.
-- Maestro review 2026-10-11: one alias (supplier + name) is used for lines
-- written in different units (Bột mì: "bao" and "kg"). A weight or volume line
-- converts by its own unit (kg -> g x1000); the alias factor only covers pack
-- and count units (bao 25kg, thùng, pack). Returns null when the line unit is
-- not a weight / volume of the same kind as the stock unit.
create or replace function public.stock_unit_line_factor(p_line_unit text, p_stock_unit text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select a.to_base / b.to_base
  from public.stock_units a, public.stock_units b
  where a.code = public.stock_unit_code(p_line_unit)
    and b.code = public.stock_unit_code(p_stock_unit)
    and a.kind in ('weight', 'volume')
    and a.kind = b.kind
    and a.base_code = b.base_code;
$$;

revoke all on function public.stock_unit_line_factor(text, text) from public, anon;
grant execute on function public.stock_unit_line_factor(text, text) to authenticated, service_role;

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

-- get_stock_ledger_overview: identical to the running version plus, for
-- 'tan_tao', the `materials` array of shared NVL items moved at Tân Tạo.
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
                 and m.movement_type = 'receipt'
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
                 and m.movement_type = 'production_usage'
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

-- Tân Tạo physical count for a shared NVL item: writes the difference as an
-- append-only adjustment and starts the Tân Tạo cutover on the first count.
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

revoke all on function public.record_tan_tao_material_count(uuid, numeric, date, text, text) from public, anon;
grant execute on function public.record_tan_tao_material_count(uuid, numeric, date, text, text) to authenticated, service_role;

-- Any new Tân Tạo NVL row that points at an already merged item is mirrored to
-- the final target, exactly like the Q7 forward trigger.
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

drop trigger if exists tan_tao_material_movements_item_merge_forward on public.tan_tao_material_movements;
create trigger tan_tao_material_movements_item_merge_forward
  after insert on public.tan_tao_material_movements
  for each row execute function public.tan_tao_material_merge_forward();

-- ===========================================================================
-- 7. Merge / revert also move the Tân Tạo NVL ledger
-- ===========================================================================

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

-- ===========================================================================
-- 8. Background new-item scan runs
-- ===========================================================================

create table if not exists public.stock_new_item_runs (
  id uuid primary key default gen_random_uuid(),
  location text not null check (location in ('q7', 'tan_tao')),
  status text not null default 'queued' check (status in ('queued', 'running', 'paused', 'done', 'failed')),
  processed integer not null default 0,
  remaining integer not null default 0,
  calls integer not null default 0,
  groups integer not null default 0,
  last_error text,
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint stock_new_item_runs_processed_check check (processed >= 0),
  constraint stock_new_item_runs_remaining_check check (remaining >= 0),
  constraint stock_new_item_runs_calls_check check (calls >= 0),
  constraint stock_new_item_runs_groups_check check (groups >= 0)
);

-- One live scan per location: a second click joins the running one.
create unique index if not exists stock_new_item_runs_active_uidx
  on public.stock_new_item_runs(location)
  where status in ('queued', 'running', 'paused');

create index if not exists idx_stock_new_item_runs_location_started
  on public.stock_new_item_runs(location, started_at desc, id desc);

alter table public.stock_new_item_runs enable row level security;
drop policy if exists stock_new_item_runs_select on public.stock_new_item_runs;
create policy stock_new_item_runs_select on public.stock_new_item_runs
  for select to authenticated
  using (public.material_alias_can_admin((select auth.uid())));

revoke all on table public.stock_new_item_runs from public, anon, authenticated;
grant select on table public.stock_new_item_runs to authenticated, service_role;
grant insert, update, delete on table public.stock_new_item_runs to service_role;

create or replace function public.get_latest_new_item_run(p_location text)
returns setof public.stock_new_item_runs
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null or not public.material_alias_can_admin(auth.uid()) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;
  return query
  select r.*
  from public.stock_new_item_runs r
  where r.location = p_location
  order by r.started_at desc, r.id desc
  limit 1;
end;
$$;

revoke all on function public.get_latest_new_item_run(text) from public, anon;
grant execute on function public.get_latest_new_item_run(text) to authenticated, service_role;

-- ===========================================================================
-- 9. Apply the catalog standardization + the 60-day document backfill
-- ===========================================================================

do $$
declare
  v_catalog jsonb;
  v_backfill jsonb;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('stock_catalog.unit_migration', 'on', true);
  v_catalog := public.standardize_stock_item_units();
  v_backfill := public.backfill_stock_document_units(60);
  perform set_config('stock_catalog.unit_migration', 'off', true);
  raise notice 'shared_catalog_units catalog=% backfill=%', v_catalog, v_backfill;
end $$;


-- ===========================================================================
-- Maestro review 2026-10-11: at Tân Tạo a Jev pick may be a finished-goods SKU.
-- The review list names it and flags it so the reviewer confirms it as a SKU.
-- ===========================================================================
drop function if exists public.get_material_alias_backlog_review(text, integer);
create function public.get_material_alias_backlog_review(p_location text, p_limit integer DEFAULT 100)
 RETURNS TABLE(normalized_name text, raw_name text, line_count bigint, supplier_id uuid, supplier_name text, last_receipt_date date, top_candidate jsonb, jev_item_id uuid, jev_item_name text, jev_unit text, jev_probability numeric, jev_line_type text, jev_source text, jev_is_sku boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  -- Owner or Q7 stock admin only.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  return query
  with lines as (
    select
      gr.supplier_id as supplier_id,
      coalesce(gr.receiving_location, s.default_receiving_location, 'q7') as location,
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
      ) as normalized_name,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as raw_name,
      gri.unit as raw_unit,
      gr.receipt_date as receipt_date
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    left join public.suppliers s on s.id = gr.supplier_id
    where gr.status in ('confirmed', 'received')
      and coalesce(s.stock_exempt, false) = false
      and coalesce(gr.receiving_location, s.default_receiving_location, 'q7') = p_location
      and p_location in ('q7', 'tan_tao')
      and public.stock_line_auto_non_stock(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) is null
      and gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
  ),
  pending as (
    select
      l.normalized_name,
      l.supplier_id,
      l.location,
      count(*)::bigint as line_count,
      max(l.receipt_date) as last_receipt_date,
      (array_agg(l.raw_name order by l.receipt_date desc, l.raw_name))[1] as raw_name
    from lines l
    where l.normalized_name is not null
      and not exists (
        select 1 from public.stock_material_aliases a
        where a.location = l.location
          and a.normalized_name = l.normalized_name
          and a.supplier_id is not distinct from l.supplier_id
      )
    group by l.normalized_name, l.supplier_id, l.location
  ),
  ordered as (
    select *
    from pending
    order by line_count desc, normalized_name asc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  select
    o.normalized_name,
    o.raw_name,
    o.line_count,
    o.supplier_id,
    sup.name as supplier_name,
    o.last_receipt_date,
    cand.top_candidate,
    nullif(cache.answer ->> 'item_id', '')::uuid as jev_item_id,
    coalesce(kii.name, ps.product_name) as jev_item_name,
    coalesce(kii.unit, ps.unit) as jev_unit,
    nullif(cache.answer ->> 'probability', '')::numeric as jev_probability,
    cache.answer ->> 'line_type' as jev_line_type,
    cache.answer ->> 'source' as jev_source,
    (kii.id is null and ps.id is not null) as jev_is_sku
  from ordered o
  left join public.suppliers sup on sup.id = o.supplier_id
  left join lateral (
    select jsonb_build_object(
      'item_id', c.item_id,
      'sku_id', c.sku_id,
      'name', c.name,
      'unit', c.unit,
      'score', c.score,
      'reason', c.reason
    ) as top_candidate
    from public.material_alias_candidates(o.raw_name, o.location, 1) c
    limit 1
  ) cand on true
  left join lateral (
    select z.answer
    from public.material_alias_jev_cache z
    where z.location = o.location
      and z.normalized_name = o.normalized_name
      and z.supplier_id is not distinct from o.supplier_id
    order by z.created_at desc, z.id desc
    limit 1
  ) cache on true
  left join public.kitchen_inventory_items kii
    on kii.id = nullif(cache.answer ->> 'item_id', '')::uuid
  left join public.product_skus ps
    on kii.id is null and ps.id = nullif(cache.answer ->> 'item_id', '')::uuid;
end;
$function$;

revoke all on function public.get_material_alias_backlog_review(text, integer) from public, anon;
grant execute on function public.get_material_alias_backlog_review(text, integer) to authenticated, service_role;
