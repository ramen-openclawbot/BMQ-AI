-- ============================================================================
-- Migration: Chi lương Q7 — chọn nhân viên lúc tạo phiếu, bỏ tick kèm lý do
--
-- When a KTT creates a payroll-Q7 payout they can now uncheck chosen employees
-- and must give a 3..200 char reason for each one. This migration:
--   (1) adds public.salary_payout_exclusions (payout_id, employee_code,
--       employee_name, net_pay, reason, created_by, created_at) with the exact
--       salary_payout_lines_select read logic; only the SECURITY DEFINER RPC
--       writes rows, so there is no write policy and no client write grant;
--   (2) adds list_salary_payout_period_lines(p_period_id) for the owner /
--       salary_cash view|edit checklist: employee_code, employee_name, net_pay
--       of the period's payslips (net_pay > 0) ordered by employee_code;
--   (3) replaces create_salary_payout with a THIRD argument
--       p_exclusions jsonb default '[]'::jsonb. The 2-argument overload is
--       dropped so PostgREST exposes one signature; calls without the third
--       argument behave exactly as before. Lines, employee_count, total_amount
--       and the Zalo message count only cover the non-excluded employees, and
--       each exclusion is snapshotted into salary_payout_exclusions;
--   (4) extends get_salary_payout with a new 'exclusions' key; every existing
--       key (payout, lines, receipts, attachments) is unchanged.
--
-- Idempotent: the table/index/function use IF NOT EXISTS / CREATE OR REPLACE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Exclusion rows (one per unchecked employee of a payout).
-- ---------------------------------------------------------------------------
create table if not exists public.salary_payout_exclusions (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.salary_payouts(id) on delete cascade,
  employee_code text not null,
  employee_name text not null,
  net_pay numeric(15,2) not null,
  reason text not null check (char_length(reason) between 3 and 200),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint salary_payout_exclusions_payout_employee_unique
    unique (payout_id, employee_code)
);

create index if not exists idx_salary_payout_exclusions_payout
  on public.salary_payout_exclusions (payout_id);

comment on table public.salary_payout_exclusions is
  'Employees deliberately excluded from a payroll-Q7 salary payout, each with the operator reason. Rows are written only by create_salary_payout (SECURITY DEFINER); clients read them under owner-or-salary_cash-view RLS.';

-- RLS + explicit grants: read logic identical to salary_payout_lines_select.
alter table public.salary_payout_exclusions enable row level security;

revoke all on public.salary_payout_exclusions from public, anon, authenticated;
grant select on public.salary_payout_exclusions to authenticated;
grant all on public.salary_payout_exclusions to service_role;

drop policy if exists salary_payout_exclusions_select on public.salary_payout_exclusions;
create policy salary_payout_exclusions_select
  on public.salary_payout_exclusions
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'salary_cash', 'view')
  );

