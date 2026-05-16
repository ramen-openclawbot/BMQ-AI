-- SKU product images for Giá Vốn overview

alter table public.product_skus
  add column if not exists image_url text,
  add column if not exists image_path text,
  add column if not exists image_updated_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sku-images',
  'sku-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Public read access to SKU images') then
    create policy "Public read access to SKU images"
      on storage.objects for select
      using (bucket_id = 'sku-images');
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Staff and owners can upload SKU images') then
    create policy "Staff and owners can upload SKU images"
      on storage.objects for insert
      with check (
        bucket_id = 'sku-images'
        and (
          has_role(auth.uid(), 'owner'::app_role)
          or has_role(auth.uid(), 'staff'::app_role)
          or has_role(auth.uid(), 'warehouse'::app_role)
        )
      );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Staff and owners can update SKU images') then
    create policy "Staff and owners can update SKU images"
      on storage.objects for update
      using (
        bucket_id = 'sku-images'
        and (
          has_role(auth.uid(), 'owner'::app_role)
          or has_role(auth.uid(), 'staff'::app_role)
          or has_role(auth.uid(), 'warehouse'::app_role)
        )
      )
      with check (
        bucket_id = 'sku-images'
        and (
          has_role(auth.uid(), 'owner'::app_role)
          or has_role(auth.uid(), 'staff'::app_role)
          or has_role(auth.uid(), 'warehouse'::app_role)
        )
      );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Owners can delete SKU images') then
    create policy "Owners can delete SKU images"
      on storage.objects for delete
      using (
        bucket_id = 'sku-images'
        and has_role(auth.uid(), 'owner'::app_role)
      );
  end if;
end $$;

create index if not exists idx_product_skus_image_updated_at
  on public.product_skus (image_updated_at desc)
  where image_path is not null;
