-- ============================================================================
-- Migration: Tự quy đổi '(Bao 100 Cái)' ra cái khi ghi sổ kho
--
-- 2026-11-01. A receipt line can be written in "bao" while the kitchen item is
-- counted in "cái", and the pack size only lives in the invoice name:
-- "THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)" means 1 bao = 100 cái. Until now the
-- posting path only converted kg / g / l / ml by the line unit and otherwise
-- used the alias conversion_factor, so a "bao" line of a cái item posted x1.
--
-- public.stock_unit_pack_factor(p_name, p_line_unit, p_stock_unit) reads the
-- last parenthesised group that closes the name and returns the pack count only
-- when its pack word matches the line unit and its count word matches the stock
-- unit. It mirrors src/lib/pack-count-factor.ts.
--
-- public.post_stock_goods_receipt_item is redefined from its latest body
-- (20261029150000_effective_received_quantity.sql) with one change: the factor
-- gains a stock_unit_pack_factor fallback between stock_unit_line_factor and the
-- alias conversion_factor. Signature, security definer, search_path, ledger
-- logic, idempotency keys, comments and grants are byte-for-byte identical.
--
-- This file only creates / replaces functions. It never inserts, updates or
-- deletes a goods_receipt_items / goods_receipts / ledger row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Pack count from the trailing bracket of an invoice name.
-- ---------------------------------------------------------------------------

create or replace function public.stock_unit_pack_factor(
  p_name text,
  p_line_unit text,
  p_stock_unit text
)
returns numeric
language plpgsql
stable
set search_path = public, pg_temp
as $function$
declare
  v_name text;
  v_match text[];
  v_pack text;
  v_count numeric;
  v_unit text;
  v_line_norm text;
  v_pack_norm text;
  v_unit_norm text;
  v_stock_norm text;
  v_pack_fold text;
  v_line_fold text;
  v_unit_fold text;
  v_stock_fold text;
  -- lowercase + uppercase Vietnamese vowels -> their base ASCII letter, đ -> d.
  v_from constant text := 'ĐÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴđàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ';
  v_to constant text := 'DAAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYdaaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy';
begin
  if p_name is null or p_line_unit is null or p_stock_unit is null then
    return null;
  end if;

  v_name := rtrim(p_name);
  v_match := regexp_match(
    v_name,
    '\(\s*([^()0-9]+?)\s+([0-9]+(?:[.,][0-9]+)?)\s+([^()0-9]+?)\s*\)$'
  );
  if v_match is null then
    return null;
  end if;

  v_pack := btrim(v_match[1]);
  v_unit := btrim(v_match[3]);
  begin
    v_count := replace(v_match[2], ',', '.')::numeric;
  exception when others then
    return null;
  end;
  if v_count is null or v_count <= 0 then
    return null;
  end if;

  v_line_norm := public.normalize_stock_unit(p_line_unit);
  v_pack_norm := public.normalize_stock_unit(v_pack);
  v_unit_norm := public.normalize_stock_unit(v_unit);
  v_stock_norm := public.normalize_stock_unit(p_stock_unit);

  -- Count packs only. normalize_stock_unit folds kg -> g and l -> ml, so a
  -- "(BAO 10 KG)" bracket on a g item would read as 10 g; weights and volumes
  -- stay with stock_unit_line_factor / the alias factor.
  if exists (
    select 1 from public.stock_units u
    where u.code in (v_unit_norm, public.stock_unit_code(v_unit))
      and u.kind in ('weight', 'volume')
  ) then
    return null;
  end if;

  v_pack_fold := lower(translate(btrim(v_pack), v_from, v_to));
  v_line_fold := lower(translate(btrim(p_line_unit), v_from, v_to));
  v_unit_fold := lower(translate(btrim(v_unit), v_from, v_to));
  v_stock_fold := lower(translate(btrim(p_stock_unit), v_from, v_to));

  if not (
    case
      when v_line_norm is not null and v_pack_norm is not null then v_line_norm = v_pack_norm
      else v_line_fold = v_pack_fold
    end
    and
    case
      when v_stock_norm is not null and v_unit_norm is not null then v_stock_norm = v_unit_norm
      else v_stock_fold = v_unit_fold
    end
  ) then
    return null;
  end if;

  return v_count;
end;
$function$;

revoke all on function public.stock_unit_pack_factor(text, text, text) from public, anon;
grant execute on function public.stock_unit_pack_factor(text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Goods receipt item -> stock ledger (Tân Tạo + automatic Q7 transfer).
--    Signature, transfer logic, tan_tao cutover check and idempotency keys are
--    unchanged from 20261029150000_effective_received_quantity.sql; only the
--    factor gains the trailing-bracket count fallback.
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
        case when p_alias.kitchen_inventory_item_id is not null then
          public.stock_unit_pack_factor(
            coalesce(v_item.raw_product_name, v_item.product_name),
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
-- 3. Grants (identical to the definitions replaced above).
-- ---------------------------------------------------------------------------

revoke all on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) from public, anon, authenticated;
grant execute on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Self-check the pack count before the migration is accepted.
-- ---------------------------------------------------------------------------

do $assert$
begin
  if public.stock_unit_pack_factor(
       'THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)', 'bao', 'cái'
     ) is distinct from 100 then
    raise exception 'stock_unit_pack_factor: (Bao 100 Cái) with bao -> cái must be 100, got %',
      public.stock_unit_pack_factor('THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)', 'bao', 'cái');
  end if;

  if public.stock_unit_pack_factor(
       'BAO TAY Y TẾ ĐEN SIZE L (HỘP 100 CÁI)', 'hộp', 'hộp'
     ) is not null then
    raise exception 'stock_unit_pack_factor: (HỘP 100 CÁI) with stock hộp must be null';
  end if;

  if public.stock_unit_pack_factor(
       'BAO PE 13X23 (BAO 10 KG)', 'bao', 'cái'
     ) is not null then
    raise exception 'stock_unit_pack_factor: (BAO 10 KG) with stock cái must be null';
  end if;

  if public.stock_unit_pack_factor(
       'BAO PE 13X23 (BAO 10 KG)', 'bao', 'g'
     ) is not null then
    raise exception 'stock_unit_pack_factor: a weight bracket must never give a count factor';
  end if;

  if public.stock_unit_pack_factor(
       'Bột mì 888 Cam', 'bao', 'cái'
     ) is not null then
    raise exception 'stock_unit_pack_factor: a name without a bracket must be null';
  end if;
end;
$assert$;
