-- 2026-10-24 — Nhiệm vụ, huy hiệu Chăm chỉ và thăng cấp (phần dữ liệu).
--
-- Additive migration on top of 20261023100000_warehouse_game.sql. It adds:
--   1. public.mission_badges / public.mission_levels — huy hiệu và mốc thăng cấp.
--   2. public.missions / public.mission_badge_awards / public.mission_requests —
--      nhiệm vụ theo người, huy hiệu đã nhận (chỉ ghi thêm) và nhật ký idempotency.
--   3. public.stock_item_distinct_pairs / public.stock_unit_ignored_variants —
--      quyết định của quản trị: một cặp hàng là hai mặt hàng khác nhau, hoặc một
--      cách viết đơn vị không phải hàng kho.
--   4. public.mission_evaluate(uuid) — chấm điểm một nhiệm vụ theo dữ liệu sống.
--   5. Các RPC client: get_my_missions, complete_mission,
--      update_stock_material_alias_factor, mark_stock_items_distinct,
--      resolve_unknown_purchase_unit.
--   6. Gieo 3 nhiệm vụ kho cho chủ sở hữu (tra theo dữ liệu, không hard-code UUID).
--
-- Không ghi đè bảng / hàm của tính lương (payroll_bn_missions) hay của game kho.
-- Không viết lại chứng từ: các hàm ở đây chỉ đọc dữ liệu sống.

-- ===========================================================================
-- 1. Huy hiệu và mốc thăng cấp
-- ===========================================================================

create table if not exists public.mission_badges (
  code text primary key,
  name text not null,
  icon text not null,
  description text,
  constraint mission_badges_code_check check (btrim(code) <> '')
);

insert into public.mission_badges (code, name, icon, description) values
  ('cham_chi', 'Chăm chỉ', '🐝', 'Hoàn thành một nhiệm vụ')
on conflict (code) do update
  set name = excluded.name,
      icon = excluded.icon,
      description = excluded.description;

create table if not exists public.mission_levels (
  level integer primary key,
  title text not null,
  min_badges integer not null,
  constraint mission_levels_level_check check (level > 0),
  constraint mission_levels_min_badges_check check (min_badges >= 0),
  constraint mission_levels_min_badges_key unique (min_badges),
  constraint mission_levels_title_check check (btrim(title) <> '')
);

insert into public.mission_levels (level, title, min_badges) values
  (1, 'Tập sự', 0),
  (2, 'Thợ kho', 3),
  (3, 'Thợ lành nghề', 7),
  (4, 'Thợ cả', 12),
  (5, 'Quản kho', 20)
on conflict (level) do update
  set title = excluded.title,
      min_badges = excluded.min_badges;

-- ===========================================================================
-- 2. Nhiệm vụ, huy hiệu đã nhận và nhật ký idempotency
-- ===========================================================================

create table if not exists public.missions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  area text not null default 'warehouse',
  title text not null,
  description text,
  assignee_user_id uuid not null references auth.users(id) on delete cascade,
  check_rule text not null,
  check_params jsonb not null,
  badge_code text not null default 'cham_chi' references public.mission_badges(code),
  sort_order integer,
  status text not null default 'open',
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  evidence jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint missions_check_rule_check check (
    check_rule in (
      'stock_alias_factor_fixed',
      'stock_duplicate_resolved',
      'stock_unknown_units_cleared'
    )
  ),
  constraint missions_status_check check (status in ('open', 'completed', 'cancelled'))
);

create index if not exists idx_missions_assignee
  on public.missions(assignee_user_id, status, sort_order);

create table if not exists public.mission_badge_awards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  badge_code text not null references public.mission_badges(code),
  mission_id uuid unique references public.missions(id) on delete set null,
  awarded_at timestamptz not null default now()
);

create index if not exists idx_mission_badge_awards_user
  on public.mission_badge_awards(user_id, awarded_at desc);

create table if not exists public.mission_requests (
  request_id uuid primary key,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint mission_requests_kind_check check (btrim(kind) <> '')
);

