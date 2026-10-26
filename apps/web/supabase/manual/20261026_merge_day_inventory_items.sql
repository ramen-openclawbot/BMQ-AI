-- ===========================================================================
-- MANUAL, ONE-TIME DATA REPAIR -- NOT A MIGRATION
-- ===========================================================================
-- Merge day-suffixed legacy inventory_items rows (for example "Tỏi ngày 9")
-- into the single item named after the canonical material ("Tỏi").
--
-- This file intentionally lives under supabase/manual/ and must NOT be moved
-- into supabase/migrations/.  The Maestro reviews the dry run first and only
-- then runs it for real.
--
-- DRY RUN IS THE DEFAULT: `v_dry_run boolean := true` performs every merge and
-- every integrity check, then raises 'DRY_RUN ok: ...' which rolls the whole DO
-- block back.  To apply for real, change that literal to `false`, review the
-- diff/notice output, and run it once in a reviewed transaction.
--
-- Safety guards: total inventory_items.quantity must be unchanged, the row
-- counts of inventory_movements / inventory_batches /
-- goods_receipt_auto_issue_items must be unchanged, and no row may still point
-- at a deleted inventory_items id.
-- ===========================================================================

DO $$
DECLARE
  v_dry_run boolean := true;
  v_r public.inventory_items%ROWTYPE;
  v_target_id uuid;
  v_target_name text;
  v_candidate record;
  v_merged integer := 0;
  v_created integer := 0;
  v_skipped_ids uuid[];
  v_deleted_ids uuid[] := ARRAY[]::uuid[];
  v_items_before bigint;
  v_items_after bigint;
  v_quantity_before numeric;
  v_quantity_after numeric;
  v_movements_before bigint;
  v_movements_after bigint;
  v_batches_before bigint;
  v_batches_after bigint;
  v_auto_issue_items_before bigint;
  v_auto_issue_items_after bigint;
  v_dangling bigint;
  v_table text;
