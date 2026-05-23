-- Production planning SKU visibility per workshop/location

create table if not exists public.production_location_sku_settings (
  id uuid primary key default gen_random_uuid(),
  location_code text not null,
  sku_id uuid not null references public.product_skus(id) on delete cascade,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint production_location_sku_settings_location_sku_key unique (location_code, sku_id),
  constraint production_location_sku_settings_location_code_check check (location_code ~ '^[a-z0-9_-]+$')
);

create index if not exists idx_production_location_sku_settings_location
  on public.production_location_sku_settings (location_code, is_enabled);

alter table public.production_location_sku_settings enable row level security;

create or replace function public.set_production_location_sku_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists production_location_sku_settings_set_updated_at on public.production_location_sku_settings;
create trigger production_location_sku_settings_set_updated_at
before update on public.production_location_sku_settings
for each row execute function public.set_production_location_sku_settings_updated_at();

create or replace function public.can_edit_production_q7()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role = 'owner'
  )
  or exists (
    select 1
    from public.user_module_permissions ump
    where ump.user_id = auth.uid()
      and ump.module_key = 'production_q7'
      and ump.can_edit = true
  );
$$;

drop policy if exists "production_location_sku_settings_select" on public.production_location_sku_settings;
create policy "production_location_sku_settings_select"
  on public.production_location_sku_settings
  for select
  to authenticated
  using (true);

drop policy if exists "production_location_sku_settings_insert" on public.production_location_sku_settings;
create policy "production_location_sku_settings_insert"
  on public.production_location_sku_settings
  for insert
  to authenticated
  with check (public.can_edit_production_q7());

drop policy if exists "production_location_sku_settings_update" on public.production_location_sku_settings;
create policy "production_location_sku_settings_update"
  on public.production_location_sku_settings
  for update
  to authenticated
  using (public.can_edit_production_q7())
  with check (public.can_edit_production_q7());

drop policy if exists "production_location_sku_settings_delete" on public.production_location_sku_settings;
create policy "production_location_sku_settings_delete"
  on public.production_location_sku_settings
  for delete
  to authenticated
  using (public.can_edit_production_q7());
