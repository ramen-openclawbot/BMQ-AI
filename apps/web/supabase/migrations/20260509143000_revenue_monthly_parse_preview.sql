-- Monthly manual PO/email parse preview and controlled operational posting.
-- Important semantics: `controlled` is owner-approved operational revenue for dashboard display;
-- `trusted` remains reserved for future month-end audit/source-of-truth workflows.

alter table public.revenue_source_documents
  drop constraint if exists revenue_source_documents_status_check;

alter table public.revenue_source_documents
  add constraint revenue_source_documents_status_check
  check (status in ('pending','trusted','controlled','superseded','rejected'));

create table if not exists public.revenue_monthly_parse_runs (
  id uuid primary key default gen_random_uuid(),
  period text not null,
  revenue_date_from date not null,
  revenue_date_to date not null,
  po_received_from date not null,
  po_received_to date not null,
  status text not null default 'preview_running',
  overwrite_requested boolean not null default false,
  approved_source_document_id uuid references public.revenue_source_documents(id) on delete set null,
  summary jsonb not null default '{}'::jsonb,
  error_message text,
  created_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  constraint revenue_monthly_parse_runs_period_check check (period ~ '^\d{4}-\d{2}$'),
  constraint revenue_monthly_parse_runs_status_check check (status in ('preview_running','preview_ready','approved','failed','rejected')),
  constraint revenue_monthly_parse_runs_date_order_check check (revenue_date_from <= revenue_date_to and po_received_from <= po_received_to)
);

create table if not exists public.revenue_monthly_parse_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.revenue_monthly_parse_runs(id) on delete cascade,
  source_row_number integer not null,
  revenue_date date not null,
  po_received_date date,
  period text not null,
  channel text not null,
  source_tab text,
  branch text,
  invoice_no text,
  customer_id uuid references public.mini_crm_customers(id) on delete set null,
  parent_customer_id uuid references public.mini_crm_customers(id) on delete set null,
  customer_code text,
  customer_name text not null,
  product_code text,
  product_name text,
  item_note text,
  quantity numeric(14,3) not null default 0,
  unit_price numeric(14,2) not null default 0,
  gross_revenue numeric(16,2) not null default 0,
  source_type text not null default 'po_email_parse',
  source_ref text,
  confidence_status text not null default 'manual_review',
  reconciliation_status text not null default 'not_reconciled',
  review_status text not null default 'not_required',
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint revenue_monthly_parse_lines_period_check check (period ~ '^\d{4}-\d{2}$'),
  constraint revenue_monthly_parse_lines_source_type_check check (source_type in ('csv_audit','po_email_parse','manual_entry','invoice_import','adjustment')),
  constraint revenue_monthly_parse_lines_confidence_status_check check (confidence_status in ('trusted','matched','unreviewed','manual_review','low_confidence')),
  constraint revenue_monthly_parse_lines_review_status_check check (review_status in ('not_required','needs_manual_review','reviewed','resolved')),
  constraint revenue_monthly_parse_lines_reconciliation_status_check check (reconciliation_status in ('not_reconciled','matched_po','csv_only','po_delta','alternate_source','manual_override')),
  unique (run_id, source_row_number)
);

create index if not exists idx_revenue_monthly_parse_runs_period_status
  on public.revenue_monthly_parse_runs(period, status, created_at desc);

create index if not exists idx_revenue_monthly_parse_lines_run
  on public.revenue_monthly_parse_lines(run_id, source_row_number);

create index if not exists idx_revenue_monthly_parse_lines_period_date
  on public.revenue_monthly_parse_lines(period, revenue_date);

create unique index if not exists uq_revenue_source_documents_active_monthly_controlled_parse
  on public.revenue_source_documents(period, source_type)
  where status = 'controlled'
    and source_type = 'po_email_parse'
    and summary->>'monthly_parse_kind' = 'manual_current_month_to_yesterday';

alter table public.revenue_monthly_parse_runs enable row level security;
alter table public.revenue_monthly_parse_lines enable row level security;

revoke all on table public.revenue_monthly_parse_runs from anon;
revoke all on table public.revenue_monthly_parse_lines from anon;
revoke all on table public.revenue_monthly_parse_runs from authenticated;
revoke all on table public.revenue_monthly_parse_lines from authenticated;

grant select, insert, update, delete on table public.revenue_monthly_parse_runs to authenticated;
grant select, insert, update, delete on table public.revenue_monthly_parse_lines to authenticated;

