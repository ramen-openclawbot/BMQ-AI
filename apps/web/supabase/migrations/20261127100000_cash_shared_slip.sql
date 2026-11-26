-- Chi tiền mặt: một chứng từ (bank slip) trả chung cho nhiều phiếu tạm ứng
-- tiền mặt đang awaiting_receipts của cùng người đề nghị.
--
-- Additive, idempotent migration on top of
-- 20261012100000_cash_settlement_flow.sql and 20261102100000_cash_receipt_splits.sql:
--   (A) list_cash_shared_slip_candidates: read model of the other cash phiếu of
--       the same requester that the caller may edit, with per-item coverage;
--   (B) submit_cash_shared_slip: allocate ONE uploaded receipt across items of
--       several phiếu (one split row per allocation, even for a single
--       allocation), mark each fully-covered phiếu completed and enqueue
--       payment_cash_settled exactly once per phiếu;
--   (C) replaces get_cash_settlement so a phiếu also sees receipts of OTHER
--       phiếu that were split into its items, annotated with the source phiếu;
--   (C2) scopes submit_cash_settlement replay to its own phiếu and rejects
--       cash-shared: keys (single-phiếu behaviour otherwise unchanged).
--
-- Known limit: deleting the phiếu that owns a shared receipt cascades the
-- receipt and its splits, so the other phiếu lose that evidence. No delete
-- guard here: a guard would also block purchase-order line edits.
--
-- discard_cash_receipt and the single-phiếu UI flow are untouched.

-- ===========================================================================
-- A. list_cash_shared_slip_candidates
-- ===========================================================================

create or replace function public.list_cash_shared_slip_candidates(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_current public.payment_requests%rowtype;
  v_result jsonb := '[]'::jsonb;
begin
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  if v_actor is null and not v_is_service then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if not (v_is_service or public.can_edit_payment_request(p_request_id)) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_current
  from public.payment_requests
  where id = p_request_id;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;

  -- A slip of a bank_transfer / already-settled phiếu cannot be shared; return
  -- no candidates at all so the caller disables the flow.
  if v_current.payment_method is distinct from 'cash'::public.payment_method_type
     or v_current.cash_settlement_status is distinct from 'awaiting_receipts' then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'request_number', c.request_number,
    'title', c.title,
    'supplier_name', (
      select s.name from public.suppliers s where s.id = c.supplier_id
    ),
    'total_amount', c.total_amount,
    'is_current', c.is_current,
    'remaining_total', coalesce((
      select sum(greatest(
        (entry->>'amount')::numeric - (entry->>'covered')::numeric,
        0
      ))
      from jsonb_array_elements(c.items) entry
    ), 0),
    'items', c.items
  ) order by c.created_at, c.id), '[]'::jsonb)
  into v_result
  from (
    select pr.id,
           pr.request_number,
           pr.title,
           pr.supplier_id,
           pr.total_amount,
           pr.created_at,
           (pr.id = p_request_id) as is_current,
           (
             select coalesce(jsonb_agg(jsonb_build_object(
               'id', x.id,
               'product_name', x.product_name,
               'amount', x.amount,
               'covered', x.covered,
               'remaining', greatest(x.amount - x.covered, 0)
             ) order by x.created_at, x.id), '[]'::jsonb)
             from (
               select i.id,
                      i.product_name,
                      i.created_at,
                      round(coalesce(i.line_total, i.quantity * i.unit_price, 0)) as amount,
                      round(coalesce((
                        select sum(cov.amount)
                        from (
                          select r.amount
                          from public.payment_cash_receipts r
                          where r.payment_request_item_id = i.id
                            and r.status = 'allocated'
                          union all
                          select s.amount
                          from public.payment_cash_receipt_splits s
                          join public.payment_cash_receipts sr on sr.id = s.receipt_id
                          where s.payment_request_item_id = i.id
                            and sr.status = 'allocated'
                        ) cov
                      ), 0)) as covered
               from public.payment_request_items i
               where i.payment_request_id = pr.id
             ) x
           ) as items
    from public.payment_requests pr
    where pr.id = p_request_id
      and pr.payment_method = 'cash'
      and pr.cash_settlement_status = 'awaiting_receipts'
    union all
    (
      select pr.id,
             pr.request_number,
             pr.title,
             pr.supplier_id,
             pr.total_amount,
             pr.created_at,
             false as is_current,
             (
               select coalesce(jsonb_agg(jsonb_build_object(
                 'id', x.id,
                 'product_name', x.product_name,
                 'amount', x.amount,
                 'covered', x.covered,
                 'remaining', greatest(x.amount - x.covered, 0)
               ) order by x.created_at, x.id), '[]'::jsonb)
               from (
                 select i.id,
                        i.product_name,
                        i.created_at,
                        round(coalesce(i.line_total, i.quantity * i.unit_price, 0)) as amount,
                        round(coalesce((
                          select sum(cov.amount)
                          from (
                            select r.amount
                            from public.payment_cash_receipts r
                            where r.payment_request_item_id = i.id
                              and r.status = 'allocated'
                            union all
                            select s.amount
                            from public.payment_cash_receipt_splits s
                            join public.payment_cash_receipts sr on sr.id = s.receipt_id
                            where s.payment_request_item_id = i.id
                              and sr.status = 'allocated'
                          ) cov
                        ), 0)) as covered
                 from public.payment_request_items i
                 where i.payment_request_id = pr.id
               ) x
             ) as items
      from public.payment_requests pr
      where pr.id <> p_request_id
        and v_current.created_by is not null
        and pr.created_by = v_current.created_by
        and pr.payment_method = 'cash'
        and pr.cash_settlement_status = 'awaiting_receipts'
        and public.can_edit_payment_request(pr.id)
      order by pr.created_at, pr.id
      limit 29
    )
  ) c;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.list_cash_shared_slip_candidates(uuid) from public, anon;