create index if not exists idx_mission_requests_kind
  on public.mission_requests(kind, created_at desc);

create table if not exists public.stock_item_distinct_pairs (
  item_a uuid not null references public.kitchen_inventory_items(id) on delete cascade,
  item_b uuid not null references public.kitchen_inventory_items(id) on delete cascade,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now(),
  primary key (item_a, item_b),
  constraint stock_item_distinct_pairs_order_check check (item_a < item_b)
);

create table if not exists public.stock_unit_ignored_variants (
  variant text primary key,
  reason text,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now(),
  constraint stock_unit_ignored_variants_variant_check check (
    btrim(variant) <> '' and variant = lower(btrim(variant))
  )
);

-- Chỉ ghi thêm: một huy hiệu đã nhận không được sửa hay xoá.
create or replace function public.mission_badge_awards_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'mission_badge_awards_append_only' using errcode = '42501';
end;
$$;

revoke all on function public.mission_badge_awards_append_only() from public, anon;
grant execute on function public.mission_badge_awards_append_only() to service_role;

drop trigger if exists mission_badge_awards_append_only on public.mission_badge_awards;
create trigger mission_badge_awards_append_only
  before update or delete on public.mission_badge_awards
  for each row execute function public.mission_badge_awards_append_only();

-- ===========================================================================
-- 3. RLS và quyền
-- ===========================================================================

alter table public.mission_badges enable row level security;
alter table public.mission_levels enable row level security;
alter table public.missions enable row level security;
alter table public.mission_badge_awards enable row level security;
alter table public.mission_requests enable row level security;
alter table public.stock_item_distinct_pairs enable row level security;
alter table public.stock_unit_ignored_variants enable row level security;

drop policy if exists mission_badges_select on public.mission_badges;
create policy mission_badges_select on public.mission_badges
  for select to authenticated using (true);

drop policy if exists mission_levels_select on public.mission_levels;
create policy mission_levels_select on public.mission_levels
  for select to authenticated using (true);

drop policy if exists missions_select on public.missions;
create policy missions_select on public.missions
  for select to authenticated
  using (
    assignee_user_id = (select auth.uid())
    or public.material_alias_can_admin((select auth.uid()))
  );

drop policy if exists mission_badge_awards_select on public.mission_badge_awards;
create policy mission_badge_awards_select on public.mission_badge_awards
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.material_alias_can_admin((select auth.uid()))
  );

drop policy if exists mission_requests_select on public.mission_requests;
create policy mission_requests_select on public.mission_requests
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.material_alias_can_admin((select auth.uid()))
  );

drop policy if exists stock_item_distinct_pairs_select on public.stock_item_distinct_pairs;
create policy stock_item_distinct_pairs_select on public.stock_item_distinct_pairs
  for select to authenticated
  using (public.material_alias_can_admin((select auth.uid())));

drop policy if exists stock_unit_ignored_variants_select on public.stock_unit_ignored_variants;
create policy stock_unit_ignored_variants_select on public.stock_unit_ignored_variants
  for select to authenticated
  using (public.material_alias_can_admin((select auth.uid())));

revoke all on table public.mission_badges from public, anon, authenticated;
grant select on table public.mission_badges to authenticated, service_role;
grant insert, update, delete on table public.mission_badges to service_role;

revoke all on table public.mission_levels from public, anon, authenticated;
grant select on table public.mission_levels to authenticated, service_role;
grant insert, update, delete on table public.mission_levels to service_role;

revoke all on table public.missions from public, anon, authenticated;
grant select on table public.missions to authenticated, service_role;
grant insert, update, delete on table public.missions to service_role;

revoke all on table public.mission_badge_awards from public, anon, authenticated;
grant select on table public.mission_badge_awards to authenticated, service_role;
grant insert, update, delete on table public.mission_badge_awards to service_role;

revoke all on table public.mission_requests from public, anon, authenticated;
grant select on table public.mission_requests to authenticated, service_role;
grant insert, update, delete on table public.mission_requests to service_role;

