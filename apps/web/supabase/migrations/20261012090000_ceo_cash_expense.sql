-- CEO tải ảnh chi tiền mặt → app tự tạo, duyệt và ghi đã chi.
--
-- Additive only. This migration:
--   (a) adds public.ceo_cash_expense_drafts (one OCR draft per cash-expense
--       image, owner-only read, written by the edge function with service role),
--   (b) adds public.record_ceo_cash_expense: owner-only, idempotent, and in one
--       transaction inserts a pending cash payment request + items, approves it
--       through the canonical approve_payment_request_with_material_controller,
--       records the payments/payment_allocations rows (triggers set
--       payment_status = paid and paid_at), then inserts exactly ONE
--       public.payment_unc_evidence row linked to that payment so the existing
--       Chứng từ thanh toán lookup (usePaymentRequestUncEvidence) shows the CEO
--       voucher image, and stores the evidence id on the draft for replays,
--   (c) adds public.discard_ceo_cash_expense_draft for drafts only.
--
-- It never redefines an existing payment RPC/trigger, never touches the
-- warehouse sync, and NEVER reads or writes the QTM / cash-fund / daily-close
-- chain: ceo_daily_closing_declarations, cash_fund_topups and the finance
-- cutover tables are neither referenced nor modified by this migration or by
-- record_ceo_cash_expense.
-- It widens the payment_request_items.cost_review_routing check with the
-- 'manual_review' value requested by the CEO cash-expense slice (additive:
-- existing 'none' / 'needs_review' rows stay valid).

-- ---------------------------------------------------------------------------
-- 1. CEO cash-expense drafts.
-- ---------------------------------------------------------------------------
create table if not exists public.ceo_cash_expense_drafts (
  id uuid primary key default gen_random_uuid(),
  file_sha256 text not null,
  storage_path text not null,
  status text not null default 'draft',
  ocr_json jsonb,
  ocr_error text,
  payee_name text,
  matched_supplier_id uuid references public.suppliers(id) on delete set null,
  expense_date date,
  amount numeric(14, 0),
  description text,
  cost_category_code text references public.cost_categories(code),
  items jsonb not null default '[]'::jsonb,
  payment_request_id uuid references public.payment_requests(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  -- One payment_unc_evidence row per recorded cash expense; replay returns this
  -- id and never inserts a second row.
  evidence_id uuid references public.payment_unc_evidence(id) on delete set null,
  idempotency_key text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  recorded_at timestamptz,
  constraint ceo_cash_expense_drafts_status_check
    check (status in ('draft', 'recorded', 'discarded')),
  constraint ceo_cash_expense_drafts_amount_positive
    check (amount is null or amount > 0),
  constraint ceo_cash_expense_drafts_items_array
    check (jsonb_typeof(items) = 'array')
);

-- One image hash is recorded at most once; a discarded draft frees the hash so
-- the CEO can retry the same photo.
create unique index if not exists uq_ceo_cash_expense_drafts_file_sha256
  on public.ceo_cash_expense_drafts (file_sha256)
  where status <> 'discarded';

-- Server-side idempotency key; unique when present.
create unique index if not exists uq_ceo_cash_expense_drafts_idempotency_key
  on public.ceo_cash_expense_drafts (idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_ceo_cash_expense_drafts_created_at
  on public.ceo_cash_expense_drafts (created_at desc);
create index if not exists idx_ceo_cash_expense_drafts_status
  on public.ceo_cash_expense_drafts (status);

alter table public.ceo_cash_expense_drafts enable row level security;
-- Written only by the scan edge function (service role) and the SECURITY DEFINER
-- RPCs below; owners may read. No anon access, every grant explicit.
revoke all on public.ceo_cash_expense_drafts from public, anon, authenticated;
grant select on public.ceo_cash_expense_drafts to authenticated;
grant all on public.ceo_cash_expense_drafts to service_role;

drop policy if exists ceo_cash_expense_drafts_owner_select on public.ceo_cash_expense_drafts;
create policy ceo_cash_expense_drafts_owner_select
  on public.ceo_cash_expense_drafts
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'owner'));

