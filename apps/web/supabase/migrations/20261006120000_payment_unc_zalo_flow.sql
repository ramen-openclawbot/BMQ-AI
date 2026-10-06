-- Giai đoạn 1 (backend) — CEO duyệt chi bằng UNC và đẩy tin qua Zalo OA.
--
-- Additive only. This migration:
--   (a) stores server-side UNC evidence (image hash / OCR fields) with owner-only RLS,
--   (b) adds approve_payment_requests_with_unc: owner-only atomic approval +
--       payment + allocation + evidence with exact-amount / same-supplier /
--       reference-uniqueness guards and an idempotency key,
--   (c) exposes finance_unc_total_from_evidence + record_unc_without_request,
--   (d) adds a default-off, idempotent finance Zalo OA outbox with claim RPC and
--       fail-safe enqueue triggers.
--
-- Existing approval semantics are untouched: the new RPC calls
-- public.approve_payment_request_with_material_controller (which itself runs
-- assert_procurement_materials_ready) and never redefines it. No pg_cron
-- schedule is created in this stage.

-- ---------------------------------------------------------------------------
-- 0. Private storage bucket for UNC evidence images.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-unc',
  'payment-unc',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. UNC evidence (payment-scoped and standalone) + OCR drafts.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_unc_evidence (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references public.payments(id) on delete set null,
  storage_path text,
  file_sha256 text not null,
  ocr_amount numeric,
  ocr_reference text,
  ocr_beneficiary_account text,
  ocr_confidence numeric,
  transfer_date date,
  manual_override boolean not null default false,
  override_reason text,
  category text,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint payment_unc_evidence_amount_positive
    check (ocr_amount is null or ocr_amount > 0),
  constraint payment_unc_evidence_confidence_range
    check (ocr_confidence is null or (ocr_confidence >= 0 and ocr_confidence <= 1)),
  constraint payment_unc_evidence_category_check
    check (category is null or category in ('luong', 'thue', 'thue_nha', 'khac')),
  constraint payment_unc_evidence_override_reason_check
    check (manual_override = false or btrim(coalesce(override_reason, '')) <> '')
);

create unique index if not exists uq_payment_unc_evidence_file_sha256
  on public.payment_unc_evidence (file_sha256);

-- Canonical normalized reference used by the unique partial index and mirrored
-- by src/lib/payment-unc-matching.ts (uppercase, alphanumeric only).
create or replace function public.normalize_unc_reference(p_reference text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(
    upper(regexp_replace(btrim(coalesce(p_reference, '')), '[^a-zA-Z0-9]', '', 'g')),
    ''
  );
$$;

create unique index if not exists uq_payment_unc_evidence_reference
  on public.payment_unc_evidence (public.normalize_unc_reference(ocr_reference))
  where ocr_reference is not null and btrim(ocr_reference) <> '';

create index if not exists idx_payment_unc_evidence_transfer_date
  on public.payment_unc_evidence (transfer_date, created_at desc);

alter table public.payment_unc_evidence enable row level security;
revoke all on public.payment_unc_evidence from public, anon, authenticated;
-- Evidence is written only through SECURITY DEFINER RPCs; owners may read it.
grant select on public.payment_unc_evidence to authenticated;

drop policy if exists payment_unc_evidence_owner_select on public.payment_unc_evidence;
create policy payment_unc_evidence_owner_select
  on public.payment_unc_evidence
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'owner'));

-- Server-side OCR snapshot captured at upload time so "confirm" can re-read the
-- OCR result and never trust a client-supplied amount.
create table if not exists public.payment_unc_ocr_drafts (
  file_sha256 text primary key,
  storage_path text not null,
  ocr_amount numeric,
  ocr_reference text,
  ocr_beneficiary_account text,
  ocr_confidence numeric,
  transfer_date date,
  amount_raw text,
  amount_in_words text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint payment_unc_ocr_drafts_amount_positive
    check (ocr_amount is null or ocr_amount > 0)
);