revoke all on table public.stock_item_distinct_pairs from public, anon, authenticated;
grant select on table public.stock_item_distinct_pairs to authenticated, service_role;
grant insert, update, delete on table public.stock_item_distinct_pairs to service_role;

revoke all on table public.stock_unit_ignored_variants from public, anon, authenticated;
grant select on table public.stock_unit_ignored_variants to authenticated, service_role;
grant insert, update, delete on table public.stock_unit_ignored_variants to service_role;

-- ===========================================================================
-- 4. Dùng chung truy vấn đơn vị lạ: helper nội bộ + RPC
-- ===========================================================================
--
-- Helper trả đúng các nhóm mà list_unknown_purchase_units vẫn trả, nhưng bỏ những
-- cách viết đã được đánh dấu "không phải hàng kho". RPC và phần chấm nhiệm vụ
-- cùng gọi helper này nên luôn khớp nhau.

create or replace function public.stock_unknown_purchase_unit_rows(p_days integer default 60)
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
  return query
  with units as (
    select 'purchase_order_items'::text as source_table, i.unit, i.product_name
    from public.purchase_order_items i
    join public.purchase_orders p on p.id = i.purchase_order_id
    where coalesce(p.order_date, p.created_at::date) >= v_today - v_days
      and i.unit is not null
      and public.normalize_stock_unit(i.unit) is null
      and not exists (
        select 1 from public.stock_unit_ignored_variants g
        where g.variant = lower(btrim(i.unit))
      )
    union all
    select 'payment_request_items', i.unit, i.product_name
    from public.payment_request_items i
    join public.payment_requests pr on pr.id = i.payment_request_id
    where pr.created_at >= now() - (v_days || ' days')::interval
      and i.unit is not null
      and public.normalize_stock_unit(i.unit) is null
      and not exists (
        select 1 from public.stock_unit_ignored_variants g
        where g.variant = lower(btrim(i.unit))
      )
    union all
    select 'goods_receipt_items', i.unit, i.product_name
    from public.goods_receipt_items i
    join public.goods_receipts g on g.id = i.goods_receipt_id
    where g.receipt_date >= v_today - v_days
      and i.unit is not null
      and public.normalize_stock_unit(i.unit) is null
      and not exists (
        select 1 from public.stock_unit_ignored_variants gv
        where gv.variant = lower(btrim(i.unit))
      )
  )
  select u.unit, count(*)::bigint, min(u.product_name), u.source_table
  from units u
  group by u.unit, u.source_table
  order by count(*) desc, u.unit asc, u.source_table asc;
end;
$$;

revoke all on function public.stock_unknown_purchase_unit_rows(integer) from public, anon, authenticated;
grant execute on function public.stock_unknown_purchase_unit_rows(integer) to service_role;

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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null or not public.material_alias_can_admin(auth.uid()) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  return query
  select r.unit, r.line_count, r.example_name, r.source_table
  from public.stock_unknown_purchase_unit_rows(p_days) r;
end;
$$;

revoke all on function public.list_unknown_purchase_units(integer) from public, anon;
grant execute on function public.list_unknown_purchase_units(integer) to authenticated, service_role;

-- ===========================================================================
-- 5. Chấm điểm nhiệm vụ
-- ===========================================================================

