-- Task9 linked rollback-only smoke: shadow rollout dashboard/config only.
-- Applies missing current controller foundation plus Task9 inside one transaction,
-- creates synthetic pending queue rows, exercises config rollback, asserts Task9
-- protected counts unchanged after synthetic cleanup, then ROLLBACKs and returns
-- zero-residue evidence.

begin;

-- Bootstrap current controller tables inside rollback only when linked/local DB has
-- not applied prior canonical material controller migrations yet.
-- Task 2 Canonical NVL Master Controller foundation.
-- Canonical root: public.sku_cogs_materials remains the only material identity root.
-- No historical canonical, kitchen, SKU, COGS, Q7, PO/GRN/PR/invoice data is inserted, updated,
-- deleted, merged, or backfilled by this migration; only additive schema/ACL/RPC foundation is added.
-- Exact RPC signature markers for static contracts:
-- public.request_material_resolution(text,text,uuid,uuid,text,text,text,uuid,jsonb)
-- public.create_canonical_material(text,text,text,text,text,text,text,uuid)
-- public.update_canonical_material(uuid,int,jsonb,text,uuid)
-- public.confirm_material_resolution(uuid,text,uuid,jsonb,jsonb,jsonb,text)
-- public.assert_material_ready(uuid,text[],uuid,text,date)

create extension if not exists pgcrypto with schema extensions;

alter table public.sku_cogs_materials
  add column if not exists category text,
  add column if not exists brand text,
  add column if not exists specification text,
  add column if not exists updated_by uuid references auth.users(id) on delete set null,
  add column if not exists version integer;

alter table public.sku_cogs_materials
  drop constraint if exists sku_cogs_materials_version_positive,
  add constraint sku_cogs_materials_version_positive check (version is null or version > 0);

create or replace function public.material_master_normalize(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select public.normalize_ocr_cost_key(p_value);
$$;

create or replace function public.material_master_jwt_role()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif((current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '')
  );
$$;

create or replace function public.can_view_material_master()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'material_master', 'view')
    or public.has_module_permission((select auth.uid()), 'material_master', 'edit');
$$;

create or replace function public.can_edit_material_master()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'material_master', 'edit');
$$;

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
select ur.user_id, 'material_master', true, true
from public.user_roles ur
where ur.role = 'owner'
  and exists (select 1 from auth.users au where au.id = ur.user_id)
on conflict (user_id, module_key) do nothing;

create table if not exists public.material_master_audit_logs (
  id uuid primary key default gen_random_uuid(),
  material_id uuid references public.sku_cogs_materials(id) on delete set null,
  request_id uuid,
  action text not null,
  reason text not null,
  actor_id uuid references auth.users(id) on delete set null,
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  safe_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint material_master_audit_logs_reason_nonempty check (nullif(btrim(reason), '') is not null)
);

create or replace function public.material_master_safe_payload(p_payload jsonb, p_allowed text[])
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then '{}'::jsonb
    else coalesce((select jsonb_object_agg(key, value) from jsonb_each(coalesce(p_payload, '{}'::jsonb)) where key = any(p_allowed)), '{}'::jsonb)
  end;
$$;

create or replace function public.material_master_row_json(p_row public.sku_cogs_materials)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'material_code', p_row.material_code,
    'canonical_name', p_row.canonical_name,
    'normalized_name', p_row.normalized_name,
    'default_unit', p_row.default_unit,
    'active', p_row.active,
    'category', p_row.category,
    'brand', p_row.brand,
    'specification', p_row.specification,
    'version', p_row.version
  );
$$;

create table if not exists public.material_unit_conversions (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.sku_cogs_materials(id) on delete restrict,
  from_unit text not null,
  to_unit text not null,
  factor numeric not null,
  effective_from date not null default current_date,
  effective_to date,
  source_type text,
  source_id uuid,
  approved boolean not null default false,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint material_unit_conversions_units_nonempty check (nullif(btrim(from_unit), '') is not null and nullif(btrim(to_unit), '') is not null),
  constraint material_unit_conversions_factor_finite_positive check (factor > 0 and factor::text not in ('NaN','Infinity','-Infinity')),
  constraint material_unit_conversions_interval_valid check (effective_to is null or effective_to >= effective_from),
  constraint material_unit_conversions_approval_consistent check ((approved = false) or (approved_by is not null and approved_at is not null))
);

create unique index if not exists uq_material_unit_conversions_current
  on public.material_unit_conversions (material_id, lower(btrim(from_unit)), lower(btrim(to_unit)))
  where active = true and approved = true and effective_to is null;
create index if not exists idx_material_unit_conversions_lookup
  on public.material_unit_conversions (material_id, lower(btrim(from_unit)), lower(btrim(to_unit)), effective_from, effective_to)
  where active = true and approved = true;

create or replace function public.trg_material_unit_conversions_reject_approved_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'material_unit_conversions_overlap:'
      || coalesce(new.material_id::text, '') || ':'
      || lower(btrim(coalesce(new.from_unit, ''))) || ':'
      || lower(btrim(coalesce(new.to_unit, ''))),
    0
  ));

  if new.active = true and new.approved = true and exists (
    select 1
    from public.material_unit_conversions c
    where c.id <> new.id
      and c.material_id = new.material_id
      and lower(btrim(c.from_unit)) = lower(btrim(new.from_unit))
      and lower(btrim(c.to_unit)) = lower(btrim(new.to_unit))
      and c.active = true
      and c.approved = true
      and daterange(c.effective_from, coalesce(c.effective_to, 'infinity'::date), '[]') && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
  ) then
    raise exception 'overlapping approved conversion period' using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_material_unit_conversions_reject_approved_overlap on public.material_unit_conversions;
create trigger trg_material_unit_conversions_reject_approved_overlap
before insert or update on public.material_unit_conversions
for each row execute function public.trg_material_unit_conversions_reject_approved_overlap();

