-- Dealer portal landing banner assets for dathang.banhmique.vn

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dealer-portal-assets',
  'dealer-portal-assets',
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
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Public read access to dealer portal assets') then
    create policy "Public read access to dealer portal assets"
      on storage.objects for select
      using (bucket_id = 'dealer-portal-assets');
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Owner can upload dealer portal assets') then
    create policy "Owner can upload dealer portal assets"
      on storage.objects for insert
      with check (
        bucket_id = 'dealer-portal-assets'
        and has_role(auth.uid(), 'owner'::app_role)
      );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Owner can update dealer portal assets') then
    create policy "Owner can update dealer portal assets"
      on storage.objects for update
      using (
        bucket_id = 'dealer-portal-assets'
        and has_role(auth.uid(), 'owner'::app_role)
      )
      with check (
        bucket_id = 'dealer-portal-assets'
        and has_role(auth.uid(), 'owner'::app_role)
      );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Owner can delete dealer portal assets') then
    create policy "Owner can delete dealer portal assets"
      on storage.objects for delete
      using (
        bucket_id = 'dealer-portal-assets'
        and has_role(auth.uid(), 'owner'::app_role)
      );
  end if;
end $$;
