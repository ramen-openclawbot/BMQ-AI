-- Rollback-only production smoke for migration
-- 20261012090000_ceo_cash_expense.sql.
--
-- Run as one file: `supabase db query --linked -f supabase/tests/ceo_cash_expense_prod_smoke.sql`.
-- The file opens one transaction, applies the migration SQL inline (nothing is
-- persisted because the transaction is always aborted), builds rollback-only
-- fixtures and exercises the record / discard RPCs and every guard. The final
-- RAISE ends the transaction, so every draft, payment request, item, payment and
-- allocation created here is rolled back. No existing business row is modified.
begin;

-- ---------------------------------------------------------------------------
-- Inline copy of 20261012090000_ceo_cash_expense.sql
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

create unique index if not exists uq_ceo_cash_expense_drafts_file_sha256
  on public.ceo_cash_expense_drafts (file_sha256)
  where status <> 'discarded';

create unique index if not exists uq_ceo_cash_expense_drafts_idempotency_key
  on public.ceo_cash_expense_drafts (idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_ceo_cash_expense_drafts_created_at
  on public.ceo_cash_expense_drafts (created_at desc);
create index if not exists idx_ceo_cash_expense_drafts_status
  on public.ceo_cash_expense_drafts (status);

alter table public.ceo_cash_expense_drafts enable row level security;
revoke all on public.ceo_cash_expense_drafts from public, anon, authenticated;
grant select on public.ceo_cash_expense_drafts to authenticated;
grant all on public.ceo_cash_expense_drafts to service_role;

drop policy if exists ceo_cash_expense_drafts_owner_select on public.ceo_cash_expense_drafts;
create policy ceo_cash_expense_drafts_owner_select
  on public.ceo_cash_expense_drafts
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'owner'));

alter table public.payment_request_items
  drop constraint if exists payment_request_items_cost_review_routing_check;

alter table public.payment_request_items
  add constraint payment_request_items_cost_review_routing_check
  check (cost_review_routing in ('none', 'needs_review', 'manual_review'));

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
  -- or cash): reject a reused voucher before any write.
  if exists (
    select 1
    from public.payment_unc_evidence e
    where e.file_sha256 = v_draft.file_sha256
  ) then
    raise exception 'duplicate' using errcode = '23505';
  end if;

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

  v_request_number := 'PR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.payment_requests (
    request_number, title, description, supplier_id, total_amount, vat_amount,
    status, delivery_status, payment_status, payment_type, payment_method,
    requires_receipt, no_receipt_reason, no_receipt_set_by, no_receipt_set_at,
    image_url, created_by, notes
  ) values (
    v_request_number, v_title, v_description, v_draft.matched_supplier_id,
    v_amount_int, 0, 'pending', 'pending', 'unpaid', 'new_order', 'cash',
    false, 'Chi tiền mặt từ ảnh chứng từ CEO xác nhận', v_actor, now(),
    v_draft.storage_path, v_actor,
    'Tạo tự động từ chứng từ chi tiền mặt ' || p_draft_id::text
  )
  returning id into v_pr_id;

  -- Owner decision 2026-10-10: no self-approval rule for the CEO cash flow.

  for v_item in select value from jsonb_array_elements(v_use_items) loop
    v_line_total := coalesce(
      nullif(v_item->>'line_total', '')::numeric,
      coalesce(nullif(v_item->>'quantity', '')::numeric, 1)
        * coalesce(nullif(v_item->>'unit_price', '')::numeric, 0)
    );
    if v_line_total <= 0 then v_line_total := v_amount_int; end if;

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

    insert into public.payment_request_items (
      payment_request_id, product_name, quantity, unit, unit_price, line_total,
      cost_category_code, cost_review_routing, standard_cost_code_type
    ) values (
      v_pr_id, v_line_name,
      coalesce(nullif(v_item->>'quantity', '')::numeric, 1),
      coalesce(nullif(btrim(coalesce(v_item->>'unit', '')), ''), 'lần'),
      coalesce(nullif(v_item->>'unit_price', '')::numeric, v_line_total),
      v_line_total, v_line_category,
      case when v_line_category = 'UNMAPPED_REVIEW' then 'manual_review' else 'none' end,
      'OTHER'
    );
  end loop;

  perform public.approve_payment_request_with_material_controller(v_pr_id, 'cash', v_actor);

  perform pg_advisory_xact_lock(hashtext('public.payments.payment_number'));

  insert into public.payments (
    payment_number, supplier_id, payment_date, amount, payment_method,
    reference_number, notes, created_by
  ) values (
    public.next_payment_number(), v_draft.matched_supplier_id, v_expense_date,
    v_amount_int, 'cash', null, 'ceo_cash_expense:' || p_draft_id::text, v_actor
  )
  returning id into v_payment_id;

  insert into public.payment_allocations (
    payment_id, payment_request_id, amount, created_by
  ) values (v_payment_id, v_pr_id, v_amount_int, v_actor);

  v_evidence_path := v_draft.storage_path;
  if v_evidence_path like 'payment-unc/%' then
    v_evidence_path := substr(v_evidence_path, length('payment-unc/') + 1);
  end if;

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
      payment_id, storage_path, file_sha256, ocr_amount, transfer_date,
      manual_override, override_reason, category, note, created_by
    ) values (
      v_payment_id, v_evidence_path, v_draft.file_sha256, v_ocr_amount,
      v_expense_date, v_manual_override, v_override_reason, null,
      'ceo_cash_expense:' || p_draft_id::text, v_actor
    )
    returning id into v_evidence_id;
  exception when unique_violation then
    raise exception 'duplicate' using errcode = '23505';
  end;

  select pr.payment_status::text into v_pr_payment_status
  from public.payment_requests pr where pr.id = v_pr_id;
  if v_pr_payment_status <> 'paid' then
    raise exception 'payment_not_recorded' using errcode = 'P0001',
      detail = format('payment_status=%s', v_pr_payment_status);
  end if;

  update public.ceo_cash_expense_drafts
  set status = 'recorded', recorded_at = now(), payment_request_id = v_pr_id,
      payment_id = v_payment_id, evidence_id = v_evidence_id, idempotency_key = v_key,
      amount = v_amount_int, expense_date = v_expense_date,
      cost_category_code = v_category, description = v_description,
      payee_name = v_payee, items = v_use_items
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