create table if not exists public.material_supplier_products (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.sku_cogs_materials(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  product_sku_id uuid references public.product_skus(id) on delete set null,
  supplier_product_code text,
  supplier_product_name text not null,
  normalized_supplier_product_name text not null,
  purchase_unit text not null,
  package_quantity numeric,
  package_unit text,
  base_quantity numeric not null,
  base_unit text not null,
  approved boolean not null default false,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint material_supplier_products_name_nonempty check (nullif(btrim(supplier_product_name), '') is not null and nullif(btrim(normalized_supplier_product_name), '') is not null),
  constraint material_supplier_products_name_normalized check (normalized_supplier_product_name = public.material_master_normalize(supplier_product_name)),
  constraint material_supplier_products_units_nonempty check (nullif(btrim(purchase_unit), '') is not null and nullif(btrim(base_unit), '') is not null),
  constraint material_supplier_products_qty_finite_positive check (base_quantity > 0 and base_quantity::text not in ('NaN','Infinity','-Infinity') and (package_quantity is null or (package_quantity > 0 and package_quantity::text not in ('NaN','Infinity','-Infinity')))),
  constraint material_supplier_products_approval_consistent check ((approved = false) or (approved_by is not null and approved_at is not null))
);
create unique index if not exists uq_material_supplier_products_active_code
  on public.material_supplier_products (supplier_id, lower(btrim(supplier_product_code)))
  where active = true and supplier_id is not null and nullif(btrim(supplier_product_code), '') is not null;
create unique index if not exists uq_material_supplier_products_active_name_unit
  on public.material_supplier_products (supplier_id, normalized_supplier_product_name, lower(btrim(purchase_unit)))
  where active = true;
create index if not exists idx_material_supplier_products_ready
  on public.material_supplier_products (material_id, supplier_id)
  where active = true and approved = true;

create table if not exists public.material_price_history (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.sku_cogs_materials(id) on delete restrict,
  supplier_product_id uuid references public.material_supplier_products(id) on delete set null,
  price_type text not null check (price_type in ('standard_cost','purchase_price')),
  price numeric not null,
  price_unit text not null,
  normalized_base_unit_price numeric,
  effective_from date not null,
  effective_to date,
  source_type text,
  source_id uuid,
  approved boolean not null default false,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint material_price_history_interval_valid check (effective_to is null or effective_to >= effective_from),
  constraint material_price_history_nonnegative_finite check (price >= 0 and price::text not in ('NaN','Infinity','-Infinity') and (normalized_base_unit_price is null or (normalized_base_unit_price >= 0 and normalized_base_unit_price::text not in ('NaN','Infinity','-Infinity')))),
  constraint material_price_history_units_nonempty check (nullif(btrim(price_unit), '') is not null),
  constraint material_price_history_approval_consistent check ((approved = false) or (approved_by is not null and approved_at is not null))
);

drop index if exists public.uq_material_price_history_current_standard;
create unique index if not exists uq_material_price_history_current
  on public.material_price_history (material_id, coalesce(supplier_product_id, '00000000-0000-0000-0000-000000000000'::uuid), price_type, lower(btrim(price_unit)))
  where approved = true and effective_to is null;
create index if not exists idx_material_price_history_lookup
  on public.material_price_history (material_id, coalesce(supplier_product_id, '00000000-0000-0000-0000-000000000000'::uuid), price_type, lower(btrim(price_unit)), effective_from, effective_to)
  where approved = true;

create or replace function public.trg_material_price_history_reject_approved_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'material_price_history_overlap:'
      || coalesce(new.material_id::text, '') || ':'
      || coalesce(new.supplier_product_id, '00000000-0000-0000-0000-000000000000'::uuid)::text || ':'
      || coalesce(new.price_type, '') || ':'
      || lower(btrim(coalesce(new.price_unit, ''))),
    0
  ));

  if new.approved = true and exists (
    select 1
    from public.material_price_history p
    where p.id <> new.id
      and p.material_id = new.material_id
      and coalesce(p.supplier_product_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(new.supplier_product_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and p.price_type = new.price_type
      and lower(btrim(p.price_unit)) = lower(btrim(new.price_unit))
      and p.approved = true
      and daterange(p.effective_from, coalesce(p.effective_to, 'infinity'::date), '[]') && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
  ) then
    raise exception 'overlapping approved price period' using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_material_price_history_reject_approved_overlap on public.material_price_history;
create trigger trg_material_price_history_reject_approved_overlap
before insert or update on public.material_price_history
for each row execute function public.trg_material_price_history_reject_approved_overlap();

create table if not exists public.material_scoped_aliases (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.sku_cogs_materials(id) on delete restrict,
  supplier_id uuid references public.suppliers(id) on delete restrict,
  source_type text not null,
  alias_name text not null,
  normalized_alias text not null,
  approved boolean not null default false,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint material_scoped_aliases_alias_nonempty check (nullif(btrim(alias_name), '') is not null and nullif(btrim(normalized_alias), '') is not null and nullif(btrim(source_type), '') is not null),
  constraint material_scoped_aliases_alias_normalized check (normalized_alias = public.material_master_normalize(alias_name)),
  constraint material_scoped_aliases_source_type_normalized check (source_type = lower(btrim(source_type))),
  constraint material_scoped_aliases_approval_consistent check ((approved = false) or (approved_by is not null and approved_at is not null))
);

create unique index if not exists uq_material_scoped_aliases_supplier_active_approved
  on public.material_scoped_aliases (supplier_id, normalized_alias)
  where supplier_id is not null and active = true and approved = true;
create unique index if not exists uq_material_scoped_aliases_source_active_approved
  on public.material_scoped_aliases (source_type, normalized_alias)
  where supplier_id is null and active = true and approved = true;
create index if not exists idx_material_scoped_aliases_lookup
  on public.material_scoped_aliases (supplier_id, source_type, normalized_alias)
  where active = true and approved = true;

create table if not exists public.material_resolution_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,
  source_type text not null,
  source_table text not null,
  source_id uuid,
  source_line_id uuid,
  supplier_id uuid references public.suppliers(id) on delete restrict,
  raw_name text not null,
  raw_code text,
  raw_unit text,
  normalized_name text not null,
  candidate_material_ids uuid[] not null default '{}'::uuid[],
  safe_payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','resolved_existing','created_new','rejected')),
  candidate_status text check (candidate_status in ('confirmation_needed','ambiguous','not_found')),
  resolved_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  resolved_scoped_alias_id uuid references public.material_scoped_aliases(id) on delete restrict,
  resolved_global_alias_id uuid references public.sku_cogs_material_aliases(id) on delete restrict,
  resolved_supplier_product_id uuid references public.material_supplier_products(id) on delete restrict,
  reviewer_id uuid references auth.users(id) on delete set null,
  reviewer_reason text,
  reviewed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint material_resolution_requests_key_sha256 check (request_key ~ '^[0-9a-f]{64}$'),
  constraint material_resolution_requests_source_nonempty check (nullif(btrim(source_type), '') is not null and nullif(btrim(source_table), '') is not null),
  constraint material_resolution_requests_source_type_normalized check (source_type = lower(btrim(source_type))),
  constraint material_resolution_requests_raw_name_nonempty check (nullif(btrim(raw_name), '') is not null and nullif(btrim(normalized_name), '') is not null),
  constraint material_resolution_requests_raw_name_normalized check (normalized_name = public.material_master_normalize(raw_name)),
  constraint material_resolution_requests_resolution_consistent check ((status in ('resolved_existing','created_new')) = (resolved_material_id is not null))
);

alter table public.material_scoped_aliases
  drop constraint if exists material_scoped_aliases_supplier_id_fkey,
  add constraint material_scoped_aliases_supplier_id_fkey foreign key (supplier_id) references public.suppliers(id) on delete restrict;

alter table public.material_resolution_requests
  drop constraint if exists material_resolution_requests_supplier_id_fkey,
  add constraint material_resolution_requests_supplier_id_fkey foreign key (supplier_id) references public.suppliers(id) on delete restrict,
  add column if not exists resolved_scoped_alias_id uuid references public.material_scoped_aliases(id) on delete restrict,
  add column if not exists resolved_global_alias_id uuid references public.sku_cogs_material_aliases(id) on delete restrict,
  add column if not exists resolved_supplier_product_id uuid references public.material_supplier_products(id) on delete restrict;

alter table public.material_master_audit_logs
  drop constraint if exists material_master_audit_logs_request_id_fkey,
  add constraint material_master_audit_logs_request_id_fkey
  foreign key (request_id) references public.material_resolution_requests(id) on delete set null;

create table if not exists public.material_master_enforcement_config (
  source_type text primary key,
  mode text not null default 'shadow' check (mode in ('disabled','shadow','enforced')),
  metadata jsonb not null default '{}'::jsonb,
  constraint material_master_enforcement_config_source_type_normalized check (source_type = lower(btrim(source_type))),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.material_master_enforcement_config (source_type, mode)
values
  ('sku_cogs', 'shadow'),
  ('kitchen_inventory', 'shadow'),
  ('purchase_order', 'shadow'),
  ('goods_receipt', 'shadow'),
  ('payment_request', 'shadow'),
  ('invoice', 'shadow'),
  ('scan_sku_cost_sheet', 'shadow'),
  ('match_delivery_note', 'shadow')
on conflict (source_type) do nothing;

alter table public.kitchen_inventory_items
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  add column if not exists material_resolution_status text,
  add column if not exists material_resolution_request_id uuid references public.material_resolution_requests(id) on delete set null;

alter table public.product_skus
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  add column if not exists material_resolution_status text,
  add column if not exists material_resolution_request_id uuid references public.material_resolution_requests(id) on delete set null;

alter table public.purchase_order_items
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  add column if not exists material_resolution_status text,
  add column if not exists material_resolution_request_id uuid references public.material_resolution_requests(id) on delete set null,
  add column if not exists raw_product_name text;

alter table public.goods_receipt_items
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  add column if not exists material_resolution_status text,
  add column if not exists material_resolution_request_id uuid references public.material_resolution_requests(id) on delete set null,
  add column if not exists raw_product_name text;

alter table public.payment_request_items
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  add column if not exists material_resolution_status text,
  add column if not exists material_resolution_request_id uuid references public.material_resolution_requests(id) on delete set null,
  add column if not exists raw_product_name text;

alter table public.invoice_items
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  add column if not exists material_resolution_status text,
  add column if not exists material_resolution_request_id uuid references public.material_resolution_requests(id) on delete set null,
  add column if not exists raw_product_name text;

create index if not exists idx_kitchen_inventory_items_canonical_material on public.kitchen_inventory_items(canonical_material_id) where canonical_material_id is not null;
create index if not exists idx_product_skus_canonical_material on public.product_skus(canonical_material_id) where canonical_material_id is not null;
create index if not exists idx_purchase_order_items_canonical_material on public.purchase_order_items(canonical_material_id) where canonical_material_id is not null;
create index if not exists idx_goods_receipt_items_canonical_material on public.goods_receipt_items(canonical_material_id) where canonical_material_id is not null;
create index if not exists idx_payment_request_items_canonical_material on public.payment_request_items(canonical_material_id) where canonical_material_id is not null;
create index if not exists idx_invoice_items_canonical_material on public.invoice_items(canonical_material_id) where canonical_material_id is not null;

create or replace function public.material_master_audit_append(
  p_action text,
  p_material_id uuid default null,
  p_request_id uuid default null,
  p_reason text default 'material master audited change',
  p_old_values jsonb default '{}'::jsonb,
  p_new_values jsonb default '{}'::jsonb,
  p_safe_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'material_master_audit_reason_required' using errcode = '22023';
  end if;
  insert into public.material_master_audit_logs(action, material_id, request_id, reason, actor_id, old_values, new_values, safe_payload)
  values (coalesce(nullif(btrim(p_action), ''), 'unknown'), p_material_id, p_request_id, p_reason, auth.uid(), coalesce(p_old_values, '{}'::jsonb), coalesce(p_new_values, '{}'::jsonb), coalesce(p_safe_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.trg_material_master_audit_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'material_master_audit_logs_append_only' using errcode = '42501';
end;
$$;

drop trigger if exists trg_material_master_audit_logs_append_only on public.material_master_audit_logs;
create trigger trg_material_master_audit_logs_append_only
before update or delete on public.material_master_audit_logs
for each row execute function public.trg_material_master_audit_append_only();

create or replace function public.trg_guard_canonical_material_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'canonical material delete is not allowed; use audited controller deactivation'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id then
      raise exception 'immutable material canonical_material_id cannot change' using errcode = '23514';
    end if;
    if new.material_code is distinct from old.material_code then
      raise exception 'immutable material_code cannot change' using errcode = '23514';
    end if;
    if coalesce(current_setting('material_master.rpc_update', true), '') <> 'on' then
      if new.canonical_name is distinct from old.canonical_name
        or new.normalized_name is distinct from old.normalized_name
        or new.default_unit is distinct from old.default_unit
        or new.active is distinct from old.active
        or new.category is distinct from old.category
        or new.brand is distinct from old.brand
        or new.specification is distinct from old.specification
        or new.updated_by is distinct from old.updated_by
        or new.version is distinct from old.version
        or new.created_by is distinct from old.created_by
        or new.created_at is distinct from old.created_at
        or new.updated_at is distinct from old.updated_at then
        raise exception 'stable material updates must use audited update_canonical_material RPC; canonical_material_id/material_code/name immutable outside controller'
          using errcode = '23514';
      end if;
    else
      if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
        raise exception 'canonical material created identity fields are immutable'
          using errcode = '23514';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_canonical_material_identity on public.sku_cogs_materials;
create trigger trg_guard_canonical_material_identity
before update or delete on public.sku_cogs_materials
for each row execute function public.trg_guard_canonical_material_identity();

create or replace function public.trg_validate_canonical_material_fk_active()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_material_id uuid;
begin
  v_material_id := new.canonical_material_id;
  if v_material_id is null then
    return new;
  end if;
  if not exists (select 1 from public.sku_cogs_materials m where m.id = v_material_id and m.active = true) then
    raise exception 'canonical_material_id must reference an active canonical material' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_kitchen_inventory_items_validate_canonical_material on public.kitchen_inventory_items;
create trigger trg_kitchen_inventory_items_validate_canonical_material before insert or update of canonical_material_id on public.kitchen_inventory_items for each row execute function public.trg_validate_canonical_material_fk_active();
drop trigger if exists trg_product_skus_validate_canonical_material on public.product_skus;
create trigger trg_product_skus_validate_canonical_material before insert or update of canonical_material_id on public.product_skus for each row execute function public.trg_validate_canonical_material_fk_active();
drop trigger if exists trg_purchase_order_items_validate_canonical_material on public.purchase_order_items;
create trigger trg_purchase_order_items_validate_canonical_material before insert or update of canonical_material_id on public.purchase_order_items for each row execute function public.trg_validate_canonical_material_fk_active();
drop trigger if exists trg_goods_receipt_items_validate_canonical_material on public.goods_receipt_items;
create trigger trg_goods_receipt_items_validate_canonical_material before insert or update of canonical_material_id on public.goods_receipt_items for each row execute function public.trg_validate_canonical_material_fk_active();
drop trigger if exists trg_payment_request_items_validate_canonical_material on public.payment_request_items;
create trigger trg_payment_request_items_validate_canonical_material before insert or update of canonical_material_id on public.payment_request_items for each row execute function public.trg_validate_canonical_material_fk_active();
drop trigger if exists trg_invoice_items_validate_canonical_material on public.invoice_items;
create trigger trg_invoice_items_validate_canonical_material before insert or update of canonical_material_id on public.invoice_items for each row execute function public.trg_validate_canonical_material_fk_active();

create or replace function public.assert_material_ready(
  p_material_id uuid,
  p_required_capabilities text[] default '{}'::text[],
  p_supplier_id uuid default null,
  p_unit text default null,
  p_effective_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_material public.sku_cogs_materials%rowtype;
  v_blockers text[] := '{}'::text[];
  v_cap text;
  v_unit text := nullif(lower(btrim(coalesce(p_unit, ''))), '');
begin
  select * into v_material from public.sku_cogs_materials where id = p_material_id;
  if not found then
    return jsonb_build_object('ready', false, 'status', 'blocked', 'material_id', p_material_id, 'blockers', jsonb_build_array('material_not_found'));
  end if;
  if not v_material.active then
    v_blockers := array_append(v_blockers, 'inactive');
  end if;

  foreach v_cap in array coalesce(p_required_capabilities, '{}'::text[]) loop
    v_cap := lower(btrim(coalesce(v_cap, '')));
    if v_cap in ('supplier_product','supplier') then
      if p_supplier_id is null then
        v_blockers := array_append(v_blockers, 'supplier_unmapped');
      elsif not exists (
        select 1 from public.material_supplier_products sp
        where sp.material_id = p_material_id and sp.supplier_id = p_supplier_id and sp.active = true and sp.approved = true
      ) then
        v_blockers := array_append(v_blockers, 'supplier_unmapped');
      end if;
    elsif v_cap in ('unit','unit_conversion') then
      if v_unit is null then
        v_blockers := array_append(v_blockers, 'unit_unmapped');
      elsif v_unit <> lower(btrim(v_material.default_unit)) and not exists (
        select 1 from public.material_unit_conversions c
        where c.material_id = p_material_id and c.active = true and c.approved = true
          and lower(btrim(c.from_unit)) = v_unit
          and lower(btrim(c.to_unit)) = lower(btrim(v_material.default_unit))
          and c.effective_from <= coalesce(p_effective_date, current_date)
          and (c.effective_to is null or c.effective_to >= coalesce(p_effective_date, current_date))
      ) then
        v_blockers := array_append(v_blockers, 'unit_unmapped');
      end if;
    elsif v_cap in ('price','standard_cost','purchase_price') then
      if not exists (
        select 1
        from public.material_price_history ph
        where ph.material_id = p_material_id
          and ph.approved = true
          and ph.price_type = case when v_cap = 'purchase_price' then 'purchase_price' else 'standard_cost' end
          and ph.effective_from <= coalesce(p_effective_date, current_date)
          and (ph.effective_to is null or ph.effective_to >= coalesce(p_effective_date, current_date))
          and (
            ph.supplier_product_id is null
            or (
              p_supplier_id is not null
              and exists (
                select 1
                from public.material_supplier_products sp
                where sp.id = ph.supplier_product_id
                  and sp.material_id = p_material_id
                  and sp.supplier_id = p_supplier_id
                  and sp.active = true
                  and sp.approved = true
              )
            )
          )
      ) then
        v_blockers := array_append(v_blockers, case when v_cap = 'purchase_price' then 'missing_purchase_price' else 'missing_standard_cost' end);
      end if;
    elsif v_cap = 'q7_mapping' then
      if not exists (
        select 1
        from public.q7_material_issue_material_mappings q7m
        where q7m.canonical_material_id = p_material_id
          and q7m.approval_status = 'approved'
          and (v_unit is null or lower(btrim(q7m.source_unit)) = v_unit)
      ) then
        v_blockers := array_append(v_blockers, 'missing_q7_mapping');
      end if;
    elsif v_cap = 'active' or v_cap = '' then
      null;
    else
      v_blockers := array_append(v_blockers, 'unsupported_capability');
    end if;
  end loop;

  if v_unit is not null and v_unit <> lower(btrim(v_material.default_unit)) and not exists (
    select 1 from public.material_unit_conversions c
    where c.material_id = p_material_id and c.active = true and c.approved = true
      and lower(btrim(c.from_unit)) = v_unit
      and lower(btrim(c.to_unit)) = lower(btrim(v_material.default_unit))
      and c.effective_from <= coalesce(p_effective_date, current_date)
      and (c.effective_to is null or c.effective_to >= coalesce(p_effective_date, current_date))
  ) then
    v_blockers := array_append(v_blockers, 'unit_unmapped');
  end if;

  select coalesce(array_agg(distinct b order by b), '{}'::text[]) into v_blockers from unnest(v_blockers) b;
  return jsonb_build_object('ready', cardinality(v_blockers) = 0, 'status', case when cardinality(v_blockers)=0 then 'ready' else 'blocked' end, 'material_id', p_material_id, 'blockers', to_jsonb(v_blockers));
end;
$$;

create or replace function public.resolve_canonical_material(
  p_raw_name text,
  p_raw_code text default null,
  p_raw_unit text default null,
  p_supplier_id uuid default null,
  p_source_type text default null,
  p_effective_date date default current_date,
  p_required_capabilities text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text := public.material_master_normalize(p_raw_name);
  v_source_type text := nullif(lower(btrim(coalesce(p_source_type, ''))), '');
  v_match public.sku_cogs_materials%rowtype;
  v_source text;
  v_ready jsonb;
  v_blockers text[];
  v_candidates uuid[];
begin
  -- match_source precedence markers: material_code, normalized_name, approved_supplier_alias, approved_source_alias, approved_global_alias.
  -- fuzzy / ai_candidate suggestions are intentionally candidate-only and fail-closed:
  -- they may return confirmation_needed/ambiguous/not_found but never resolved_exact.
  if nullif(btrim(coalesce(p_raw_code, '')), '') is not null then
    select * into v_match from public.sku_cogs_materials m where lower(btrim(m.material_code)) = lower(btrim(p_raw_code)) order by m.active desc limit 1;
    if found then v_source := 'material_code'; end if;
  end if;
  if v_match.id is null and v_norm <> '' then
    select * into v_match from public.sku_cogs_materials m where m.normalized_name = v_norm order by m.active desc limit 1;
    if found then v_source := 'normalized_name'; end if;
  end if;
  if v_match.id is null and p_supplier_id is not null and v_norm <> '' then
    select m.* into v_match
    from public.material_scoped_aliases a join public.sku_cogs_materials m on m.id = a.material_id
    where a.supplier_id = p_supplier_id and a.normalized_alias = v_norm and a.active = true and a.approved = true
    order by m.active desc, a.created_at desc limit 1;
    if found then v_source := 'approved_supplier_alias'; end if;
  end if;
  if v_match.id is null and p_supplier_id is null and v_source_type is not null and v_norm <> '' then
    select m.* into v_match
    from public.material_scoped_aliases a join public.sku_cogs_materials m on m.id = a.material_id
    where a.supplier_id is null and a.source_type = v_source_type and a.normalized_alias = v_norm and a.active = true and a.approved = true
    order by m.active desc, a.created_at desc limit 1;
    if found then v_source := 'approved_source_alias'; end if;
  end if;
  if v_match.id is null and v_norm <> '' then
    select m.* into v_match
    from public.sku_cogs_material_aliases a join public.sku_cogs_materials m on m.id = a.material_id
    where a.normalized_alias = v_norm and a.active = true and a.source in ('canonical_name','existing_cogs','approved_peerless_alias','approved_global_alias','approved')
    order by m.active desc, a.created_at desc limit 1;
    if found then v_source := 'approved_global_alias'; end if;
  end if;

  if v_match.id is not null then
    if not v_match.active then
      return jsonb_build_object('status','inactive','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'material_code',v_match.material_code);
    end if;
    v_ready := public.assert_material_ready(v_match.id, coalesce(p_required_capabilities, '{}'::text[]), p_supplier_id, p_raw_unit, p_effective_date);
    v_blockers := array(select jsonb_array_elements_text(v_ready->'blockers'));
    if 'unit_unmapped' = any(v_blockers) then
      return jsonb_build_object('status','unit_unmapped','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'blockers',v_ready->'blockers');
    end if;
    if 'supplier_unmapped' = any(v_blockers) then
      return jsonb_build_object('status','supplier_unmapped','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'blockers',v_ready->'blockers');
    end if;
    if (v_ready->>'ready')::boolean is false then
      return jsonb_build_object('status','confirmation_needed','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'blockers',v_ready->'blockers');
    end if;
    return jsonb_build_object('status','resolved_exact','resolved_exact',true,'match_source',v_source,'material_id',v_match.id,'material_code',v_match.material_code,'canonical_name',v_match.canonical_name,'default_unit',v_match.default_unit);
  end if;

  select coalesce(array_agg(id order by canonical_name), '{}'::uuid[]) into v_candidates
  from public.sku_cogs_materials
  where v_norm <> '' and active = true and normalized_name like v_norm || '%';
  if cardinality(v_candidates) > 1 then
    return jsonb_build_object('status','ambiguous','resolved_exact',false,'candidates',v_candidates,'fail_closed',true);
  elsif cardinality(v_candidates) = 1 then
    return jsonb_build_object('status','confirmation_needed','resolved_exact',false,'candidates',v_candidates,'fail_closed',true);
  end if;
  return jsonb_build_object('status','not_found','resolved_exact',false,'candidates','[]'::jsonb,'fail_closed',true);
end;
$$;

create or replace function public.request_material_resolution(
  p_source_type text,
  p_source_table text,
  p_source_id uuid,
  p_source_line_id uuid,
  p_raw_name text,
  p_raw_code text default null,
  p_raw_unit text default null,
  p_supplier_id uuid default null,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text := public.material_master_normalize(p_raw_name);
  v_key text;
  v_row public.material_resolution_requests%rowtype;
  v_resolved jsonb;
  v_candidates uuid[];
  v_candidate_status text;
  v_safe_payload jsonb := '{}'::jsonb;
  v_source_type text := nullif(lower(btrim(coalesce(p_source_type, ''))), '');
begin
  if v_source_type is null or nullif(btrim(coalesce(p_source_table, '')), '') is null then
    raise exception 'source identity required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_raw_name, '')), '') is null then
    raise exception 'raw_name required' using errcode = '22023';
  end if;
  v_key := encode(extensions.digest(
    concat_ws('|', v_source_type, lower(btrim(p_source_table)), coalesce(p_source_id::text, ''), coalesce(p_source_line_id::text, ''), coalesce(p_supplier_id::text, ''), v_norm, public.material_master_normalize(p_raw_code), lower(btrim(coalesce(p_raw_unit, '')))),
    'sha256'
  ), 'hex');
  v_resolved := public.resolve_canonical_material(p_raw_name, p_raw_code, p_raw_unit, p_supplier_id, v_source_type, current_date, '{}'::text[]);
  if coalesce((v_resolved->>'resolved_exact')::boolean, false) is true then
    insert into public.material_resolution_requests(request_key, source_type, source_table, source_id, source_line_id, supplier_id, raw_name, raw_code, raw_unit, normalized_name, candidate_material_ids, safe_payload, status, candidate_status, resolved_material_id, reviewer_id, reviewed_at, created_by)
    values (v_key, v_source_type, btrim(p_source_table), p_source_id, p_source_line_id, p_supplier_id, btrim(p_raw_name), nullif(btrim(coalesce(p_raw_code,'')),''), nullif(btrim(coalesce(p_raw_unit,'')),''), v_norm, array[(v_resolved->>'material_id')::uuid], public.material_master_safe_payload(p_payload, array['candidate_source','confidence','field_name']), 'resolved_existing', null, (v_resolved->>'material_id')::uuid, auth.uid(), now(), auth.uid())
    on conflict (request_key) do nothing
    returning * into v_row;
    if v_row.id is not null then
      return jsonb_build_object('status','already_resolved','request_id',v_row.id,'request_key',v_row.request_key,'resolution_status',v_row.status,'resolved_material_id',v_row.resolved_material_id);
    end if;
    select * into v_row from public.material_resolution_requests where request_key = v_key;
    return jsonb_build_object('status', case when v_row.status in ('resolved_existing','created_new') then 'already_resolved' else 'request_existing' end, 'request_id',v_row.id,'request_key',v_row.request_key,'resolution_status',v_row.status,'resolved_material_id',v_row.resolved_material_id);
  end if;

  select coalesce(array_agg(id order by canonical_name), '{}'::uuid[]) into v_candidates
  from public.sku_cogs_materials where v_norm <> '' and active = true and normalized_name like v_norm || '%';
  v_candidate_status := case when cardinality(v_candidates)>1 then 'ambiguous' when cardinality(v_candidates)=1 then 'confirmation_needed' else 'not_found' end;
  -- request safe_payload allowlist only candidate_source/confidence/field_name.
  if jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) = 'object' then
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_safe_payload
    from jsonb_each(coalesce(p_payload, '{}'::jsonb))
    where key in ('candidate_source','confidence','field_name');
  end if;

  insert into public.material_resolution_requests(request_key, source_type, source_table, source_id, source_line_id, supplier_id, raw_name, raw_code, raw_unit, normalized_name, candidate_material_ids, safe_payload, status, candidate_status, created_by)
  values (v_key, v_source_type, btrim(p_source_table), p_source_id, p_source_line_id, p_supplier_id, btrim(p_raw_name), nullif(btrim(coalesce(p_raw_code,'')),''), nullif(btrim(coalesce(p_raw_unit,'')),''), v_norm, v_candidates, v_safe_payload, 'pending', v_candidate_status, auth.uid())
  on conflict (request_key) do nothing
  returning * into v_row;
  if v_row.id is not null then
    return jsonb_build_object('status','request_created','request_id',v_row.id,'request_key',v_row.request_key,'resolution_status',v_row.status,'candidate_status',v_row.candidate_status,'resolved_material_id',v_row.resolved_material_id);
  end if;
  select * into v_row from public.material_resolution_requests where request_key = v_key;
  return jsonb_build_object('status','request_existing','request_id',v_row.id,'request_key',v_row.request_key,'resolution_status',v_row.status,'candidate_status',v_row.candidate_status,'resolved_material_id',v_row.resolved_material_id);
end;
$$;

create or replace function public.create_canonical_material(
  p_material_code text,
  p_canonical_name text,
  p_default_unit text,
  p_category text default null,
  p_brand text default null,
  p_specification text default null,
  p_reason text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_norm text := public.material_master_normalize(p_canonical_name);
  v_code text := nullif(btrim(p_material_code), '');
  v_row public.sku_cogs_materials%rowtype;
begin
  if not public.can_edit_material_master() then raise exception 'insufficient_privilege' using errcode='42501'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'reason required' using errcode='22023'; end if;
  if v_norm = '' or nullif(btrim(coalesce(p_default_unit, '')), '') is null then raise exception 'name and unit required' using errcode='22023'; end if;
  if v_code is null then
    v_code := 'NVL-' || lpad((nextval('public.sku_cogs_materials_nvl_code_seq'))::text, 6, '0');
  end if;
  if exists(select 1 from public.sku_cogs_materials where normalized_name = v_norm) then raise exception 'normalized canonical name already exists' using errcode='23505'; end if;
  insert into public.sku_cogs_materials(material_code, canonical_name, normalized_name, default_unit, category, brand, specification, created_by, updated_by, version)
  values (v_code, btrim(p_canonical_name), v_norm, btrim(p_default_unit), nullif(btrim(coalesce(p_category,'')),''), nullif(btrim(coalesce(p_brand,'')),''), nullif(btrim(coalesce(p_specification,'')),''), v_actor, v_actor, 1)
  returning * into v_row;
  perform public.material_master_audit_append('create_canonical_material', v_row.id, p_request_id, p_reason, '{}'::jsonb, public.material_master_row_json(v_row), jsonb_build_object('created', true, 'request_id', p_request_id));
  return jsonb_build_object('status','created','material_id',v_row.id,'material_code',v_row.material_code,'version',v_row.version);
end;
$$;

do $$
declare
  v_max_code bigint;
  v_last_value bigint;
  v_is_called boolean;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='sku_cogs_materials_nvl_code_seq') then
    create sequence public.sku_cogs_materials_nvl_code_seq start with 1;
  end if;
  select coalesce(max((substring(material_code from '^NVL-([0-9]{6})$'))::bigint), 0)
    into v_max_code
  from public.sku_cogs_materials
  where material_code ~ '^NVL-[0-9]{6}$';
  select last_value, is_called into v_last_value, v_is_called from public.sku_cogs_materials_nvl_code_seq;
  if v_max_code = 0 and v_last_value <= 1 and v_is_called = false then
    perform setval('public.sku_cogs_materials_nvl_code_seq', 1, false);
  elsif v_max_code >= (case when v_is_called then v_last_value + 1 else v_last_value end) then
    perform setval('public.sku_cogs_materials_nvl_code_seq', greatest(v_max_code, v_last_value), true);
  end if;
end $$;

create or replace function public.update_canonical_material(
  p_material_id uuid,
  p_expected_version int,
  p_patch jsonb,
  p_reason text,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_old public.sku_cogs_materials%rowtype;
  v_new public.sku_cogs_materials%rowtype;
  v_allowed text[] := array['canonical_name','default_unit','active','category','brand','specification'];
  v_key text;
  v_new_norm text;
  v_alias_created boolean := false;
begin
  if not public.can_edit_material_master() then raise exception 'insufficient_privilege' using errcode='42501'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'reason required' using errcode='22023'; end if;
  if jsonb_typeof(coalesce(p_patch, '{}'::jsonb)) <> 'object' then raise exception 'material patch must be a JSON object' using errcode='22023'; end if;
  if p_patch ? 'default_unit' and nullif(btrim(coalesce(p_patch->>'default_unit', '')), '') is null then raise exception 'default_unit required' using errcode='22023'; end if;
  if p_patch ? 'id' or p_patch ? 'uuid' or p_patch ? 'material_code' then
    raise exception 'material_code and canonical_material_id are immutable material fields' using errcode='23514';
  end if;
  for v_key in select jsonb_object_keys(coalesce(p_patch,'{}'::jsonb)) loop
    if not v_key = any(v_allowed) then raise exception 'unsupported material patch key: %', v_key using errcode='22023'; end if;
  end loop;
  select * into v_old from public.sku_cogs_materials where id = p_material_id for update;
  if not found then raise exception 'material not found' using errcode='P0002'; end if;
  if coalesce(v_old.version, 0) <> p_expected_version then raise exception 'material version conflict' using errcode='40001'; end if;
  v_new_norm := case when p_patch ? 'canonical_name' then public.material_master_normalize(p_patch->>'canonical_name') else v_old.normalized_name end;
  if v_new_norm = '' then raise exception 'canonical_name required' using errcode='22023'; end if;
  if exists(select 1 from public.sku_cogs_materials where normalized_name = v_new_norm and id <> p_material_id) then raise exception 'normalized canonical name already belongs to another material' using errcode='23505'; end if;
  if p_patch ? 'canonical_name' and v_new_norm <> v_old.normalized_name and exists(select 1 from public.sku_cogs_material_aliases where normalized_alias = v_old.normalized_name and material_id <> p_material_id) then
    raise exception 'old canonical name alias belongs to another material' using errcode='23505';
  end if;

  perform set_config('material_master.rpc_update', 'on', true);
  update public.sku_cogs_materials
  set canonical_name = case when p_patch ? 'canonical_name' then btrim(p_patch->>'canonical_name') else canonical_name end,
      normalized_name = v_new_norm,
      default_unit = case when p_patch ? 'default_unit' then btrim(p_patch->>'default_unit') else default_unit end,
      active = case when p_patch ? 'active' then (p_patch->>'active')::boolean else active end,
      category = case when p_patch ? 'category' then nullif(btrim(p_patch->>'category'),'') else category end,
      brand = case when p_patch ? 'brand' then nullif(btrim(p_patch->>'brand'),'') else brand end,
      specification = case when p_patch ? 'specification' then nullif(btrim(p_patch->>'specification'),'') else specification end,
      updated_by = v_actor,
      updated_at = now(),
      version = coalesce(version, 0) + 1
  where id = p_material_id
  returning * into v_new;

  if p_patch ? 'canonical_name' and v_new.normalized_name <> v_old.normalized_name then
    insert into public.sku_cogs_material_aliases(material_id, alias_name, normalized_alias, source, active, created_by)
    values (p_material_id, v_old.canonical_name, v_old.normalized_name, 'canonical_name', true, v_actor)
    on conflict (normalized_alias) do update
    set alias_name = excluded.alias_name,
        source = 'canonical_name',
        active = true
    where public.sku_cogs_material_aliases.material_id = excluded.material_id;
    v_alias_created := true;
  end if;
  perform public.material_master_audit_append('update_canonical_material', p_material_id, p_request_id, p_reason, public.material_master_row_json(v_old), public.material_master_row_json(v_new), jsonb_build_object('patch_keys', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k), 'alias_created_for_old_name', v_alias_created));
  return jsonb_build_object('status','updated','material_id',v_new.id,'version',v_new.version,'alias_created_for_old_name',v_alias_created);
end;
$$;

create or replace function public.confirm_material_resolution(
  p_request_id uuid,
  p_action text,
  p_material_id uuid default null,
  p_create_payload jsonb default null,
  p_alias_payload jsonb default '{}'::jsonb,
  p_supplier_product_payload jsonb default '{}'::jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.material_resolution_requests%rowtype;
  v_material_id uuid := p_material_id;
  v_created jsonb;
  v_alias text;
  v_alias_name text;
  v_default_unit text;
  v_purchase_unit text;
  v_base_unit text;
  v_package_unit text;
  v_package_quantity numeric;
  v_base_quantity numeric;
  v_supplier_product_name text;
  v_scoped_alias_id uuid;
  v_global_alias_id uuid;
  v_alias_id uuid;
  v_supplier_product_id uuid;
  v_existing_alias_material_id uuid;
  v_existing_supplier_product_material_id uuid;
  v_status text;
  v_alias_metadata jsonb := '{}'::jsonb;
  v_supplier_product_metadata jsonb := '{}'::jsonb;
begin
  if not public.can_edit_material_master() then raise exception 'insufficient_privilege' using errcode='42501'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'reason required' using errcode='22023'; end if;
  if jsonb_typeof(coalesce(p_alias_payload, '{}'::jsonb)) <> 'object' then raise exception 'alias payload must be a JSON object' using errcode='22023'; end if;
  if jsonb_typeof(coalesce(p_supplier_product_payload, '{}'::jsonb)) <> 'object' then raise exception 'supplier product payload must be a JSON object' using errcode='22023'; end if;
  v_alias_metadata := public.material_master_safe_payload(p_alias_payload, array['candidate_source','confidence','field_name']);
  v_supplier_product_metadata := public.material_master_safe_payload(p_supplier_product_payload, array['candidate_source','confidence','field_name']);
  select * into v_req from public.material_resolution_requests where id = p_request_id for update;
  if not found then raise exception 'resolution request not found' using errcode='P0002'; end if;
  if v_req.status in ('resolved_existing','created_new','rejected') then
    return jsonb_build_object('status','resolution_unchanged','request_id',p_request_id,'material_id',v_req.resolved_material_id,'alias_id',coalesce(v_req.resolved_scoped_alias_id, v_req.resolved_global_alias_id),'supplier_product_id',v_req.resolved_supplier_product_id);
  end if;

  if p_action = 'reject' then
    update public.material_resolution_requests set status='rejected', reviewer_id=auth.uid(), reviewer_reason=p_reason, reviewed_at=now(), updated_at=now() where id=p_request_id returning * into v_req;
    perform public.material_master_audit_append('reject_material_resolution', null, p_request_id, p_reason, '{}'::jsonb, jsonb_build_object('request_id', v_req.id, 'status', v_req.status), jsonb_build_object('action','reject'));
    return jsonb_build_object('status','rejected','request_id',p_request_id,'material_id',null,'alias_id',null,'supplier_product_id',null);
  elsif p_action = 'create_new' then
    if jsonb_typeof(coalesce(p_create_payload, '{}'::jsonb)) <> 'object' then raise exception 'new material payload must be a JSON object' using errcode='22023'; end if;
    v_default_unit := coalesce(nullif(btrim(p_create_payload->>'default_unit'), ''), nullif(btrim(v_req.raw_unit), ''));
    if v_default_unit is null then raise exception 'default_unit required for new canonical material' using errcode='22023'; end if;
    v_created := public.create_canonical_material(p_create_payload->>'material_code', p_create_payload->>'canonical_name', v_default_unit, p_create_payload->>'category', p_create_payload->>'brand', p_create_payload->>'specification', p_reason, p_request_id);
    v_material_id := (v_created->>'material_id')::uuid;
    v_status := 'created_new';
  elsif p_action = 'resolve_existing' then
    v_status := 'resolved_existing';
  else
    raise exception 'unsupported confirm action' using errcode='22023';
  end if;

  if v_material_id is null or not exists(select 1 from public.sku_cogs_materials where id=v_material_id and active=true) then raise exception 'active material required' using errcode='23514'; end if;

  v_alias_name := coalesce(nullif(btrim(p_alias_payload->>'alias_name'), ''), v_req.raw_name);
  v_alias := public.material_master_normalize(v_alias_name);
  if v_alias <> '' then
    if v_req.supplier_id is not null then
      if exists (
        select 1 from public.material_scoped_aliases
        where supplier_id = v_req.supplier_id and normalized_alias = v_alias and active = true and approved = true and material_id <> v_material_id
      ) then
        raise exception 'approved scoped alias already belongs to another canonical material' using errcode='23505';
      end if;
      insert into public.material_scoped_aliases(material_id, supplier_id, source_type, alias_name, normalized_alias, approved, approved_by, approved_at, active, metadata, created_by)
      values (v_material_id, v_req.supplier_id, lower(btrim(v_req.source_type)), v_alias_name, v_alias, true, auth.uid(), now(), true, v_alias_metadata, auth.uid())
      on conflict (supplier_id, normalized_alias) where supplier_id is not null and active = true and approved = true do update
      set approved_by=excluded.approved_by,
          approved_at=excluded.approved_at,
          metadata=excluded.metadata
      where public.material_scoped_aliases.material_id = excluded.material_id
      returning id into v_scoped_alias_id;
      if v_scoped_alias_id is null then
        select id, material_id into v_scoped_alias_id, v_existing_alias_material_id
        from public.material_scoped_aliases
        where supplier_id = v_req.supplier_id
          and normalized_alias = v_alias
          and active = true
          and approved = true;
        if v_scoped_alias_id is null then
          raise exception 'approved alias insert returned no id after conflict re-read' using errcode='23505';
        elsif v_existing_alias_material_id <> v_material_id then
          raise exception 'approved scoped alias conflict after insert race' using errcode='23505';
        end if;
      end if;
      v_alias_id := v_scoped_alias_id;
    elsif nullif(btrim(v_req.source_type), '') is not null then
      if exists (
        select 1 from public.material_scoped_aliases
        where supplier_id is null and source_type = lower(btrim(v_req.source_type)) and normalized_alias = v_alias and active = true and approved = true and material_id <> v_material_id
      ) then
        raise exception 'approved source alias already belongs to another canonical material' using errcode='23505';
      end if;
      insert into public.material_scoped_aliases(material_id, supplier_id, source_type, alias_name, normalized_alias, approved, approved_by, approved_at, active, metadata, created_by)
      values (v_material_id, null, lower(btrim(v_req.source_type)), v_alias_name, v_alias, true, auth.uid(), now(), true, v_alias_metadata, auth.uid())
      on conflict (source_type, normalized_alias) where supplier_id is null and active = true and approved = true do update
      set approved_by=excluded.approved_by,
          approved_at=excluded.approved_at,
          metadata=excluded.metadata
      where public.material_scoped_aliases.material_id = excluded.material_id
      returning id into v_scoped_alias_id;
      if v_scoped_alias_id is null then
        select id, material_id into v_scoped_alias_id, v_existing_alias_material_id
        from public.material_scoped_aliases
        where supplier_id is null
          and source_type = lower(btrim(v_req.source_type))
          and normalized_alias = v_alias
          and active = true
          and approved = true;
        if v_scoped_alias_id is null then
          raise exception 'approved alias insert returned no id after conflict re-read' using errcode='23505';
        elsif v_existing_alias_material_id <> v_material_id then
          raise exception 'approved source alias conflict after insert race' using errcode='23505';
        end if;
      end if;
      v_alias_id := v_scoped_alias_id;
    else
      if exists (
        select 1 from public.sku_cogs_material_aliases
        where normalized_alias = v_alias and active = true and material_id <> v_material_id
      ) then
        raise exception 'approved global alias already belongs to another canonical material' using errcode='23505';
      end if;
      insert into public.sku_cogs_material_aliases(material_id, alias_name, normalized_alias, source, active, created_by)
      values (v_material_id, v_alias_name, v_alias, 'approved_global_alias', true, auth.uid())
      on conflict (normalized_alias) do update
      set alias_name=excluded.alias_name,
          source='approved_global_alias',
          active=true
      where public.sku_cogs_material_aliases.material_id = excluded.material_id
      returning id into v_global_alias_id;
      if v_global_alias_id is null then
        select id, material_id into v_global_alias_id, v_existing_alias_material_id
        from public.sku_cogs_material_aliases
        where normalized_alias = v_alias;
        if v_global_alias_id is null then
          raise exception 'approved alias insert returned no id after conflict re-read' using errcode='23505';
        elsif v_existing_alias_material_id <> v_material_id then
          raise exception 'approved global alias conflict after insert race' using errcode='23505';
        end if;
      end if;
      v_alias_id := v_global_alias_id;
    end if;
  end if;

  if v_req.supplier_id is not null and p_supplier_product_payload <> '{}'::jsonb then
    v_supplier_product_name := coalesce(nullif(btrim(p_supplier_product_payload->>'name'), ''), v_req.raw_name);
    v_purchase_unit := coalesce(nullif(btrim(p_supplier_product_payload->>'purchase_unit'), ''), nullif(btrim(v_req.raw_unit), ''));
    v_base_unit := coalesce(nullif(btrim(p_supplier_product_payload->>'base_unit'), ''), nullif(btrim(v_req.raw_unit), ''));
    v_package_unit := nullif(btrim(p_supplier_product_payload->>'package_unit'), '');
    v_package_quantity := nullif(p_supplier_product_payload->>'package_quantity','')::numeric;
    v_base_quantity := nullif(p_supplier_product_payload->>'base_quantity','')::numeric;
    if nullif(btrim(v_supplier_product_name), '') is null then raise exception 'supplier product name required' using errcode='22023'; end if;
    if v_purchase_unit is null or v_base_unit is null then raise exception 'supplier product purchase_unit and base_unit required' using errcode='22023'; end if;
    if v_base_quantity is null or v_base_quantity <= 0 or v_base_quantity::text in ('NaN','Infinity','-Infinity') then raise exception 'supplier product positive finite base_quantity required' using errcode='22023'; end if;
    if v_package_quantity is not null and (v_package_quantity <= 0 or v_package_quantity::text in ('NaN','Infinity','-Infinity')) then raise exception 'supplier product package_quantity must be positive finite' using errcode='22023'; end if;
    insert into public.material_supplier_products(material_id, supplier_id, supplier_product_code, supplier_product_name, normalized_supplier_product_name, purchase_unit, package_quantity, package_unit, base_quantity, base_unit, approved, approved_by, approved_at, active, metadata, created_by)
    values (v_material_id, v_req.supplier_id, nullif(btrim(p_supplier_product_payload->>'code'),''), v_supplier_product_name, public.material_master_normalize(v_supplier_product_name), v_purchase_unit, v_package_quantity, v_package_unit, v_base_quantity, v_base_unit, true, auth.uid(), now(), true, v_supplier_product_metadata, auth.uid())
    on conflict (supplier_id, normalized_supplier_product_name, (lower(btrim(purchase_unit)))) where active = true do nothing
    returning id into v_supplier_product_id;
    if v_supplier_product_id is null then
      select id, material_id into v_supplier_product_id, v_existing_supplier_product_material_id
      from public.material_supplier_products
      where supplier_id = v_req.supplier_id
        and normalized_supplier_product_name = public.material_master_normalize(v_supplier_product_name)
        and lower(btrim(purchase_unit)) = lower(btrim(v_purchase_unit))
        and active = true;
      if v_supplier_product_id is null then
        raise exception 'supplier product insert returned no id after conflict re-read' using errcode='23505';
      elsif v_existing_supplier_product_material_id <> v_material_id then
        raise exception 'supplier product normalized name/unit already belongs to another material' using errcode='23505';
      end if;
    end if;
  end if;

  if v_alias <> '' and v_alias_id is null then
    raise exception 'approved alias insert returned no id after conflict re-read' using errcode='23505';
  end if;

  update public.material_resolution_requests set status=v_status, resolved_material_id=v_material_id, resolved_scoped_alias_id=v_scoped_alias_id, resolved_global_alias_id=v_global_alias_id, resolved_supplier_product_id=v_supplier_product_id, reviewer_id=auth.uid(), reviewer_reason=p_reason, reviewed_at=now(), updated_at=now() where id=p_request_id returning * into v_req;
  perform public.material_master_audit_append(
    'confirm_material_resolution',
    v_material_id,
    p_request_id,
    p_reason,
    '{}'::jsonb,
    jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'resolved_material_id', v_req.resolved_material_id),
    jsonb_build_object('alias_created', v_alias_id is not null, 'supplier_product_created', v_supplier_product_id is not null, 'action', p_action)
  );
  return jsonb_build_object('status',v_status,'request_id',p_request_id,'material_id',v_material_id,'alias_id',v_alias_id,'supplier_product_id',v_supplier_product_id);
end;
$$;

-- RLS/ACL: authenticated SELECT through view helper; no direct browser DML on new controller tables.
alter table public.material_unit_conversions enable row level security;
alter table public.material_supplier_products enable row level security;
alter table public.material_price_history enable row level security;
alter table public.material_scoped_aliases enable row level security;
alter table public.material_resolution_requests enable row level security;
alter table public.material_master_audit_logs enable row level security;
alter table public.material_master_enforcement_config enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='material_unit_conversions' and policyname='material_master_select_material_unit_conversions') then execute 'create policy material_master_select_material_unit_conversions on public.material_unit_conversions for select to authenticated using (public.can_view_material_master())'; end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='material_supplier_products' and policyname='material_master_select_material_supplier_products') then execute 'create policy material_master_select_material_supplier_products on public.material_supplier_products for select to authenticated using (public.can_view_material_master())'; end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='material_price_history' and policyname='material_master_select_material_price_history') then execute 'create policy material_master_select_material_price_history on public.material_price_history for select to authenticated using (public.can_view_material_master())'; end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='material_scoped_aliases' and policyname='material_master_select_material_scoped_aliases') then execute 'create policy material_master_select_material_scoped_aliases on public.material_scoped_aliases for select to authenticated using (public.can_view_material_master())'; end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='material_resolution_requests' and policyname='material_master_select_material_resolution_requests') then execute 'create policy material_master_select_material_resolution_requests on public.material_resolution_requests for select to authenticated using (public.can_view_material_master())'; end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='material_master_audit_logs' and policyname='material_master_select_material_master_audit_logs') then execute 'create policy material_master_select_material_master_audit_logs on public.material_master_audit_logs for select to authenticated using (public.can_view_material_master())'; end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='material_master_enforcement_config' and policyname='material_master_select_material_master_enforcement_config') then execute 'create policy material_master_select_material_master_enforcement_config on public.material_master_enforcement_config for select to authenticated using (public.can_view_material_master())'; end if;
end $$;

revoke all on public.material_unit_conversions from public, anon, authenticated;
revoke all on public.material_supplier_products from public, anon, authenticated;
revoke all on public.material_price_history from public, anon, authenticated;
revoke all on public.material_scoped_aliases from public, anon, authenticated;
revoke all on public.material_resolution_requests from public, anon, authenticated;
revoke all on public.material_master_audit_logs from public, anon, authenticated;
revoke all on public.material_master_enforcement_config from public, anon, authenticated;
grant select on public.material_unit_conversions, public.material_supplier_products, public.material_price_history, public.material_scoped_aliases, public.material_resolution_requests, public.material_master_audit_logs, public.material_master_enforcement_config to authenticated;
grant all on public.material_unit_conversions, public.material_supplier_products, public.material_price_history, public.material_scoped_aliases, public.material_resolution_requests, public.material_master_audit_logs, public.material_master_enforcement_config to service_role;
revoke insert, update, delete, truncate on public.sku_cogs_materials from public, anon, authenticated;
revoke insert, update, delete, truncate on public.sku_cogs_material_aliases from public, anon, authenticated;
revoke insert, update, delete, truncate on public.sku_cogs_materials from service_role;
revoke insert, update, delete, truncate on public.sku_cogs_material_aliases from service_role;

revoke execute on function public.material_master_audit_append(text, uuid, uuid, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.create_canonical_material(text, text, text, text, text, text, text, uuid) from public, anon;
revoke execute on function public.update_canonical_material(uuid, int, jsonb, text, uuid) from public, anon;
revoke execute on function public.confirm_material_resolution(uuid, text, uuid, jsonb, jsonb, jsonb, text) from public, anon;
revoke execute on function public.request_material_resolution(text, text, uuid, uuid, text, text, text, uuid, jsonb) from public, anon;
revoke execute on function public.resolve_canonical_material(text, text, text, uuid, text, date, text[]) from public, anon;
revoke execute on function public.assert_material_ready(uuid, text[], uuid, text, date) from public, anon;
grant execute on function public.resolve_canonical_material(text, text, text, uuid, text, date, text[]) to authenticated, service_role;
grant execute on function public.request_material_resolution(text, text, uuid, uuid, text, text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function public.create_canonical_material(text, text, text, text, text, text, text, uuid) to authenticated, service_role;
grant execute on function public.update_canonical_material(uuid, int, jsonb, text, uuid) to authenticated, service_role;
grant execute on function public.confirm_material_resolution(uuid, text, uuid, jsonb, jsonb, jsonb, text) to authenticated, service_role;
grant execute on function public.assert_material_ready(uuid, text[], uuid, text, date) to authenticated, service_role;

revoke execute on function public.trg_material_unit_conversions_reject_approved_overlap() from public, anon, authenticated, service_role;
revoke execute on function public.trg_material_price_history_reject_approved_overlap() from public, anon, authenticated, service_role;
revoke execute on function public.trg_material_master_audit_append_only() from public, anon, authenticated, service_role;
revoke execute on function public.trg_guard_canonical_material_identity() from public, anon, authenticated, service_role;
revoke execute on function public.trg_validate_canonical_material_fk_active() from public, anon, authenticated, service_role;


-- Inline Task7 prerequisite begins.
-- Task 7 Canonical NVL COGS Controller.
-- Canonical root remains public.sku_cogs_materials only.
-- This migration is additive/controller-only: it does not backfill, merge, delete, or rewrite historical COGS/formulation versions.

alter table public.sku_formulations
  add column if not exists material_resolution_status text,
  add column if not exists material_resolution_request_id uuid references public.material_resolution_requests(id) on delete set null,
  add column if not exists canonical_default_unit text,
  add column if not exists standard_unit_price numeric,
  add column if not exists standard_price_id uuid references public.material_price_history(id) on delete set null;

alter table public.sku_cogs_version_formulations
  add column if not exists canonical_material_snapshot jsonb not null default '{}'::jsonb;

insert into public.material_master_enforcement_config (source_type, mode)
values ('sku_cogs', 'enforced'), ('scan_sku_cost_sheet', 'enforced')
on conflict (source_type) do update set mode = excluded.mode, updated_at = now();

create or replace function public.sku_cogs_material_price_snapshot(
  p_material_id uuid,
  p_input_unit text,
  p_effective_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_material public.sku_cogs_materials%rowtype;
  v_price public.material_price_history%rowtype;
  v_input_unit text := nullif(lower(btrim(coalesce(p_input_unit, ''))), '');
  v_default_unit text;
  v_input_to_default_factor numeric := 1;
  v_price_to_default_factor numeric := 1;
  v_base_unit_price numeric;
begin
  select * into v_material from public.sku_cogs_materials where id = p_material_id and active = true;
  if not found then
    return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('material_not_found'));
  end if;
  v_default_unit := lower(btrim(v_material.default_unit));
  if v_input_unit is null then
    return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('unit_unmapped'));
  end if;
  if v_input_unit <> v_default_unit then
    select c.factor into v_input_to_default_factor
    from public.material_unit_conversions c
    where c.material_id = p_material_id and c.active = true and c.approved = true
      and lower(btrim(c.from_unit)) = v_input_unit
      and lower(btrim(c.to_unit)) = v_default_unit
      and c.effective_from <= coalesce(p_effective_date, current_date)
      and (c.effective_to is null or c.effective_to >= coalesce(p_effective_date, current_date))
    order by c.effective_from desc, c.created_at desc
    limit 1;
    if v_input_to_default_factor is null then
      return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('unit_unmapped'), 'material_id', p_material_id);
    end if;
  end if;

  select * into v_price
  from public.material_price_history ph
  where ph.material_id = p_material_id
    and ph.approved = true
    and ph.price_type = 'standard_cost'
    and ph.effective_from <= coalesce(p_effective_date, current_date)
    and (ph.effective_to is null or ph.effective_to >= coalesce(p_effective_date, current_date))
    and ph.supplier_product_id is null
  order by ph.effective_from desc, ph.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('missing_standard_cost'), 'material_id', p_material_id);
  end if;

  if v_price.normalized_base_unit_price is not null then
    v_base_unit_price := v_price.normalized_base_unit_price;
  elsif lower(btrim(v_price.price_unit)) = v_default_unit then
    v_base_unit_price := v_price.price;
  else
    select c.factor into v_price_to_default_factor
    from public.material_unit_conversions c
    where c.material_id = p_material_id and c.active = true and c.approved = true
      and lower(btrim(c.from_unit)) = lower(btrim(v_price.price_unit))
      and lower(btrim(c.to_unit)) = v_default_unit
      and c.effective_from <= coalesce(p_effective_date, current_date)
      and (c.effective_to is null or c.effective_to >= coalesce(p_effective_date, current_date))
    order by c.effective_from desc, c.created_at desc
    limit 1;
    if v_price_to_default_factor is null then
      return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('unit_unmapped'), 'material_id', p_material_id, 'price_id', v_price.id);
    end if;
    v_base_unit_price := v_price.price / v_price_to_default_factor;
  end if;

  return jsonb_build_object(
    'ready', true,
    'material_id', p_material_id,
    'canonical_material_name', v_material.canonical_name,
    'canonical_material_code', v_material.material_code,
    'canonical_default_unit', v_material.default_unit,
    'standard_unit_price', v_base_unit_price,
    'price_id', v_price.id,
    'input_unit', v_input_unit,
    'input_to_default_factor', v_input_to_default_factor,
    'blockers', '[]'::jsonb
  );
end;
$$;

create or replace function public.apply_sku_cogs_material_resolution(
  p_source_line_id uuid,
  p_raw_name text,
  p_raw_code text default null,
  p_raw_unit text default null,
  p_effective_date date default current_date,
  p_zero_cost_approved boolean default false,
  p_reason text default 'Task7 COGS canonical material resolution'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_raw_name text := nullif(btrim(coalesce(p_raw_name, '')), '');
  v_resolved jsonb;
  v_material_id uuid;
  v_request jsonb;
  v_request_id uuid;
  v_price jsonb;
  v_status text;
  v_blockers jsonb := '[]'::jsonb;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  if not (public.has_role(v_actor, 'owner') or public.has_role(v_actor, 'staff') or public.has_role(v_actor, 'warehouse')) then
    raise exception 'Không có quyền cập nhật SKU COGS' using errcode='42501';
  end if;
  if v_raw_name is null then raise exception 'raw material name required' using errcode='22023'; end if;

  v_resolved := public.resolve_canonical_material(v_raw_name, p_raw_code, p_raw_unit, null, 'sku_cogs', coalesce(p_effective_date, current_date), array['unit','standard_cost']);
  v_status := coalesce(v_resolved->>'status', 'controller_error');
  v_material_id := nullif(v_resolved->>'material_id', '')::uuid;

  if coalesce((v_resolved->>'resolved_exact')::boolean, false) is not true or v_material_id is null then
    v_request := public.request_material_resolution(
      'sku_cogs', 'sku_formulations', null, p_source_line_id, v_raw_name, p_raw_code, p_raw_unit, null,
      jsonb_build_object('candidate_source', coalesce(v_resolved->>'match_source', v_status), 'confidence', 'pending', 'field_name', 'sku_formulations.canonical_material_id')
    );
    v_request_id := nullif(v_request->>'request_id', '')::uuid;
    if p_source_line_id is not null then
      perform set_config('material_master.sku_cogs_save', coalesce(v_request_id::text, 'pending'), true);
      update public.sku_formulations
      set material_resolution_status = case when v_status in ('ambiguous','confirmation_needed','not_found','unit_unmapped','supplier_unmapped','inactive') then v_status else 'not_found' end,
          material_resolution_request_id = v_request_id,
          raw_ocr_name = coalesce(raw_ocr_name, v_raw_name)
      where id = p_source_line_id;
    end if;
    return jsonb_build_object('status', coalesce(v_status, 'not_found'), 'resolved_exact', false, 'material_id', v_material_id, 'request_id', v_request_id, 'blockers', coalesce(v_resolved->'blockers', jsonb_build_array('material_resolution_required')));
  end if;

  v_price := public.sku_cogs_material_price_snapshot(v_material_id, p_raw_unit, coalesce(p_effective_date, current_date));
  if coalesce((v_price->>'ready')::boolean, false) is not true then
    v_blockers := coalesce(v_price->'blockers', jsonb_build_array('missing_standard_cost'));
    v_request := public.request_material_resolution(
      'sku_cogs', 'sku_formulations', null, p_source_line_id, v_raw_name, p_raw_code, p_raw_unit, null,
      jsonb_build_object('candidate_source', 'exact_identity_missing_capability', 'confidence', 'pending', 'field_name', 'sku_formulations.canonical_material_id', 'blockers', v_blockers)
    );
    v_request_id := nullif(v_request->>'request_id', '')::uuid;
    if p_source_line_id is not null then
      perform set_config('material_master.sku_cogs_save', coalesce(v_request_id::text, 'pending'), true);
      update public.sku_formulations
      set material_resolution_status = case when v_blockers ? 'unit_unmapped' then 'unit_unmapped' else 'confirmation_needed' end,
          material_resolution_request_id = v_request_id,
          raw_ocr_name = coalesce(raw_ocr_name, v_raw_name)
      where id = p_source_line_id;
    end if;
    return jsonb_build_object('status', 'blocked', 'resolved_exact', false, 'material_id', v_material_id, 'request_id', v_request_id, 'blockers', v_blockers);
  end if;

  if coalesce((v_price->>'standard_unit_price')::numeric, 0) = 0 and p_zero_cost_approved is not true then
    v_request := public.request_material_resolution(
      'sku_cogs', 'sku_formulations', null, p_source_line_id, v_raw_name, p_raw_code, p_raw_unit, null,
      jsonb_build_object('candidate_source', 'zero_standard_cost_policy', 'confidence', 'pending', 'field_name', 'sku_formulations.standard_unit_price', 'blockers', jsonb_build_array('zero cost standard cost requires explicit approval'))
    );
    v_request_id := nullif(v_request->>'request_id', '')::uuid;
    return jsonb_build_object('status','blocked','resolved_exact',false,'material_id',v_material_id,'request_id',v_request_id,'blockers',jsonb_build_array('zero cost standard cost requires explicit approval'));
  end if;

  if p_source_line_id is not null then
    perform set_config('material_master.sku_cogs_save', coalesce(v_request_id::text, 'exact'), true);
    update public.sku_formulations f
    set canonical_material_id = v_material_id,
        ingredient_name = v_price->>'canonical_material_name',
        raw_ocr_name = coalesce(f.raw_ocr_name, v_raw_name),
        material_code = v_price->>'canonical_material_code',
        unit = v_price->>'canonical_default_unit',
        unit_price = (v_price->>'standard_unit_price')::numeric,
        canonical_default_unit = v_price->>'canonical_default_unit',
        standard_unit_price = (v_price->>'standard_unit_price')::numeric,
        standard_price_id = (v_price->>'price_id')::uuid,
        material_resolution_status = 'resolved_exact',
        material_resolution_request_id = v_request_id
    where f.id = p_source_line_id;
  end if;

  return jsonb_build_object('status','resolved_exact','resolved_exact',true,'material_id',v_material_id,'request_id',v_request_id,'blockers','[]'::jsonb) || v_price || jsonb_build_object('zero_cost_standard_cost_approved', p_zero_cost_approved);
end;
$$;

create or replace function public.assert_sku_cogs_materials_ready(
  p_formulations jsonb,
  p_effective_from date default current_date,
  p_zero_cost_approved boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  v_res jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_idx int := 0;
begin
  if jsonb_typeof(coalesce(p_formulations, '[]'::jsonb)) <> 'array' then
    raise exception 'Danh sách NVL không hợp lệ' using errcode='22023';
  end if;
  for item in select value from jsonb_array_elements(coalesce(p_formulations, '[]'::jsonb)) loop
    v_idx := v_idx + 1;
    v_res := public.apply_sku_cogs_material_resolution(
      null,
      coalesce(item->>'raw_ocr_name', item->>'ingredient_name'),
      item->>'material_code',
      coalesce(item->>'unit', item->>'canonical_default_unit'),
      p_effective_from,
      p_zero_cost_approved or coalesce((item->>'zeroCostApproval')::boolean, false),
      'Task7 COGS readiness preflight'
    );
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('row', v_idx, 'result', v_res));
    if coalesce((v_res->>'resolved_exact')::boolean, false) is not true then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('row', v_idx, 'blockers', coalesce(v_res->'blockers', jsonb_build_array('material_resolution_required')), 'request_id', v_res->>'request_id'));
    end if;
  end loop;
  return jsonb_build_object('ready', jsonb_array_length(v_blockers) = 0, 'status', case when jsonb_array_length(v_blockers)=0 then 'ready' else 'blocked' end, 'blockers', v_blockers, 'rows', v_rows);
end;
$$;

create or replace function public.trg_guard_sku_cogs_material_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('material_master.sku_cogs_save', true), '') = '' then
    raise exception 'direct sku cogs material mutation is not allowed' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_sku_cogs_material_mutation on public.sku_formulations;
create trigger trg_guard_sku_cogs_material_mutation
before insert or update or delete on public.sku_formulations
for each row execute function public.trg_guard_sku_cogs_material_mutation();

create or replace function public.trg_guard_product_sku_cogs_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.sku_cogs_versions v where v.sku_id = old.id) then
      raise exception 'direct product sku cogs mutation is not allowed' using errcode = '42501';
    end if;
    return old;
  end if;
  if coalesce(current_setting('material_master.sku_cogs_save', true), '') = '' then
    if coalesce(old.sku_type::text, '') = 'finished_good'
       or coalesce(new.sku_type::text, '') = 'finished_good'
       or exists (select 1 from public.sku_cogs_versions v where v.sku_id = old.id) then
      raise exception 'direct product sku cogs mutation is not allowed' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_product_sku_cogs_mutation on public.product_skus;
