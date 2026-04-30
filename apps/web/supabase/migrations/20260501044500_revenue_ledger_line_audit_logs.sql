-- Audit trail for staff edits on revenue ledger source lines.
-- Staff do not approve lines in this workflow; they edit incorrect rows and every save is logged.

create table if not exists public.revenue_ledger_line_audit_logs (
  id uuid primary key default gen_random_uuid(),
  ledger_line_id uuid not null references public.revenue_ledger_lines(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null default 'edit',
  before_payload jsonb not null default '{}'::jsonb,
  after_payload jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now(),
  constraint revenue_ledger_line_audit_logs_action_check check (action in ('edit'))
);

create index if not exists idx_revenue_ledger_line_audit_logs_line
  on public.revenue_ledger_line_audit_logs(ledger_line_id, created_at desc);

create index if not exists idx_revenue_ledger_line_audit_logs_actor
  on public.revenue_ledger_line_audit_logs(actor_id, created_at desc);

alter table public.revenue_ledger_line_audit_logs enable row level security;

revoke all on table public.revenue_ledger_line_audit_logs from anon;
revoke all on table public.revenue_ledger_line_audit_logs from authenticated;

grant select, insert on table public.revenue_ledger_line_audit_logs to authenticated;

drop policy if exists "finance_read_revenue_ledger_line_audit_logs" on public.revenue_ledger_line_audit_logs;
create policy "finance_read_revenue_ledger_line_audit_logs"
  on public.revenue_ledger_line_audit_logs for select to authenticated
  using (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'));

drop policy if exists "finance_insert_revenue_ledger_line_audit_logs" on public.revenue_ledger_line_audit_logs;
create policy "finance_insert_revenue_ledger_line_audit_logs"
  on public.revenue_ledger_line_audit_logs for insert to authenticated
  with check (
    actor_id = (select auth.uid())
    and (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'))
  );

create or replace function public.edit_revenue_ledger_line(
  _ledger_line_id uuid,
  _patch jsonb,
  _note text default null
)
returns public.revenue_ledger_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  _before public.revenue_ledger_lines;
  _after public.revenue_ledger_lines;
  _actor_id uuid := auth.uid();
begin
  if _actor_id is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not (public.has_role(_actor_id, 'owner') or public.has_role(_actor_id, 'staff')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into _before
  from public.revenue_ledger_lines
  where id = _ledger_line_id
  for update;

  if not found then
    raise exception 'revenue ledger line not found: %', _ledger_line_id using errcode = 'P0002';
  end if;

  update public.revenue_ledger_lines
  set
    revenue_date = coalesce(nullif(_patch->>'revenue_date', '')::date, revenue_date),
    invoice_no = nullif(_patch->>'invoice_no', ''),
    customer_name = coalesce(nullif(_patch->>'customer_name', ''), customer_name),
    product_name = nullif(_patch->>'product_name', ''),
    item_note = nullif(_patch->>'item_note', ''),
    quantity = coalesce((_patch->>'quantity')::numeric, quantity),
    unit_price = coalesce((_patch->>'unit_price')::numeric, unit_price),
    gross_revenue = coalesce((_patch->>'gross_revenue')::numeric, gross_revenue),
    approval_status = _before.approval_status,
    audit_status = 'adjusted',
    confidence_status = 'manual_review',
    review_status = 'resolved',
    reconciliation_status = 'manual_override',
    raw_payload = coalesce(_patch->'raw_payload', raw_payload),
    updated_at = now()
  where id = _ledger_line_id
  returning * into _after;

  insert into public.revenue_ledger_line_audit_logs (
    ledger_line_id,
    actor_id,
    action,
    before_payload,
    after_payload,
    note
  ) values (
    _ledger_line_id,
    _actor_id,
    'edit',
    to_jsonb(_before),
    to_jsonb(_after),
    nullif(btrim(_note), '')
  );

  return _after;
end;
$$;

revoke all on function public.edit_revenue_ledger_line(uuid, jsonb, text) from anon;
grant execute on function public.edit_revenue_ledger_line(uuid, jsonb, text) to authenticated;
