-- Rollback-only production smoke for migration
-- 20261025100000_alias_backlog_active_60.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_alias_backlog_active_60.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_alias_backlog_active_60.sql).
--
-- The file opens one transaction, captures the previous backlog-review rows for
-- q7 / tan_tao, applies the migration SQL inline, asserts the 60-day activity
-- rule for both locations, then raises SMOKE_RESULT PASS. The final RAISE aborts
-- the transaction, so every change rolls back.
begin;

-- (0) The owner is taken from public.user_roles and impersonated through
-- request.jwt.claims, so the pre-migration review list can be captured.
do $ownercheck$
declare
  v_owner uuid;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;
end;
$ownercheck$;

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (
      select ur.user_id
      from public.user_roles ur
      where ur.role::text = 'owner'
      order by ur.created_at, ur.user_id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  true
);

-- (1) Capture the previous review rows for both locations, and the count of
-- those already inside the 60-day window.
create temp table smoke_alias_before as
select
  r.location,
  r.normalized_name,
  r.supplier_id,
  r.raw_name,
  r.line_count,
  r.last_receipt_date
from (
  select 'q7'::text as location, x.*
  from public.get_material_alias_backlog_review('q7', 500) x
  union all
  select 'tan_tao'::text as location, x.*
  from public.get_material_alias_backlog_review('tan_tao', 500) x
) r;

create temp table smoke_alias_before_count as
select
  b.location,
  count(*) filter (
    where b.last_receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 60
  ) as active_count
from smoke_alias_before b
group by b.location;

-- (2) Apply the migration SQL inline, byte-for-byte.
-- 2026-10-25 — Thùng chờ dán nhãn (phần dữ liệu): chỉ tên có nhập trong 60 ngày.
--
-- Additive migration on top of 20261024100000_missions.sql. It replaces exactly
-- two read-only RPCs with identical signatures and return types:
--   1. public.get_material_alias_backlog(text, integer)
--   2. public.get_material_alias_backlog_review(text, integer)
--
-- Owner rule (12/10): 'chỉ dán nhãn tên có nhập trong 60 ngày; không nhập quá
-- 60/90 ngày thì bỏ qua'. The 90-day line window is kept so line_count and
-- raw_name are unchanged. A name stays in the box only when its most recent
-- qualifying receipt line is within the last 60 days (Asia/Ho_Chi_Minh date).
-- The rule is applied before ORDER BY / LIMIT so 60-day names are not crowded
-- out by older names.
--
-- Nothing here writes: both functions are read-only and the migration is applied
-- as one transaction. No DROP is used.

-- ---------------------------------------------------------------------------
-- 1. public.get_material_alias_backlog: keep only names received in 60 days
-- ---------------------------------------------------------------------------

create or replace function public.get_material_alias_backlog(
  p_location text default 'q7',
  p_limit integer default 200
)
returns table (
  supplier_id uuid,
  normalized_name text,
  raw_name text,
  raw_unit text,
  location text,
  receipt_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with lines as (
    select
      gr.receipt_date as receipt_date,
      gr.supplier_id as supplier_id,
      coalesce(gr.receiving_location, s.default_receiving_location, 'q7') as location,
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
      ) as normalized_name,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as raw_name,
      gri.unit as raw_unit
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    left join public.suppliers s on s.id = gr.supplier_id
    where gr.status in ('confirmed', 'received')
      and coalesce(s.stock_exempt, false) = false
      and coalesce(gr.receiving_location, s.default_receiving_location, 'q7') = p_location
      and p_location in ('q7', 'tan_tao')
      -- [2026-10-19] a name the fixed rule marks as VAT / fee / service is
      -- not a material waiting to be ranked.
      and public.stock_line_auto_non_stock(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) is null
      and gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
  )
  select
    l.supplier_id,
    l.normalized_name,
    min(l.raw_name) as raw_name,
    min(l.raw_unit) as raw_unit,
    l.location,
    count(*)::bigint as receipt_count
  from lines l
  where l.normalized_name is not null
    and not exists (
      select 1 from public.stock_material_aliases a
      where a.location = l.location
        and a.normalized_name = l.normalized_name
        and a.supplier_id is not distinct from l.supplier_id
    )
  group by l.supplier_id, l.normalized_name, l.location
  having max(l.receipt_date) >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 60
  order by count(*) desc, l.normalized_name asc
  limit greatest(1, least(coalesce(p_limit, 200), 200));