create trigger trg_guard_product_sku_cogs_mutation
before update of sku_code, product_name, unit, category, base_unit, cost_values, cost_widgets, cost_template, finished_output_qty, finished_output_unit, sku_type
on public.product_skus
for each row execute function public.trg_guard_product_sku_cogs_mutation();

drop trigger if exists trg_guard_product_sku_cogs_delete on public.product_skus;
create trigger trg_guard_product_sku_cogs_delete
before delete on public.product_skus
for each row execute function public.trg_guard_product_sku_cogs_mutation();

create or replace function public.save_sku_cogs(
  p_sku_id uuid,
  p_sku_updates jsonb,
  p_formulations jsonb,
  p_effective_from date default current_date,
  p_change_reason text default 'Cập nhật SKU COGS'
)
returns table(saved_sku_id uuid, version_id uuid, version_no integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  target_sku_id uuid := p_sku_id;
  next_version integer;
  new_version_id uuid;
  current_version_id uuid;
  current_effective_from date;
  item jsonb;
  inserted_id uuid;
  v_ready jsonb;
  v_apply jsonb;
  v_snapshot jsonb;
begin
  if actor_id is null or not (public.has_role(actor_id, 'owner') or public.has_role(actor_id, 'staff') or public.has_role(actor_id, 'warehouse')) then
    raise exception 'Không có quyền cập nhật SKU COGS' using errcode = '42501';
  end if;
  if p_effective_from is null then raise exception 'Ngày hiệu lực COGS là bắt buộc' using errcode = '22023'; end if;
  if nullif(btrim(p_sku_updates->>'sku_code'), '') is null or nullif(btrim(p_sku_updates->>'product_name'), '') is null then
    raise exception 'Mã SKU và tên sản phẩm là bắt buộc' using errcode = '22023';
  end if;

  v_ready := public.assert_sku_cogs_materials_ready(p_formulations, p_effective_from, coalesce((p_sku_updates->>'zeroCostApproval')::boolean, false));
  if coalesce((v_ready->>'ready')::boolean, false) is not true then
    raise exception 'sku_cogs_material_blocked_before_publish: %', v_ready using errcode='23514', hint='material_resolution_required';
  end if;

  perform set_config('material_master.sku_cogs_save', 'save_sku_cogs', true);

  if target_sku_id is null then
    insert into public.product_skus (sku_code, product_name, unit, category, base_unit, finished_output_qty, finished_output_unit, cost_template, cost_values, cost_widgets, hide_from_dealer_portal, sku_type, created_by)
    values (btrim(p_sku_updates->>'sku_code'), btrim(p_sku_updates->>'product_name'), nullif(p_sku_updates->>'unit',''), coalesce(nullif(p_sku_updates->>'category',''),'Thành phẩm'), nullif(p_sku_updates->>'base_unit',''), coalesce((p_sku_updates->>'finished_output_qty')::numeric,1), nullif(p_sku_updates->>'finished_output_unit',''), p_sku_updates->'cost_template', p_sku_updates->'cost_values', p_sku_updates->'cost_widgets', coalesce((p_sku_updates->>'hide_from_dealer_portal')::boolean,false), 'finished_good', actor_id)
    returning id into target_sku_id;
  else
    perform 1 from public.product_skus where id = target_sku_id for update;
    if not found then raise exception 'SKU không tồn tại' using errcode='P0002'; end if;
  end if;

  select id, effective_from into current_version_id, current_effective_from
  from public.sku_cogs_versions where sku_id = target_sku_id and effective_to is null for update;
  if current_version_id is not null then
    if p_effective_from <= current_effective_from then
      raise exception 'Ngày hiệu lực mới phải sau ngày bắt đầu phiên bản hiện tại (%)', current_effective_from using errcode='22023', hint='SKU_COGS_EFFECTIVE_DATE_NOT_FORWARD';
    end if;
    update public.sku_cogs_versions set effective_to = p_effective_from - 1 where id = current_version_id;
  end if;

  update public.product_skus
  set sku_code = coalesce(nullif(p_sku_updates->>'sku_code', ''), sku_code),
      product_name = coalesce(nullif(p_sku_updates->>'product_name', ''), product_name),
      unit = coalesce(nullif(p_sku_updates->>'unit', ''), unit),
      category = coalesce(nullif(p_sku_updates->>'category', ''), category),
      base_unit = coalesce(nullif(p_sku_updates->>'base_unit', ''), base_unit),
      finished_output_qty = coalesce((p_sku_updates->>'finished_output_qty')::numeric, finished_output_qty),
      finished_output_unit = coalesce(nullif(p_sku_updates->>'finished_output_unit', ''), finished_output_unit),
      cost_template = coalesce(p_sku_updates->'cost_template', cost_template),
      cost_values = coalesce(p_sku_updates->'cost_values', cost_values),
      cost_widgets = coalesce(p_sku_updates->'cost_widgets', cost_widgets),
      hide_from_dealer_portal = coalesce((p_sku_updates->>'hide_from_dealer_portal')::boolean, hide_from_dealer_portal),
      sku_type = 'finished_good', updated_at = now()
  where id = target_sku_id;

  perform set_config('material_master.sku_cogs_save', 'delete-replace', true);
  delete from public.sku_formulations where sku_id = target_sku_id;

  for item in select value from jsonb_array_elements(coalesce(p_formulations, '[]'::jsonb)) loop
    v_apply := public.apply_sku_cogs_material_resolution(null, coalesce(item->>'raw_ocr_name', item->>'ingredient_name'), item->>'material_code', coalesce(item->>'unit', item->>'canonical_default_unit'), p_effective_from, coalesce((p_sku_updates->>'zeroCostApproval')::boolean, false) or coalesce((item->>'zeroCostApproval')::boolean, false), 'Task7 COGS save exact approved canonical material');
    if coalesce((v_apply->>'resolved_exact')::boolean, false) is not true then
      raise exception 'sku_cogs_material_blocked_before_publish: %', v_apply using errcode='23514', hint='material_resolution_required';
    end if;
    perform set_config('material_master.sku_cogs_save', coalesce(v_apply->>'request_id', 'insert'), true);
    insert into public.sku_formulations (sku_id, canonical_material_id, ingredient_name, raw_ocr_name, material_code, unit, unit_price, dosage_qty, wastage_percent, sort_order, effective_from, material_resolution_status, material_resolution_request_id, canonical_default_unit, standard_unit_price, standard_price_id)
    values (target_sku_id, (v_apply->>'material_id')::uuid, v_apply->>'canonical_material_name', nullif(item->>'raw_ocr_name',''), v_apply->>'canonical_material_code', v_apply->>'canonical_default_unit', (v_apply->>'standard_unit_price')::numeric, coalesce((item->>'dosage_qty')::numeric,0) * coalesce((v_apply->>'input_to_default_factor')::numeric, 1), coalesce((item->>'wastage_percent')::numeric,0), coalesce((item->>'sort_order')::integer,0), p_effective_from, 'resolved_exact', nullif(v_apply->>'request_id','')::uuid, v_apply->>'canonical_default_unit', (v_apply->>'standard_unit_price')::numeric, (v_apply->>'price_id')::uuid)
    returning id into inserted_id;
  end loop;

  select coalesce(max(v.version_no), 0) + 1 into next_version from public.sku_cogs_versions v where v.sku_id = target_sku_id;
  insert into public.sku_cogs_versions (sku_id, version_no, effective_from, effective_to, change_reason, product_snapshot, changed_by)
  select target_sku_id, next_version, p_effective_from, null, coalesce(nullif(btrim(p_change_reason), ''), 'Cập nhật SKU COGS'), to_jsonb(ps), actor_id
  from public.product_skus ps where ps.id = target_sku_id
  returning id into new_version_id;

  insert into public.sku_cogs_version_formulations (version_id, source_formulation_id, canonical_material_id, ingredient_sku_id, ingredient_name, raw_ocr_name, material_code, unit, unit_price, dosage_qty, wastage_percent, sort_order, canonical_material_snapshot)
  select new_version_id, f.id, f.canonical_material_id, f.ingredient_sku_id, f.ingredient_name, f.raw_ocr_name, f.material_code, f.unit, f.unit_price, f.dosage_qty, f.wastage_percent, f.sort_order,
    jsonb_build_object('canonical_material_id', m.id, 'canonical_material_name', m.canonical_name, 'canonical_material_code', m.material_code, 'canonical_default_unit', m.default_unit, 'standard_unit_price', f.standard_unit_price, 'standard_price_id', f.standard_price_id, 'published_at', now())
  from public.sku_formulations f join public.sku_cogs_materials m on m.id = f.canonical_material_id
  where f.sku_id = target_sku_id;

  return query select target_sku_id, new_version_id, next_version;
end;
$$;

revoke all on function public.sku_cogs_material_price_snapshot(uuid, text, date) from public, anon, authenticated, service_role;
revoke all on function public.apply_sku_cogs_material_resolution(uuid, text, text, text, date, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.assert_sku_cogs_materials_ready(jsonb, date, boolean) from public, anon, authenticated, service_role;
revoke all on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) from public, anon, service_role;
grant execute on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) to authenticated;
revoke execute on function public.trg_guard_sku_cogs_material_mutation() from public, anon, authenticated, service_role;
revoke execute on function public.trg_guard_product_sku_cogs_mutation() from public, anon, authenticated, service_role;

