-- Add new columns to suppliers table
ALTER TABLE public.suppliers 
ADD COLUMN IF NOT EXISTS default_payment_method payment_method_type DEFAULT 'bank_transfer',
ADD COLUMN IF NOT EXISTS contract_url text,
ADD COLUMN IF NOT EXISTS payment_terms_days integer DEFAULT 0;

COMMENT ON COLUMN public.suppliers.default_payment_method IS 'Phương thức thanh toán mặc định (UNC hoặc tiền mặt)';
COMMENT ON COLUMN public.suppliers.contract_url IS 'URL file hợp đồng PDF';
COMMENT ON COLUMN public.suppliers.payment_terms_days IS 'Số ngày công nợ';

-- Create storage bucket for contracts
INSERT INTO storage.buckets (id, name, public)
VALUES ('contracts', 'contracts', true)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for contracts bucket
CREATE POLICY "Anyone can upload contracts"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'contracts');

CREATE POLICY "Anyone can read contracts"  
ON storage.objects FOR SELECT
USING (bucket_id = 'contracts');

CREATE POLICY "Anyone can update contracts"
ON storage.objects FOR UPDATE
USING (bucket_id = 'contracts');

CREATE POLICY "Anyone can delete contracts"
ON storage.objects FOR DELETE
USING (bucket_id = 'contracts');