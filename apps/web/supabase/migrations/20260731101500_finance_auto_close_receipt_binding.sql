-- Tighten PO receipt binding for finance auto-close.
-- If a payment request links a specific goods receipt, only that receipt may satisfy the received gate.
-- PO-level fallback is allowed only when goods_receipt_id is null.

create or replace function public.finance_auto_close_day(
  p_closing_date date,
  p_mode text,
  p_snapshot jsonb,
  p_actor text default 'system_finance_cron'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text := lower(trim(coalesce(p_mode, '')));
  v_actor text := coalesce(nullif(trim(p_actor), ''), 'system_finance_cron');
  v_run_id uuid;
  v_existing_run public.finance_daily_close_runs%rowtype;
  v_declaration public.ceo_daily_closing_declarations%rowtype;
  v_previous_declaration public.ceo_daily_closing_declarations%rowtype;
  v_previous_closing numeric := 0;
  v_start_utc timestamptz;
  v_end_utc timestamptz;
  v_drive_connectivity boolean := coalesce((p_snapshot->>'driveConnectivity')::boolean, false);
  v_unc_evidence jsonb := coalesce(p_snapshot->'uncEvidence', '[]'::jsonb);
  v_qtm_evidence jsonb := coalesce(p_snapshot->'qtmEvidence', '[]'::jsonb);
  v_snapshot_blockers jsonb := coalesce(p_snapshot->'blockers', '[]'::jsonb);
  v_declared_unc numeric := coalesce(nullif(p_snapshot->>'declaredUnc', '')::numeric, 0);
  v_qtm_opening numeric := coalesce(nullif(p_snapshot->>'qtmOpening', '')::numeric, 0);
  v_qtm_topup numeric := coalesce(nullif(p_snapshot->>'qtmTopup', '')::numeric, 0);
  v_qtm_spent numeric := coalesce(nullif(p_snapshot->>'qtmSpent', '')::numeric, 0);
  v_qtm_closing numeric := coalesce(nullif(p_snapshot->>'qtmClosing', '')::numeric, 0);
  v_low_confidence_threshold numeric := coalesce(nullif(p_snapshot->>'lowConfidenceThreshold', '')::numeric, 0.85);
  v_unc_evidence_sum numeric := 0;
  v_qtm_evidence_sum numeric := 0;
  v_min_confidence numeric := 1;
  v_db_declared_unc numeric := 0;
  v_db_qtm_opening numeric := 0;
  v_db_qtm_topup numeric := 0;
  v_declaration_count integer := 0;
  v_blockers jsonb := '[]'::jsonb;
  v_auto_approve_enabled boolean := false;
  v_auto_close_enabled boolean := false;
  v_evidence record;
  v_candidate_ids uuid[];
  v_match_count integer := 0;
  v_match_id uuid;
  v_match_status text;
  v_match_strategy text;
  v_match_blocker text;
  v_pending record;
  v_approved_ids jsonb := '[]'::jsonb;
  v_approved_count integer := 0;
  v_result jsonb := '{}'::jsonb;
  v_audit_entry jsonb;
begin
  if v_mode not in ('shadow', 'enforced') then
    raise exception 'Invalid finance auto-close mode: %', p_mode;
  end if;

  if p_closing_date > (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'Cannot auto-close future Vietnam date: %', p_closing_date;
  end if;

  perform pg_advisory_xact_lock(hashtext('finance_auto_close_day'), p_closing_date - date '2000-01-01');

  select * into v_existing_run
  from public.finance_daily_close_runs
  where closing_date = p_closing_date
    and mode = v_mode
    and status = 'succeeded'
  order by created_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'ok', true,
      'existing', true,
      'runId', v_existing_run.id,
      'closingDate', v_existing_run.closing_date,
      'mode', v_existing_run.mode,
      'status', v_existing_run.status,
      'decision', v_existing_run.decision,
      'blockers', v_existing_run.blockers,
      'approvedPaymentRequestIds', v_existing_run.approved_payment_request_ids
    );
  end if;

  v_start_utc := p_closing_date::timestamp at time zone 'Asia/Ho_Chi_Minh';
  v_end_utc := (p_closing_date + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh';

  select count(*) into v_declaration_count
  from public.ceo_daily_closing_declarations
  where closing_date = p_closing_date;

  select * into v_declaration
  from public.ceo_daily_closing_declarations
  where closing_date = p_closing_date
  order by created_at desc, id desc
  limit 1;

  if v_declaration_count = 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'missing_declaration', 'message', 'Missing CEO daily closing declaration'));
  elsif v_declaration_count > 1 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'duplicate_declaration',
      'message', 'More than one CEO daily closing declaration exists for the date',
      'count', v_declaration_count
    ));
  else
    v_db_declared_unc := coalesce(v_declaration.unc_extracted_amount, v_declaration.unc_total_declared, 0);
    v_db_qtm_topup := coalesce(v_declaration.qtm_extracted_amount, v_declaration.cash_fund_topup_amount, 0);
    v_db_qtm_opening := coalesce(nullif(v_declaration.extraction_meta->>'qtm_opening_balance', '')::numeric, 0);

    if v_declared_unc is distinct from v_db_declared_unc
       or v_qtm_opening is distinct from v_db_qtm_opening
       or v_qtm_topup is distinct from v_db_qtm_topup then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'snapshot_declaration_mismatch',
        'message', 'Snapshot values do not match the persisted CEO declaration'
      ));
    end if;
  end if;

  select * into v_previous_declaration
  from public.ceo_daily_closing_declarations
  where closing_date < p_closing_date
  order by closing_date desc
  limit 1;

  if found then
    if coalesce(v_previous_declaration.extraction_meta->>'close_approval_locked', 'false') <> 'true' then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', 'prior_unclosed_day',
        'message', 'The immediately preceding finance day is not closed',
        'priorClosingDate', v_previous_declaration.closing_date
      ));
    else
      v_previous_closing := coalesce(nullif(v_previous_declaration.extraction_meta->>'qtm_closing_balance', '')::numeric, 0);
      if v_qtm_opening is distinct from v_previous_closing then
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
          'code', 'qtm_opening_chain_mismatch',
          'message', 'QTM opening does not equal the prior closed day balance',
          'priorClosingDate', v_previous_declaration.closing_date,
          'priorClosing', v_previous_closing,
          'qtmOpening', v_qtm_opening
        ));
      end if;
    end if;
  elsif v_qtm_opening <> 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'qtm_opening_chain_mismatch',
      'message', 'First finance day must start with zero QTM opening',
      'qtmOpening', v_qtm_opening
    ));
  end if;

  select coalesce((select value::boolean from public.app_settings where key = 'finance_auto_approve_enabled'), false)
    into v_auto_approve_enabled;
  select coalesce((select value::boolean from public.app_settings where key = 'finance_auto_close_enabled'), false)
    into v_auto_close_enabled;

  drop table if exists pg_temp.tmp_finance_auto_close_evidence;
  create temporary table tmp_finance_auto_close_evidence (
    evidence_source text not null,
    evidence jsonb not null,
    file_id text,
    amount numeric not null,
    confidence numeric not null,
    supplier_id uuid,
    reference text,
    payment_request_id uuid
  ) on commit drop;

  insert into tmp_finance_auto_close_evidence (
    evidence_source,
    evidence,
    file_id,
    amount,
    confidence,
    supplier_id,
    reference,
    payment_request_id
  )
  select
    'unc',
    e.value,
    nullif(e.value->>'fileId', ''),
    coalesce(nullif(e.value->>'amount', '')::numeric, 0),
    coalesce(nullif(e.value->>'confidence', '')::numeric, 0),
    nullif(e.value->>'supplierId', '')::uuid,
    nullif(e.value->>'reference', ''),
    nullif(e.value->>'paymentRequestId', '')::uuid
  from jsonb_array_elements(v_unc_evidence) as e(value)
  union all
  select
    'qtm',
    e.value,
    nullif(e.value->>'fileId', ''),
    coalesce(nullif(e.value->>'amount', '')::numeric, 0),
    coalesce(nullif(e.value->>'confidence', '')::numeric, 0),
    nullif(e.value->>'supplierId', '')::uuid,
    nullif(e.value->>'reference', ''),
    nullif(e.value->>'paymentRequestId', '')::uuid
  from jsonb_array_elements(v_qtm_evidence) as e(value);

  select coalesce(sum(amount), 0)
  into v_unc_evidence_sum
  from tmp_finance_auto_close_evidence
  where evidence_source = 'unc';

  select coalesce(sum(amount), 0)
  into v_qtm_evidence_sum
  from tmp_finance_auto_close_evidence
  where evidence_source = 'qtm';

  select coalesce(min(confidence), 1)
  into v_min_confidence
  from tmp_finance_auto_close_evidence;

  if exists (
    select 1
    from tmp_finance_auto_close_evidence
    where file_id is not null
    group by evidence_source, file_id
    having count(*) > 1
  ) then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'duplicate_evidence_file',
      'message', 'The same Drive evidence file appears more than once'
    ));
  end if;

  if not v_drive_connectivity then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'drive_connectivity', 'message', 'Drive connectivity check failed'));
  end if;

  if v_declared_unc > 0 and jsonb_array_length(v_unc_evidence) = 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'missing_unc_evidence', 'message', 'UNC declaration has no evidence'));
  end if;

  if v_qtm_spent > 0 and jsonb_array_length(v_qtm_evidence) = 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'missing_qtm_evidence', 'message', 'QTM spend has no evidence'));
  end if;

  if v_min_confidence < v_low_confidence_threshold then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'low_confidence', 'message', 'Evidence confidence is below threshold'));
  end if;

  if v_unc_evidence_sum is distinct from v_declared_unc then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'unc_amount_mismatch',
      'message', 'UNC evidence sum does not exactly equal declared UNC',
      'declaredUnc', v_declared_unc,
      'uncEvidenceSum', v_unc_evidence_sum
    ));
  end if;

  if v_qtm_evidence_sum is distinct from v_qtm_spent then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'qtm_evidence_sum_mismatch',
      'message', 'QTM evidence sum does not exactly equal QTM spend',
      'qtmSpent', v_qtm_spent,
      'qtmEvidenceSum', v_qtm_evidence_sum
    ));
  end if;

  if (v_qtm_opening + v_qtm_topup - v_qtm_spent) is distinct from v_qtm_closing then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'qtm_chain_mismatch', 'message', 'QTM cash equation does not balance'));
  end if;

  if v_qtm_opening < 0 or v_qtm_topup < 0 or v_qtm_spent < 0 or v_qtm_closing < 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'qtm_negative_balance', 'message', 'QTM cash values must be nonnegative'));
  end if;

  if jsonb_array_length(v_snapshot_blockers) > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'snapshot_blockers', 'message', 'Snapshot already contains blockers', 'blockers', v_snapshot_blockers));
  end if;

  insert into public.finance_daily_close_runs (
    closing_date,
    mode,
    status,
    decision,
    actor,
    snapshot,
    blockers,
    created_by,
    updated_by
  )
  values (
    p_closing_date,
    v_mode,
    'running',
    'pending',
    v_actor,
    p_snapshot,
    v_blockers,
    v_actor,
    v_actor
  )
  returning id into v_run_id;

  drop table if exists pg_temp.tmp_finance_auto_close_matched_prs;
  create temporary table tmp_finance_auto_close_matched_prs (
    payment_request_id uuid primary key
  ) on commit drop;

  drop table if exists pg_temp.tmp_finance_auto_close_scoped_pending_prs;
  create temporary table tmp_finance_auto_close_scoped_pending_prs as
  select pr.id
  from public.payment_requests pr
  where pr.status::text in ('pending', 'approved')
    and (
      (pr.created_at >= v_start_utc and pr.created_at < v_end_utc)
      or exists (
        select 1
        from tmp_finance_auto_close_evidence ev
        where ev.file_id is not null
          and strpos(concat_ws(' ', pr.image_url, pr.description, pr.notes, pr.title), ev.file_id) > 0
      )
    );

  for v_evidence in
    select *
    from tmp_finance_auto_close_evidence
    order by evidence_source, file_id nulls last, reference nulls last
  loop
    v_match_count := 0;
    v_candidate_ids := array[]::uuid[];
    v_match_id := null;
    v_match_status := 'blocked';
    v_match_strategy := 'amount';
    v_match_blocker := null;

    if v_evidence.payment_request_id is not null then
      v_match_strategy := 'explicit_payment_request_id';
      if not exists (
        select 1 from public.payment_requests pr
        where pr.id = v_evidence.payment_request_id
          and pr.status::text in ('pending', 'approved')
      ) then
        v_match_blocker := 'explicit_payment_request_not_found';
      elsif not exists (
        select 1 from public.payment_requests pr
        where pr.id = v_evidence.payment_request_id
          and (
            (pr.created_at >= v_start_utc and pr.created_at < v_end_utc)
            or (
              v_evidence.file_id is not null
              and strpos(concat_ws(' ', pr.image_url, pr.description, pr.notes, pr.title), v_evidence.file_id) > 0
            )
          )
      ) then
        v_match_blocker := 'explicit_payment_request_outside_close_scope';
      elsif exists (
        select 1 from public.payment_requests pr
        where pr.id = v_evidence.payment_request_id
          and pr.payment_method::text is distinct from case v_evidence.evidence_source when 'unc' then 'bank_transfer' else 'cash' end
      ) then
        v_match_blocker := 'explicit_payment_request_method_mismatch';
      elsif exists (
        select 1 from public.payment_requests pr
        where pr.id = v_evidence.payment_request_id
          and pr.total_amount is distinct from v_evidence.amount
      ) then
        v_match_blocker := 'explicit_payment_request_amount_mismatch';
      elsif v_evidence.supplier_id is not null and exists (
        select 1 from public.payment_requests pr
        where pr.id = v_evidence.payment_request_id
          and pr.supplier_id is distinct from v_evidence.supplier_id
      ) then
        v_match_blocker := 'explicit_payment_request_supplier_mismatch';
      else
        v_match_count := 1;
        v_candidate_ids := array[v_evidence.payment_request_id];
        v_match_id := v_evidence.payment_request_id;
      end if;
    elsif v_evidence.supplier_id is not null then
      v_match_strategy := 'supplier_amount';
      select count(*), array_agg(pr.id order by pr.id)
      into v_match_count, v_candidate_ids
      from public.payment_requests pr
      where pr.status::text in ('pending', 'approved')
        and pr.supplier_id = v_evidence.supplier_id
        and pr.total_amount = v_evidence.amount
        and pr.payment_method::text = case v_evidence.evidence_source when 'unc' then 'bank_transfer' else 'cash' end
        and (
          (pr.created_at >= v_start_utc and pr.created_at < v_end_utc)
          or (
            v_evidence.file_id is not null
            and strpos(concat_ws(' ', pr.image_url, pr.description, pr.notes, pr.title), v_evidence.file_id) > 0
          )
        );

      if v_match_count = 0 then
        v_match_blocker := 'supplier_amount_no_match';
      elsif v_match_count > 1 then
        v_match_blocker := 'supplier_amount_ambiguous';
      else
        v_match_id := v_candidate_ids[1];
      end if;
    else
      v_match_strategy := 'amount';
      select count(*), array_agg(pr.id order by pr.id)

      into v_match_count, v_candidate_ids
      from public.payment_requests pr
      where pr.status::text in ('pending', 'approved')
        and pr.total_amount = v_evidence.amount
        and pr.payment_method::text = case v_evidence.evidence_source when 'unc' then 'bank_transfer' else 'cash' end
        and (
          (pr.created_at >= v_start_utc and pr.created_at < v_end_utc)
          or (
            v_evidence.file_id is not null
            and strpos(concat_ws(' ', pr.image_url, pr.description, pr.notes, pr.title), v_evidence.file_id) > 0
          )
        );

      if v_match_count = 0 then
        v_match_blocker := 'amount_no_match';
      elsif v_match_count > 1 then
        v_match_blocker := 'amount_ambiguous';
      else
        v_match_id := v_candidate_ids[1];
      end if;
    end if;

    if v_match_id is not null and exists (
      select 1
      from public.finance_payment_auto_approval_matches prior_match
      where prior_match.run_id = v_run_id
        and prior_match.payment_request_id = v_match_id
        and prior_match.match_status in ('matched', 'already_approved')
    ) then
      v_match_blocker := 'duplicate_payment_request_match';
      v_match_status := 'blocked';
      v_match_id := null;
    end if;

    if v_match_id is not null then
      select pr.status::text
      into v_match_status
      from public.payment_requests pr
      where pr.id = v_match_id;

      if v_match_status = 'approved' then
        v_match_status := 'already_approved';
      else
        v_match_status := 'matched';
        insert into tmp_finance_auto_close_matched_prs(payment_request_id)
        values (v_match_id)
        on conflict do nothing;
      end if;
    else
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'code', v_match_blocker,
        'evidenceSource', v_evidence.evidence_source,
        'fileId', v_evidence.file_id,
        'amount', v_evidence.amount
      ));
    end if;

    insert into public.finance_payment_auto_approval_matches (
      run_id,
      payment_request_id,
      evidence_source,
      evidence_file_id,
      evidence_reference,
      evidence_amount,
      evidence_confidence,
      supplier_id,
      match_strategy,
      match_status,
      blocker,
      match_candidates,
      created_by,
      updated_by
    )
    values (
      v_run_id,
      v_match_id,
      v_evidence.evidence_source,
      v_evidence.file_id,
      v_evidence.reference,
      v_evidence.amount,
      v_evidence.confidence,
      v_evidence.supplier_id,
      v_match_strategy,
      v_match_status,
      v_match_blocker,
      to_jsonb(coalesce(v_candidate_ids, array[]::uuid[])),
      v_actor,
      v_actor
    );
  end loop;

  for v_pending in
    select pr.id, pr.request_number, pr.total_amount
    from public.payment_requests pr
    join tmp_finance_auto_close_scoped_pending_prs scoped on scoped.id = pr.id
    left join tmp_finance_auto_close_matched_prs matched on matched.payment_request_id = pr.id
    where matched.payment_request_id is null
  loop
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'unmatched_scoped_payment_request',
      'paymentRequestId', v_pending.id,
      'requestNumber', v_pending.request_number,
      'amount', v_pending.total_amount
    ));

    insert into public.finance_payment_auto_approval_matches (
      run_id,
      payment_request_id,
      evidence_source,
      match_strategy,
      match_status,
      blocker,
      created_by,
      updated_by
    )
    values (
      v_run_id,
      v_pending.id,
      'pending_scope',
      'pending_scope',
      'blocked',
      'unmatched_scoped_payment_request',
      v_actor,
      v_actor
    );
  end loop;

  for v_pending in
    select pr.id, pr.request_number, pr.purchase_order_id, pr.goods_receipt_id
    from public.payment_requests pr
    join tmp_finance_auto_close_matched_prs matched on matched.payment_request_id = pr.id
    where pr.status::text in ('pending', 'approved')
      and pr.purchase_order_id is not null
      and not exists (
        select 1
        from public.goods_receipts gr
        where (
            (pr.goods_receipt_id is not null and gr.id = pr.goods_receipt_id)
            or (pr.goods_receipt_id is null and gr.purchase_order_id = pr.purchase_order_id)
          )
          and gr.status::text = 'received'
      )
  loop
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'pending_receipt',
      'paymentRequestId', v_pending.id,
      'requestNumber', v_pending.request_number,
      'purchaseOrderId', v_pending.purchase_order_id
    ));

    insert into public.finance_payment_auto_approval_matches (
      run_id,
      payment_request_id,
      evidence_source,
      match_strategy,
      match_status,
      blocker,
      created_by,
      updated_by
    )
    values (
      v_run_id,
      v_pending.id,
      'pending_scope',
      'pending_scope',
      'blocked',
      'pending_receipt',
      v_actor,
      v_actor
    );
  end loop;

  if v_mode = 'enforced' and (not v_auto_approve_enabled or not v_auto_close_enabled) then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'setting_disabled',
      'message', 'finance_auto_approve_enabled and finance_auto_close_enabled must both be true for enforced mode'
    ));
  end if;

  if jsonb_array_length(v_blockers) > 0 then
    v_result := jsonb_build_object(
      'ok', false,
      'existing', false,
      'runId', v_run_id,
      'closingDate', p_closing_date,
      'mode', v_mode,
      'status', 'blocked',
      'decision', 'block',
      'blockers', v_blockers,
      'approvedPaymentRequestIds', '[]'::jsonb
    );

    update public.finance_daily_close_runs
    set status = 'blocked',
        decision = 'block',
        blockers = v_blockers,
        blocker_count = jsonb_array_length(v_blockers),
        match_count = (select count(*) from public.finance_payment_auto_approval_matches where run_id = v_run_id),
        approved_count = 0,
        approved_payment_request_ids = '[]'::jsonb,
        result = v_result,
        finished_at = now(),
        updated_at = now(),
        updated_by = v_actor
    where id = v_run_id;

    return v_result;
  end if;

  if v_mode = 'shadow' then
    select coalesce(jsonb_agg(payment_request_id order by payment_request_id), '[]'::jsonb)
    into v_approved_ids
    from tmp_finance_auto_close_matched_prs;

    v_result := jsonb_build_object(
      'ok', true,
      'existing', false,
      'runId', v_run_id,
      'closingDate', p_closing_date,
      'mode', v_mode,
      'status', 'succeeded',
      'decision', 'approve',
      'approvedPaymentRequestIds', v_approved_ids
    );

    update public.finance_daily_close_runs
    set status = 'succeeded',
        decision = 'approve',
        blockers = '[]'::jsonb,
        blocker_count = 0,
        match_count = (select count(*) from public.finance_payment_auto_approval_matches where run_id = v_run_id),
        approved_count = jsonb_array_length(v_approved_ids),
        approved_payment_request_ids = v_approved_ids,
        result = v_result,
        finished_at = now(),
        updated_at = now(),
        updated_by = v_actor
    where id = v_run_id;

    return v_result;
  end if;

  drop table if exists pg_temp.tmp_finance_auto_close_approved;
  create temporary table tmp_finance_auto_close_approved (
    id uuid primary key
  ) on commit drop;

  insert into tmp_finance_auto_close_approved(id)
  with updated as (
    update public.payment_requests pr
    set status = 'approved'::public.payment_request_status,
        approved_at = now(),
        approved_by = null,
        updated_at = now()
    from tmp_finance_auto_close_matched_prs targets
    where pr.id = targets.payment_request_id
      and pr.status = 'pending'::public.payment_request_status
    returning id
  )
  select id
  from updated;

  select coalesce(jsonb_agg(id order by id), '[]'::jsonb), count(*)
  into v_approved_ids, v_approved_count
  from tmp_finance_auto_close_approved;

  select * into v_declaration
  from public.ceo_daily_closing_declarations
  where id = v_declaration.id
  for update;

  v_audit_entry := jsonb_build_object(
    'action', 'finance_auto_close_day',
    'decision', 'approve',
    'mode', v_mode,
    'actor', v_actor,
    'time', now(),
    'runId', v_run_id,
    'approved_payment_request_ids', v_approved_ids
  );

  update public.ceo_daily_closing_declarations
  set extraction_meta = jsonb_set(
        coalesce(v_declaration.extraction_meta, '{}'::jsonb)
          || jsonb_build_object(
            'close_approval_locked', true,
            'close_decision', 'approve',
            'close_actor', v_actor,
            'close_time', now(),
            'close_run_id', v_run_id,
            'qtm_opening_balance', v_qtm_opening,
            'qtm_spent_from_folder', v_qtm_spent,
            'qtm_closing_balance', v_qtm_closing
          ),
        '{finance_auto_close_audit_log}',
        coalesce(v_declaration.extraction_meta->'finance_auto_close_audit_log', '[]'::jsonb)
          || jsonb_build_array(v_audit_entry),
        true
      ),
      updated_at = now()
  where id = v_declaration.id;

  v_result := jsonb_build_object(
    'ok', true,
    'existing', false,
    'runId', v_run_id,
    'closingDate', p_closing_date,
    'mode', v_mode,
    'status', 'succeeded',
    'decision', 'approve',
    'blockers', '[]'::jsonb,
    'approvedPaymentRequestIds', v_approved_ids
  );

  update public.finance_daily_close_runs
  set status = 'succeeded',
      decision = 'approve',
      blockers = '[]'::jsonb,
      blocker_count = 0,
      match_count = (select count(*) from public.finance_payment_auto_approval_matches where run_id = v_run_id),
      approved_count = v_approved_count,
      approved_payment_request_ids = v_approved_ids,
      result = v_result,
      finished_at = now(),
      updated_at = now(),
      updated_by = v_actor
  where id = v_run_id;

  return v_result;
end;
$$;

revoke all on function public.finance_auto_close_day(date, text, jsonb, text) from public;
revoke all on function public.finance_auto_close_day(date, text, jsonb, text) from anon, authenticated;
grant execute on function public.finance_auto_close_day(date, text, jsonb, text) to service_role;