-- ---------------------------------------------------------------------------
-- 2. list_salary_payout_period_lines — checklist source for one period.
--
-- payroll_bn_payslips is owner-only under RLS, so a salary_cash accountant
-- reads the employees and amounts through this SECURITY DEFINER function. It
-- returns nothing but code/name/net_pay of the published (net_pay > 0) payslips
-- of the requested period, ordered by employee_code.
-- ---------------------------------------------------------------------------
create or replace function public.list_salary_payout_period_lines(p_period_id uuid)
returns table (employee_code text, employee_name text, net_pay numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not (
    v_uid is not null
    and (
      public.has_role(v_uid, 'owner')
      or public.has_module_permission(v_uid, 'salary_cash', 'edit')
      or public.has_module_permission(v_uid, 'salary_cash', 'view')
    )
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select p.employee_code, p.employee_name, p.net_pay
  from public.payroll_bn_payslips p
  where p.period_id = p_period_id
    and p.net_pay > 0
  order by p.employee_code;
end;
$$;

revoke all on function public.list_salary_payout_period_lines(uuid) from public, anon;
grant execute on function public.list_salary_payout_period_lines(uuid) to authenticated, service_role;

comment on function public.list_salary_payout_period_lines(uuid) is
  'Owner / salary_cash view|edit: employee_code, employee_name and net_pay of the published payslips (net_pay > 0) of one payroll_bn period, ordered by employee_code, for the Chi lương exclusion checklist.';

-- ---------------------------------------------------------------------------
-- 3. create_salary_payout — same behaviour plus optional p_exclusions.
--
-- Drop the old 2-argument overload first so PostgREST sees a single function
-- with a defaulted third argument.
-- ---------------------------------------------------------------------------
drop function if exists public.create_salary_payout(uuid, text);

create or replace function public.create_salary_payout(
  p_period_id uuid,
  p_idempotency_key text,
  p_exclusions jsonb default '[]'::jsonb
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
  v_exclusions jsonb := coalesce(p_exclusions, '[]'::jsonb);
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

  -- Exclusion payload shape: a jsonb array of objects, each with a non-blank
  -- employee_code text and no duplicate code.
  if jsonb_typeof(v_exclusions) <> 'array' then
    raise exception 'invalid_exclusions' using errcode = '22023', detail = 'not_array';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_exclusions) m
    where jsonb_typeof(m) <> 'object'
       or not (m ? 'employee_code')
       or jsonb_typeof(m->'employee_code') <> 'string'
       or btrim(m->>'employee_code') = ''
  ) then
    raise exception 'invalid_exclusions' using errcode = '22023', detail = 'invalid_item';
  end if;
  if (
    select count(*) <> count(distinct btrim(m->>'employee_code'))
    from jsonb_array_elements(v_exclusions) m
  ) then
    raise exception 'invalid_exclusions' using errcode = '22023', detail = 'duplicate_employee_code';
  end if;

  -- Every reason is required and 3..200 chars after btrim.
  if exists (
    select 1
    from jsonb_array_elements(v_exclusions) m
    where (m ? 'reason' and jsonb_typeof(m->'reason') <> 'string')
       or char_length(btrim(coalesce(m->>'reason', ''))) not between 3 and 200
  ) then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  -- Every excluded code must belong to this period's published snapshot.
  if exists (
    select 1
    from jsonb_array_elements(v_exclusions) m
    where not exists (
      select 1
      from public.payroll_bn_payslips p
      where p.period_id = p_period_id
        and p.net_pay > 0
        and p.employee_code = btrim(m->>'employee_code')
    )
  ) then
    raise exception 'unknown_employee_code' using errcode = '22023';
  end if;

  -- Count/sum only the non-excluded employees.
  select count(*), coalesce(sum(p.net_pay), 0)
    into v_employee_count, v_total
  from public.payroll_bn_payslips p
  where p.period_id = p_period_id
    and p.net_pay > 0
    and not exists (
      select 1
      from jsonb_array_elements(v_exclusions) m
      where btrim(m->>'employee_code') = p.employee_code
    );

  if v_employee_count < 1 then
    raise exception 'no_employees_left' using errcode = 'P0001';
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
    and not exists (
      select 1
      from jsonb_array_elements(v_exclusions) m
      where btrim(m->>'employee_code') = p.employee_code
    )
  order by p.employee_code;

  -- Snapshot each exclusion with the employee name/net_pay from the payslip.
  insert into public.salary_payout_exclusions (
    payout_id, employee_code, employee_name, net_pay, reason, created_by
  )
  select
    v_payout_id, p.employee_code, p.employee_name, p.net_pay, btrim(m->>'reason'), v_actor
  from jsonb_array_elements(v_exclusions) m
  join public.payroll_bn_payslips p
    on p.period_id = p_period_id
   and p.net_pay > 0
   and p.employee_code = btrim(m->>'employee_code')
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

revoke all on function public.create_salary_payout(uuid, text, jsonb) from public, anon;
grant execute on function public.create_salary_payout(uuid, text, jsonb) to authenticated, service_role;

comment on function public.create_salary_payout(uuid, text, jsonb) is
  'Owner / salary_cash edit (or service_role): snapshot the net_pay of every published payslip (net_pay > 0) of one payroll_bn period into a pending SAL-YYMMDD-NN payout. The optional p_exclusions jsonb array of {employee_code, reason} removes chosen employees from the lines, employee_count, total_amount and the Zalo notice, and snapshots them into salary_payout_exclusions. Refuses a second non-cancelled payout for the same period and enqueues salary_payout_created without any amount. Idempotent by key; payroll_bn data is never modified.';

-- ---------------------------------------------------------------------------
-- 4. get_salary_payout — same signature and every existing key, plus a new
--    'exclusions' array ordered by employee_code.
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
    'receipts', coalesce(v_receipts, '[]'::jsonb),
    'attachments', coalesce(v_attachments, '[]'::jsonb),
    'exclusions', coalesce(v_exclusions, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_salary_payout(uuid) from public, anon;
grant execute on function public.get_salary_payout(uuid) to authenticated, service_role;

comment on function public.get_salary_payout(uuid) is
  'Owner / salary_cash view (or service_role): salary payout header (incl. source), employee lines (incl. note), uploaded receipts, supporting attachments and the excluded employees (with reasons) ordered by employee_code/created_at.';
