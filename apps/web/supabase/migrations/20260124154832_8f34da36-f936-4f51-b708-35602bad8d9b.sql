-- Create drive_import_logs table for tracking imported Google Drive files
CREATE TABLE public.drive_import_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  folder_date TEXT NOT NULL,
  import_type TEXT NOT NULL CHECK (import_type IN ('po', 'bank_slip')),
  payment_request_id UUID REFERENCES public.payment_requests(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('processed', 'failed', 'skipped')),
  error_message TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(file_id, import_type)
);

-- Enable RLS
ALTER TABLE public.drive_import_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Owner and staff can manage drive import logs
CREATE POLICY "Owners and staff can view drive_import_logs"
  ON public.drive_import_logs FOR SELECT
  USING (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role));

CREATE POLICY "Owners and staff can insert drive_import_logs"
  ON public.drive_import_logs FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role));

CREATE POLICY "Only owners can delete drive_import_logs"
  ON public.drive_import_logs FOR DELETE
  USING (has_role(auth.uid(), 'owner'::app_role));

-- Insert default app_settings for Google Drive folders if they don't exist
INSERT INTO public.app_settings (key, value)
VALUES 
  ('google_drive_po_folder', ''),
  ('google_drive_receipts_folder', '')
ON CONFLICT (key) DO NOTHING;