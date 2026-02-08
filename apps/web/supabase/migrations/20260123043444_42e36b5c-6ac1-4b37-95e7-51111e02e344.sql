-- Add image_url column to purchase_orders table
ALTER TABLE purchase_orders 
ADD COLUMN image_url TEXT;

COMMENT ON COLUMN purchase_orders.image_url IS 'URL ảnh đơn đặt hàng gốc từ NCC';

-- Create storage bucket for purchase order images
INSERT INTO storage.buckets (id, name, public)
VALUES ('purchase-orders', 'purchase-orders', true)
ON CONFLICT (id) DO NOTHING;

-- RLS policy for authenticated users to upload
CREATE POLICY "Auth users can upload PO images"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'purchase-orders' AND auth.uid() IS NOT NULL);

-- Public can view PO images
CREATE POLICY "Public can view PO images"
ON storage.objects FOR SELECT
USING (bucket_id = 'purchase-orders');

-- Update VAT for PO-000001 to fix the total calculation
UPDATE purchase_orders 
SET vat_amount = 180720 
WHERE po_number = 'PO-000001';