grant execute on function public.list_cash_shared_slip_candidates(uuid) to authenticated, service_role;

comment on function public.list_cash_shared_slip_candidates(uuid) is
  'Owner / payment_requests edit / PR creator: cash phiếu of the same requester awaiting receipts (current phiếu always tagged is_current), with per-item amount/covered/remaining and remaining_total, ordered by created_at (max 30).';

-- ===========================================================================
-- B. submit_cash_shared_slip
-- ===========================================================================

create or replace function public.submit_cash_shared_slip(
  p_receipt_id uuid,
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
  v_key_prefix text;
  v_allocs jsonb := coalesce(p_allocations, '[]'::jsonb);
  v_prior jsonb;
  v_prior_request_id uuid;
  v_receipt public.payment_cash_receipts%rowtype;
  v_source_pr public.payment_requests%rowtype;
  v_pr public.payment_requests%rowtype;
  v_alloc record;
  v_item record;
  v_alloc_count integer := 0;
  v_distinct_requests integer := 0;
  v_request_ids uuid[];
  v_receipt_amount numeric;
  v_alloc_total numeric := 0;
  v_item_amount numeric;
  v_item_allocated numeric;
  v_covered_total numeric;
  v_expected_total numeric;
  v_remaining_total numeric;
  v_all_complete boolean;
  v_requests jsonb := '[]'::jsonb;
  v_request_status text;
  v_result jsonb;
begin
  if not v_is_service then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_receipt_id is null then
    raise exception 'receipt_required' using errcode = '22023';
  end if;
  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  -- A shared key is always scoped to the receipt and stays far below the
  -- payment_cash_settlement_idempotency btree row limit.
  if octet_length(v_key) > 512 then
    raise exception 'invalid_idempotency_key' using errcode = '22023', detail = 'too_long';
  end if;
  v_key_prefix := 'cash-shared:' || p_receipt_id::text || ':';
  if left(v_key, length(v_key_prefix)) <> v_key_prefix then
    raise exception 'invalid_idempotency_key' using errcode = '22023', detail = 'expected_cash_shared_prefix';
  end if;

  -- Authorize BEFORE replaying a stored result: the ledger is shared with
  -- submit_cash_settlement and must never leak another phiếu's result.
  select * into v_receipt
  from public.payment_cash_receipts
  where id = p_receipt_id;
  if not found then
    raise exception 'receipt_not_found' using errcode = 'P0002';
  end if;
  if not (v_is_service or public.can_edit_payment_request(v_receipt.payment_request_id)) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Idempotent replay (checked before and after the advisory lock).
  select result, payment_request_id into v_prior, v_prior_request_id
  from public.payment_cash_settlement_idempotency
  where idempotency_key = v_key;
  if found then
    if v_prior_request_id is distinct from v_receipt.payment_request_id then
      raise exception 'invalid_idempotency_key' using errcode = '22023', detail = 'idempotency_key_request_mismatch';
    end if;
    -- The ledger is shared with submit_cash_settlement; only a shared result
    -- may be replayed here.
    if v_prior->>'status' is distinct from 'ok'
       or jsonb_typeof(v_prior->'requests') is distinct from 'array' then
      raise exception 'invalid_idempotency_key' using errcode = '22023', detail = 'idempotency_key_foreign_result';
    end if;
    -- A ledger row only replays while its allocation is still on the receipt.
    -- A manual reversal leaves the row behind, but the resubmit must write.
    if v_receipt.status = 'allocated' then
      return v_prior || jsonb_build_object('idempotent', true);
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('payment_cash_shared_slip:' || p_receipt_id::text));

  -- Refresh the receipt after the advisory lock so a concurrent allocation or
  -- reversal is visible before deciding whether the ledger row is replayable.
  select * into v_receipt
  from public.payment_cash_receipts
  where id = p_receipt_id;
  if not found then
    raise exception 'receipt_not_found' using errcode = 'P0002';
  end if;
  if not (v_is_service or public.can_edit_payment_request(v_receipt.payment_request_id)) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select result, payment_request_id into v_prior, v_prior_request_id
  from public.payment_cash_settlement_idempotency
  where idempotency_key = v_key;
  if found then
    if v_prior_request_id is distinct from v_receipt.payment_request_id then
      raise exception 'invalid_idempotency_key' using errcode = '22023', detail = 'idempotency_key_request_mismatch';
    end if;
    -- The ledger is shared with submit_cash_settlement; only a shared result
    -- may be replayed here.
    if v_prior->>'status' is distinct from 'ok'
       or jsonb_typeof(v_prior->'requests') is distinct from 'array' then
      raise exception 'invalid_idempotency_key' using errcode = '22023', detail = 'idempotency_key_foreign_result';
    end if;
    if v_receipt.status = 'allocated' then
      return v_prior || jsonb_build_object('idempotent', true);
    end if;
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
       or coalesce(a->>'request_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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

  select count(*), count(distinct (a->>'request_id'))
    into v_alloc_count, v_distinct_requests
  from jsonb_array_elements(v_allocs) a;
  if v_distinct_requests > 10 then
    raise exception 'invalid_allocation' using errcode = '22023', detail = 'too_many_requests';
  end if;

  if exists (
    select 1
    from (
      select (a->>'request_id')::uuid as request_id,
             (a->>'item_id')::uuid as item_id
      from jsonb_array_elements(v_allocs) a
      group by 1, 2
      having count(*) > 1
    ) duplicate_pairs
  ) then
    raise exception 'invalid_allocation' using errcode = '22023', detail = 'duplicate_request_item';
  end if;

  select array_agg(distinct (a->>'request_id')::uuid)
    into v_request_ids
  from jsonb_array_elements(v_allocs) a;

  -- Lock every phiếu FIRST (id order), then the receipt. submit_cash_settlement
  -- locks its phiếu before updating the receipt, so this order avoids a
  -- cross-flow deadlock.
  perform 1
  from public.payment_requests
  where id = any(v_request_ids)
  order by id
  for update;

  select * into v_receipt
  from public.payment_cash_receipts
  where id = p_receipt_id
  for update;
  if not found then
    raise exception 'receipt_not_found' using errcode = 'P0002';
  end if;
  if v_receipt.status <> 'uploaded' then
    raise exception 'receipt_not_uploaded' using errcode = 'P0001',
      detail = format('status=%s', v_receipt.status);
  end if;

  -- --- The receipt's own phiếu must be one of the allocations -------------
  if not exists (
    select 1
    from jsonb_array_elements(v_allocs) a
    where (a->>'request_id')::uuid = v_receipt.payment_request_id
  ) then
    raise exception 'invalid_allocation' using errcode = '22023', detail = 'receipt_request_missing';
  end if;

  select * into v_source_pr
  from public.payment_requests
  where id = v_receipt.payment_request_id;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;

  -- A missing creator cannot establish "same requester"; never let two
  -- system-created phiếu share one slip.
  if v_source_pr.created_by is null and cardinality(v_request_ids) > 1 then
    raise exception 'requester_mismatch' using errcode = 'P0001', detail = 'requester_unknown';
  end if;

  -- --- Permission on every phiếu first, so later errors never reveal data
  -- of a phiếu the caller may not edit.
  if not v_is_service and exists (
    select 1 from unnest(v_request_ids) as r(id)
    where not public.can_edit_payment_request(r.id)
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- --- Every phiếu: cash, awaiting receipts, same requester, editable ------
  for v_pr in
    select *
    from public.payment_requests
    where id = any(v_request_ids)
    order by id
  loop
    if v_pr.payment_method is distinct from 'cash'::public.payment_method_type
       or v_pr.cash_settlement_status is distinct from 'awaiting_receipts' then
      raise exception 'not_awaiting_receipts' using errcode = 'P0001',
        detail = format(
          'request_number=%s payment_method=%s cash_settlement_status=%s',
          v_pr.request_number,
          coalesce(v_pr.payment_method::text, 'null'),
          coalesce(v_pr.cash_settlement_status, 'null')
        );
    end if;
    if v_pr.created_by is distinct from v_source_pr.created_by then
      raise exception 'requester_mismatch' using errcode = 'P0001',
        detail = format(
          'request_number=%s created_by=%s receipt_request_created_by=%s',
          v_pr.request_number,
          coalesce(v_pr.created_by::text, 'null'),
          coalesce(v_source_pr.created_by::text, 'null')
        );
    end if;
    if not (v_is_service or public.can_edit_payment_request(v_pr.id)) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end loop;

  -- --- Every item belongs to the request_id it is allocated to ------------
  if exists (
    select 1
    from jsonb_array_elements(v_allocs) a
    where not exists (
      select 1
      from public.payment_request_items i
      where i.id = (a->>'item_id')::uuid
        and i.payment_request_id = (a->>'request_id')::uuid
    )
  ) then
    raise exception 'item_not_found' using errcode = 'P0001';
  end if;

  -- --- Each allocation must fit the item's remaining (whole đồng) ---------
  for v_alloc in
    select (a->>'request_id')::uuid as request_id,
           (a->>'item_id')::uuid as item_id,
           (a->>'amount')::numeric as amount
    from jsonb_array_elements(v_allocs) a
  loop
    select round(coalesce(i.line_total, i.quantity * i.unit_price, 0))
      into v_item_amount
    from public.payment_request_items i
    where i.id = v_alloc.item_id;

    select round(coalesce(sum(cov.amount), 0))
      into v_item_allocated
    from (
      select r.amount
      from public.payment_cash_receipts r
      where r.payment_request_item_id = v_alloc.item_id
        and r.status = 'allocated'
      union all
      select s.amount
      from public.payment_cash_receipt_splits s
      join public.payment_cash_receipts sr on sr.id = s.receipt_id
      where s.payment_request_item_id = v_alloc.item_id
        and sr.status = 'allocated'
    ) cov;

    if round(v_item_allocated + v_alloc.amount) > round(v_item_amount) then
      raise exception 'item_over_allocated' using errcode = 'P0001',
        detail = format(
          'item_id=%s allocated=%s new=%s amount=%s',
          v_alloc.item_id, v_item_allocated, v_alloc.amount, v_item_amount
        );
    end if;
  end loop;

  -- --- The whole slip must be allocated exactly ---------------------------
  select sum((a->>'amount')::numeric)
    into v_alloc_total
  from jsonb_array_elements(v_allocs) a;

  v_receipt_amount := coalesce(v_receipt.amount, v_receipt.ocr_amount);
  if v_receipt_amount is null then
    raise exception 'receipt_amount_missing' using errcode = 'P0001',
      detail = format('receipt_id=%s', p_receipt_id);
  end if;
  if round(v_alloc_total) <> round(v_receipt_amount) then
    raise exception 'shared_total_mismatch' using errcode = 'P0001',
      detail = format(
        'receipt_id=%s allocated=%s receipt_amount=%s',
        p_receipt_id, v_alloc_total, v_receipt_amount
      );
  end if;

  -- --- Apply: one split row per allocation, even for a single one ---------
  insert into public.payment_cash_receipt_splits (
    receipt_id, payment_request_item_id, amount, created_by
  )
  select p_receipt_id,
         (a->>'item_id')::uuid,
         (a->>'amount')::numeric,
         v_actor
  from jsonb_array_elements(v_allocs) a;

  update public.payment_cash_receipts
  set payment_request_item_id = null,
      amount = v_receipt_amount,
      status = 'allocated',
      allocated_at = now()
  where id = p_receipt_id;

  -- --- Per-phiếu coverage, completion and Zalo outbox ---------------------
  -- Iterate an id snapshot (not a cursor over payment_requests) because this
  -- loop updates the same table.
  for v_alloc in
    select snapshot.id
    from unnest(v_request_ids) as snapshot(id)
    order by snapshot.id
  loop
    select * into v_pr
    from public.payment_requests
    where id = v_alloc.id;

    v_covered_total := 0;
    v_expected_total := 0;
    v_all_complete := true;

    for v_item in
      select *
      from public.payment_request_items i
      where i.payment_request_id = v_pr.id
      order by i.created_at, i.id
    loop
      v_item_amount := coalesce(v_item.line_total, v_item.quantity * v_item.unit_price, 0);

      select coalesce(sum(cov.amount), 0)
        into v_item_allocated
      from (
        select r.amount
        from public.payment_cash_receipts r
        where r.payment_request_item_id = v_item.id
          and r.status = 'allocated'
        union all
        select s.amount
        from public.payment_cash_receipt_splits s
        join public.payment_cash_receipts sr on sr.id = s.receipt_id
        where s.payment_request_item_id = v_item.id
          and sr.status = 'allocated'
      ) cov;

      v_covered_total := v_covered_total + v_item_allocated;
      v_expected_total := v_expected_total + v_item_amount;

      if round(v_item_allocated) < round(v_item_amount) then
        v_all_complete := false;
      end if;
    end loop;

    v_remaining_total := greatest(v_expected_total - v_covered_total, 0);

    if v_all_complete then
      v_request_status := 'completed';
      update public.payment_requests
      set cash_settlement_status = 'completed',
          cash_settled_at = now(),
          cash_settled_by = v_actor
      where id = v_pr.id;

      insert into public.finance_zalo_notifications (
        event_type, entity_id, group_key, message_body, status
      ) values (
        'payment_cash_settled',
        v_pr.id,
        'finance',
        coalesce(
          public.build_finance_zalo_cash_message(v_pr.id, 'payment_cash_settled'),
          'Hoàn tất chi tiền mặt: ' || v_pr.request_number
        ),
        'pending'
      )
      on conflict (event_type, entity_id) do nothing;
    else
      v_request_status := 'awaiting_receipts';
    end if;

    v_requests := v_requests || jsonb_build_array(jsonb_build_object(
      'request_id', v_pr.id,
      'request_number', v_pr.request_number,
      'status', v_request_status,
      'covered_total', v_covered_total,
      'remaining_total', v_remaining_total
    ));
  end loop;

  v_result := jsonb_build_object(
    'status', 'ok',
    'requests', v_requests,
    'idempotent', false
  );

  insert into public.payment_cash_settlement_idempotency (
    idempotency_key, payment_request_id, result, created_by
  ) values (
    v_key, v_receipt.payment_request_id, v_result, v_actor
  )
  on conflict (idempotency_key) do update
    set result = excluded.result,
        payment_request_id = excluded.payment_request_id,
        created_by = excluded.created_by,
        created_at = now();

  return v_result;
end;
$$;

revoke all on function public.submit_cash_shared_slip(uuid, jsonb, text) from public, anon;
grant execute on function public.submit_cash_shared_slip(uuid, jsonb, text) to authenticated, service_role;

comment on function public.submit_cash_shared_slip(uuid, jsonb, text) is
  'Owner / payment_requests edit / PR creator of the receipt: allocate one uploaded cash receipt across items of several cash phiếu of the same requester. The allocation total must equal coalesce(receipt.amount, receipt.ocr_amount) after round() to whole đồng; every split writes payment_cash_receipt_splits, fully-covered phiếu become completed and enqueue payment_cash_settled once. Idempotent by key.';

-- ===========================================================================
-- C. get_cash_settlement: also expose receipts shared into this phiếu
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

  -- Own receipts plus every receipt of ANOTHER phiếu that has a split into an
  -- item of this phiếu. shared_from_* stays null for own receipts.
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
    'shared_from_request_id',
      case when r.payment_request_id = p_request_id then null else r.payment_request_id end,
    'shared_from_request_number',
      case when r.payment_request_id = p_request_id then null else source_pr.request_number end,
    'splits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', s.payment_request_item_id,
        'amount', s.amount,
        'request_id', si.payment_request_id
      ) order by s.created_at, s.id)
      from public.payment_cash_receipt_splits s
      join public.payment_request_items si on si.id = s.payment_request_item_id
      where s.receipt_id = r.id
    ), '[]'::jsonb)
  ) order by r.created_at, r.id), '[]'::jsonb)
  into v_receipts
  from public.payment_cash_receipts r
  left join public.payment_requests source_pr on source_pr.id = r.payment_request_id
  where r.payment_request_id = p_request_id
     or (
       r.status = 'allocated'
       and exists (
         select 1
         from public.payment_cash_receipt_splits s
         join public.payment_request_items si on si.id = s.payment_request_item_id
         where s.receipt_id = r.id
           and si.payment_request_id = p_request_id
       )
     );

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
  'Owner / payment_requests view: cash PR header, items with covered amounts (legacy receipts + splits), own receipts plus receipts of other phiếu split into this phiếu (shared_from_request_id/number), each receipt with all its splits (item_id, amount, request_id), the CEO evidence rows (get_payment_request_unc_evidence) and attachments.';

