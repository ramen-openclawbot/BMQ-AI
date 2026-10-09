-- Chặn chi vượt giá trị PO + gắn nhãn đối soát chi trùng / chi thiếu chứng từ.
--
-- Additive only. This migration:
--   (a) adds public.purchase_order_overpay_allowances + the owner-only
--       public.allow_purchase_order_overpay RPC (CEO-approved overpay budget),
--   (b) adds a BEFORE INSERT/UPDATE trigger on payment_allocations that stops
--       any write from pushing the total paid across every phiếu of one PO past
--       purchase_orders.total_amount + the approved allowance (po_overpaid),
--   (c) adds a BEFORE INSERT/UPDATE trigger on payment_requests that stops a new
--       or re-opened phiếu from pushing the total requested across the
--       non-rejected phiếu of one PO past the PO value + allowance
--       (po_over_requested). Approving, rejecting or editing other fields of an
--       already-existing phiếu is never blocked,
--   (d) adds the partial unique index public.uq_payment_requests_goods_receipt_open
--       so one goods receipt only ever has one non-rejected payment request,
--   (e) adds public.finance_reconciliation_reviews + the owner-only
--       public.review_finance_reconciliation_flag RPC (CEO check-state),
--   (f) adds the read-only public.finance_reconciliation_flags view
--       (security_invoker = true) that computes the fixed Laya-style labels.
--
-- It never updates, deletes or changes the state of any existing payment,
-- allocation, payment request, purchase order, goods receipt or invoice, sends
-- no notification and schedules no cron job. Existing UNC flows keep working:
-- the new trigger is the only added write guard.

-- ---------------------------------------------------------------------------
-- 1. CEO-approved overpay allowance per purchase order.
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_order_overpay_allowances (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  extra_amount numeric not null,
  reason text not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint purchase_order_overpay_allowances_extra_amount_positive
    check (extra_amount > 0),
  constraint purchase_order_overpay_allowances_reason_length
    check (length(btrim(reason)) >= 5)
);

create index if not exists idx_purchase_order_overpay_allowances_po
  on public.purchase_order_overpay_allowances (purchase_order_id);

alter table public.purchase_order_overpay_allowances enable row level security;
-- Written only through the SECURITY DEFINER RPC below; clients never write it
-- directly. The project has no default grants, so every grant is explicit.
revoke all on public.purchase_order_overpay_allowances from public, anon, authenticated;
grant select on public.purchase_order_overpay_allowances to authenticated;

drop policy if exists purchase_order_overpay_allowances_select on public.purchase_order_overpay_allowances;
create policy purchase_order_overpay_allowances_select
  on public.purchase_order_overpay_allowances
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
  );

