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
