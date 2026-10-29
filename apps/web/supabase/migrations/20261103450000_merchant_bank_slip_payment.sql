-- Merchant agent — bank-slip payment staged change.
--
-- Additive only. This migration:
--   (a) lets merchant_staged_changes store the new kind 'bank_slip_payment',
--   (b) adds merchant_prepare_bank_slip_request(uuid): approved change -> one
--       pending payment request (create_new) or a re-verified existing pending
--       request (pay_existing), idempotent through payload.prepared_request_id,
--   (c) adds merchant_finalize_bank_slip_payment(uuid, text): after the existing
--       UNC confirm has paid the request, approves the chosen cost category and
--       marks the staged change applied.
--
-- Neither function writes payments or payment_unc_evidence: the existing
-- payment-unc-approve confirm path owns those writes. Nothing here is applied by
-- the coding agent.

-- ---------------------------------------------------------------------------
-- 1. Staged-change kind.
-- ---------------------------------------------------------------------------
alter table public.merchant_staged_changes
  drop constraint if exists merchant_staged_changes_kind_check;

alter table public.merchant_staged_changes
  add constraint merchant_staged_changes_kind_check
  check (
    kind in (
      'listing',
      'price',
      'inventory',
      'promotion',
      'campaign',
      'bank_slip_payment'
    )
  );

comment on column public.merchant_staged_changes.kind is
  'listing | price | inventory | promotion | campaign | bank_slip_payment';