comment on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) is 'Task7 server-side COGS canonical controller: sku_cogs_materials root, exact approved material/code/alias only, unit+standard_cost readiness, zero-cost explicit policy, immutable published snapshots.';
-- Inline Task7 prerequisite ends.

create temp table task9_protected_counts_before as
select (select count(*) from public.sku_cogs_materials) as sku_cogs_materials,(select count(*) from public.sku_cogs_material_aliases) as sku_cogs_material_aliases,(select count(*) from public.material_scoped_aliases) as material_scoped_aliases,(select count(*) from public.material_resolution_requests) as material_resolution_requests,(select count(*) from public.sku_formulations) as sku_formulations,(select count(*) from public.sku_cogs_versions) as sku_cogs_versions,(select count(*) from public.sku_cogs_version_formulations) as sku_cogs_version_formulations,(select count(*) from public.kitchen_inventory_items) as kitchen_inventory_items,(select count(*) from public.q7_material_issue_material_mappings) as q7_material_issue_material_mappings,(select count(*) from public.q7_inventory_movements) as q7_inventory_movements,(select count(*) from public.q7_inventory_openings) as q7_inventory_openings,(select count(*) from public.q7_inventory_opening_audit_logs) as q7_inventory_opening_audit_logs,(select count(*) from public.kitchen_inventory_movements) as kitchen_inventory_movements;

