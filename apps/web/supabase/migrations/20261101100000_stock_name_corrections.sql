-- Bảng sửa tên hiển thị cho tên hàng máy đọc sai (Nhân → Nhãn pate).
--
-- 2026-11-01. The intake reader sometimes sees the lid label "Nhãn" as "Nhân"
-- on the pate boxes. public.stock_name_corrections maps a normalized material
-- name to the display name an operator should read. It is reference data only:
-- it never changes normalized_name, the line set, the grouping, the ordering or
-- a stored goods_receipt_items / goods_receipts row.
--
-- The primary key is the same key the Tân Tạo pending-crate backlog already
-- groups by: public.normalize_stock_item_name(coalesce(nullif(btrim(
-- gri.raw_product_name), ''), gri.product_name)). Verified on the linked DB:
--   * 'Nhân Patê Heo 200gr' -> 'nhan pate heo 200gr'
--   * 'Nhân Patê Heo 500gr' -> 'nhan pate heo 500gr'
--
-- Re-created readers (body taken from the newest definition, only the returned
-- raw_name becomes coalesce(corrected_name, the machine name)):
--   * public.get_material_alias_backlog_review(text, integer)     20261031150000
--   * public.get_crate_receipt_lines(text, uuid, text, integer)   20261029150000
--   * public.get_item_receipt_lines(uuid, integer)                20261029150000
-- public.receipt_lines_for_game_base, the alias / candidate matching and the
-- normalized_name columns stay byte-for-byte: they keep the raw machine name.
--
-- The table is read-only for the browser: RLS is enabled, authenticated gets
-- SELECT only, and the owner / service_role keep the write path. This file runs
-- in one transaction, does not apply itself and never runs a CLI push; the
-- Maestro applies it.

-- ===========================================================================
-- 1. public.stock_name_corrections: display-name overrides by normalized name
-- ===========================================================================

create table if not exists public.stock_name_corrections (
  normalized_name text primary key,
  corrected_name text not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.stock_name_corrections enable row level security;

-- Every write stays with the owner / service_role; a browser may only read.
revoke all on table public.stock_name_corrections from public, anon, authenticated;
grant select on table public.stock_name_corrections to authenticated, service_role;

drop policy if exists stock_name_corrections_select on public.stock_name_corrections;
create policy stock_name_corrections_select on public.stock_name_corrections
  for select to authenticated
  using (true);

insert into public.stock_name_corrections (normalized_name, corrected_name, note)
values
  (
    'nhan pate heo 200gr',
    'Nhãn Patê Heo 200gr',
    'Máy đọc nhầm Nhãn thành Nhân (nhãn dán nắp hộp pate), owner 13/10'
  ),
  (
    'nhan pate heo 500gr',
    'Nhãn Patê Heo 500gr',
    'Máy đọc nhầm Nhãn thành Nhân (nhãn dán nắp hộp pate), owner 13/10'
  )
on conflict (normalized_name) do update
  set corrected_name = excluded.corrected_name,
      note = excluded.note;

-- ===========================================================================
-- 2. public.get_material_alias_backlog_review: corrected display name
-- ===========================================================================

create or replace function public.get_material_alias_backlog_review(p_location text, p_limit integer DEFAULT 100)
 RETURNS TABLE(normalized_name text, raw_name text, line_count bigint, supplier_id uuid, supplier_name text, last_receipt_date date, top_candidate jsonb, jev_item_id uuid, jev_item_name text, jev_unit text, jev_probability numeric, jev_line_type text, jev_source text, jev_is_sku boolean, raw_unit text, raw_units jsonb)
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
      coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') as location,
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
      and coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') = p_location
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
      -- [raw-unit-agg]
      , (
        select (array_agg(u.unit order by u.unit_count desc, u.latest desc, u.unit asc nulls last))[1]
        from (
          select
            nullif(btrim(l2.raw_unit), '') as unit,
            count(*)::bigint as unit_count,
            max(l2.receipt_date) as latest
          from lines l2
          where l2.normalized_name = l.normalized_name
            and l2.supplier_id is not distinct from l.supplier_id
            and l2.location = l.location
          group by 1
        ) u
        where u.unit is not null
      ) as raw_unit
      , (
        select coalesce(
          jsonb_agg(
            jsonb_build_object('unit', u.unit, 'line_count', u.unit_count)
            order by u.unit_count desc, u.unit asc nulls last
          ),
          '[]'::jsonb
        )
        from (
          select
            nullif(btrim(l2.raw_unit), '') as unit,
            count(*)::bigint as unit_count
          from lines l2
          where l2.normalized_name = l.normalized_name
            and l2.supplier_id is not distinct from l.supplier_id
            and l2.location = l.location
          group by 1
        ) u
      ) as raw_units
      -- [/raw-unit-agg]
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
    coalesce(
      (select c.corrected_name
         from public.stock_name_corrections c
        where c.normalized_name = o.normalized_name),
      o.raw_name
    ) as raw_name,
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
    -- [raw-unit-out]
    , o.raw_unit
    , o.raw_units
    -- [/raw-unit-out]
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

-- get_material_alias_backlog_review: grants identical to 20261031150000.
revoke all on function public.get_material_alias_backlog_review(text, integer) from public, anon;
grant execute on function public.get_material_alias_backlog_review(text, integer) to authenticated, service_role;

-- ===========================================================================
-- 3. public.get_crate_receipt_lines: corrected display name
-- ===========================================================================

create or replace function public.get_crate_receipt_lines(
  p_location text,
  p_supplier_id uuid,
  p_normalized_name text,
  p_limit integer default 20
)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path = public, pg_temp
as $function$
declare
  v_actor uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  -- Owner or Q7 stock admin only, exactly like the backlog review.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(t) order by t.receipt_date desc, t.receipt_number desc)
    from (
      select
        b.goods_receipt_id,
        b.goods_receipt_item_id,
        b.receipt_number,
        b.receipt_date,
        b.status,
        sup.name as supplier_name,
        coalesce(
          (select c.corrected_name
             from public.stock_name_corrections c
            where c.normalized_name = b.normalized_name),
          b.raw_name
        ) as raw_name,
        public.goods_receipt_effective_quantity(
          gri.actual_quantity, gri.quantity, gri.ordered_quantity, gr.status::text
        ) as quantity,
        b.unit,
        b.unit_price,
        public.goods_receipt_effective_quantity(
          gri.actual_quantity, gri.quantity, gri.ordered_quantity, gr.status::text
        ) * b.unit_price as line_total,
        b.image_path,
        b.photo_paths
      from public.receipt_lines_for_game_base(90) b
      join public.goods_receipt_items gri on gri.id = b.goods_receipt_item_id
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      left join public.suppliers sup on sup.id = b.supplier_id
      where b.location = p_location
        and b.supplier_id is not distinct from p_supplier_id
        and b.normalized_name = p_normalized_name
      order by b.receipt_date desc, b.receipt_number desc
      limit v_limit
    ) t
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_crate_receipt_lines(text, uuid, text, integer) from public, anon;
grant execute on function public.get_crate_receipt_lines(text, uuid, text, integer) to authenticated, service_role;

