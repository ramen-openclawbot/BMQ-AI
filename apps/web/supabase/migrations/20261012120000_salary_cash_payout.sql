-- ============================================================================
-- Migration: Chi lương tiền mặt cho KTT (salary cash payout)
--
-- A private cash-salary payout flow for the Bếp BN payroll (payroll_bn_*),
-- separate from payment_requests / cash settlement / UNC:
--   (1) registers the 'salary_cash' module key in the UI permission list and
--       grants it to nobody here (no DB CHECK/registry exists for module keys);
--   (2) adds public.salary_payouts / salary_payout_lines /
--       salary_payout_receipts / salary_payout_idempotency;
--   (3) adds the SECURITY DEFINER RPCs create_salary_payout,
--       get_salary_payout, record_salary_payout_ceo_payment,
--       submit_salary_payout_matches, discard_salary_payout_receipt and
--       cancel_salary_payout, plus the salary_payout_* Zalo outbox events.
--
-- The payout snapshots net_pay per employee from the published payslips of one
-- payroll_bn period. payroll_bn data is only read, never modified. Every Zalo
-- message body carries NO amount: only the payout number, period name, employee
-- count and the detail link https://ai.banhmique.vn/salary-payouts/<id>.
--
-- Status flow: pending -> advanced (CEO transfer slip recorded) -> completed
-- (every employee line matched to a receipt for its full net pay). 'cancelled'
-- is the owner-only terminal state from pending.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Module key registration.
--
-- There is no database CHECK constraint or registry table for module keys:
-- public.user_module_permissions.module_key is free text and
-- public.has_module_permission() matches by equality. The UI source of truth is
-- ALL_MODULES / ALL_MODULE_KEYS in src/hooks/useUserManagement.ts, where
-- 'salary_cash' (label 'Chi lương') is added without any default view/edit
-- grant, so the key is registered and granted to nobody.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- One cash payout per published payroll_bn period.
create table if not exists public.salary_payouts (
  id uuid primary key default gen_random_uuid(),
  payout_number text not null,
  payroll_period_id uuid not null references public.payroll_bn_periods(id) on delete restrict,
  period_name text not null,
  employee_count integer not null,
  total_amount numeric(15,2) not null,
  status text not null default 'pending',
  ceo_evidence_storage_path text,
  ceo_evidence_sha256 text,
  ceo_paid_at timestamptz,
  ceo_paid_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  note text,
  constraint salary_payouts_status_check
    check (status in ('pending', 'advanced', 'completed', 'cancelled')),
  constraint salary_payouts_employee_count_check check (employee_count > 0),
  constraint salary_payouts_total_amount_check check (total_amount > 0),
  constraint salary_payouts_payout_number_unique unique (payout_number)
);

create unique index if not exists uq_salary_payouts_ceo_evidence_sha256
  on public.salary_payouts (ceo_evidence_sha256)
  where ceo_evidence_sha256 is not null;

create index if not exists idx_salary_payouts_period
  on public.salary_payouts (payroll_period_id, created_at desc);

-- One line per employee (net_pay > 0) of the snapshotted period.
create table if not exists public.salary_payout_lines (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.salary_payouts(id) on delete cascade,
  employee_code text not null,
  employee_name text not null,
  net_pay numeric(15,2) not null,
  receipt_storage_path text,
  receipt_sha256 text,
  receipt_amount numeric(15,2),
  receipt_beneficiary text,
  receipt_reference text,
  matched_at timestamptz,
  matched_by uuid references auth.users(id) on delete set null,
  constraint salary_payout_lines_net_pay_check check (net_pay > 0),
  constraint salary_payout_lines_receipt_amount_check
    check (receipt_amount is null or receipt_amount > 0),
  constraint salary_payout_lines_payout_employee_unique unique (payout_id, employee_code)
);

create unique index if not exists uq_salary_payout_lines_receipt_sha256
  on public.salary_payout_lines (receipt_sha256)
  where receipt_sha256 is not null;

create index if not exists idx_salary_payout_lines_payout
  on public.salary_payout_lines (payout_id, employee_code);