-- Inline Task9 migration begins.
-- Task 9: additive material-master shadow rollout dashboard.
-- Read-only rollout status only: no historical backfill, merge, rewrite, or hard
-- enforcement. Canonical root remains public.sku_cogs_materials. Fuzzy/AI
-- candidates remain pending human approval.

insert into public.material_master_enforcement_config (source_type, mode)
values ('kitchen_inventory', 'shadow')
on conflict (source_type) do nothing;

create or replace view public.material_master_shadow_rollout_dashboard as
with configured_sources as (
  select cfg.source_type, cfg.mode, cfg.updated_at as mode_updated_at
  from public.material_master_enforcement_config cfg
), request_agg as (
  select
    lower(btrim(r.source_type)) as source_type,
    count(*)::bigint as queue_total_count,
    count(*) filter (where r.status = 'pending')::bigint as queue_pending_count,
    count(*) filter (where r.status in ('resolved_existing', 'created_new'))::bigint as queue_resolved_count,
    count(*) filter (where r.status = 'rejected')::bigint as queue_blocked_count,
    min(r.created_at) filter (where r.status = 'pending') as oldest_queue_created_at,
    max(r.created_at) as latest_queue_created_at,
    jsonb_build_object(
      'pending', count(*) filter (where r.status = 'pending'),
      'confirmation_needed', count(*) filter (where r.status = 'pending' and r.candidate_status = 'confirmation_needed'),
      'ambiguous', count(*) filter (where r.status = 'pending' and r.candidate_status = 'ambiguous'),
      'not_found', count(*) filter (where r.status = 'pending' and r.candidate_status = 'not_found'),
      'inactive', 0,
      'unit_unmapped', 0,
      'supplier_unmapped', 0,
      'controller_error', count(*) filter (where r.status = 'pending' and r.candidate_status is null),
      'resolved_exact', count(*) filter (where r.status in ('resolved_existing', 'created_new')),
      'rejected', count(*) filter (where r.status = 'rejected')
    ) as queue_buckets
  from public.material_resolution_requests r
  group by lower(btrim(r.source_type))
), kitchen_operational as (
  select
    'kitchen_inventory'::text as source_type,
    count(*)::bigint as evaluated_active_count,
    count(*) filter (where kii.canonical_material_id is null)::bigint as missing_canonical_material_id,
    count(*) filter (
      where kii.canonical_material_id is not null
        and (
          coalesce(kii.material_resolution_status, '') <> 'linked'
          or scm.active is not true
          or (select count(*)
              from public.q7_material_issue_material_mappings m
              where m.approval_status = 'approved'
                and m.kitchen_inventory_item_id = kii.id
                and m.canonical_material_id = kii.canonical_material_id
                and lower(btrim(m.kitchen_unit)) = lower(btrim(kii.unit))) <> 1
        )
    )::bigint as missing_exact_approved_link,
    count(*) filter (
      where kii.canonical_material_id is not null
        and kii.material_resolution_status = 'linked'
        and scm.active is true
        and (select count(*)
             from public.q7_material_issue_material_mappings m
             where m.approval_status = 'approved'
               and m.kitchen_inventory_item_id = kii.id
               and m.canonical_material_id = kii.canonical_material_id
               and lower(btrim(m.kitchen_unit)) = lower(btrim(kii.unit))) = 1
    )::bigint as resolved_exact_operational
  from public.kitchen_inventory_items kii
  left join public.sku_cogs_materials scm on scm.id = kii.canonical_material_id
  where kii.active = true
), sku_operational as (
  select
    'sku_cogs'::text as source_type,
    count(*)::bigint as evaluated_active_count,
    count(*) filter (where f.canonical_material_id is null)::bigint as missing_canonical_material_id,
    count(*) filter (
      where f.canonical_material_id is not null
        and (coalesce(f.material_resolution_status, '') <> 'resolved_exact' or scm.active is not true)
    )::bigint as missing_exact_approved_link,
    count(*) filter (
      where f.canonical_material_id is not null
        and f.material_resolution_status = 'resolved_exact'
        and scm.active is true
    )::bigint as resolved_exact_operational
  from public.sku_formulations f
  left join public.sku_cogs_materials scm on scm.id = f.canonical_material_id
), operational as (
  select * from kitchen_operational
  union all
  select * from sku_operational
), rollout as (
  select
    cfg.source_type,
    cfg.mode,
    coalesce(req.queue_total_count, 0)::bigint as queue_total_count,
    coalesce(req.queue_pending_count, 0)::bigint as queue_pending_count,
    coalesce(req.queue_resolved_count, 0)::bigint as queue_resolved_count,
    coalesce(req.queue_blocked_count, 0)::bigint as queue_blocked_count,
    req.oldest_queue_created_at,
    req.latest_queue_created_at,
    coalesce(req.queue_buckets, jsonb_build_object(
      'pending', 0, 'confirmation_needed', 0, 'ambiguous', 0,
      'not_found', 0, 'inactive', 0, 'unit_unmapped', 0,
      'supplier_unmapped', 0, 'controller_error', 0,
      'resolved_exact', 0, 'rejected', 0
    )) || jsonb_build_object(
      'resolved_exact_operational', coalesce(op.resolved_exact_operational, 0),
      'missing_canonical_material_id', coalesce(op.missing_canonical_material_id, 0),
      'missing_exact_approved_link', coalesce(op.missing_exact_approved_link, 0)
    ) as queue_buckets,
    coalesce(op.evaluated_active_count, 0) + coalesce(req.queue_total_count, 0) as evaluated_count,
    coalesce(op.missing_canonical_material_id, 0) as missing_canonical_material_id,
    coalesce(op.missing_exact_approved_link, 0) as missing_exact_approved_link,
    cfg.mode_updated_at
  from configured_sources cfg
  left join request_agg req on req.source_type = cfg.source_type
  left join operational op on op.source_type = cfg.source_type
)
select
  source_type,
  mode,
  queue_total_count,
  queue_pending_count,
  queue_resolved_count,
  queue_blocked_count,
  queue_buckets,
  oldest_queue_created_at,
  latest_queue_created_at,
  case
    when mode = 'disabled' then false
    when evaluated_count = 0 then false
    when queue_pending_count = 0
      and queue_blocked_count = 0
      and missing_canonical_material_id = 0
      and missing_exact_approved_link = 0 then true
    else false
  end as ready_for_enforcement,
  (case when mode = 'disabled' then jsonb_build_array('source_disabled') else '[]'::jsonb end
   || case when evaluated_count = 0 then jsonb_build_array('no_evaluation_evidence') else '[]'::jsonb end
   || case when queue_pending_count > 0 then jsonb_build_array('pending_resolution_queue') else '[]'::jsonb end
   || case when queue_blocked_count > 0 then jsonb_build_array('rejected_resolution_queue') else '[]'::jsonb end
   || case when missing_canonical_material_id > 0 then jsonb_build_array('missing_canonical_material_id') else '[]'::jsonb end
   || case when missing_exact_approved_link > 0 then jsonb_build_array('missing_exact_approved_link') else '[]'::jsonb end) as blockers,
  mode_updated_at
