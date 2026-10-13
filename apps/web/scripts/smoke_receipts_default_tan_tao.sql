-- Rollback-only production smoke for migration
-- 20261031150000_receipts_default_tan_tao.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_receipts_default_tan_tao.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_receipts_default_tan_tao.sql).
--
-- The file opens one transaction, impersonates the real owner through
-- request.jwt.claims, captures the pre-migration null-location receipts and
-- ledger counts, applies the migration SQL inline byte-for-byte, then asserts:
--   (a) no goods_receipts row is left with receiving_location is null;
--   (b) every pre-null receipt that already posted a line to the Q7 ledger is
--       pinned to 'q7' and every other pre-null receipt is 'tan_tao';
--   (c) one stock_location_moves audit row per null-location receipt that
--       actually moved to 'tan_tao', reason 'null location → default (owner
--       13/10)', and none for the q7-pinned receipts;
--   (d) get_material_alias_backlog_review('q7', 200), read as the owner,
--       contains no crate whose only q7 receipts were null-location and
--       unposted (the candidate set is computed independently before the
--       migration from the raw tables);
--   (e) a fresh goods_receipt with a supplier that has no default ends with
--       receiving_location = 'tan_tao', and a q7 supplier default cannot slip
--       past the central guard either;
--   (f) the q7_inventory_movements and tan_tao_material_movements row counts
--       are unchanged.
-- The final RAISE aborts the transaction, so every change rolls back.
begin;

-- (0) The owner is taken from public.user_roles and impersonated through
-- request.jwt.claims, so the admin-only reader can be called before and after
-- the migration is applied inline.
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

-- (0b) Pre-migration state (all temporary tables roll back with the RAISE).
create temporary table smoke_rdtt_pre_null on commit drop as
select gr.id as receipt_id,
       exists (
         select 1
         from public.goods_receipt_items gri
         join public.q7_inventory_movements m
           on m.source = 'goods_receipt'
          and m.source_ref_key = 'gr-item:' || gri.id::text
         where gri.goods_receipt_id = gr.id
       ) as posted_q7
from public.goods_receipts gr
where gr.receiving_location is null;

create temporary table smoke_rdtt_ledger_before on commit drop as
select
  (select count(*) from public.q7_inventory_movements) as q7_count,
  (select count(*) from public.tan_tao_material_movements) as tt_count;

create temporary table smoke_rdtt_audit_before on commit drop as
select count(*) as n
from public.stock_location_moves
where reason = 'null location → default (owner 13/10)';

-- crates whose only q7 receipts were null-location and unposted, computed with
-- the old q7 fallback before the migration runs.
create temporary table smoke_rdtt_q7_only_null on commit drop as
select distinct
  gr.supplier_id,
  public.normalize_stock_item_name(
    coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
  ) as normalized_name
from public.goods_receipt_items gri
join public.goods_receipts gr on gr.id = gri.goods_receipt_id
left join public.suppliers s on s.id = gr.supplier_id
where gr.status in ('confirmed', 'received')
  and coalesce(s.stock_exempt, false) = false
  and coalesce(gr.receiving_location, s.default_receiving_location, 'q7') = 'q7'
  and exists (
    select 1 from smoke_rdtt_pre_null n
    where n.receipt_id = gr.id and n.posted_q7 = false
  )
  and not exists (
    select 1
    from public.goods_receipt_items gri2
    join public.goods_receipts gr2 on gr2.id = gri2.goods_receipt_id
    left join public.suppliers s2 on s2.id = gr2.supplier_id
    where gr2.status in ('confirmed', 'received')
      and coalesce(gr2.receiving_location, s2.default_receiving_location, 'q7') = 'q7'
      and gr2.supplier_id is not distinct from gr.supplier_id
      and public.normalize_stock_item_name(
            coalesce(nullif(btrim(gri2.raw_product_name), ''), gri2.product_name)
          ) = public.normalize_stock_item_name(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          )
      and not exists (
        select 1 from smoke_rdtt_pre_null n2
        where n2.receipt_id = gr2.id and n2.posted_q7 = false
      )
  );

-- (1) Apply the migration SQL inline, byte-for-byte.

