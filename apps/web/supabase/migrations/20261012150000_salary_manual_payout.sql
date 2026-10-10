-- ============================================================================
-- Migration: Lương lẻ — Chi lương nhập tay (manual salary payout)
--
-- Adds a second source to public.salary_payouts besides the payroll Q7 period
-- snapshot:
--   * source = 'payroll_q7' (default, one non-cancelled payout per period);
--   * source = 'manual'    (Lương lẻ: the chief accountant types 1..50 people
--     who are not on the Bếp Q7 payroll; payroll_period_id is null and the
--     title is stored in period_name).
--
-- Manual rows reuse every existing piece of the salary flow unchanged:
-- get_salary_payout, record_salary_payout_ceo_payment,
-- submit_salary_payout_matches, discard_salary_payout_receipt,
-- cancel_salary_payout, the salary-payout edge function (receipts), the RLS
-- policies and the amount-free Zalo builders. It also adds the SECURITY DEFINER
-- RPC create_manual_salary_payout and an audit_logs entry.
--
-- payroll_bn_* is never read or written here. No outbox message carries an
-- amount: only the payout number, the (title) period name, the employee count
-- and the detail link.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. salary_payouts: source + nullable period + source/period coherence.
--
-- The Q7 create RPC inserts without a source, so existing and future payroll
-- rows take the 'payroll_q7' default. Manual rows leave payroll_period_id null.
-- ---------------------------------------------------------------------------
alter table public.salary_payouts
  add column if not exists source text not null default 'payroll_q7';

-- Defensive: keep the default/not-null if the column somehow already existed.
alter table public.salary_payouts
  alter column source set default 'payroll_q7';
alter table public.salary_payouts
  alter column source set not null;

alter table public.salary_payouts
  drop constraint if exists salary_payouts_source_check;
alter table public.salary_payouts
  add constraint salary_payouts_source_check
  check (source in ('payroll_q7', 'manual'));

alter table public.salary_payouts
  alter column payroll_period_id drop not null;

alter table public.salary_payouts
  drop constraint if exists salary_payouts_source_period_check;
alter table public.salary_payouts
  add constraint salary_payouts_source_period_check
  check (
    (source = 'payroll_q7' and payroll_period_id is not null)
    or (source = 'manual' and payroll_period_id is null)
  );

-- The one-non-cancelled-payout-per-period guarantee lives in the Q7 RPC guard
-- (create_salary_payout checks payroll_period_id = p_period_id). A manual row
-- has payroll_period_id null, so the guard never matches manual rows and the
-- Q7 rule is preserved without a new unique index.

-- ---------------------------------------------------------------------------
-- 2. salary_payout_lines: optional free-text note for a manual line.
-- ---------------------------------------------------------------------------
alter table public.salary_payout_lines
  add column if not exists note text;