-- Mốc thăng cấp ứng với một số huy hiệu; null khi chưa có mốc nào.
create or replace function public.mission_level_for(p_badges integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('level', l.level, 'title', l.title, 'min_badges', l.min_badges)
  from public.mission_levels l
  where l.min_badges <= coalesce(p_badges, 0)
  order by l.min_badges desc
  limit 1;
$$;

revoke all on function public.mission_level_for(integer) from public, anon, authenticated;
grant execute on function public.mission_level_for(integer) to service_role;

-- Chấm một nhiệm vụ theo dữ liệu sống: {done, total, left, detail}.
-- Ba quy tắc: sửa hệ số bí danh, gỡ cặp trùng, dọn đơn vị lạ.
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

revoke all on function public.mission_evaluate(uuid) from public, anon, authenticated;
grant execute on function public.mission_evaluate(uuid) to service_role;

-- ===========================================================================
-- 6. RPC client
-- ===========================================================================

-- (1) Nhiệm vụ của tôi: danh sách + huy hiệu + cấp + phần thưởng gần đây.
create or replace function public.get_my_missions(p_user uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_target uuid;
  v_missions jsonb := '[]'::jsonb;
  v_badges_total integer := 0;
  v_by_code jsonb := '{}'::jsonb;
  v_level jsonb;
  v_next jsonb;
  v_recent jsonb := '[]'::jsonb;
begin
  v_target := coalesce(p_user, v_actor);

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if v_target is distinct from v_actor and not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  if v_target is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'code', m.code,
           'title', m.title,
           'description', m.description,
           'area', m.area,
           'status', m.status,
           'sort_order', m.sort_order,
           'badge', case when b.code is null then null else jsonb_build_object(
             'code', b.code, 'name', b.name, 'icon', b.icon
           ) end,
           'completed_at', m.completed_at,
           'progress', public.mission_evaluate(m.id)
         ) order by
           case m.status when 'open' then 0 else 1 end,
           case when m.status = 'open' then m.sort_order end asc nulls last,
           m.completed_at desc nulls last,
           m.created_at asc), '[]'::jsonb)
  into v_missions
  from public.missions m
  left join public.mission_badges b on b.code = m.badge_code
  where m.assignee_user_id = v_target
    and m.status in ('open', 'completed');

  select count(*)::integer into v_badges_total
  from public.mission_badge_awards aw
  where aw.user_id = v_target;

  select coalesce(jsonb_object_agg(c.badge_code, c.n), '{}'::jsonb)
  into v_by_code
  from (
    select aw.badge_code, count(*)::integer as n
    from public.mission_badge_awards aw
    where aw.user_id = v_target
    group by aw.badge_code
  ) c;

  v_level := public.mission_level_for(v_badges_total);

  select jsonb_build_object('level', l.level, 'title', l.title, 'min_badges', l.min_badges)
  into v_next
  from public.mission_levels l
  where l.min_badges > v_badges_total
  order by l.min_badges asc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'badge_code', x.badge_code,
           'mission_title', x.mission_title,
           'awarded_at', x.awarded_at
         ) order by x.awarded_at desc), '[]'::jsonb)
  into v_recent
  from (
    select aw.badge_code, m.title as mission_title, aw.awarded_at
    from public.mission_badge_awards aw
    left join public.missions m on m.id = aw.mission_id
    where aw.user_id = v_target
    order by aw.awarded_at desc
    limit 5
  ) x;

  return jsonb_build_object(
    'missions', v_missions,
    'badges', jsonb_build_object('total', v_badges_total, 'by_code', v_by_code),
    'level', v_level,
    'next_level', v_next,
    'recent_awards', v_recent
  );
end;
$$;

revoke all on function public.get_my_missions(uuid) from public, anon;
grant execute on function public.get_my_missions(uuid) to authenticated, service_role;

