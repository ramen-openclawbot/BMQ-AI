-- Rollback-only production smoke for migration
-- 20261028110000_receipt_lines_for_game.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_receipt_lines_for_game.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_receipt_lines_for_game.sql).
--
-- The file opens one transaction, impersonates the real owner through
-- request.jwt.claims, applies the migration SQL inline, then asserts that:
--   (a) for the first 5 crates of get_material_alias_backlog_review('tan_tao',
--       200) the crate RPC returns exactly line_count rows (or p_limit when
--       smaller), every row carries the documented keys and every
--       goods_receipt_item_id is a real line of that supplier / normalized name;
--   (b) at least one returned row carries a non-null image_path when any
--       receipt line of those crates in the 90-day window has one;
--   (c) for an item with aliases, every returned line maps back to one of its
--       aliases;
--   (d) a non-admin user (skipped with a notice when none exists) gets 42501.
-- The final RAISE aborts the transaction, so every change rolls back.
begin;

-- (0) The owner is taken from public.user_roles and impersonated through
-- request.jwt.claims, so the crate list can be read before the migration.
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

-- (1) Apply the migration SQL inline, byte-for-byte.

-- 2026-10-28 — Phiếu giao hàng cho thùng chờ và mặt hàng (phần dữ liệu).
--
-- Read-only additive migration on top of 20261027100000_backlog_raw_unit.sql.
-- It adds one internal helper and two client RPCs that return the goods
-- receipt lines behind the Kho 2D game, together with the delivery-note image
-- path of their receipt:
--
--   * public.receipt_lines_for_game_base(integer) — internal helper. It selects
--     exactly the line set of public.get_material_alias_backlog_review(
--     text, integer) from 20261027100000_backlog_raw_unit.sql: same name
--     normalization, status in ('confirmed', 'received'), location coalesce,
--     stock_exempt false, stock_line_auto_non_stock(...) is null and the
--     90-day receipt_date window (Asia/Ho_Chi_Minh). The window is a parameter
--     so the item RPC can ask for the whole history while the crate RPC keeps
--     the backlog's 90 days.
--   * public.get_crate_receipt_lines(text, uuid, text, integer) — the receipt
--     lines of one pending crate (supplier + normalized name + location).
--   * public.get_item_receipt_lines(uuid, integer) — the latest receipt lines
--     matching any alias of one kitchen item, with no day limit.
--
-- Both RPCs return a jsonb array ordered by receipt_date desc, receipt_number
-- desc. Each object carries goods_receipt_id, goods_receipt_item_id,
-- receipt_number, receipt_date, status, supplier_name, raw_name,
-- quantity (coalesce(actual_quantity, quantity)), unit, unit_price, line_total
-- (goods_receipt_items has no total column, so it is quantity * unit_price),
-- image_path (goods_receipts.image_url trimmed to null) and photo_paths
-- (goods_receipts.product_photos, [] when null). image_url stores a storage
-- path such as 'goods-receipts/delivery-note-<id>-<ts>.jpg' that lives in the
-- 'invoices' bucket; the client builds the signed URL.
--
-- The whole file runs in one transaction and writes nothing. The two backlog
-- functions from 20261025100000 / 20261027100000 are not touched.

-- ---------------------------------------------------------------------------
-- 1. Shared line rules (internal — no client role may call it directly).
-- ---------------------------------------------------------------------------

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
    coalesce(gr.receiving_location, s.default_receiving_location, 'q7') as location,
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
    and coalesce(gr.receiving_location, s.default_receiving_location, 'q7') in ('q7', 'tan_tao')
    and public.stock_line_auto_non_stock(
          coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
        ) is null
    and (
      p_window_days is null
      or gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - p_window_days
    );
$function$;

