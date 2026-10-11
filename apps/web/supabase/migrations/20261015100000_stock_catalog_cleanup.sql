-- Giai đoạn 1: Jev dọn danh mục NVL Q7.
--
-- Additive migration for the Q7 stock catalog cleanup. It adds the classification
-- and merge-tracking columns to kitchen_inventory_items, the suggestion / usage /
-- merge-log tables, an immutable unit-conversion helper shared with the TS layer,
-- and the security-definer RPCs that build Jev candidates, record approved
-- suggestions, apply a merge with per-row rollback logging, revert it, link
-- kitchen items to an approved canonical material and expose one review payload.
--
-- Nothing here touches payment_requests, goods_receipts, purchase_orders or
-- payment_allocations, and no merge is ever applied automatically.

-- ---------------------------------------------------------------------------
-- 1. kitchen_inventory_items: classification + merge bookkeeping
-- ---------------------------------------------------------------------------

alter table public.kitchen_inventory_items
  add column if not exists item_class text,
  add column if not exists item_class_source text,
  add column if not exists merged_into_id uuid references public.kitchen_inventory_items(id),
  add column if not exists merged_factor numeric(18, 8),
  add column if not exists merged_at timestamptz;

alter table public.kitchen_inventory_items
  drop constraint if exists kitchen_inventory_items_item_class_check;
alter table public.kitchen_inventory_items
  add constraint kitchen_inventory_items_item_class_check
  check (item_class is null or item_class in ('raw_material', 'packaging_supply', 'finished_goods', 'non_stock'));

alter table public.kitchen_inventory_items
  drop constraint if exists kitchen_inventory_items_item_class_source_check;
alter table public.kitchen_inventory_items
  add constraint kitchen_inventory_items_item_class_source_check
  check (item_class_source is null or item_class_source in ('jev', 'manual'));

alter table public.kitchen_inventory_items
  drop constraint if exists kitchen_inventory_items_merged_factor_check;
alter table public.kitchen_inventory_items
  add constraint kitchen_inventory_items_merged_factor_check
  check (
    merged_factor is null
    or (merged_factor > 0 and merged_factor::text not in ('NaN', 'Infinity', '-Infinity'))
  );

create index if not exists idx_kitchen_inventory_items_active_class
  on public.kitchen_inventory_items(item_type, active, item_class);
create index if not exists idx_kitchen_inventory_items_merged_into
  on public.kitchen_inventory_items(merged_into_id) where merged_into_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Immutable unit conversion shared with src/lib/stock-catalog.ts
-- ---------------------------------------------------------------------------

