-- Finance reconciliation module (daily + monthly)

create table if not exists public.cash_fund_topups (
  id uuid primary key default gen_random_uuid(),
  topup_date date not null,
  amount numeric(15,2) not null check (amount >= 0),
  slip_file_url text,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cash_fund_topups_topup_date on public.cash_fund_topups(topup_date desc);

create table if not exists public.ceo_daily_closing_declarations (
  id uuid primary key default gen_random_uuid(),
  closing_date date not null unique,
  unc_total_declared numeric(15,2) not null default 0 check (unc_total_declared >= 0),
  cash_fund_topup_amount numeric(15,2) not null default 0 check (cash_fund_topup_amount >= 0),
  topup_slip_file_url text,
  notes text,
  declared_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ceo_daily_closing_declarations_closing_date on public.ceo_daily_closing_declarations(closing_date desc);

create table if not exists public.daily_reconciliations (
  id uuid primary key default gen_random_uuid(),
  closing_date date not null unique,
  unc_detail_amount numeric(15,2) not null default 0,
  unc_declared_amount numeric(15,2) not null default 0,
  cash_fund_topup_amount numeric(15,2) not null default 0,
  variance_amount numeric(15,2) not null default 0,
  status text not null default 'pending' check (status in ('match', 'mismatch', 'pending')),
  tolerance_amount numeric(15,2) not null default 0,
  matched_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_daily_reconciliations_closing_date on public.daily_reconciliations(closing_date desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_cash_fund_topups_updated_at on public.cash_fund_topups;
create trigger trg_cash_fund_topups_updated_at
before update on public.cash_fund_topups
for each row execute function public.touch_updated_at();

drop trigger if exists trg_ceo_daily_closing_declarations_updated_at on public.ceo_daily_closing_declarations;
create trigger trg_ceo_daily_closing_declarations_updated_at
before update on public.ceo_daily_closing_declarations
for each row execute function public.touch_updated_at();

drop trigger if exists trg_daily_reconciliations_updated_at on public.daily_reconciliations;
create trigger trg_daily_reconciliations_updated_at
before update on public.daily_reconciliations
for each row execute function public.touch_updated_at();

alter table public.cash_fund_topups enable row level security;
alter table public.ceo_daily_closing_declarations enable row level security;
alter table public.daily_reconciliations enable row level security;

do $$ begin
  create policy "cash_fund_topups read" on public.cash_fund_topups
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "cash_fund_topups write" on public.cash_fund_topups
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "ceo_declarations read" on public.ceo_daily_closing_declarations
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "ceo_declarations write" on public.ceo_daily_closing_declarations
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "daily_reconciliations read" on public.daily_reconciliations
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "daily_reconciliations write" on public.daily_reconciliations
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
