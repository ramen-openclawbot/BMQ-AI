-- Chi tiền mặt: một chứng từ (bank slip) trả cho nhiều khoản của cùng phiếu.
--
-- Additive, idempotent migration on top of 20261012100000_cash_settlement_flow.sql:
--   (A) adds public.payment_cash_receipt_splits (one row per receipt/item split),
--       with the same SELECT rule as payment_cash_receipts, no client writes and
--       explicit grants;
--   (B) replaces submit_cash_settlement so p_allocations may repeat a receipt_id,
--       the per-receipt sum (not each row) is bounded by coalesce(amount, ocr_amount),
--       item / receipt / completion comparisons use round() to whole đồng, and
--       single-allocation receipts keep the legacy receipt columns while 2+
--       allocations write split rows;
--   (C) replaces get_cash_settlement so item coverage = legacy receipt column +
--       splits, and every receipt also exposes a 'splits' array.
--
-- discard_cash_receipt is intentionally NOT redefined: it only accepts
-- status='uploaded', so allocated receipts (legacy or split) keep being refused.
-- Permissions, idempotency, and the payment_cash_settled Zalo outbox are kept.

-- ===========================================================================
-- 1. Bảng phân bổ một chứng từ cho nhiều khoản
-- ===========================================================================

create table if not exists public.payment_cash_receipt_splits (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.payment_cash_receipts(id) on delete cascade,
  payment_request_item_id uuid not null references public.payment_request_items(id) on delete cascade,
  amount numeric not null check (amount > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (receipt_id, payment_request_item_id)
);

create index if not exists idx_payment_cash_receipt_splits_item
  on public.payment_cash_receipt_splits (payment_request_item_id);

alter table public.payment_cash_receipt_splits enable row level security;
revoke all on public.payment_cash_receipt_splits from public, anon, authenticated;
grant select on public.payment_cash_receipt_splits to authenticated;
grant all on public.payment_cash_receipt_splits to service_role;

drop policy if exists payment_cash_receipt_splits_select on public.payment_cash_receipt_splits;
create policy payment_cash_receipt_splits_select
  on public.payment_cash_receipt_splits
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner')
    or public.has_module_permission(auth.uid(), 'payment_requests', 'view')
  );

comment on table public.payment_cash_receipt_splits is
  'One receipt allocated across several items of the same cash phiếu. Only submit_cash_settlement writes it (SECURITY DEFINER); authenticated can read.';

-- ===========================================================================
-- 2. submit_cash_settlement: repeated receipt_id, per-receipt sum, splits
-- ===========================================================================

