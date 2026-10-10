-- Chi tiền mặt kiểu UNC + bước quyết toán chứng từ.
--
-- This migration:
--   (A) removes the retired CEO cash-expense flow (production has 0 rows):
--       record_ceo_cash_expense + discard_ceo_cash_expense_draft +
--       ceo_cash_expense_drafts are dropped. The widened
--       payment_request_items.cost_review_routing check stays.
--   (B) adds the cash-settlement columns and tables:
--       payment_requests.cash_settlement_status / cash_settled_at / cash_settled_by,
--       payment_request_attachments and payment_cash_receipts with explicit grants.
--   (C) hooks the paid Zalo trigger into the cash flow and adds the settlement
--       RPCs (submit_cash_settlement, discard_cash_receipt, get_cash_settlement)
--       plus the payment_cash_advanced / payment_cash_settled outbox events.
--
-- UNC / bank_transfer behaviour is untouched: bank_transfer PRs keep the exact
-- payment_request_paid message, the existing approve_payment_requests_with_unc
-- signature/behaviour is not redefined, and no cron job is scheduled.

-- ---------------------------------------------------------------------------
-- PART A. Drop the retired CEO cash-expense flow.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ceo_cash_expense_drafts') is not null then
    if exists (select 1 from public.ceo_cash_expense_drafts limit 1) then
      raise exception 'ceo_cash_expense_drafts_not_empty: refusing to drop a table that still has rows';
    end if;
  end if;
end $$;

drop function if exists public.record_ceo_cash_expense(uuid, jsonb, text);
drop function if exists public.discard_ceo_cash_expense_draft(uuid);
drop table if exists public.ceo_cash_expense_drafts;

-- Keep the additive widened cost-review routing value (20261012090000).
alter table public.payment_request_items
  drop constraint if exists payment_request_items_cost_review_routing_check;
alter table public.payment_request_items
  add constraint payment_request_items_cost_review_routing_check
  check (cost_review_routing in ('none', 'needs_review', 'manual_review'));

-- ---------------------------------------------------------------------------
-- PART B. Cash-settlement columns and tables.
-- ---------------------------------------------------------------------------
alter table public.payment_requests
  add column if not exists cash_settlement_status text;
alter table public.payment_requests
  add column if not exists cash_settled_at timestamptz;
alter table public.payment_requests
  add column if not exists cash_settled_by uuid;

alter table public.payment_requests
  drop constraint if exists payment_requests_cash_settlement_status_check;
alter table public.payment_requests
  add constraint payment_requests_cash_settlement_status_check
  check (cash_settlement_status is null or cash_settlement_status in ('awaiting_receipts', 'completed'));

