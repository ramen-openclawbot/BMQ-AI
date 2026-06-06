-- Store sample label images and AI-detected barcode crop references for QA label validation.

ALTER TABLE public.product_label_specs
  ADD COLUMN IF NOT EXISTS label_template_image_url text,
  ADD COLUMN IF NOT EXISTS label_template_image_path text,
  ADD COLUMN IF NOT EXISTS barcode_crop_image_url text,
  ADD COLUMN IF NOT EXISTS barcode_crop_image_path text,
  ADD COLUMN IF NOT EXISTS barcode_crop_bbox jsonb,
  ADD COLUMN IF NOT EXISTS barcode_crop_confidence numeric;

ALTER TABLE public.qa_label_checks
  ADD COLUMN IF NOT EXISTS expected_barcode_crop_image_url text,
  ADD COLUMN IF NOT EXISTS extracted_barcode_crop_image_url text,
  ADD COLUMN IF NOT EXISTS extracted_barcode_bbox jsonb;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'label-template-images',
  'label-template-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Public read access to label template images') THEN
    CREATE POLICY "Public read access to label template images"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'label-template-images');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Staff and owners can upload label template images') THEN
    CREATE POLICY "Staff and owners can upload label template images"
      ON storage.objects FOR INSERT
      WITH CHECK (
        bucket_id = 'label-template-images'
        AND (
          has_role(auth.uid(), 'owner'::app_role)
          OR has_role(auth.uid(), 'staff'::app_role)
          OR has_role(auth.uid(), 'warehouse'::app_role)
        )
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Staff and owners can update label template images') THEN
    CREATE POLICY "Staff and owners can update label template images"
      ON storage.objects FOR UPDATE
      USING (
        bucket_id = 'label-template-images'
        AND (
          has_role(auth.uid(), 'owner'::app_role)
          OR has_role(auth.uid(), 'staff'::app_role)
          OR has_role(auth.uid(), 'warehouse'::app_role)
        )
      )
      WITH CHECK (
        bucket_id = 'label-template-images'
        AND (
          has_role(auth.uid(), 'owner'::app_role)
          OR has_role(auth.uid(), 'staff'::app_role)
          OR has_role(auth.uid(), 'warehouse'::app_role)
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_product_label_specs_barcode_crop
  ON public.product_label_specs USING gin (barcode_crop_bbox)
  WHERE barcode_crop_bbox IS NOT NULL;