-- ---------------------------------------------------------------------------
-- 2. Prepare: approved bank_slip_payment -> one pending payment request.
--
-- The finance cost views date an approved request by
-- (payment_requests.created_at at time zone 'Asia/Ho_Chi_Minh')::date. A new
-- request therefore stores created_at at midnight on the slip transfer_date so
-- it lands in the transfer month; without a transfer_date it keeps now().
-- ---------------------------------------------------------------------------
create or replace function public.merchant_prepare_bank_slip_request(
  p_change_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_change public.merchant_staged_changes;
  v_payload jsonb;
  v_slip jsonb;
  v_ocr jsonb;
  v_target jsonb;
  v_mode text;
  v_supplier_id uuid;
  v_amount numeric;
  v_title text;
  v_line_name text;
  v_reference text;
  v_transfer_date date;
  v_notes text;
  v_prior_id uuid;
  v_request_id uuid;
  v_request_number text;
  v_remaining numeric;
  v_pr record;
  v_attempt integer;
  v_created_at timestamptz;
begin
  if p_change_id is null then
    raise exception 'change_id_required' using errcode = '22023';
  end if;

  select *
    into v_change
  from public.merchant_staged_changes
  where id = p_change_id
  for update;

  if not found then
    raise exception 'change_not_found' using errcode = 'P0002';
  end if;
  if v_change.kind <> 'bank_slip_payment' then
    raise exception 'invalid_change_kind' using errcode = '22023';
  end if;
  if v_change.status <> 'approved' then
    raise exception 'change_not_approved' using errcode = '22023';
  end if;

  v_payload := coalesce(v_change.payload, '{}'::jsonb);
  v_slip := coalesce(v_payload -> 'slip', '{}'::jsonb);
  v_ocr := coalesce(v_slip -> 'ocr', '{}'::jsonb);
  v_target := coalesce(v_payload -> 'target', '{}'::jsonb);

  -- Idempotency: a second approve after a failed confirm reuses the request that
  -- the first prepare already created.
  v_prior_id := nullif(v_payload ->> 'prepared_request_id', '')::uuid;
  if v_prior_id is not null then
    select pr.request_number
      into v_request_number
    from public.payment_requests pr
    where pr.id = v_prior_id;
    return jsonb_build_object(
      'request_id', v_prior_id,
      'request_number', v_request_number,
      'created', false
    );
  end if;

  v_mode := nullif(btrim(coalesce(v_target ->> 'mode', '')), '');
  v_supplier_id := nullif(v_payload -> 'supplier' ->> 'id', '')::uuid;
  v_amount := coalesce(
    nullif(v_target ->> 'amount', '')::numeric,
    nullif(v_ocr ->> 'amount', '')::numeric,
    nullif(v_slip ->> 'amount', '')::numeric
  );
  v_reference := nullif(btrim(coalesce(v_ocr ->> 'reference', v_slip ->> 'reference', '')), '');
  v_transfer_date := coalesce(
    nullif(v_ocr ->> 'transfer_date', '')::date,
    nullif(v_slip ->> 'transfer_date', '')::date
  );

  if v_amount is null or v_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if v_supplier_id is null then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

  if v_mode = 'pay_existing' then
    v_request_id := nullif(v_target ->> 'request_id', '')::uuid;
    if v_request_id is null then
      raise exception 'request_id_required' using errcode = '22023';
    end if;

    select *
      into v_pr
    from public.payment_requests pr
    where pr.id = v_request_id
    for update;

    if not found then
      raise exception 'request_not_found' using errcode = 'P0002';
    end if;
    if v_pr.status::text <> 'pending' or v_pr.payment_status::text <> 'unpaid' then
      raise exception 'not_pending' using errcode = 'P0001',
        detail = format('request_number=%s', v_pr.request_number);
    end if;
    if v_pr.supplier_id is distinct from v_supplier_id then
      raise exception 'supplier_mismatch' using errcode = 'P0001',
        detail = format('request_number=%s', v_pr.request_number);
    end if;

    v_remaining := coalesce(v_pr.total_amount, 0) - coalesce((
      select sum(pa.amount)
      from public.payment_allocations pa
      where pa.payment_request_id = v_pr.id
    ), 0);
    if v_remaining <> v_amount then
      raise exception 'amount_mismatch' using errcode = 'P0001',
        detail = format(
          'request_number=%s remaining=%s slip_amount=%s',
          v_pr.request_number,
          v_remaining,
          v_amount
        );
    end if;

    v_request_id := v_pr.id;
    v_request_number := v_pr.request_number;
  elsif v_mode = 'create_new' then
    if v_supplier_id is null then
      raise exception 'supplier_required' using errcode = '22023';
    end if;

    v_title := nullif(btrim(coalesce(v_target ->> 'title', '')), '');
    if v_title is null or length(v_title) > 200 then
      raise exception 'invalid_title' using errcode = '22023';
    end if;

    v_line_name := nullif(btrim(coalesce(v_target ->> 'line_name', v_title, '')), '');
    if v_line_name is null or length(v_line_name) > 200 then
      v_line_name := left(v_title, 200);
    end if;

    v_notes := concat_ws(
      ' · ',
      nullif(btrim(coalesce(v_payload ->> 'notes', '')), ''),
      'Bankslip ' || coalesce(v_reference, ''),
      'Duyệt từ chatbox'
    );

    v_created_at := case
      when v_transfer_date is null then now()
      else v_transfer_date::timestamp at time zone 'Asia/Ho_Chi_Minh'
    end;

    v_attempt := 0;
    loop
      v_attempt := v_attempt + 1;
      v_request_number := 'PR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      begin
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
          notes,
          created_by,
          created_at
        ) values (
          v_request_number,
          v_title,
          v_line_name,
          v_supplier_id,
          v_amount,
          0,
          'pending',
          'pending',
          'unpaid',
          'new_order',
          'bank_transfer',
          false,
          'Chi phí định kỳ, duyệt từ bankslip trong chat',
          v_change.decided_by,
          now(),
          v_notes,
          v_change.decided_by,
          v_created_at
        )
        returning id into v_request_id;
        exit;
      exception when unique_violation then
        if v_attempt >= 5 then
          raise;
        end if;
      end;
    end loop;

    insert into public.payment_request_items (
      payment_request_id,
      product_name,
      quantity,
      unit,
      unit_price,
      line_total,
      cost_review_routing,
      standard_cost_code_type
    ) values (
      v_request_id,
      v_line_name,
      1,
      'lần',
      v_amount,
      v_amount,
      'none',
      'OTHER'
    );
  else
    raise exception 'invalid_target_mode' using errcode = '22023';
  end if;

  update public.merchant_staged_changes
  set payload = jsonb_set(
    payload,
    '{prepared_request_id}',
    to_jsonb(v_request_id),
    true
  )
  where id = p_change_id;

  return jsonb_build_object(
    'request_id', v_request_id,
    'request_number', v_request_number,
    'created', v_mode = 'create_new'
  );