alter table public.payment_unc_ocr_drafts enable row level security;
revoke all on public.payment_unc_ocr_drafts from public, anon, authenticated;
grant all on public.payment_unc_ocr_drafts to service_role;

-- Idempotency ledger for approve_payment_requests_with_unc.
create table if not exists public.payment_unc_idempotency (
  idempotency_key text primary key,
  result jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.payment_unc_idempotency enable row level security;
revoke all on public.payment_unc_idempotency from public, anon, authenticated;
grant all on public.payment_unc_idempotency to service_role;

-- ---------------------------------------------------------------------------
-- 2. Atomic owner-only UNC approval RPC.
-- ---------------------------------------------------------------------------
create or replace function public.approve_payment_requests_with_unc(
  p_request_ids uuid[],
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
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_ids uuid[];
  v_prior jsonb;
  v_file_sha text := nullif(btrim(coalesce(v_evidence->>'file_sha256', '')), '');
  v_storage_path text := nullif(btrim(coalesce(v_evidence->>'storage_path', '')), '');
  v_reference text := nullif(btrim(coalesce(v_evidence->>'ocr_reference', '')), '');
  v_reference_norm text;
  v_beneficiary text := nullif(btrim(coalesce(v_evidence->>'ocr_beneficiary_account', '')), '');
  v_confidence numeric := nullif(v_evidence->>'ocr_confidence', '')::numeric;
  v_transfer_date date := nullif(v_evidence->>'transfer_date', '')::date;
  v_amount numeric := coalesce(
    nullif(v_evidence->>'ocr_amount', '')::numeric,
    nullif(v_evidence->>'amount', '')::numeric
  );
  v_manual_override boolean := lower(coalesce(v_evidence->>'manual_override', 'false')) in ('true', 't', '1');
  v_override_reason text := nullif(btrim(coalesce(v_evidence->>'override_reason', '')), '');
  v_note text := nullif(btrim(coalesce(v_evidence->>'note', '')), '');
  v_category text := nullif(btrim(coalesce(v_evidence->>'category', '')), '');
  v_pr record;
  v_request_count integer := 0;
  v_remaining numeric;
  v_remaining_total numeric := 0;
  v_supplier_id uuid;
  v_supplier_set boolean := false;
  v_allocations jsonb := '[]'::jsonb;
  v_payment_id uuid;
  v_owner_count integer;
  v_draft_amount numeric;
  v_result jsonb;
begin
  -- Owner-only: app_role owner (or service_role for trusted automation). Module
  -- edit permission is deliberately NOT accepted for UNC cash-out approval.
  if not v_is_service then
    if v_actor is null then
      raise exception 'not_owner' using errcode = '42501';
    end if;
  end if;
  if not (v_is_service or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  if p_request_ids is null or array_length(p_request_ids, 1) is null then
    raise exception 'request_ids_required' using errcode = '22023';
  end if;

  select array(select distinct unnest(p_request_ids)) into v_ids;

  select result into v_prior
  from public.payment_unc_idempotency
  where idempotency_key = v_key
  limit 1;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  perform pg_advisory_xact_lock(hashtext('payment_unc_approval:' || v_key));

  select result into v_prior
  from public.payment_unc_idempotency
  where idempotency_key = v_key
  limit 1;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  if exists (
    select 1
    from unnest(v_ids) as rid(id)
    where not exists (select 1 from public.payment_requests pr where pr.id = rid.id)
  ) then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;

  perform 1
  from public.payment_requests pr
  where pr.id = any(v_ids)
  order by pr.id
  for update of pr;

  -- Guard: a caller must not approve a request they created themselves when
  -- there is more than one owner (segregation of duties). When the caller is the
  -- only active owner, self-approval is allowed (documented, single-operator
  -- house) so the business is not blocked.
  select count(*) into v_owner_count from public.user_roles where role = 'owner';
  if v_owner_count > 1 and exists (
    select 1 from public.payment_requests pr
    where pr.id = any(v_ids) and pr.created_by = v_actor
  ) then
    raise exception 'self_approval_not_allowed' using errcode = '42501';
  end if;

  for v_pr in
    select * from public.payment_requests pr
    where pr.id = any(v_ids)
    order by pr.id
  loop
    if v_pr.status::text <> 'pending' then
      raise exception 'not_pending' using errcode = 'P0001',
        detail = format('request_number=%s status=%s', v_pr.request_number, v_pr.status);
    end if;
    if v_pr.payment_status::text <> 'unpaid' then
      raise exception 'not_pending' using errcode = 'P0001',
        detail = format('request_number=%s payment_status=%s', v_pr.request_number, v_pr.payment_status);
    end if;

    v_remaining := coalesce(v_pr.total_amount, 0) - coalesce((
      select sum(pa.amount)
      from public.payment_allocations pa
      where pa.payment_request_id = v_pr.id
    ), 0);
    if v_remaining <= 0 then
      raise exception 'not_pending' using errcode = 'P0001',
        detail = format('request_number=%s remaining=%s', v_pr.request_number, v_remaining);
    end if;

    if not v_supplier_set then
      v_supplier_id := v_pr.supplier_id;
      v_supplier_set := true;
    elsif v_pr.supplier_id is distinct from v_supplier_id then
      raise exception 'supplier_mismatch' using errcode = 'P0001',
        detail = format('request_number=%s', v_pr.request_number);
    end if;

    v_request_count := v_request_count + 1;
    v_remaining_total := v_remaining_total + v_remaining;
    v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
      'payment_request_id', v_pr.id,
      'amount', v_remaining
    ));
  end loop;

  if v_request_count = 0 then
    raise exception 'request_ids_required' using errcode = '22023';
  end if;

  if v_file_sha is null then
    raise exception 'evidence_required' using errcode = '22023';
  end if;

  -- The OCR fields come from the server-side draft written by
  -- payment-unc-approve (extract), never from the caller. Only a reasoned
  -- manual override may supply its own amount.
  select d.storage_path, d.ocr_amount, d.ocr_reference, d.ocr_beneficiary_account,
         d.ocr_confidence, d.transfer_date
    into v_storage_path, v_draft_amount, v_reference, v_beneficiary,
         v_confidence, v_transfer_date
  from public.payment_unc_ocr_drafts d
  where d.file_sha256 = v_file_sha;
  if not found then
    raise exception 'evidence_not_extracted' using errcode = '22023';
  end if;
  if not v_manual_override then
    v_amount := v_draft_amount;
  end if;

  if v_manual_override then
    if v_override_reason is null then
      raise exception 'override_reason_required' using errcode = '22023';
    end if;
  elsif v_amount is null or v_amount <> v_remaining_total then
    raise exception 'amount_mismatch' using errcode = 'P0001',
      detail = format('evidence_amount=%s remaining_total=%s', v_amount, v_remaining_total);
  end if;

  v_reference_norm := public.normalize_unc_reference(v_reference);

  if exists (select 1 from public.payment_unc_evidence e where e.file_sha256 = v_file_sha) then
    raise exception 'file_reused' using errcode = '23505';
  end if;
  if v_reference_norm is not null and exists (
    select 1 from public.payment_unc_evidence e
    where public.normalize_unc_reference(e.ocr_reference) = v_reference_norm
  ) then
    raise exception 'reference_reused' using errcode = '23505';
  end if;

  -- Reuse the canonical approval path (material controller + audit columns).
  for v_pr in
    select * from public.payment_requests pr
    where pr.id = any(v_ids)
    order by pr.id
  loop
    perform public.approve_payment_request_with_material_controller(
      v_pr.id,
      'bank_transfer',
      v_actor
    );
  end loop;

  perform pg_advisory_xact_lock(hashtext('public.payments.payment_number'));

  insert into public.payments (
    payment_number,
    supplier_id,
    payment_date,
    amount,
    payment_method,
    reference_number,
    notes,
    created_by
  ) values (
    public.next_payment_number(),
    v_supplier_id,
    coalesce(v_transfer_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date),
    v_remaining_total,
    'bank_transfer'::public.payment_method_type,
    v_reference,
    v_override_reason,
    v_actor
  )
  returning id into v_payment_id;

  insert into public.payment_allocations (payment_id, payment_request_id, amount, created_by)
  select v_payment_id, (item->>'payment_request_id')::uuid, (item->>'amount')::numeric, v_actor
  from jsonb_array_elements(v_allocations) item;

  begin
    insert into public.payment_unc_evidence (
      payment_id,
      storage_path,
      file_sha256,
      ocr_amount,
      ocr_reference,
      ocr_beneficiary_account,
      ocr_confidence,
      transfer_date,
      manual_override,
      override_reason,
      category,
      note,
      created_by
    ) values (
      v_payment_id,
      v_storage_path,
      v_file_sha,
      v_amount,
      v_reference,
      v_beneficiary,
      v_confidence,
      v_transfer_date,
      v_manual_override,
      v_override_reason,
      coalesce(v_category, 'khac'),
      v_note,
      v_actor
    );
  exception when unique_violation then
    if exists (select 1 from public.payment_unc_evidence e where e.file_sha256 = v_file_sha) then
      raise exception 'file_reused' using errcode = '23505';
    end if;
    raise exception 'reference_reused' using errcode = '23505';
  end;

  v_result := jsonb_build_object(
    'status', 'approved',
    'payment_id', v_payment_id,
    'payment_request_ids', to_jsonb(v_ids),
    'amount', v_remaining_total,
    'evidence_amount', v_amount,
    'manual_override', v_manual_override,
    'reference_number', v_reference,
    'supplier_id', v_supplier_id,
    'transfer_date', coalesce(v_transfer_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date),
    'idempotent', false
  );

  insert into public.payment_unc_idempotency (idempotency_key, result, created_by)
  values (v_key, v_result, v_actor)
  on conflict (idempotency_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) from public, anon;
grant execute on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) to authenticated, service_role;