create or replace function public.submit_cash_settlement(
  p_request_id uuid,
  p_allocations jsonb,
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
  v_allocs jsonb := coalesce(p_allocations, '[]'::jsonb);
  v_prior jsonb;
  v_pr public.payment_requests%rowtype;
  v_alloc record;
  v_item record;
  v_alloc_count integer := 0;
  v_item_amount numeric;
  v_item_allocated numeric;
  v_receipt_amount numeric;
  v_covered_total numeric := 0;
  v_expected_total numeric := 0;
  v_remaining_total numeric := 0;
  v_all_complete boolean := true;
  v_items jsonb := '[]'::jsonb;
  v_status text;
  v_result jsonb;
begin
  if not v_is_service then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  if not (v_is_service or public.can_edit_payment_request(p_request_id)) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;

  -- Idempotent replay (checked before and after the advisory lock).
  select result into v_prior
  from public.payment_cash_settlement_idempotency
  where idempotency_key = v_key;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  perform pg_advisory_xact_lock(hashtext('payment_cash_settlement:' || v_key));

  select result into v_prior
  from public.payment_cash_settlement_idempotency
  where idempotency_key = v_key;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  select * into v_pr
  from public.payment_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_pr.cash_settlement_status is distinct from 'awaiting_receipts' then
    raise exception 'not_awaiting_receipts' using errcode = 'P0001',
      detail = format(
        'request_number=%s cash_settlement_status=%s',
        v_pr.request_number,
        coalesce(v_pr.cash_settlement_status, 'null')
      );
  end if;

  -- --- Validate the allocation shape -------------------------------------
  if jsonb_typeof(v_allocs) <> 'array' then
    raise exception 'invalid_allocation' using errcode = '22023', detail = 'not_array';
  end if;
  v_alloc_count := jsonb_array_length(v_allocs);
  if v_alloc_count = 0 then
    raise exception 'allocation_required' using errcode = '22023';
  end if;
  if v_alloc_count > 100 then
    raise exception 'invalid_allocation' using errcode = '22023', detail = 'too_many_allocations';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_allocs) a
    where jsonb_typeof(a) <> 'object'
       or coalesce(a->>'receipt_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(a->>'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not (a ? 'amount')
       or jsonb_typeof(a->'amount') <> 'number'
  ) then
    raise exception 'invalid_allocation' using errcode = '22023', detail = 'invalid_item';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_allocs) a
    where (a->>'amount')::numeric <= 0
  ) then
    raise exception 'invalid_allocation' using errcode = '22023', detail = 'amount_must_be_positive';
  end if;

  -- A receipt may repeat for different items of the same phiếu, but the same
  -- (receipt_id, item_id) pair twice in one call is still invalid.
  if exists (
    select 1
    from (
      select (a->>'receipt_id')::uuid as receipt_id,
             (a->>'item_id')::uuid as item_id
      from jsonb_array_elements(v_allocs) a
      group by 1, 2
      having count(*) > 1
    ) duplicate_pairs
  ) then
    raise exception 'invalid_allocation' using errcode = '22023', detail = 'duplicate_receipt_item';
  end if;

  -- --- Every receipt belongs to this PR and is still uploaded ------------
  if exists (
    select 1
    from jsonb_array_elements(v_allocs) a
    where not exists (
      select 1
      from public.payment_cash_receipts r
      where r.id = (a->>'receipt_id')::uuid
        and r.payment_request_id = p_request_id
        and r.status = 'uploaded'
    )
  ) then
    raise exception 'receipt_not_uploaded' using errcode = 'P0001';
  end if;

  -- --- Every item belongs to this PR --------------------------------------
  if exists (
    select 1
    from jsonb_array_elements(v_allocs) a
    where not exists (
      select 1
      from public.payment_request_items i
      where i.id = (a->>'item_id')::uuid
        and i.payment_request_id = p_request_id
    )
  ) then
    raise exception 'item_not_found' using errcode = 'P0001';
  end if;

  -- --- Per-item sum (existing + new) must not exceed the item amount -------
  -- Existing coverage = legacy receipt column + split rows for this item.
  -- Whole-đồng rule: compare after round() like the rest of finance.
  for v_alloc in
    select (a->>'item_id')::uuid as item_id, sum((a->>'amount')::numeric) as amount
    from jsonb_array_elements(v_allocs) a
    group by 1
  loop
    select coalesce(i.line_total, i.quantity * i.unit_price, 0)
      into v_item_amount
    from public.payment_request_items i
    where i.id = v_alloc.item_id;

    select coalesce(sum(covered_rows.amount), 0)
      into v_item_allocated
    from (
      select r.amount
      from public.payment_cash_receipts r
      where r.payment_request_item_id = v_alloc.item_id
        and r.status = 'allocated'
      union all
      select s.amount
      from public.payment_cash_receipt_splits s
      join public.payment_cash_receipts r on r.id = s.receipt_id
      where s.payment_request_item_id = v_alloc.item_id
        and r.status = 'allocated'
    ) covered_rows;

    if round(v_item_allocated + v_alloc.amount) > round(v_item_amount) then
      raise exception 'item_over_allocated' using errcode = 'P0001',
        detail = format(
          'item_id=%s allocated=%s new=%s amount=%s',
          v_alloc.item_id, v_item_allocated, v_alloc.amount, v_item_amount
        );
    end if;
  end loop;

  -- --- Per-receipt sum must not exceed the receipt amount -----------------
  -- One receipt may pay several items, so check the grouped sum once.
  for v_alloc in
    select (a->>'receipt_id')::uuid as receipt_id,
           sum((a->>'amount')::numeric) as amount
    from jsonb_array_elements(v_allocs) a
    group by 1
  loop
    select coalesce(r.amount, r.ocr_amount)
      into v_receipt_amount
    from public.payment_cash_receipts r
    where r.id = v_alloc.receipt_id;

    if v_receipt_amount is not null
       and round(v_alloc.amount) > round(v_receipt_amount) then
      raise exception 'receipt_over_allocated' using errcode = 'P0001',
        detail = format(
          'receipt_id=%s new=%s amount=%s',
          v_alloc.receipt_id, v_alloc.amount, v_receipt_amount
        );
    end if;
  end loop;

  -- --- Apply the allocations ---------------------------------------------
  -- One allocation keeps today's behaviour (item + amount on the receipt row).
  -- Two or more allocations for the same receipt become split rows; the receipt
  -- keeps its item column null and amount = sum of its allocations.
  for v_alloc in
    select (a->>'receipt_id')::uuid as receipt_id,
           sum((a->>'amount')::numeric) as amount,
           count(*) as alloc_count
    from jsonb_array_elements(v_allocs) a
    group by 1
  loop
    if v_alloc.alloc_count = 1 then
      update public.payment_cash_receipts
      set payment_request_item_id = (
            select (a->>'item_id')::uuid
            from jsonb_array_elements(v_allocs) a
            where (a->>'receipt_id')::uuid = v_alloc.receipt_id
            limit 1
          ),
          amount = v_alloc.amount,
          status = 'allocated',
          allocated_at = now()
      where id = v_alloc.receipt_id;
    else
      insert into public.payment_cash_receipt_splits (
        receipt_id, payment_request_item_id, amount, created_by
      )
      select (a->>'receipt_id')::uuid,
             (a->>'item_id')::uuid,
             (a->>'amount')::numeric,
             v_actor
      from jsonb_array_elements(v_allocs) a
      where (a->>'receipt_id')::uuid = v_alloc.receipt_id;

      update public.payment_cash_receipts
      set payment_request_item_id = null,
          amount = v_alloc.amount,
          status = 'allocated',
          allocated_at = now()
      where id = v_alloc.receipt_id;
    end if;
  end loop;

  -- --- Coverage per item: legacy receipt column + splits -------------------
  for v_item in
    select *
    from public.payment_request_items i
    where i.payment_request_id = p_request_id
    order by i.created_at, i.id
  loop
    v_item_amount := coalesce(v_item.line_total, v_item.quantity * v_item.unit_price, 0);

    select coalesce(sum(covered_rows.amount), 0)
      into v_item_allocated
    from (
      select r.amount
      from public.payment_cash_receipts r
      where r.payment_request_item_id = v_item.id
        and r.status = 'allocated'
      union all
      select s.amount
      from public.payment_cash_receipt_splits s
      join public.payment_cash_receipts r on r.id = s.receipt_id
      where s.payment_request_item_id = v_item.id
        and r.status = 'allocated'
    ) covered_rows;

    v_covered_total := v_covered_total + v_item_allocated;
    v_expected_total := v_expected_total + v_item_amount;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
      'amount', v_item_amount,
      'covered', v_item_allocated
    ));

    if round(v_item_allocated) < round(v_item_amount) then
      v_all_complete := false;
    end if;
  end loop;

  v_remaining_total := greatest(v_expected_total - v_covered_total, 0);

  if v_all_complete then
    v_status := 'completed';
    update public.payment_requests
    set cash_settlement_status = 'completed',
        cash_settled_at = now(),
        cash_settled_by = v_actor
    where id = p_request_id;

    insert into public.finance_zalo_notifications (
      event_type, entity_id, group_key, message_body, status
    ) values (
      'payment_cash_settled',
      p_request_id,
      'finance',
      coalesce(
        public.build_finance_zalo_cash_message(p_request_id, 'payment_cash_settled'),
        'Hoàn tất chi tiền mặt: ' || v_pr.request_number
      ),
      'pending'
    )
    on conflict (event_type, entity_id) do nothing;
  else
    v_status := 'awaiting_receipts';
  end if;

  v_result := jsonb_build_object(
    'status', v_status,
    'covered_total', v_covered_total,
    'remaining_total', v_remaining_total,
    'items', v_items,
    'idempotent', false
  );

  insert into public.payment_cash_settlement_idempotency (
    idempotency_key, payment_request_id, result, created_by
  ) values (
    v_key, p_request_id, v_result, v_actor
  )
  on conflict (idempotency_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.submit_cash_settlement(uuid, jsonb, text) from public, anon;
grant execute on function public.submit_cash_settlement(uuid, jsonb, text) to authenticated, service_role;

comment on function public.submit_cash_settlement(uuid, jsonb, text) is
  'Owner / payment_requests edit / PR creator: allocate uploaded cash receipts to PR items (each amount > 0; one receipt may be split across several items; per-item and per-receipt sums bounded after round() to whole đồng), mark allocated, set completed + cash_settled_at/by and enqueue payment_cash_settled when every item is fully covered. Idempotent by key.';

-- ===========================================================================
-- 3. get_cash_settlement: coverage = legacy + splits, per-receipt splits array
-- ===========================================================================

create or replace function public.get_cash_settlement(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_pr public.payment_requests%rowtype;
  v_supplier text;
  v_requester text;
  v_items jsonb := '[]'::jsonb;
  v_receipts jsonb := '[]'::jsonb;
  v_attachments jsonb := '[]'::jsonb;
  v_evidence jsonb := '[]'::jsonb;
begin
  -- Same access as the payment_requests view policy.
  if not (
    (
      v_uid is not null
      and (
        public.has_role(v_uid, 'owner')
        or public.has_module_permission(v_uid, 'payment_requests', 'view')
      )
    )
    or public.material_master_jwt_role() = 'service_role'
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_pr from public.payment_requests where id = p_request_id;
  if not found then
    return null;
  end if;

  select s.name into v_supplier from public.suppliers s where s.id = v_pr.supplier_id;
  select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''))
    into v_requester
  from public.profiles p
  where p.user_id = v_pr.created_by;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'product_name', i.product_name,
    'amount', coalesce(i.line_total, i.quantity * i.unit_price, 0),
    'covered', coalesce((
      select sum(covered_rows.amount)
      from (
        select r.amount
        from public.payment_cash_receipts r
        where r.payment_request_item_id = i.id
          and r.status = 'allocated'
        union all
        select s.amount
        from public.payment_cash_receipt_splits s
        join public.payment_cash_receipts r on r.id = s.receipt_id
        where s.payment_request_item_id = i.id
          and r.status = 'allocated'
      ) covered_rows
    ), 0)
  ) order by i.created_at, i.id), '[]'::jsonb)
  into v_items
  from public.payment_request_items i
  where i.payment_request_id = p_request_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'payment_request_item_id', r.payment_request_item_id,
    'storage_path', r.storage_path,
    'file_sha256', r.file_sha256,
    'ocr_amount', r.ocr_amount,
    'ocr_payee', r.ocr_payee,
    'ocr_date', r.ocr_date,
    'ocr_reference', r.ocr_reference,
    'ocr_content', r.ocr_content,
    'ocr_error', r.ocr_error,
    'amount', r.amount,
    'status', r.status,
    'uploaded_by', r.uploaded_by,
    'created_at', r.created_at,
    'allocated_at', r.allocated_at,
    'splits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', s.payment_request_item_id,
        'amount', s.amount
      ) order by s.created_at, s.id)
      from public.payment_cash_receipt_splits s
      where s.receipt_id = r.id
    ), '[]'::jsonb)
  ) order by r.created_at), '[]'::jsonb)
  into v_receipts
  from public.payment_cash_receipts r
  where r.payment_request_id = p_request_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'storage_path', a.storage_path,
    'file_name', a.file_name,
    'mime_type', a.mime_type,
    'uploaded_by', a.uploaded_by,
    'created_at', a.created_at
  ) order by a.created_at), '[]'::jsonb)
  into v_attachments
  from public.payment_request_attachments a
  where a.payment_request_id = p_request_id;

  -- Reuse the canonical UNC / cash evidence read for the CEO voucher rows.
  v_evidence := public.get_payment_request_unc_evidence(p_request_id);

  return jsonb_build_object(
    'payment_request', jsonb_build_object(
      'id', v_pr.id,
      'request_number', v_pr.request_number,
      'title', v_pr.title,
      'description', v_pr.description,
      'status', v_pr.status,
      'payment_status', v_pr.payment_status,
      'payment_method', v_pr.payment_method,
      'total_amount', v_pr.total_amount,
      'supplier_id', v_pr.supplier_id,
      'supplier_name', v_supplier,
      'created_by', v_pr.created_by,
      'requester_name', v_requester,
      'cash_settlement_status', v_pr.cash_settlement_status,
      'cash_settled_at', v_pr.cash_settled_at,
      'cash_settled_by', v_pr.cash_settled_by
    ),
    'items', coalesce(v_items, '[]'::jsonb),
    'receipts', coalesce(v_receipts, '[]'::jsonb),
    'evidence', coalesce(v_evidence, '[]'::jsonb),
    'attachments', coalesce(v_attachments, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_cash_settlement(uuid) from public, anon;
grant execute on function public.get_cash_settlement(uuid) to authenticated, service_role;

comment on function public.get_cash_settlement(uuid) is
  'Owner / payment_requests view: cash PR header, items with covered amounts (legacy receipts + splits), receipts with storage_path and their splits, the CEO evidence rows (get_payment_request_unc_evidence) and attachments.';
