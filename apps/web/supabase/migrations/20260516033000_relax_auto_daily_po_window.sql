-- Allow auto-daily PO/email posting when the PO window is the day before the revenue date.
-- Business rule: revenue/delivery date D scans Vietnam-local PO emails on D-1.

create or replace function public.auto_post_revenue_daily_parse(_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _run public.revenue_monthly_parse_runs;
  _source_doc_id uuid;
  _line_count integer := 0;
  _review_flagged_line_count integer := 0;
  _gross_total numeric := 0;
  _quantity_total numeric := 0;
  _channels jsonb := '[]'::jsonb;
  _superseded_doc_ids uuid[] := array[]::uuid[];
  _superseded_document_count integer := 0;
  _no_double_count_key text;
begin
  select * into _run
  from public.revenue_monthly_parse_runs
  where id = _run_id
  for update;

  if not found then
    raise exception 'Auto daily monthly parse run not found';
  end if;

  if _run.status <> 'preview_ready' then
    raise exception 'Auto daily monthly parse run is not ready for posting';
  end if;

  if _run.revenue_date_from <> _run.revenue_date_to then
    raise exception 'Auto daily monthly parse must cover exactly one revenue date';
  end if;

  if _run.po_received_from is null or _run.po_received_to is null or _run.po_received_from > _run.po_received_to then
    raise exception 'Auto daily PO received window is invalid';
  end if;

  -- PO/order emails for revenue date D are normally received on D-1.
  -- Do not require the PO received window itself to contain the revenue date;
  -- line-level validation below already ensures every parsed line belongs to
  -- the one revenue date and has po_received_date inside the configured PO window.

  _no_double_count_key := 'auto_daily_po_email_parse:' || _run.revenue_date_from::text;
  perform pg_advisory_xact_lock(hashtext('revenue_auto_daily_post:' || _run.revenue_date_from::text));

  if exists (
    select 1
    from public.revenue_monthly_parse_lines l
    where l.run_id = _run.id
      and (
        l.period <> _run.period
        or l.revenue_date <> _run.revenue_date_from
        or (l.po_received_date is not null and (l.po_received_date < _run.po_received_from or l.po_received_date > _run.po_received_to))
      )
  ) then
    raise exception 'Auto daily monthly parse contains lines outside the one-day date window';
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

  select coalesce(jsonb_agg(row_to_json(channel_summary)::jsonb order by gross_revenue desc), '[]'::jsonb)
    into _channels
  from (
    select
      channel,
      count(*)::integer as rows,
      coalesce(sum(gross_revenue), 0) as gross_revenue,
      coalesce(sum(quantity), 0) as quantity,
      count(*) filter (where review_status = 'needs_manual_review')::integer as review_flagged_rows
    from public.revenue_monthly_parse_lines
    where run_id = _run.id
    group by channel
  ) channel_summary;

  select coalesce(array_agg(d.id), array[]::uuid[])
    into _superseded_doc_ids
  from public.revenue_source_documents d
  where d.period = _run.period
    and d.source_type = 'po_email_parse'
    and d.status = 'controlled'
    and d.summary->>'monthly_parse_kind' = 'auto_daily_post'
    and (
      d.summary->>'auto_daily_no_double_count_key' = _no_double_count_key
      or d.summary->>'revenue_date' = _run.revenue_date_from::text
      or d.summary->>'revenue_date_from' = _run.revenue_date_from::text
    );

  if coalesce(array_length(_superseded_doc_ids, 1), 0) > 0 then
    update public.revenue_source_documents
      set status = 'superseded',
          summary = summary || jsonb_build_object('superseded_by_run_id', _run.id, 'superseded_at', now()),
          updated_at = now()
    where id = any(_superseded_doc_ids);
    get diagnostics _superseded_document_count = row_count;

    update public.revenue_ledger_lines l
      set approval_status = 'superseded',
          updated_at = now(),
          raw_payload = l.raw_payload || jsonb_build_object('superseded_by_run_id', _run.id, 'superseded_at', now())
    where l.source_document_id = any(_superseded_doc_ids);
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
    format('Auto daily temporary controlled PO/email parse %s', _run.revenue_date_from),
    _run.period,
    'controlled',
    jsonb_build_object(
      'monthly_parse_kind', 'auto_daily_post',
      'controlled_kind', 'auto_daily_temporary_controlled_parse',
      'trust_semantics', 'not_trusted_month_end_audit_source',
      'temporary_controlled_revenue', true,
      'owner_approval_required', false,
      'auto_daily_no_double_count_key', _no_double_count_key,
      'revenue_date', _run.revenue_date_from,
      'revenue_date_from', _run.revenue_date_from,
      'revenue_date_to', _run.revenue_date_to,
      'po_received_from', _run.po_received_from,
      'po_received_to', _run.po_received_to,
      'row_count', _line_count,
      'posted_line_count', _line_count,
      'review_flagged_line_count', _review_flagged_line_count,
      'gross_total', _gross_total,
      'quantity_total', _quantity_total,
      'channels', _channels,
      'superseded_document_count', _superseded_document_count,
      'posted_run_id', _run.id,
      'parser_version', 'monthly_parse_preview_v1'
    ),
    null
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
      'monthly_parse_kind', 'auto_daily_post',
      'controlled_status', 'auto_daily_temporary_controlled_parse',
      'controlled_kind', 'auto_daily_temporary_controlled_parse',
      'temporary_controlled_revenue', true,
      'owner_approval_required', false,
      'original_parse_review_status', review_status,
      'trust_semantics', 'not_trusted_month_end_audit_source',
      'auto_daily_no_double_count_key', _no_double_count_key
    )
  from public.revenue_monthly_parse_lines
  where run_id = _run.id
  order by source_row_number;

  update public.revenue_monthly_parse_runs
    set status = 'approved',
        overwrite_requested = true,
        approved_source_document_id = _source_doc_id,
        approved_by = null,
        approved_at = now(),
        summary = summary || jsonb_build_object(
          'approved_source_document_id', _source_doc_id,
          'approved_line_count', _line_count,
          'posted_line_count', _line_count,
          'review_flagged_line_count', _review_flagged_line_count,
          'approved_gross_total', _gross_total,
          'approved_quantity_total', _quantity_total,
          'approval_semantics', 'cron_auto_daily_no_owner_approval',
          'auto_daily_no_double_count_key', _no_double_count_key,
          'temporary_controlled_revenue', true,
          'trust_semantics', 'not_trusted_month_end_audit_source'
        ),
        updated_at = now()
  where id = _run.id;

  return jsonb_build_object(
    'success', true,
    'sourceDocumentId', _source_doc_id,
    'stagingRunId', _run.id,
    'summary', jsonb_build_object(
      'period', _run.period,
      'revenue_date', _run.revenue_date_from,
      'po_received_from', _run.po_received_from,
      'po_received_to', _run.po_received_to,
      'row_count', _line_count,
      'posted_line_count', _line_count,
      'review_flagged_line_count', _review_flagged_line_count,
      'gross_total', _gross_total,
      'quantity_total', _quantity_total,
      'channels', _channels,
      'status', 'controlled',
      'monthly_parse_kind', 'auto_daily_post',
      'controlled_kind', 'auto_daily_temporary_controlled_parse',
      'temporary_controlled_revenue', true,
      'trust_semantics', 'not_trusted_month_end_audit_source',
      'approval_semantics', 'cron_auto_daily_no_owner_approval',
      'auto_daily_no_double_count_key', _no_double_count_key,
      'superseded_document_count', _superseded_document_count
    )
  );
end;
$$;

revoke all on function public.auto_post_revenue_daily_parse(uuid) from public;
revoke all on function public.auto_post_revenue_daily_parse(uuid) from anon;
revoke all on function public.auto_post_revenue_daily_parse(uuid) from authenticated;
grant execute on function public.auto_post_revenue_daily_parse(uuid) to service_role;
