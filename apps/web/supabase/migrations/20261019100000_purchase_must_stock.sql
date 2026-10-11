-- Giai đoạn 4: a purchase line that must be received (hàng mua bắt buộc nhập kho)
-- drops its VAT, shipping and service lines automatically.
--
-- Additive migration for the "purchase must stock" flow (data layer only). It
-- adds a fixed-rule classifier and reuses it in the alias flow:
--   * public.stock_line_auto_non_stock(text) immutable, mirrors the TS helper
--     autoNonStockReason and the shared STOCK_LINE_AUTO_NON_STOCK_TEST_CASES;
--   * redefined post_goods_receipt_to_stock / get_stock_ledger_overview /
--     get_material_alias_backlog: a rule line is skipped and never counted as
--     pending / pending_alias_count;
--   * redefined suggest_material_aliases: a rule line (or a >= 0.9 Jev
--     non_goods answer) comes back with needs_prompt false and auto_non_stock;
--   * redefined confirm_material_alias (13-arg + the old 12-arg wrapper): a
--     hand-picked non_stock for a name the rule does not classify needs an
--     admin (material_alias_can_admin).
--
-- It never applies a migration by itself, never deploys and never calls Jev.
-- No UPDATE or DELETE on purchase_orders, payment_requests, goods_receipt_items
-- or q7_inventory_movements. The ledger idempotency key ('gr-item:') and the
-- on conflict guards stay in the untouched post_stock_goods_receipt_item.

-- ---------------------------------------------------------------------------
-- 1. Fixed non-stock rule for purchase lines that must not be received
-- ---------------------------------------------------------------------------
-- A purchase line is never received into stock when its normalized name holds
-- one of the fixed phrases below: it is VAT, a shipping / service fee or a
-- service. Matching is done on whole space-delimited tokens (or a known
-- multi-word phrase), so the single token "phi" is deliberately never a match
-- and a real material such as "Tỏi phi" stays a stock line.
--
-- Case table shared by this migration, src/lib/material-alias.ts,
-- supabase/functions/stock-alias-jev/jev.ts STOCK_LINE_AUTO_NON_STOCK_TEST_CASES
-- and scripts/smoke_purchase_must_stock.sql:
--   'Thuế VAT 8%'          -> vat
--   'VAT'                  -> vat
--   'Thuế GTGT'            -> vat
--   'Phí vận chuyển'       -> fee
--   'Phụ phí giao hàng'    -> fee
--   'Cước ship nội thành'  -> fee
--   'Vận chuyển hàng'      -> fee
--   'Xử lý côn trùng'      -> service
--   'Phí phân tích mẫu'    -> service
--   'Thuê máy'             -> service
--   'Tỏi phi'              -> null
--   'Bánh mì lớn 17'       -> null
--   'Phô mai Dairymont'    -> null
--   'Ship hàng'            -> fee
--   'Cước Rửa Chén TBP x 4 Miếng' -> null
--   'Cước điện thoại_0966998998' -> fee
--   'Thuê nhà Q.7 T9/26'   -> service

create or replace function public.stock_line_auto_non_stock(p_name text)
returns text
language sql
immutable
set search_path = public, pg_catalog
as $$
  with n as (
    select ' ' || public.normalize_stock_item_name(p_name) || ' ' as v
  )
  select case
    -- Rent is a service even though it starts with 'thue' and carries a month number.
    when n.v like ' thue nha %' or n.v like '% thue mat bang %' or n.v like '% tien nha %'
      then 'service'
    when n.v like '% vat %'
      or n.v like '% thue gtgt %'
      or n.v like '% thue vat %'
      or n.v like '% gtgt %'
      or (n.v like ' thue %' and (n.v ~ '[0-9]' or n.v like '%vat%'))
      then 'vat'
    when n.v like '% phi van chuyen %'
      or n.v like '% phi giao hang %'
      or n.v like '% phu phi %'
      or n.v like '% phi ship %'
      -- Never the bare word 'cuoc': OCR reads 'Cuộn mút' as 'Cước mút'.
      or n.v like '% cuoc van chuyen %'
      or n.v like '% cuoc ship %'
      or n.v like '% cuoc giao hang %'
      or n.v like '% cuoc dien thoai%'
      or n.v like '% cuoc dau so%'
      or n.v like '% cuoc internet%'
      or n.v like '% van chuyen %'
      or n.v like '% giao hang %'
      or n.v like '% ship %'
      then 'fee'
    when n.v like '% dich vu %'
      or n.v like '% xu ly con trung %'
      or n.v like '% phan tich mau %'
      or n.v like '% thue may %'
      or n.v like '% bao tri %'
      or n.v like '% sua chua %'
      or n.v like '% chiet khau %'
      then 'service'
    else null
  end
  from n;
