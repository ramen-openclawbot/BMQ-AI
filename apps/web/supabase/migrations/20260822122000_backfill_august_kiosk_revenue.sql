-- Backfill all submitted August 2026 kiosk reports into the controlled revenue ledger.
-- Each of the four point-sale channels is valued from quantity using the owner-approved
-- effective price: 12,000 VND through 2026-08-14 and 14,000 VND from 2026-08-15.
-- Existing Retail Kiosk PO/email estimates are superseded on dates with submitted reports.

do $$
declare
  v_period constant text := '2026-08';
  v_from_date constant date := date '2026-08-01';
  v_to_date date := (timezone('Asia/Ho_Chi_Minh', now()))::date;
  v_report_date date;
  v_source_document_id uuid;
  v_expected_reports integer;
  v_expected_lines integer;
  v_expected_quantity numeric;
  v_expected_gross numeric;
  v_superseded_lines integer := 0;
  v_inserted_lines integer := 0;
  v_actual_lines integer;
  v_actual_quantity numeric;
  v_actual_gross numeric;
  v_legacy_active_lines integer;
  v_doc_row_count integer;
  v_doc_quantity numeric;
  v_doc_gross numeric;
  v_doc_channels jsonb;
begin
  if v_to_date > date '2026-08-31' then
    v_to_date := date '2026-08-31';
  end if;

  perform pg_advisory_xact_lock(hashtext('backfill_august_2026_kiosk_revenue_v1'));

  create temporary table kiosk_revenue_backfill_lines on commit drop as
  select
    report.report_date,
    report.id as report_id,
    report.location_id,
    report.location_name_snapshot,
    report.submitted_at,
    channel_row.id as channel_row_id,
    lower(btrim(channel_row.channel_code)) as channel_code,
    channel_row.channel_name_snapshot,
    channel_row.quantity,
    channel_row.amount_vnd as source_amount_vnd,
    channel_row.notes,
    case when report.report_date < date '2026-08-15' then 12000::numeric else 14000::numeric end as unit_price_vnd,
    round(
      channel_row.quantity
      * case when report.report_date < date '2026-08-15' then 12000::numeric else 14000::numeric end
    ) as gross_revenue_vnd
  from public.kiosk_daily_reports report
  join public.kiosk_daily_report_channel_rows channel_row
    on channel_row.report_id = report.id
  where report.status = 'submitted'
    and report.report_date between v_from_date and v_to_date
    and lower(btrim(channel_row.channel_code)) in ('khach_le', 'shopeefood', 'grabfood', 'befood');

  select count(distinct report_id), count(*), coalesce(sum(quantity), 0), coalesce(sum(gross_revenue_vnd), 0)
    into v_expected_reports, v_expected_lines, v_expected_quantity, v_expected_gross
  from kiosk_revenue_backfill_lines;

  if v_expected_reports = 0 or v_expected_lines = 0 then
    raise exception 'No submitted kiosk reports found for August 2026 backfill';
  end if;

  if v_expected_lines <> v_expected_reports * 4 then
    raise exception 'Kiosk revenue backfill expected four channel rows per report: reports %, lines %',
      v_expected_reports, v_expected_lines;
  end if;

  create temporary table kiosk_revenue_backfill_documents (
    report_date date primary key,
    source_document_id uuid not null
  ) on commit drop;

  for v_report_date in
    select distinct report_date from kiosk_revenue_backfill_lines order by report_date
  loop
    v_source_document_id := null;

    select document.id
      into v_source_document_id
    from public.revenue_source_documents document
    where document.period = v_period
      and document.source_type = 'po_email_parse'
      and document.status = 'controlled'
      and document.summary->>'monthly_parse_kind' = 'auto_daily_post'
      and (
        document.summary->>'auto_daily_no_double_count_key' = 'auto_daily_po_email_parse:' || v_report_date::text
        or document.summary->>'revenue_date' = v_report_date::text
        or document.summary->>'revenue_date_from' = v_report_date::text
      )
    order by document.imported_at desc, document.id desc
    limit 1;

    if v_source_document_id is null then
      insert into public.revenue_source_documents (
        source_type,
        source_name,
        period,
        status,
        summary,
        imported_by
      ) values (
        'po_email_parse',
        format('Kiosk revenue controlled backfill %s', v_report_date),
        v_period,
        'controlled',
        jsonb_build_object(
          'monthly_parse_kind', 'auto_daily_post',
          'controlled_kind', 'auto_daily_temporary_controlled_parse',
          'trust_semantics', 'submitted_kiosk_report_controlled_revenue',
          'temporary_controlled_revenue', true,
          'owner_approval_required', false,
          'auto_daily_no_double_count_key', 'auto_daily_po_email_parse:' || v_report_date::text,
          'revenue_date', v_report_date,
          'revenue_date_from', v_report_date,
          'revenue_date_to', v_report_date,
          'kiosk_revenue_backfill_version', 'august_2026_v1',
          'kiosk_revenue_backfilled_at', now()
        ),
        null
      ) returning id into v_source_document_id;
    end if;

    insert into kiosk_revenue_backfill_documents (report_date, source_document_id)
    values (v_report_date, v_source_document_id);
  end loop;

  update public.revenue_ledger_lines ledger
  set approval_status = 'superseded',
      updated_at = now(),
      raw_payload = ledger.raw_payload || jsonb_build_object(
        'superseded_by_kiosk_revenue_backfill', 'august_2026_v1',
        'superseded_at', now(),
        'supersede_reason', 'submitted kiosk report replaces Retail Kiosk PO/email estimate'
      )
  where ledger.period = v_period
    and ledger.revenue_date in (select distinct report_date from kiosk_revenue_backfill_lines)
    and ledger.channel = 'Retail Kiosk'
    and ledger.approval_status = 'approved';
  get diagnostics v_superseded_lines = row_count;

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
    document.source_document_id,
    coalesce(existing.max_source_row_number, 0)
      + row_number() over (
          partition by source.report_date
          order by source.location_name_snapshot, source.location_id, source.channel_code, source.channel_row_id
        )::integer,
    v_period,
    source.report_date,
    'Retail Kiosk',
    'Báo cáo điểm bán',
    source.location_name_snapshot,
    null,
    null,
    null,
    null,
    source.location_name_snapshot,
    'BMQ-001',
    'Bánh Mì Que Pate',
    nullif(btrim(coalesce(source.notes, '')), ''),
    source.quantity,
    source.unit_price_vnd,
    source.gross_revenue_vnd,
    'po_email_parse',
    'approved',
    'pending',
    'matched',
    'not_required',
    'not_reconciled',
    source.channel_row_id::text,
    jsonb_build_object(
      'source', 'kiosk_point_report',
      'source_url', 'https://baocao.banhmique.vn',
      'kiosk_report_id', source.report_id,
      'kiosk_channel_row_id', source.channel_row_id,
      'location_id', source.location_id,
      'location_name', source.location_name_snapshot,
      'channel_code', source.channel_code,
      'channel_name', source.channel_name_snapshot,
      'report_date', source.report_date,
      'submitted_at', source.submitted_at,
      'source_amount_vnd', source.source_amount_vnd,
      'applied_unit_price_vnd', source.unit_price_vnd,
      'pricing_rule', 'kiosk_bread_unit_price_effective_20260815_v1',
      'dashboard_channel', 'Retail Kiosk',
      'monthly_parse_kind', 'auto_daily_post',
      'controlled_kind', 'auto_daily_temporary_controlled_parse',
      'auto_daily_no_double_count_key', 'auto_daily_po_email_parse:' || source.report_date::text,
      'backfill_version', 'august_2026_v1',
      'backfilled_at', now(),
      'trust_semantics', 'submitted_kiosk_report_replaces_retail_kiosk_po_email_for_reported_date'
    )
  from kiosk_revenue_backfill_lines source
  join kiosk_revenue_backfill_documents document
    on document.report_date = source.report_date
  left join lateral (
    select max(ledger.source_row_number) as max_source_row_number
    from public.revenue_ledger_lines ledger
    where ledger.source_document_id = document.source_document_id
  ) existing on true;
  get diagnostics v_inserted_lines = row_count;

  for v_source_document_id in
    select distinct source_document_id from kiosk_revenue_backfill_documents
  loop
    select
      count(*),
      coalesce(sum(ledger.quantity), 0),
      coalesce(sum(ledger.gross_revenue), 0)
      into v_doc_row_count, v_doc_quantity, v_doc_gross
    from public.revenue_ledger_lines ledger
    where ledger.source_document_id = v_source_document_id
      and ledger.approval_status = 'approved';

    select coalesce(jsonb_agg(to_jsonb(channel_summary) order by channel_summary.gross_revenue desc), '[]'::jsonb)
      into v_doc_channels
    from (
      select
        ledger.channel,
        count(*)::integer as rows,
        coalesce(sum(ledger.gross_revenue), 0) as gross_revenue,
        coalesce(sum(ledger.quantity), 0) as quantity,
        count(*) filter (where ledger.review_status = 'needs_manual_review')::integer as review_flagged_rows
      from public.revenue_ledger_lines ledger
      where ledger.source_document_id = v_source_document_id
        and ledger.approval_status = 'approved'
      group by ledger.channel
    ) channel_summary;

    update public.revenue_source_documents document
    set summary = document.summary || jsonb_build_object(
          'row_count', v_doc_row_count,
          'posted_line_count', v_doc_row_count,
          'gross_total', v_doc_gross,
          'quantity_total', v_doc_quantity,
          'channels', v_doc_channels,
          'kiosk_revenue_backfill_version', 'august_2026_v1',
          'kiosk_revenue_backfilled_at', now(),
          'kiosk_revenue_backfill_report_count', (
            select count(distinct source.report_id)
            from kiosk_revenue_backfill_lines source
            join kiosk_revenue_backfill_documents mapping
              on mapping.report_date = source.report_date
            where mapping.source_document_id = v_source_document_id
          ),
          'kiosk_revenue_backfill_line_count', (
            select count(*)
            from kiosk_revenue_backfill_lines source
            join kiosk_revenue_backfill_documents mapping
              on mapping.report_date = source.report_date
            where mapping.source_document_id = v_source_document_id
          )
        ),
        updated_at = now()
    where document.id = v_source_document_id;
  end loop;

  select count(*), coalesce(sum(ledger.quantity), 0), coalesce(sum(ledger.gross_revenue), 0)
    into v_actual_lines, v_actual_quantity, v_actual_gross
  from public.revenue_ledger_lines ledger
  where ledger.period = v_period
    and ledger.revenue_date in (select distinct report_date from kiosk_revenue_backfill_lines)
    and ledger.approval_status = 'approved'
    and ledger.raw_payload->>'source' = 'kiosk_point_report'
    and ledger.raw_payload->>'backfill_version' = 'august_2026_v1';

  select count(*) into v_legacy_active_lines
  from public.revenue_ledger_lines ledger
  where ledger.period = v_period
    and ledger.revenue_date in (select distinct report_date from kiosk_revenue_backfill_lines)
    and ledger.channel = 'Retail Kiosk'
    and ledger.approval_status = 'approved'
    and coalesce(ledger.raw_payload->>'source', '') <> 'kiosk_point_report';

  if v_inserted_lines <> v_expected_lines
    or v_actual_lines <> v_expected_lines
    or v_actual_quantity <> v_expected_quantity
    or v_actual_gross <> v_expected_gross
    or v_legacy_active_lines <> 0 then
    raise exception 'Kiosk revenue backfill invariant failed: expected lines %, inserted %, actual %, expected qty %, actual qty %, expected gross %, actual gross %, legacy active %',
      v_expected_lines, v_inserted_lines, v_actual_lines,
      v_expected_quantity, v_actual_quantity,
      v_expected_gross, v_actual_gross,
      v_legacy_active_lines;
  end if;

  raise notice 'Kiosk revenue backfill complete: reports %, lines %, quantity %, gross %, superseded Retail Kiosk lines %',
    v_expected_reports, v_actual_lines, v_actual_quantity, v_actual_gross, v_superseded_lines;
end;
$$;