-- 2026-10-31 — Phiếu nhập không ghi kho mặc định về Tân Tạo (phần dữ liệu).
--
-- Owner rule 12/10 (nhắc lại 13/10): every goods receipt lands at Tân Tạo. A
-- receipt whose receiving_location is null must behave as tan_tao everywhere:
--   * the goods_receipts default-location trigger fills a receipt that is still
--     null after the supplier default with 'tan_tao' (and keeps coercing q7 to
--     tan_tao together with the central guard);
--   * every read-only definition that fell back to 'q7' for a null location now
--     falls back to 'tan_tao';
--   * existing null-location receipts move to 'tan_tao' with one
--     stock_location_moves audit row each, except the receipts that already
--     posted a line to the Q7 ledger: those are pinned to 'q7' so the yard does
--     not change for already-posted stock.
--
-- Re-created functions (body taken from the newest definition, only the
-- coalesce fallback literal changes from 'q7' to 'tan_tao'):
--   * public.get_material_alias_backlog(text, integer)            20261025100000
--   * public.get_material_alias_backlog_review(text, integer)     20261027100000
--   * public.receipt_lines_for_game_base(integer)                 20261028110000
--   * public.list_unmatched_purchase_names(text, integer)         20261021100000
--   * public.stock_ledger_default_goods_receipt_location()        20261013100000
--     (adds the null -> tan_tao fallback; the central q7 -> tan_tao guard is
--     kept and is also reflected for a q7 supplier default on insert).
--
-- Readers that defaulted to q7 elsewhere are covered transitively; they are not
-- redefined here because they carry no q7 fallback of their own:
--   * public.get_crate_receipt_lines / public.get_item_receipt_lines
--     (20261029150000) build their rows from receipt_lines_for_game_base;
--   * public.get_warehouse_game_snapshot (20261026100000) builds its pending
--     list from get_material_alias_backlog_review;
--   * public.list_unknown_purchase_units / stock_unknown_purchase_unit_rows
--     (20261024100000) never classify by receiving_location;
--   * public.post_stock_goods_receipt_item (20261029150000) posts by the alias
--     location, not by the receipt's receiving_location.
--
-- Edge function default (the Maestro owns edge code; not edited here):
--   * apps/web/supabase/functions/stock-alias-jev/store.ts, mapNewItemRun:
--     `location: String(row.location ?? "q7")` still defaults a new-item run
--     with a null location to q7 and should read tan_tao.
--
-- The backfill writes only goods_receipts.receiving_location and the
-- append-only public.stock_location_moves audit rows. It never inserts,
-- updates or deletes a q7_inventory_movements, tan_tao_material_movements,
-- tan_tao_warehouse_movements or tan_tao_warehouse_documents row. The
-- goods_receipts posting trigger and the central q7 -> tan_tao guard are
-- disabled only for the duration of the data move and re-enabled before the
-- file ends, so a location-only update can neither post stock nor be coerced.
--
-- This file runs in one transaction. It does not apply itself and never runs a
-- CLI push; the Maestro applies it.

-- ===========================================================================
-- 1. public.get_material_alias_backlog: null location -> tan_tao
-- ===========================================================================

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
      coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') as location,
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
      and coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') = p_location
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

-- get_material_alias_backlog: grants identical to 20261025100000.
revoke all on function public.get_material_alias_backlog(text, integer) from public, anon, authenticated;
grant execute on function public.get_material_alias_backlog(text, integer) to service_role;

-- ===========================================================================
-- 2. public.get_material_alias_backlog_review: null location -> tan_tao
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

-- get_material_alias_backlog_review: grants identical to 20261027100000.
revoke all on function public.get_material_alias_backlog_review(text, integer) from public, anon;
grant execute on function public.get_material_alias_backlog_review(text, integer) to authenticated, service_role;

-- ===========================================================================
-- 3. public.receipt_lines_for_game_base: null location -> tan_tao
-- ===========================================================================