comment on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) is 'Owner-only atomic UNC approval: locks pending same-supplier requests, enforces exact evidence amount (unless a reasoned manual override), rejects reused file hash/reference, then approves via approve_payment_request_with_material_controller, records one bank-transfer payment + allocations + evidence, and replays by idempotency_key.';

-- ---------------------------------------------------------------------------
-- 3. UNC total from evidence + evidence without a payment request.
-- ---------------------------------------------------------------------------
create or replace function public.finance_unc_total_from_evidence(p_date date)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_total numeric := 0;
  v_count integer := 0;
begin
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role(auth.uid(), 'owner')
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_date is null then
    raise exception 'date_required' using errcode = '22023';
  end if;

  select coalesce(sum(e.ocr_amount), 0), count(*)
  into v_total, v_count
  from public.payment_unc_evidence e
  where coalesce(e.transfer_date, (e.created_at at time zone 'Asia/Ho_Chi_Minh')::date) = p_date;

  return jsonb_build_object(
    'transfer_date', p_date,
    'total_amount', v_total,
    'evidence_count', v_count
  );
end;
$$;

revoke all on function public.finance_unc_total_from_evidence(date) from public, anon;
grant execute on function public.finance_unc_total_from_evidence(date) to authenticated, service_role;

comment on function public.finance_unc_total_from_evidence(date) is 'Owner-only daily UNC total/count from stored app evidence, grouped by transfer_date in Asia/Ho_Chi_Minh, for the CEO daily declaration.';

