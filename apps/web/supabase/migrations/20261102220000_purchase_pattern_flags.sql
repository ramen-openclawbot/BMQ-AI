-- Reconciliation flags: purchase-pattern anomalies on pending payment requests.
--
-- Four new labels on phiếu still waiting for approval (status 'pending'):
--   price_above_usual      unit price >= 1.15x the median of >= 3 earlier lines
--                          of the same item and unit (high from 1.25x)
--   quantity_above_usual   quantity >= 2x the median of >= 3 earlier lines of
--                          the same item and unit (high from 3x)
--   ordered_before_cycle   the item is bought every >= 7 days (median gap over
--                          >= 4 distinct earlier days) and this phiếu comes
--                          before half of that gap; daily goods such as bread
--                          are batched into phiếu and would only add noise
--   new_supplier_for_item  >= 2 earlier lines from other suppliers and none
--                          from this supplier
-- History = non-rejected phiếu lines created earlier, within 365 days.
--
-- The baselines are computed in a SECURITY DEFINER function, not inside the
-- security_invoker view: under the payment_requests RLS policy the planner
-- turned the self-joins into nested loops (24 s for one phiếu in a rollback
-- test as the owner, against 30 ms before). The function checks the same
-- predicate as that policy (owner or payment_requests view permission) once
-- and returns nothing otherwise; the view only appends its rows. Every
-- existing branch of the view is copied verbatim from
-- 20261012140000_receipt_status_labels_and_po_cancel_receipts.sql.

