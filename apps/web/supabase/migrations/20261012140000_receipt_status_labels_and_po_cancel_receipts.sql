-- Sửa nhãn đối soát theo trạng thái phiếu nhập + dọn phiếu nhập trống khi hủy PO.
--
-- This migration is additive and never rewrites existing business data by itself:
--   (1) public.reject_payment_requests_on_po_cancel() is redefined so that,
--       before a PO is cancelled, a PO whose goods receipt was actually received
--       (status 'received'), or finalized (finalized_at not null), or has a line
--       with quantity / actual_quantity > 0, or already has a
--       goods_receipt_auto_issues row, is refused with the error code
--       'po_cancel_has_receipt'. Otherwise, after the PO's payment requests are
--       rejected as before, the remaining empty placeholder receipts of that PO
--       are removed (references first, then goods_receipt_items, then
--       goods_receipts). The existing 'po_cancel_has_payments' guard keeps
--       running first, unchanged.
--   (2) The reconciliation view public.finance_reconciliation_flags keeps every
--       label and column exactly as before except two branches:
--         * receipt_confirmed_delivery_pending only fires when the linked goods
--           receipt status is 'received' (đã nhập kho) while the phiếu still
--           says delivery pending;
--         * paid_without_receipt also fires when a linked goods receipt exists
--           but is not 'received', not only when goods_receipt_id is null.
--       The Jev duplicate branch (including the rejected-phiếu exclusion) is
--       copied verbatim.
--   (3) public.cleanup_cancelled_po_placeholder_receipts(p_dry_run boolean) is
--       added (owner-only, SECURITY DEFINER). It reports / removes the empty
--       placeholder receipts left behind on cancelled POs by older data.
--
-- Removing a placeholder receipt does not fire the goods receipt Zalo enqueue
-- trigger (trg_finance_zalo_goods_receipt is AFTER UPDATE OF status) nor the
-- auto issue trigger (auto_issue_goods_receipt_on_received is AFTER UPDATE OF
-- status), because both are UPDATE-only and the code performs DELETE. The
-- deletion is guarded by the emptiness conditions below, so no received /
-- finalized / positive-quantity / auto-issued receipt is ever deleted.

-- ---------------------------------------------------------------------------
-- 1. Hủy PO: chặn nếu hàng đã nhập, ngược lại gỡ phiếu nhập trống.
-- ---------------------------------------------------------------------------
create or replace function public.reject_payment_requests_on_po_cancel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paid text;
  v_blocked_receipts text;
  v_placeholder_ids uuid[];
begin
  if new.status::text = 'cancelled' and old.status::text is distinct from 'cancelled' then
    -- (1) Refuse the cancel when the PO's non-rejected payment requests already
    -- have money leaving. Unchanged from the previous definition.
    select string_agg(pr.request_number, ', ' order by pr.request_number)
      into v_paid
    from public.payment_requests pr
    where pr.purchase_order_id = new.id
      and pr.status::text <> 'rejected'
      and (
        pr.payment_status::text <> 'unpaid'
        or exists (select 1 from public.payment_allocations a where a.payment_request_id = pr.id)
      );
    if v_paid is not null then
      raise exception 'po_cancel_has_payments: Không hủy được PO %: phiếu chi % đã có tiền chi. Xử lý phiếu chi trước.',
        coalesce(new.po_number, new.id::text), v_paid
        using errcode = 'P0001';
    end if;

    -- (2) Refuse the cancel when any goods receipt of the PO is no longer an
    -- empty placeholder: received, finalized, carrying quantity, auto-issued,
    -- or already referenced by supplier unit-scan evidence.
    select string_agg(gr.receipt_number, ', ' order by gr.receipt_number)
      into v_blocked_receipts
    from public.goods_receipts gr
    where gr.purchase_order_id = new.id
      and (
        gr.status::text = 'received'
        or gr.finalized_at is not null
        or exists (
          select 1
          from public.goods_receipt_items gri
          where gri.goods_receipt_id = gr.id
            and greatest(0, coalesce(gri.actual_quantity, gri.quantity, 0)) > 0
        )
        or exists (
          select 1
          from public.goods_receipt_auto_issues ai
          where ai.goods_receipt_id = gr.id
        )
        or exists (
          select 1
          from public.material_supplier_unit_scan_evidence e
          where e.goods_receipt_id = gr.id
        )
      );
    if v_blocked_receipts is not null then
      raise exception 'po_cancel_has_receipt: Không hủy được PO %: phiếu nhập % đã có hàng nhập kho. Xử lý phiếu nhập trước.',
        coalesce(new.po_number, new.id::text), v_blocked_receipts
        using errcode = 'P0001';
    end if;

    -- (3) Reject the still-open payment requests, exactly as before.
    update public.payment_requests
    set status = 'rejected'::payment_request_status,
        rejection_reason = 'PO ' || coalesce(new.po_number, new.id::text) || ' đã hủy',
        approved_by = null,
        approved_at = now(),
        updated_at = now()
    where purchase_order_id = new.id
      and status::text <> 'rejected';

    -- (4) Remove the empty placeholder receipts of that PO. Collect them under
    -- the emptiness conditions first, then clear every reference and delete.
    select array_agg(gr.id)
      into v_placeholder_ids
    from public.goods_receipts gr
    where gr.purchase_order_id = new.id
      and gr.status::text <> 'received'
      and gr.finalized_at is null
      and not exists (
        select 1
        from public.goods_receipt_items gri
        where gri.goods_receipt_id = gr.id
          and greatest(0, coalesce(gri.actual_quantity, gri.quantity, 0)) > 0
      )
      and not exists (
        select 1
        from public.goods_receipt_auto_issues ai
        where ai.goods_receipt_id = gr.id
      )
      and not exists (
        select 1
        from public.material_supplier_unit_scan_evidence e
        where e.goods_receipt_id = gr.id
      );

    if v_placeholder_ids is not null then
      update public.payment_requests
      set goods_receipt_id = null
      where goods_receipt_id = any(v_placeholder_ids);

      update public.invoices
      set goods_receipt_id = null
      where goods_receipt_id = any(v_placeholder_ids);

      update public.inventory_batches
      set goods_receipt_id = null
      where goods_receipt_id = any(v_placeholder_ids);

      delete from public.goods_receipt_items
      where goods_receipt_id = any(v_placeholder_ids);

      delete from public.goods_receipts
      where id = any(v_placeholder_ids);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.reject_payment_requests_on_po_cancel() from public, anon, authenticated;