end;
$$;

revoke all on function public.merchant_prepare_bank_slip_request(uuid)
  from public, anon, authenticated;
grant execute on function public.merchant_prepare_bank_slip_request(uuid)
  to service_role;

comment on function public.merchant_prepare_bank_slip_request(uuid) is
  'Service-role only: lock an approved bank_slip_payment change and return its prepared pending request. pay_existing re-verifies pending/unpaid, same supplier and exact remaining amount; create_new inserts one bank-transfer request plus one line dated in the slip transfer month. Idempotent through payload.prepared_request_id. Never writes payments or payment_unc_evidence.';

-- ---------------------------------------------------------------------------
-- 3. Finalize: after UNC confirm paid the request, approve the category.
-- ---------------------------------------------------------------------------
create or replace function public.merchant_finalize_bank_slip_payment(
  p_change_id uuid,
  p_category_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_change public.merchant_staged_changes;
  v_payload jsonb;
  v_target jsonb;
  v_slip jsonb;
  v_ocr jsonb;
  v_request_id uuid;
  v_request_number text;
  v_request public.payment_requests;
  v_category text;
  v_line_count integer;
  v_item public.payment_request_items;
  v_class public.cost_line_classifications;
  v_before jsonb;
  v_after jsonb;
  v_product_line text;
  v_reference text;
  v_classification text := 'applied';
  v_note text;
begin
  if p_change_id is null then
    raise exception 'change_id_required' using errcode = '22023';
  end if;

  select *
    into v_change
  from public.merchant_staged_changes
  where id = p_change_id
  for update;

  if not found then
    raise exception 'change_not_found' using errcode = 'P0002';
  end if;
  if v_change.kind <> 'bank_slip_payment' then
    raise exception 'invalid_change_kind' using errcode = '22023';
  end if;

  v_payload := coalesce(v_change.payload, '{}'::jsonb);
  v_target := coalesce(v_payload -> 'target', '{}'::jsonb);
  v_slip := coalesce(v_payload -> 'slip', '{}'::jsonb);
  v_ocr := coalesce(v_slip -> 'ocr', '{}'::jsonb);
  v_request_id := coalesce(
    nullif(v_payload ->> 'prepared_request_id', '')::uuid,
    nullif(v_target ->> 'request_id', '')::uuid
  );

  if v_change.status = 'applied' then
    select pr.request_number
      into v_request_number
    from public.payment_requests pr
    where pr.id = v_request_id;
    return jsonb_build_object(
      'change_id', v_change.id,
      'status', 'applied',
      'classification', 'already_applied',
      'request_id', v_request_id,
      'request_number', v_request_number
    );
  end if;

  if v_request_id is null then
    raise exception 'prepared_request_required' using errcode = '22023';
  end if;

  select *
    into v_request
  from public.payment_requests pr
  where pr.id = v_request_id;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_request.payment_status::text <> 'paid' then
    raise exception 'request_not_paid' using errcode = 'P0001',
      detail = format('request_number=%s payment_status=%s', v_request.request_number, v_request.payment_status);
  end if;
  v_request_number := v_request.request_number;

  v_category := upper(nullif(btrim(coalesce(p_category_code, '')), ''));
  if v_category is null or not exists (
    select 1
    from public.cost_categories c
    where c.code = v_category and c.is_active
  ) then
    raise exception 'invalid_category' using errcode = '22023';
  end if;

  select count(*)
    into v_line_count
  from public.payment_request_items pri
  where pri.payment_request_id = v_request_id;

  if v_line_count > 1 then
    v_classification := 'skipped_multi_line';
  elsif v_line_count = 1 then
    select *
      into v_item
    from public.payment_request_items pri
    where pri.payment_request_id = v_request_id
    limit 1;

    select *
      into v_class
    from public.cost_line_classifications clc
    where clc.source_type = 'payment_request_item'
      and clc.source_line_id = v_item.id
    limit 1;

    if found then
      v_before := to_jsonb(v_class);
      v_product_line := v_class.product_line;
    else
      v_before := null;
      v_product_line := 'shared';
    end if;
    if v_product_line is null or v_product_line not in ('bmq_bread', 'sweet_kitchen', 'shared', 'general') then
      v_product_line := 'shared';
    end if;

    v_reference := nullif(btrim(coalesce(v_ocr ->> 'reference', v_slip ->> 'reference', '')), '');
    v_note := concat_ws(
      ' · ',
      'Bankslip ' || coalesce(v_reference, ''),
      'duyệt từ chatbox'
    );

    if found then
      update public.cost_line_classifications
      set category_code = v_category,
          payment_request_id = v_request_id,
          supplier_id = v_request.supplier_id,
          product_line = v_product_line,
          allocation_rule = coalesce(v_class.allocation_rule, 'none'),
          confidence = 1,
          classification_source = 'manual_override',
          review_status = 'approved',
          reviewed_by = v_change.decided_by,
          reviewed_at = now(),
          note = v_note,
          updated_at = now()
      where id = v_class.id
      returning * into v_class;
    else
      insert into public.cost_line_classifications (
        source_type,
        source_line_id,
        payment_request_id,
        supplier_id,
        category_code,
        product_line,
        allocation_rule,
        confidence,
        classification_source,
        review_status,
        reviewed_by,
        reviewed_at,
        note
      ) values (
        'payment_request_item',
        v_item.id,
        v_request_id,
        v_request.supplier_id,
        v_category,
        v_product_line,
        'none',
        1,
        'manual_override',
        'approved',
        v_change.decided_by,
        now(),
        v_note
      )
      returning * into v_class;
    end if;

    v_after := to_jsonb(v_class);
    insert into public.cost_classification_audit_logs (
      classification_id,
      source_type,
      source_line_id,
      action,
      before,
      after,
      reason,
      actor_id
    ) values (
      v_class.id,
      v_class.source_type,
      v_class.source_line_id,
      case when v_before is null then 'created_by_backfill' else 'manual_override' end,
      v_before,
      v_after,
      'bankslip ' || coalesce(v_reference, ''),
      v_change.decided_by
    );
  end if;

  update public.merchant_staged_changes
  set status = 'applied',
      applied_at = now(),
      error = null
  where id = p_change_id
  returning * into v_change;

  return jsonb_build_object(
    'change_id', v_change.id,
    'status', 'applied',
    'classification', v_classification,
    'request_id', v_request_id,
    'request_number', v_request_number
  );
end;
$$;

revoke all on function public.merchant_finalize_bank_slip_payment(uuid, text)
  from public, anon, authenticated;
grant execute on function public.merchant_finalize_bank_slip_payment(uuid, text)
  to service_role;

comment on function public.merchant_finalize_bank_slip_payment(uuid, text) is
  'Service-role only: lock a bank_slip_payment change whose prepared/target request is paid, validate an active cost category, upsert one approved manual_override classification plus its audit row for a single-line request (multi-line is skipped), then mark the change applied. Idempotent when already applied. Never writes payments or payment_unc_evidence.';
