-- ============================================================================
-- Migration: Chi lương — CEO up nhiều ảnh chuyển khoản cho một phiếu
--
-- A pending salary payout can now be advanced with 1..10 CEO transfer slips
-- instead of a single slip. This migration:
--   (1) adds public.salary_payout_ceo_evidence: one row per slip, ordered by
--       position, unique by sha256 across every payout. RLS is enabled with no
--       direct policy; only SECURITY DEFINER functions read/write it;
--   (2) replaces record_salary_payout_ceo_payment(uuid, jsonb, text) keeping the
--       signature, owner check, idempotency and Zalo enqueue. p_evidence accepts
--       the old single object or a 1..10 object array. Every slip is validated,
--       duplicate/reused sha256 are rejected with 'evidence_reused', all rows
--       are inserted, and salary_payouts keeps the first slip for backward
--       compatibility;
--   (3) replaces get_salary_payout(uuid) with the same shape plus a
--       'ceo_evidence' array ordered by position. Legacy rows without evidence
--       rows fall back to a one-item array from ceo_evidence_storage_path;
--   (4) backfills one position-0 row for every existing payout that already has
--       a CEO storage path and a valid sha256.
--
-- Idempotent: table/index use IF NOT EXISTS and functions CREATE OR REPLACE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. CEO transfer slip rows (one per uploaded image).
-- ---------------------------------------------------------------------------
create table if not exists public.salary_payout_ceo_evidence (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.salary_payouts(id) on delete cascade,
  storage_path text not null,
  file_sha256 text not null unique check (file_sha256 ~ '^[0-9a-f]{64}$'),
  ocr_amount numeric check (ocr_amount is null or ocr_amount > 0),
  position int not null,
  created_at timestamptz default now(),
  created_by uuid
);

create index if not exists idx_salary_payout_ceo_evidence_payout
  on public.salary_payout_ceo_evidence (payout_id, position);

comment on table public.salary_payout_ceo_evidence is
  'CEO bank-transfer slips attached to a salary payout, ordered by position. file_sha256 is unique across every payout. Rows are written only by record_salary_payout_ceo_payment (SECURITY DEFINER); clients never read or write the table directly.';

-- RLS + explicit grants: there is no direct policy, so access is only through
-- the SECURITY DEFINER functions below. service_role keeps select/insert for
-- operational tooling, as the latest salary migrations do.
alter table public.salary_payout_ceo_evidence enable row level security;

revoke all on public.salary_payout_ceo_evidence from public, anon, authenticated;
grant select, insert on public.salary_payout_ceo_evidence to service_role;

-- Backfill the legacy single slip as position 0 (its OCR amount was never kept
-- on salary_payouts, so it is null).
insert into public.salary_payout_ceo_evidence (
  payout_id, storage_path, file_sha256, ocr_amount, position, created_by
)
select
  sp.id,
  sp.ceo_evidence_storage_path,
  lower(sp.ceo_evidence_sha256),
  null,
  0,
  sp.ceo_paid_by
from public.salary_payouts sp
where sp.ceo_evidence_storage_path is not null
  and sp.ceo_evidence_sha256 is not null
  and lower(sp.ceo_evidence_sha256) ~ '^[0-9a-f]{64}$'
on conflict (file_sha256) do nothing;