from rollout;

comment on view public.material_master_shadow_rollout_dashboard is
  'Task9 read-only fail-closed rollout dashboard. Exact approved links only; fuzzy/AI candidates remain pending human approval.';

revoke all on public.material_master_shadow_rollout_dashboard from public, anon, authenticated, service_role;

create or replace function public.get_material_master_rollout_dashboard()
returns table (
  source_type text,
  mode text,
  queue_total_count bigint,
  queue_pending_count bigint,
  queue_resolved_count bigint,
  queue_blocked_count bigint,
  queue_buckets jsonb,
  oldest_queue_created_at timestamptz,
  latest_queue_created_at timestamptz,
  ready_for_enforcement boolean,
  blockers jsonb,
  mode_updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_view_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select d.source_type, d.mode, d.queue_total_count, d.queue_pending_count,
         d.queue_resolved_count, d.queue_blocked_count, d.queue_buckets,
         d.oldest_queue_created_at, d.latest_queue_created_at,
         d.ready_for_enforcement, d.blockers, d.mode_updated_at
  from public.material_master_shadow_rollout_dashboard d
  order by d.source_type;
end;
$$;

revoke all on function public.get_material_master_rollout_dashboard() from public, anon, authenticated, service_role;
grant execute on function public.get_material_master_rollout_dashboard() to authenticated, service_role;
-- Inline Task9 migration ends.

do $$ begin
  if to_regprocedure('public.get_material_master_rollout_dashboard()') is null then raise exception 'missing get_material_master_rollout_dashboard signature'; end if;
  if has_function_privilege('anon', 'public.get_material_master_rollout_dashboard()', 'execute') then raise exception 'anon must not execute rollout dashboard'; end if;
  if not has_function_privilege('authenticated', 'public.get_material_master_rollout_dashboard()', 'execute') then raise exception 'authenticated rollout dashboard execute missing'; end if;
  if exists (select 1 from public.material_master_enforcement_config where source_type = 'q7') then raise exception 'competing q7 source_type must not exist'; end if;
end; $$;

do $$
begin
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);
  begin
    perform public.get_material_master_rollout_dashboard();
    raise exception 'rollout_dashboard_permission_denial was not enforced';
  exception
    when insufficient_privilege then null;
  end;