create or replace function public.record_unc_without_request(
  p_evidence jsonb,
  p_category text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_category text := lower(btrim(coalesce(p_category, '')));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_file_sha text := nullif(btrim(coalesce(v_evidence->>'file_sha256', '')), '');
  v_reference text := nullif(btrim(coalesce(v_evidence->>'ocr_reference', '')), '');
  v_reference_norm text;
  v_amount numeric := coalesce(
    nullif(v_evidence->>'ocr_amount', '')::numeric,
    nullif(v_evidence->>'amount', '')::numeric
  );
  v_draft_amount numeric;
  v_storage_path text;
  v_beneficiary text;
  v_confidence numeric;
  v_transfer_date date;
  v_id uuid;
begin
  if not v_is_service then
    if v_actor is null then
      raise exception 'not_owner' using errcode = '42501';
    end if;
  end if;
  if not (v_is_service or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  if v_category not in ('luong', 'thue', 'thue_nha', 'khac') then
    raise exception 'invalid_category' using errcode = '22023';
  end if;
  if v_file_sha is null then
    raise exception 'evidence_required' using errcode = '22023';
  end if;
  if lower(coalesce(v_evidence->>'manual_override', 'false')) in ('true', 't', '1')
     and nullif(btrim(coalesce(v_evidence->>'override_reason', '')), '') is null then
    raise exception 'override_reason_required' using errcode = '22023';
  end if;

  -- OCR fields come from the server-side draft; only a reasoned manual
  -- override may supply its own amount.
  select d.storage_path, d.ocr_amount, d.ocr_reference, d.ocr_beneficiary_account,
         d.ocr_confidence, d.transfer_date
    into v_storage_path, v_draft_amount, v_reference, v_beneficiary,
         v_confidence, v_transfer_date
  from public.payment_unc_ocr_drafts d
  where d.file_sha256 = v_file_sha;
  if not found then
    raise exception 'evidence_not_extracted' using errcode = '22023';
  end if;
  if not (lower(coalesce(v_evidence->>'manual_override', 'false')) in ('true', 't', '1')) then
    v_amount := v_draft_amount;
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'amount_required' using errcode = '22023';
  end if;

  v_reference_norm := public.normalize_unc_reference(v_reference);

  if exists (select 1 from public.payment_unc_evidence e where e.file_sha256 = v_file_sha) then
    raise exception 'file_reused' using errcode = '23505';
  end if;
  if v_reference_norm is not null and exists (
    select 1 from public.payment_unc_evidence e
    where public.normalize_unc_reference(e.ocr_reference) = v_reference_norm
  ) then
    raise exception 'reference_reused' using errcode = '23505';
  end if;

  begin
    insert into public.payment_unc_evidence (
      payment_id,
      storage_path,
      file_sha256,
      ocr_amount,
      ocr_reference,
      ocr_beneficiary_account,
      ocr_confidence,
      transfer_date,
      manual_override,
      override_reason,
      category,
      note,
      created_by
    ) values (
      null,
      v_storage_path,
      v_file_sha,
      v_amount,
      v_reference,
      v_beneficiary,
      v_confidence,
      v_transfer_date,
      lower(coalesce(v_evidence->>'manual_override', 'false')) in ('true', 't', '1'),
      nullif(btrim(coalesce(v_evidence->>'override_reason', '')), ''),
      v_category,
      v_note,
      v_actor
    )
    returning id into v_id;
  exception when unique_violation then
    if exists (select 1 from public.payment_unc_evidence e where e.file_sha256 = v_file_sha) then
      raise exception 'file_reused' using errcode = '23505';
    end if;
    raise exception 'reference_reused' using errcode = '23505';
  end;

  return jsonb_build_object(
    'id', v_id,
    'category', v_category,
    'ocr_amount', v_amount,
    'reference_number', v_reference
  );
end;
$$;

revoke all on function public.record_unc_without_request(jsonb, text, text) from public, anon;
grant execute on function public.record_unc_without_request(jsonb, text, text) to authenticated, service_role;

comment on function public.record_unc_without_request(jsonb, text, text) is 'Owner-only standalone UNC evidence (payment_id null) for salary/tax/rent/other, still enforcing unique file hash and normalized reference.';

-- ---------------------------------------------------------------------------
-- 4. Finance Zalo OA outbox (service-role only) + default-off config.
-- ---------------------------------------------------------------------------
create table if not exists public.finance_zalo_notification_config (
  id text primary key,
  finance_zalo_notifications_enabled boolean not null default false,
  worker_secret uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  constraint finance_zalo_notification_config_id_check check (id = 'finance-zalo')
);

insert into public.finance_zalo_notification_config (id, finance_zalo_notifications_enabled)
values ('finance-zalo', false)
on conflict (id) do nothing;

alter table public.finance_zalo_notification_config enable row level security;
revoke all on public.finance_zalo_notification_config from public, anon, authenticated;
grant select, update on public.finance_zalo_notification_config to service_role;

create table if not exists public.finance_zalo_notifications (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  entity_id uuid not null,
  group_key text not null default 'finance',
  message_body text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  sent_at timestamptz,
  provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_type, entity_id),
  constraint finance_zalo_notifications_event_type_check
    check (event_type in (
      'payment_request_created',
      'payment_request_paid',
      'goods_receipt_received',
      'goods_receipt_short'
    )),
  constraint finance_zalo_notifications_status_check
    check (status in ('pending', 'processing', 'sent', 'failed', 'suppressed')),
  constraint finance_zalo_notifications_attempts_check check (attempts >= 0),
  constraint finance_zalo_notifications_message_check
    check (length(message_body) between 1 and 10000)
);

create index if not exists finance_zalo_notifications_retry_idx
  on public.finance_zalo_notifications (status, next_attempt_at, created_at)
  where status in ('pending', 'processing');

alter table public.finance_zalo_notifications enable row level security;
revoke all on public.finance_zalo_notifications from public, anon, authenticated;
grant select, insert, update on public.finance_zalo_notifications to service_role;

create or replace function public.claim_finance_zalo_notifications(batch_size integer default 10)
returns table (
  id uuid,
  event_type text,
  entity_id uuid,
  group_key text,
  message_body text,
  attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Noise filter, re-checked at send time:
  -- * a "new request" notice is pointless once the request left pending
  --   (Drive UNC import creates pending rows and approves them right away);
  -- * a "paid" notice is only for payments made through the UNC approval flow,
  --   not Drive imports or manual "mark paid".
  update public.finance_zalo_notifications n
  set status = 'suppressed', last_error = 'suppressed: request no longer pending', locked_at = null, updated_at = now()
  where n.status = 'pending'
    and n.event_type = 'payment_request_created'
    and exists (
      select 1 from public.payment_requests pr
      where pr.id = n.entity_id and pr.status::text <> 'pending'
    );

  update public.finance_zalo_notifications n
  set status = 'suppressed', last_error = 'suppressed: not paid through UNC approval', locked_at = null, updated_at = now()
  where n.status = 'pending'
    and n.event_type = 'payment_request_paid'
    and not exists (
      select 1
      from public.payment_allocations pa
      join public.payment_unc_evidence e on e.payment_id = pa.payment_id
      where pa.payment_request_id = n.entity_id
    );

  return query
  with picked as (
    select n.id
    from public.finance_zalo_notifications n
    where n.attempts < 5
      and n.next_attempt_at <= now()
      -- Give an immediate approval a moment to land before announcing a new request.
      and (n.event_type <> 'payment_request_created' or n.created_at < now() - interval '2 minutes')
      and (
        n.status = 'pending'
        or (n.status = 'processing' and n.locked_at < now() - interval '15 minutes')
      )
    order by n.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(batch_size, 10), 50))
  ), claimed as (
    update public.finance_zalo_notifications n
    set status = 'processing',
        attempts = n.attempts + 1,
        locked_at = now(),
        updated_at = now()
    from picked
    where n.id = picked.id
    returning n.id,
              n.event_type,
              n.entity_id,
              n.group_key,
              n.message_body,
              n.attempts
  )
  select claimed.id,
         claimed.event_type,
         claimed.entity_id,
         claimed.group_key,
         claimed.message_body,
         claimed.attempts
  from claimed;
