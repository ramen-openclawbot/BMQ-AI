-- Giai đoạn 2 (backend) — UNC trả nhiều phiếu: gồm phiếu đã duyệt và trả một phần.
--
-- Additive only, and deliberately re-declares the SAME signature
-- public.approve_payment_requests_with_unc(uuid[], jsonb, text) so no overload is
-- created. When p_evidence carries no "allocations" array the function behaves
-- exactly as before (all requests pending, pay the remaining amount in full).
--
-- When p_evidence->'allocations' is a non-empty array, each item is
-- {payment_request_id, amount}:
--   * request status may be pending (approved in this call) or approved;
--   * payment_status must be unpaid or partial;
--   * every amount must be > 0 and <= that request's remaining amount;
--   * all requests must share one supplier;
--   * the allocations must cover exactly the p_request_ids set (no missing,
--     extra or duplicate request id);
--   * sum(amount) must equal the evidence amount exactly, unless a reasoned
--     manual override is supplied.
-- One payments row of the allocated total plus one payment_allocations row per
-- request is written. Existing guards (owner-only, idempotency key, advisory
-- lock, FOR UPDATE ordering, self-approval, OCR draft fields, file/reference
-- uniqueness, evidence insert, grants) are preserved. This migration never
-- redefines record_payment_allocations / approve_payment_request_with_material_controller
-- / finalize functions and schedules no cron job.

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
  v_alloc_input jsonb;
  v_has_alloc boolean := false;
  v_alloc_count integer := 0;
  v_alloc_distinct_count integer := 0;
  v_alloc_amount numeric;
  v_pr record;
  v_request_count integer := 0;
  v_remaining numeric;
  v_payment_total numeric := 0;
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

  -- Optional per-request allocation branch. Absent/empty => legacy full-remaining
  -- behaviour (all requests pending, one allocation per request equal to its
  -- remaining amount).
  if jsonb_typeof(v_evidence->'allocations') = 'array' then
    v_alloc_input := v_evidence->'allocations';
  else
    v_alloc_input := '[]'::jsonb;
  end if;
  v_has_alloc := jsonb_array_length(v_alloc_input) > 0;

  if v_has_alloc then
    if jsonb_array_length(v_alloc_input) > 50 then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'too_many_allocations';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where jsonb_typeof(item) <> 'object'
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'item_not_object';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where coalesce(item->>'payment_request_id', '')
              !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'payment_request_id_invalid';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where not (item ? 'amount')
         or jsonb_typeof(item->'amount') <> 'number'
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'amount_required';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where (item->>'amount')::numeric <= 0
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'amount_must_be_positive';
    end if;
    select count(*) into v_alloc_count from jsonb_array_elements(v_alloc_input) item;
    select count(distinct (item->>'payment_request_id'))
      into v_alloc_distinct_count
      from jsonb_array_elements(v_alloc_input) item;
    if v_alloc_count <> v_alloc_distinct_count then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'duplicate_payment_request_id';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where (item->>'payment_request_id')::uuid <> all(v_ids)
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'allocation_not_in_request_ids';
    end if;
    if v_alloc_distinct_count <> array_length(v_ids, 1) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'request_ids_mismatch';
    end if;
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
    if v_has_alloc then
      -- Allocations may settle already-approved requests (unpaid/partial) and
      -- may approve pending ones in the same call.
      if v_pr.status::text not in ('pending', 'approved') then
        raise exception 'not_pending' using errcode = 'P0001',
          detail = format('request_number=%s status=%s', v_pr.request_number, v_pr.status);
      end if;
      if v_pr.payment_status::text not in ('unpaid', 'partial') then
        raise exception 'not_pending' using errcode = 'P0001',
          detail = format('request_number=%s payment_status=%s', v_pr.request_number, v_pr.payment_status);
      end if;
    else
      if v_pr.status::text <> 'pending' then
        raise exception 'not_pending' using errcode = 'P0001',
          detail = format('request_number=%s status=%s', v_pr.request_number, v_pr.status);
      end if;
      if v_pr.payment_status::text <> 'unpaid' then
        raise exception 'not_pending' using errcode = 'P0001',
          detail = format('request_number=%s payment_status=%s', v_pr.request_number, v_pr.payment_status);
      end if;
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

    if v_has_alloc then
      select (item->>'amount')::numeric
        into v_alloc_amount
        from jsonb_array_elements(v_alloc_input) item
        where (item->>'payment_request_id')::uuid = v_pr.id;
      if v_alloc_amount is null or v_alloc_amount <= 0 then
        raise exception 'invalid_allocation' using errcode = '22023', detail = 'amount_must_be_positive';
      end if;
      if v_alloc_amount > v_remaining then
        raise exception 'allocation_exceeds_remaining' using errcode = 'P0001',
          detail = format('request_number=%s amount=%s remaining=%s', v_pr.request_number, v_alloc_amount, v_remaining);
      end if;
      v_payment_total := v_payment_total + v_alloc_amount;
      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
        'payment_request_id', v_pr.id,
        'amount', v_alloc_amount
      ));
    else
      v_payment_total := v_payment_total + v_remaining;
      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
        'payment_request_id', v_pr.id,
        'amount', v_remaining
      ));
    end if;
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
  elsif v_amount is null or v_amount <> v_payment_total then
    raise exception 'amount_mismatch' using errcode = 'P0001',
      detail = format('evidence_amount=%s allocated_total=%s', v_amount, v_payment_total);
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
  -- Requests already approved by an earlier partial payment are not re-approved.
  for v_pr in
    select * from public.payment_requests pr
    where pr.id = any(v_ids)
    order by pr.id
  loop
    if v_pr.status::text = 'pending' then
      perform public.approve_payment_request_with_material_controller(
        v_pr.id,
        'bank_transfer',
        v_actor
      );
    end if;
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
    v_payment_total,
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
    'amount', v_payment_total,
    'evidence_amount', v_amount,
    'manual_override', v_manual_override,
    'reference_number', v_reference,
    'supplier_id', v_supplier_id,
    'transfer_date', coalesce(v_transfer_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date),
    'allocations', v_allocations,
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

comment on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) is 'Owner-only atomic UNC approval: locks same-supplier requests (pending and/or already-approved unpaid/partial), enforces per-request allocations from p_evidence->allocations (each >0 and <= remaining, exact evidence amount unless a reasoned manual override), rejects reused file hash/reference, approves pending requests via approve_payment_request_with_material_controller, records one bank-transfer payment + allocations + evidence, and replays by idempotency_key. Without an allocations array it pays every pending request in full as before.';