drop policy if exists "finance_read_revenue_monthly_parse_runs" on public.revenue_monthly_parse_runs;
create policy "finance_read_revenue_monthly_parse_runs"
  on public.revenue_monthly_parse_runs for select to authenticated
  using (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'));

drop policy if exists "finance_owner_write_revenue_monthly_parse_runs" on public.revenue_monthly_parse_runs;
create policy "finance_owner_write_revenue_monthly_parse_runs"
  on public.revenue_monthly_parse_runs for all to authenticated
  using (public.has_role((select auth.uid()), 'owner'))
  with check (public.has_role((select auth.uid()), 'owner'));

drop policy if exists "finance_read_revenue_monthly_parse_lines" on public.revenue_monthly_parse_lines;
create policy "finance_read_revenue_monthly_parse_lines"
  on public.revenue_monthly_parse_lines for select to authenticated
  using (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'));

drop policy if exists "finance_owner_write_revenue_monthly_parse_lines" on public.revenue_monthly_parse_lines;
create policy "finance_owner_write_revenue_monthly_parse_lines"
  on public.revenue_monthly_parse_lines for all to authenticated
  using (public.has_role((select auth.uid()), 'owner'))
  with check (public.has_role((select auth.uid()), 'owner'));

drop trigger if exists trg_touch_revenue_monthly_parse_runs on public.revenue_monthly_parse_runs;
create trigger trg_touch_revenue_monthly_parse_runs
  before update on public.revenue_monthly_parse_runs
  for each row execute function public.touch_revenue_ledger_updated_at();

create or replace function public.approve_revenue_monthly_parse(_run_id uuid, _overwrite boolean default false, _actor_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _actor uuid := coalesce(auth.uid(), _actor_id);
  _run public.revenue_monthly_parse_runs;
  _existing jsonb := '[]'::jsonb;
  _source_doc_id uuid;
  _line_count integer := 0;
  _excluded_review_line_count integer := 0;
  _gross_total numeric := 0;
  _quantity_total numeric := 0;
begin
  if _actor is null or not public.has_role(_actor, 'owner') then
    raise exception 'Forbidden: owner role required for monthly parse approval';
  end if;

  select * into _run
  from public.revenue_monthly_parse_runs
  where id = _run_id
  for update;

  if not found then
    raise exception 'Monthly parse preview run not found';
  end if;

  if _run.status <> 'preview_ready' then
    raise exception 'Monthly parse preview run is not ready for approval';
  end if;

  perform pg_advisory_xact_lock(hashtext('revenue_monthly_parse:' || _run.period));

  if exists (
    select 1
    from public.revenue_monthly_parse_lines l
    where l.run_id = _run.id
      and (
        l.period <> _run.period
        or l.revenue_date < _run.revenue_date_from
        or l.revenue_date > _run.revenue_date_to
        or (l.po_received_date is not null and (l.po_received_date < _run.po_received_from or l.po_received_date > _run.po_received_to))
      )
  ) then
    raise exception 'Monthly parse preview contains lines outside the approved date window';
  end if;

  select count(*), coalesce(sum(gross_revenue), 0), coalesce(sum(quantity), 0)
    into _line_count, _gross_total, _quantity_total
  from public.revenue_monthly_parse_lines
  where run_id = _run.id
    and review_status <> 'needs_manual_review';

  select count(*)
    into _excluded_review_line_count
  from public.revenue_monthly_parse_lines
  where run_id = _run.id
    and review_status = 'needs_manual_review';

  if _line_count = 0 then
    raise exception 'Monthly parse preview has no approvable lines; review or reject the preview';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id,
    'sourceName', d.source_name,
    'importedAt', d.imported_at,
    'summary', d.summary
  ) order by d.imported_at desc), '[]'::jsonb)
    into _existing
  from public.revenue_source_documents d
  where d.period = _run.period
    and d.source_type = 'po_email_parse'
    and d.status = 'controlled'
    and d.summary->>'monthly_parse_kind' = 'manual_current_month_to_yesterday';

  if jsonb_array_length(_existing) > 0 and not coalesce(_overwrite, false) then
    return jsonb_build_object(
      'success', false,
      'requiresOverwriteConfirmation', true,
      'existing', _existing
    );
  end if;

  if jsonb_array_length(_existing) > 0 and coalesce(_overwrite, false) then
    with superseded_docs as (
      update public.revenue_source_documents
        set status = 'superseded',
            summary = summary || jsonb_build_object('superseded_by_run_id', _run.id, 'superseded_at', now()),
            updated_at = now()
      where period = _run.period
        and source_type = 'po_email_parse'
        and status = 'controlled'
        and summary->>'monthly_parse_kind' = 'manual_current_month_to_yesterday'
      returning id
    )
    update public.revenue_ledger_lines l
      set approval_status = 'superseded',
          updated_at = now(),
          raw_payload = l.raw_payload || jsonb_build_object('superseded_by_run_id', _run.id, 'superseded_at', now())
    where l.source_document_id in (select id from superseded_docs);
  end if;

  insert into public.revenue_source_documents (
    source_type,
    source_name,
    period,
    status,
    summary,
    imported_by
  ) values (
    'po_email_parse',
    format('Owner-approved PO/email monthly parse %s through %s', _run.period, _run.revenue_date_to),
    _run.period,
    'controlled',
    jsonb_build_object(
      'monthly_parse_kind', 'manual_current_month_to_yesterday',
      'controlled_kind', 'owner_approved_operational_parse',
      'trust_semantics', 'not_trusted_month_end_audit_source',
      'revenue_date_from', _run.revenue_date_from,
      'revenue_date_to', _run.revenue_date_to,
      'po_received_from', _run.po_received_from,
      'po_received_to', _run.po_received_to,
      'row_count', _line_count,
      'excluded_review_line_count', _excluded_review_line_count,
      'gross_total', _gross_total,
      'quantity_total', _quantity_total,
      'approved_run_id', _run.id,
      'parser_version', 'monthly_parse_preview_v1'
    ),
    _actor
  ) returning id into _source_doc_id;

  insert into public.revenue_ledger_lines (
    source_document_id,
    source_row_number,
    period,
    revenue_date,
    channel,
    source_tab,
    branch,
    invoice_no,
    customer_id,
    parent_customer_id,
    customer_code,
    customer_name,
    product_code,
    product_name,
    item_note,
    quantity,
    unit_price,
    gross_revenue,
    source_type,
    approval_status,
    audit_status,
    confidence_status,
    review_status,
    reconciliation_status,
    source_ref,
    raw_payload
  )
  select
    _source_doc_id,
    source_row_number,
    period,
    revenue_date,
    channel,
    source_tab,
    branch,
    invoice_no,
    customer_id,
    parent_customer_id,
    customer_code,
    customer_name,
    product_code,
    product_name,
    item_note,
    quantity,
    unit_price,
    gross_revenue,
    source_type,
    'approved',
    'pending',
    confidence_status,
    review_status,
    reconciliation_status,
    source_ref,
    raw_payload || jsonb_build_object('monthly_parse_run_id', _run.id, 'controlled_status', 'owner_approved_operational_parse')
  from public.revenue_monthly_parse_lines
  where run_id = _run.id
    and review_status <> 'needs_manual_review'
  order by source_row_number;

  update public.revenue_monthly_parse_runs
    set status = 'approved',
        overwrite_requested = coalesce(_overwrite, false),
        approved_source_document_id = _source_doc_id,
        approved_by = _actor,
        approved_at = now(),
        summary = summary || jsonb_build_object(
          'approved_source_document_id', _source_doc_id,
          'approved_line_count', _line_count,
          'approved_gross_total', _gross_total,
          'approved_quantity_total', _quantity_total
        ),
        updated_at = now()
  where id = _run.id;

  return jsonb_build_object(
    'success', true,
    'sourceDocumentId', _source_doc_id,
    'summary', jsonb_build_object(
      'period', _run.period,
      'row_count', _line_count,
      'excluded_review_line_count', _excluded_review_line_count,
      'gross_total', _gross_total,
      'quantity_total', _quantity_total,
      'status', 'controlled'
    )
  );
end;
$$;

create or replace function public.reject_revenue_monthly_parse(_run_id uuid, _actor_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _actor uuid := coalesce(auth.uid(), _actor_id);
begin
  if _actor is null or not public.has_role(_actor, 'owner') then
    raise exception 'Forbidden: owner role required for monthly parse rejection';
  end if;

  delete from public.revenue_monthly_parse_runs
  where id = _run_id
    and status <> 'approved';

  if not found then
    raise exception 'Monthly parse preview run not found or already approved';
  end if;

  return jsonb_build_object('success', true, 'deletedRunId', _run_id);
end;
$$;

revoke all on function public.approve_revenue_monthly_parse(uuid, boolean, uuid) from public;
revoke all on function public.approve_revenue_monthly_parse(uuid, boolean, uuid) from anon;
revoke all on function public.reject_revenue_monthly_parse(uuid, uuid) from public;
revoke all on function public.reject_revenue_monthly_parse(uuid, uuid) from anon;

grant execute on function public.approve_revenue_monthly_parse(uuid, boolean, uuid) to authenticated, service_role;
grant execute on function public.reject_revenue_monthly_parse(uuid, uuid) to authenticated, service_role;