create or replace function public.receipt_lines_for_game_base(p_window_days integer)
 returns table (
   goods_receipt_id uuid,
   goods_receipt_item_id uuid,
   location text,
   supplier_id uuid,
   normalized_name text,
   raw_name text,
   receipt_number text,
   receipt_date date,
   status text,
   quantity numeric,
   unit text,
   unit_price numeric,
   line_total numeric,
   image_path text,
   photo_paths text[]
 )
 language sql
 stable security definer
 set search_path = public, pg_temp
as $function$
  select
    gr.id as goods_receipt_id,
    gri.id as goods_receipt_item_id,
    coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') as location,
    gr.supplier_id as supplier_id,
    public.normalize_stock_item_name(
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
    ) as normalized_name,
    coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as raw_name,
    gr.receipt_number,
    gr.receipt_date,
    gr.status::text as status,
    coalesce(gri.actual_quantity, gri.quantity) as quantity,
    nullif(btrim(gri.unit), '') as unit,
    gri.unit_price,
    coalesce(gri.actual_quantity, gri.quantity) * gri.unit_price as line_total,
    nullif(btrim(gr.image_url), '') as image_path,
    coalesce(gr.product_photos, '{}'::text[]) as photo_paths
  from public.goods_receipt_items gri
  join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  left join public.suppliers s on s.id = gr.supplier_id
  where gr.status in ('confirmed', 'received')
    and coalesce(s.stock_exempt, false) = false
    and coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') in ('q7', 'tan_tao')
    and public.stock_line_auto_non_stock(
          coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
        ) is null
    and (
      p_window_days is null
      or gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - p_window_days
    );
$function$;

-- receipt_lines_for_game_base: grants identical to 20261028110000.
revoke all on function public.receipt_lines_for_game_base(integer) from public, anon, authenticated;
grant execute on function public.receipt_lines_for_game_base(integer) to service_role;

-- ===========================================================================
-- 4. public.list_unmatched_purchase_names: null location -> tan_tao
-- ===========================================================================

create or replace function public.list_unmatched_purchase_names(
  p_location text,
  p_days integer default 60
)
returns table (
  supplier_id uuid,
  normalized_name text,
  raw_name text,
  raw_unit text,
  receipt_count bigint,
  receipt_days bigint,
  first_date date,
  last_date date,
  has_exact_candidate boolean,
  cached_match_item_id uuid,
  cached_match_line_type text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 60), 365));
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_prompt text := 'jev-material-alias-2026-10-20.1';
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
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
      and gr.receipt_date >= v_today - v_days
  ),
  pending as (
    select
      l.supplier_id,
      l.location,
      l.normalized_name,
      count(*)::bigint as receipt_count,
      count(distinct l.receipt_date)::bigint as receipt_days,
      min(l.receipt_date) as first_date,
      max(l.receipt_date) as last_date,
      (array_agg(l.raw_name order by l.receipt_date desc, l.raw_name))[1] as raw_name,
      (array_agg(l.raw_unit order by l.receipt_date desc, l.raw_name))[1] as raw_unit
    from lines l
    where l.normalized_name is not null
      and not exists (
        select 1 from public.stock_material_aliases a
        where a.location = l.location
          and a.normalized_name = l.normalized_name
          and a.supplier_id is not distinct from l.supplier_id
      )
    group by l.supplier_id, l.location, l.normalized_name
  )
  select
    p.supplier_id,
    p.normalized_name,
    p.raw_name,
    p.raw_unit,
    p.receipt_count,
    p.receipt_days,
    p.first_date,
    p.last_date,
    exists (
      select 1
      from public.material_alias_candidates(p.raw_name, p.location, 5) c
      where c.reason like 'name_exact%'
    ) as has_exact_candidate,
    nullif(cache.answer ->> 'item_id', '')::uuid as cached_match_item_id,
    cache.answer ->> 'line_type' as cached_match_line_type
  from pending p
  left join lateral (
    select z.answer
    from public.material_alias_jev_cache z
    where z.location = p.location
      and z.normalized_name = p.normalized_name
      and z.supplier_id is not distinct from p.supplier_id
      and z.prompt_version = v_prompt
    order by z.created_at desc, z.id desc
    limit 1
  ) cache on true
  order by p.receipt_count desc, p.normalized_name asc;
end;
$$;