-- OCR drafts / uploaded employee receipts (the edge function inserts them with
-- the service role; clients never write here directly).
create table if not exists public.salary_payout_receipts (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.salary_payouts(id) on delete cascade,
  storage_path text not null,
  file_sha256 text not null,
  ocr_amount numeric,
  ocr_beneficiary text,
  ocr_reference text,
  ocr_error text,
  status text not null default 'uploaded',
  uploaded_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint salary_payout_receipts_status_check
    check (status in ('uploaded', 'matched', 'discarded')),
  constraint salary_payout_receipts_ocr_amount_check
    check (ocr_amount is null or ocr_amount > 0)
);

create unique index if not exists uq_salary_payout_receipts_file_sha256
  on public.salary_payout_receipts (file_sha256)
  where status <> 'discarded';

create index if not exists idx_salary_payout_receipts_payout
  on public.salary_payout_receipts (payout_id, created_at);

-- Server-side replay ledger for every RPC (never exposed to clients).
create table if not exists public.salary_payout_idempotency (
  idempotency_key text primary key,
  payout_id uuid not null references public.salary_payouts(id) on delete cascade,
  result jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.salary_payout_idempotency enable row level security;

-- ---------------------------------------------------------------------------
-- 2. RLS + explicit grants. No direct client write is possible: every writer is
--    a SECURITY DEFINER RPC. Reads need owner or salary_cash view.
-- ---------------------------------------------------------------------------
alter table public.salary_payouts enable row level security;
alter table public.salary_payout_lines enable row level security;
alter table public.salary_payout_receipts enable row level security;

revoke all on public.salary_payouts from public, anon, authenticated;
revoke all on public.salary_payout_lines from public, anon, authenticated;
revoke all on public.salary_payout_receipts from public, anon, authenticated;
revoke all on public.salary_payout_idempotency from public, anon, authenticated;

grant select on public.salary_payouts to authenticated;
grant select on public.salary_payout_lines to authenticated;
grant select on public.salary_payout_receipts to authenticated;
grant all on public.salary_payouts to service_role;
grant all on public.salary_payout_lines to service_role;
grant all on public.salary_payout_receipts to service_role;
grant all on public.salary_payout_idempotency to service_role;

drop policy if exists salary_payouts_select on public.salary_payouts;
create policy salary_payouts_select
  on public.salary_payouts
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'salary_cash', 'view')
  );

drop policy if exists salary_payout_lines_select on public.salary_payout_lines;
create policy salary_payout_lines_select
  on public.salary_payout_lines
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'salary_cash', 'view')
  );

drop policy if exists salary_payout_receipts_select on public.salary_payout_receipts;
create policy salary_payout_receipts_select
  on public.salary_payout_receipts
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'salary_cash', 'view')
  );

-- ---------------------------------------------------------------------------
-- 3. Zalo message builder (no amount is ever printed) + event check.
-- ---------------------------------------------------------------------------
create or replace function public.build_finance_zalo_salary_payout_message(
  p_payout_id uuid,
  p_event_type text
)
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_sp public.salary_payouts%rowtype;
  v_link text;
  v_title text;
begin
  select * into v_sp from public.salary_payouts where id = p_payout_id;
  if not found then
    return null;
  end if;

  v_link := 'https://ai.banhmique.vn/salary-payouts/' || v_sp.id::text;

  if p_event_type = 'salary_payout_created' then
    v_title := '💰 CHI LƯƠNG';
  elsif p_event_type = 'salary_payout_advanced' then
    v_title := '💵 CHI LƯƠNG — ĐÃ NHẬN TIỀN MẶT';
  elsif p_event_type = 'salary_payout_completed' then
    v_title := '✅ CHI LƯƠNG — HOÀN TẤT';
  else
    return null;
  end if;

  -- Intentionally no amount line: only the payout number, period name, employee
  -- count and the detail link.
  return concat_ws(
    E'\n',
    v_title,
    '',
    'Mã phiếu: ' || v_sp.payout_number,
    'Kỳ lương: ' || v_sp.period_name,
    'Số nhân viên: ' || v_sp.employee_count::text,
    '',
    'Xem chi tiết: ' || v_link
  );
end;
$$;

revoke all on function public.build_finance_zalo_salary_payout_message(uuid, text)
  from public, anon, authenticated;

alter table public.finance_zalo_notifications
  drop constraint if exists finance_zalo_notifications_event_type_check;

alter table public.finance_zalo_notifications
  add constraint finance_zalo_notifications_event_type_check
  check (event_type in (
    'payment_request_created',
    'payment_request_paid',
    'goods_receipt_received',
    'goods_receipt_short',
    'payment_submission_created',
    'payment_cash_advanced',
    'payment_cash_settled',
    'salary_payout_created',
    'salary_payout_advanced',
    'salary_payout_completed'
  ));