-- (2) Hoàn thành một nhiệm vụ; bất biến theo p_request_id.
create or replace function public.complete_mission(
  p_mission_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_mission public.missions%rowtype;
  v_eval jsonb;
  v_cached jsonb;
  v_badge jsonb;
  v_before integer := 0;
  v_after integer;
  v_level_before jsonb;
  v_level_after jsonb;
  v_leveled boolean := false;
  v_result jsonb;
begin
  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('mission:' || p_request_id::text));
    select r.result into v_cached
    from public.mission_requests r
    where r.request_id = p_request_id
      and r.kind = 'complete_mission';
    if found and v_cached is not null then
      return v_cached;
    end if;
  end if;

  select * into v_mission from public.missions where id = p_mission_id for update;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or v_mission.assignee_user_id <> v_actor then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  if v_mission.status = 'completed' then
    select r.result into v_cached
    from public.mission_requests r
    where r.kind = 'complete_mission'
      and (r.result ->> 'mission_id')::uuid = p_mission_id
    order by r.created_at asc, r.request_id asc
    limit 1;
    if v_cached is not null then
      return v_cached;
    end if;
    raise exception 'mission_already_completed' using errcode = 'P0001';
  end if;

  if v_mission.status <> 'open' then
    raise exception 'mission_not_open' using errcode = 'P0001';
  end if;

  v_eval := public.mission_evaluate(p_mission_id);
  if not coalesce((v_eval ->> 'done')::boolean, false) then
    raise exception 'mission_not_done' using errcode = 'P0001',
      detail = coalesce(v_eval ->> 'left', '0');
  end if;

  select count(*)::integer into v_before
  from public.mission_badge_awards aw
  where aw.user_id = v_mission.assignee_user_id;
  v_level_before := public.mission_level_for(v_before);

  insert into public.mission_badge_awards (user_id, badge_code, mission_id)
  values (v_mission.assignee_user_id, v_mission.badge_code, p_mission_id)
  on conflict (mission_id) do nothing;

  select count(*)::integer into v_after
  from public.mission_badge_awards aw
  where aw.user_id = v_mission.assignee_user_id;
  v_level_after := public.mission_level_for(v_after);
  v_leveled := coalesce((v_level_after ->> 'level')::integer, 0)
    > coalesce((v_level_before ->> 'level')::integer, 0);

  select jsonb_build_object('code', b.code, 'name', b.name, 'icon', b.icon)
  into v_badge
  from public.mission_badges b
  where b.code = v_mission.badge_code;

  update public.missions
    set status = 'completed',
        completed_at = now(),
        completed_by = v_actor,
        evidence = v_eval
    where id = p_mission_id;

  v_result := jsonb_build_object(
    'mission_id', p_mission_id,
    'badge', v_badge,
    'badges_total', v_after,
    'level_before', v_level_before,
    'level_after', v_level_after,
    'leveled_up', v_leveled
  );

  if p_request_id is not null then
    insert into public.mission_requests (request_id, user_id, kind, result)
    values (p_request_id, v_actor, 'complete_mission', v_result)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.complete_mission(uuid, uuid) from public, anon;
grant execute on function public.complete_mission(uuid, uuid) to authenticated, service_role;

-- (3) Sửa hệ số quy đổi của một bí danh; ghi nhật ký và bất biến theo request id.
create or replace function public.update_stock_material_alias_factor(
  p_alias_id uuid,
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
  v_alias public.stock_material_aliases%rowtype;
  v_old_factor numeric;
  v_cached jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  if p_factor is null
     or p_factor <= 0
     or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_factor' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('mission:' || p_request_id::text));
    select r.result into v_cached
    from public.mission_requests r
    where r.request_id = p_request_id
      and r.kind = 'update_alias_factor';
    if found and v_cached is not null then
      return v_cached;
    end if;
  end if;

  select * into v_alias
  from public.stock_material_aliases a
  where a.id = p_alias_id
  for update;
  if not found then
    raise exception 'alias_not_found' using errcode = 'P0002';
  end if;

  v_old_factor := v_alias.conversion_factor;

  update public.stock_material_aliases
    set conversion_factor = p_factor,
        updated_at = now()
    where id = p_alias_id;

  insert into public.material_alias_events (
    alias_id, action, actor_id, raw_name, raw_unit, previous_factor, new_factor
  ) values (
    p_alias_id, 'correct', v_actor, v_alias.normalized_name, v_alias.unit,
    v_old_factor, p_factor
  );

  v_result := jsonb_build_object(
    'alias_id', p_alias_id,
    'old_factor', v_old_factor,
    'new_factor', p_factor
  );

  if p_request_id is not null then
    insert into public.mission_requests (request_id, user_id, kind, result)
    values (p_request_id, v_actor, 'update_alias_factor', v_result)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.update_stock_material_alias_factor(uuid, numeric, uuid) from public, anon;
grant execute on function public.update_stock_material_alias_factor(uuid, numeric, uuid) to authenticated, service_role;

-- (4) Đánh dấu hai mặt hàng là hai mặt hàng khác nhau (không gộp).
create or replace function public.mark_stock_items_distinct(
  p_item_a uuid,
  p_item_b uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_a uuid;
  v_b uuid;
  v_cached jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  if p_item_a is null or p_item_b is null or p_item_a = p_item_b then
    raise exception 'items_must_differ' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('mission:' || p_request_id::text));
    select r.result into v_cached
    from public.mission_requests r
    where r.request_id = p_request_id
      and r.kind = 'mark_items_distinct';
    if found and v_cached is not null then
      return v_cached;
    end if;
  end if;

  if not exists (select 1 from public.kitchen_inventory_items k where k.id = p_item_a) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.kitchen_inventory_items k where k.id = p_item_b) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  v_a := least(p_item_a, p_item_b);
  v_b := greatest(p_item_a, p_item_b);

  insert into public.stock_item_distinct_pairs (item_a, item_b, decided_by, decided_at)
  values (v_a, v_b, v_actor, now())
  on conflict (item_a, item_b) do nothing;

  v_result := jsonb_build_object('item_a', v_a, 'item_b', v_b);

  if p_request_id is not null then
    insert into public.mission_requests (request_id, user_id, kind, result)
    values (p_request_id, v_actor, 'mark_items_distinct', v_result)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.mark_stock_items_distinct(uuid, uuid, uuid) from public, anon;