-- ---------------------------------------------------------------------------
-- 3. get_salary_payout — same signature and output keys, plus source and the
--    line note.
-- ---------------------------------------------------------------------------
create or replace function public.get_salary_payout(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_sp public.salary_payouts%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_receipts jsonb := '[]'::jsonb;
begin
  if not (
    (
      v_uid is not null
      and (
        public.has_role(v_uid, 'owner')
        or public.has_module_permission(v_uid, 'salary_cash', 'view')
      )
    )
    or public.material_master_jwt_role() = 'service_role'
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_sp from public.salary_payouts where id = p_id;
  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id,
    'payout_id', l.payout_id,
    'employee_code', l.employee_code,
    'employee_name', l.employee_name,
    'net_pay', l.net_pay,
    'note', l.note,
    'receipt_storage_path', l.receipt_storage_path,
    'receipt_sha256', l.receipt_sha256,
    'receipt_amount', l.receipt_amount,
    'receipt_beneficiary', l.receipt_beneficiary,
    'receipt_reference', l.receipt_reference,
    'matched_at', l.matched_at,
    'matched_by', l.matched_by
  ) order by l.employee_code), '[]'::jsonb)
  into v_lines
  from public.salary_payout_lines l
  where l.payout_id = p_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'payout_id', r.payout_id,
    'storage_path', r.storage_path,
    'file_sha256', r.file_sha256,
    'ocr_amount', r.ocr_amount,
    'ocr_beneficiary', r.ocr_beneficiary,
    'ocr_reference', r.ocr_reference,
    'ocr_error', r.ocr_error,
    'status', r.status,
    'uploaded_by', r.uploaded_by,
    'created_at', r.created_at
  ) order by r.created_at), '[]'::jsonb)
  into v_receipts
  from public.salary_payout_receipts r
  where r.payout_id = p_id;

  return jsonb_build_object(
    'payout', jsonb_build_object(
      'id', v_sp.id,
      'payout_number', v_sp.payout_number,
      'payroll_period_id', v_sp.payroll_period_id,
      'source', v_sp.source,
      'period_name', v_sp.period_name,
      'employee_count', v_sp.employee_count,
      'total_amount', v_sp.total_amount,
      'status', v_sp.status,
      'ceo_evidence_storage_path', v_sp.ceo_evidence_storage_path,
      'ceo_evidence_sha256', v_sp.ceo_evidence_sha256,
      'ceo_paid_at', v_sp.ceo_paid_at,
      'ceo_paid_by', v_sp.ceo_paid_by,
      'completed_at', v_sp.completed_at,
      'completed_by', v_sp.completed_by,
      'created_by', v_sp.created_by,
      'created_at', v_sp.created_at,
      'note', v_sp.note
    ),
    'lines', coalesce(v_lines, '[]'::jsonb),
    'receipts', coalesce(v_receipts, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_salary_payout(uuid) from public, anon;
grant execute on function public.get_salary_payout(uuid) to authenticated, service_role;

comment on function public.get_salary_payout(uuid) is
  'Owner / salary_cash view (or service_role): salary payout header (incl. source), employee lines (incl. note) and uploaded receipts.';

-- ---------------------------------------------------------------------------
-- 4. create_manual_salary_payout — type 1..50 manual (Lương lẻ) lines.
--
-- Same advisory lock / idempotency ledger / SAL-YYMMDD-NN sequence as the Q7
-- path, so both sources share one payout-number space and one replay ledger.
-- ---------------------------------------------------------------------------
create or replace function public.create_manual_salary_payout(
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_prior jsonb;
  v_title text;
  v_lines jsonb;
  v_line jsonb;
  v_row jsonb;
  v_index integer := 0;
  v_count integer := 0;
  v_total numeric := 0;
  v_amount numeric;
  v_name text;
  v_code text;
  v_note text;
  v_used_codes text[] := '{}';
  v_generated integer := 0;
  v_candidate text;
  v_lines_out jsonb := '[]'::jsonb;
  v_day text;
  v_seq integer;
  v_payout_number text;
  v_payout_id uuid;
  v_attempt integer := 0;
  v_result jsonb;
  i integer;
begin
  if not (
    v_is_service
    or (
      v_actor is not null
      and (
        public.has_role(v_actor, 'owner')
        or public.has_module_permission(v_actor, 'salary_cash', 'edit')
      )
    )
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;

  -- Idempotent replay (checked before and after the advisory lock).
  select result into v_prior
  from public.salary_payout_idempotency
  where idempotency_key = v_key;
  if found then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  perform pg_advisory_xact_lock(hashtext('salary_payout_create:' || v_key));

  select result into v_prior
  from public.salary_payout_idempotency
  where idempotency_key = v_key;
  if found then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  v_title := btrim(coalesce(p_payload->>'title', ''));
  if v_title = '' then
    raise exception 'title_required' using errcode = '22023';
  end if;
  if char_length(v_title) > 120 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;

  v_lines := p_payload->'lines';
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;
  if jsonb_array_length(v_lines) < 1 then
    raise exception 'lines_required' using errcode = '22023';
  end if;
  if jsonb_array_length(v_lines) > 50 then
    raise exception 'too_many_lines' using errcode = '22023';
  end if;

  -- Validate every line, compute the total and stage the normalised rows.
  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_index := v_index + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'invalid_lines' using errcode = '22023',
        detail = format('line_index=%s', v_index);
    end if;

    v_name := btrim(coalesce(v_line->>'employee_name', ''));
    if v_name = '' then
      raise exception 'employee_name_required' using errcode = '22023',
        detail = format('line_index=%s', v_index);
    end if;
    if char_length(v_name) > 120 then
      raise exception 'invalid_employee_name' using errcode = '22023',
        detail = format('line_index=%s', v_index);
    end if;

    if not (v_line ? 'amount') or jsonb_typeof(v_line->'amount') <> 'number' then
      raise exception 'invalid_amount' using errcode = '22023',
        detail = format('line_index=%s', v_index);
    end if;
    v_amount := (v_line->>'amount')::numeric;
    if v_amount is null
       or v_amount <> trunc(v_amount)
       or v_amount < 1
       or v_amount > 200000000 then
      raise exception 'invalid_amount' using errcode = '22023',
        detail = format('line_index=%s', v_index);
    end if;

    v_code := nullif(btrim(coalesce(v_line->>'employee_code', '')), '');
    v_note := nullif(btrim(coalesce(v_line->>'note', '')), '');

    v_lines_out := v_lines_out || jsonb_build_object(
      'employee_code', v_code,
      'employee_name', v_name,
      'amount', v_amount,
      'note', v_note
    );

    v_total := v_total + v_amount;
  end loop;

  if v_total > 2000000000 then
    raise exception 'total_exceeds_limit' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(v_lines_out);

  -- Reserve the supplied codes, then fill the missing ones with LL-01.. (never
  -- reusing a supplied/generated code, so each line is unique per payout).
  for v_row in select value from jsonb_array_elements(v_lines_out) loop
    v_code := nullif(btrim(coalesce(v_row->>'employee_code', '')), '');
    if v_code is not null then
      if v_code = any(v_used_codes) then
        raise exception 'duplicate_employee_code' using errcode = '22023';
      end if;
      v_used_codes := array_append(v_used_codes, v_code);
    end if;
  end loop;

  for i in 0 .. v_count - 1 loop
    v_row := v_lines_out->i;
    if nullif(btrim(coalesce(v_row->>'employee_code', '')), '') is null then
      loop
        v_generated := v_generated + 1;
        v_candidate := 'LL-' || lpad(v_generated::text, 2, '0');
        exit when not (v_candidate = any(v_used_codes));
      end loop;
      v_used_codes := array_append(v_used_codes, v_candidate);
      v_lines_out := jsonb_set(
        v_lines_out,
        array[i::text, 'employee_code'],
        to_jsonb(v_candidate)
      );
    end if;
  end loop;

  -- SAL-YYMMDD-NN from the same sequence/lock as the Q7 path.
  v_day := to_char((now() at time zone 'Asia/Ho_Chi_Minh'), 'YYMMDD');
  perform pg_advisory_xact_lock(hashtext('salary_payout_number:' || v_day));

  loop
    v_attempt := v_attempt + 1;
    select coalesce(max(right(sp.payout_number, 2)::integer), 0) + 1
      into v_seq
    from public.salary_payouts sp
    where sp.payout_number like 'SAL-' || v_day || '-%';
    v_payout_number := 'SAL-' || v_day || '-' || lpad(v_seq::text, 2, '0');

    begin
      insert into public.salary_payouts (
        payout_number,
        payroll_period_id,
        period_name,
        employee_count,
        total_amount,
        status,
        created_by,
        source
      ) values (
        v_payout_number,
        null,
        v_title,
        v_count,
        v_total,
        'pending',
        v_actor,
        'manual'
      )
      returning id into v_payout_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.salary_payout_lines (
    payout_id, employee_code, employee_name, net_pay, note
  )
  select
    v_payout_id,
    l->>'employee_code',
    l->>'employee_name',
    (l->>'amount')::numeric,
    nullif(l->>'note', '')
  from jsonb_array_elements(v_lines_out) l;

  -- Exactly like the Q7 path: salary_payout_created, never any amount.
  insert into public.finance_zalo_notifications (
    event_type, entity_id, group_key, message_body, status
  ) values (
    'salary_payout_created',
    v_payout_id,
    'finance',
    coalesce(
      public.build_finance_zalo_salary_payout_message(v_payout_id, 'salary_payout_created'),
      'Chi lương: ' || v_payout_number
    ),
    'pending'
  )
  on conflict (event_type, entity_id) do nothing;

  -- Audited: append one actor/time row (internal ledger, not an outbox message).
  insert into public.audit_logs (actor_id, action, target_id, metadata)
  values (
    v_actor,
    'salary_payout_manual_created',
    v_payout_id,
    jsonb_build_object(
      'source', 'manual',
      'title', v_title,
      'employee_count', v_count,
      'total_amount', v_total,
      'changed_at', now()
    )
  );

  v_result := jsonb_build_object(
    'payout_id', v_payout_id,
    'payout_number', v_payout_number,
    'period_name', v_title,
    'employee_count', v_count,
    'total_amount', v_total,
    'status', 'pending',
    'source', 'manual',
    'replayed', false
  );

  insert into public.salary_payout_idempotency (
    idempotency_key, payout_id, result, created_by
  ) values (
    v_key, v_payout_id, v_result, v_actor
  )
  on conflict (idempotency_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.create_manual_salary_payout(jsonb, text) from public, anon;
grant execute on function public.create_manual_salary_payout(jsonb, text) to authenticated, service_role;

comment on function public.create_manual_salary_payout(jsonb, text) is
  'Owner / salary_cash edit (or service_role): create a pending manual (Lương lẻ) payout source=manual, payroll_period_id null, title in period_name, 1..50 typed employee lines (amount 1..200,000,000, total <= 2,000,000,000, employee_code given or generated LL-01..). Uses the same SAL-YYMMDD-NN sequence, advisory lock and idempotency ledger as the Q7 path, enqueues salary_payout_created without any amount and writes one audit_logs row. payroll_bn_* is never touched.';