create or replace function public.allow_purchase_order_overpay(
  p_purchase_order_id uuid,
  p_extra_amount numeric,
  p_reason text
)
returns public.purchase_order_overpay_allowances
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row public.purchase_order_overpay_allowances;
begin
  -- Owner-only: raising a PO budget is a CEO decision. Module edit permission is
  -- deliberately NOT accepted.
  if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if p_purchase_order_id is null then
    raise exception 'purchase_order_required' using errcode = '22023';
  end if;
  if p_extra_amount is null or p_extra_amount <= 0 then
    raise exception 'invalid_extra_amount' using errcode = '22023';
  end if;
  if length(v_reason) < 5 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  -- Serialize concurrent allowances / cash-outs on the same PO.
  perform 1 from public.purchase_orders po where po.id = p_purchase_order_id for update;
  if not found then
    raise exception 'purchase_order_not_found' using errcode = 'P0002';
  end if;

  insert into public.purchase_order_overpay_allowances (
    purchase_order_id,
    extra_amount,
    reason,
    created_by
  ) values (
    p_purchase_order_id,
    p_extra_amount,
    v_reason,
    v_actor
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.allow_purchase_order_overpay(uuid, numeric, text) from public, anon;
grant execute on function public.allow_purchase_order_overpay(uuid, numeric, text) to authenticated, service_role;

comment on function public.allow_purchase_order_overpay(uuid, numeric, text) is
  'Owner-only RPC: locks the purchase order and records an approved overpay allowance (extra_amount > 0, reason >= 5 chars) for it, returning the inserted row.';

-- ---------------------------------------------------------------------------
-- 2. payment_allocations guard: never pay more than PO value + allowance.
-- ---------------------------------------------------------------------------
create or replace function public.guard_payment_allocation_po_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po_id uuid;
  v_po_number text;
  v_po_total numeric;
  v_allowance numeric;
  v_allocated numeric;
  v_candidate numeric;
begin
  -- Defensive: the trigger is not created for DELETE, but never block a
  -- reduction of the paid total either way.
  if tg_op = 'DELETE' then
    return old;
  end if;
  -- Lowering an allocation on the same phiếu never adds money: always allowed,
  -- even on a PO that is already over its value (so mistakes can be corrected).
  if tg_op = 'UPDATE'
     and new.payment_request_id is not distinct from old.payment_request_id
     and coalesce(new.amount, 0) <= coalesce(old.amount, 0) then
    return new;
  end if;

  select pr.purchase_order_id
    into v_po_id
  from public.payment_requests pr
  where pr.id = new.payment_request_id;

  -- A phiếu without a PO is out of scope for this guard.
  if v_po_id is null then
    return new;
  end if;

  -- Lock the PO row (same order in every write path) to serialize concurrent
  -- allocations that would otherwise each read a stale paid total.
  select po.po_number, po.total_amount
    into v_po_number, v_po_total
  from public.purchase_orders po
  where po.id = v_po_id
  for update;

  select coalesce(sum(a.extra_amount), 0)
    into v_allowance
  from public.purchase_order_overpay_allowances a
  where a.purchase_order_id = v_po_id;

  -- Total paid across every phiếu of the PO, excluding this row when it is an
  -- UPDATE (so the old value is replaced, not double-counted), then add the
  -- amount being written.
  select coalesce(sum(pa.amount), 0)
    into v_allocated
  from public.payment_allocations pa
  join public.payment_requests pr on pr.id = pa.payment_request_id
  where pr.purchase_order_id = v_po_id
    and (tg_op = 'INSERT' or pa.id <> new.id);

  v_candidate := coalesce(v_allocated, 0) + coalesce(new.amount, 0);

  if round(v_candidate) > round(coalesce(v_po_total, 0) + coalesce(v_allowance, 0)) then
    raise exception 'po_overpaid: Khoản chi làm tổng đã chi vượt giá trị PO % (PO % đ, ngoại lệ % đ, đã chi % đ, lần này % đ). Cần CEO mở ngoại lệ có lý do.',
      coalesce(v_po_number, v_po_id::text),
      to_char(round(coalesce(v_po_total, 0)), 'FM999G999G999G999'),
      to_char(round(coalesce(v_allowance, 0)), 'FM999G999G999G999'),
      to_char(round(coalesce(v_allocated, 0)), 'FM999G999G999G999'),
      to_char(round(coalesce(new.amount, 0)), 'FM999G999G999G999')
      using errcode = 'P0001',
            detail = format(
              'po_number=%s po_total=%s allowance=%s already_paid=%s this_amount=%s',
              coalesce(v_po_number, v_po_id::text),
              coalesce(v_po_total, 0),
              coalesce(v_allowance, 0),
              coalesce(v_allocated, 0),
              coalesce(new.amount, 0)
            );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_payment_allocation_po_total on public.payment_allocations;
create trigger trg_guard_payment_allocation_po_total
before insert or update of amount, payment_request_id
on public.payment_allocations
for each row execute function public.guard_payment_allocation_po_total();

-- ---------------------------------------------------------------------------
-- 3. payment_requests guard: never over-request one PO (+ allowance).
-- ---------------------------------------------------------------------------
create or replace function public.guard_payment_request_po_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check boolean := false;
  v_po_id uuid := new.purchase_order_id;
  v_po_number text;
  v_po_total numeric;
  v_allowance numeric;
  v_requested numeric;
  v_dup_request text;
begin
  if tg_op = 'INSERT' then
    v_check := true;
  else
    -- Only a new phiếu, a changed PO / amount or a rejected -> open reopen is
    -- checked. Approving, rejecting or editing other fields is always allowed,
    -- even on an already over-limit phiếu, so accounting can still reject it.
    v_check :=
      new.purchase_order_id is distinct from old.purchase_order_id
      or coalesce(new.total_amount, 0) > coalesce(old.total_amount, 0)
      or (old.status::text = 'rejected' and new.status::text <> 'rejected');
  end if;

  -- One open phiếu per goods receipt: a readable error ahead of the partial
  -- unique index uq_payment_requests_goods_receipt_open (which stays the hard stop).
  if new.goods_receipt_id is not null
     and new.status::text <> 'rejected'
     and (tg_op = 'INSERT'
          or new.goods_receipt_id is distinct from old.goods_receipt_id
          or (old.status::text = 'rejected' and new.status::text <> 'rejected')) then
    select pr.request_number
      into v_dup_request
    from public.payment_requests pr
    where pr.goods_receipt_id = new.goods_receipt_id
      and pr.status::text <> 'rejected'
      and (tg_op = 'INSERT' or pr.id <> new.id)
    limit 1;
    if v_dup_request is not null then
      raise exception 'goods_receipt_already_requested: Phiếu nhập này đã có phiếu đề nghị chi % chưa bị từ chối.', v_dup_request
        using errcode = 'P0001';
    end if;
  end if;

  if not v_check then
    return new;
  end if;
  if new.status::text = 'rejected' or v_po_id is null then
    return new;
  end if;

  select po.po_number, po.total_amount
    into v_po_number, v_po_total
  from public.purchase_orders po
  where po.id = v_po_id
  for update;

  select coalesce(sum(a.extra_amount), 0)
    into v_allowance
  from public.purchase_order_overpay_allowances a
  where a.purchase_order_id = v_po_id;

  -- Total requested across every other non-rejected phiếu of the PO plus the
  -- amount being written on this one.
  select coalesce(sum(pr.total_amount), 0)
    into v_requested
  from public.payment_requests pr
  where pr.purchase_order_id = v_po_id
    and pr.status::text <> 'rejected'
    and (tg_op = 'INSERT' or pr.id <> new.id);

  v_requested := coalesce(v_requested, 0) + coalesce(new.total_amount, 0);

  if round(v_requested) > round(coalesce(v_po_total, 0) + coalesce(v_allowance, 0)) then
    raise exception 'po_over_requested: Tổng các phiếu đề nghị chi vượt giá trị PO % (PO % đ, ngoại lệ % đ, các phiếu khác % đ, phiếu này % đ). Kiểm tra phiếu tạo trùng, hoặc CEO mở ngoại lệ có lý do.',
      coalesce(v_po_number, v_po_id::text),
      to_char(round(coalesce(v_po_total, 0)), 'FM999G999G999G999'),
      to_char(round(coalesce(v_allowance, 0)), 'FM999G999G999G999'),
      to_char(round(coalesce(v_requested - coalesce(new.total_amount, 0), 0)), 'FM999G999G999G999'),
      to_char(round(coalesce(new.total_amount, 0)), 'FM999G999G999G999')
      using errcode = 'P0001',
            detail = format(
              'po_number=%s po_total=%s allowance=%s already_requested=%s this_amount=%s',
              coalesce(v_po_number, v_po_id::text),
              coalesce(v_po_total, 0),
              coalesce(v_allowance, 0),
              coalesce(v_requested - coalesce(new.total_amount, 0), 0),
              coalesce(new.total_amount, 0)
            );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_payment_request_po_total on public.payment_requests;
create trigger trg_guard_payment_request_po_total
before insert or update of purchase_order_id, total_amount, status, goods_receipt_id
on public.payment_requests
for each row execute function public.guard_payment_request_po_total();

-- ---------------------------------------------------------------------------
-- 4. One non-rejected payment request per goods receipt.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad record;
begin
  select gr.receipt_number, count(*) as open_requests
    into v_bad
  from public.payment_requests pr
  join public.goods_receipts gr on gr.id = pr.goods_receipt_id
  where pr.goods_receipt_id is not null
    and pr.status::text <> 'rejected'
  group by gr.receipt_number
  having count(*) > 1
  limit 1;

  if found then
    raise exception 'goods_receipt_already_requested'
      using errcode = 'P0001',
            detail = format(
              'receipt_number=%s open_requests=%s',
              v_bad.receipt_number,
              v_bad.open_requests
            );
  end if;
end $$;

create unique index if not exists uq_payment_requests_goods_receipt_open
  on public.payment_requests (goods_receipt_id)
  where goods_receipt_id is not null and status <> 'rejected';

-- ---------------------------------------------------------------------------
-- 5. CEO check-state for a reconciliation flag.
-- ---------------------------------------------------------------------------
create table if not exists public.finance_reconciliation_reviews (
  flag_key text primary key,
  status text not null,
  note text,
  reviewed_by uuid,
  reviewed_at timestamptz not null default now(),
  constraint finance_reconciliation_reviews_status_check
    check (status in ('checked', 'false_alarm', 'needs_action'))
);

alter table public.finance_reconciliation_reviews enable row level security;
revoke all on public.finance_reconciliation_reviews from public, anon, authenticated;
grant select on public.finance_reconciliation_reviews to authenticated;

drop policy if exists finance_reconciliation_reviews_select on public.finance_reconciliation_reviews;
create policy finance_reconciliation_reviews_select
  on public.finance_reconciliation_reviews
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
  );