$$;

revoke all on function public.get_material_alias_backlog(text, integer) from public, anon, authenticated;
grant execute on function public.get_material_alias_backlog(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. public.get_material_alias_backlog_review: same 60-day activity rule
-- ---------------------------------------------------------------------------
-- Latest definition lives in 20261022100000_shared_catalog_units.sql, created
-- with drop + create there. Here it becomes create or replace with the same
-- signature, return columns, ordering, candidate and Jev fields, and limits.

create or replace function public.get_material_alias_backlog_review(p_location text, p_limit integer DEFAULT 100)
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
    having max(l.receipt_date) >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 60
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

-- (3) Assert the new 60-day activity rule for q7 and tan_tao.
do $smoke$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_loc text;
  v_locs text[] := array['q7', 'tan_tao'];
  v_bad integer;
  v_new_count integer;
  v_before_count integer;
  v_pending integer;
begin
  foreach v_loc in array v_locs loop
    -- (a) every new review row is inside the last 60 days.
    select count(*) into v_bad
    from public.get_material_alias_backlog_review(v_loc, 500) r
    where r.last_receipt_date < v_today - 60;
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL review_active_60 % stale=%', v_loc, v_bad;
    end if;

    -- (b) the new count equals the captured 60-day count.
    select count(*) into v_new_count
    from public.get_material_alias_backlog_review(v_loc, 500) r;
    select b.active_count into v_before_count
    from smoke_alias_before_count b
    where b.location = v_loc;
    if coalesce(v_before_count, 0) <> v_new_count then
      raise exception 'SMOKE_RESULT FAIL review_count % before=% new=%',
        v_loc, v_before_count, v_new_count;
    end if;

    -- (c) every kept normalized_name + supplier_id is one of the previous rows.
    select count(*) into v_bad
    from public.get_material_alias_backlog_review(v_loc, 500) r
    where not exists (
      select 1
      from smoke_alias_before b
      where b.location = v_loc
        and b.normalized_name = r.normalized_name
        and b.supplier_id is not distinct from r.supplier_id
    );
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL review_no_new_names % new=%', v_loc, v_bad;
    end if;

    -- (d) the backlog RPC returns no name whose latest 90-day line is older
    -- than 60 days (same receipt / location rule as the functions).
    select count(*) into v_bad
    from public.get_material_alias_backlog(v_loc, 200) b
    join (
      select
        l.supplier_id,
        l.normalized_name,
        max(l.receipt_date) as last_receipt_date
      from (
        select
          gr.supplier_id as supplier_id,
          public.normalize_stock_item_name(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) as normalized_name,
          gr.receipt_date as receipt_date
        from public.goods_receipt_items gri
        join public.goods_receipts gr on gr.id = gri.goods_receipt_id
        left join public.suppliers s on s.id = gr.supplier_id
        where gr.status in ('confirmed', 'received')
          and coalesce(s.stock_exempt, false) = false
          and coalesce(gr.receiving_location, s.default_receiving_location, 'q7') = v_loc
          and v_loc in ('q7', 'tan_tao')
          and public.stock_line_auto_non_stock(
                coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
              ) is null
          and gr.receipt_date >= v_today - 90
      ) l
      where l.normalized_name is not null
      group by l.supplier_id, l.normalized_name
    ) d
      on d.supplier_id is not distinct from b.supplier_id
     and d.normalized_name = b.normalized_name
    where d.last_receipt_date < v_today - 60;
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL backlog_active_60 % stale=%', v_loc, v_bad;
    end if;
  end loop;

  -- (e) the q7 snapshot pending list is the new review list, capped at 200.
  select coalesce(jsonb_array_length(public.get_warehouse_game_snapshot('q7') -> 'pending'), 0)
  into v_pending;
  select count(*) into v_new_count
  from public.get_material_alias_backlog_review('q7', 200) r;
  if v_pending <> least(v_new_count, 200) then
    raise exception 'SMOKE_RESULT FAIL pending_match pending=% expected=%',
      v_pending, least(v_new_count, 200);
  end if;

  raise exception 'SMOKE_RESULT PASS: alias backlog active 60';
end;
$smoke$;