-- ===========================================================================
-- 4. public.get_item_receipt_lines: corrected display name
-- ===========================================================================

create or replace function public.get_item_receipt_lines(
  p_item_id uuid,
  p_limit integer default 12
)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path = public, pg_temp
as $function$
declare
  v_actor uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 12), 30));
begin
  -- Owner or Q7 stock admin only, exactly like the backlog review.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(t) order by t.receipt_date desc, t.receipt_number desc)
    from (
      select
        b.goods_receipt_id,
        b.goods_receipt_item_id,
        b.receipt_number,
        b.receipt_date,
        b.status,
        sup.name as supplier_name,
        coalesce(
          (select c.corrected_name
             from public.stock_name_corrections c
            where c.normalized_name = b.normalized_name),
          b.raw_name
        ) as raw_name,
        public.goods_receipt_effective_quantity(
          gri.actual_quantity, gri.quantity, gri.ordered_quantity, gr.status::text
        ) as quantity,
        b.unit,
        b.unit_price,
        public.goods_receipt_effective_quantity(
          gri.actual_quantity, gri.quantity, gri.ordered_quantity, gr.status::text
        ) * b.unit_price as line_total,
        b.image_path,
        b.photo_paths
      from public.receipt_lines_for_game_base(null) b
      join public.goods_receipt_items gri on gri.id = b.goods_receipt_item_id
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      join public.stock_material_aliases a
        on a.location = b.location
       and a.normalized_name = b.normalized_name
       and a.supplier_id is not distinct from b.supplier_id
      left join public.suppliers sup on sup.id = b.supplier_id
      where a.kitchen_inventory_item_id = p_item_id
      order by b.receipt_date desc, b.receipt_number desc
      limit v_limit
    ) t
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_item_receipt_lines(uuid, integer) from public, anon;
grant execute on function public.get_item_receipt_lines(uuid, integer) to authenticated, service_role;
