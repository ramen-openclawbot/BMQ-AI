-- ============================================================================
-- Migration: Chứng từ kèm theo phiếu lương (salary payout attachments)
--
-- A salary payout (manual "Lương lẻ" and payroll Q7) can carry supporting
-- documents: images (JPEG/PNG/WebP/HEIC), PDF or Excel (.xls/.xlsx). They are
-- NOT stored in the existing payment-unc bucket (images only); this migration:
--   (1) registers a NEW private bucket 'salary-documents' with the document
--       mime list and a 10 MB object limit;
--   (2) adds public.salary_payout_attachments with owner-or-salary_cash-view
--       RLS (the exact salary_payouts_select logic, via the parent payout).
--       There is NO storage.objects policy for this bucket and no write policy
--       on the table: only the salary-payout edge function (service role)
--       reads/writes objects and rows. The client receives short-lived signed
--       URLs from the edge after a permission check;
--   (3) extends get_salary_payout with a new 'attachments' key (existing keys
--       are unchanged).
--
-- Payment-unc and its allowed types are untouched. No Zalo notice is sent for
-- any attachment action: the existing salary_payout_* builders are unchanged
-- and never include documents or amounts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Private bucket for salary supporting documents.
--
-- No storage.objects policy is created for 'salary-documents'. The service role
-- (edge function) bypasses RLS; the authenticated client never touches the
-- bucket directly. The idempotent upsert only refreshes limit/mimes.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'salary-documents',
  'salary-documents',
  false,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
set file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Attachment rows (one per uploaded document).
--
-- storage_path is the bucket object key '<payout_id>/<sha256>.<ext>' (no bucket
-- prefix). The unique (payout_id, file_sha256) makes a re-upload of the same
-- content idempotent.
-- ---------------------------------------------------------------------------
create table if not exists public.salary_payout_attachments (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.salary_payouts(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes integer not null,
  file_sha256 text not null,
  uploaded_by uuid not null,
  created_at timestamptz not null default now(),
  constraint salary_payout_attachments_file_name_check
    check (char_length(file_name) between 1 and 200),
  constraint salary_payout_attachments_size_check
    check (size_bytes between 1 and 10485760),
  constraint salary_payout_attachments_payout_sha_unique
    unique (payout_id, file_sha256)
);

create index if not exists idx_salary_payout_attachments_payout
  on public.salary_payout_attachments (payout_id);

comment on table public.salary_payout_attachments is
  'Supporting documents (image/PDF/Excel) of a salary payout. Rows are written only by the salary-payout edge function (service role); clients read metadata under owner-or-salary_cash-view RLS and download through short-lived signed URLs.';

-- ---------------------------------------------------------------------------
-- 3. RLS + explicit grants. Read logic is identical to salary_payouts_select
--    (owner or salary_cash view) evaluated through the parent payout. There is
--    no insert/update/delete policy: only the service role writes.
-- ---------------------------------------------------------------------------
alter table public.salary_payout_attachments enable row level security;

revoke all on public.salary_payout_attachments from public, anon, authenticated;
grant select on public.salary_payout_attachments to authenticated;
grant all on public.salary_payout_attachments to service_role;

drop policy if exists salary_payout_attachments_select on public.salary_payout_attachments;
create policy salary_payout_attachments_select
  on public.salary_payout_attachments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.salary_payouts sp
      where sp.id = salary_payout_attachments.payout_id
        and (
          public.has_role((select auth.uid()), 'owner')
          or public.has_module_permission((select auth.uid()), 'salary_cash', 'view')
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 4. get_salary_payout — same signature and every existing key, plus a new
--    'attachments' array ordered by created_at. Attachments expose the metadata
--    needed for the detail view; the edge mints the signed download URLs.
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
    'attachments', coalesce(v_attachments, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_salary_payout(uuid) from public, anon;
grant execute on function public.get_salary_payout(uuid) to authenticated, service_role;

comment on function public.get_salary_payout(uuid) is
  'Owner / salary_cash view (or service_role): salary payout header (incl. source), employee lines (incl. note), uploaded receipts and supporting attachments ordered by created_at.';