-- ---------------------------------------------------------------------------
-- Shared permission helper: owner, payment_requests edit, or the PR creator.
-- SECURITY DEFINER so the creator check is not hidden behind payment_requests RLS.
-- ---------------------------------------------------------------------------
create or replace function public.can_edit_payment_request(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role(auth.uid(), 'owner')
    or public.has_module_permission(auth.uid(), 'payment_requests', 'edit')
    or exists (
      select 1
      from public.payment_requests pr
      where pr.id = p_request_id and pr.created_by = auth.uid()
    );
$$;

revoke all on function public.can_edit_payment_request(uuid) from public, anon;
grant execute on function public.can_edit_payment_request(uuid) to authenticated, service_role;

comment on function public.can_edit_payment_request(uuid) is
  'True when auth.uid() is owner, has payment_requests edit, or created the request (service_role always true).';

-- Supporting documents attached by staff to a cash PR. Written directly by
-- authenticated staff; not part of the settlement accounting.
create table if not exists public.payment_request_attachments (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.payment_requests(id) on delete cascade,
  storage_path text not null,
  file_name text,
  mime_type text,
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists idx_payment_request_attachments_request
  on public.payment_request_attachments (payment_request_id, created_at);

alter table public.payment_request_attachments enable row level security;
revoke all on public.payment_request_attachments from public, anon, authenticated;
grant select, insert on public.payment_request_attachments to authenticated;
grant all on public.payment_request_attachments to service_role;

drop policy if exists payment_request_attachments_select on public.payment_request_attachments;
create policy payment_request_attachments_select
  on public.payment_request_attachments
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner')
    or public.has_module_permission(auth.uid(), 'payment_requests', 'view')
  );

drop policy if exists payment_request_attachments_insert on public.payment_request_attachments;
create policy payment_request_attachments_insert
  on public.payment_request_attachments
  for insert
  to authenticated
  with check (public.can_edit_payment_request(payment_request_id));

-- Cash receipts uploaded against a cash PR. The edge function (service role)
-- inserts the OCR draft; submit_cash_settlement / discard_cash_receipt are the
-- only client-reachable writers (both SECURITY DEFINER).
create table if not exists public.payment_cash_receipts (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.payment_requests(id) on delete cascade,
  payment_request_item_id uuid references public.payment_request_items(id) on delete set null,
  storage_path text not null,
  file_sha256 text not null,
  ocr_amount numeric,
  ocr_payee text,
  ocr_date date,
  ocr_reference text,
  ocr_content text,
  ocr_error text,
  amount numeric,
  status text not null default 'uploaded',
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  allocated_at timestamptz,
  constraint payment_cash_receipts_status_check
    check (status in ('uploaded', 'allocated', 'discarded')),
  constraint payment_cash_receipts_amount_positive
    check (amount is null or amount > 0),
  constraint payment_cash_receipts_ocr_amount_positive
    check (ocr_amount is null or ocr_amount > 0)
);

create unique index if not exists uq_payment_cash_receipts_file_sha256
  on public.payment_cash_receipts (file_sha256)
  where status <> 'discarded';

create index if not exists idx_payment_cash_receipts_request
  on public.payment_cash_receipts (payment_request_id, created_at);
create index if not exists idx_payment_cash_receipts_item
  on public.payment_cash_receipts (payment_request_item_id)
  where payment_request_item_id is not null;

alter table public.payment_cash_receipts enable row level security;
revoke all on public.payment_cash_receipts from public, anon, authenticated;
grant select on public.payment_cash_receipts to authenticated;
grant all on public.payment_cash_receipts to service_role;

drop policy if exists payment_cash_receipts_select on public.payment_cash_receipts;
create policy payment_cash_receipts_select
  on public.payment_cash_receipts
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner')
    or public.has_module_permission(auth.uid(), 'payment_requests', 'view')
  );

-- Server-side idempotency ledger for submit_cash_settlement (never exposed).
create table if not exists public.payment_cash_settlement_idempotency (
  idempotency_key text primary key,
  payment_request_id uuid not null references public.payment_requests(id) on delete cascade,
  result jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.payment_cash_settlement_idempotency enable row level security;
revoke all on public.payment_cash_settlement_idempotency from public, anon, authenticated;
grant all on public.payment_cash_settlement_idempotency to service_role;

-- ---------------------------------------------------------------------------
-- PART C. Cash Zalo message builder + paid trigger + settlement RPCs.
-- ---------------------------------------------------------------------------

-- Vietnamese message builder for the two cash events. Mirrors the shared
-- TypeScript formatters: no bank account numbers, no image payloads.
create or replace function public.build_finance_zalo_cash_message(
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
  v_requester text;
begin
  select * into v_pr from public.payment_requests where id = p_request_id;
  if not found then
    return null;
  end if;

  select coalesce(
    nullif(btrim(p.full_name), ''),
    nullif(btrim(p.email), '')
  )
  into v_requester
  from public.profiles p
  where p.user_id = v_pr.created_by;

  if p_event_type = 'payment_cash_advanced' then
    return concat_ws(
      E'\n',
      '💵 TẠM ỨNG TIỀN MẶT',
      '',
      'Mã duyệt chi: ' || v_pr.request_number,
      'Người đề nghị: ' || coalesce(v_requester, 'Chưa xác định'),
      'Số tiền: ' || public.finance_format_vnd(v_pr.total_amount),
      '',
      'Nộp chứng từ: https://ai.banhmique.vn/payment-requests/cash-settle/' || v_pr.id::text
    );
  end if;

  if p_event_type = 'payment_cash_settled' then
    return concat_ws(
      E'\n',
      '✅ HOÀN TẤT CHI TIỀN MẶT',
      '',
      'Mã duyệt chi: ' || v_pr.request_number,
      'Người đề nghị: ' || coalesce(v_requester, 'Chưa xác định'),
      'Số tiền: ' || public.finance_format_vnd(v_pr.total_amount),
      '',
      'Xem chi tiết: https://ai.banhmique.vn/payment-requests?id=' || v_pr.id::text
    );
  end if;

  return null;
end;
$$;

revoke all on function public.build_finance_zalo_cash_message(uuid, text) from public, anon, authenticated;

-- Event-type check gains the two cash events.
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
    'payment_cash_settled'
  ));

