-- Rollback-only production smoke for migration
-- 20261027100000_backlog_raw_unit.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_backlog_raw_unit.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_backlog_raw_unit.sql).
--
-- The file opens one transaction, captures the previous backlog-review rows for
-- q7 / tan_tao as the real owner, applies the migration SQL inline, then asserts
-- that (a) the same (normalized_name, supplier_id, line_count, last_receipt_date)
-- rows come back in the same order, (b) every raw_unit equals the most frequent
-- trimmed unit recomputed directly, (c) the line_count inside raw_units sums to
-- the row line_count, (d) the snapshot pending objects carry raw_unit / raw_units,
-- and (e) PACK-style units are checked when present live. The final RAISE aborts
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

-- (1) Capture the previous review rows for both locations, before the function
-- is dropped and recreated.
create temp table smoke_backlog_raw_before as
select
  r.location,
  r.normalized_name,
  r.supplier_id,
  r.line_count,
  r.last_receipt_date
from (
  select 'q7'::text as location, x.normalized_name, x.supplier_id, x.line_count, x.last_receipt_date
  from public.get_material_alias_backlog_review('q7', 500) x
  union all
  select 'tan_tao'::text as location, x.normalized_name, x.supplier_id, x.line_count, x.last_receipt_date
  from public.get_material_alias_backlog_review('tan_tao', 500) x
) r;

-- The qualifying 90-day lines, recomputed directly, so raw_unit / raw_units can
-- be re-derived without trusting the function under test.
create temp table smoke_backlog_raw_lines as
select
  l.location,
  l.normalized_name,
  l.supplier_id,
  l.unit,
  l.receipt_date
from (
  select
    gr.supplier_id as supplier_id,
    coalesce(gr.receiving_location, s.default_receiving_location, 'q7') as location,
    public.normalize_stock_item_name(
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
    ) as normalized_name,
    nullif(btrim(gri.unit), '') as unit,
    gr.receipt_date as receipt_date
  from public.goods_receipt_items gri
  join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  left join public.suppliers s on s.id = gr.supplier_id
  where gr.status in ('confirmed', 'received')
    and coalesce(s.stock_exempt, false) = false
    and coalesce(gr.receiving_location, s.default_receiving_location, 'q7') in ('q7', 'tan_tao')
    and public.stock_line_auto_non_stock(
          coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
        ) is null
    and gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
) l
where l.normalized_name is not null
  and not exists (
    select 1 from public.stock_material_aliases a
    where a.location = l.location
      and a.normalized_name = l.normalized_name
      and a.supplier_id is not distinct from l.supplier_id
  );

-- (2) Apply the migration SQL inline, byte-for-byte.
-- 2026-10-27 — Thùng chờ trả thêm đơn vị ghi trên phiếu nhập (phần dữ liệu).
--
-- Additive migration on top of 20261026100000_central_warehouse_flow.sql. It
-- replaces exactly one read-only RPC, public.get_material_alias_backlog_review(
-- text, integer), with the same signature and the same 14 columns plus two
-- trailing columns:
--   * raw_unit  text   — the most frequent goods_receipt_items.unit among the
--                        name's qualifying 90-day lines; ties go to the unit on
--                        the latest receipt_date. Units are trimmed to null and
--                        the value is null when every line's unit is blank.
--   * raw_units jsonb  — [{unit, line_count}, ...] ordered by line_count desc,
--                        then unit asc.
--
-- Everything else is unchanged: the 90-day line window, the 60-day activity
-- rule, the alias exclusion, the candidate / Jev columns, the ORDER BY and the
-- limits. public.get_warehouse_game_snapshot(text) builds its pending rows with
-- to_jsonb(...), so each pending object carries raw_unit / raw_units without the
-- snapshot function being redefined.
--
-- The RETURNS TABLE shape changes, so the old definition is dropped first. The
-- whole file runs in one transaction and writes nothing.
-- No DROP is needed for any caller: the snapshot that calls this RPC is
-- LANGUAGE plpgsql and resolves the call at run time.

drop function if exists public.get_material_alias_backlog_review(text, integer);

create function public.get_material_alias_backlog_review(p_location text, p_limit integer DEFAULT 100)
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

revoke all on function public.get_material_alias_backlog_review(text, integer) from public, anon;
grant execute on function public.get_material_alias_backlog_review(text, integer) to authenticated, service_role;

