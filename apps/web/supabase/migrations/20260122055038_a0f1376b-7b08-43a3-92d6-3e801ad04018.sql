
-- Fix storage policies for invoices bucket - allow all authenticated users
DROP POLICY IF EXISTS "Staff and owners can upload invoices" ON storage.objects;
DROP POLICY IF EXISTS "Staff and owners can view invoices" ON storage.objects;
DROP POLICY IF EXISTS "Staff and owners can update invoices" ON storage.objects;
DROP POLICY IF EXISTS "Owners can delete invoice images" ON storage.objects;

-- Create simple authenticated-user policies for storage
CREATE POLICY "Authenticated users can upload to invoices"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'invoices' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can view invoices storage"
ON storage.objects FOR SELECT
USING (bucket_id = 'invoices' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update invoices storage"
ON storage.objects FOR UPDATE
USING (bucket_id = 'invoices' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete invoices storage"
ON storage.objects FOR DELETE
USING (bucket_id = 'invoices' AND auth.uid() IS NOT NULL);
