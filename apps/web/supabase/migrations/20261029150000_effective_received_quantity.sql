-- ============================================================================
-- Migration: Số lượng thực nhận lấy từ số lượng đặt khi dòng phiếu nhập để 0
--
-- 2026-10-29. A goods receipt line can be stored with quantity = 0,
-- actual_quantity = null and ordered_quantity > 0 (420 of the last 712 lines in
-- the 90-day window, parent receipt already confirmed). That is a real
-- delivery: the ordered quantity is what was received and what must reach the
-- stock ledger and the delivery note.
--
-- public.goods_receipt_effective_quantity(p_actual, p_quantity, p_ordered,
-- p_status) defines the effective received quantity once:
--   * parent receipt status in ('confirmed', 'received'):
--       coalesce(actual_quantity, nullif(quantity, 0), ordered_quantity)
--   * any other status:
--       coalesce(actual_quantity, quantity)
--
-- Applied to:
--   (a) public.get_crate_receipt_lines / public.get_item_receipt_lines
--       (quantity and line_total) — the two Kho 2D delivery-note readers;
--   (b) public.post_stock_goods_receipt_item (v_qty) — which feeds the Tân Tạo
--       receipt row, the automatic Tân Tạo -> Q7 transfer and the Q7 branch.
-- Stored goods_receipt_items rows are never updated. The central-warehouse
-- transfer logic, the tan_tao cutover check and every idempotency key are kept
-- byte-for-byte.
--
-- Reader inventory (grep actual_quantity in supabase/migrations and
-- supabase/functions). "aligned" = redefined here to call the helper;
-- "left alone" = deliberately not part of this slice.
--
-- ALIGNED
--   * public.post_stock_goods_receipt_item (20261026100000) — v_qty.
--   * public.get_crate_receipt_lines (20261028110000) — quantity, line_total.
--   * public.get_item_receipt_lines (20261028110000) — quantity, line_total.
--
-- LEFT ALONE
--   * public.receipt_lines_for_game_base (20261028110000) — the internal line
--     filter behind the two RPCs. Both callers overwrite quantity / line_total
--     with the helper, so its coalesce(actual_quantity, quantity) never reaches
--     a client; the row set it selects (status, location, stock_exempt,
--     stock_line_auto_non_stock, 90-day window) stays byte-for-byte.
--   * public.get_stock_ledger_overview(text, date) -> pending_aliases
--     (20261026100000) — lists the *unaliased* lines for manual mapping. Those
--     lines have no alias and never post, so its quantity is an informational
--     hint; changing it would alter a stock reader outside the delivery-note /
--     posting slice.
--   * public.post_goods_receipt_to_stock (20261019100000) — selects line ids and
--     names only; the quantity lives in post_stock_goods_receipt_item.
--   * public.stock_goods_receipt_item_is_posted (20261022100000) — existence
--     check, no quantity.
--   * The finalize / payable / PO / auto-receive line readers that derive
--     received quantity the same way, in 20260529112600, 20260529130000,
--     20260602081500, 20260603143000, 20260603165000, 20260603172000,
--     20260603185000, 20260610153000, 20260610174500, 20260629093000,
--     20260708093000 and 20260730013000 (v_actual_quantity :=
--     greatest(0, coalesce(actual_quantity, quantity, 0)) and the line_status /
--     payable sums built on it), plus public.auto_receive_goods_receipt /
--     public.backfill_auto_receive_paid (20261012160000, which already writes
--     actual_quantity = ordered_quantity for untouched pending lines). They
--     classify or sum received quantity for payables, JEV and VAT: reading
--     ordered_quantity there would generate money documents for a line with no
--     received quantity — a finance/owner decision, not this stock slice.
--     Stored rows are not updated.
--   * public.assert_goods_receipt_materials_ready (20260817150000) and the
--     procurement controller (20260817170000) — they read the received quantity
--     only to compare it with the ordered quantity inside the shadow material
--     controller, already covered by that flag.
--   * public.get_stock_ledger_overview / public.post_stock_goods_receipt_item in
--     20261013100000, 20261017100000, 20261019100000 and 20261022100000 —
--     superseded by 20261026100000, kept as history.
--   * Edge functions: create-warehouse-receipt/index.ts normalizes
--     actual_quantity ?? quantity ?? 0 while *writing* new lines (an intake
--     default, not a reader); match-delivery-note/index.ts uses
--     ordered_quantity ?? quantity for PO matching assistance only;
--     production-material-issue-check/index.ts only names a blocker string.
--     None of them posts stock, so none is aligned here.
--
-- This file only redefines functions; it never inserts, updates or deletes a
-- goods_receipt_items / goods_receipts row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Effective received quantity (immutable, one definition).
-- ---------------------------------------------------------------------------