-- ---------------------------------------------------------------------------
-- 2. record_salary_payout_ceo_payment — same signature, 1..10 slips.
-- ---------------------------------------------------------------------------
create or replace function public.record_salary_payout_ceo_payment(
  p_id uuid,
  p_evidence jsonb,
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
  v_payload jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_items jsonb := '[]'::jsonb;
  v_storage_path text;
  v_file_sha256 text;
  v_ocr_amount numeric;
  v_evidence_result jsonb := '[]'::jsonb;
  v_sp public.salary_payouts%rowtype;
  v_result jsonb;
begin
  if not (v_is_service or (v_actor is not null and public.has_role(v_actor, 'owner'))) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_id is null then
    raise exception 'payout_id_required' using errcode = '22023';
  end if;
  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;

  select result into v_prior
  from public.salary_payout_idempotency
  where idempotency_key = v_key;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  perform pg_advisory_xact_lock(hashtext('salary_payout_ceo:' || v_key));

  select result into v_prior
  from public.salary_payout_idempotency
  where idempotency_key = v_key;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  -- Old shape: one evidence object. New shape: a jsonb array of 1..10 objects.
  if jsonb_typeof(v_payload) = 'object' then
    v_items := jsonb_build_array(v_payload);
  elsif jsonb_typeof(v_payload) = 'array' then
    v_items := v_payload;
  else
    raise exception 'evidence_required' using errcode = '22023';
  end if;

  if jsonb_array_length(v_items) = 0 then
    raise exception 'evidence_required' using errcode = '22023';
  end if;
  if jsonb_array_length(v_items) > 10 then
    raise exception 'invalid_evidence' using errcode = '22023', detail = 'too_many';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_items) e
    where jsonb_typeof(e) <> 'object'
  ) then
    raise exception 'evidence_required' using errcode = '22023';
  end if;

  -- Every item needs a non-blank storage path and sha256.
  if exists (
    select 1
    from jsonb_array_elements(v_items) e
    where nullif(btrim(coalesce(e->>'storage_path', '')), '') is null
       or nullif(btrim(coalesce(e->>'file_sha256', '')), '') is null
  ) then
    raise exception 'evidence_required' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_items) e
    where lower(btrim(e->>'file_sha256')) !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'invalid_evidence_sha256' using errcode = '22023';
  end if;

  -- Same OCR amount rule as the old single-slip RPC.
  if exists (
    select 1
    from jsonb_array_elements(v_items) e
    where e ? 'ocr_amount'
      and case
        when jsonb_typeof(e->'ocr_amount') = 'number'
          then (e->>'ocr_amount')::numeric <= 0
        else false
      end
  ) then
    raise exception 'invalid_evidence_amount' using errcode = '22023';
  end if;

  -- The same sha256 may not appear twice in one request.
  if (
    select count(*) <> count(distinct lower(btrim(e->>'file_sha256')))
    from jsonb_array_elements(v_items) e
  ) then
    raise exception 'evidence_reused' using errcode = 'P0001',
      detail = 'duplicate_in_request';
  end if;

  -- A sha256 already used by any payout (new evidence table or the legacy
  -- salary_payouts column) can never be reused.
  if exists (
    select 1
    from jsonb_array_elements(v_items) e
    join public.salary_payout_ceo_evidence se
      on se.file_sha256 = lower(btrim(e->>'file_sha256'))
  ) or exists (
    select 1
    from jsonb_array_elements(v_items) e
    join public.salary_payouts sp
      on lower(sp.ceo_evidence_sha256) = lower(btrim(e->>'file_sha256'))
  ) then
    raise exception 'evidence_reused' using errcode = 'P0001';
  end if;

  select * into v_sp
  from public.salary_payouts
  where id = p_id
  for update;
  if not found then
    raise exception 'payout_not_found' using errcode = 'P0002';
  end if;
  if v_sp.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'P0001',
      detail = format('status=%s', v_sp.status);
  end if;

  v_storage_path := btrim(v_items->0->>'storage_path');
  v_file_sha256 := lower(btrim(v_items->0->>'file_sha256'));

  begin
    insert into public.salary_payout_ceo_evidence (
      payout_id, storage_path, file_sha256, ocr_amount, position, created_by
    )
    select
      p_id,
      btrim(e->>'storage_path'),
      lower(btrim(e->>'file_sha256')),
      case
        when e ? 'ocr_amount' and jsonb_typeof(e->'ocr_amount') = 'number'
          then (e->>'ocr_amount')::numeric
        else null
      end,
      (ord - 1)::int,
      v_actor
    from jsonb_array_elements(v_items) with ordinality as t(e, ord);
  exception when unique_violation then
    raise exception 'evidence_reused' using errcode = 'P0001';
  end;

  -- Keep the first slip in the legacy columns for old readers.
  begin
    update public.salary_payouts
    set status = 'advanced',
        ceo_evidence_storage_path = v_storage_path,
        ceo_evidence_sha256 = v_file_sha256,
        ceo_paid_at = now(),
        ceo_paid_by = v_actor
    where id = p_id;
  exception when unique_violation then
    raise exception 'evidence_reused' using errcode = 'P0001';
  end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'storage_path', btrim(t.e->>'storage_path'),
    'file_sha256', lower(btrim(t.e->>'file_sha256')),
    'ocr_amount', case
      when t.e ? 'ocr_amount' and jsonb_typeof(t.e->'ocr_amount') = 'number'
        then (t.e->>'ocr_amount')::numeric
      else null
    end
  ) order by t.ord), '[]'::jsonb)
  into v_evidence_result
  from jsonb_array_elements(v_items) with ordinality as t(e, ord);

  insert into public.finance_zalo_notifications (
    event_type, entity_id, group_key, message_body, status
  ) values (
    'salary_payout_advanced',
    p_id,
    'finance',
    coalesce(
      public.build_finance_zalo_salary_payout_message(p_id, 'salary_payout_advanced'),
      'Chi lương đã nhận tiền mặt: ' || v_sp.payout_number
    ),
    'pending'
  )
  on conflict (event_type, entity_id) do nothing;

  v_result := jsonb_build_object(
    'payout_id', p_id,
    'payout_number', v_sp.payout_number,
    'status', 'advanced',
    'ceo_evidence_storage_path', v_storage_path,
    'ceo_evidence_sha256', v_file_sha256,
    'ceo_evidence', v_evidence_result,
    'idempotent', false
  );

  insert into public.salary_payout_idempotency (
    idempotency_key, payout_id, result, created_by
  ) values (
    v_key, p_id, v_result, v_actor
  )
  on conflict (idempotency_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.record_salary_payout_ceo_payment(uuid, jsonb, text) from public, anon;
grant execute on function public.record_salary_payout_ceo_payment(uuid, jsonb, text) to authenticated, service_role;

comment on function public.record_salary_payout_ceo_payment(uuid, jsonb, text) is
  'Owner only (or service_role): record 1..10 CEO cash transfer slips for a pending payout -> advanced and enqueue salary_payout_advanced without any amount. p_evidence may be one object (legacy shape) or an array of {storage_path, file_sha256, ocr_amount?}; every sha256 must be new across all payouts. The first slip is kept in salary_payouts.ceo_evidence_storage_path/ceo_evidence_sha256 and the result includes the full ceo_evidence array. Idempotent by key.';

-- ---------------------------------------------------------------------------
-- 3. get_salary_payout — same shape, plus the full ordered CEO slip array.
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
  v_attachments jsonb := '[]'::jsonb;
  v_exclusions jsonb := '[]'::jsonb;
  v_ceo_evidence jsonb := '[]'::jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'payout_id', a.payout_id,
    'storage_path', a.storage_path,
    'file_name', a.file_name,
    'mime_type', a.mime_type,
    'size_bytes', a.size_bytes,
    'file_sha256', a.file_sha256,
    'uploaded_by', a.uploaded_by,
    'created_at', a.created_at
  ) order by a.created_at), '[]'::jsonb)
  into v_attachments
  from public.salary_payout_attachments a
  where a.payout_id = p_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'employee_code', e.employee_code,
    'employee_name', e.employee_name,
    'net_pay', e.net_pay,
    'reason', e.reason,
    'created_by', e.created_by,
    'created_at', e.created_at
  ) order by e.employee_code), '[]'::jsonb)
  into v_exclusions
  from public.salary_payout_exclusions e
  where e.payout_id = p_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'storage_path', e.storage_path,
    'file_sha256', e.file_sha256,
    'ocr_amount', e.ocr_amount
  ) order by e.position, e.created_at), '[]'::jsonb)
  into v_ceo_evidence
  from public.salary_payout_ceo_evidence e
  where e.payout_id = p_id;

  -- Legacy payouts have no evidence rows yet: expose the old single slip.
  if v_ceo_evidence = '[]'::jsonb and v_sp.ceo_evidence_storage_path is not null then
    v_ceo_evidence := jsonb_build_array(jsonb_build_object(
      'storage_path', v_sp.ceo_evidence_storage_path,
      'file_sha256', v_sp.ceo_evidence_sha256,
      'ocr_amount', null
    ));
  end if;

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
      'ceo_evidence', coalesce(v_ceo_evidence, '[]'::jsonb),
      'ceo_paid_at', v_sp.ceo_paid_at,
      'ceo_paid_by', v_sp.ceo_paid_by,
      'completed_at', v_sp.completed_at,
      'completed_by', v_sp.completed_by,
      'created_by', v_sp.created_by,
      'created_at', v_sp.created_at,
      'note', v_sp.note
    ),
    'lines', coalesce(v_lines, '[]'::jsonb),
    'receipts', coalesce(v_receipts, '[]'::jsonb),
    'attachments', coalesce(v_attachments, '[]'::jsonb),
    'exclusions', coalesce(v_exclusions, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_salary_payout(uuid) from public, anon;
grant execute on function public.get_salary_payout(uuid) to authenticated, service_role;

comment on function public.get_salary_payout(uuid) is
  'Owner / salary_cash view (or service_role): salary payout header (incl. source and the ordered ceo_evidence array, falling back to the legacy single slip), employee lines (incl. note), uploaded receipts, supporting attachments and the excluded employees (with reasons) ordered by employee_code/created_at.';
