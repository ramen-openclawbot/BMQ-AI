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
