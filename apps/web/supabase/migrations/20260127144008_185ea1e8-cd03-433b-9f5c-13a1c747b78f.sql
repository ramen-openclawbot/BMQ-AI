-- Add purchase_order_id column to drive_import_logs
ALTER TABLE public.drive_import_logs 
ADD COLUMN purchase_order_id UUID REFERENCES public.purchase_orders(id) ON DELETE CASCADE;

-- Create index for faster lookups
CREATE INDEX idx_drive_import_logs_po_id ON public.drive_import_logs(purchase_order_id);