create or replace function public.stock_catalog_normalize_unit(p_unit text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when n.value is null then null
    when n.value in ('kilogram', 'kg') then 'kg'
    when n.value in ('gram', 'gr', 'g') then 'g'
    when n.value in ('lit', 'l') then 'l'
    when n.value = 'ml' then 'ml'
    else n.value
  end
  from (select public.normalize_stock_item_name(p_unit) as value) n;
$$;

create or replace function public.stock_unit_factor(p_from text, p_to text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  with units as (
    select public.stock_catalog_normalize_unit(p_from) as from_unit,
           public.stock_catalog_normalize_unit(p_to) as to_unit
  )
  select case
    when u.from_unit is null or u.to_unit is null then null::numeric
    when u.from_unit = u.to_unit then 1::numeric
    when u.from_unit = 'kg' and u.to_unit = 'g' then 1000::numeric
    when u.from_unit = 'g' and u.to_unit = 'kg' then 0.001::numeric
    when u.from_unit = 'l' and u.to_unit = 'ml' then 1000::numeric
    when u.from_unit = 'ml' and u.to_unit = 'l' then 0.001::numeric
    else null::numeric
  end
  from units u;
$$;

-- Tokens used by the candidate matcher: normalized words without numbers or
-- counting/measure unit tokens, so "Bột mì 888" and "Bột mì 888 (25kg)" match.
create or replace function public.stock_catalog_item_tokens(p_name text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct token order by token), '{}'::text[])
  from unnest(regexp_split_to_array(coalesce(public.normalize_stock_item_name(p_name), ''), '\s+')) as token
  where token <> ''
    and token !~ '^[0-9]+$'
    and token <> all (array[
      'kg', 'g', 'gr', 'gram', 'kilogram',
      'l', 'lit', 'ml',
      'qua', 'hop', 'cai', 'chiec', 'chai', 'goi', 'bao', 'thung', 'ky'
    ]::text[]);
$$;

create or replace function public.stock_catalog_token_jaccard(p_left text, p_right text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  with l as (select public.stock_catalog_item_tokens(p_left) as t),
       r as (select public.stock_catalog_item_tokens(p_right) as t),
       s as (select l.t as lt, r.t as rt from l, r),
       i as (select count(*)::numeric as n from s, unnest(s.lt) as token where token = any(s.rt))
  select case
    when cardinality(s.lt) = 0 or cardinality(s.rt) = 0 then 0::numeric
    else i.n / nullif(cardinality(s.lt) + cardinality(s.rt) - i.n, 0)
  end
  from s, i;
$$;

-- ---------------------------------------------------------------------------
-- 3. Suggestion, usage and merge-log tables
-- ---------------------------------------------------------------------------

create table if not exists public.stock_catalog_suggestions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('merge', 'classify')),
  item_id uuid not null references public.kitchen_inventory_items(id) on delete cascade,
  other_item_id uuid references public.kitchen_inventory_items(id) on delete cascade,
  proposed_target_id uuid references public.kitchen_inventory_items(id) on delete set null,
  proposed_factor numeric(18, 8),
  factor_source text check (factor_source is null or factor_source in ('unit_rule', 'none')),
  proposed_class text check (
    proposed_class is null
    or proposed_class in ('raw_material', 'packaging_supply', 'finished_goods', 'non_stock')
  ),
  probability numeric(5, 4) not null,
  jev_answer jsonb,
  prompt_version text not null,
  cost numeric(18, 8),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'applied', 'reverted', 'superseded')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint stock_catalog_suggestions_probability_check check (
    probability >= 0 and probability <= 1
  ),
  constraint stock_catalog_suggestions_factor_check check (
    proposed_factor is null
    or (proposed_factor > 0 and proposed_factor::text not in ('NaN', 'Infinity', '-Infinity'))
  ),
  constraint stock_catalog_suggestions_kind_shape_check check (
    (kind = 'merge' and other_item_id is not null and proposed_target_id is not null and proposed_class is null)
    or (kind = 'classify' and other_item_id is null and proposed_target_id is null and proposed_class is not null)
  )
);

-- Re-scanning the same pair with the same prompt must never create a duplicate.
create unique index if not exists stock_catalog_suggestions_pair_prompt_uidx
  on public.stock_catalog_suggestions (
    kind,
    least(item_id, coalesce(other_item_id, item_id)),
    greatest(item_id, coalesce(other_item_id, item_id)),
    prompt_version
  );

create index if not exists idx_stock_catalog_suggestions_status
  on public.stock_catalog_suggestions(status, kind, created_at desc);

