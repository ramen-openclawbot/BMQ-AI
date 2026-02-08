
-- PROTOTYPE MODE: remove all access restrictions (public read/write) for internal testing.
-- WARNING: This makes all data accessible to anyone with the app URL.

-- ===== Public tables =====
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
        'profiles',
        'user_roles',
        'suppliers',
        'inventory_items',
        'invoices',
        'invoice_items',
        'payment_requests',
        'payment_request_items',
        'product_skus',
        'orders',
        'order_items'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "public_full_access" ON %I.%I', t.schemaname, t.tablename);
    EXECUTE format('CREATE POLICY "public_full_access" ON %I.%I FOR ALL USING (true) WITH CHECK (true)', t.schemaname, t.tablename);
  END LOOP;
END $$;

-- ===== Storage: invoices bucket =====
-- Make bucket public so images load without signed URLs.
UPDATE storage.buckets
SET public = true
WHERE id = 'invoices';

-- Allow anyone full access to objects in invoices bucket.
DROP POLICY IF EXISTS "public_invoices_bucket_access" ON storage.objects;
CREATE POLICY "public_invoices_bucket_access"
ON storage.objects
FOR ALL
USING (bucket_id = 'invoices')
WITH CHECK (bucket_id = 'invoices');