create or replace function public.goods_receipt_effective_quantity(
  p_actual numeric,
  p_quantity numeric,
  p_ordered numeric,
  p_status text
)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $function$
  select case
    when p_status in ('confirmed', 'received')
      then coalesce(p_actual, nullif(p_quantity, 0), p_ordered)
    else coalesce(p_actual, p_quantity)
  end;
$function$;

revoke all on function public.goods_receipt_effective_quantity(numeric, numeric, numeric, text) from public, anon;
grant execute on function public.goods_receipt_effective_quantity(numeric, numeric, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Receipt lines behind one pending crate (Kho 2D).
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

-- ---------------------------------------------------------------------------
-- 4. Goods receipt item -> stock ledger (Tân Tạo + automatic Q7 transfer).
--    Signature, transfer logic, tan_tao cutover check and idempotency keys are
--    unchanged from 20261026100000_central_warehouse_flow.sql; only v_qty uses
--    the helper.
-- ---------------------------------------------------------------------------

create or replace function public.post_stock_goods_receipt_item(
  p_item_id uuid,
  p_alias public.stock_material_aliases
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_cutover date;
  v_qty numeric;
  v_inserted integer := 0;
  v_sku_code text;
  v_doc_id uuid;
  v_doc_number text;
  v_transfer_id uuid;
  v_transfer_number text;
  v_pastry boolean;
begin
  if p_alias.line_class = 'non_stock' then
    return false;
  end if;

  select * into v_item from public.goods_receipt_items where id = p_item_id;
  if not found then
    return false;
  end if;
  select * into v_receipt from public.goods_receipts where id = v_item.goods_receipt_id;
  if not found then
    return false;
  end if;

  -- A kg / g / l / ml line converts by its own unit; packs use the alias factor.
  v_qty := round(
    greatest(0, coalesce(public.goods_receipt_effective_quantity(
      v_item.actual_quantity,
      v_item.quantity,
      v_item.ordered_quantity,
      v_receipt.status::text
    ), 0))
    * coalesce(
        case when p_alias.kitchen_inventory_item_id is not null then
          public.stock_unit_line_factor(
            v_item.unit,
            (select k.unit from public.kitchen_inventory_items k where k.id = p_alias.kitchen_inventory_item_id)
          )
        end,
        p_alias.conversion_factor
      ),
    3
  );
  if v_qty is null or v_qty <= 0 then
    return false;
  end if;

  if p_alias.location = 'q7' then
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_alias.kitchen_inventory_item_id, v_receipt.receipt_date, 'receipt', v_qty,
      p_alias.unit, 'goods_receipt', 'gr-item:' || p_item_id::text,
      'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
    get diagnostics v_inserted = row_count;
    return v_inserted > 0;
  end if;

  if p_alias.location = 'tan_tao' then
    -- Shared raw material: append to the Tân Tạo NVL ledger, same cutover rule.
    if p_alias.kitchen_inventory_item_id is not null then
      if public.stock_goods_receipt_item_is_posted(p_item_id) then
        return false;
      end if;
      v_cutover := public.stock_ledger_cutover_date('tan_tao');
      if v_cutover is null or v_receipt.receipt_date < v_cutover then
        return false;
      end if;
      insert into public.tan_tao_material_movements(
        kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
        source, source_ref_key, note, created_by
      ) values (
        p_alias.kitchen_inventory_item_id, v_receipt.receipt_date, 'receipt', v_qty,
        p_alias.unit, 'goods_receipt', 'gr-item:' || p_item_id::text,
        'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
      )
      on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
      get diagnostics v_inserted = row_count;

      -- Owner 2026-10-12: a pastry item received at Tân Tạo moves straight to Q7.
      if v_inserted > 0 then
        select k.pastry_q7 into v_pastry
        from public.kitchen_inventory_items k
        where k.id = p_alias.kitchen_inventory_item_id;

        if coalesce(v_pastry, false) then
          v_transfer_number := 'CK-'
            || to_char(coalesce(v_receipt.receipt_date, current_date), 'YYYYMMDD')
            || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

          insert into public.stock_transfers(
            transfer_number, from_location, to_location, kitchen_inventory_item_id,
            quantity, unit, transfer_date, source, goods_receipt_item_id, note, created_by
          ) values (
            v_transfer_number, 'tan_tao', 'q7', p_alias.kitchen_inventory_item_id,
            v_qty, p_alias.unit, v_receipt.receipt_date, 'auto_goods_receipt', p_item_id,
            'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
          )
          on conflict (goods_receipt_item_id) do nothing
          returning id into v_transfer_id;

          if v_transfer_id is not null then
            insert into public.tan_tao_material_movements(
              kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
              source, source_ref_key, note, created_by
            ) values (
              p_alias.kitchen_inventory_item_id, v_receipt.receipt_date, 'transfer_out', v_qty,
              p_alias.unit, 'stock_transfer', 'transfer:' || v_transfer_id::text,
              'Chuyển NVL bánh ngọt sang Q7 (phiếu nhập kho ' || v_receipt.receipt_number || ')',
              auth.uid()
            )
            on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

            insert into public.q7_inventory_movements(
              kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
              source, source_ref_key, note, created_by
            ) values (
              p_alias.kitchen_inventory_item_id, v_receipt.receipt_date, 'transfer_in', v_qty,
              p_alias.unit, 'stock_transfer', 'transfer:' || v_transfer_id::text,
              'Nhận NVL bánh ngọt từ Tân Tạo (phiếu nhập kho ' || v_receipt.receipt_number || ')',
              auth.uid()
            )
            on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
          end if;
        end if;
      end if;

      return v_inserted > 0;
    end if;

    -- Finished-goods SKU: unchanged document path.
    if public.stock_goods_receipt_item_is_posted(p_item_id) then
      return false;
    end if;
    select upper(sku_code) into v_sku_code
    from public.product_skus
    where id = p_alias.tan_tao_sku_id;
    if v_sku_code is null
       or v_sku_code not in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G') then
      return false;
    end if;

    v_doc_number := 'TT-GR-' || to_char(coalesce(v_receipt.receipt_date, current_date), 'YYYYMMDD')
      || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

    insert into public.tan_tao_warehouse_documents(
      document_number, location_code, sku_id, sku_code_snapshot, document_type, status,
      quantity, physical_quantity, source_authority, reference_type, reference_id,
      reference_label, idempotency_key, note, metadata, created_by
    ) values (
      v_doc_number, 'warehouse_tan_tao', p_alias.tan_tao_sku_id, v_sku_code, 'receipt', 'posted',
      v_qty, v_qty, 'confirmed_goods_receipt', 'goods_receipt', v_receipt.id,
      v_receipt.receipt_number, 'gr-item:' || p_item_id::text,
      'Phiếu nhập kho ' || v_receipt.receipt_number,
      jsonb_build_object('goods_receipt_id', v_receipt.id, 'goods_receipt_item_id', p_item_id, 'stock_effect', 'receipt'),
      auth.uid()
    )
    on conflict (idempotency_key) do nothing
    returning id into v_doc_id;

    if v_doc_id is null then
      return false;
    end if;

    insert into public.tan_tao_warehouse_movements(
      document_id, location_code, sku_id, sku_code_snapshot, movement_type, quantity, note, created_by
    ) values (
      v_doc_id, 'warehouse_tan_tao', p_alias.tan_tao_sku_id, v_sku_code, 'receipt', v_qty,
      'Phiếu nhập kho ' || v_receipt.receipt_number, auth.uid()
    );
    return true;
  end if;

  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants (identical to the definitions replaced above).
-- ---------------------------------------------------------------------------

revoke all on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) from public, anon, authenticated;
grant execute on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) to service_role;
