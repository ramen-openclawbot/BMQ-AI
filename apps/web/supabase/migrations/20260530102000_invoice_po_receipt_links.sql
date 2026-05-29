-- Add lightweight accounting trace links from supplier invoices back to the PO / receipt context.
-- This keeps invoices as the tax/accounting document while preserving the existing
-- small-company flow: PO -> goods receipt -> payable/payment request -> invoice.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS goods_receipt_id uuid REFERENCES public.goods_receipts(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_purchase_order_id_fkey'
      AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_purchase_order_id_fkey
      FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_goods_receipt_id_fkey'
      AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_goods_receipt_id_fkey
      FOREIGN KEY (goods_receipt_id) REFERENCES public.goods_receipts(id) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE public.invoices AS inv
SET purchase_order_id = COALESCE(inv.purchase_order_id, pr.purchase_order_id),
    goods_receipt_id = COALESCE(inv.goods_receipt_id, pr.goods_receipt_id)
FROM public.payment_requests AS pr
WHERE inv.payment_request_id = pr.id
  AND (inv.purchase_order_id IS NULL OR inv.goods_receipt_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_invoices_purchase_order_id
  ON public.invoices(purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_goods_receipt_id
  ON public.invoices(goods_receipt_id)
  WHERE goods_receipt_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_supplier_invoice_number
  ON public.invoices(supplier_id, lower(invoice_number))
  WHERE supplier_id IS NOT NULL AND invoice_number IS NOT NULL;
