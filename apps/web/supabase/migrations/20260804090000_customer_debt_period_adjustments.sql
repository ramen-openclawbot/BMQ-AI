create table if not exists public.customer_debt_period_adjustments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete restrict,
  period_from date not null,
  period_to date not null,
  opening_balance_vnd numeric not null default 0,
  amount_collected_vnd numeric not null default 0,
  payment_due_date date,
  note text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_debt_period_adjustments_period_check check (period_from <= period_to),
  constraint customer_debt_period_adjustments_collected_check check (amount_collected_vnd >= 0),
  unique (customer_id, period_from, period_to)
);

create table if not exists public.customer_debt_period_adjustment_audit_logs (
  id uuid primary key default gen_random_uuid(),
  adjustment_id uuid not null references public.customer_debt_period_adjustments(id) on delete restrict,
  customer_id uuid not null references public.mini_crm_customers(id) on delete restrict,
  period_from date not null,
  period_to date not null,
  old_values jsonb,
  new_values jsonb not null,
  note text,
  changed_by uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default now()
);

create unique index if not exists revenue_ledger_lines_dealer_order_item_uidx
  on public.revenue_ledger_lines ((raw_payload->>'dealer_order_item_id'))
  where raw_payload->>'source' = 'dealer_portal_order'
    and raw_payload->>'dealer_order_item_id' is not null
    and approval_status = 'approved';

create index if not exists customer_debt_period_adjustments_customer_period_idx
  on public.customer_debt_period_adjustments(customer_id, period_from, period_to);
create index if not exists customer_debt_period_adjustment_audit_lookup_idx
  on public.customer_debt_period_adjustment_audit_logs(adjustment_id, changed_at desc);

alter table public.customer_debt_period_adjustments enable row level security;
alter table public.customer_debt_period_adjustment_audit_logs enable row level security;

revoke all on table public.customer_debt_period_adjustments from anon, authenticated;
revoke all on table public.customer_debt_period_adjustment_audit_logs from anon, authenticated;
grant select on table public.customer_debt_period_adjustments to authenticated;
grant select on table public.customer_debt_period_adjustment_audit_logs to authenticated;

drop policy if exists "finance_revenue_view_customer_debt_adjustments" on public.customer_debt_period_adjustments;
create policy "finance_revenue_view_customer_debt_adjustments"
  on public.customer_debt_period_adjustments
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'view')
  );

drop policy if exists "finance_revenue_view_customer_debt_adjustment_audit" on public.customer_debt_period_adjustment_audit_logs;
create policy "finance_revenue_view_customer_debt_adjustment_audit"
  on public.customer_debt_period_adjustment_audit_logs
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'view')
  );

create or replace function public.upsert_customer_debt_period_adjustment(
  _customer_id uuid,
  _period_from date,
  _period_to date,
  _opening_balance_vnd numeric default 0,
  _amount_collected_vnd numeric default 0,
  _payment_due_date date default null,
  _note text default null
)
returns public.customer_debt_period_adjustments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.customer_debt_period_adjustments%rowtype;
  v_result public.customer_debt_period_adjustments%rowtype;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_revenue', 'edit')
  ) then
    raise exception 'finance_revenue_edit_required';
  end if;
  if _customer_id is null then
    raise exception 'customer_id_required';
  end if;
  if _period_from is null or _period_to is null or _period_from > _period_to then
    raise exception 'invalid_debt_period';
  end if;
  if coalesce(_amount_collected_vnd, 0) < 0 then
    raise exception 'amount_collected_must_be_nonnegative';
  end if;

  select *
  into v_existing
  from public.customer_debt_period_adjustments
  where customer_id = _customer_id
    and period_from = _period_from
    and period_to = _period_to
  for update;

  insert into public.customer_debt_period_adjustments (
    customer_id,
    period_from,
    period_to,
    opening_balance_vnd,
    amount_collected_vnd,
    payment_due_date,
    note,
    updated_by,
    updated_at
  ) values (
    _customer_id,
    _period_from,
    _period_to,
    coalesce(_opening_balance_vnd, 0),
    coalesce(_amount_collected_vnd, 0),
    _payment_due_date,
    nullif(btrim(coalesce(_note, '')), ''),
    v_actor,
    now()
  )
  on conflict (customer_id, period_from, period_to)
  do update set
    opening_balance_vnd = excluded.opening_balance_vnd,
    amount_collected_vnd = excluded.amount_collected_vnd,
    payment_due_date = excluded.payment_due_date,
    note = excluded.note,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into v_result;

  insert into public.customer_debt_period_adjustment_audit_logs (
    adjustment_id,
    customer_id,
    period_from,
    period_to,
    old_values,
    new_values,
    note,
    changed_by
  ) values (
    v_result.id,
    v_result.customer_id,
    v_result.period_from,
    v_result.period_to,
    case when v_existing.id is null then null else to_jsonb(v_existing) end,
    to_jsonb(v_result),
    nullif(btrim(coalesce(_note, '')), ''),
    v_actor
  );

  return v_result;
end;
$$;

revoke all on function public.upsert_customer_debt_period_adjustment(uuid, date, date, numeric, numeric, date, text) from public;
grant execute on function public.upsert_customer_debt_period_adjustment(uuid, date, date, numeric, numeric, date, text) to authenticated;

comment on table public.customer_debt_period_adjustments is
  'Manual period-level opening balance, collections, and due date for customer receivables; approved revenue remains in revenue_ledger_lines.';
comment on function public.upsert_customer_debt_period_adjustment(uuid, date, date, numeric, numeric, date, text) is
  'Permission-gated audited edit for customer debt period adjustments.';