grant execute on function public.mark_stock_items_distinct(uuid, uuid, uuid) to authenticated, service_role;

-- (5) Xử lý một cách viết đơn vị lạ: gán mã chuẩn hoặc đánh dấu không phải hàng kho.
create or replace function public.resolve_unknown_purchase_unit(
  p_variant text,
  p_action text,
  p_code text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_variant text := lower(btrim(coalesce(p_variant, '')));
  v_code text;
  v_cached jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  if v_variant = '' then
    raise exception 'variant_required' using errcode = '22023';
  end if;

  if p_action not in ('map', 'not_stock') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  if p_action = 'map' then
    v_code := lower(btrim(coalesce(p_code, '')));
    if v_code = '' or not exists (select 1 from public.stock_units u where u.code = v_code) then
      raise exception 'unknown_unit_code' using errcode = '22023';
    end if;
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('mission:' || p_request_id::text));
    select r.result into v_cached
    from public.mission_requests r
    where r.request_id = p_request_id
      and r.kind = 'resolve_unknown_unit';
    if found and v_cached is not null then
      return v_cached;
    end if;
  end if;

  if p_action = 'map' then
    insert into public.stock_unit_aliases (variant, code)
    values (v_variant, v_code)
    on conflict (variant) do update set code = excluded.code;
  else
    insert into public.stock_unit_ignored_variants (variant, reason, decided_by, decided_at)
    values (v_variant, 'not_stock', v_actor, now())
    on conflict (variant) do nothing;
  end if;

  v_result := jsonb_build_object(
    'variant', v_variant,
    'action', p_action,
    'code', case when p_action = 'map' then v_code else null end
  );

  if p_request_id is not null then
    insert into public.mission_requests (request_id, user_id, kind, result)
    values (p_request_id, v_actor, 'resolve_unknown_unit', v_result)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.resolve_unknown_purchase_unit(text, text, text, uuid) from public, anon;
grant execute on function public.resolve_unknown_purchase_unit(text, text, text, uuid) to authenticated, service_role;

-- ===========================================================================
-- 7. Gieo 3 nhiệm vụ kho cho chủ sở hữu
-- ===========================================================================
--
-- Tất cả id đều tra theo dữ liệu lúc apply. Thiếu dữ liệu thì bỏ qua nhiệm vụ đó
-- bằng RAISE NOTICE, không làm hỏng migration.

