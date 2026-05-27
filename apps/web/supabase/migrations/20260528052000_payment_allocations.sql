-- Support many-to-many settlement between payment requests and actual payments.
-- Existing paid payment_requests are backfilled as one legacy payment allocation.

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  payment_number text not null unique,
  supplier_id uuid references public.suppliers(id) on delete set null,
  payment_date date not null default current_date,
  amount numeric not null check (amount > 0),
  payment_method public.payment_method_type,
  reference_number text,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete cascade,
  payment_request_id uuid not null references public.payment_requests(id) on delete cascade,
  amount numeric not null check (amount > 0),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payment_id, payment_request_id)
);

create index if not exists idx_payments_supplier_id on public.payments(supplier_id);
create index if not exists idx_payments_payment_date on public.payments(payment_date desc);
create index if not exists idx_payment_allocations_payment_id on public.payment_allocations(payment_id);
create index if not exists idx_payment_allocations_payment_request_id on public.payment_allocations(payment_request_id);

create or replace function public.next_payment_number()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_num bigint;
begin
  select coalesce(max((regexp_match(payment_number, '^PAY-([0-9]+)$'))[1]::bigint), 0) + 1
  into next_num
  from public.payments
  where payment_number ~ '^PAY-[0-9]+$';

  return 'PAY-' || lpad(next_num::text, 6, '0');
end;
$$;

create or replace function public.sync_payment_request_payment_status(p_payment_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request_total numeric;
  allocated_total numeric;
  next_status public.payment_status;
begin
  select coalesce(total_amount, 0)
  into request_total
  from public.payment_requests
  where id = p_payment_request_id;

  if not found then
    return;
  end if;

  select coalesce(sum(amount), 0)
  into allocated_total
  from public.payment_allocations
  where payment_request_id = p_payment_request_id;

  if allocated_total <= 0 then
    next_status := 'unpaid';
  elsif allocated_total < request_total then
    next_status := 'partial';
  elsif allocated_total = request_total then
    next_status := 'paid';
  else
    next_status := 'overpaid';
  end if;

  update public.payment_requests
  set
    payment_status = next_status,
    paid_at = case
      when next_status in ('paid', 'overpaid') then coalesce(paid_at, now())
      when next_status = 'unpaid' then null
      else paid_at
    end,
    updated_at = now()
  where id = p_payment_request_id;
end;
$$;

create or replace function public.sync_payment_allocation_parent_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.sync_payment_request_payment_status(new.payment_request_id);
    return new;
  end if;

  if tg_op = 'UPDATE' then
    perform public.sync_payment_request_payment_status(new.payment_request_id);
    if old.payment_request_id is distinct from new.payment_request_id then
      perform public.sync_payment_request_payment_status(old.payment_request_id);
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.sync_payment_request_payment_status(old.payment_request_id);
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_sync_payment_allocation_parent_status on public.payment_allocations;
create trigger trg_sync_payment_allocation_parent_status
after insert or update or delete on public.payment_allocations
for each row
execute function public.sync_payment_allocation_parent_status();

create or replace function public.set_payment_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_payments_updated_at on public.payments;
create trigger trg_payments_updated_at
before update on public.payments
for each row
execute function public.set_payment_updated_at();

drop trigger if exists trg_payment_allocations_updated_at on public.payment_allocations;
create trigger trg_payment_allocations_updated_at
before update on public.payment_allocations
for each row
execute function public.set_payment_updated_at();

create or replace function public.record_payment_allocations(
  p_allocations jsonb,
  p_payment_method public.payment_method_type default null,
  p_payment_date date default current_date,
  p_reference_number text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment_id uuid;
  payment_total numeric;
  supplier_count integer;
  selected_supplier_id uuid;
begin
  if not (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  ) then
    raise exception 'Insufficient permission to record payments';
  end if;

  if jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Payment allocations must be a non-empty JSON array';
  end if;

  drop table if exists pg_temp.tmp_payment_allocations;
  create temporary table tmp_payment_allocations (
    payment_request_id uuid primary key,
    amount numeric not null
  ) on commit drop;

  insert into tmp_payment_allocations(payment_request_id, amount)
  select
    (item->>'payment_request_id')::uuid,
    (item->>'amount')::numeric
  from jsonb_array_elements(p_allocations) item;

  if exists (select 1 from tmp_payment_allocations where amount <= 0) then
    raise exception 'Payment allocation amount must be greater than zero';
  end if;

  if exists (
    select 1
    from tmp_payment_allocations a
    left join public.payment_requests pr on pr.id = a.payment_request_id
    where pr.id is null
  ) then
    raise exception 'One or more payment requests do not exist';
  end if;

  perform 1
  from public.payment_requests pr
  join tmp_payment_allocations a on a.payment_request_id = pr.id
  for update of pr;

  if exists (
    select 1
    from tmp_payment_allocations a
    join public.payment_requests pr on pr.id = a.payment_request_id
    where a.amount > greatest(coalesce(pr.total_amount, 0) - coalesce((
      select sum(pa.amount)
      from public.payment_allocations pa
      where pa.payment_request_id = pr.id
    ), 0), 0)
  ) then
    raise exception 'Payment allocation exceeds remaining amount';
  end if;

  select sum(amount) into payment_total from tmp_payment_allocations;

  select count(distinct pr.supplier_id), min(pr.supplier_id)
  into supplier_count, selected_supplier_id
  from tmp_payment_allocations a
  join public.payment_requests pr on pr.id = a.payment_request_id;

  perform pg_advisory_xact_lock(hashtext('public.payments.payment_number'));

  insert into public.payments (
    payment_number,
    supplier_id,
    payment_date,
    amount,
    payment_method,
    reference_number,
    notes,
    created_by
  )
  values (
    public.next_payment_number(),
    case when supplier_count = 1 then selected_supplier_id else null end,
    coalesce(p_payment_date, current_date),
    payment_total,
    p_payment_method,
    nullif(trim(p_reference_number), ''),
    nullif(trim(p_notes), ''),
    auth.uid()
  )
  returning id into payment_id;

  insert into public.payment_allocations(payment_id, payment_request_id, amount, created_by)
  select payment_id, payment_request_id, amount, auth.uid()
  from tmp_payment_allocations;

  return payment_id;
end;
$$;

alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;

drop policy if exists "payments_select_by_module_permission" on public.payments;
drop policy if exists "payments_insert_by_module_permission" on public.payments;
drop policy if exists "payments_update_by_module_permission" on public.payments;
drop policy if exists "payments_delete_by_module_permission" on public.payments;
drop policy if exists "payment_allocations_select_by_module_permission" on public.payment_allocations;
drop policy if exists "payment_allocations_insert_by_module_permission" on public.payment_allocations;
drop policy if exists "payment_allocations_update_by_module_permission" on public.payment_allocations;
drop policy if exists "payment_allocations_delete_by_module_permission" on public.payment_allocations;

create policy "payments_select_by_module_permission"
  on public.payments
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
  );

create policy "payments_insert_by_module_permission"
  on public.payments
  for insert
  to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payments_update_by_module_permission"
  on public.payments
  for update
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payments_delete_by_module_permission"
  on public.payments
  for delete
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payment_allocations_select_by_module_permission"
  on public.payment_allocations
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
  );

