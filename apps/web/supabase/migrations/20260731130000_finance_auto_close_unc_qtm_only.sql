-- Correct finance daily close scope: CEO declaration versus Drive UNC/QTM only.
-- Invalidate stale successful shadow decisions produced by the broader legacy contract.

update public.finance_daily_close_runs
set status = 'failed',
    decision = 'block',
    result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
      'invalidatedBy', '20260731130000_finance_auto_close_unc_qtm_only',
      'reason', 'legacy_scope_removed'
    ),
    finished_at = coalesce(finished_at, now()),
    updated_at = now(),
    updated_by = 'migration_20260731130000'
where mode = 'shadow'
  and status = 'succeeded';

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
  v_prior_unclosed_declaration public.ceo_daily_closing_declarations%rowtype;
  v_previous_closing numeric := 0;
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
  v_auto_close_enabled boolean := false;
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
      'blockers', v_existing_run.blockers
    );
  end if;

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

  select * into v_prior_unclosed_declaration
  from public.ceo_daily_closing_declarations
  where closing_date < p_closing_date
    and coalesce(extraction_meta->>'close_approval_locked', 'false') <> 'true'
  order by closing_date asc
  limit 1;

  if found then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'prior_unclosed_day',
      'message', 'An earlier finance day is not closed',
      'priorClosingDate', v_prior_unclosed_declaration.closing_date
    ));
  end if;

  select * into v_previous_declaration
  from public.ceo_daily_closing_declarations
  where closing_date < p_closing_date
  order by closing_date desc
  limit 1;

  if found then
    if coalesce(v_previous_declaration.extraction_meta->>'close_approval_locked', 'false') = 'true' then
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

  select coalesce((select value::boolean from public.app_settings where key = 'finance_auto_close_enabled'), false)
    into v_auto_close_enabled;

  drop table if exists pg_temp.tmp_finance_auto_close_evidence;
  create temporary table tmp_finance_auto_close_evidence (
    evidence_source text not null,
    evidence jsonb not null,
    file_id text,
    amount numeric not null,
    confidence numeric not null
  ) on commit drop;

  insert into tmp_finance_auto_close_evidence (evidence_source, evidence, file_id, amount, confidence)
  select 'unc', e.value, nullif(e.value->>'fileId', ''), coalesce(nullif(e.value->>'amount', '')::numeric, 0), coalesce(nullif(e.value->>'confidence', '')::numeric, 0)
  from jsonb_array_elements(v_unc_evidence) as e(value)
  union all
  select 'qtm', e.value, nullif(e.value->>'fileId', ''), coalesce(nullif(e.value->>'amount', '')::numeric, 0), coalesce(nullif(e.value->>'confidence', '')::numeric, 0)
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

  if v_mode = 'enforced' and not v_auto_close_enabled then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'setting_disabled',
      'message', 'finance_auto_close_enabled must be true for enforced mode'
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
      'blockers', v_blockers
    );

    update public.finance_daily_close_runs
    set status = 'blocked',
        decision = 'block',
        blockers = v_blockers,
        blocker_count = jsonb_array_length(v_blockers),
        result = v_result,
        finished_at = now(),
        updated_at = now(),
        updated_by = v_actor
    where id = v_run_id;

    return v_result;
  end if;

  if v_mode = 'shadow' then
    v_result := jsonb_build_object(
      'ok', true,
      'existing', false,
      'runId', v_run_id,
      'closingDate', p_closing_date,
      'mode', v_mode,
      'status', 'succeeded',
      'decision', 'approve',
      'blockers', '[]'::jsonb,
      'uncEvidenceSum', v_unc_evidence_sum,
      'qtmEvidenceSum', v_qtm_evidence_sum
    );

    update public.finance_daily_close_runs
    set status = 'succeeded',
        decision = 'approve',
        blockers = '[]'::jsonb,
        blocker_count = 0,
        result = v_result,
        finished_at = now(),
        updated_at = now(),
        updated_by = v_actor
    where id = v_run_id;

    return v_result;
  end if;

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
    'unc_evidence_sum', v_unc_evidence_sum,
    'qtm_evidence_sum', v_qtm_evidence_sum
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
    'closedDeclarationId', v_declaration.id
  );

  update public.finance_daily_close_runs
  set status = 'succeeded',
      decision = 'approve',
      blockers = '[]'::jsonb,
      blocker_count = 0,
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
