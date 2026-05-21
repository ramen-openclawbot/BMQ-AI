-- Dealer ordering portal foundation.
-- Phone numbers intentionally live in dealer_customer_contacts because
-- mini_crm_customers has no phone column.

create table if not exists public.dealer_customer_contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  contact_name text,
  phone_raw text,
  phone_normalized text not null,
  zalo_user_id text,
  is_primary boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dealer_customer_contacts_phone_normalized_check
    check (phone_normalized ~ '^84(3|5|7|8|9)[0-9]{8}$')
);

create index if not exists dealer_customer_contacts_customer_idx
  on public.dealer_customer_contacts(customer_id);

create index if not exists dealer_customer_contacts_phone_idx
  on public.dealer_customer_contacts(phone_normalized);

create unique index if not exists dealer_customer_contacts_active_phone_unique
  on public.dealer_customer_contacts(phone_normalized)
  where is_active = true;

create unique index if not exists dealer_customer_contacts_primary_unique
  on public.dealer_customer_contacts(customer_id)
  where is_primary = true and is_active = true;

create table if not exists public.dealer_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  contact_id uuid not null references public.dealer_customer_contacts(id) on delete cascade,
  phone_normalized text not null,
  otp_hash text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  sent_at timestamptz,
  send_provider text,
  send_status text not null default 'pending',
  send_error text,
  request_ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  constraint dealer_otp_challenges_attempts_check check (attempts >= 0),
  constraint dealer_otp_challenges_max_attempts_check check (max_attempts between 1 and 20),
  constraint dealer_otp_challenges_phone_normalized_check
    check (phone_normalized ~ '^84(3|5|7|8|9)[0-9]{8}$')
);

create index if not exists dealer_otp_challenges_phone_active_idx
  on public.dealer_otp_challenges(phone_normalized, created_at desc)
  where consumed_at is null;

create index if not exists dealer_otp_challenges_expires_idx
  on public.dealer_otp_challenges(expires_at);

create index if not exists dealer_otp_challenges_customer_idx
  on public.dealer_otp_challenges(customer_id);

create table if not exists public.dealer_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  contact_id uuid not null references public.dealer_customer_contacts(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  request_ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists dealer_sessions_customer_idx
  on public.dealer_sessions(customer_id);

create index if not exists dealer_sessions_active_idx
  on public.dealer_sessions(expires_at)
  where revoked_at is null;

create table if not exists public.dealer_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  severity text not null default 'info',
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dealer_announcements_severity_check
    check (severity in ('info', 'success', 'warning', 'critical'))
);

create index if not exists dealer_announcements_active_idx
  on public.dealer_announcements(is_active, starts_at, ends_at);

create table if not exists public.dealer_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references public.mini_crm_customers(id) on delete restrict,
  contact_id uuid references public.dealer_customer_contacts(id) on delete set null,
  session_id uuid references public.dealer_sessions(id) on delete set null,
  status text not null default 'submitted',
  currency text not null default 'VND',
  subtotal_amount_vnd numeric(14,2) not null default 0,
  total_amount_vnd numeric(14,2) not null default 0,
  requested_delivery_date date,
  delivery_note text,
  customer_note text,
  customer_snapshot jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dealer_orders_status_check
    check (status in ('submitted', 'confirmed', 'fulfilled', 'cancelled')),
  constraint dealer_orders_amounts_check
    check (subtotal_amount_vnd >= 0 and total_amount_vnd >= 0)
);

create index if not exists dealer_orders_customer_created_idx
  on public.dealer_orders(customer_id, created_at desc);

create index if not exists dealer_orders_status_created_idx
  on public.dealer_orders(status, created_at desc);

create table if not exists public.dealer_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.dealer_orders(id) on delete cascade,
  sku_id uuid not null references public.product_skus(id) on delete restrict,
  sku_code text not null,
  product_name text not null,
  unit text,
  quantity numeric(12,3) not null,
  unit_price_vnd numeric(14,2) not null,
  line_total_vnd numeric(14,2) not null,
  price_source text not null default 'sku_unit_price',
  created_at timestamptz not null default now(),
  constraint dealer_order_items_quantity_check check (quantity > 0),
  constraint dealer_order_items_amounts_check check (unit_price_vnd >= 0 and line_total_vnd >= 0),
  constraint dealer_order_items_price_source_check
    check (price_source in ('sku_unit_price', 'customer_override'))
);