end;
$$;

revoke all on function public.claim_finance_zalo_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_finance_zalo_notifications(integer) to service_role;

comment on function public.claim_finance_zalo_notifications(integer) is 'Service-role claim for the finance Zalo outbox, mirroring claim_dealer_order_notifications (FOR UPDATE SKIP LOCKED, stale-lock recovery).';

-- ---------------------------------------------------------------------------
-- 5. SQL message builders (mirror the shared TypeScript formatters) and the
--    fail-safe enqueue triggers.
-- ---------------------------------------------------------------------------
create or replace function public.finance_format_vnd(p_amount numeric)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select regexp_replace(
    to_char(coalesce(p_amount, 0), 'FM999,999,999,999,999,999'),
    ',',
    '.',
    'g'
  ) || ' đ';
$$;

create or replace function public.build_finance_zalo_payment_request_message(
  p_request_id uuid,
  p_event_type text
)
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_pr public.payment_requests%rowtype;
  v_supplier text;
  v_po text;
  v_grn text;
  v_link text;
begin
  select * into v_pr from public.payment_requests where id = p_request_id;
  if not found then
    return null;
  end if;

  select s.name into v_supplier from public.suppliers s where s.id = v_pr.supplier_id;
  select po.po_number into v_po from public.purchase_orders po where po.id = v_pr.purchase_order_id;
  select gr.receipt_number into v_grn from public.goods_receipts gr where gr.id = v_pr.goods_receipt_id;

  v_link := 'https://ai.banhmique.vn/payment-requests?id=' || v_pr.id::text;

  if p_event_type = 'payment_request_paid' then
    return concat_ws(
      E'\n',
      '✅ ĐÃ CHI BẰNG UNC',
      '',
      'Mã duyệt chi: ' || v_pr.request_number,
      'Nhà cung cấp: ' || coalesce(v_supplier, 'Chưa xác định'),
      'Số tiền: ' || public.finance_format_vnd(v_pr.total_amount),
      'Trạng thái: đã duyệt và đã thanh toán',
      case when v_po is not null then 'PO: ' || v_po end,
      case when v_grn is not null then 'Phiếu nhận: ' || v_grn end,
      '',
      'Xem chi tiết: ' || v_link
    );
  end if;

  return concat_ws(
    E'\n',
    '💳 DUYỆT CHI MỚI',
    '',
    'Mã duyệt chi: ' || v_pr.request_number,
    'Nhà cung cấp: ' || coalesce(v_supplier, 'Chưa xác định'),
    'Số tiền: ' || public.finance_format_vnd(v_pr.total_amount),
    case when v_po is not null then 'PO: ' || v_po end,
    case when v_grn is not null then 'Phiếu nhận: ' || v_grn end,
    '',
    'Xem chi tiết: ' || v_link
  );
