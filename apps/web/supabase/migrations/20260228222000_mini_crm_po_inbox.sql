-- Phase 4: mini-CRM + PO inbox (Gmail po@bmq.vn)

create table if not exists public.mini_crm_customers (
  id uuid primary key default gen_random_uuid(),
  customer_code text,
  customer_name text not null,
  customer_group text not null check (customer_group in ('banhmi_point','banhmi_agency','online','cake_kingfoodmart','cake_cafe')),
  default_revenue_channel text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mini_crm_customer_emails (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  email text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email)
);

create table if not exists public.customer_po_inbox (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text unique,
  gmail_thread_id text,
  from_email text not null,
  from_name text,
  email_subject text,
  body_preview text,
  has_attachments boolean not null default false,
  attachment_names text[] not null default '{}',
  received_at timestamptz not null default now(),
  matched_customer_id uuid references public.mini_crm_customers(id),
  match_status text not null default 'unmatched' check (match_status in ('matched','unmatched','pending_approval','approved','rejected','error')),
  parsed_po_number text,
  parsed_total_amount numeric(15,2),
  revenue_channel text,
  raw_payload jsonb,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_mini_crm_customers_group on public.mini_crm_customers(customer_group);
create index if not exists idx_mini_crm_customer_emails_email on public.mini_crm_customer_emails(lower(email));
create index if not exists idx_customer_po_inbox_received_at on public.customer_po_inbox(received_at desc);
create index if not exists idx_customer_po_inbox_status on public.customer_po_inbox(match_status);

-- normalize emails to lowercase
create or replace function public.normalize_email_before_write()
returns trigger
language plpgsql
as $$
begin
  if new.email is not null then
    new.email = lower(trim(new.email));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mini_crm_customer_emails_normalize on public.mini_crm_customer_emails;
create trigger trg_mini_crm_customer_emails_normalize
before insert or update on public.mini_crm_customer_emails
for each row execute function public.normalize_email_before_write();

drop trigger if exists trg_mini_crm_customers_updated_at on public.mini_crm_customers;
create trigger trg_mini_crm_customers_updated_at
before update on public.mini_crm_customers
for each row execute function public.touch_updated_at();

drop trigger if exists trg_mini_crm_customer_emails_updated_at on public.mini_crm_customer_emails;
create trigger trg_mini_crm_customer_emails_updated_at
before update on public.mini_crm_customer_emails
for each row execute function public.touch_updated_at();

drop trigger if exists trg_customer_po_inbox_updated_at on public.customer_po_inbox;
create trigger trg_customer_po_inbox_updated_at
before update on public.customer_po_inbox
for each row execute function public.touch_updated_at();

alter table public.mini_crm_customers enable row level security;
alter table public.mini_crm_customer_emails enable row level security;
alter table public.customer_po_inbox enable row level security;

do $$ begin
  create policy "mini_crm_customers read" on public.mini_crm_customers
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "mini_crm_customers write" on public.mini_crm_customers
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "mini_crm_customer_emails read" on public.mini_crm_customer_emails
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "mini_crm_customer_emails write" on public.mini_crm_customer_emails
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "customer_po_inbox read" on public.customer_po_inbox
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "customer_po_inbox write" on public.customer_po_inbox
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;