-- ---------------------------------------------------------------------------
-- Behavioural checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
  v_other uuid := gen_random_uuid();
  v_supplier uuid := gen_random_uuid();
  v_draft uuid := gen_random_uuid();
  v_draft_dup uuid := gen_random_uuid();
  v_draft_zero uuid := gen_random_uuid();
  v_draft_limit uuid := gen_random_uuid();
  v_draft_bad_category uuid := gen_random_uuid();
  v_draft_future uuid := gen_random_uuid();
  v_draft_discard uuid := gen_random_uuid();
  v_draft_override uuid := gen_random_uuid();
  v_draft_evidence_dup uuid := gen_random_uuid();
  v_sha text := 'smoke-ceo-cash-' || replace(gen_random_uuid()::text, '-', '');
  v_sha_override text;
  v_sha_evidence text;
  v_category text;
  v_result jsonb;
  v_replay jsonb;
  v_pr uuid;
  v_payment uuid;
  v_count integer;
  v_effective text;
  v_ok boolean;
  v_evidence_id uuid;
  v_evidence_count integer;
  v_storage_expected text;
  v_closing_before integer;
  v_fund_before integer;
  v_cutover_before integer;
  v_closing_after integer;
  v_fund_after integer;
  v_cutover_after integer;
begin
  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL owner_missing';
  end if;

  v_sha_override := v_sha || '-override';
  v_sha_evidence := v_sha || '-evidence';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  -- Baseline QTM / cash-fund / cutover counts. The CEO cash-expense record must
  -- never read or write these chains, so the counts must be identical after.
  select count(*) into v_closing_before from public.ceo_daily_closing_declarations;
  select count(*) into v_fund_before from public.cash_fund_topups;
  select count(*) into v_cutover_before from public.finance_period_cutovers;

  -- Minimal privilege checks: anon must never be able to execute either RPC.
  if has_function_privilege('anon', 'public.record_ceo_cash_expense(uuid,jsonb,text)', 'EXECUTE') then
    raise exception 'SMOKE_RESULT FAIL anon_can_record';
  end if;
  if has_function_privilege('anon', 'public.discard_ceo_cash_expense_draft(uuid)', 'EXECUTE') then
    raise exception 'SMOKE_RESULT FAIL anon_can_discard';
  end if;

  -- Rollback-only fixture: one supplier + one confirmed category.
  insert into public.suppliers (id, name) values (v_supplier, 'SMOKE cash-expense supplier');
  select code into v_category
  from public.cost_categories
  where is_active and code <> 'UNMAPPED_REVIEW'
  order by sort_order
  limit 1;
  if v_category is null then
    raise exception 'SMOKE_RESULT FAIL no_active_category';
  end if;

  insert into public.ceo_cash_expense_drafts (
    id, file_sha256, storage_path, status, payee_name, matched_supplier_id,
    expense_date, amount, description, cost_category_code, items, created_by
  ) values (
    v_draft, v_sha, 'payment-unc/ceo-cash/smoke/' || v_sha || '.jpg', 'draft',
    'SMOKE người nhận', v_supplier, current_date, 1250000,
    'SMOKE chi tiền mặt', v_category,
    jsonb_build_array(jsonb_build_object(
      'product_name', 'SMOKE hàng', 'quantity', 1,
      'unit_price', 1250000, 'line_total', 1250000,
      'cost_category_code', v_category
    )),
    v_owner
  );

  -- (1) First record succeeds and writes exactly one paid cash chain.
  execute 'set local role authenticated';
  v_result := public.record_ceo_cash_expense(
    v_draft,
    jsonb_build_object(
      'amount', 1250000,
      'expense_date', to_char(current_date, 'YYYY-MM-DD'),
      'cost_category_code', v_category,
      'description', 'SMOKE chi tiền mặt đã sửa'
    ),
    'ceo-cash:' || v_draft::text
  );
  execute 'reset role';

  if coalesce((v_result->>'replayed')::boolean, false) then
    raise exception 'SMOKE_RESULT FAIL first_not_replayed_false';
  end if;
  v_pr := (v_result->>'payment_request_id')::uuid;
  v_payment := (v_result->>'payment_id')::uuid;

  select count(*) into v_count
  from public.payment_requests
  where id = v_pr
    and payment_method = 'cash'
    and status = 'approved'
    and payment_status = 'paid'
    and approved_by = v_owner
    and requires_receipt = false
    and image_url = 'payment-unc/ceo-cash/smoke/' || v_sha || '.jpg';
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL payment_request';
  end if;

  select count(*) into v_count
  from public.payment_request_items
  where payment_request_id = v_pr and cost_category_code = v_category;
  if v_count < 1 then
    raise exception 'SMOKE_RESULT FAIL item_category';
  end if;

  select count(*) into v_count
  from public.payments
  where id = v_payment and payment_method = 'cash'
    and notes = 'ceo_cash_expense:' || v_draft::text;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL payment';
  end if;

  select count(*) into v_count
  from public.payment_allocations
  where payment_id = v_payment and payment_request_id = v_pr;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL allocation';
  end if;

  -- (1a) Exactly one payment_unc_evidence row, linked to the new payment, with
  -- the voucher object key (bucket prefix stripped), hash and amount.
  v_evidence_id := (v_result->>'evidence_id')::uuid;
  if v_evidence_id is null then
    raise exception 'SMOKE_RESULT FAIL evidence_id_missing';
  end if;

  v_storage_expected := 'ceo-cash/smoke/' || v_sha || '.jpg';
  select count(*) into v_evidence_count
  from public.payment_unc_evidence
  where id = v_evidence_id
    and payment_id = v_payment
    and file_sha256 = v_sha
    and storage_path = v_storage_expected
    and ocr_amount = 1250000
    and transfer_date = current_date
    and manual_override = false
    and override_reason is null
    and category is null
    and note = 'ceo_cash_expense:' || v_draft::text
    and created_by = v_owner;
  if v_evidence_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL evidence_row count=% path=%', v_evidence_count, v_storage_expected;
  end if;

  select count(*) into v_count
  from public.ceo_cash_expense_drafts
  where id = v_draft and evidence_id = v_evidence_id and status = 'recorded';
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL evidence_id_on_draft';
  end if;

  -- (1b) The evidence lookup used by usePaymentRequestUncEvidence
  -- (payment_allocations -> payments -> oldest evidence per payment) returns this
  -- row for the request.
  select count(*) into v_count
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  left join lateral (
    select e2.id, e2.storage_path, e2.ocr_amount, e2.file_sha256
    from public.payment_unc_evidence e2
    where e2.payment_id = p.id
    order by e2.created_at
    limit 1
  ) e on true
  where pa.payment_request_id = v_pr
    and e.id = v_evidence_id
    and e.storage_path = v_storage_expected
    and e.file_sha256 = v_sha
    and e.ocr_amount = 1250000;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL evidence_lookup count=%', v_count;
  end if;

  -- (1c) QTM / cash-fund / cutover rows are untouched.
  select count(*) into v_closing_after from public.ceo_daily_closing_declarations;
  select count(*) into v_fund_after from public.cash_fund_topups;
  select count(*) into v_cutover_after from public.finance_period_cutovers;
  if v_closing_after <> v_closing_before then
    raise exception 'SMOKE_RESULT FAIL qtm_closing_changed before=% after=%', v_closing_before, v_closing_after;
  end if;
  if v_fund_after <> v_fund_before then
    raise exception 'SMOKE_RESULT FAIL cash_fund_changed before=% after=%', v_fund_before, v_fund_after;
  end if;
  if v_cutover_after <> v_cutover_before then
    raise exception 'SMOKE_RESULT FAIL finance_cutover_changed before=% after=%', v_cutover_before, v_cutover_after;
  end if;

  -- classify_paid_payment_request does not read the item category itself; the
  -- canonical views coalesce the item code first, so the CEO category survives.
  select coalesce(pri.cost_category_code, clc.category_code) into v_effective
  from public.payment_request_items pri
  left join public.cost_line_classifications clc
    on clc.source_type = 'payment_request_item' and clc.source_line_id = pri.id
  where pri.payment_request_id = v_pr
  limit 1;
  if v_effective is distinct from v_category then
    raise exception 'SMOKE_RESULT FAIL classification_category effective=%', v_effective;
  end if;

  -- (2) Same key replays and does not add rows.
  execute 'set local role authenticated';
  v_replay := public.record_ceo_cash_expense(
    v_draft,
    jsonb_build_object('amount', 1250000, 'expense_date', to_char(current_date, 'YYYY-MM-DD')),
    'ceo-cash:' || v_draft::text
  );
  execute 'reset role';
  if coalesce((v_replay->>'replayed')::boolean, false) is not true then
    raise exception 'SMOKE_RESULT FAIL replay_flag';
  end if;
  if (v_replay->>'evidence_id')::uuid is distinct from v_evidence_id then
    raise exception 'SMOKE_RESULT FAIL replay_evidence_id';
  end if;
  select count(*) into v_count
  from public.payment_unc_evidence
  where payment_id = v_payment;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL replay_evidence_count count=%', v_count;
  end if;
  select count(*) into v_count
  from public.payment_requests
  where notes = 'Tạo tự động từ chứng từ chi tiền mặt ' || v_draft::text;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL replay_duplicated_request count=%', v_count;
  end if;

  -- (3) A non-owner caller is rejected with not_owner.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_other, 'role', 'authenticated')::text,
    true
  );
  v_ok := false;
  execute 'set local role authenticated';
  begin
    perform public.record_ceo_cash_expense(
      v_draft, jsonb_build_object('amount', 1250000), 'ceo-cash:' || v_draft::text
    );
  exception when others then
    v_ok := sqlerrm like '%not_owner%';
  end;
  execute 'reset role';
  if not v_ok then
    raise exception 'SMOKE_RESULT FAIL non_owner_not_blocked';
  end if;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  -- (4) Duplicate image hash is blocked by the partial unique index.
  v_ok := false;
  begin
    insert into public.ceo_cash_expense_drafts (
      id, file_sha256, storage_path, status, amount, description,
      cost_category_code, items, created_by
    ) values (
      v_draft_dup, v_sha, 'payment-unc/ceo-cash/smoke/' || v_sha || '.jpg',
      'draft', 1000, 'SMOKE trùng ảnh', v_category, '[]'::jsonb, v_owner
    );
  exception when unique_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'SMOKE_RESULT FAIL duplicate_sha_not_blocked';
  end if;

  -- (4a) A confirmed amount that differs from the OCR amount is stored as a
  -- reasoned manual override; the evidence amount stays the OCR amount.
  insert into public.ceo_cash_expense_drafts (
    id, file_sha256, storage_path, status, payee_name, matched_supplier_id,
    expense_date, amount, description, cost_category_code, items, created_by
  ) values (
    v_draft_override, v_sha_override,
    'payment-unc/ceo-cash/smoke/' || v_sha_override || '.jpg', 'draft',
    'SMOKE override', v_supplier, current_date, 1300000, 'SMOKE override',
    v_category, '[]'::jsonb, v_owner
  );

  execute 'set local role authenticated';
  v_result := public.record_ceo_cash_expense(
    v_draft_override,
    jsonb_build_object(
      'amount', 1250000,
      'expense_date', to_char(current_date, 'YYYY-MM-DD'),
      'cost_category_code', v_category,
      'description', 'SMOKE override'
    ),
    'ceo-cash:' || v_draft_override::text
  );
  execute 'reset role';

  select count(*) into v_count
  from public.payment_unc_evidence
  where payment_id = (v_result->>'payment_id')::uuid
    and file_sha256 = v_sha_override
    and storage_path = 'ceo-cash/smoke/' || v_sha_override || '.jpg'
    and ocr_amount = 1300000
    and manual_override = true
    and btrim(coalesce(override_reason, '')) <> '';
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL evidence_manual_override count=%', v_count;
  end if;

  -- (4b) A draft whose image hash already exists in payment_unc_evidence fails
  -- with duplicate and writes no request/payment/evidence row.
  insert into public.payment_unc_evidence (
    file_sha256, storage_path, ocr_amount, transfer_date, created_by
  ) values (
    v_sha_evidence, 'ceo-cash/smoke/' || v_sha_evidence || '.jpg', 1000,
    current_date, v_owner
  );

  insert into public.ceo_cash_expense_drafts (
    id, file_sha256, storage_path, status, amount, description,
    cost_category_code, items, created_by
  ) values (
    v_draft_evidence_dup, v_sha_evidence,
    'payment-unc/ceo-cash/smoke/' || v_sha_evidence || '.jpg', 'draft', 1000,
    'SMOKE trùng evidence', v_category, '[]'::jsonb, v_owner
  );

  select count(*) into v_evidence_count from public.payment_unc_evidence;
  v_ok := false;
  execute 'set local role authenticated';
  begin
    perform public.record_ceo_cash_expense(
      v_draft_evidence_dup,
      jsonb_build_object('amount', 1000, 'expense_date', to_char(current_date, 'YYYY-MM-DD'),
                         'cost_category_code', v_category, 'description', 'SMOKE trùng evidence'),
      'ceo-cash:' || v_draft_evidence_dup::text
    );
  exception when others then
    v_ok := sqlerrm like '%duplicate%';
  end;
  execute 'reset role';
  if not v_ok then
    raise exception 'SMOKE_RESULT FAIL evidence_duplicate_not_blocked';
  end if;

  select count(*) into v_count from public.payment_unc_evidence;
  if v_count <> v_evidence_count then
    raise exception 'SMOKE_RESULT FAIL evidence_duplicate_wrote_rows before=% after=%', v_evidence_count, v_count;
  end if;
  select count(*) into v_count
  from public.payment_requests
  where notes = 'Tạo tự động từ chứng từ chi tiền mặt ' || v_draft_evidence_dup::text;
  if v_count <> 0 then
    raise exception 'SMOKE_RESULT FAIL evidence_duplicate_wrote_request count=%', v_count;
  end if;
  select count(*) into v_count
  from public.ceo_cash_expense_drafts
  where id = v_draft_evidence_dup and status = 'draft' and payment_request_id is null;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL evidence_duplicate_draft_write';
  end if;

  -- (5) Validation guards on fresh drafts.
  insert into public.ceo_cash_expense_drafts (
    id, file_sha256, storage_path, status, description, cost_category_code, items, created_by
  ) values
    (v_draft_zero, v_sha || '-zero', 'p/zero.jpg', 'draft', 'zero', v_category, '[]'::jsonb, v_owner),
    (v_draft_limit, v_sha || '-limit', 'p/limit.jpg', 'draft', 'limit', v_category, '[]'::jsonb, v_owner),
    (v_draft_bad_category, v_sha || '-cat', 'p/cat.jpg', 'draft', 'cat', v_category, '[]'::jsonb, v_owner),
    (v_draft_future, v_sha || '-future', 'p/future.jpg', 'draft', 'future', v_category, '[]'::jsonb, v_owner),
    (v_draft_discard, v_sha || '-discard', 'p/discard.jpg', 'draft', 'discard', v_category, '[]'::jsonb, v_owner);

  v_ok := false;
  begin
    perform public.record_ceo_cash_expense(
      v_draft_zero,
      jsonb_build_object('amount', 0, 'expense_date', to_char(current_date, 'YYYY-MM-DD'),
                         'cost_category_code', v_category, 'description', 'zero'),
      'ceo-cash:' || v_draft_zero::text
    );
  exception when others then
    v_ok := sqlerrm like '%invalid_amount%';
  end;
  if not v_ok then raise exception 'SMOKE_RESULT FAIL amount_zero'; end if;

  v_ok := false;
  begin
    perform public.record_ceo_cash_expense(
      v_draft_limit,
      jsonb_build_object('amount', 50000001, 'expense_date', to_char(current_date, 'YYYY-MM-DD'),
                         'cost_category_code', v_category, 'description', 'limit'),
      'ceo-cash:' || v_draft_limit::text
    );
  exception when others then
    v_ok := sqlerrm like '%amount_over_cash_limit%';
  end;
  if not v_ok then raise exception 'SMOKE_RESULT FAIL amount_over_limit'; end if;

  v_ok := false;
  begin
    perform public.record_ceo_cash_expense(
      v_draft_bad_category,
      jsonb_build_object('amount', 1000, 'expense_date', to_char(current_date, 'YYYY-MM-DD'),
                         'cost_category_code', 'NOT_A_CATEGORY', 'description', 'cat'),
      'ceo-cash:' || v_draft_bad_category::text
    );
  exception when others then
    v_ok := sqlerrm like '%invalid_category%';
  end;
  if not v_ok then raise exception 'SMOKE_RESULT FAIL invalid_category'; end if;

  v_ok := false;
  begin
    perform public.record_ceo_cash_expense(
      v_draft_future,
      jsonb_build_object('amount', 1000, 'expense_date', to_char(current_date + 1, 'YYYY-MM-DD'),
                         'cost_category_code', v_category, 'description', 'future'),
      'ceo-cash:' || v_draft_future::text
    );
  exception when others then
    v_ok := sqlerrm like '%date_out_of_range%';
  end;
  if not v_ok then raise exception 'SMOKE_RESULT FAIL future_date'; end if;

  -- (6) Discard only works on a draft, and blocks a re-record afterwards.
  v_result := public.discard_ceo_cash_expense_draft(v_draft_discard);
  if v_result->>'status' <> 'discarded' then
    raise exception 'SMOKE_RESULT FAIL discard_status';
  end if;
  v_ok := false;
  begin
    perform public.record_ceo_cash_expense(
      v_draft_discard,
      jsonb_build_object('amount', 1000, 'expense_date', to_char(current_date, 'YYYY-MM-DD'),
                         'cost_category_code', v_category, 'description', 'discard'),
      'ceo-cash:' || v_draft_discard::text
    );
  exception when others then
    v_ok := sqlerrm like '%draft_discarded%';
  end;
  if not v_ok then raise exception 'SMOKE_RESULT FAIL discarded_record'; end if;

  v_ok := false;
  begin
    perform public.discard_ceo_cash_expense_draft(v_draft);
  exception when others then
    v_ok := sqlerrm like '%draft_not_draft%';
  end;
  if not v_ok then raise exception 'SMOKE_RESULT FAIL discard_recorded'; end if;

  raise exception 'SMOKE_RESULT PASS: ceo cash expense record + guards ok (request=%, payment=%)', v_pr, v_payment;
end $$;