end;
$$;

create or replace function public.build_finance_zalo_goods_receipt_message(
  p_receipt_id uuid,
  p_event_type text
)
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_gr public.goods_receipts%rowtype;
  v_supplier text;
  v_po text;
  v_short_count integer;
  v_link text;
begin
  select * into v_gr from public.goods_receipts where id = p_receipt_id;
  if not found then
    return null;
  end if;

  select s.name into v_supplier from public.suppliers s where s.id = v_gr.supplier_id;
  select po.po_number into v_po from public.purchase_orders po where po.id = v_gr.purchase_order_id;
  select count(*) into v_short_count
  from public.goods_receipt_items gri
  where gri.goods_receipt_id = v_gr.id and gri.line_status = 'thieu';

  v_link := 'https://ai.banhmique.vn/goods-receipts?id=' || v_gr.id::text;

  if p_event_type = 'goods_receipt_short' or v_short_count > 0 then
    return concat_ws(
      E'\n',
      '⚠️ NHẬN HÀNG THIẾU',
      '',
      'Phiếu nhận: ' || v_gr.receipt_number,
      'Nhà cung cấp: ' || coalesce(v_supplier, 'Chưa xác định'),
      case when v_po is not null then 'PO: ' || v_po end,
      'Số dòng thiếu: ' || v_short_count::text,
      '',
      'Xem chi tiết: ' || v_link
    );
  end if;

  return concat_ws(
    E'\n',
    '📦 ĐÃ NHẬN HÀNG',
    '',
    'Phiếu nhận: ' || v_gr.receipt_number,
    'Nhà cung cấp: ' || coalesce(v_supplier, 'Chưa xác định'),
    case when v_po is not null then 'PO: ' || v_po end,
    '',
    'Xem chi tiết: ' || v_link
  );