-- ---------------------------------------------------------------------------
-- 2. Widen the item cost review routing with the requested manual_review value.
-- ---------------------------------------------------------------------------
alter table public.payment_request_items
  drop constraint if exists payment_request_items_cost_review_routing_check;

alter table public.payment_request_items
  add constraint payment_request_items_cost_review_routing_check
  check (cost_review_routing in ('none', 'needs_review', 'manual_review'));

-- ---------------------------------------------------------------------------
-- 3. record_ceo_cash_expense: one atomic, idempotent owner-only write.
-- ---------------------------------------------------------------------------
create or replace function public.record_ceo_cash_expense(
  p_draft_id uuid,
  p_fields jsonb,
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
  v_fields jsonb := coalesce(p_fields, '{}'::jsonb);
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_draft public.ceo_cash_expense_drafts%rowtype;
  v_prior public.ceo_cash_expense_drafts%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_amount numeric;
  v_amount_int numeric;
  v_expense_date date;
  v_category text;
  v_description text;
  v_payee text;
  v_title text;
  v_items jsonb;
  v_use_items jsonb := '[]'::jsonb;
  v_item_sum numeric := 0;
  v_item jsonb;
  v_line_total numeric;
  v_line_category text;
  v_line_name text;
  v_request_number text;
  v_pr_id uuid;
  v_payment_id uuid;
  v_pr_payment_status text;
  v_evidence_id uuid;
  v_evidence_path text;
  v_ocr_amount numeric;
  v_manual_override boolean := false;
  v_override_reason text;
  v_result jsonb;
begin
  -- Owner-only (service_role for trusted automation). Module edit permission is
  -- deliberately not accepted for CEO cash-expense recording.
  if not v_is_service then
    if v_actor is null then
      raise exception 'not_owner' using errcode = '42501';
    end if;
  end if;
  if not (v_is_service or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  if p_draft_id is null then
    raise exception 'draft_required' using errcode = '22023';
  end if;
  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;

  -- The same key can only belong to one draft.
  select * into v_prior
  from public.ceo_cash_expense_drafts
  where idempotency_key = v_key
  limit 1;
  if found and v_prior.id <> p_draft_id then
    raise exception 'duplicate' using errcode = '23505';
  end if;

  perform pg_advisory_xact_lock(hashtext('ceo_cash_expense:' || p_draft_id::text));

  select * into v_draft
  from public.ceo_cash_expense_drafts
  where id = p_draft_id
  for update;
  if not found then
    raise exception 'draft_not_found' using errcode = 'P0002';
  end if;
  if v_draft.status = 'discarded' then
    raise exception 'draft_discarded' using errcode = 'P0001';
  end if;
  if v_draft.status = 'recorded' then
    -- Replay: return the already-recorded result without writing anything.
    select pr.request_number into v_request_number
    from public.payment_requests pr
    where pr.id = v_draft.payment_request_id;
    return jsonb_build_object(
      'payment_request_id', v_draft.payment_request_id,
      'request_number', v_request_number,
      'payment_id', v_draft.payment_id,
      'evidence_id', v_draft.evidence_id,
      'replayed', true
    );
  end if;

  -- One image hash maps to at most one evidence row worldwide (UNC, standalone
  -- or cash): if this voucher was already used as another UNC/cash slip, fail
  -- closed before any write.
  if exists (
    select 1
    from public.payment_unc_evidence e
    where e.file_sha256 = v_draft.file_sha256
  ) then
    raise exception 'duplicate' using errcode = '23505';
  end if;

  -- --- Validate the CEO-confirmed fields against the same rules as the RPC ---
  v_amount := coalesce(nullif(v_fields->>'amount', '')::numeric, v_draft.amount);
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount) then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  v_amount_int := round(v_amount);
  if v_amount_int > 50000000 then
    raise exception 'amount_over_cash_limit' using errcode = '22023';
  end if;

  v_expense_date := coalesce(
    nullif(v_fields->>'expense_date', '')::date,
    v_draft.expense_date,
    v_today
  );
  if v_expense_date > v_today or v_expense_date < v_today - 90 then
    raise exception 'date_out_of_range' using errcode = '22023';
  end if;

  v_category := nullif(btrim(coalesce(
    v_fields->>'cost_category_code',
    v_draft.cost_category_code,
    ''
  )), '');
  v_category := upper(coalesce(v_category, 'UNMAPPED_REVIEW'));
  if not exists (
    select 1 from public.cost_categories c
    where c.code = v_category and c.is_active
  ) then
    raise exception 'invalid_category' using errcode = '22023';
  end if;

  v_description := nullif(btrim(coalesce(
    v_fields->>'description',
    v_draft.description,
    ''
  )), '');
  if v_description is null then
    raise exception 'description_required' using errcode = '22023';
  end if;
  v_description := left(v_description, 500);

  v_payee := nullif(btrim(coalesce(v_fields->>'payee_name', v_draft.payee_name, '')), '');
  v_payee := left(v_payee, 160);
  v_title := left('Chi tiền mặt: ' || coalesce(v_payee, v_description), 200);

  -- Items: keep the OCR lines only when their total matches the confirmed
  -- amount; otherwise record one aggregated line for the exact amount.
  if jsonb_typeof(v_fields->'items') = 'array' and jsonb_array_length(v_fields->'items') > 0 then
    v_items := v_fields->'items';
  elsif jsonb_typeof(v_draft.items) = 'array' then
    v_items := v_draft.items;
  else
    v_items := '[]'::jsonb;
  end if;

  select coalesce(sum(
    coalesce(
      nullif(item->>'line_total', '')::numeric,
      coalesce(nullif(item->>'quantity', '')::numeric, 1)
        * coalesce(nullif(item->>'unit_price', '')::numeric, 0)
    )
  ), 0)
  into v_item_sum
  from jsonb_array_elements(v_items) item;

  if jsonb_array_length(v_items) > 0 and round(v_item_sum) = v_amount_int then
    v_use_items := v_items;
  else
    v_use_items := jsonb_build_array(jsonb_build_object(
      'product_name', v_description,
      'quantity', 1,
      'unit', null,
      'unit_price', v_amount_int,
      'line_total', v_amount_int,
      'cost_category_code', v_category
    ));
  end if;

  -- --- (1) pending cash payment request --------------------------------
  v_request_number := 'PR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.payment_requests (
    request_number,
    title,
    description,
    supplier_id,
    total_amount,
    vat_amount,
    status,
    delivery_status,
    payment_status,
    payment_type,
    payment_method,
    requires_receipt,
    no_receipt_reason,
    no_receipt_set_by,
    no_receipt_set_at,
    image_url,
    created_by,
    notes
  ) values (
    v_request_number,
    v_title,
    v_description,
    v_draft.matched_supplier_id,
    v_amount_int,
    0,
    'pending',
    'pending',
    'unpaid',
    'new_order',
    'cash',
    false,
    'Chi tiền mặt từ ảnh chứng từ CEO xác nhận',
    v_actor,
    now(),
    v_draft.storage_path,
    v_actor,
    'Tạo tự động từ chứng từ chi tiền mặt ' || p_draft_id::text
  )
  returning id into v_pr_id;

  -- Owner decision 2026-10-10: a CEO cash expense is created and approved by the
  -- same owner in this one call, so the "an owner cannot approve a request they
  -- created" rule of approve_payment_requests_with_unc does NOT apply here. The
  -- voucher image is attached as payment evidence and created_by/approved_by
  -- record who did it. Every other payment flow keeps that rule.

  -- --- (2) items with cost_category_code ---------------------------------
  for v_item in select value from jsonb_array_elements(v_use_items) loop
    v_line_total := coalesce(
      nullif(v_item->>'line_total', '')::numeric,
      coalesce(nullif(v_item->>'quantity', '')::numeric, 1)
        * coalesce(nullif(v_item->>'unit_price', '')::numeric, 0)
    );
    if v_line_total <= 0 then
      v_line_total := v_amount_int;
    end if;

    v_line_category := upper(coalesce(
      nullif(btrim(coalesce(v_item->>'cost_category_code', '')), ''),
      v_category
    ));
    if not exists (
      select 1 from public.cost_categories c
      where c.code = v_line_category and c.is_active
    ) then
      v_line_category := v_category;
    end if;

    v_line_name := coalesce(
      nullif(btrim(coalesce(v_item->>'product_name', '')), ''),
      v_description
    );
    v_line_name := left(v_line_name, 200);

    -- standard_cost_code_type = 'OTHER' keeps cash-expense lines on the
    -- non-material path of assert_procurement_materials_ready, so a phiếu with
    -- no NVL evidence never blocks approval and never opens a material
    -- resolution queue entry.
    insert into public.payment_request_items (
      payment_request_id,
      product_name,
      quantity,
      unit,
      unit_price,
      line_total,
      cost_category_code,
      cost_review_routing,
      standard_cost_code_type
    ) values (
      v_pr_id,
      v_line_name,
      coalesce(nullif(v_item->>'quantity', '')::numeric, 1),
      coalesce(nullif(btrim(coalesce(v_item->>'unit', '')), ''), 'lần'),
      coalesce(nullif(v_item->>'unit_price', '')::numeric, v_line_total),
      v_line_total,
      v_line_category,
      case when v_line_category = 'UNMAPPED_REVIEW' then 'manual_review' else 'none' end,
      'OTHER'
    );
  end loop;

  -- --- (3) canonical approval (never a direct status update) --------------
  perform public.approve_payment_request_with_material_controller(
    v_pr_id,
    'cash',
    v_actor
  );

  -- --- (4) payment + allocation; triggers set payment_status/paid_at ------
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
    v_draft.matched_supplier_id,
    v_expense_date,
    v_amount_int,
    'cash',
    null,
    'ceo_cash_expense:' || p_draft_id::text,
    v_actor
  )
  returning id into v_payment_id;

  insert into public.payment_allocations (
    payment_id,
    payment_request_id,
    amount,
    created_by
  ) values (
    v_payment_id,
    v_pr_id,
    v_amount_int,
    v_actor
  );

  -- --- (5) exactly one payment_unc_evidence row for this cash payment -----
  -- The Chứng từ thanh toán lookup signs storage_path from the private
  -- payment-unc bucket, so store the object key without the bucket prefix (the
  -- UNC flow stores the prefixed form; normalizeUncStoragePath strips it before
  -- createSignedUrl, so both resolve and stripping matches the call directly).
  v_evidence_path := v_draft.storage_path;
  if v_evidence_path like 'payment-unc/%' then
    v_evidence_path := substr(v_evidence_path, length('payment-unc/') + 1);
  end if;

  -- Mirror the cash branch of approve_payment_requests_with_unc: the OCR amount
  -- is the stored evidence amount when the server-side draft has one, otherwise
  -- the CEO-confirmed amount; a confirmed amount that differs from the OCR
  -- amount is a reasoned manual override.
  v_ocr_amount := case
    when coalesce(v_draft.amount, 0) > 0 then v_draft.amount
    else v_amount_int
  end;
  v_manual_override := v_draft.amount is not null
    and v_amount_int is distinct from v_draft.amount;
  v_override_reason := case
    when v_manual_override then
      'ceo_cash_expense: OCR ' || coalesce(v_draft.amount::text, 'null')
        || ' -> xác nhận ' || v_amount_int::text
    else null
  end;

  begin
    insert into public.payment_unc_evidence (
      payment_id,
      storage_path,
      file_sha256,
      ocr_amount,
      transfer_date,
      manual_override,
      override_reason,
      category,
      note,
      created_by
    ) values (
      v_payment_id,
      v_evidence_path,
      v_draft.file_sha256,
      v_ocr_amount,
      v_expense_date,
      v_manual_override,
      v_override_reason,
      null,
      'ceo_cash_expense:' || p_draft_id::text,
      v_actor
    )
    returning id into v_evidence_id;
  exception when unique_violation then
    raise exception 'duplicate' using errcode = '23505';
  end;

  select pr.payment_status::text into v_pr_payment_status
  from public.payment_requests pr
  where pr.id = v_pr_id;
  if v_pr_payment_status <> 'paid' then
    raise exception 'payment_not_recorded' using errcode = 'P0001',
      detail = format('payment_status=%s', v_pr_payment_status);
  end if;

  update public.ceo_cash_expense_drafts
  set status = 'recorded',
      recorded_at = now(),
      payment_request_id = v_pr_id,
      payment_id = v_payment_id,
      evidence_id = v_evidence_id,
      idempotency_key = v_key,
      amount = v_amount_int,
      expense_date = v_expense_date,
      cost_category_code = v_category,
      description = v_description,
      payee_name = v_payee,
      items = v_use_items
  where id = p_draft_id;

  v_result := jsonb_build_object(
    'payment_request_id', v_pr_id,
    'request_number', v_request_number,
    'payment_id', v_payment_id,
    'evidence_id', v_evidence_id,
    'replayed', false
  );
  return v_result;
