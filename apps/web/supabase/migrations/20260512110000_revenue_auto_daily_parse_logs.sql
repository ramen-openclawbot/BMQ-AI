-- One-row-per-day operational log for automated daily PO/email revenue parse.
-- Purpose: track whether the 23:59 VN cron ran, succeeded, and what it posted.

create table if not exists public.revenue_auto_daily_parse_logs (
  id uuid primary key default gen_random_uuid(),
  revenue_date date not null,
  period text not null,
  scheduled_for_vn text not null default '23:59',
  status text not null check (status in ('started', 'success', 'failed')),
  started_at timestamptz,
  finished_at timestamptz,
  run_id uuid references public.revenue_monthly_parse_runs(id) on delete set null,
  source_document_id uuid references public.revenue_source_documents(id) on delete set null,
  po_received_from date,
  po_received_to date,
  row_count integer not null default 0,
  gross_total numeric not null default 0,
  review_flagged_line_count integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (revenue_date)
);

create index if not exists idx_revenue_auto_daily_parse_logs_period
  on public.revenue_auto_daily_parse_logs(period, revenue_date desc);

create or replace function public.upsert_revenue_auto_daily_parse_log(
  _revenue_date date,
  _period text,
  _status text,
  _scheduled_for_vn text default '23:59',
  _started_at timestamptz default null,
  _finished_at timestamptz default null,
  _run_id uuid default null,
  _source_document_id uuid default null,
  _po_received_from date default null,
  _po_received_to date default null,
  _row_count integer default 0,
  _gross_total numeric default 0,
  _review_flagged_line_count integer default 0,
  _error_message text default null,
  _metadata jsonb default '{}'::jsonb
)
returns public.revenue_auto_daily_parse_logs
language plpgsql
security definer
set search_path = public
as $$
declare
  _row public.revenue_auto_daily_parse_logs;
begin
  insert into public.revenue_auto_daily_parse_logs (
    revenue_date,
    period,
    scheduled_for_vn,
    status,
    started_at,
    finished_at,
    run_id,
    source_document_id,
    po_received_from,
    po_received_to,
    row_count,
    gross_total,
    review_flagged_line_count,
    error_message,
    metadata,
    updated_at
  ) values (
    _revenue_date,
    _period,
    coalesce(nullif(_scheduled_for_vn, ''), '23:59'),
    _status,
    _started_at,
    _finished_at,
    _run_id,
    _source_document_id,
    _po_received_from,
    _po_received_to,
    coalesce(_row_count, 0),
    coalesce(_gross_total, 0),
    coalesce(_review_flagged_line_count, 0),
    _error_message,
    coalesce(_metadata, '{}'::jsonb),
    now()
  )
  on conflict (revenue_date) do update
    set period = excluded.period,
        scheduled_for_vn = excluded.scheduled_for_vn,
        status = excluded.status,
        started_at = coalesce(excluded.started_at, public.revenue_auto_daily_parse_logs.started_at),
        finished_at = excluded.finished_at,
        run_id = coalesce(excluded.run_id, public.revenue_auto_daily_parse_logs.run_id),
        source_document_id = coalesce(excluded.source_document_id, public.revenue_auto_daily_parse_logs.source_document_id),
        po_received_from = coalesce(excluded.po_received_from, public.revenue_auto_daily_parse_logs.po_received_from),
        po_received_to = coalesce(excluded.po_received_to, public.revenue_auto_daily_parse_logs.po_received_to),
        row_count = excluded.row_count,
        gross_total = excluded.gross_total,
        review_flagged_line_count = excluded.review_flagged_line_count,
        error_message = excluded.error_message,
        metadata = public.revenue_auto_daily_parse_logs.metadata || excluded.metadata,
        updated_at = now()
  returning * into _row;

  return _row;
end;
$$;

revoke all on function public.upsert_revenue_auto_daily_parse_log(date, text, text, text, timestamptz, timestamptz, uuid, uuid, date, date, integer, numeric, integer, text, jsonb) from public;
revoke all on function public.upsert_revenue_auto_daily_parse_log(date, text, text, text, timestamptz, timestamptz, uuid, uuid, date, date, integer, numeric, integer, text, jsonb) from anon;
revoke all on function public.upsert_revenue_auto_daily_parse_log(date, text, text, text, timestamptz, timestamptz, uuid, uuid, date, date, integer, numeric, integer, text, jsonb) from authenticated;
grant execute on function public.upsert_revenue_auto_daily_parse_log(date, text, text, text, timestamptz, timestamptz, uuid, uuid, date, date, integer, numeric, integer, text, jsonb) to service_role;

alter table public.revenue_auto_daily_parse_logs enable row level security;

drop policy if exists "finance_revenue_view_auto_daily_parse_logs" on public.revenue_auto_daily_parse_logs;
create policy "finance_revenue_view_auto_daily_parse_logs"
  on public.revenue_auto_daily_parse_logs
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'view')
  );

drop trigger if exists trg_revenue_auto_daily_parse_logs_updated_at on public.revenue_auto_daily_parse_logs;
create trigger trg_revenue_auto_daily_parse_logs_updated_at
  before update on public.revenue_auto_daily_parse_logs
  for each row
  execute function public.update_updated_at_column();