-- ===========================================================================
-- C2. submit_cash_settlement: scope replay to the same phiếu.
--
-- The shared ledger also holds multi-phiếu results from
-- submit_cash_shared_slip. Keep the single-phiếu flow's behaviour identical,
-- but never replay a result belonging to another phiếu and never accept a
-- cash-shared: key.
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
  v_prior_request_id uuid;
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
  -- Shared-slip keys belong to submit_cash_shared_slip and may never be read
  -- or reserved by this single-phiếu flow.
  if left(v_key, 12) = 'cash-shared:' then
    raise exception 'invalid_idempotency_key' using errcode = '22023', detail = 'reserved_shared_prefix';
  end if;

  -- Idempotent replay (checked before and after the advisory lock).
  select result, payment_request_id into v_prior, v_prior_request_id
  from public.payment_cash_settlement_idempotency
  where idempotency_key = v_key;
  if found then
    if v_prior_request_id is distinct from p_request_id then
      raise exception 'invalid_idempotency_key' using errcode = '22023', detail = 'idempotency_key_request_mismatch';
    end if;
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  perform pg_advisory_xact_lock(hashtext('payment_cash_settlement:' || v_key));

  select result, payment_request_id into v_prior, v_prior_request_id
  from public.payment_cash_settlement_idempotency
  where idempotency_key = v_key;
  if found then
    if v_prior_request_id is distinct from p_request_id then
      raise exception 'invalid_idempotency_key' using errcode = '22023', detail = 'idempotency_key_request_mismatch';
    end if;
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
  'Owner / payment_requests edit / PR creator: allocate uploaded cash receipts to PR items (each amount > 0; one receipt may be split across several items; per-item and per-receipt sums bounded after round() to whole đồng), mark allocated, set completed + cash_settled_at/by and enqueue payment_cash_settled when every item is fully covered. Idempotent by key, scoped to this phiếu; cash-shared keys are rejected.';