create or replace function public.finance_purchase_pattern_flag_rows()
returns table (
  flag_key text,
  label text,
  priority text,
  category text,
  entity_type text,
  entity_id uuid,
  entity_ref text,
  supplier_id uuid,
  supplier_name text,
  group_key text,
  amount numeric,
  evidence jsonb,
  detected_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or (
      v_uid is not null
      and (
        public.has_role(v_uid, 'owner'::app_role)
        or public.has_module_permission(v_uid, 'payment_requests'::text, 'view'::text)
      )
    )
  ) then
    return;
  end if;

  return query
  with
  -- One row per non-rejected payment-request line. normalize_stock_item_name is
  -- evaluated once per row in the inner select; the outer filter only reads the
  -- computed item_key.
  pattern_lines as materialized (
    select
      x.line_id,
      x.payment_request_id,
      x.request_number,
      x.supplier_id,
      x.purchase_order_id,
      x.total_amount,
      x.created_at,
      x.buy_day,
      x.item_key,
      x.unit_key,
      x.product_name,
      x.unit,
      x.quantity,
      x.unit_price
    from (
      select
        i.id as line_id,
        pr.id as payment_request_id,
        pr.request_number,
        pr.supplier_id,
        pr.purchase_order_id,
        pr.total_amount,
        pr.created_at,
        (pr.created_at at time zone 'Asia/Ho_Chi_Minh')::date as buy_day,
        public.normalize_stock_item_name(i.product_name) as item_key,
        lower(btrim(coalesce(i.unit, ''))) as unit_key,
        i.product_name,
        i.unit,
        coalesce(i.quantity, 0) as quantity,
        coalesce(i.unit_price, 0) as unit_price
      from public.payment_request_items i
      join public.payment_requests pr on pr.id = i.payment_request_id
      where pr.status::text <> 'rejected'
        and coalesce(i.quantity, 0) > 0
        and coalesce(i.unit_price, 0) > 0
    ) x
    where x.item_key is not null
      and btrim(x.item_key) <> ''
  ),
  current_lines as (
    select pl.*
    from pattern_lines pl
    join public.payment_requests pr on pr.id = pl.payment_request_id
    where pr.status::text = 'pending'
  ),
  -- Price baseline: same item_key + unit_key, different PR, strictly earlier and
  -- within 365 days before the current line.
  price_baseline as (
    select
      c.line_id,
      count(*) as prior_count,
      (percentile_cont(0.5) within group (order by h.unit_price))::numeric as usual_unit_price
    from current_lines c
    join pattern_lines h
      on h.item_key = c.item_key
     and h.unit_key = c.unit_key
     and h.payment_request_id <> c.payment_request_id
     and h.created_at < c.created_at
     and h.created_at >= c.created_at - interval '365 days'
    group by c.line_id
    having count(*) >= 3
  ),
  -- Quantity baseline: same item_key + unit_key, different PR, strictly earlier
  -- and within 365 days before the current line.
  quantity_baseline as (
    select
      c.line_id,
      count(*) as prior_count,
      (percentile_cont(0.5) within group (order by h.quantity))::numeric as usual_quantity
    from current_lines c
    join pattern_lines h
      on h.item_key = c.item_key
     and h.unit_key = c.unit_key
     and h.payment_request_id <> c.payment_request_id
     and h.created_at < c.created_at
     and h.created_at >= c.created_at - interval '365 days'
    group by c.line_id
    having count(*) >= 3
  ),
  -- Cycle baseline: distinct history buy days for this item_key (any unit).
  history_days as (
    select distinct
      c.line_id as current_line_id,
      h.buy_day as history_day
    from current_lines c
    join pattern_lines h
      on h.item_key = c.item_key
     and h.payment_request_id <> c.payment_request_id
     and h.created_at < c.created_at
     and h.created_at >= c.created_at - interval '365 days'
  ),
  history_day_gaps as (
    select
      current_line_id,
      history_day,
      history_day - lag(history_day) over (
        partition by current_line_id order by history_day
      ) as gap_days
    from history_days
  ),
  cycle_baseline as (
    select
      current_line_id,
      count(*) as prior_count,
      max(history_day) as last_history_day,
      (percentile_cont(0.5) within group (order by gap_days))::numeric as median_gap
    from history_day_gaps
    group by current_line_id
    having count(*) >= 4
  ),
  latest_history_line as (
    select current_line_id, request_number as last_request_number
    from (
      select
        c.line_id as current_line_id,
        h.request_number,
        row_number() over (
          partition by c.line_id order by h.created_at desc, h.request_number desc
        ) as rn
      from current_lines c
      join pattern_lines h
        on h.item_key = c.item_key
       and h.payment_request_id <> c.payment_request_id
       and h.created_at < c.created_at
       and h.created_at >= c.created_at - interval '365 days'
    ) x
    where x.rn = 1
  ),
  -- New supplier: at least 2 earlier lines of this item_key from other suppliers
  -- in the last 365 days, and no earlier line (any age) from the current supplier.
  new_supplier_history as (
    select
      c.line_id,
      count(*) as prior_count
    from current_lines c
    join pattern_lines h
      on h.item_key = c.item_key
     and h.payment_request_id <> c.payment_request_id
     and h.created_at < c.created_at
     and h.created_at >= c.created_at - interval '365 days'
    where c.supplier_id is not null
      and h.supplier_id is not null
      and h.supplier_id <> c.supplier_id
    group by c.line_id
    having count(*) >= 2
  ),
  earlier_supplier_lines as (
    select distinct c.line_id
    from current_lines c
    join pattern_lines h
      on h.item_key = c.item_key
     and h.supplier_id = c.supplier_id
     and h.payment_request_id <> c.payment_request_id
     and h.created_at < c.created_at
    where c.supplier_id is not null
  ),
  new_supplier_baseline as (
    select nsh.line_id, nsh.prior_count
    from new_supplier_history nsh
    left join earlier_supplier_lines esl on esl.line_id = nsh.line_id
    where esl.line_id is null
  ),
  usual_suppliers as (
    select
      x.line_id,
      jsonb_agg(x.name order by x.name) as names
    from (
      select line_id, name
      from (
        select
          c.line_id,
          s.name,
          row_number() over (
            partition by c.line_id order by count(*) desc, s.name
          ) as rn
        from current_lines c
        join pattern_lines h
          on h.item_key = c.item_key
         and h.payment_request_id <> c.payment_request_id
         and h.created_at < c.created_at
         and h.created_at >= c.created_at - interval '365 days'
        join public.suppliers s on s.id = h.supplier_id
        where c.supplier_id is not null
          and h.supplier_id is not null
          and h.supplier_id <> c.supplier_id
          and s.name is not null
        group by c.line_id, s.name
      ) ranked
      where rn <= 3
    ) x
    group by x.line_id
  ),
  line_flags as (
    select
      c.payment_request_id,
      c.request_number,
      c.supplier_id,
      c.purchase_order_id,
      c.total_amount,
      'price_above_usual'::text as label,
      case when c.unit_price >= 1.25 * pb.usual_unit_price then 1 else 2 end as severity_rank,
      jsonb_build_object(
        'product_name', c.product_name,
        'unit', c.unit,
        'quantity', c.quantity,
        'unit_price', c.unit_price,
        'prior_count', pb.prior_count,
        'ratio', round(c.unit_price / nullif(pb.usual_unit_price, 0), 2),
        'usual_unit_price', pb.usual_unit_price
      ) as line_evidence,
      round(c.unit_price / nullif(pb.usual_unit_price, 0), 4) as sort_ratio
    from current_lines c
    join price_baseline pb on pb.line_id = c.line_id
    where pb.usual_unit_price > 0
      and c.unit_price >= 1.15 * pb.usual_unit_price

    union all

    select
      c.payment_request_id,
      c.request_number,
      c.supplier_id,
      c.purchase_order_id,
      c.total_amount,
      'quantity_above_usual'::text,
      case when c.quantity >= 3 * qb.usual_quantity then 1 else 2 end,
      jsonb_build_object(
        'product_name', c.product_name,
        'unit', c.unit,
        'quantity', c.quantity,
        'unit_price', c.unit_price,
        'prior_count', qb.prior_count,
        'ratio', round(c.quantity / nullif(qb.usual_quantity, 0), 2),
        'usual_quantity', qb.usual_quantity
      ),
      round(c.quantity / nullif(qb.usual_quantity, 0), 4)
    from current_lines c
    join quantity_baseline qb on qb.line_id = c.line_id
    where qb.usual_quantity > 0
      and c.quantity >= 2 * qb.usual_quantity

    union all

    select
      c.payment_request_id,
      c.request_number,
      c.supplier_id,
      c.purchase_order_id,
      c.total_amount,
      'ordered_before_cycle'::text,
      2,
      jsonb_build_object(
        'product_name', c.product_name,
        'unit', c.unit,
        'quantity', c.quantity,
        'unit_price', c.unit_price,
        'prior_count', cb.prior_count,
        'ratio', case
          when cb.median_gap > 0 then round((c.buy_day - cb.last_history_day)::numeric / cb.median_gap, 2)
          else null
        end,
        'median_gap_days', cb.median_gap,
        'days_since_last', c.buy_day - cb.last_history_day,
        'last_request_number', lhl.last_request_number
      ),
      case
        when cb.median_gap > 0 then round((c.buy_day - cb.last_history_day)::numeric / cb.median_gap, 4)
        else 0::numeric
      end
    from current_lines c
    join cycle_baseline cb on cb.current_line_id = c.line_id
    join latest_history_line lhl on lhl.current_line_id = c.line_id
    where cb.median_gap >= 7
      and (c.buy_day - cb.last_history_day) < 0.5 * cb.median_gap

    union all

    select
      c.payment_request_id,
      c.request_number,
      c.supplier_id,
      c.purchase_order_id,
      c.total_amount,
      'new_supplier_for_item'::text,
      2,
      jsonb_build_object(
        'product_name', c.product_name,
        'unit', c.unit,
        'quantity', c.quantity,
        'unit_price', c.unit_price,
        'prior_count', nsb.prior_count,
        'ratio', null::numeric,
        'usual_suppliers', coalesce(us.names, '[]'::jsonb)
      ),
      0::numeric
    from current_lines c
    join new_supplier_baseline nsb on nsb.line_id = c.line_id
    left join usual_suppliers us on us.line_id = c.line_id
    where c.supplier_id is not null
  ),
  ranked_line_flags as (
    select
      lf.*,
      row_number() over (
        partition by lf.payment_request_id, lf.label
        order by lf.severity_rank asc, lf.sort_ratio desc, lf.line_evidence ->> 'product_name'
      ) as rn
    from line_flags lf
  ),
  -- One row per payment request per label. Keep at most five lines, most severe
  -- first. severity_rank 1 = high, 2 = medium.
  pattern_flags as (
    select
      payment_request_id,
      request_number,
      supplier_id,
      purchase_order_id,
      total_amount,
      label,
      min(severity_rank) as severity_rank,
      jsonb_agg(
        line_evidence
        order by severity_rank asc, sort_ratio desc, line_evidence ->> 'product_name'
      ) as lines
    from ranked_line_flags
    where rn <= 5
    group by
      payment_request_id,
      request_number,
      supplier_id,
      purchase_order_id,
      total_amount,
      label
  )

  select
    (pf.label || ':' || pf.payment_request_id::text)::text,
    pf.label::text,
    (case when pf.severity_rank = 1 then 'high' else 'medium' end)::text,
    'finance'::text,
    'payment_request'::text,
    pf.payment_request_id,
    pf.request_number::text,
    pf.supplier_id,
    s.name::text,
    (case
      when pf.purchase_order_id is not null then 'po:' || pf.purchase_order_id::text
      else 'supplier:' || coalesce(pf.supplier_id::text, '')
    end)::text,
    coalesce(pf.total_amount, 0)::numeric,
    jsonb_build_object(
      'request_number', pf.request_number,
      'lines', pf.lines
    ),
    now()
  from pattern_flags pf
  left join public.suppliers s on s.id = pf.supplier_id;
end;
$$;

revoke all on function public.finance_purchase_pattern_flag_rows() from public, anon;
grant execute on function public.finance_purchase_pattern_flag_rows() to authenticated, service_role;

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

  union all

  -- price_above_usual / quantity_above_usual / ordered_before_cycle /
  -- new_supplier_for_item: purchase-pattern anomalies on pending phiếu,
  -- computed by public.finance_purchase_pattern_flag_rows().
  select
    pp.flag_key,
    pp.label,
    pp.priority,
    pp.category,
    pp.entity_type,
    pp.entity_id,
    pp.entity_ref,
    pp.supplier_id,
    pp.supplier_name,
    pp.group_key,
    pp.amount,
    pp.evidence,
    pp.detected_at
  from public.finance_purchase_pattern_flag_rows() pp
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