-- ---------------------------------------------------------------------------
-- 4. create_salary_payout — snapshot one published payroll_bn period.
-- ---------------------------------------------------------------------------
create or replace function public.create_salary_payout(
  p_period_id uuid,
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
  v_period public.payroll_bn_periods%rowtype;
  v_employee_count integer := 0;
  v_total numeric := 0;
  v_day text;
  v_seq integer;
  v_payout_number text;
  v_payout_id uuid;
  v_attempt integer := 0;
  v_result jsonb;
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

  if p_period_id is null then
    raise exception 'period_id_required' using errcode = '22023';
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

  select * into v_period
  from public.payroll_bn_periods
  where id = p_period_id;
  if not found then
    raise exception 'period_not_found' using errcode = 'P0002';
  end if;

  -- Published payslips are the only source; payroll_bn is never modified.
  if not exists (
    select 1
    from public.payroll_bn_payslips p
    where p.period_id = p_period_id
      and p.net_pay > 0
  ) then
    raise exception 'no_published_payslips' using errcode = 'P0001';
  end if;

  -- At most one live (non-cancelled) payout per period.
  if exists (
    select 1
    from public.salary_payouts sp
    where sp.payroll_period_id = p_period_id
      and sp.status <> 'cancelled'
  ) then
    raise exception 'payout_already_exists' using errcode = 'P0001';
  end if;

  select count(*), coalesce(sum(p.net_pay), 0)
    into v_employee_count, v_total
  from public.payroll_bn_payslips p
  where p.period_id = p_period_id
    and p.net_pay > 0;

  if v_employee_count < 1 then
    raise exception 'no_published_payslips' using errcode = 'P0001';
  end if;

  -- SAL-YYMMDD-NN under an advisory lock, with a retry on a rare collision.
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
        created_by
      ) values (
        v_payout_number,
        p_period_id,
        v_period.period_name,
        v_employee_count,
        v_total,
        'pending',
        v_actor
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
    payout_id, employee_code, employee_name, net_pay
  )
  select
    v_payout_id, p.employee_code, p.employee_name, p.net_pay
  from public.payroll_bn_payslips p
  where p.period_id = p_period_id
    and p.net_pay > 0
  order by p.employee_code;

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

  v_result := jsonb_build_object(
    'payout_id', v_payout_id,
    'payout_number', v_payout_number,
    'period_name', v_period.period_name,
    'employee_count', v_employee_count,
    'total_amount', v_total,
    'status', 'pending',
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

revoke all on function public.create_salary_payout(uuid, text) from public, anon;
grant execute on function public.create_salary_payout(uuid, text) to authenticated, service_role;

comment on function public.create_salary_payout(uuid, text) is
  'Owner / salary_cash edit (or service_role): snapshot the net_pay of every published payslip (net_pay > 0) of one payroll_bn period into a pending SAL-YYMMDD-NN payout. Refuses a second non-cancelled payout for the same period and enqueues salary_payout_created without any amount. Idempotent by key; payroll_bn data is never modified.';

-- ---------------------------------------------------------------------------
-- 5. get_salary_payout — read model (header + lines + receipts).
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
  'Owner / salary_cash view (or service_role): salary payout header, employee lines and uploaded receipts.';

-- ---------------------------------------------------------------------------
-- 6. record_salary_payout_ceo_payment — owner records the CEO transfer slip.
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
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_storage_path text;
  v_file_sha256 text;
  v_ocr_amount numeric;
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

  v_storage_path := nullif(btrim(coalesce(v_evidence->>'storage_path', '')), '');
  v_file_sha256 := nullif(lower(btrim(coalesce(v_evidence->>'file_sha256', ''))), '');
  if v_storage_path is null or v_file_sha256 is null then
    raise exception 'evidence_required' using errcode = '22023';
  end if;
  if v_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_evidence_sha256' using errcode = '22023';
  end if;
  if v_evidence ? 'ocr_amount' and jsonb_typeof(v_evidence->'ocr_amount') = 'number' then
    v_ocr_amount := (v_evidence->>'ocr_amount')::numeric;
    if v_ocr_amount is not null and v_ocr_amount <= 0 then
      raise exception 'invalid_evidence_amount' using errcode = '22023';
    end if;
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
  'Owner only (or service_role): record the CEO cash transfer slip for a pending payout -> advanced and enqueue salary_payout_advanced without any amount. Idempotent by key.';

-- ---------------------------------------------------------------------------
-- 7. submit_salary_payout_matches — match uploaded receipts to employee lines.
-- ---------------------------------------------------------------------------
create or replace function public.submit_salary_payout_matches(
  p_id uuid,
  p_matches jsonb,
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
  v_matches jsonb := coalesce(p_matches, '[]'::jsonb);
  v_sp public.salary_payouts%rowtype;
  v_match jsonb;
  v_receipt public.salary_payout_receipts%rowtype;
  v_line public.salary_payout_lines%rowtype;
  v_receipt_amount numeric;
  v_typed_amount numeric;
  v_matched_this integer := 0;
  v_remaining integer := 0;
  v_all_matched boolean;
  v_result jsonb;
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

  perform pg_advisory_xact_lock(hashtext('salary_payout_match:' || v_key));

  select result into v_prior
  from public.salary_payout_idempotency
  where idempotency_key = v_key;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  select * into v_sp
  from public.salary_payouts
  where id = p_id
  for update;
  if not found then
    raise exception 'payout_not_found' using errcode = 'P0002';
  end if;
  if v_sp.status <> 'advanced' then
    raise exception 'not_advanced' using errcode = 'P0001',
      detail = format('status=%s', v_sp.status);
  end if;

  if jsonb_typeof(v_matches) <> 'array' then
    raise exception 'invalid_matches' using errcode = '22023', detail = 'not_array';
  end if;
  if jsonb_array_length(v_matches) = 0 then
    raise exception 'matches_required' using errcode = '22023';
  end if;
  if jsonb_array_length(v_matches) > 500 then
    raise exception 'invalid_matches' using errcode = '22023', detail = 'too_many';
  end if;

  -- Shape and uniqueness: one receipt and one line per match.
  if exists (
    select 1
    from jsonb_array_elements(v_matches) m
    where jsonb_typeof(m) <> 'object'
       or coalesce(m->>'receipt_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(m->>'line_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'invalid_matches' using errcode = '22023', detail = 'invalid_item';
  end if;
  if (
    select count(*) <> count(distinct (m->>'receipt_id'))
    from jsonb_array_elements(v_matches) m
  ) or (
    select count(*) <> count(distinct (m->>'line_id'))
    from jsonb_array_elements(v_matches) m
  ) then
    raise exception 'invalid_matches' using errcode = '22023', detail = 'duplicate_item';
  end if;

  for v_match in select value from jsonb_array_elements(v_matches) loop
    select * into v_receipt
    from public.salary_payout_receipts r
    where r.id = (v_match->>'receipt_id')::uuid
      and r.payout_id = p_id
    for update;
    if not found or v_receipt.status <> 'uploaded' then
      raise exception 'receipt_not_uploaded' using errcode = 'P0001',
        detail = format('receipt_id=%s', v_match->>'receipt_id');
    end if;

    select * into v_line
    from public.salary_payout_lines l
    where l.id = (v_match->>'line_id')::uuid
      and l.payout_id = p_id
    for update;
    if not found then
      raise exception 'line_not_found' using errcode = 'P0001',
        detail = format('line_id=%s', v_match->>'line_id');
    end if;
    if v_line.matched_at is not null or v_line.receipt_storage_path is not null then
      raise exception 'line_already_matched' using errcode = 'P0001',
        detail = format('line_id=%s', v_match->>'line_id');
    end if;

    -- The typed amount is only consulted when OCR returned nothing.
    v_typed_amount := null;
    if v_match ? 'amount' and jsonb_typeof(v_match->'amount') = 'number' then
      v_typed_amount := (v_match->>'amount')::numeric;
    end if;
    v_receipt_amount := coalesce(v_receipt.ocr_amount, v_typed_amount);
    if v_receipt_amount is null then
      raise exception 'receipt_amount_required' using errcode = '22023',
        detail = format('receipt_id=%s', v_receipt.id);
    end if;
    if v_receipt_amount <> v_line.net_pay then
      raise exception 'amount_mismatch' using errcode = 'P0001',
        detail = format('receipt_id=%s line_id=%s', v_receipt.id, v_line.id);
    end if;

    update public.salary_payout_lines
    set receipt_storage_path = v_receipt.storage_path,
        receipt_sha256 = v_receipt.file_sha256,
        receipt_amount = v_receipt_amount,
        receipt_beneficiary = v_receipt.ocr_beneficiary,
        receipt_reference = v_receipt.ocr_reference,
        matched_at = now(),
        matched_by = v_actor
    where id = v_line.id;

    update public.salary_payout_receipts
    set status = 'matched'
    where id = v_receipt.id;

    v_matched_this := v_matched_this + 1;
  end loop;

  select count(*) into v_remaining
  from public.salary_payout_lines l
  where l.payout_id = p_id
    and l.matched_at is null;

  v_all_matched := (v_remaining = 0);

  if v_all_matched then
    update public.salary_payouts
    set status = 'completed',
        completed_at = now(),
        completed_by = v_actor
    where id = p_id;

    insert into public.finance_zalo_notifications (
      event_type, entity_id, group_key, message_body, status
    ) values (
      'salary_payout_completed',
      p_id,
      'finance',
      coalesce(
        public.build_finance_zalo_salary_payout_message(p_id, 'salary_payout_completed'),
        'Hoàn tất chi lương: ' || v_sp.payout_number
      ),
      'pending'
    )
    on conflict (event_type, entity_id) do nothing;
  end if;

  v_result := jsonb_build_object(
    'payout_id', p_id,
    'status', case when v_all_matched then 'completed' else 'advanced' end,
    'matched_count', v_matched_this,
    'remaining_count', v_remaining,
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

revoke all on function public.submit_salary_payout_matches(uuid, jsonb, text) from public, anon;
grant execute on function public.submit_salary_payout_matches(uuid, jsonb, text) to authenticated, service_role;

comment on function public.submit_salary_payout_matches(uuid, jsonb, text) is
  'Owner / salary_cash edit (or service_role): match uploaded receipts of an advanced payout to employee lines. Each receipt amount (OCR, else the typed amount when OCR is null) must equal the line net_pay exactly; when every line is matched the payout becomes completed and salary_payout_completed is enqueued without any amount. Idempotent by key.';

-- ---------------------------------------------------------------------------
-- 8. discard_salary_payout_receipt — owner / salary_cash edit.
-- ---------------------------------------------------------------------------
create or replace function public.discard_salary_payout_receipt(p_receipt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_receipt public.salary_payout_receipts%rowtype;
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

  if p_receipt_id is null then
    raise exception 'receipt_required' using errcode = '22023';
  end if;

  select * into v_receipt
  from public.salary_payout_receipts
  where id = p_receipt_id
  for update;
  if not found then
    raise exception 'receipt_not_found' using errcode = 'P0002';
  end if;
  if v_receipt.status <> 'uploaded' then
    raise exception 'receipt_not_uploaded' using errcode = 'P0001',
      detail = format('status=%s', v_receipt.status);
  end if;

  update public.salary_payout_receipts
  set status = 'discarded'
  where id = p_receipt_id;

  return jsonb_build_object('id', p_receipt_id, 'status', 'discarded');
end;
$$;

revoke all on function public.discard_salary_payout_receipt(uuid) from public, anon;
grant execute on function public.discard_salary_payout_receipt(uuid) to authenticated, service_role;

comment on function public.discard_salary_payout_receipt(uuid) is
  'Owner / salary_cash edit (or service_role): mark an uploaded (not matched) salary receipt discarded so its sha256 can be reused.';

-- ---------------------------------------------------------------------------
-- 9. cancel_salary_payout — owner only, pending only.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_salary_payout(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_sp public.salary_payouts%rowtype;
begin
  if not (v_is_service or (v_actor is not null and public.has_role(v_actor, 'owner'))) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_id is null then
    raise exception 'payout_id_required' using errcode = '22023';
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

  update public.salary_payouts
  set status = 'cancelled'
  where id = p_id;

  return jsonb_build_object(
    'payout_id', p_id,
    'payout_number', v_sp.payout_number,
    'status', 'cancelled'
  );
end;
$$;

revoke all on function public.cancel_salary_payout(uuid) from public, anon;
grant execute on function public.cancel_salary_payout(uuid) to authenticated, service_role;

comment on function public.cancel_salary_payout(uuid) is
  'Owner only (or service_role): cancel a pending salary payout so a new payout can be created for the same period.';