-- Same trigger as 20261006120000, but a cash PR that becomes paid is moved to
-- cash_settlement_status='awaiting_receipts' and announces payment_cash_advanced
-- INSTEAD of the normal payment_request_paid message. bank_transfer keeps the
-- exact current behaviour.
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
      if new.payment_method::text = 'cash' then
        if new.cash_settlement_status is null then
          update public.payment_requests
          set cash_settlement_status = 'awaiting_receipts'
          where id = new.id and cash_settlement_status is null;

          insert into public.finance_zalo_notifications (
            event_type, entity_id, group_key, message_body, status
          ) values (
            'payment_cash_advanced',
            new.id,
            'finance',
            coalesce(
              public.build_finance_zalo_cash_message(new.id, 'payment_cash_advanced'),
              'Tạm ứng tiền mặt: ' || new.request_number
            ),
            'pending'
          )
          on conflict (event_type, entity_id) do nothing;
        end if;
      else
        insert into public.finance_zalo_notifications (
          event_type, entity_id, group_key, message_body, status
        ) values (
          'payment_request_paid',
          new.id,
          'finance',
          coalesce(
            public.build_finance_zalo_payment_request_message(new.id, 'payment_request_paid'),
            'Đã chi: ' || new.request_number
          ),
          'pending'
        )
        on conflict (event_type, entity_id) do nothing;
      end if;
    end if;
  exception when others then
    -- Never break the business write; the outbox is best-effort.
    raise warning 'finance_zalo enqueue payment_request_paid failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_finance_zalo_payment_request_paid on public.payment_requests;
create trigger trg_finance_zalo_payment_request_paid
after update of status, payment_status on public.payment_requests
for each row execute function public.enqueue_finance_zalo_payment_request_paid();

revoke all on function public.enqueue_finance_zalo_payment_request_paid() from public, anon, authenticated;