end;
$$;

revoke all on function public.build_finance_zalo_payment_request_message(uuid, text) from public, anon, authenticated;
revoke all on function public.build_finance_zalo_goods_receipt_message(uuid, text) from public, anon, authenticated;

create or replace function public.enqueue_finance_zalo_payment_request_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if new.status::text = 'pending' then
      insert into public.finance_zalo_notifications (
        event_type, entity_id, group_key, message_body, status
      ) values (
        'payment_request_created',
        new.id,
        'finance',
        coalesce(public.build_finance_zalo_payment_request_message(new.id, 'payment_request_created'), 'Duyệt chi mới: ' || new.request_number),
        'pending'
      )
      on conflict (event_type, entity_id) do nothing;
    end if;
  exception when others then
    -- Never break the business write; the outbox is best-effort.
    raise warning 'finance_zalo enqueue payment_request_created failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_finance_zalo_payment_request_created on public.payment_requests;
create trigger trg_finance_zalo_payment_request_created
after insert on public.payment_requests
for each row execute function public.enqueue_finance_zalo_payment_request_created();

create or replace function public.enqueue_finance_zalo_payment_request_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if new.status::text = 'approved'
       and new.payment_status::text = 'paid'
       and (
         old.status::text is distinct from 'approved'
         or old.payment_status::text is distinct from 'paid'
       ) then
      insert into public.finance_zalo_notifications (
        event_type, entity_id, group_key, message_body, status
      ) values (
        'payment_request_paid',
        new.id,
        'finance',
        coalesce(public.build_finance_zalo_payment_request_message(new.id, 'payment_request_paid'), 'Đã chi: ' || new.request_number),
        'pending'
      )
      on conflict (event_type, entity_id) do nothing;
    end if;
  exception when others then
    raise warning 'finance_zalo enqueue payment_request_paid failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_finance_zalo_payment_request_paid on public.payment_requests;