end;
$$;

revoke all on function public.record_ceo_cash_expense(uuid, jsonb, text) from public, anon;
grant execute on function public.record_ceo_cash_expense(uuid, jsonb, text) to authenticated, service_role;

comment on function public.record_ceo_cash_expense(uuid, jsonb, text) is
  'Owner-only idempotent RPC: validates CEO-confirmed cash-expense fields (integer amount <= 50,000,000, Vietnam date within 90 days, active cost category, non-empty description), inserts a pending cash payment request + items, approves it through approve_payment_request_with_material_controller, records one cash payment + allocation (triggers set paid/paid_at), inserts exactly one payment_unc_evidence row (file_sha256 unique; reused image raises duplicate before any write) using the draft voucher path/amount and marks it manual_override with a reason when the confirmed amount differs from OCR, stores the evidence id on the draft, and replays the same result (with the stored evidence id) for an already-recorded draft or a reused idempotency key. Never reads or writes the daily-close / cash-fund chain.';

-- ---------------------------------------------------------------------------
-- 4. discard_ceo_cash_expense_draft: owner-only, drafts only.
-- ---------------------------------------------------------------------------
create or replace function public.discard_ceo_cash_expense_draft(p_draft_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_draft public.ceo_cash_expense_drafts%rowtype;
begin
  if not v_is_service then
    if v_actor is null then
      raise exception 'not_owner' using errcode = '42501';
    end if;
  end if;
  if not (v_is_service or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  if p_draft_id is null then
    raise exception 'draft_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('ceo_cash_expense:' || p_draft_id::text));

  select * into v_draft
  from public.ceo_cash_expense_drafts
  where id = p_draft_id
  for update;
  if not found then
    raise exception 'draft_not_found' using errcode = 'P0002';
  end if;
  if v_draft.status <> 'draft' then
    raise exception 'draft_not_draft' using errcode = 'P0001',
      detail = format('status=%s', v_draft.status);
  end if;

  update public.ceo_cash_expense_drafts
  set status = 'discarded'
  where id = p_draft_id;

  return jsonb_build_object('id', p_draft_id, 'status', 'discarded');
end;
$$;

revoke all on function public.discard_ceo_cash_expense_draft(uuid) from public, anon;
grant execute on function public.discard_ceo_cash_expense_draft(uuid) to authenticated, service_role;

comment on function public.discard_ceo_cash_expense_draft(uuid) is
  'Owner-only RPC: marks a CEO cash-expense draft discarded (status must be draft) and returns {id, status}.';
