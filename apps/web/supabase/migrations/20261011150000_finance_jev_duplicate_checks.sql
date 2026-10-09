-- Jev quét phiếu chi nghi trùng khác PO — lưu kết quả để đồng bộ warehouse.
--
-- Additive only. This migration:
--   (a) adds public.finance_jev_duplicate_checks, the per-pair Jev result store
--       (auto_clear / needs_review / auto_flag + the CEO review decision),
--   (b) adds the owner-only SECURITY DEFINER RPC
--       public.review_jev_duplicate_check(p_pair_key, p_decision, p_note),
--   (c) extends the read-only public.finance_reconciliation_flags view with the
--       new jev_possible_duplicate label, keeping all seven existing labels and
--       the exact column order (CREATE OR REPLACE, not a drop).
--
-- It never updates, deletes or changes the state of any existing payment,
-- allocation, payment request, purchase order, goods receipt or invoice, sends
-- no notification, creates no trigger and schedules no cron job. Jev only
-- labels pairs; a human (CEO) makes the spend decision. Candidates are written
-- by SQL or by the service-role edge function, never by the client directly.

-- ---------------------------------------------------------------------------
-- 1. Per-pair Jev duplicate result.
-- ---------------------------------------------------------------------------
create table if not exists public.finance_jev_duplicate_checks (
  id uuid primary key default gen_random_uuid(),
  -- Canonical pair identity: least(pr_a, pr_b) || ':' || greatest(pr_a, pr_b).
  pair_key text not null unique,
  pr_older uuid not null references public.payment_requests(id) on delete cascade,
  pr_newer uuid not null references public.payment_requests(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  amount_older numeric,
  amount_newer numeric,
  days_apart numeric,
  -- Hash of the exact state sent to Jev, so a pair is only re-checked when its
  -- source data actually changed.
  state_hash text not null,
  p_same numeric,
  relation text,
  relation_prob numeric,
  relation_confidence numeric,
  status text not null,
  model text,
  prompt_version text,
  checked_at timestamptz not null default now(),
  review_decision text,
  review_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  constraint finance_jev_duplicate_checks_pair_order
    check (pr_older <> pr_newer),
  constraint finance_jev_duplicate_checks_p_same_range
    check (p_same is null or (p_same >= 0 and p_same <= 1)),
  constraint finance_jev_duplicate_checks_status_check
    check (status in ('auto_clear', 'needs_review', 'auto_flag')),
  constraint finance_jev_duplicate_checks_review_decision_check
    check (review_decision is null or review_decision in ('same_purchase', 'different_purchase'))
);

create index if not exists idx_finance_jev_duplicate_checks_supplier
  on public.finance_jev_duplicate_checks (supplier_id);

create index if not exists idx_finance_jev_duplicate_checks_status
  on public.finance_jev_duplicate_checks (status);

create index if not exists idx_finance_jev_duplicate_checks_pr_newer
  on public.finance_jev_duplicate_checks (pr_newer);

alter table public.finance_jev_duplicate_checks enable row level security;
-- Written only by the service-role edge function (and reviewed through the RPC
-- below); clients never write it directly. The project has no default grants, so
-- every grant is explicit.
revoke all on public.finance_jev_duplicate_checks from public, anon, authenticated;
grant select on public.finance_jev_duplicate_checks to authenticated;

drop policy if exists finance_jev_duplicate_checks_select on public.finance_jev_duplicate_checks;
create policy finance_jev_duplicate_checks_select
  on public.finance_jev_duplicate_checks
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
  );

-- ---------------------------------------------------------------------------
-- 2. Owner-only CEO decision on one Jev duplicate pair.
-- ---------------------------------------------------------------------------
create or replace function public.review_jev_duplicate_check(
  p_pair_key text,
  p_decision text,
  p_note text
)
returns public.finance_jev_duplicate_checks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_key text := btrim(coalesce(p_pair_key, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row public.finance_jev_duplicate_checks;
begin
  -- Owner-only: deciding whether two phiếu are the same purchase is a CEO call.
  if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if v_key = '' then
    raise exception 'pair_key_required' using errcode = '22023';
  end if;
  if p_decision is null or p_decision not in ('same_purchase', 'different_purchase') then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;

  update public.finance_jev_duplicate_checks
     set review_decision = p_decision,
         review_note = v_note,
         reviewed_by = v_actor,
         reviewed_at = now()
   where pair_key = v_key
   returning * into v_row;

  if v_row.id is null then
    raise exception 'check_not_found' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

revoke all on function public.review_jev_duplicate_check(text, text, text) from public, anon;
grant execute on function public.review_jev_duplicate_check(text, text, text) to authenticated, service_role;

comment on function public.review_jev_duplicate_check(text, text, text) is
  'Owner-only RPC: records the CEO decision (same_purchase/different_purchase) on one Jev duplicate pair and returns the stored row.';

-- ---------------------------------------------------------------------------
-- 3. Reconciliation flag view (fixed rules, read-only) + new Jev label.
--    CREATE OR REPLACE keeps the seven existing labels and the exact column
--    order; only one union branch is appended.
-- ---------------------------------------------------------------------------
create or replace view public.finance_reconciliation_flags
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

  union all

  -- jev_possible_duplicate (high when Jev flagged it or the CEO confirmed the
  -- same purchase, else medium): two phiếu of one supplier that Jev thinks may
  -- be the same purchase but which sit on different POs. Disappears when the
  -- CEO decides different_purchase; auto_clear rows are never shown.
  select
    'jev_possible_duplicate:' || c.pair_key as flag_key,
    'jev_possible_duplicate'::text as label,
    case
      when c.status = 'auto_flag' or c.review_decision = 'same_purchase' then 'high'::text
      else 'medium'::text
    end as priority,
    'finance'::text as category,
    'payment_request'::text as entity_type,
    c.pr_newer as entity_id,
    prn.request_number as entity_ref,
    c.supplier_id as supplier_id,
    s.name as supplier_name,
    'supplier:' || coalesce(c.supplier_id::text, '') as group_key,
    c.amount_newer as amount,
    jsonb_build_object(
      'older_request', pro.request_number,
      'newer_request', prn.request_number,
      'p_same', c.p_same,
      'relation', c.relation,
      'days_apart', c.days_apart,
      'amount_older', c.amount_older,
      'amount_newer', c.amount_newer,
      'status', c.status
    ) as evidence,
    now() as detected_at
  from public.finance_jev_duplicate_checks c
  join public.payment_requests pro on pro.id = c.pr_older
  join public.payment_requests prn on prn.id = c.pr_newer
  left join public.suppliers s on s.id = c.supplier_id
  where c.status in ('auto_flag', 'needs_review')
    and c.review_decision is distinct from 'different_purchase'
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