revoke all on function public.receipt_lines_for_game_base(integer) from public, anon, authenticated;
grant execute on function public.receipt_lines_for_game_base(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Receipt lines behind one pending crate.
-- ---------------------------------------------------------------------------

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
        b.raw_name,
        b.quantity,
        b.unit,
        b.unit_price,
        b.line_total,
        b.image_path,
        b.photo_paths
      from public.receipt_lines_for_game_base(90) b
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

-- ---------------------------------------------------------------------------
-- 3. Receipt lines behind one kitchen item (through its aliases).
-- ---------------------------------------------------------------------------

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
        b.raw_name,
        b.quantity,
        b.unit,
        b.unit_price,
        b.line_total,
        b.image_path,
        b.photo_paths
      from public.receipt_lines_for_game_base(null) b
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

-- (2) The 90-day Tân Tạo lines the crate RPC is allowed to see, recomputed
-- directly so image_path and membership can be checked without trusting the
-- function under test.
create temp table smoke_receipt_lines as
select
  gr.id as goods_receipt_id,
  gri.id as goods_receipt_item_id,
  coalesce(gr.receiving_location, s.default_receiving_location, 'q7') as location,
  gr.supplier_id,
  public.normalize_stock_item_name(
    coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
  ) as normalized_name,
  nullif(btrim(gr.image_url), '') as image_path
from public.goods_receipt_items gri
join public.goods_receipts gr on gr.id = gri.goods_receipt_id
left join public.suppliers s on s.id = gr.supplier_id
where gr.status in ('confirmed', 'received')
  and coalesce(s.stock_exempt, false) = false
  and coalesce(gr.receiving_location, s.default_receiving_location, 'q7') in ('q7', 'tan_tao')
  and public.stock_line_auto_non_stock(
        coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
      ) is null
  and gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90;

-- (3) The first 5 pending crates of Tân Tạo.
create temp table smoke_receipt_crates as
select c.*
from public.get_material_alias_backlog_review('tan_tao', 200) c
limit 5;

-- (4) Assertions. Any failure aborts the transaction before the final PASS.
do $smoke$
declare
  v_crate record;
  v_limit integer := 50;
  v_rows jsonb;
  v_bad integer;
  v_image_rows integer := 0;
  v_window_images integer;
  v_item_id uuid;
  v_item_rows jsonb;
  v_non_admin uuid;
  v_denied boolean := false;
begin
  -- (a) Crate row counts, keys and line membership.
  for v_crate in select * from smoke_receipt_crates loop
    v_rows := public.get_crate_receipt_lines(
      'tan_tao', v_crate.supplier_id, v_crate.normalized_name, v_limit
    );

    if jsonb_typeof(v_rows) <> 'array' then
      raise exception 'SMOKE_RESULT FAIL crate_not_array %', v_crate.normalized_name;
    end if;

    if jsonb_array_length(v_rows) <> least(v_crate.line_count, v_limit) then
      raise exception 'SMOKE_RESULT FAIL crate_count % expected=% got=%',
        v_crate.normalized_name,
        least(v_crate.line_count, v_limit),
        jsonb_array_length(v_rows);
    end if;

    select count(*) into v_bad
    from jsonb_array_elements(v_rows) e
    cross join unnest(array[
      'goods_receipt_id',
      'goods_receipt_item_id',
      'receipt_number',
      'receipt_date',
      'status',
      'supplier_name',
      'raw_name',
      'quantity',
      'unit',
      'unit_price',
      'line_total',
      'image_path',
      'photo_paths'
    ]) k(key)
    where not (e ? k.key);
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL crate_keys % bad=%', v_crate.normalized_name, v_bad;
    end if;

    select count(*) into v_bad
    from jsonb_array_elements(v_rows) e
    where not exists (
      select 1
      from smoke_receipt_lines l
      where l.goods_receipt_item_id = (e ->> 'goods_receipt_item_id')::uuid
        and l.location = 'tan_tao'
        and l.supplier_id is not distinct from v_crate.supplier_id
        and l.normalized_name = v_crate.normalized_name
    );
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL crate_membership % bad=%',
        v_crate.normalized_name, v_bad;
    end if;

    select count(*) into v_bad
    from jsonb_array_elements(v_rows) e
    where nullif(btrim(e ->> 'image_path'), '') is not null;
    v_image_rows := v_image_rows + v_bad;
  end loop;

  -- (b) Delivery-note image coverage for the crates above.
  select count(*) into v_window_images
  from smoke_receipt_lines l
  join smoke_receipt_crates c
    on l.supplier_id is not distinct from c.supplier_id
   and l.normalized_name = c.normalized_name
  where l.location = 'tan_tao'
    and l.image_path is not null;

  if v_window_images > 0 and v_image_rows = 0 then
    raise exception 'SMOKE_RESULT FAIL image_path_missing window=%', v_window_images;
  elsif v_window_images = 0 then
    raise notice 'SMOKE notice: no delivery-note image in the 90-day Tân Tạo crate window';
  end if;

  -- (c) An item with aliases: every returned line maps back to one alias.
  select a.kitchen_inventory_item_id into v_item_id
  from public.stock_material_aliases a
  where a.kitchen_inventory_item_id is not null
  order by a.created_at, a.id
  limit 1;

  if v_item_id is null then
    raise notice 'SMOKE notice: no kitchen item with aliases to test';
  else
    v_item_rows := public.get_item_receipt_lines(v_item_id, 30);

    if jsonb_typeof(v_item_rows) <> 'array' then
      raise exception 'SMOKE_RESULT FAIL item_not_array';
    end if;
    if jsonb_array_length(v_item_rows) > 30 then
      raise exception 'SMOKE_RESULT FAIL item_limit got=%', jsonb_array_length(v_item_rows);
    end if;

    select count(*) into v_bad
    from jsonb_array_elements(v_item_rows) e
    where not exists (
      select 1
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      left join public.suppliers s on s.id = gr.supplier_id
      where gri.id = (e ->> 'goods_receipt_item_id')::uuid
        and exists (
          select 1
          from public.stock_material_aliases a
          where a.kitchen_inventory_item_id = v_item_id
            and a.location = coalesce(gr.receiving_location, s.default_receiving_location, 'q7')
            and a.normalized_name = public.normalize_stock_item_name(
                  coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
                )
            and a.supplier_id is not distinct from gr.supplier_id
        )
    );
    if v_bad <> 0 then
      raise exception 'SMOKE_RESULT FAIL item_alias_map bad=%', v_bad;
    end if;
  end if;

  -- (d) A non-admin gets 42501.
  select u.id into v_non_admin
  from auth.users u
  where not public.material_alias_can_admin(u.id)
  order by u.id
  limit 1;

  if v_non_admin is null then
    raise notice 'SMOKE notice: no non-admin user to test 42501';
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', v_non_admin, 'role', 'authenticated')::text,
      true
    );
    begin
      perform public.get_crate_receipt_lines('tan_tao', null, 'khong_ton_tai', 5);
    exception
      when insufficient_privilege then
        v_denied := true;
    end;
    if not v_denied then
      raise exception 'SMOKE_RESULT FAIL non_admin_allowed';
    end if;
  end if;

  raise exception 'SMOKE_RESULT PASS: receipt lines for game';
end;
$smoke$;