create table if not exists public.stock_catalog_jev_usage (
  usage_date date primary key,
  calls integer not null default 0 check (calls >= 0),
  cost numeric(18, 8) not null default 0 check (cost >= 0 and cost::text not in ('NaN', 'Infinity', '-Infinity')),
  call_limit integer not null default 600 check (call_limit > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.stock_item_merges (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  target_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  factor numeric(18, 8) not null,
  status text not null default 'applied' check (status in ('applied', 'reverted')),
  applied_by uuid references auth.users(id) on delete set null,
  applied_at timestamptz not null default now(),
  reverted_by uuid references auth.users(id) on delete set null,
  reverted_at timestamptz,
  suggestion_id uuid references public.stock_catalog_suggestions(id) on delete set null,
  constraint stock_item_merges_factor_check check (
    factor > 0 and factor::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint stock_item_merges_distinct_items_check check (source_id <> target_id)
);

create index if not exists idx_stock_item_merges_target
  on public.stock_item_merges(target_id, status, applied_at desc);
create index if not exists idx_stock_item_merges_source
  on public.stock_item_merges(source_id, status);

create table if not exists public.stock_item_merge_rows (
  id uuid primary key default gen_random_uuid(),
  merge_id uuid not null references public.stock_item_merges(id) on delete cascade,
  table_name text not null,
  row_id uuid not null,
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_stock_item_merge_rows_merge
  on public.stock_item_merge_rows(merge_id, created_at, id);

-- ---------------------------------------------------------------------------
-- 4. RLS and explicit grants
-- ---------------------------------------------------------------------------

alter table public.stock_catalog_suggestions enable row level security;
alter table public.stock_catalog_jev_usage enable row level security;
alter table public.stock_item_merges enable row level security;
alter table public.stock_item_merge_rows enable row level security;

drop policy if exists stock_catalog_suggestions_select on public.stock_catalog_suggestions;
create policy stock_catalog_suggestions_select on public.stock_catalog_suggestions
  for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

drop policy if exists stock_catalog_jev_usage_select on public.stock_catalog_jev_usage;
create policy stock_catalog_jev_usage_select on public.stock_catalog_jev_usage
  for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

drop policy if exists stock_item_merges_select on public.stock_item_merges;
create policy stock_item_merges_select on public.stock_item_merges
  for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

drop policy if exists stock_item_merge_rows_select on public.stock_item_merge_rows;
create policy stock_item_merge_rows_select on public.stock_item_merge_rows
  for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

-- Read-only for signed-in users; every write goes through a security definer RPC
-- (or the service role used by the edge function).
revoke all on table public.stock_catalog_suggestions from public, anon, authenticated;
grant select on table public.stock_catalog_suggestions to authenticated, service_role;
grant insert, update, delete on table public.stock_catalog_suggestions to service_role;

revoke all on table public.stock_catalog_jev_usage from public, anon, authenticated;
grant select on table public.stock_catalog_jev_usage to authenticated, service_role;
grant insert, update, delete on table public.stock_catalog_jev_usage to service_role;

revoke all on table public.stock_item_merges from public, anon, authenticated;
grant select on table public.stock_item_merges to authenticated, service_role;
grant insert, update, delete on table public.stock_item_merges to service_role;

revoke all on table public.stock_item_merge_rows from public, anon, authenticated;
grant select on table public.stock_item_merge_rows to authenticated, service_role;
grant insert, update, delete on table public.stock_item_merge_rows to service_role;

-- ---------------------------------------------------------------------------
-- 5. Candidate pairs for Jev (view gate only, deterministic order)
-- ---------------------------------------------------------------------------

create or replace function public.get_stock_catalog_candidates()
returns table (
  left_id uuid,
  right_id uuid,
  left_name text,
  right_name text,
  left_unit text,
  right_unit text,
  left_item_type text,
  right_item_type text,
  left_issue_count_90d bigint,
  right_issue_count_90d bigint,
  left_movement_count_90d bigint,
  right_movement_count_90d bigint,
  left_canonical_material_id uuid,
  right_canonical_material_id uuid,
  left_canonical_material_code text,
  right_canonical_material_code text,
  left_to_right_factor numeric,
  right_to_left_factor numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_since date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_since := (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90;

  return query
  with items as (
    select
      kii.id,
      kii.name,
      kii.unit,
      kii.item_type,
      kii.canonical_material_id,
      scm.material_code,
      public.normalize_stock_item_name(kii.name) as norm
    from public.kitchen_inventory_items kii
    left join public.sku_cogs_materials scm on scm.id = kii.canonical_material_id
    where kii.active = true
  ),
  pairs as (
    select
      a.id as left_id, b.id as right_id,
      a.name as left_name, b.name as right_name,
      a.unit as left_unit, b.unit as right_unit,
      a.item_type as left_item_type, b.item_type as right_item_type,
      a.canonical_material_id as left_canonical_material_id,
      b.canonical_material_id as right_canonical_material_id,
      a.material_code as left_canonical_material_code,
      b.material_code as right_canonical_material_code
    from items a
    join items b on a.id < b.id and a.item_type = b.item_type
    where (a.norm is not null and a.norm = b.norm)
       or public.stock_catalog_token_jaccard(a.name, b.name) >= 0.6
  )
  select
    p.left_id, p.right_id, p.left_name, p.right_name, p.left_unit, p.right_unit,
    p.left_item_type, p.right_item_type,
    (
      select count(*)
      from public.production_material_issue_items pmii
      join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
      where pmii.kitchen_inventory_item_id = p.left_id and pmi.issue_date >= v_since
    ),
    (
      select count(*)
      from public.production_material_issue_items pmii
      join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
      where pmii.kitchen_inventory_item_id = p.right_id and pmi.issue_date >= v_since
    ),
    (
      select count(*) from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = p.left_id and m.movement_date >= v_since
    ),
    (
      select count(*) from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = p.right_id and m.movement_date >= v_since
    ),
    p.left_canonical_material_id, p.right_canonical_material_id,
    p.left_canonical_material_code, p.right_canonical_material_code,
    public.stock_unit_factor(p.left_unit, p.right_unit),
    public.stock_unit_factor(p.right_unit, p.left_unit)
  from pairs p
  order by p.left_id, p.right_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Merge resolution, item_merge movement sources and the forward trigger
-- ---------------------------------------------------------------------------
--
-- The Q7 ledger is append-only: q7_inventory_movements has a BEFORE UPDATE OR
-- DELETE trigger and q7_inventory_opening_audit_logs is immutable. A merge can
-- therefore never rewrite history; it retires the source item and moves its
-- on-hand stock to the target with signed adjustment movements.

-- Keep every source value the applied 20261013100000 migration already allows
-- and add the two keys used to move stock across a merge.
alter table public.q7_inventory_movements
  drop constraint if exists q7_inventory_movements_source_check;
alter table public.q7_inventory_movements
  add constraint q7_inventory_movements_source_check
  check (source in (
    'manual_receipt', 'signed_q7_issue', 'manual_adjustment',
    'goods_receipt', 'production_material_issue', 'production_material_issue_reversal',
    'item_merge', 'item_merge_revert'
  ));

-- Walk merged_into_id up to five hops and multiply merged_factor on the way.
-- Raises for a missing item, a missing factor, a cycle or a chain deeper than 5.
create or replace function public.stock_item_merge_resolve(p_item uuid)
returns table (target_id uuid, factor numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_current uuid := p_item;
  v_next uuid;
  v_step_factor numeric;
  v_factor numeric := 1;
  v_seen uuid[] := array[p_item];
  v_depth integer := 0;
begin
  if p_item is null then
    raise exception 'merge_resolve_item_required' using errcode = '22023';
  end if;

  loop
    select kii.merged_into_id, kii.merged_factor
      into v_next, v_step_factor
    from public.kitchen_inventory_items kii
    where kii.id = v_current;

    if not found then
      raise exception 'merge_resolve_item_not_found: %', v_current using errcode = 'P0002';
    end if;
    if v_next is null then
      return query select v_current, v_factor;
      return;
    end if;
    if v_step_factor is null or v_step_factor <= 0 then
      raise exception 'merge_resolve_factor_invalid: item % has merged_into_id without a positive merged_factor', v_current
        using errcode = '23514';
    end if;
    if v_next = any (v_seen) then
      raise exception 'merge_resolve_cycle: merge chain from % loops back to %', p_item, v_next
        using errcode = '23514';
    end if;

    v_depth := v_depth + 1;
    if v_depth > 5 then
      raise exception 'merge_resolve_too_deep: merge chain from % exceeds 5 steps', p_item
        using errcode = '23514';
    end if;

    v_factor := v_factor * v_step_factor;
    v_seen := v_seen || v_next;
    v_current := v_next;
  end loop;
end;
$$;

-- Any new ledger row that points at an item already merged into another one is
-- mirrored to the final target: the source gets an offsetting adjustment so it
-- stays at zero and the target receives the same on-hand change times factor.
-- Rows written by this function use source item_merge/item_merge_revert and are
-- skipped, so the trigger never recurses.
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

drop trigger if exists q7_inventory_movements_item_merge_forward on public.q7_inventory_movements;
create trigger q7_inventory_movements_item_merge_forward
  after insert on public.q7_inventory_movements
  for each row execute function public.stock_item_merge_forward();

-- ---------------------------------------------------------------------------
-- 7. Merge engine with per-row logging
-- ---------------------------------------------------------------------------

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

  -- Move the on-hand stock as an append-only transfer pair. Read the balance
  -- before any mapping moves so get_q7_inventory_snapshot still sees the source.
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

  -- 1. production_material_issue_items: required_qty × factor, unit -> target.
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

  -- 2. q7_material_issue_material_mappings: conversion_factor × factor, unit -> target.
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

  -- 3. stock_material_aliases: conversion_factor × factor, unit -> target.
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

  -- 4. q7_purchase_item_settings: unique per item; delete the source row when the
  -- target already has settings, otherwise move it.
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

  -- Finally retire the source item and mark the suggestion applied.
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

-- ---------------------------------------------------------------------------
-- 8. Decide a suggestion (approve / reject)
-- ---------------------------------------------------------------------------

create or replace function public.decide_stock_catalog_suggestion(
  p_id uuid,
  p_action text,
  p_factor numeric default null,
  p_class text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_suggestion public.stock_catalog_suggestions%rowtype;
  v_class text;
  v_class_source text;
  v_factor numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_action not in ('approve', 'reject') then
    raise exception 'suggestion_action_invalid' using errcode = '22023';
  end if;

  select * into v_suggestion from public.stock_catalog_suggestions where id = p_id for update;
  if not found then raise exception 'suggestion_not_found' using errcode = 'P0002'; end if;

  if p_action = 'reject' then
    if v_suggestion.status = 'rejected' then
      return jsonb_build_object('status', 'already_rejected', 'suggestion_id', p_id);
    end if;
    if v_suggestion.status <> 'pending' then
      raise exception 'suggestion_not_pending' using errcode = '23514';
    end if;
    update public.stock_catalog_suggestions
      set status = 'rejected', decided_by = v_actor_id, decided_at = now()
      where id = p_id;
    return jsonb_build_object('status', 'rejected', 'suggestion_id', p_id);
  end if;

  -- approve
  if v_suggestion.status = 'applied' then
    return jsonb_build_object('status', 'already_applied', 'suggestion_id', p_id, 'kind', v_suggestion.kind);
  end if;
  if v_suggestion.status <> 'pending' then
    raise exception 'suggestion_not_pending' using errcode = '23514';
  end if;

  if v_suggestion.kind = 'classify' then
    v_class := coalesce(p_class, v_suggestion.proposed_class);
    if v_class is null or v_class not in ('raw_material', 'packaging_supply', 'finished_goods', 'non_stock') then
      raise exception 'suggestion_class_invalid' using errcode = '22023';
    end if;
    v_class_source := case
      when p_class is not null and p_class is distinct from v_suggestion.proposed_class then 'manual'
      else 'jev'
    end;
    update public.kitchen_inventory_items
      set item_class = v_class,
          item_class_source = v_class_source,
          updated_at = now()
      where id = v_suggestion.item_id;
    update public.stock_catalog_suggestions
      set status = 'applied',
          proposed_class = v_class,
          decided_by = v_actor_id,
          decided_at = now()
      where id = p_id;
    return jsonb_build_object(
      'status', 'applied',
      'kind', 'classify',
      'suggestion_id', p_id,
      'item_id', v_suggestion.item_id,
      'item_class', v_class,
      'item_class_source', v_class_source
    );
  end if;

  -- merge
  v_factor := coalesce(p_factor, v_suggestion.proposed_factor);
  if v_factor is null or v_factor <= 0 or v_factor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'merge_factor_required' using errcode = '22023';
  end if;
  return public.apply_stock_item_merge(
    v_suggestion.item_id,
    v_suggestion.proposed_target_id,
    v_factor,
    p_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Revert an applied merge from its per-row log
-- ---------------------------------------------------------------------------

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

  -- A newer effective merge touching the target makes a safe revert impossible.
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

  -- Restore only the four reference tables the merge actually moved/converted.
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
      -- Row was deleted by the merge, restore the exact old row (same id).
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

  -- The ledger is append-only: reverse the merge rows with new adjustments.
  -- This covers the transfer pair plus every row the forward trigger mirrored.
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
    'movements_reversed', v_movements
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Link kitchen items to a single approved canonical material mapping
-- ---------------------------------------------------------------------------

create or replace function public.link_kitchen_items_to_canonical_materials()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_linked integer := 0;
  v_ambiguous jsonb := '[]'::jsonb;
  v_linkable jsonb := '[]'::jsonb;
  r record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  for r in
    select
      kii.id as item_id,
      kii.name as item_name,
      kii.unit as item_unit,
      count(distinct m.canonical_material_id)::integer as material_count,
      (array_agg(distinct m.canonical_material_id))[1] as material_id
    from public.kitchen_inventory_items kii
    join public.q7_material_issue_material_mappings m
      on m.kitchen_inventory_item_id = kii.id
     and m.approval_status = 'approved'
    join public.sku_cogs_materials scm
      on scm.id = m.canonical_material_id
     and scm.active = true
    where kii.active = true
      and kii.canonical_material_id is null
    group by kii.id, kii.name, kii.unit
    order by kii.id
  loop
    if r.material_count = 1 then
      -- Report only: kitchen_inventory_items.canonical_material_id can be written
      -- solely by link_approved_material_resolution (guarded by
      -- guard_canonical_material_link_update and a resolved request). The actual
      -- link goes through Material Master in Giai đoạn 2.
      v_linkable := v_linkable || jsonb_build_object(
        'item_id', r.item_id,
        'item_name', r.item_name,
        'item_unit', r.item_unit,
        'material_id', r.material_id
      );
      v_linked := v_linked + 1;
    else
      v_ambiguous := v_ambiguous || jsonb_build_object(
        'item_id', r.item_id,
        'item_name', r.item_name,
        'item_unit', r.item_unit,
        'mapping_material_count', r.material_count
      );
    end if;
  end loop;

  return jsonb_build_object('linkable_count', v_linked, 'linkable_items', v_linkable, 'ambiguous_items', v_ambiguous, 'writes', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. One review payload for the reviewer screen
-- ---------------------------------------------------------------------------

create or replace function public.get_stock_catalog_review()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_pending jsonb := '[]'::jsonb;
  v_merges jsonb := '[]'::jsonb;
  v_classes jsonb := '{}'::jsonb;
  v_usage jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'kind', s.kind,
    'item_id', s.item_id,
    'item_name', i.name,
    'item_unit', i.unit,
    'other_item_id', s.other_item_id,
    'other_item_name', oi.name,
    'other_item_unit', oi.unit,
    'proposed_target_id', s.proposed_target_id,
    'target_name', ti.name,
    'target_unit', ti.unit,
    'probability', s.probability,
    'proposed_factor', s.proposed_factor,
    'factor_source', s.factor_source,
    'proposed_class', s.proposed_class,
    'prompt_version', s.prompt_version,
    'cost', s.cost,
    'created_at', s.created_at,
    'item_issue_count_90d', (
      select count(*) from public.production_material_issue_items pmii
      join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
      where pmii.kitchen_inventory_item_id = s.item_id
        and pmi.issue_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
    ),
    'other_issue_count_90d', case when s.other_item_id is null then null else (
      select count(*) from public.production_material_issue_items pmii
      join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
      where pmii.kitchen_inventory_item_id = s.other_item_id
        and pmi.issue_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
    ) end
  ) order by s.created_at desc, s.id), '[]'::jsonb)
    into v_pending
  from public.stock_catalog_suggestions s
  join public.kitchen_inventory_items i on i.id = s.item_id
  left join public.kitchen_inventory_items oi on oi.id = s.other_item_id
  left join public.kitchen_inventory_items ti on ti.id = s.proposed_target_id
  where s.status = 'pending';

  select coalesce(jsonb_agg(jsonb_build_object(
    'merge_id', m.id,
    'source_id', m.source_id,
    'source_name', si.name,
    'target_id', m.target_id,
    'target_name', ti.name,
    'factor', m.factor,
    'status', m.status,
    'applied_at', m.applied_at,
    'reverted_at', m.reverted_at,
    'can_revert', (
      m.status = 'applied'
      and not exists (
        select 1 from public.stock_item_merges x
        where x.status = 'applied'
          and x.id <> m.id
          and (x.target_id = m.target_id or x.source_id = m.target_id)
          and (x.applied_at, x.id) > (m.applied_at, m.id)
      )
    )
  ) order by m.applied_at desc, m.id), '[]'::jsonb)
    into v_merges
  from (
    select * from public.stock_item_merges order by applied_at desc, id limit 20
  ) m
  join public.kitchen_inventory_items si on si.id = m.source_id
  join public.kitchen_inventory_items ti on ti.id = m.target_id;

  select coalesce(jsonb_object_agg(class_key, class_count), '{}'::jsonb)
    into v_classes
  from (
    select coalesce(item_class, 'unclassified') as class_key, count(*)::integer as class_count
    from public.kitchen_inventory_items
    where active = true
    group by coalesce(item_class, 'unclassified')
  ) c;

  select jsonb_build_object(
    'usage_date', v_today,
    'calls', coalesce(u.calls, 0),
    'cost', coalesce(u.cost, 0),
    'call_limit', coalesce(u.call_limit, 600)
  )
    into v_usage
  from (select 1) one
  left join public.stock_catalog_jev_usage u on u.usage_date = v_today;

  return jsonb_build_object(
    'pending_suggestions', v_pending,
    'recent_merges', v_merges,
    'item_class_counts', v_classes,
    'jev_usage', v_usage
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.stock_catalog_normalize_unit(text) from public, anon;
grant execute on function public.stock_catalog_normalize_unit(text) to authenticated, service_role;

revoke all on function public.stock_unit_factor(text, text) from public, anon;
grant execute on function public.stock_unit_factor(text, text) to authenticated, service_role;

revoke all on function public.stock_catalog_item_tokens(text) from public, anon;
grant execute on function public.stock_catalog_item_tokens(text) to authenticated, service_role;

revoke all on function public.stock_catalog_token_jaccard(text, text) from public, anon;
grant execute on function public.stock_catalog_token_jaccard(text, text) to authenticated, service_role;

revoke all on function public.get_stock_catalog_candidates() from public, anon;
grant execute on function public.get_stock_catalog_candidates() to authenticated, service_role;

revoke all on function public.stock_item_merge_resolve(uuid) from public, anon;
grant execute on function public.stock_item_merge_resolve(uuid) to authenticated, service_role;

-- Trigger-only helper: never callable directly by a client role.
revoke all on function public.stock_item_merge_forward() from public, anon, authenticated;

revoke all on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid) from public, anon;
grant execute on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid) to authenticated, service_role;

revoke all on function public.decide_stock_catalog_suggestion(uuid, text, numeric, text) from public, anon;
grant execute on function public.decide_stock_catalog_suggestion(uuid, text, numeric, text) to authenticated, service_role;

revoke all on function public.revert_stock_item_merge(uuid) from public, anon;
grant execute on function public.revert_stock_item_merge(uuid) to authenticated, service_role;

revoke all on function public.link_kitchen_items_to_canonical_materials() from public, anon;
grant execute on function public.link_kitchen_items_to_canonical_materials() to authenticated, service_role;

revoke all on function public.get_stock_catalog_review() from public, anon;
grant execute on function public.get_stock_catalog_review() to authenticated, service_role;