create trigger trg_finance_zalo_payment_request_paid
after update of status, payment_status on public.payment_requests
for each row execute function public.enqueue_finance_zalo_payment_request_paid();

create or replace function public.enqueue_finance_zalo_goods_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_short boolean;
  v_event text;
begin
  begin
    if new.status::text = 'received' and old.status::text is distinct from 'received' then
      select exists (
        select 1
        from public.goods_receipt_items gri
        where gri.goods_receipt_id = new.id and gri.line_status = 'thieu'
      ) into v_short;
      v_event := case when v_short then 'goods_receipt_short' else 'goods_receipt_received' end;

      insert into public.finance_zalo_notifications (
        event_type, entity_id, group_key, message_body, status
      ) values (
        v_event,
        new.id,
        'finance',
        coalesce(public.build_finance_zalo_goods_receipt_message(new.id, v_event), 'Phiếu nhận: ' || new.receipt_number),
        'pending'
      )
      on conflict (event_type, entity_id) do nothing;
    end if;
  exception when others then
    raise warning 'finance_zalo enqueue goods receipt failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_finance_zalo_goods_receipt on public.goods_receipts;
create trigger trg_finance_zalo_goods_receipt
after update of status on public.goods_receipts
for each row execute function public.enqueue_finance_zalo_goods_receipt();

revoke all on function public.enqueue_finance_zalo_payment_request_created() from public, anon, authenticated;
revoke all on function public.enqueue_finance_zalo_payment_request_paid() from public, anon, authenticated;
revoke all on function public.enqueue_finance_zalo_goods_receipt() from public, anon, authenticated;
