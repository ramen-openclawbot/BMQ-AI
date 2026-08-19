-- Mini CRM delivery staff master data.
-- Delivery staff are internal records only and receive no login/session access.

create table if not exists public.delivery_staff (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone_raw text not null,
  phone_normalized text not null,
  monthly_salary_vnd numeric(14,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_staff_full_name_check check (length(btrim(full_name)) between 2 and 160),
  constraint delivery_staff_phone_normalized_check check (phone_normalized ~ '^84(3|5|7|8|9)[0-9]{8}$'),
  constraint delivery_staff_salary_check check (monthly_salary_vnd >= 0)
);

create unique index if not exists delivery_staff_active_phone_unique
  on public.delivery_staff(phone_normalized)
  where active = true;

create table if not exists public.delivery_staff_audit_logs (
  id uuid primary key default gen_random_uuid(),
  delivery_staff_id uuid not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor_id uuid,
  before_payload jsonb,
  after_payload jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_delivery_staff_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.audit_delivery_staff_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.delivery_staff_audit_logs(
    delivery_staff_id,
    action,
    actor_id,
    before_payload,
    after_payload
  ) values (
    coalesce(new.id, old.id),
    lower(tg_op),
    auth.uid(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists set_delivery_staff_updated_at on public.delivery_staff;
create trigger set_delivery_staff_updated_at
before update on public.delivery_staff
for each row execute function public.set_delivery_staff_updated_at();

drop trigger if exists audit_delivery_staff_changes on public.delivery_staff;
create trigger audit_delivery_staff_changes
after insert or update or delete on public.delivery_staff
for each row execute function public.audit_delivery_staff_change();

alter table public.delivery_staff enable row level security;
alter table public.delivery_staff_audit_logs enable row level security;

revoke all on table public.delivery_staff from public, anon;
revoke all on table public.delivery_staff_audit_logs from public, anon;
grant select, insert, update on table public.delivery_staff to authenticated;
grant select on table public.delivery_staff_audit_logs to authenticated;

drop policy if exists delivery_staff_select_crm on public.delivery_staff;
create policy delivery_staff_select_crm
on public.delivery_staff for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'view')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
);

drop policy if exists delivery_staff_insert_crm on public.delivery_staff;
create policy delivery_staff_insert_crm
on public.delivery_staff for insert to authenticated
with check (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
);

drop policy if exists delivery_staff_update_crm on public.delivery_staff;
create policy delivery_staff_update_crm
on public.delivery_staff for update to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
)
with check (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
);

drop policy if exists delivery_staff_audit_select_crm on public.delivery_staff_audit_logs;
create policy delivery_staff_audit_select_crm
on public.delivery_staff_audit_logs for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
);

comment on table public.delivery_staff is
  'Internal delivery employee master data. It does not grant authentication or portal access.';
comment on table public.delivery_staff_audit_logs is
  'Immutable audit history for delivery staff master-data changes.';