-- (3) Capture the new review rows, including the two new columns.
create temp table smoke_backlog_raw_after as
select
  r.location,
  r.normalized_name,
  r.raw_name,
  r.supplier_id,
  r.line_count,
  r.last_receipt_date,
  r.raw_unit,
  r.raw_units
from (
  select 'q7'::text as location, x.*
  from public.get_material_alias_backlog_review('q7', 500) x
  union all
  select 'tan_tao'::text as location, x.*
  from public.get_material_alias_backlog_review('tan_tao', 500) x
) r;

-- (4) Assertions. Any failure aborts the transaction before the final PASS.
do $smoke$
declare
  v_loc text;
  v_locs text[] := array['q7', 'tan_tao'];
  v_bad integer;
  v_pack integer;
begin
  foreach v_loc in array v_locs loop
    -- (a1) The same (normalized_name, supplier_id, line_count, last_receipt_date)
    -- rows, both directions.
    select count(*) into v_bad
    from (
      (select normalized_name, supplier_id, line_count, last_receipt_date
         from smoke_backlog_raw_before where location = v_loc
       except
       select normalized_name, supplier_id, line_count, last_receipt_date
         from smoke_backlog_raw_after where location = v_loc)
      union all
      (select normalized_name, supplier_id, line_count, last_receipt_date
         from smoke_backlog_raw_after where location = v_loc
       except
       select normalized_name, supplier_id, line_count, last_receipt_date
         from smoke_backlog_raw_before where location = v_loc)
    ) d;
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL review_same_rows % diff=%', v_loc, v_bad;
    end if;

    -- (a2) The same order, using the function's own ordering keys.
    if (
      select array_agg(
               row(normalized_name, supplier_id, line_count, last_receipt_date)
               order by line_count desc, normalized_name, supplier_id
             )
      from smoke_backlog_raw_before
      where location = v_loc
    ) is distinct from (
      select array_agg(
               row(normalized_name, supplier_id, line_count, last_receipt_date)
               order by line_count desc, normalized_name, supplier_id
             )
      from smoke_backlog_raw_after
      where location = v_loc
    ) then
      raise exception 'SMOKE_RESULT FAIL review_order %', v_loc;
    end if;

    -- (b) raw_unit equals the most frequent trimmed unit recomputed directly;
    -- ties go to the latest receipt_date, then unit asc.
    select count(*) into v_bad
    from smoke_backlog_raw_after a
    left join (
      select distinct on (normalized_name, supplier_id, location)
        normalized_name,
        supplier_id,
        location,
        unit
      from (
        select
          l.normalized_name,
          l.supplier_id,
          l.location,
          l.unit,
          count(*)::bigint as unit_count,
          max(l.receipt_date) as latest
        from smoke_backlog_raw_lines l
        where l.unit is not null
        group by l.normalized_name, l.supplier_id, l.location, l.unit
      ) u
      order by normalized_name, supplier_id, location, unit_count desc, latest desc, unit asc nulls last
    ) m
      on m.location = a.location
     and m.normalized_name = a.normalized_name
     and m.supplier_id is not distinct from a.supplier_id
    where a.location = v_loc
      and a.raw_unit is distinct from m.unit;
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL raw_unit_mode % bad=%', v_loc, v_bad;
    end if;

    -- (c) raw_units covers every line of the name.
    select count(*) into v_bad
    from smoke_backlog_raw_after a
    where a.location = v_loc
      and coalesce((
        select sum((u ->> 'line_count')::bigint)
        from jsonb_array_elements(a.raw_units) u
      ), 0) <> a.line_count;
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL raw_units_sum % bad=%', v_loc, v_bad;
    end if;

    -- (d) the snapshot pending objects carry both new keys.
    select count(*) into v_bad
    from jsonb_array_elements(public.get_warehouse_game_snapshot(v_loc) -> 'pending') e
    where not (e ? 'raw_unit') or not (e ? 'raw_units');
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL snapshot_keys % bad=%', v_loc, v_bad;
    end if;

    -- (e) PACK-style units: assert the live list when one exists, otherwise a
    -- notice (the fixture data may legitimately have none).
    select count(*) into v_pack
    from smoke_backlog_raw_after a
    where a.location = v_loc
      and exists (
        select 1
        from jsonb_array_elements(a.raw_units) u
        where upper(coalesce(u ->> 'unit', '')) like '%PACK%'
      );
    if v_pack = 0 then
      raise notice 'SMOKE notice: no PACK-style unit live at %', v_loc;
    end if;
  end loop;

  raise exception 'SMOKE_RESULT PASS: backlog raw unit';
end;
$smoke$;
