-- OCR standard cost code foundation.
-- Phase 1 only: add nullable metadata and alias storage without changing current PR/invoice behavior.

alter table public.payment_request_items
  add column if not exists raw_product_name text,
  add column if not exists suggested_standard_cost_code text,
  add column if not exists confirmed_standard_cost_code text,
  add column if not exists standard_cost_code_type text,
  add column if not exists canonical_cost_item_name text,
  add column if not exists canonical_cost_item_source text,
  add column if not exists cost_category_code text,
  add column if not exists cost_product_line text,
  add column if not exists cost_allocation_rule text,
  add column if not exists cost_review_routing text not null default 'none',
  add column if not exists unit_conversion_note text,
  add column if not exists matched_finished_skus text[],
  add column if not exists ocr_classification_json jsonb;

alter table public.invoice_items
  add column if not exists raw_product_name text,
  add column if not exists suggested_standard_cost_code text,
  add column if not exists confirmed_standard_cost_code text,
  add column if not exists standard_cost_code_type text,
  add column if not exists canonical_cost_item_name text,
  add column if not exists canonical_cost_item_source text,
  add column if not exists cost_category_code text,
  add column if not exists cost_product_line text,
  add column if not exists cost_allocation_rule text,
  add column if not exists cost_review_routing text not null default 'none',
  add column if not exists unit_conversion_note text,
  add column if not exists matched_finished_skus text[],
  add column if not exists ocr_classification_json jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_request_items_standard_cost_code_type_check'
      and conrelid = 'public.payment_request_items'::regclass
  ) then
    alter table public.payment_request_items
      add constraint payment_request_items_standard_cost_code_type_check
      check (standard_cost_code_type is null or standard_cost_code_type in ('NVL', 'OPEX', 'OTHER'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_request_items_cost_product_line_check'
      and conrelid = 'public.payment_request_items'::regclass
  ) then
    alter table public.payment_request_items
      add constraint payment_request_items_cost_product_line_check
      check (cost_product_line is null or cost_product_line in ('bmq_bread', 'sweet_kitchen', 'shared', 'general'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_request_items_cost_allocation_rule_check'
      and conrelid = 'public.payment_request_items'::regclass
  ) then
    alter table public.payment_request_items
      add constraint payment_request_items_cost_allocation_rule_check
      check (cost_allocation_rule is null or cost_allocation_rule in ('direct', 'manual', 'none'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_request_items_cost_review_routing_check'
      and conrelid = 'public.payment_request_items'::regclass
  ) then
    alter table public.payment_request_items
      add constraint payment_request_items_cost_review_routing_check
      check (cost_review_routing in ('none', 'needs_review'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_request_items_cost_category_code_fkey'
      and conrelid = 'public.payment_request_items'::regclass
  ) then
    alter table public.payment_request_items
      add constraint payment_request_items_cost_category_code_fkey
      foreign key (cost_category_code) references public.cost_categories(code);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'invoice_items_standard_cost_code_type_check'
      and conrelid = 'public.invoice_items'::regclass
  ) then
    alter table public.invoice_items
      add constraint invoice_items_standard_cost_code_type_check
      check (standard_cost_code_type is null or standard_cost_code_type in ('NVL', 'OPEX', 'OTHER'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'invoice_items_cost_product_line_check'
      and conrelid = 'public.invoice_items'::regclass
  ) then
    alter table public.invoice_items
      add constraint invoice_items_cost_product_line_check
      check (cost_product_line is null or cost_product_line in ('bmq_bread', 'sweet_kitchen', 'shared', 'general'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'invoice_items_cost_allocation_rule_check'
      and conrelid = 'public.invoice_items'::regclass
  ) then
    alter table public.invoice_items
      add constraint invoice_items_cost_allocation_rule_check
      check (cost_allocation_rule is null or cost_allocation_rule in ('direct', 'manual', 'none'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'invoice_items_cost_review_routing_check'
      and conrelid = 'public.invoice_items'::regclass
  ) then
    alter table public.invoice_items
      add constraint invoice_items_cost_review_routing_check
      check (cost_review_routing in ('none', 'needs_review'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'invoice_items_cost_category_code_fkey'
      and conrelid = 'public.invoice_items'::regclass
  ) then
    alter table public.invoice_items
      add constraint invoice_items_cost_category_code_fkey
      foreign key (cost_category_code) references public.cost_categories(code);
  end if;
end $$;

create table if not exists public.cost_item_alias_mappings (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_name_key text not null,
  supplier_id uuid references public.suppliers(id),
  standard_cost_code_type text not null check (standard_cost_code_type in ('NVL', 'OPEX', 'OTHER')),
  standard_cost_code text not null,
  canonical_cost_item_name text not null,
  category_code text not null references public.cost_categories(code),
  product_line text not null default 'general' check (product_line in ('bmq_bread', 'sweet_kitchen', 'shared', 'general')),
  allocation_rule text not null default 'none' check (allocation_rule in ('direct', 'manual', 'none')),
  unit_conversion_note text,
  matched_finished_skus text[],
  source_sheet_url text,
  source_review_note text,
  mapping_status text not null default 'approved' check (mapping_status in ('approved', 'needs_review', 'inactive')),
  active boolean not null default true,
  effective_from date,
  effective_to date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cost_item_alias_mappings_source_name_key_nonempty
    check (length(btrim(source_name_key)) > 0),
  constraint cost_item_alias_mappings_standard_code_nonempty
    check (length(btrim(standard_cost_code)) > 0),
  constraint cost_item_alias_mappings_effective_window_check
    check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

create unique index if not exists cost_item_alias_mappings_unique_active_idx
  on public.cost_item_alias_mappings (
    source_name_key,
    coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
    standard_cost_code_type,
    standard_cost_code
  )
  where active;

create index if not exists cost_item_alias_mappings_lookup_idx
  on public.cost_item_alias_mappings (active, mapping_status, source_name_key);

create index if not exists cost_item_alias_mappings_standard_code_idx
  on public.cost_item_alias_mappings (standard_cost_code_type, standard_cost_code)
  where active;

create index if not exists cost_item_alias_mappings_category_idx
  on public.cost_item_alias_mappings (category_code, product_line, allocation_rule)
  where active;

drop trigger if exists trg_touch_cost_item_alias_mappings on public.cost_item_alias_mappings;
create trigger trg_touch_cost_item_alias_mappings
  before update on public.cost_item_alias_mappings
  for each row execute function public.touch_cost_classification_updated_at();

alter table public.cost_item_alias_mappings enable row level security;

drop policy if exists "finance_cost_select_cost_item_alias_mappings" on public.cost_item_alias_mappings;
create policy "finance_cost_select_cost_item_alias_mappings"
  on public.cost_item_alias_mappings for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'view')
  );

drop policy if exists "finance_cost_edit_cost_item_alias_mappings" on public.cost_item_alias_mappings;
create policy "finance_cost_edit_cost_item_alias_mappings"
  on public.cost_item_alias_mappings for all to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'edit')
  );

grant select on public.cost_item_alias_mappings to authenticated;
grant insert, update on public.cost_item_alias_mappings to authenticated;
