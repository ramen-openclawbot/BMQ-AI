-- Add product_photos column to goods_receipts for storing multiple product images
ALTER TABLE public.goods_receipts 
ADD COLUMN IF NOT EXISTS product_photos text[];

-- Add payment_request_id column if not exists (for linking goods receipt to payment request)
ALTER TABLE public.goods_receipts 
ADD COLUMN IF NOT EXISTS payment_request_id uuid REFERENCES public.payment_requests(id) ON DELETE SET NULL;

-- Create index for faster queries on payment_request_id
CREATE INDEX IF NOT EXISTS idx_goods_receipts_payment_request_id 
ON public.goods_receipts(payment_request_id);

-- Create storage bucket for warehouse product photos
INSERT INTO storage.buckets (id, name, public) 
VALUES ('warehouse-photos', 'warehouse-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Create storage policy for authenticated users to upload warehouse photos
CREATE POLICY "Authenticated users can upload warehouse photos" 
ON storage.objects 
FOR INSERT 
TO authenticated
WITH CHECK (bucket_id = 'warehouse-photos');

-- Create storage policy for public read access to warehouse photos
CREATE POLICY "Public read access to warehouse photos" 
ON storage.objects 
FOR SELECT 
TO public
USING (bucket_id = 'warehouse-photos');