$$;

revoke all on function public.stock_line_auto_non_stock(text) from public, anon;
grant execute on function public.stock_line_auto_non_stock(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. post_goods_receipt_to_stock: skip a rule line
-- ---------------------------------------------------------------------------

create or replace function public.post_goods_receipt_to_stock(p_receipt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.goods_receipts%rowtype;
  v_cutover date;
  v_item record;
  v_name text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_posted integer := 0;
  v_pending integer := 0;
  v_supplier_exempt boolean := false; -- [Giai đoạn 3]
begin
  select * into v_receipt from public.goods_receipts where id = p_receipt_id;
  if not found then
    return jsonb_build_object('status', 'receipt_not_found');
  end if;

  -- [Giai đoạn 3] A stock_exempt supplier (dịch vụ, phí, vận chuyển) never posts.
  if v_receipt.supplier_id is not null then
    select s.stock_exempt into v_supplier_exempt
    from public.suppliers s
    where s.id = v_receipt.supplier_id;
  end if;
  if coalesce(v_supplier_exempt, false) then
    return jsonb_build_object(
      'status', 'supplier_exempt',
      'receipt_id', p_receipt_id,
      'supplier_id', v_receipt.supplier_id
    );
  end if;

  if v_receipt.status not in ('confirmed', 'received') then
    return jsonb_build_object('status', 'not_confirmed');
  end if;
  if v_receipt.receiving_location is null then
    return jsonb_build_object('status', 'missing_receiving_location');
  end if;

  v_cutover := public.stock_ledger_cutover_date(v_receipt.receiving_location);
  if v_cutover is null then
    return jsonb_build_object('status', 'cutover_not_set');
  end if;
  if v_receipt.receipt_date < v_cutover then
    return jsonb_build_object('status', 'before_cutover');
  end if;

  for v_item in
    select gri.id,
           coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as item_name
    from public.goods_receipt_items gri
    where gri.goods_receipt_id = p_receipt_id
    order by gri.created_at asc, gri.id asc
  loop
    -- [2026-10-19] A line the fixed rule marks as VAT / fee / service never
    -- posts and is never counted as pending. The ledger idempotency key
    -- ('gr-item:' + item id) and its on conflict (source, source_ref_key)
    -- guard live in post_stock_goods_receipt_item, which is unchanged.
    if public.stock_line_auto_non_stock(v_item.item_name) is not null then
      continue;
    end if;

    v_norm := public.normalize_stock_item_name(v_item.item_name);
    if v_norm is null then
      v_pending := v_pending + 1;
      continue;
    end if;

    v_alias := null;
    select * into v_alias
    from public.resolve_stock_material_alias(v_receipt.supplier_id, v_norm, v_receipt.receiving_location);
    if v_alias.id is null then
      v_pending := v_pending + 1;
      continue;
    end if;

    -- [Giai đoạn 3] A non_stock alias is intentionally skipped and is not pending.
    if v_alias.line_class = 'non_stock' then
      continue;
    end if;

    if public.post_stock_goods_receipt_item(v_item.id, v_alias) then
      v_posted := v_posted + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'posted',
    'receipt_id', p_receipt_id,
    'location', v_receipt.receiving_location,
    'posted_count', v_posted,
    'pending_alias_count', v_pending
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. get_stock_ledger_overview: pending excludes rule lines
-- ---------------------------------------------------------------------------

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
      -- [Giai đoạn 3] resolved alias (if any), kept from resolve_stock_material_alias.
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
        -- [Giai đoạn 3] a stock_exempt supplier is not waiting for an alias.
        and coalesce(sup.stock_exempt, false) = false
        and ra.alias_id is null
        -- [Giai đoạn 3] a non_stock alias never shows as pending.
        and coalesce(ra.line_class, 'stock') <> 'non_stock'
        -- [2026-10-19] a line the fixed rule marks as VAT / fee / service
        -- never waits for an alias.
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
    'pending_aliases', v_pending
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. get_material_alias_backlog: rule lines are not ranked
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
  order by count(*) desc, l.normalized_name asc
  limit greatest(1, least(coalesce(p_limit, 200), 200));
$$;

-- ---------------------------------------------------------------------------
-- 5. suggest_material_aliases: expose auto_non_stock
-- ---------------------------------------------------------------------------

create or replace function public.suggest_material_aliases(
  p_supplier_id uuid,
  p_location text,
  p_lines jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line jsonb;
  v_line_key text;
  v_raw_name text;
  v_raw_unit text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_item_name text;
  v_candidates jsonb;
  v_candidate_ids text[];
  v_candidates_hash text;
  v_cache public.material_alias_jev_cache%rowtype;
  v_alias_json jsonb;
  v_jev jsonb;
  v_pack jsonb;
  v_needs_prompt boolean;
  v_rule text;
  v_auto_non_stock jsonb;
  v_jev_probability numeric;
  v_result jsonb := '[]'::jsonb;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines_required' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'too_many_lines' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_line_key := nullif(btrim(coalesce(v_line ->> 'line_key', '')), '');
    v_raw_name := coalesce(nullif(btrim(v_line ->> 'raw_name'), ''), '');
    v_raw_unit := nullif(btrim(v_line ->> 'raw_unit'), '');
    if v_line_key is null or v_raw_name = '' then
      continue;
    end if;

    v_norm := public.normalize_stock_item_name(v_raw_name);

    -- [2026-10-19] The fixed rule decides VAT / fee / service before any alias
    -- or candidate lookup: no prompt, empty candidates and no Jev call.
    v_rule := public.stock_line_auto_non_stock(v_raw_name);
    if v_rule is not null then
      v_result := v_result || jsonb_build_object(
        'line_key', v_line_key,
        'normalized_name', v_norm,
        'alias', null,
        'needs_prompt', false,
        'candidates', '[]'::jsonb,
        'candidates_hash', '',
        'jev', null,
        'pack_guess', public.q7_pack_from_name(v_raw_name, v_raw_unit),
        'auto_non_stock', jsonb_build_object('reason', v_rule, 'source', 'rule')
      );
      continue;
    end if;

    v_alias := null;

    -- Prefer the supplier-specific alias, otherwise show the generic suggestion.
    select * into v_alias
    from public.stock_material_aliases a
    where a.location = p_location
      and a.normalized_name = v_norm
      and a.supplier_id is not distinct from p_supplier_id
    order by a.created_at asc, a.id asc
    limit 1;
    if v_alias.id is null then
      select * into v_alias
      from public.stock_material_aliases a
      where a.location = p_location
        and a.normalized_name = v_norm
        and a.supplier_id is null
      order by a.created_at asc, a.id asc
      limit 1;
    end if;

    v_item_name := null;
    if v_alias.id is not null and v_alias.line_class = 'stock' then
      if p_location = 'q7' then
        select kii.name into v_item_name
        from public.kitchen_inventory_items kii
        where kii.id = v_alias.kitchen_inventory_item_id;
      else
        select ps.product_name into v_item_name
        from public.product_skus ps
        where ps.id = v_alias.tan_tao_sku_id;
      end if;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
             'id', coalesce(c.item_id, c.sku_id),
             'item_id', c.item_id,
             'sku_id', c.sku_id,
             'name', c.name,
             'unit', c.unit,
             'score', c.score,
             'reason', c.reason
           ) order by c.score desc, c.name asc, c.item_id asc nulls last, c.sku_id asc nulls last), '[]'::jsonb)
    into v_candidates
    from public.material_alias_candidates(v_raw_name, p_location, 5) c;

    select coalesce(array_agg(elem ->> 'id'), '{}'::text[])
    into v_candidate_ids
    from jsonb_array_elements(v_candidates) elem
    where elem ->> 'id' is not null;
    v_candidates_hash := public.material_alias_candidates_hash(v_candidate_ids);

    v_cache := null;
    select * into v_cache
    from public.material_alias_jev_cache z
    where z.location = p_location
      and z.normalized_name = v_norm
      and z.supplier_id is not distinct from p_supplier_id
      and z.candidates_hash = v_candidates_hash
    order by z.created_at desc, z.id desc
    limit 1;

    if v_alias.id is null then
      v_alias_json := null;
      v_needs_prompt := true;
    else
      v_alias_json := jsonb_build_object(
        'alias_id', v_alias.id,
        'status', v_alias.status,
        'line_class', v_alias.line_class,
        'item_id', v_alias.kitchen_inventory_item_id,
        'sku_id', v_alias.tan_tao_sku_id,
        'item_name', v_item_name,
        'unit', v_alias.unit,
        'conversion_factor', v_alias.conversion_factor,
        'pack_label', v_alias.pack_label,
        'confirm_count', v_alias.confirm_count,
        'confirmers_count', cardinality(coalesce(v_alias.confirmers, '{}'::uuid[])),
        'jev_disagreed', v_alias.jev_disagreed
      );
      -- [Giai đoạn 3] an auto non_stock alias needs no prompt.
      v_needs_prompt := v_alias.status <> 'auto';
    end if;

    v_pack := public.q7_pack_from_name(v_raw_name, v_raw_unit);

    -- [2026-10-19] A confident Jev "non_goods" answer marks the line
    -- non-stock without a prompt, unless an auto stock alias already exists.
    -- Rule lines already returned above.
    v_auto_non_stock := null;
    if v_cache.id is not null
       and v_cache.answer ->> 'line_type' = 'non_goods'
       and coalesce((v_cache.answer ->> 'line_type_probability')::numeric, 0) >= 0.9
       and not (v_alias.id is not null and v_alias.line_class = 'stock' and v_alias.status = 'auto') then
      v_jev_probability := (v_cache.answer ->> 'line_type_probability')::numeric;
      v_auto_non_stock := jsonb_build_object(
        'reason', 'jev',
        'source', 'jev',
        'probability', v_jev_probability
      );
      v_needs_prompt := false;
    end if;

    v_result := v_result || jsonb_build_object(
      'line_key', v_line_key,
      'normalized_name', v_norm,
      'alias', v_alias_json,
      'needs_prompt', v_needs_prompt,
      'candidates', v_candidates,
      'candidates_hash', v_candidates_hash,
      'jev', case when v_cache.id is null then null else v_cache.answer end,
      'pack_guess', v_pack,
      'auto_non_stock', v_auto_non_stock
    );
  end loop;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. confirm_material_alias: non_stock for a rule name needs no admin
