-- Compatibility patch for environments where inventory_batches already exists
ALTER TABLE public.inventory_batches
  ADD COLUMN IF NOT EXISTS goods_receipt_item_id UUID REFERENCES public.goods_receipt_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expiry_edit_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expiry_last_edited_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS expiry_last_edited_by UUID NULL;

-- ensure helper indexes
CREATE INDEX IF NOT EXISTS idx_inventory_batches_goods_receipt_item_id ON public.inventory_batches(goods_receipt_item_id);

-- one-time-only expiry edit guard
CREATE OR REPLACE FUNCTION public.guard_inventory_batch_expiry_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.expiry_date IS DISTINCT FROM OLD.expiry_date THEN
    IF COALESCE(OLD.expiry_edit_count, 0) >= 1 THEN
      RAISE EXCEPTION 'Expiry date can only be edited once for this batch';
    END IF;

    NEW.expiry_edit_count := COALESCE(OLD.expiry_edit_count, 0) + 1;
    NEW.expiry_last_edited_at := now();
    NEW.expiry_last_edited_by := auth.uid();
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_inventory_batch_expiry_once ON public.inventory_batches;
CREATE TRIGGER trg_guard_inventory_batch_expiry_once
BEFORE UPDATE ON public.inventory_batches
FOR EACH ROW
EXECUTE FUNCTION public.guard_inventory_batch_expiry_once();

CREATE OR REPLACE FUNCTION public.update_batch_expiry_once(p_batch_id UUID, p_expiry_date DATE)
RETURNS public.inventory_batches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch public.inventory_batches;
BEGIN
  UPDATE public.inventory_batches
  SET expiry_date = p_expiry_date
  WHERE id = p_batch_id
  RETURNING * INTO v_batch;

  IF v_batch.id IS NULL THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;

  RETURN v_batch;
END;
$$;

grant execute on function public.update_batch_expiry_once(UUID, DATE) to authenticated;
