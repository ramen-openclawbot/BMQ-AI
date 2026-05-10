-- Owner approval posts the complete current-month PO/email preview into the controlled revenue ledger.
-- Parser review/confidence flags are preserved as metadata for later ledger edit/month-end audit;
-- they do not block approval or exclude rows from the dashboard.

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
  _review_flagged_line_count integer := 0;
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
  where run_id = _run.id;

  select count(*)
    into _review_flagged_line_count
  from public.revenue_monthly_parse_lines
  where run_id = _run.id
    and review_status = 'needs_manual_review';

  if _line_count = 0 then
    raise exception 'Monthly parse preview has no rows to approve';
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
      'posted_line_count', _line_count,
      'review_flagged_line_count', _review_flagged_line_count,
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
    raw_payload || jsonb_build_object(
      'monthly_parse_run_id', _run.id,
      'controlled_status', 'owner_approved_operational_parse',
      'owner_controlled_approved_at', now(),
      'original_parse_review_status', review_status,
      'trust_semantics', 'not_trusted_month_end_audit_source'
    )
  from public.revenue_monthly_parse_lines
  where run_id = _run.id
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
          'posted_line_count', _line_count,
          'review_flagged_line_count', _review_flagged_line_count,
          'approved_gross_total', _gross_total,
          'approved_quantity_total', _quantity_total,
          'approval_semantics', 'owner_controlled_ledger_first'
        ),
        updated_at = now()
  where id = _run.id;

  return jsonb_build_object(
    'success', true,
    'sourceDocumentId', _source_doc_id,
    'dashboardUrlPeriod', _run.period,
    'summary', jsonb_build_object(
      'period', _run.period,
      'row_count', _line_count,
      'posted_line_count', _line_count,
      'review_flagged_line_count', _review_flagged_line_count,
      'gross_total', _gross_total,
      'quantity_total', _quantity_total,
      'status', 'controlled',
      'approval_semantics', 'owner_controlled_ledger_first'
    )
  );
end;
$$;

revoke all on function public.approve_revenue_monthly_parse(uuid, boolean, uuid) from public;
revoke all on function public.approve_revenue_monthly_parse(uuid, boolean, uuid) from anon;
grant execute on function public.approve_revenue_monthly_parse(uuid, boolean, uuid) to authenticated, service_role;
