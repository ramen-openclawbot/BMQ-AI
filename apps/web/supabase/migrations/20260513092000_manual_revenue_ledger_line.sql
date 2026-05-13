-- Audited staff manual revenue additions for missing PO/email operational cases.
-- Scope: positive manual revenue lines only. Delivery-short adjustments remain linked to dispatch/PO flows.

alter table public.revenue_ledger_line_audit_logs
  drop constraint if exists revenue_ledger_line_audit_logs_action_check;

alter table public.revenue_ledger_line_audit_logs
  add constraint revenue_ledger_line_audit_logs_action_check
  check (action in ('edit', 'add_manual'));

create or replace function public.add_manual_revenue_ledger_line(
  _payload jsonb,
  _note text default null
)
returns public.revenue_ledger_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  _actor_id uuid := auth.uid();
  _period text := nullif(btrim(_payload->>'period'), '');
  _revenue_date date;
  _channel text := nullif(btrim(_payload->>'channel'), '');
  _customer_id uuid;
  _parent_customer_id uuid;
  _customer_name text := nullif(btrim(_payload->>'customer_name'), '');
  _product_code text := nullif(btrim(_payload->>'product_code'), '');
  _product_name text := nullif(btrim(_payload->>'product_name'), '');
  _item_note text := nullif(btrim(_payload->>'item_note'), '');
  _quantity numeric := coalesce(nullif(_payload->>'quantity', '')::numeric, 0);
  _unit_price numeric := coalesce(nullif(_payload->>'unit_price', '')::numeric, 0);
  _gross_revenue numeric := coalesce(nullif(_payload->>'gross_revenue', '')::numeric, 0);
  _manual_entry_type text := coalesce(nullif(btrim(_payload->>'manual_entry_type'), ''), 'missing_po_email');
  _reason_code text := coalesce(nullif(btrim(_payload->>'reason_code'), ''), 'staff_forgot_po_email');
  _evidence_note text := nullif(btrim(_payload->>'evidence_note'), '');
  _evidence_url text := nullif(btrim(_payload->>'evidence_url'), '');
  _source_checksum text;
  _source_doc_id uuid;
  _source_row_number integer;
  _line public.revenue_ledger_lines;
  _after_payload jsonb;
  _existing_summary jsonb;