create index if not exists dealer_order_items_order_idx
  on public.dealer_order_items(order_id);

create index if not exists dealer_order_items_sku_idx
  on public.dealer_order_items(sku_id);

create or replace function public.set_dealer_portal_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_dealer_customer_contacts_updated_at on public.dealer_customer_contacts;
create trigger set_dealer_customer_contacts_updated_at
before update on public.dealer_customer_contacts
for each row execute function public.set_dealer_portal_updated_at();

drop trigger if exists set_dealer_announcements_updated_at on public.dealer_announcements;
create trigger set_dealer_announcements_updated_at
before update on public.dealer_announcements
for each row execute function public.set_dealer_portal_updated_at();

drop trigger if exists set_dealer_orders_updated_at on public.dealer_orders;
create trigger set_dealer_orders_updated_at
before update on public.dealer_orders
for each row execute function public.set_dealer_portal_updated_at();

alter table public.dealer_customer_contacts enable row level security;
alter table public.dealer_otp_challenges enable row level security;
alter table public.dealer_sessions enable row level security;
alter table public.dealer_announcements enable row level security;
alter table public.dealer_orders enable row level security;
alter table public.dealer_order_items enable row level security;

-- Staff/ops table management stays inside authenticated BMQ roles.
-- Public dealer writes go through service-role Edge Functions only.
create or replace function public.can_manage_dealer_portal()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_role(auth.uid(), 'owner'::app_role)
    or has_role(auth.uid(), 'staff'::app_role)
    or has_role(auth.uid(), 'warehouse'::app_role);
$$;

drop policy if exists dealer_customer_contacts_ops_read on public.dealer_customer_contacts;
create policy dealer_customer_contacts_ops_read
  on public.dealer_customer_contacts for select to authenticated using (true);

drop policy if exists dealer_customer_contacts_ops_write on public.dealer_customer_contacts;
create policy dealer_customer_contacts_ops_write
  on public.dealer_customer_contacts for all to authenticated
  using (public.can_manage_dealer_portal())
  with check (public.can_manage_dealer_portal());

drop policy if exists dealer_announcements_ops_read on public.dealer_announcements;
create policy dealer_announcements_ops_read
  on public.dealer_announcements for select to authenticated using (true);

drop policy if exists dealer_announcements_ops_write on public.dealer_announcements;
create policy dealer_announcements_ops_write
  on public.dealer_announcements for all to authenticated
  using (public.can_manage_dealer_portal())
  with check (public.can_manage_dealer_portal());

drop policy if exists dealer_orders_ops_read on public.dealer_orders;
create policy dealer_orders_ops_read
  on public.dealer_orders for select to authenticated using (true);

drop policy if exists dealer_orders_ops_write on public.dealer_orders;
create policy dealer_orders_ops_write
  on public.dealer_orders for all to authenticated
  using (public.can_manage_dealer_portal())
  with check (public.can_manage_dealer_portal());

drop policy if exists dealer_order_items_ops_read on public.dealer_order_items;
create policy dealer_order_items_ops_read
  on public.dealer_order_items for select to authenticated using (true);

drop policy if exists dealer_order_items_ops_write on public.dealer_order_items;
create policy dealer_order_items_ops_write
  on public.dealer_order_items for all to authenticated
  using (public.can_manage_dealer_portal())
  with check (public.can_manage_dealer_portal());

-- OTP challenges and dealer sessions intentionally have no client policies.
-- They are accessible through service-role Edge Functions only.

insert into public.dealer_announcements (title, body, severity, starts_at, is_active)
select
  'Thông báo đặt hàng',
  'Portal đặt hàng đại lý BMQ đang chạy thử nghiệm. Vui lòng liên hệ vận hành nếu cần chỉnh đơn sau khi gửi.',
  'info',
  now(),
  true
where not exists (
  select 1 from public.dealer_announcements where title = 'Thông báo đặt hàng'
);
