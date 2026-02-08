-- =============================================
-- Step 1: Create drive_file_index table
-- =============================================
CREATE TABLE public.drive_file_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  folder_date TEXT NOT NULL,
  folder_type TEXT NOT NULL CHECK (folder_type IN ('po', 'bank_slip')),
  mime_type TEXT,
  parent_folder_id TEXT,
  file_size INTEGER,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Processing status
  processed BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  purchase_order_id UUID REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  payment_request_id UUID REFERENCES public.payment_requests(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  
  created_by UUID
);

-- Create indexes for common queries
CREATE INDEX idx_drive_file_index_folder_type ON public.drive_file_index(folder_type);
CREATE INDEX idx_drive_file_index_folder_date ON public.drive_file_index(folder_date);
CREATE INDEX idx_drive_file_index_processed ON public.drive_file_index(processed);
CREATE INDEX idx_drive_file_index_last_seen ON public.drive_file_index(last_seen_at);

-- Enable RLS
ALTER TABLE public.drive_file_index ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Owners and staff can view drive_file_index"
ON public.drive_file_index FOR SELECT
USING (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role));

CREATE POLICY "Owners and staff can insert drive_file_index"
ON public.drive_file_index FOR INSERT
WITH CHECK (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role));

CREATE POLICY "Owners and staff can update drive_file_index"
ON public.drive_file_index FOR UPDATE
USING (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
WITH CHECK (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role));

CREATE POLICY "Only owners can delete drive_file_index"
ON public.drive_file_index FOR DELETE
USING (has_role(auth.uid(), 'owner'::app_role));

-- =============================================
-- Step 2: Create drive_sync_config table
-- =============================================
CREATE TABLE public.drive_sync_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_type TEXT NOT NULL UNIQUE CHECK (folder_type IN ('po', 'bank_slip')),
  sync_mode TEXT NOT NULL DEFAULT 'manual' CHECK (sync_mode IN ('auto', 'manual')),
  auto_sync_interval_minutes INTEGER DEFAULT 30,
  last_synced_at TIMESTAMPTZ,
  last_sync_status TEXT,
  last_sync_error TEXT,
  files_synced_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.drive_sync_config ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Owners and staff can view drive_sync_config"
ON public.drive_sync_config FOR SELECT
USING (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role));

CREATE POLICY "Only owners can insert drive_sync_config"
ON public.drive_sync_config FOR INSERT
WITH CHECK (has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "Only owners can update drive_sync_config"
ON public.drive_sync_config FOR UPDATE
USING (has_role(auth.uid(), 'owner'::app_role))
WITH CHECK (has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "Only owners can delete drive_sync_config"
ON public.drive_sync_config FOR DELETE
USING (has_role(auth.uid(), 'owner'::app_role));

-- Create trigger for updated_at
CREATE TRIGGER update_drive_sync_config_updated_at
BEFORE UPDATE ON public.drive_sync_config
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- Step 3: Insert default config records
-- =============================================
INSERT INTO public.drive_sync_config (folder_type, sync_mode)
VALUES 
  ('po', 'manual'),
  ('bank_slip', 'manual');

-- =============================================
-- Step 4: Migrate data from drive_import_logs
-- =============================================
INSERT INTO public.drive_file_index (
  file_id,
  file_name,
  folder_date,
  folder_type,
  processed,
  processed_at,
  purchase_order_id,
  payment_request_id,
  invoice_id,
  created_by
)
SELECT 
  file_id,
  file_name,
  folder_date,
  import_type,
  CASE WHEN status = 'processed' THEN true ELSE false END,
  CASE WHEN status = 'processed' THEN created_at ELSE NULL END,
  purchase_order_id,
  payment_request_id,
  invoice_id,
  created_by
FROM public.drive_import_logs
ON CONFLICT (file_id) DO NOTHING;

-- =============================================
-- Step 5: Create trigger to auto-reset processed when PO deleted
-- =============================================
CREATE OR REPLACE FUNCTION public.reset_drive_file_index_processed()
RETURNS TRIGGER AS $$
BEGIN
  -- When purchase_order_id becomes NULL (due to ON DELETE SET NULL),
  -- reset processed to false so the file can be re-imported
  IF NEW.purchase_order_id IS NULL AND OLD.purchase_order_id IS NOT NULL THEN
    NEW.processed := false;
    NEW.processed_at := NULL;
  END IF;
  
  -- Same for payment_request_id
  IF NEW.payment_request_id IS NULL AND OLD.payment_request_id IS NOT NULL AND NEW.purchase_order_id IS NULL THEN
    NEW.processed := false;
    NEW.processed_at := NULL;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trigger_reset_drive_file_index_processed
BEFORE UPDATE ON public.drive_file_index
FOR EACH ROW
EXECUTE FUNCTION public.reset_drive_file_index_processed();