end; $$;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

select 'task9_shadow_rollout_config_rollback' as marker;
insert into public.material_master_enforcement_config(source_type, mode) values ('task9_shadow_rollout_config_rollback', 'shadow') on conflict (source_type) do nothing;
update public.material_master_enforcement_config set mode = 'disabled', updated_at = now() where source_type = 'task9_shadow_rollout_config_rollback';

select 'synthetic pending queue rows' as marker;
insert into public.material_resolution_requests(request_key, source_type, source_table, source_line_id, raw_name, raw_code, raw_unit, normalized_name, status, candidate_status, safe_payload) values
(repeat('a',64), 'kitchen_inventory', 'kitchen_inventory_items', '00000000-0000-0000-0000-000000000901', 'Task9 pending material', 'T9-PEND', 'kg', public.material_master_normalize('Task9 pending material'), 'pending', 'not_found', jsonb_build_object('candidate_source','fixture','confidence','pending','field_name','canonical_material_id')),
(repeat('b',64), 'kitchen_inventory', 'kitchen_inventory_items', '00000000-0000-0000-0000-000000000902', 'Task9 ambiguous material', 'T9-AMB', 'kg', public.material_master_normalize('Task9 ambiguous material'), 'pending', 'ambiguous', jsonb_build_object('candidate_source','fixture','confidence','pending','field_name','canonical_material_id'));