create or replace function public.review_finance_reconciliation_flag(
  p_flag_key text,
  p_status text,
  p_note text
)
returns public.finance_reconciliation_reviews
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_key text := btrim(coalesce(p_flag_key, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row public.finance_reconciliation_reviews;
begin
  if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if v_key = '' then
    raise exception 'flag_key_required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('checked', 'false_alarm', 'needs_action') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  insert into public.finance_reconciliation_reviews (
    flag_key,
    status,
    note,
    reviewed_by,
    reviewed_at
  ) values (
    v_key,
    p_status,
    v_note,
    v_actor,
    now()
  )
  on conflict (flag_key) do update
    set status = excluded.status,
        note = excluded.note,
        reviewed_by = excluded.reviewed_by,
        reviewed_at = excluded.reviewed_at
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.review_finance_reconciliation_flag(text, text, text) from public, anon;
grant execute on function public.review_finance_reconciliation_flag(text, text, text) to authenticated, service_role;

comment on function public.review_finance_reconciliation_flag(text, text, text) is
  'Owner-only RPC: upserts the CEO reconciliation status (checked/false_alarm/needs_action) for one flag_key and returns the stored row.';

-- ---------------------------------------------------------------------------
-- 6. Reconciliation flag view (fixed rules, read-only).
-- ---------------------------------------------------------------------------
drop view if exists public.finance_reconciliation_flags;
create view public.finance_reconciliation_flags
with (security_invoker = true) as
with
allow as (
  select a.purchase_order_id, sum(a.extra_amount) as extra
  from public.purchase_order_overpay_allowances a
  group by a.purchase_order_id
),
request_paid as (
  select pr.id,
         pr.purchase_order_id,
         pr.supplier_id,
         pr.request_number,
         pr.status,
         pr.total_amount,
         coalesce(sum(pa.amount), 0) as paid
  from public.payment_requests pr
  left join public.payment_allocations pa on pa.payment_request_id = pr.id
  group by pr.id
),
po_paid as (
  select rp.purchase_order_id as po_id,
         sum(rp.paid) as paid,
         jsonb_agg(
           jsonb_build_object(
             'request_number', rp.request_number,
             'status', rp.status::text,
             'total_amount', coalesce(rp.total_amount, 0),
             'paid', rp.paid
           )
           order by rp.request_number
         ) as requests
  from request_paid rp
  where rp.purchase_order_id is not null
  group by rp.purchase_order_id
),
po_requested as (
  select pr.purchase_order_id as po_id, sum(coalesce(pr.total_amount, 0)) as requested
  from public.payment_requests pr
  where pr.purchase_order_id is not null
    and pr.status::text <> 'rejected'
  group by pr.purchase_order_id
),
flags as (
  -- po_overpaid (critical): paid total across the PO's phiếu exceeds value + allowance.
  select
    'po_overpaid:' || po.id::text as flag_key,
    'po_overpaid'::text as label,
    'critical'::text as priority,
    'finance'::text as category,
    'purchase_order'::text as entity_type,
    po.id as entity_id,
    po.po_number as entity_ref,
    po.supplier_id as supplier_id,
    s.name as supplier_name,
    'po:' || po.id::text as group_key,
    round(pp.paid - (coalesce(po.total_amount, 0) + coalesce(al.extra, 0))) as amount,
    jsonb_build_object(
      'po_number', po.po_number,
      'po_total', coalesce(po.total_amount, 0),
      'allowance', coalesce(al.extra, 0),
      'paid_total', pp.paid,
      'overpaid', round(pp.paid - (coalesce(po.total_amount, 0) + coalesce(al.extra, 0))),
      'requests', pp.requests
    ) as evidence,
    now() as detected_at
  from public.purchase_orders po
  join po_paid pp on pp.po_id = po.id
  left join allow al on al.purchase_order_id = po.id
  left join public.suppliers s on s.id = po.supplier_id
  where round(pp.paid) > round(coalesce(po.total_amount, 0) + coalesce(al.extra, 0))

  union all

  -- po_over_requested (high): non-rejected requested total exceeds value + allowance.
  select
    'po_over_requested:' || po.id::text,
    'po_over_requested',
    'high',
    'finance',
    'purchase_order',
    po.id,
    po.po_number,
    po.supplier_id,
    s.name,
    'po:' || po.id::text,
    round(rq.requested - (coalesce(po.total_amount, 0) + coalesce(al.extra, 0))),
    jsonb_build_object(
      'po_number', po.po_number,
      'po_total', coalesce(po.total_amount, 0),
      'allowance', coalesce(al.extra, 0),
      'requested_total', rq.requested,
      'over_requested', round(rq.requested - (coalesce(po.total_amount, 0) + coalesce(al.extra, 0)))
    ),
    now()
  from public.purchase_orders po
  join po_requested rq on rq.po_id = po.id
  left join allow al on al.purchase_order_id = po.id
  left join public.suppliers s on s.id = po.supplier_id
  where round(rq.requested) > round(coalesce(po.total_amount, 0) + coalesce(al.extra, 0))

  union all

  -- pr_twin_created (high): the later of two non-rejected same-PO, same-amount
  -- phiếu created within 10 minutes.
  select
    'pr_twin_created:' || pr.id::text,
    'pr_twin_created',
    'high',
    'finance',
    'payment_request',
    pr.id,
    pr.request_number,
    pr.supplier_id,
    s.name,
    'po:' || pr.purchase_order_id::text,
    coalesce(pr.total_amount, 0),
    jsonb_build_object(
      'request_number', pr.request_number,
      'twin_request_number', twin.request_number,
      'request_total', coalesce(pr.total_amount, 0),
      'twin_total', coalesce(twin.total_amount, 0),
      'gap_seconds', round(extract(epoch from (pr.created_at - twin.created_at)))
    ),
    now()
  from public.payment_requests pr
  join lateral (
    select t.id, t.request_number, t.total_amount, t.created_at
    from public.payment_requests t
    where t.purchase_order_id = pr.purchase_order_id
      and t.id <> pr.id
      and t.status::text <> 'rejected'
      and t.total_amount = pr.total_amount
      and t.created_at <= pr.created_at
      and pr.created_at - t.created_at <= interval '10 minutes'
    order by t.created_at desc, t.id desc
    limit 1
  ) twin on true
  left join public.suppliers s on s.id = pr.supplier_id
  where pr.purchase_order_id is not null
    and pr.status::text <> 'rejected'
    and pr.total_amount is not null

  union all

  -- paid_without_bank_evidence (medium): paid, but no linked payment reference
  -- and no linked UNC evidence.
  select
    'paid_without_bank_evidence:' || pr.id::text,
    'paid_without_bank_evidence',
    'medium',
    'finance',
    'payment_request',
    pr.id,
    pr.request_number,
    pr.supplier_id,
    s.name,
    case
      when pr.purchase_order_id is not null then 'po:' || pr.purchase_order_id::text
      else 'supplier:' || coalesce(pr.supplier_id::text, '')
    end,
    coalesce(pr.total_amount, 0),
    jsonb_build_object(
      'request_number', pr.request_number,
      'payment_status', pr.payment_status::text,
      'total_amount', coalesce(pr.total_amount, 0)
    ),
    now()
  from public.payment_requests pr
  left join public.suppliers s on s.id = pr.supplier_id
  where pr.payment_status::text = 'paid'
    and not exists (
      select 1
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id
      where pa.payment_request_id = pr.id
        and p.reference_number is not null
        and btrim(p.reference_number) <> ''
    )
    and not exists (
      select 1
      from public.payment_allocations pa
      join public.payment_unc_evidence e on e.payment_id = pa.payment_id
      where pa.payment_request_id = pr.id
    )

  union all

  -- paid_without_receipt (medium): requires a receipt, paid, no goods receipt,
  -- open more than 7 days.
  select
    'paid_without_receipt:' || pr.id::text,
    'paid_without_receipt',
    'medium',
    'finance',
    'payment_request',
    pr.id,
    pr.request_number,
    pr.supplier_id,
    s.name,
    case
      when pr.purchase_order_id is not null then 'po:' || pr.purchase_order_id::text
      else 'supplier:' || coalesce(pr.supplier_id::text, '')
    end,
    coalesce(pr.total_amount, 0),
    jsonb_build_object(
      'request_number', pr.request_number,
      'payment_status', pr.payment_status::text,
      'total_amount', coalesce(pr.total_amount, 0),
      'days_open', floor(extract(epoch from (now() - pr.created_at)) / 86400)
    ),
    now()
  from public.payment_requests pr
  left join public.suppliers s on s.id = pr.supplier_id
  where pr.requires_receipt = true
    and pr.payment_status::text in ('paid', 'overpaid')
    and pr.goods_receipt_id is null
    and pr.created_at < now() - interval '7 days'

  union all

  -- receipt_confirmed_delivery_pending (low): linked goods receipt confirmed but
  -- the phiếu still says pending delivery.
  select
    'receipt_confirmed_delivery_pending:' || pr.id::text,
    'receipt_confirmed_delivery_pending',
    'low',
    'finance',
    'payment_request',
    pr.id,
    pr.request_number,
    pr.supplier_id,
    s.name,
    case
      when pr.purchase_order_id is not null then 'po:' || pr.purchase_order_id::text
      else 'supplier:' || coalesce(pr.supplier_id::text, '')
    end,
    coalesce(pr.total_amount, 0),
    jsonb_build_object(
      'request_number', pr.request_number,
      'receipt_number', gr.receipt_number,
      'receipt_status', gr.status::text,
      'delivery_status', pr.delivery_status::text
    ),
    now()
  from public.payment_requests pr
  join public.goods_receipts gr on gr.id = pr.goods_receipt_id
  left join public.suppliers s on s.id = pr.supplier_id
  where gr.status::text = 'confirmed'
    and pr.delivery_status::text = 'pending'

  union all

  -- invoice_zero_amount (low): linked invoice is 0 while the phiếu is not.
  select
    'invoice_zero_amount:' || pr.id::text,
    'invoice_zero_amount',
    'low',
    'finance',
    'payment_request',
    pr.id,
    pr.request_number,
    pr.supplier_id,
    s.name,
    case
      when pr.purchase_order_id is not null then 'po:' || pr.purchase_order_id::text
      else 'supplier:' || coalesce(pr.supplier_id::text, '')
    end,
    coalesce(pr.total_amount, 0),
    jsonb_build_object(
      'request_number', pr.request_number,
      'invoice_number', inv.invoice_number,
      'invoice_total', coalesce(inv.total_amount, 0),
      'request_total', coalesce(pr.total_amount, 0)
    ),
    now()
  from public.payment_requests pr
  join public.invoices inv on inv.id = pr.invoice_id
  left join public.suppliers s on s.id = pr.supplier_id
  where coalesce(inv.total_amount, 0) = 0
    and coalesce(pr.total_amount, 0) > 0
)
select
  f.flag_key,
  f.label,
  f.priority,
  f.category,
  f.entity_type,
  f.entity_id,
  f.entity_ref,
  f.supplier_id,
  f.supplier_name,
  f.group_key,
  f.amount,
  f.evidence,
  f.detected_at,
  r.status as review_status,
  r.note as review_note
from flags f
left join public.finance_reconciliation_reviews r on r.flag_key = f.flag_key;

revoke all on public.finance_reconciliation_flags from public, anon;
grant select on public.finance_reconciliation_flags to authenticated;