-- ---------------------------------------------------------------------------

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
  -- [Giai đoạn 3] line_class is stock or non_stock.
  if p_line_class not in ('stock', 'non_stock') then
    raise exception 'line_class_invalid' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  -- [2026-10-19] Marking a line "not stock" by hand is an admin decision
  -- unless the fixed rule already classifies it as VAT / fee / service.
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
    -- No item / SKU is required and the unit falls back to the raw label.
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
      if p_kitchen_inventory_item_id is null then
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
      if p_tan_tao_sku_id is null then
        raise exception 'tan_tao_sku_required' using errcode = '22023';
      end if;
      select ps.unit into v_unit
      from public.product_skus ps
      where ps.id = p_tan_tao_sku_id
        and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');
      if v_unit is null then raise exception 'tan_tao_sku_not_found' using errcode = 'P0002'; end if;
      v_new_item := null;
      v_new_sku := p_tan_tao_sku_id;
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
    -- [Giai đoạn 3] switching stock <-> non_stock counts as a correction.
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

  -- Auto-promote only when the state actually changes.
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

  -- Apply the confirmed alias to the already-confirmed receipt lines of the same
  -- supplier, exactly like resolve_stock_alias does. [Giai đoạn 3] a non_stock
  -- alias never posts anything.
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

-- The old 12-argument signature keeps working for the current hook.
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