-- submit_cash_settlement: allocates receipts to PR items, marks fully-covered
-- requests completed, and enqueues payment_cash_settled. Idempotent by key.
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
  v_distinct_receipts integer := 0;
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

  select count(*), count(distinct (a->>'receipt_id'))
    into v_alloc_count, v_distinct_receipts
  from jsonb_array_elements(v_allocs) a;
  if v_alloc_count <> v_distinct_receipts then
    raise exception 'invalid_allocation' using errcode = '22023', detail = 'duplicate_receipt';
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
  for v_alloc in
    select (a->>'item_id')::uuid as item_id, sum((a->>'amount')::numeric) as amount
    from jsonb_array_elements(v_allocs) a
    group by 1
  loop
    select coalesce(i.line_total, i.quantity * i.unit_price, 0)
      into v_item_amount
    from public.payment_request_items i
    where i.id = v_alloc.item_id;

    select coalesce(sum(r.amount), 0)
      into v_item_allocated
    from public.payment_cash_receipts r
    where r.payment_request_item_id = v_alloc.item_id
      and r.status = 'allocated';

    if v_item_allocated + v_alloc.amount > v_item_amount then
      raise exception 'item_over_allocated' using errcode = 'P0001',
        detail = format(
          'item_id=%s allocated=%s new=%s amount=%s',
          v_alloc.item_id, v_item_allocated, v_alloc.amount, v_item_amount
        );
    end if;
  end loop;

  -- --- Per-receipt allocated amount must not exceed the receipt amount -----
  for v_alloc in
    select (a->>'receipt_id')::uuid as receipt_id, (a->>'amount')::numeric as amount
    from jsonb_array_elements(v_allocs) a
  loop
    select coalesce(r.amount, r.ocr_amount)
      into v_receipt_amount
    from public.payment_cash_receipts r
    where r.id = v_alloc.receipt_id;

    if v_receipt_amount is not null and v_alloc.amount > v_receipt_amount then
      raise exception 'receipt_over_allocated' using errcode = 'P0001',
        detail = format(
          'receipt_id=%s new=%s amount=%s',
          v_alloc.receipt_id, v_alloc.amount, v_receipt_amount
        );
    end if;
  end loop;

  -- --- Apply the allocations ---------------------------------------------
  for v_alloc in
    select (a->>'receipt_id')::uuid as receipt_id,
           (a->>'item_id')::uuid as item_id,
           (a->>'amount')::numeric as amount
    from jsonb_array_elements(v_allocs) a
  loop
    update public.payment_cash_receipts
    set payment_request_item_id = v_alloc.item_id,
        amount = v_alloc.amount,
        status = 'allocated',
        allocated_at = now()
    where id = v_alloc.receipt_id;
  end loop;

  -- --- Coverage per item --------------------------------------------------
  for v_item in
    select *
    from public.payment_request_items i
    where i.payment_request_id = p_request_id
    order by i.created_at, i.id
  loop
    v_item_amount := coalesce(v_item.line_total, v_item.quantity * v_item.unit_price, 0);

    select coalesce(sum(r.amount), 0)
      into v_item_allocated
    from public.payment_cash_receipts r
    where r.payment_request_item_id = v_item.id
      and r.status = 'allocated';

    v_covered_total := v_covered_total + v_item_allocated;
    v_expected_total := v_expected_total + v_item_amount;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
      'amount', v_item_amount,
      'covered', v_item_allocated
    ));

    if v_item_allocated < v_item_amount then
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
  'Owner / payment_requests edit / PR creator: allocate uploaded cash receipts to PR items (each amount > 0, per-item and per-receipt sums bounded), mark allocated, set completed + cash_settled_at/by and enqueue payment_cash_settled when every item is fully covered. Idempotent by key.';

-- discard_cash_receipt: uploaded (not allocated) receipts only.
create or replace function public.discard_cash_receipt(p_receipt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_receipt public.payment_cash_receipts%rowtype;
begin
  if not v_is_service then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_receipt_id is null then
    raise exception 'receipt_required' using errcode = '22023';
  end if;

  select * into v_receipt
  from public.payment_cash_receipts
  where id = p_receipt_id
  for update;
  if not found then
    raise exception 'receipt_not_found' using errcode = 'P0002';
  end if;

  if not (v_is_service or public.can_edit_payment_request(v_receipt.payment_request_id)) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_receipt.status <> 'uploaded' then
    raise exception 'receipt_not_uploaded' using errcode = 'P0001',
      detail = format('status=%s', v_receipt.status);
  end if;

  update public.payment_cash_receipts
  set status = 'discarded'
  where id = p_receipt_id;

  return jsonb_build_object('id', p_receipt_id, 'status', 'discarded');
end;
$$;

revoke all on function public.discard_cash_receipt(uuid) from public, anon;
grant execute on function public.discard_cash_receipt(uuid) to authenticated, service_role;

comment on function public.discard_cash_receipt(uuid) is
  'Owner / payment_requests edit / PR creator: mark an uploaded (not allocated) cash receipt discarded so its sha256 can be reused.';

-- get_cash_settlement: read model for the settlement page.
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
      select sum(r.amount)
      from public.payment_cash_receipts r
      where r.payment_request_item_id = i.id and r.status = 'allocated'
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
    'allocated_at', r.allocated_at
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
  'Owner / payment_requests view: cash PR header, items with covered amounts, receipts with storage_path, the CEO evidence rows (get_payment_request_unc_evidence) and attachments.';
