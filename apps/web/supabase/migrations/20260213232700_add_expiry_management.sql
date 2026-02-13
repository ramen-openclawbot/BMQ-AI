-- Add expiry_date to goods_receipt_items
ALTER TABLE public.goods_receipt_items
ADD COLUMN IF NOT EXISTS expiry_date DATE;

-- Batch-level expiry management
CREATE TABLE IF NOT EXISTS public.inventory_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_item_id UUID NOT NULL REFERENCES public.goods_receipt_items(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  sku_id UUID NULL REFERENCES public.product_skus(id) ON DELETE SET NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit TEXT NULL,
  expiry_date DATE NULL,
  expiry_edit_count INTEGER NOT NULL DEFAULT 0,
  expiry_last_edited_at TIMESTAMPTZ NULL,
  expiry_last_edited_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_inventory_item_id ON public.inventory_batches(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry_date ON public.inventory_batches(expiry_date);

ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_batches' AND policyname = 'Authenticated users can select inventory_batches'
  ) THEN
    CREATE POLICY "Authenticated users can select inventory_batches"
    ON public.inventory_batches FOR SELECT TO authenticated USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_batches' AND policyname = 'Authenticated users can insert inventory_batches'
  ) THEN
    CREATE POLICY "Authenticated users can insert inventory_batches"
    ON public.inventory_batches FOR INSERT TO authenticated WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_batches' AND policyname = 'Authenticated users can update inventory_batches'
  ) THEN
    CREATE POLICY "Authenticated users can update inventory_batches"
    ON public.inventory_batches FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_batches' AND policyname = 'Authenticated users can delete inventory_batches'
  ) THEN
    CREATE POLICY "Authenticated users can delete inventory_batches"
    ON public.inventory_batches FOR DELETE TO authenticated USING (true);
  END IF;
END $$;

-- one-time-only expiry edit guard
CREATE OR REPLACE FUNCTION public.guard_inventory_batch_expiry_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.expiry_date IS DISTINCT FROM OLD.expiry_date THEN
    IF OLD.expiry_edit_count >= 1 THEN
      RAISE EXCEPTION 'Expiry date can only be edited once for this batch';
    END IF;

    NEW.expiry_edit_count := OLD.expiry_edit_count + 1;
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