do $seed_missions$
declare
  v_owner uuid;
  v_aliases jsonb;
  v_items jsonb;
  v_initial integer;
  v_description text;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  if v_owner is null then
    raise notice 'missions seed skipped: no owner role';
    return;
  end if;

  -- Nhiệm vụ 1: sửa 2 bí danh sai hệ số.
  select jsonb_agg(jsonb_build_object(
           'id', a.id,
           'bad_factor', a.conversion_factor,
           'bad_item_id', a.kitchen_inventory_item_id
         ))
  into v_aliases
  from public.stock_material_aliases a
  where a.normalized_name = 'pho mai lat trang brinayr'
     or (
       a.normalized_name ilike '%mekovita%'
       and a.normalized_name ilike '%combo 3 thung%'
     );

  if v_aliases is not null and jsonb_array_length(v_aliases) > 0 then
    v_description := 'Hai bí danh đang trỏ sai hệ số quy đổi. Mở "Bảng bí danh", '
      || 'kiểm tra lại hệ số của từng dòng rồi lưu hệ số đúng.';
    insert into public.missions (
      code, area, title, description, assignee_user_id,
      check_rule, check_params, badge_code, sort_order, created_by
    ) values (
      'wh-fix-alias-factors', 'warehouse', 'Sửa 2 bí danh sai hệ số', v_description,
      v_owner, 'stock_alias_factor_fixed', jsonb_build_object('aliases', v_aliases),
      'cham_chi', 1, v_owner
    )
    on conflict (code) do nothing;
  else
    raise notice 'missions seed skipped: wh-fix-alias-factors has no matching aliases';
  end if;

  -- Nhiệm vụ 2: gỡ cặp trùng Hộp Croissant thường.
  select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name))
  into v_items
  from public.kitchen_inventory_items k
  where k.active = true
    and k.merged_into_id is null
    and k.name in ('Hộp Croissant thường', 'Hộp Croissant thường (khay nhựa vuông)');

  if v_items is not null and jsonb_array_length(v_items) = 2 then
    v_description := 'Hai mặt hàng cùng tên "Hộp Croissant thường" đang cùng hoạt động. '
      || 'Chọn đúng một trong hai: đánh dấu là hai mặt hàng khác nhau, '
      || 'hoặc đổi tên một mặt hàng.';
    insert into public.missions (
      code, area, title, description, assignee_user_id,
      check_rule, check_params, badge_code, sort_order, created_by
    ) values (
      'wh-croissant-duplicate', 'warehouse', 'Xử lý cặp trùng Hộp Croissant thường',
      v_description, v_owner, 'stock_duplicate_resolved',
      jsonb_build_object('items', v_items), 'cham_chi', 2, v_owner
    )
    on conflict (code) do nothing;
  else
    raise notice 'missions seed skipped: wh-croissant-duplicate needs exactly 2 live items';
  end if;

  -- Nhiệm vụ 3: dọn đơn vị lạ trên phiếu mua 60 ngày.
  select count(distinct lower(btrim(r.unit)))::integer into v_initial
  from public.stock_unknown_purchase_unit_rows(60) r;
  v_initial := coalesce(v_initial, 0);

  if v_initial > 0 then
    v_description := 'Còn cách viết đơn vị lạ trên phiếu mua 60 ngày. Với mỗi đơn vị, '
      || 'gán mã đơn vị chuẩn hoặc đánh dấu "không phải hàng kho".';
    insert into public.missions (
      code, area, title, description, assignee_user_id,
      check_rule, check_params, badge_code, sort_order, created_by
    ) values (
      'wh-unknown-units', 'warehouse', 'Dọn đơn vị lạ trên phiếu', v_description,
      v_owner, 'stock_unknown_units_cleared',
      jsonb_build_object('initial', v_initial, 'days', 60), 'cham_chi', 3, v_owner
    )
    on conflict (code) do nothing;
  else
    raise notice 'missions seed skipped: wh-unknown-units has no unknown units';
  end if;
end;
$seed_missions$;