create policy "payment_allocations_insert_by_module_permission"
  on public.payment_allocations
  for insert
  to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payment_allocations_update_by_module_permission"
  on public.payment_allocations
  for update
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payment_allocations_delete_by_module_permission"
  on public.payment_allocations
  for delete
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

grant select, insert, update, delete on public.payments to authenticated;
grant select, insert, update, delete on public.payment_allocations to authenticated;
grant execute on function public.record_payment_allocations(jsonb, public.payment_method_type, date, text, text) to authenticated;

with paid_requests as (
  select pr.*
  from public.payment_requests pr
  where pr.payment_status = 'paid'
    and coalesce(pr.total_amount, 0) > 0
    and not exists (
      select 1
      from public.payment_allocations pa
      where pa.payment_request_id = pr.id
    )
),
legacy_payments as (
  insert into public.payments (
    payment_number,
    supplier_id,
    payment_date,
    amount,
    payment_method,
    notes,
    created_by,
    created_at,
    updated_at
  )
  select
    'PAY-LEGACY-' || pr.request_number,
    pr.supplier_id,
    coalesce(pr.paid_at::date, pr.approved_at::date, pr.created_at::date, current_date),
    pr.total_amount,
    pr.payment_method,
    'Backfilled from legacy paid payment_request',
    pr.created_by,
    coalesce(pr.paid_at, pr.approved_at, pr.created_at, now()),
    now()
  from paid_requests pr
  on conflict (payment_number) do nothing
  returning id, payment_number
)
insert into public.payment_allocations(payment_id, payment_request_id, amount, created_by, created_at, updated_at)
select
  p.id,
  pr.id,
  pr.total_amount,
  pr.created_by,
  coalesce(pr.paid_at, pr.approved_at, pr.created_at, now()),
  now()
from paid_requests pr
join public.payments p on p.payment_number = 'PAY-LEGACY-' || pr.request_number
on conflict (payment_id, payment_request_id) do nothing;

-- Defensive idempotent repair for environments where legacy payments were
-- inserted first but allocations were not yet present.
insert into public.payment_allocations(payment_id, payment_request_id, amount, created_by, created_at, updated_at)
select
  p.id,
  pr.id,
  pr.total_amount,
  pr.created_by,
  coalesce(pr.paid_at, pr.approved_at, pr.created_at, now()),
  now()
from public.payment_requests pr
join public.payments p on p.payment_number = 'PAY-LEGACY-' || pr.request_number
where pr.payment_status = 'paid'
  and coalesce(pr.total_amount, 0) > 0
  and not exists (
    select 1
    from public.payment_allocations pa
    where pa.payment_request_id = pr.id
  )
on conflict (payment_id, payment_request_id) do nothing;