BEGIN
  -- ---------------------------------------------------------------- baseline
  SELECT count(*), COALESCE(sum(quantity), 0)
  INTO v_items_before, v_quantity_before
  FROM public.inventory_items;

  SELECT count(*) INTO v_movements_before FROM public.inventory_movements;
  SELECT count(*) INTO v_batches_before FROM public.inventory_batches;
  SELECT count(*) INTO v_auto_issue_items_before FROM public.goods_receipt_auto_issue_items;

  -- Rows whose receipt lines resolve to more than one canonical material are
  -- ambiguous: leave them alone and announce them.
  SELECT COALESCE(array_agg(x.item_id ORDER BY x.item_id), ARRAY[]::uuid[])
  INTO v_skipped_ids
  FROM (
    SELECT i.id AS item_id
    FROM public.inventory_items i
    JOIN public.goods_receipt_items gri ON gri.inventory_item_id = i.id
    WHERE gri.canonical_material_id IS NOT NULL
    GROUP BY i.id
    HAVING count(DISTINCT gri.canonical_material_id) > 1
  ) x;

  IF cardinality(v_skipped_ids) > 0 THEN
    RAISE NOTICE 'SKIPPED inventory_items with multiple canonical materials: %', v_skipped_ids;
  END IF;

  -- ------------------------------------------------------- merge each legacy row
  FOR v_candidate IN
    SELECT i.id AS item_id, min(m.canonical_name) AS canonical_name
    FROM public.inventory_items i
    JOIN public.goods_receipt_items gri ON gri.inventory_item_id = i.id
    JOIN public.sku_cogs_materials m ON m.id = gri.canonical_material_id
    WHERE gri.canonical_material_id IS NOT NULL
      -- Only day-suffixed names ("tỏi ngày 9", "dưa leo 13", "hành lá13");
      -- branded or sized items keep their own row.
      AND i.name ~* '(ng[aà]y\s*[0-9]{1,2}|[^0-9][0-9]{1,2})\s*$'
    GROUP BY i.id
    HAVING count(DISTINCT gri.canonical_material_id) = 1
       AND lower(btrim(i.name)) <> lower(btrim(min(m.canonical_name)))
       -- The name minus its day number must be the material name or its leading
       -- words ("ớt sừng 12" -> "Ớt sừng đỏ").  Packaging sizes such as
       -- "BAO XỐP ZIN TRẮNG 35" or "BAO PE 13X23" never qualify.
       AND min(m.canonical_name) !~ '[0-9]'
       AND (
         lower(btrim(min(m.canonical_name)))
           = regexp_replace(lower(btrim(i.name)), '\s*(ng[aà]y)?\s*[0-9]{1,2}\s*$', '')
         OR lower(btrim(min(m.canonical_name)))
           LIKE regexp_replace(lower(btrim(i.name)), '\s*(ng[aà]y)?\s*[0-9]{1,2}\s*$', '') || ' %'
       )
    ORDER BY min(i.created_at) ASC, i.id ASC
  LOOP
    SELECT * INTO v_r
    FROM public.inventory_items
    WHERE id = v_candidate.item_id
    FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    v_target_name := v_candidate.canonical_name;

    SELECT id
    INTO v_target_id
    FROM public.inventory_items
    WHERE id <> v_r.id
      AND lower(btrim(name)) = lower(btrim(v_target_name))
    ORDER BY created_at ASC, id ASC
    LIMIT 1
    FOR UPDATE;

    IF v_target_id IS NULL THEN
      INSERT INTO public.inventory_items (
        name,
        quantity,
        unit,
        category,
        supplier_id
      ) VALUES (
        v_target_name,
        0,
        v_r.unit,
        'Từ phiếu nhập',
        v_r.supplier_id
      )
      RETURNING id INTO v_target_id;
      v_created := v_created + 1;
    END IF;

    -- Repoint every known reference before deleting the legacy row.
    UPDATE public.goods_receipt_items
    SET inventory_item_id = v_target_id
    WHERE inventory_item_id = v_r.id;

    UPDATE public.inventory_movements
    SET inventory_item_id = v_target_id
    WHERE inventory_item_id = v_r.id;

    UPDATE public.inventory_batches
    SET inventory_item_id = v_target_id
    WHERE inventory_item_id = v_r.id;

    UPDATE public.goods_receipt_auto_issue_items
    SET inventory_item_id = v_target_id
    WHERE inventory_item_id = v_r.id;

    UPDATE public.payment_request_items
    SET inventory_item_id = v_target_id
    WHERE inventory_item_id = v_r.id;

    UPDATE public.invoice_items
    SET inventory_item_id = v_target_id
    WHERE inventory_item_id = v_r.id;

    UPDATE public.order_items
    SET inventory_item_id = v_target_id
    WHERE inventory_item_id = v_r.id;

    UPDATE public.cost_classification_rules
    SET inventory_item_id = v_target_id
    WHERE inventory_item_id = v_r.id;

    UPDATE public.inventory_items
    SET quantity = quantity + COALESCE(v_r.quantity, 0),
        updated_at = now()
    WHERE id = v_target_id;

    DELETE FROM public.inventory_items WHERE id = v_r.id;

    v_deleted_ids := array_append(v_deleted_ids, v_r.id);
    v_merged := v_merged + 1;
  END LOOP;

  -- ------------------------------------------------------------- verify totals
  SELECT count(*), COALESCE(sum(quantity), 0)
  INTO v_items_after, v_quantity_after
  FROM public.inventory_items;

  SELECT count(*) INTO v_movements_after FROM public.inventory_movements;
  SELECT count(*) INTO v_batches_after FROM public.inventory_batches;
  SELECT count(*) INTO v_auto_issue_items_after FROM public.goods_receipt_auto_issue_items;

  IF v_quantity_after <> v_quantity_before THEN
    RAISE EXCEPTION 'ABORT total inventory quantity changed: before=%, after=%',
      v_quantity_before, v_quantity_after;
  END IF;

  IF v_items_after <> v_items_before - v_merged + v_created THEN
    RAISE EXCEPTION 'ABORT inventory_items count mismatch: before=%, after=%, merged=%, created=%',
      v_items_before, v_items_after, v_merged, v_created;
  END IF;

  IF v_movements_after <> v_movements_before THEN
    RAISE EXCEPTION 'ABORT inventory_movements row count changed: before=%, after=%',
      v_movements_before, v_movements_after;
  END IF;

  IF v_batches_after <> v_batches_before THEN
    RAISE EXCEPTION 'ABORT inventory_batches row count changed: before=%, after=%',
      v_batches_before, v_batches_after;
  END IF;

  IF v_auto_issue_items_after <> v_auto_issue_items_before THEN
    RAISE EXCEPTION 'ABORT goods_receipt_auto_issue_items row count changed: before=%, after=%',
      v_auto_issue_items_before, v_auto_issue_items_after;
  END IF;

  -- ------------------------------------------------- no dangling references
  IF cardinality(v_deleted_ids) > 0 THEN
    FOREACH v_table IN ARRAY ARRAY[
      'goods_receipt_items',
      'inventory_movements',
      'inventory_batches',
      'goods_receipt_auto_issue_items',
      'payment_request_items',
      'invoice_items',
      'order_items',
      'cost_classification_rules'
    ] LOOP
      EXECUTE format(
        'SELECT count(*) FROM public.%I WHERE inventory_item_id = ANY($1)',
        v_table
      ) INTO v_dangling USING v_deleted_ids;

      IF v_dangling > 0 THEN
        RAISE EXCEPTION 'ABORT % row(s) still reference deleted inventory_items in %',
          v_dangling, v_table;
      END IF;
    END LOOP;
  END IF;

  IF v_dry_run THEN
    RAISE EXCEPTION 'DRY_RUN ok: merged=%, skipped=%', v_merged, cardinality(v_skipped_ids);
  END IF;

  RAISE NOTICE 'MERGE applied: merged=%, created=%, skipped=%',
    v_merged, v_created, cardinality(v_skipped_ids);
END;
$$;