-- list_unmatched_purchase_names: grants identical to 20261021100000.
revoke all on function public.list_unmatched_purchase_names(text, integer) from public, anon, authenticated;
grant execute on function public.list_unmatched_purchase_names(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Default location: supplier default, then Tân Tạo (never q7)
-- ---------------------------------------------------------------------------
-- The central guard already maps an explicit q7 to tan_tao on insert/update.
-- This trigger runs after it on insert, so it must also map a q7 supplier
-- default to tan_tao; a receipt that is still null lands at Tân Tạo.

create or replace function public.stock_ledger_default_goods_receipt_location()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.receiving_location is null and new.supplier_id is not null then
    select s.default_receiving_location
    into new.receiving_location
    from public.suppliers s
    where s.id = new.supplier_id;
  end if;
  if new.receiving_location is null or new.receiving_location = 'q7' then
    new.receiving_location := 'tan_tao';
  end if;
  return new;
end;
$$;

revoke all on function public.stock_ledger_default_goods_receipt_location() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. Backfill: a null-location receipt gets its real yard
-- ---------------------------------------------------------------------------
-- A null-location receipt that already wrote a q7 'goods_receipt' movement
-- keeps the yard the stock already reached: pin it to 'q7' (no effective move,
-- so no audit row). Every other null-location receipt moves to 'tan_tao' and
-- gets one stock_location_moves audit row, reason
-- 'null location → default (owner 13/10)', exactly like the central-warehouse
-- migration did. The Q7 -> Tân Tạo guard and the posting trigger are disabled
-- only for the data move so a location-only update can neither be coerced back
-- nor post stock; both are re-enabled before the file ends.

alter table public.goods_receipts disable trigger goods_receipts_central_receiving_guard;
alter table public.goods_receipts disable trigger goods_receipts_stock_ledger_post;

do $$
declare
  v_q7 integer := 0;
  v_tan_tao integer := 0;
begin
  with pinned as (
    update public.goods_receipts gr
    set receiving_location = 'q7'
    where gr.receiving_location is null
      and exists (
        select 1
        from public.goods_receipt_items gri
        join public.q7_inventory_movements m
          on m.source = 'goods_receipt'
         and m.source_ref_key = 'gr-item:' || gri.id::text
        where gri.goods_receipt_id = gr.id
      )
    returning gr.id
  )
  select count(*) into v_q7 from pinned;

  with moved as (
    update public.goods_receipts gr
    set receiving_location = 'tan_tao'
    where gr.receiving_location is null
    returning gr.id
  )
  insert into public.stock_location_moves (
    goods_receipt_id, from_location, to_location, reason, moved_at
  )
  select id, 'q7', 'tan_tao', 'null location → default (owner 13/10)', now()
  from moved;
  get diagnostics v_tan_tao = row_count;

  raise notice 'receipts_default_tan_tao: q7-pinned=%, tan_tao-moved=%', v_q7, v_tan_tao;
end $$;

alter table public.goods_receipts enable trigger goods_receipts_central_receiving_guard;
alter table public.goods_receipts enable trigger goods_receipts_stock_ledger_post;


-- (2) Assertions. Any failure aborts the transaction before the final PASS.
do $smoke$
declare
  v_owner uuid;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_supplier uuid;
  v_supplier_q7 uuid;
  v_receipt uuid;
  v_loc text;
  v_bad integer;
  v_changed integer;
  v_audit integer;
  v_audit_before integer;
  v_audit_distinct integer;
  v_q7_before integer;
  v_tt_before integer;
  v_q7_after integer;
  v_tt_after integer;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;

  ------------------------------------------------------------------
  -- (a) no null receiving_location remains
  ------------------------------------------------------------------
  select count(*) into v_bad
  from public.goods_receipts
  where receiving_location is null;
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL null_location_left %', v_bad;
  end if;

  ------------------------------------------------------------------
  -- (b) posted pre-null receipts keep q7, the rest move to tan_tao
  ------------------------------------------------------------------
  select count(*) into v_bad
  from smoke_rdtt_pre_null p
  join public.goods_receipts gr on gr.id = p.receipt_id
  where (p.posted_q7 and gr.receiving_location is distinct from 'q7')
     or (not p.posted_q7 and gr.receiving_location is distinct from 'tan_tao');
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL pinned_location %', v_bad;
  end if;

  ------------------------------------------------------------------
  -- (c) one audit row per receipt that actually moved to tan_tao
  ------------------------------------------------------------------
  select count(*) into v_changed
  from smoke_rdtt_pre_null
  where posted_q7 = false;
  select n into v_audit_before from smoke_rdtt_audit_before;
  select count(*), count(distinct goods_receipt_id)
    into v_audit, v_audit_distinct
  from public.stock_location_moves
  where reason = 'null location → default (owner 13/10)';
  if v_audit - v_audit_before <> v_changed then
    raise exception 'SMOKE_RESULT FAIL audit_count moved=% audit=% before=%',
      v_changed, v_audit, v_audit_before;
  end if;
  if v_audit <> v_audit_distinct then
    raise exception 'SMOKE_RESULT FAIL audit_not_one_per_receipt total=% distinct=%',
      v_audit, v_audit_distinct;
  end if;
  -- a q7-pinned receipt is not an effective move and must not be audited
  select count(*) into v_bad
  from smoke_rdtt_pre_null p
  join public.stock_location_moves m
    on m.goods_receipt_id = p.receipt_id
   and m.reason = 'null location → default (owner 13/10)'
  where p.posted_q7 = true;
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL audit_pinned %', v_bad;
  end if;

  ------------------------------------------------------------------
  -- (d) the q7 backlog no longer carries a crate that only null-location,
  --     unposted receipts formed before the migration
  ------------------------------------------------------------------
  select count(*) into v_bad
  from public.get_material_alias_backlog_review('q7', 200) c
  join smoke_rdtt_q7_only_null x
    on x.supplier_id is not distinct from c.supplier_id
   and x.normalized_name = c.normalized_name;
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL q7_only_null_crate %', v_bad;
  end if;

  ------------------------------------------------------------------
  -- (e) new receipts: supplier with no default -> tan_tao; a q7 supplier
  --     default is coerced too
  ------------------------------------------------------------------
  insert into public.suppliers (name)
  values ('SMOKE rdtt no default ' || v_suffix)
  returning id into v_supplier;

  insert into public.goods_receipts
    (receipt_number, receipt_date, supplier_id, status, payable_status)
  values
    ('SMOKE-RDTT-' || v_suffix, current_date, v_supplier, 'confirmed', 'not_generated')
  returning id into v_receipt;

  select gr.receiving_location into v_loc
  from public.goods_receipts gr where gr.id = v_receipt;
  if v_loc is distinct from 'tan_tao' then
    raise exception 'SMOKE_RESULT FAIL default_tan_tao %', v_loc;
  end if;

  insert into public.suppliers (name, default_receiving_location)
  values ('SMOKE rdtt q7 default ' || v_suffix, 'q7')
  returning id into v_supplier_q7;

  insert into public.goods_receipts
    (receipt_number, receipt_date, supplier_id, status, payable_status)
  values
    ('SMOKE-RDTTQ7-' || v_suffix, current_date, v_supplier_q7, 'confirmed', 'not_generated')
  returning id into v_receipt;

  select gr.receiving_location into v_loc
  from public.goods_receipts gr where gr.id = v_receipt;
  if v_loc is distinct from 'tan_tao' then
    raise exception 'SMOKE_RESULT FAIL q7_supplier_default_tan_tao %', v_loc;
  end if;

  ------------------------------------------------------------------
  -- (f) the backfill never touched a ledger row
  ------------------------------------------------------------------
  select q7_count, tt_count into v_q7_before, v_tt_before
  from smoke_rdtt_ledger_before;
  select count(*) into v_q7_after from public.q7_inventory_movements;
  select count(*) into v_tt_after from public.tan_tao_material_movements;
  if v_q7_after <> v_q7_before or v_tt_after <> v_tt_before then
    raise exception 'SMOKE_RESULT FAIL ledger_counts q7 %->% tt %->%',
      v_q7_before, v_q7_after, v_tt_before, v_tt_after;
  end if;

  raise exception 'SMOKE_RESULT PASS: receipts default tan tao';
end;
$smoke$;