drop trigger if exists trg_reject_payment_requests_on_po_cancel on public.purchase_orders;
create trigger trg_reject_payment_requests_on_po_cancel
after update of status on public.purchase_orders
for each row execute function public.reject_payment_requests_on_po_cancel();

-- ---------------------------------------------------------------------------
-- 2. Reconciliation flag view: status-aware receipt labels.
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

  -- paid_without_receipt (medium): requires a receipt, already paid, open more
  -- than 7 days, and either there is no goods receipt at all or the linked one
  -- is not yet 'received' (đã nhập kho).
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
  left join public.goods_receipts gr on gr.id = pr.goods_receipt_id
  left join public.suppliers s on s.id = pr.supplier_id
  where pr.requires_receipt = true
    and pr.payment_status::text in ('paid', 'overpaid')
    and (pr.goods_receipt_id is null or gr.status::text <> 'received')
    and pr.created_at < now() - interval '7 days'

  union all

  -- receipt_confirmed_delivery_pending (low): linked goods receipt is received
  -- (đã nhập kho) but the phiếu still says pending delivery.
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
  where gr.status::text = 'received'
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
    -- A pair whose phiếu was rejected (for example its PO was cancelled) is no longer a risk.
    and pro.status::text <> 'rejected'
    and prn.status::text <> 'rejected'
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

-- ---------------------------------------------------------------------------
-- 3. Owner-only cleanup of empty placeholder receipts on cancelled POs.
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_cancelled_po_placeholder_receipts(
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_eligible jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_ids uuid[] := '{}'::uuid[];
  r record;
begin
  -- Owner-only, same authority pattern as public.allow_purchase_order_overpay
  -- and public.review_finance_reconciliation_flag.
  if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  for r in
    select gr.id, gr.receipt_number, po.po_number,
           (
             gr.status::text <> 'received'
             and gr.finalized_at is null
             and not exists (
               select 1
               from public.goods_receipt_items gri
               where gri.goods_receipt_id = gr.id
                 and greatest(0, coalesce(gri.actual_quantity, gri.quantity, 0)) > 0
             )
             and not exists (
               select 1
               from public.goods_receipt_auto_issues ai
               where ai.goods_receipt_id = gr.id
             )
             and not exists (
               select 1
               from public.material_supplier_unit_scan_evidence e
               where e.goods_receipt_id = gr.id
             )
           ) as is_empty
    from public.goods_receipts gr
    join public.purchase_orders po on po.id = gr.purchase_order_id
    where po.status::text = 'cancelled'
    order by gr.receipt_number
  loop
    if r.is_empty then
      v_eligible := v_eligible || jsonb_build_object(
        'receipt_number', r.receipt_number,
        'po_number', r.po_number
      );
      v_ids := array_append(v_ids, r.id);
    else
      v_skipped := v_skipped || jsonb_build_object(
        'receipt_number', r.receipt_number,
        'reason', 'not_empty'
      );
    end if;
  end loop;

  if p_dry_run then
    return jsonb_build_object('eligible', v_eligible, 'skipped', v_skipped);
  end if;

  if array_length(v_ids, 1) is not null then
    update public.payment_requests
    set goods_receipt_id = null
    where goods_receipt_id = any(v_ids);

    update public.invoices
    set goods_receipt_id = null
    where goods_receipt_id = any(v_ids);

    update public.inventory_batches
    set goods_receipt_id = null
    where goods_receipt_id = any(v_ids);

    delete from public.goods_receipt_items
    where goods_receipt_id = any(v_ids);

    delete from public.goods_receipts
    where id = any(v_ids);
  end if;

  return jsonb_build_object('removed', v_eligible, 'skipped', v_skipped);
end;
$$;

revoke all on function public.cleanup_cancelled_po_placeholder_receipts(boolean) from public, anon;
grant execute on function public.cleanup_cancelled_po_placeholder_receipts(boolean) to authenticated, service_role;

comment on function public.cleanup_cancelled_po_placeholder_receipts(boolean) is
  'Owner-only RPC: dry-run or remove the empty placeholder goods receipts left on cancelled POs (status <> received, not finalized, no positive line quantity/actual_quantity, no auto issue, no scan evidence). Returns {eligible|removed, skipped}.';