do $$
declare v_row record;
begin
  select * into v_row from public.get_material_master_rollout_dashboard() where source_type='kitchen_inventory';
  if v_row.ready_for_enforcement is true then raise exception 'pending synthetic queue should block readiness'; end if;
  if not (v_row.blockers ? 'pending_resolution_queue') then raise exception 'pending_resolution_queue blocker missing: %', v_row.blockers; end if;
  if coalesce((v_row.queue_buckets->>'not_found')::int,0)<1 or coalesce((v_row.queue_buckets->>'ambiguous')::int,0)<1 then raise exception 'synthetic pending buckets missing: %', v_row.queue_buckets; end if;
  if v_row.queue_total_count < 2 or v_row.queue_pending_count < 2 then raise exception 'synthetic queue counts missing: %', row_to_json(v_row); end if;
end; $$;

delete from public.material_resolution_requests where request_key in (repeat('a',64), repeat('b',64));
do $$
begin
  if exists (select 1 from public.material_resolution_requests where request_key in (repeat('a',64), repeat('b',64))) then
    raise exception 'synthetic_queue_residue_absent assertion failed';
  end if;
end; $$;
select 'protected_table_counts_unchanged' as marker;
do $$ declare before_row record; after_row record; begin select * into before_row from task9_protected_counts_before; select (select count(*) from public.sku_cogs_materials) as sku_cogs_materials,(select count(*) from public.sku_cogs_material_aliases) as sku_cogs_material_aliases,(select count(*) from public.material_scoped_aliases) as material_scoped_aliases,(select count(*) from public.material_resolution_requests) as material_resolution_requests,(select count(*) from public.sku_formulations) as sku_formulations,(select count(*) from public.sku_cogs_versions) as sku_cogs_versions,(select count(*) from public.sku_cogs_version_formulations) as sku_cogs_version_formulations,(select count(*) from public.kitchen_inventory_items) as kitchen_inventory_items,(select count(*) from public.q7_material_issue_material_mappings) as q7_material_issue_material_mappings,(select count(*) from public.q7_inventory_movements) as q7_inventory_movements,(select count(*) from public.q7_inventory_openings) as q7_inventory_openings,(select count(*) from public.q7_inventory_opening_audit_logs) as q7_inventory_opening_audit_logs,(select count(*) from public.kitchen_inventory_movements) as kitchen_inventory_movements into after_row; if to_jsonb(before_row) <> to_jsonb(after_row) then raise exception 'protected table counts changed: before %, after %', to_jsonb(before_row), to_jsonb(after_row); end if; end; $$;

rollback;

select 'post_rollback_zero_residue' as marker,
       to_regclass('public.material_master_enforcement_config') as config_relation_after_rollback,
       to_regclass('public.material_resolution_requests') as queue_relation_after_rollback;