begin
  if _actor_id is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not (
    public.has_role(_actor_id, 'owner')
    or public.has_module_permission(_actor_id, 'finance_revenue', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if _payload is null or jsonb_typeof(_payload) <> 'object' then
    raise exception 'payload_required' using errcode = '22023';
  end if;

  begin
    _revenue_date := nullif(_payload->>'revenue_date', '')::date;
  exception when others then
    raise exception 'invalid_revenue_date' using errcode = '22007';
  end;

  if _revenue_date is null then
    raise exception 'revenue_date_required' using errcode = '23502';
  end if;

  _period := coalesce(_period, to_char(_revenue_date, 'YYYY-MM'));
  if _period <> to_char(_revenue_date, 'YYYY-MM') then
    raise exception 'period_must_match_revenue_date' using errcode = '22023';
  end if;

  if _channel is null then
    raise exception 'channel_required' using errcode = '23502';
  end if;

  if _customer_name is null then
    raise exception 'customer_name_required' using errcode = '23502';
  end if;

  if _manual_entry_type <> 'missing_po_email' then
    raise exception 'unsupported_manual_entry_type: %', _manual_entry_type using errcode = '22023';
  end if;

  if _reason_code <> 'staff_forgot_po_email' then
    raise exception 'unsupported_reason_code: %', _reason_code using errcode = '22023';
  end if;

  if _quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  if _unit_price < 0 or _gross_revenue <= 0 then
    raise exception 'amount_must_be_positive' using errcode = '22023';
  end if;

  if _evidence_note is null or length(_evidence_note) < 10 then
    raise exception 'evidence_note_required' using errcode = '23502';
  end if;

  if nullif(btrim(_note), '') is null or length(btrim(_note)) < 10 then
    raise exception 'audit_note_required' using errcode = '23502';
  end if;

  if nullif(_payload->>'customer_id', '') is not null then
    _customer_id := (_payload->>'customer_id')::uuid;
  end if;
  if nullif(_payload->>'parent_customer_id', '') is not null then
    _parent_customer_id := (_payload->>'parent_customer_id')::uuid;
  end if;

  _source_checksum := 'manual-revenue:' || _revenue_date::text || ':' || lower(regexp_replace(_channel, '\s+', '-', 'g'));

  insert into public.revenue_source_documents (
    source_type,
    source_name,
    period,
    status,
    source_uri,
    checksum,
    summary,
    imported_by,
    imported_at
  ) values (
    'manual_entry',
    format('Manual revenue additions %s %s', _revenue_date::text, _channel),
    _period,
    'controlled',
    'manual://revenue-ledger/' || _revenue_date::text || '/' || lower(regexp_replace(_channel, '\s+', '-', 'g')),
    _source_checksum,
    jsonb_build_object(
      'manual_entry', true,
      'manual_entry_type', 'missing_po_email',
      'controlled_kind', 'staff_manual_operational_addition',
      'trust_semantics', 'not_trusted_month_end_audit_source',
      'revenue_date', _revenue_date,
      'channel', _channel,
      'rows', 0,
      'quantity_total', 0,
      'gross_total', 0
    ),
    _actor_id,
    now()
  )
  on conflict (source_type, period, checksum)
  where checksum is not null
  do update set
    status = 'controlled',
    updated_at = now(),
    summary = public.revenue_source_documents.summary || jsonb_build_object(
      'manual_entry', true,
      'manual_entry_type', 'missing_po_email',
      'controlled_kind', 'staff_manual_operational_addition',
      'trust_semantics', 'not_trusted_month_end_audit_source',
      'revenue_date', _revenue_date,
      'channel', _channel
    )
  returning id, summary into _source_doc_id, _existing_summary;

  perform 1 from public.revenue_source_documents where id = _source_doc_id for update;

  select coalesce(max(source_row_number), 0) + 1
  into _source_row_number
  from public.revenue_ledger_lines
  where source_document_id = _source_doc_id;

  _after_payload := jsonb_build_object(
    'manual_entry', true,
    'manual_entry_type', 'missing_po_email',
    'reason_code', 'staff_forgot_po_email',
    'reason_label', 'Thiếu PO/email',
    'evidence_note', _evidence_note,
    'evidence_url', _evidence_url,
    'created_by', _actor_id,
    'created_at', now(),
    'source', 'staff_manual_ledger_add',
    'controlled_status', 'staff_manual_operational_addition',
    'trust_semantics', 'not_trusted_month_end_audit_source',
    'audit_decision', jsonb_build_object(
      'action', 'add_manual',
      'note', nullif(btrim(_note), ''),
      'edited_at', now(),
      'edited_by', _actor_id,
      'before', null
    ),
    'audit_decisions', jsonb_build_array(jsonb_build_object(
      'action', 'add_manual',
      'note', nullif(btrim(_note), ''),
      'edited_at', now(),
      'edited_by', _actor_id,
      'before', null
    ))
  );

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
    order_gross,
    customer_payable,
    source_type,
    approval_status,
    audit_status,
    confidence_status,
    review_status,
    reconciliation_status,
    source_ref,
    raw_payload
  ) values (
    _source_doc_id,
    _source_row_number,
    _period,
    _revenue_date,
    _channel,
    'Manual revenue',
    nullif(btrim(_payload->>'branch'), ''),
    nullif(btrim(_payload->>'invoice_no'), ''),
    _customer_id,
    _parent_customer_id,
    nullif(btrim(_payload->>'customer_code'), ''),
    _customer_name,
    _product_code,
    _product_name,
    _item_note,
    _quantity,
    _unit_price,
    _gross_revenue,
    _gross_revenue,
    _gross_revenue,
    'manual_entry',
    'approved',
    'adjusted',
    'manual_review',
    'resolved',
    'manual_override',
    _source_checksum || '#' || _source_row_number::text,
    _after_payload
  ) returning * into _line;

  insert into public.revenue_ledger_line_audit_logs (
    ledger_line_id,
    actor_id,
    action,
    before_payload,
    after_payload,
    note
  ) values (
    _line.id,
    _actor_id,
    'add_manual',
    '{}'::jsonb,
    to_jsonb(_line),
    nullif(btrim(_note), '')
  );

  update public.revenue_source_documents
  set summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object(
      'rows', (select count(*) from public.revenue_ledger_lines where source_document_id = _source_doc_id),
      'quantity_total', (select coalesce(sum(quantity), 0) from public.revenue_ledger_lines where source_document_id = _source_doc_id),
      'gross_total', (select coalesce(sum(gross_revenue), 0) from public.revenue_ledger_lines where source_document_id = _source_doc_id),
      'last_manual_entry_at', now(),
      'last_manual_entry_by', _actor_id
    ),
    updated_at = now()
  where id = _source_doc_id;

  return _line;
end;
$$;

revoke all on function public.add_manual_revenue_ledger_line(jsonb, text) from public;
revoke all on function public.add_manual_revenue_ledger_line(jsonb, text) from anon;
grant execute on function public.add_manual_revenue_ledger_line(jsonb, text) to authenticated;
