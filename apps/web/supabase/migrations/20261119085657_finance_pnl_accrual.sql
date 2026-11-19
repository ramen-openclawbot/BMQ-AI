-- BMQ finance module, accrual P&L phase 1 (server-side).
--
-- One read-only JSON RPC, public.finance_pnl_accrual(p_month date), returns a
-- single-month P&L on an accrual basis:
--   * revenue is exactly the revenue source used by finance_month_lines;
--   * purchases are accrued on goods_receipts.receipt_date, one row per receipt,
--     using the linked approved or pending payment request items when present,
--     or the received item quantity * unit price and canonical-material
--     category only when there is no payment request at all;
--   * approved payment requests without a goods receipt keep the current
--     request-month basis;
--   * BMQ - HKD Tuyết Anh bread is valued from sent production_bread_order
--     notifications (billable que quantity and VietJet quantity) at the latest
--     non-rejected supplier unit price (approved before pending), with Tuyết
--     Anh payment-request lines removed to prevent double counting;
--   * payroll is taken from the month's payroll_bn_payslips plus non-cancelled
--     salary payout families; missing prior-month payslip groups and payout
--     families are accrued with PAYROLL payroll_last_month, excluding amounts
--     already covered by the current payslips;
--   * RENT / ELECTRICITY / GAS / TELECOM / SOCIAL_INS are accrued from the
--     trailing three-month average when the month has no actual booking.
--
-- Inventory differences are deliberately not deducted in phase 1. This file
-- only creates read-only functions. It never writes a business table.

-- ===========================================================================
-- 1. Private label helper (same English leaves as finance_pnl)
-- ===========================================================================

create or replace function public.finance_pnl_accrual_label(p_code text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case p_code
    when 'A1_BREAD_BOUGHT' then 'Bread purchased (finished)'
    when 'A2_MEAT_OFFAL' then 'Meat & offal'
    when 'A3_FLOSS_FILLING' then 'Pork floss & fillings'
    when 'A4_DAIRY_EGG' then 'Dairy, butter & eggs'
    when 'A5_DRY_SPICE' then 'Dry goods & spices'
    when 'A6_FRESH_PRODUCE' then 'Fresh produce'
    when 'A7_PACKAGING' then 'Packaging & labels'
    when 'B1_DELIVERY' then 'Delivery'
    when 'B2_KIOSK_RENT' then 'Kiosk rent'
    when 'B3_MARKETING' then 'Marketing'
    when 'B4_PLATFORM_FEE' then 'Platform fees'
    when 'C1_WAREHOUSE_RENT' then 'Warehouse & kitchen rent'
    when 'C2_ELECTRICITY' then 'Electricity'
    when 'C3_WATER_WASTE' then 'Water & waste'
    when 'C4_GAS' then 'Gas'
    when 'C5_TELECOM' then 'Internet & phone'
    when 'C6_PAYROLL' then 'Payroll'
    when 'C7_SOCIAL_INSURANCE' then 'Social insurance'
    when 'C8_REPAIR' then 'Repairs & maintenance'
    when 'C9_TOOLS_CLEANING' then 'Tools & cleaning'
    when 'C10_ONE_OFF' then 'One-off & relocation'
    when 'C11_BANK_TAX_OTHER' then 'Bank fees, tax & other'
    when 'D1_CONSTRUCTION' then 'Construction & fit-out'
    when 'D2_EQUIPMENT' then 'Equipment'
    when 'UNMAPPED_REVIEW' then 'Unclassified — review required'
    when 'COGS_BMQ_BREAD' then 'Legacy — Bread COGS'
    when 'COGS_SWEET_KITCHEN' then 'Legacy — Sweet kitchen COGS'
    when 'PACKAGING_SALES' then 'Legacy — Packaging'
    when 'OPEX_GENERAL' then 'Legacy — Operating expenses'
    when 'KITCHEN_SUPPLY_REPAIR' then 'Legacy — Kitchen supplies & repairs'
    when 'CAPEX_ASSET_PROJECT' then 'Legacy — Capex'
    else 'Unclassified — ' || coalesce(p_code, '(no category)')
  end;
$$;

revoke all on function public.finance_pnl_accrual_label(text) from public, anon, authenticated;

-- Stable family key for salary payout period names. It removes Txx/yyyy and
-- "tháng xx/yyyy", lowercases, strips punctuation/underscores and the trailing
-- "unc", and collapses whitespace. Examples:
--   "Lương BH, GH T09/2026" -> "lương bh gh"
--   "Lương lẻ T09/2026_Bếp Tân Tạo_UNC" -> "lương lẻ bếp tân tạo"
create or replace function public.finance_pnl_accrual_payroll_family(p_name text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    nullif(
      btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                lower(coalesce(p_name, '')),
                '(T|tháng)[[:space:]]*[0-9]{1,2}[[:space:]]*/[[:space:]]*[0-9]{4}',
                ' ',
                'gi'
              ),
              '[^[:alnum:][:space:]]+',
              ' ',
              'g'
            ),
            '[[:space:]]+',
            ' ',
            'g'
          ),
          '[[:space:]]+unc$',
          '',
          'g'
        )
      ),
      ''
    ),
    '(no family)'
  );
$$;

revoke all on function public.finance_pnl_accrual_payroll_family(text) from public, anon, authenticated;

-- ===========================================================================
-- 2. Private purchase accrual source
-- ===========================================================================
-- Every goods receipt dated in the range is counted once. A rejected linked
-- payment request removes the receipt. A receipt linked to an approved or a
-- pending payment request uses that request's items and classifications
-- (approved first, then pending); only a receipt with no payment request at all
-- falls back to the received quantity, unit price and canonical-material
-- category. Approved requests without any receipt are dated by the request
-- month. Tuyết Anh payment-request/receipt rows are excluded here and replaced
-- by the production_bread_order block so the bread cost is not counted twice.

create or replace function public.finance_pnl_accrual_purchase_lines(p_from date, p_to date)
returns table (
  month date,
  section text,
  line_code text,
  line_label_en text,
  product_line text,
  counterparty text,
  amount numeric,
  source text,
  source_ref text,
  source_id text,
  source_line_id text,
  is_estimate boolean,
  note text,
  quantity numeric,
  unit_price numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
  rejected_receipts as (
    select distinct gr.id
    from public.goods_receipts gr
    join public.payment_requests pr
      on (pr.id = gr.payment_request_id or pr.goods_receipt_id = gr.id)
    where gr.receipt_date between p_from and p_to
      and pr.status::text = 'rejected'
  ),
  receipt_base as (
    select
      gr.id as receipt_id,
      gr.receipt_number,
      gr.receipt_date,
      gr.payment_request_id,
      gr.purchase_order_id,
      gr.supplier_id,
      coalesce(s.name, '(no supplier)') as supplier_name,
      (coalesce(s.name, '') ~* 'tuy[ếệe]t[[:space:]]*anh') as is_tuyet_anh
    from public.goods_receipts gr
    left join public.suppliers s on s.id = gr.supplier_id
    where gr.receipt_date between p_from and p_to
      and not exists (
        select 1 from rejected_receipts rr where rr.id = gr.id
      )
  ),
  receipt_links as (
    select
      rb.*,
      pr.id as pr_id,
      pr.request_number,
      pr.status::text as pr_status,
      (coalesce(pr_s.name, '') ~* 'tuy[ếệe]t[[:space:]]*anh') as pr_is_tuyet_anh
    from receipt_base rb
    left join lateral (
      select pr.id, pr.request_number, pr.supplier_id, pr.status
      from public.payment_requests pr
      where pr.status::text in ('approved', 'pending')
        and (pr.id = rb.payment_request_id or pr.goods_receipt_id = rb.receipt_id)
      order by
        case pr.status::text when 'approved' then 0 when 'pending' then 1 else 2 end,
        (pr.id = rb.payment_request_id) desc,
        pr.created_at desc
      limit 1
    ) pr on true
    left join public.suppliers pr_s on pr_s.id = pr.supplier_id
  ),
  receipt_pr_lines as (
    select
      date_trunc('month', rl.receipt_date)::date as month,
      case
        when d.category_code = 'UNMAPPED_REVIEW'
          or coalesce(cc.is_active, false) = false
          or parent.code is null then 'unclassified'
        when parent.code = 'A_COGS' then 'cogs'
        when parent.code = 'B_SELLING' then 'selling'
        when parent.code = 'C_OPERATING' then 'operating'
        when parent.code = 'D_INVESTMENT' then 'capex'
        else 'unclassified'
      end as section,
      d.category_code as line_code,
      public.finance_pnl_accrual_label(d.category_code) as line_label_en,
      d.product_line,
      rl.supplier_name as counterparty,
      d.amount,
      'goods_receipt'::text as source,
      rl.receipt_number as source_ref,
      rl.receipt_id::text as source_id,
      d.item_id::text as source_line_id,
      false as is_estimate,
      case
        when rl.pr_status = 'pending' then
          'Accrued on receipt date from pending payment request ' || rl.request_number
        else
          'Accrued on receipt date from approved payment request ' || rl.request_number
      end as note,
      d.quantity,
      d.unit_price
    from receipt_links rl
    join lateral (
      select
        pri.id as item_id,
        coalesce(pri.line_total, pri.quantity * pri.unit_price, 0)::numeric as amount,
        pri.quantity::numeric as quantity,
        pri.unit_price::numeric as unit_price,
        coalesce(clc.category_code, pri.cost_category_code, 'UNMAPPED_REVIEW') as category_code,
        coalesce(clc.product_line, pri.cost_product_line, 'shared') as product_line
      from public.payment_request_items pri
      left join public.cost_line_classifications clc
        on clc.source_type = 'payment_request_item'
        and clc.source_line_id = pri.id
      where pri.payment_request_id = rl.pr_id
        and coalesce(pri.line_total, pri.quantity * pri.unit_price, 0) <> 0
    ) d on true
    left join public.cost_categories cc on cc.code = d.category_code
    left join public.cost_categories parent on parent.code = cc.parent_code
    where rl.pr_id is not null
      and not rl.is_tuyet_anh
      and not coalesce(rl.pr_is_tuyet_anh, false)
  ),
  receipt_direct_lines as (
    select
      date_trunc('month', rl.receipt_date)::date as month,
      case
        when d.category_code = 'UNMAPPED_REVIEW'
          or coalesce(cc.is_active, false) = false
          or parent.code is null then 'unclassified'
        when parent.code = 'A_COGS' then 'cogs'
        when parent.code = 'B_SELLING' then 'selling'
        when parent.code = 'C_OPERATING' then 'operating'
        when parent.code = 'D_INVESTMENT' then 'capex'
        else 'unclassified'
      end as section,
      d.category_code as line_code,
      public.finance_pnl_accrual_label(d.category_code) as line_label_en,
      coalesce(cam.product_line, cc.product_line, 'shared') as product_line,
      rl.supplier_name as counterparty,
      (d.quantity * d.unit_price)::numeric as amount,
      'goods_receipt'::text as source,
      rl.receipt_number as source_ref,
      rl.receipt_id::text as source_id,
      gri.id::text as source_line_id,
      false as is_estimate,
      'Accrued on receipt date from goods_receipt_items (no payment request)' as note,
      d.quantity,
      d.unit_price
    from receipt_links rl
    join public.goods_receipt_items gri on gri.goods_receipt_id = rl.receipt_id
    left join public.sku_cogs_materials scm on scm.id = gri.canonical_material_id
    left join public.product_skus ps on ps.id = gri.sku_id
    left join public.cost_categories scm_cc on scm_cc.code = scm.category
    left join public.cost_categories ps_cc on ps_cc.code = ps.category
    left join lateral (
      select m.category_code, m.product_line
      from public.cost_item_alias_mappings m
      where m.active
        and m.mapping_status = 'approved'
        and m.source_name_key = coalesce(
          scm.normalized_name,
          public.normalize_ocr_cost_key(coalesce(gri.raw_product_name, gri.product_name))
        )
      order by m.effective_from desc nulls last, m.updated_at desc
      limit 1
    ) cam on true
    cross join lateral (
      select
        coalesce(
          cam.category_code,
          case scm.category
            when 'flour' then 'A5_DRY_SPICE'
            when 'sugar_additives' then 'A5_DRY_SPICE'
            when 'dairy_fat' then 'A4_DAIRY_EGG'
            when 'cheese' then 'A4_DAIRY_EGG'
            when 'meat_filling' then 'A2_MEAT_OFFAL'
            when 'vegetables' then 'A6_FRESH_PRODUCE'
            when 'supplies' then 'A7_PACKAGING'
            when 'service' then 'C9_TOOLS_CLEANING'
          end,
          scm_cc.code,
          ps_cc.code,
          'UNMAPPED_REVIEW'
        ) as category_code,
        coalesce(gri.actual_quantity, gri.quantity, 0)::numeric as quantity,
        coalesce(gri.unit_price, 0)::numeric as unit_price
    ) d
    left join public.cost_categories cc on cc.code = d.category_code
    left join public.cost_categories parent on parent.code = cc.parent_code
    where rl.pr_id is null
      and not rl.is_tuyet_anh
      and not coalesce(rl.pr_is_tuyet_anh, false)
      and d.quantity * d.unit_price <> 0
  ),
  bread_price_candidates as (
    select
      case
        when pri.product_name ~* 'lớn'
          or pri.product_name ~* 'vi[eệ]t[[:space:]]*jet'
          or pri.product_code = '40000294'
          or ps.sku_code = '40000294' then 'vietjet'
        when pri.product_name ~* 'que'
          or pri.product_name ~* 'tươi'
          or ps.sku_code = 'BMQ-001'
          or pri.product_code = 'BMQ-001' then 'que'
        else 'other'
      end as kind,
      pri.unit_price::numeric as unit_price,
      pr.request_number,
      pr.status::text as pr_status,
      case pr.status::text when 'approved' then 0 when 'pending' then 1 else 2 end as status_rank,
      pr.created_at as price_at,
      pri.created_at as line_at
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    join public.suppliers s on s.id = pr.supplier_id
    left join public.product_skus ps on ps.id = pri.sku_id
    where coalesce(s.name, '') ~* 'tuy[ếệe]t[[:space:]]*anh'
      and pr.status::text <> 'rejected'
      and coalesce(pri.unit_price, 0) > 0
      and (
        pri.product_name ~* '(que|lớn|tươi)'
        or pri.product_name ~* 'vi[eệ]t[[:space:]]*jet'
        or pri.product_code in ('40000294', 'BMQ-001')
        or ps.sku_code in ('40000294', 'BMQ-001')
      )
  ),
  latest_bread_prices as (
    select distinct on (kind) kind, unit_price, request_number, pr_status
    from bread_price_candidates
    where kind in ('que', 'vietjet')
    order by kind, status_rank, price_at desc nulls last, line_at desc
  ),
  bread_orders as (
    select
      n.id,
      n.digest_date,
      case
        when coalesce(n.source_snapshot #>> '{supplier,billable_quantity}', '')
          ~ '^[0-9]+([.][0-9]+)?$'
        then (n.source_snapshot #>> '{supplier,billable_quantity}')::numeric
        else 0
      end as que_quantity,
      case
        when coalesce(n.source_snapshot #>> '{vietjet,quantity}', '')
          ~ '^[0-9]+([.][0-9]+)?$'
        then (n.source_snapshot #>> '{vietjet,quantity}')::numeric
        else 0
      end as vietjet_quantity
    from public.dealer_order_notifications n
    where n.notification_type = 'production_bread_order'
      and n.status = 'sent'
      and n.digest_date between p_from and p_to
  ),
  bread_lines as (
    select
      date_trunc('month', bo.digest_date)::date as month,
      'cogs'::text as section,
      'A1_BREAD_BOUGHT'::text as line_code,
      public.finance_pnl_accrual_label('A1_BREAD_BOUGHT') as line_label_en,
      'bmq_bread'::text as product_line,
      'BMQ - HKD Tuyết Anh'::text as counterparty,
      (bo.que_quantity * coalesce(qp.unit_price, 0))::numeric as amount,
      'supplier_bread_order'::text as source,
      bo.id::text as source_ref,
      bo.id::text as source_id,
      bo.id::text || ':que' as source_line_id,
      false as is_estimate,
      ('Sent production_bread_order ' || bo.digest_date::text || ': '
        || bo.que_quantity::text || ' que at '
        || coalesce(qp.unit_price::text, '(missing price)')
        || ' from ' || coalesce(qp.request_number, '(no payment request)')
        || ' (' || coalesce(qp.pr_status, 'missing status') || ')') as note,
      bo.que_quantity as quantity,
      qp.unit_price
    from bread_orders bo
    left join latest_bread_prices qp on qp.kind = 'que'
    where bo.que_quantity <> 0

    union all

    select
      date_trunc('month', bo.digest_date)::date as month,
      'cogs'::text as section,
      'A1_BREAD_BOUGHT'::text as line_code,
      public.finance_pnl_accrual_label('A1_BREAD_BOUGHT') as line_label_en,
      'bmq_bread'::text as product_line,
      'BMQ - HKD Tuyết Anh'::text as counterparty,
      (bo.vietjet_quantity * coalesce(vp.unit_price, 0))::numeric as amount,
      'supplier_bread_order'::text as source,
      bo.id::text as source_ref,
      bo.id::text as source_id,
      bo.id::text || ':vietjet' as source_line_id,
      false as is_estimate,
      ('Sent production_bread_order ' || bo.digest_date::text || ': '
        || bo.vietjet_quantity::text || ' VietJet at '
        || coalesce(vp.unit_price::text, '(missing price)')
        || ' from ' || coalesce(vp.request_number, '(no payment request)')
        || ' (' || coalesce(vp.pr_status, 'missing status') || ')') as note,
      bo.vietjet_quantity as quantity,
      vp.unit_price
    from bread_orders bo
    left join latest_bread_prices vp on vp.kind = 'vietjet'
    where bo.vietjet_quantity <> 0
  ),
  request_base as (
    select
      pr.id,
      pr.request_number,
      pr.created_at,
      coalesce(s.name, '(no supplier)') as supplier_name,
      (coalesce(s.name, '') ~* 'tuy[ếệe]t[[:space:]]*anh') as is_tuyet_anh
    from public.payment_requests pr
    left join public.suppliers s on s.id = pr.supplier_id
    where pr.status::text = 'approved'
      and (pr.created_at at time zone 'Asia/Ho_Chi_Minh')::date between p_from and p_to
      and not exists (
        select 1
        from public.goods_receipts gr
        where gr.id = pr.goods_receipt_id
          or gr.payment_request_id = pr.id
          or (
            pr.goods_receipt_id is null
            and pr.purchase_order_id is not null
            and gr.purchase_order_id = pr.purchase_order_id
          )
      )
  ),
  request_lines as (
    select
      date_trunc('month', rb.created_at at time zone 'Asia/Ho_Chi_Minh')::date as month,
      case
        when d.category_code = 'UNMAPPED_REVIEW'
          or coalesce(cc.is_active, false) = false
          or parent.code is null then 'unclassified'
        when parent.code = 'A_COGS' then 'cogs'
        when parent.code = 'B_SELLING' then 'selling'
        when parent.code = 'C_OPERATING' then 'operating'
        when parent.code = 'D_INVESTMENT' then 'capex'
        else 'unclassified'
      end as section,
      d.category_code as line_code,
      public.finance_pnl_accrual_label(d.category_code) as line_label_en,
      d.product_line,
      rb.supplier_name as counterparty,
      d.amount,
      'approved_request_without_receipt'::text as source,
      rb.request_number as source_ref,
      rb.id::text as source_id,
      d.item_id::text as source_line_id,
      false as is_estimate,
      'Approved payment request without a linked goods receipt (request-month basis)' as note,
      d.quantity,
      d.unit_price
    from request_base rb
    join lateral (
      select
        pri.id as item_id,
        coalesce(pri.line_total, pri.quantity * pri.unit_price, 0)::numeric as amount,
        pri.quantity::numeric as quantity,
        pri.unit_price::numeric as unit_price,
        coalesce(clc.category_code, pri.cost_category_code, 'UNMAPPED_REVIEW') as category_code,
        coalesce(clc.product_line, pri.cost_product_line, 'shared') as product_line
      from public.payment_request_items pri
      left join public.cost_line_classifications clc
        on clc.source_type = 'payment_request_item'
        and clc.source_line_id = pri.id
      where pri.payment_request_id = rb.id
        and coalesce(pri.line_total, pri.quantity * pri.unit_price, 0) <> 0
    ) d on true
    left join public.cost_categories cc on cc.code = d.category_code
    left join public.cost_categories parent on parent.code = cc.parent_code
    where not rb.is_tuyet_anh
  )
  select * from receipt_pr_lines
  union all
  select * from receipt_direct_lines
  union all
  select * from bread_lines
  union all
  select * from request_lines;
$$;

revoke all on function public.finance_pnl_accrual_purchase_lines(date, date) from public, anon, authenticated;

-- ===========================================================================
-- 3. Public accrual P&L
-- ===========================================================================

create or replace function public.finance_pnl_accrual(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_start date;
  v_end date;
  v_prior_start date;
  v_prior_end date;
  v_lines jsonb := '[]'::jsonb;
  v_sections jsonb;
  v_totals jsonb;
  v_flags jsonb;
  v_policy public.finance_accrual_policies%rowtype;
  v_section text;
  v_product_line text;
  v_basis numeric;
  v_already numeric;
  v_months text[];
  v_estimated_amount numeric;
  v_receipt_count integer;
  v_receipt_lines integer;
  v_receipt_amount numeric;
  v_receipts_without_pr integer;
  v_rejected_receipts integer;
  v_bread_accrued numeric;
  v_bread_paid numeric;
  v_bread_requested numeric;
  v_bread_variance numeric;
  v_bread_request_variance numeric;
  v_que_quantity numeric;
  v_que_price numeric;
  v_vietjet_quantity numeric;
  v_vietjet_price numeric;
  v_bread_notifications integer;
  v_goods_receipts jsonb;
  v_bread jsonb;
  v_result jsonb;
begin
  if not public.finance_can_view(auth.uid()) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_month is null then
    raise exception 'invalid_period' using errcode = '22023';
  end if;

  v_start := date_trunc('month', p_month)::date;
  v_end := (v_start + interval '1 month - 1 day')::date;
  v_prior_start := (v_start - interval '3 months')::date;
  v_prior_end := (v_start - interval '1 day')::date;

  -- Base lines: controlled revenue, purchase accrual by receipt date, and the
  -- month's payroll. Missing prior-month payroll groups are added below with
  -- the same source but is_estimate = true.
  with
  payroll_periods_month as (
    select p.id, p.period_code, p.period_name
    from public.payroll_bn_periods p
    where date_trunc('month', p.date_from)::date = v_start
  ),
  current_payslip_groups as (
    select
      lower(btrim(coalesce(nullif(ps.group_name, ''), 'Chưa phân nhóm'))) as group_key,
      min(coalesce(nullif(ps.group_name, ''), 'Chưa phân nhóm')) as group_name,
      sum(ps.net_pay)::numeric as amount,
      count(*)::integer as line_count,
      min(p.period_code) as period_code,
      min(p.id::text) as period_id,
      string_agg(distinct p.period_name, ', ') as period_names
    from public.payroll_bn_payslips ps
    join payroll_periods_month p on p.id = ps.period_id
    group by 1
  ),
  prior_payslip_groups as (
    select
      lower(btrim(coalesce(nullif(ps.group_name, ''), 'Chưa phân nhóm'))) as group_key,
      min(coalesce(nullif(ps.group_name, ''), 'Chưa phân nhóm')) as group_name,
      sum(ps.net_pay)::numeric as amount
    from public.payroll_bn_payslips ps
    join public.payroll_bn_periods p on p.id = ps.period_id
    where date_trunc('month', p.date_from)::date = (v_start - interval '1 month')::date
    group by 1
  ),
  current_payslip_count as (
    select count(*)::integer as n
    from public.payroll_bn_payslips ps
    join payroll_periods_month p on p.id = ps.period_id
  ),
  current_payslip_employees as (
    select distinct ps.employee_code
    from public.payroll_bn_payslips ps
    join payroll_periods_month p on p.id = ps.period_id
  ),
  current_payslip_period_families as (
    select distinct public.finance_pnl_accrual_payroll_family(period_name) as family_key
    from (
      select p.period_name
      from payroll_periods_month p
      union all
      select ps.period_name
      from public.payroll_bn_payslips ps
      join payroll_periods_month p on p.id = ps.period_id
    ) names
  ),
  payout_base as (
    select
      sp.id,
      sp.payout_number,
      sp.period_name,
      sp.total_amount,
      sp.payroll_period_id,
      (regexp_match(
        sp.period_name,
        '(T|tháng)[[:space:]]*([0-9]{1,2})[[:space:]]*/[[:space:]]*([0-9]{4})',
        'i'
      ))[2]::integer as month_no,
      (regexp_match(
        sp.period_name,
        '(T|tháng)[[:space:]]*([0-9]{1,2})[[:space:]]*/[[:space:]]*([0-9]{4})',
        'i'
      ))[3]::integer as year_no,
      public.finance_pnl_accrual_payroll_family(sp.period_name) as family_key
    from public.salary_payouts sp
    where sp.status <> 'cancelled'
  ),
  current_all_payout_families as (
    select pf.family_key, min(pf.period_name) as family_name
    from payout_base pf
    where pf.year_no = extract(year from v_start)::integer
      and pf.month_no = extract(month from v_start)::integer
    group by pf.family_key
  ),
  current_payout_families as (
    select
      pf.family_key,
      min(pf.period_name) as family_name,
      sum(pf.total_amount)::numeric as amount,
      count(*)::integer as payout_count,
      string_agg(pf.payout_number, ', ' order by pf.payout_number) as payout_numbers
    from payout_base pf
    where pf.year_no = extract(year from v_start)::integer
      and pf.month_no = extract(month from v_start)::integer
      and not exists (
        select 1 from public.payroll_bn_payslips ps where ps.period_id = pf.payroll_period_id
      )
    group by pf.family_key
  ),
  prior_payout_family_lines as (
    select
      pf.family_key,
      min(pf.period_name) as family_name,
      sum(
        greatest(
          pf.total_amount - coalesce(
            (
              select sum(spl.net_pay)
              from public.salary_payout_lines spl
              join current_payslip_employees cpe on cpe.employee_code = spl.employee_code
              where spl.payout_id = pf.id
            ),
            0
          ),
          0
        )
      )::numeric as amount,
      count(*)::integer as payout_count
    from payout_base pf
    where pf.year_no = extract(year from (v_start - interval '1 month'))::integer
      and pf.month_no = extract(month from (v_start - interval '1 month'))::integer
    group by pf.family_key
  ),
  prior_payout_families_missing as (
    select pr.*
    from prior_payout_family_lines pr
    where pr.amount > 0
      and not exists (
        select 1 from current_all_payout_families c where c.family_key = pr.family_key
      )
      and not exists (
        select 1 from current_payslip_period_families cpf where cpf.family_key = pr.family_key
      )
  ),
  prior_payroll_total as (
    select coalesce(
      (select sum(amount) from prior_payslip_groups),
      (
        select sum(ml.amount)
        from public.finance_month_lines(
          (v_start - interval '1 month')::date,
          (v_start - interval '1 day')::date
        ) ml
        where ml.source = 'payroll'
          and ml.month = (v_start - interval '1 month')::date
      ),
      0
    )::numeric as amount
  ),
  base_lines as (
    select
      v_start as month,
      'revenue'::text as section,
      coalesce(ml.line_code, '(no channel)') as line_code,
      'Revenue — ' || coalesce(ml.line_code, '(no channel)') as line_label_en,
      ml.product_line,
      null::text as counterparty,
      sum(ml.amount)::numeric as amount,
      'revenue_ledger'::text as source,
      null::text as source_ref,
      null::text as source_id,
      null::text as source_line_id,
      false as is_estimate,
      null::text as note,
      null::numeric as quantity,
      null::numeric as unit_price
    from public.finance_month_lines(v_start, v_end) ml
    where ml.section = 'revenue'
    group by ml.line_code, ml.product_line

    union all

    select
      l.month,
      l.section,
      l.line_code,
      l.line_label_en,
      l.product_line,
      l.counterparty,
      l.amount,
      l.source,
      l.source_ref,
      l.source_id,
      l.source_line_id,
      l.is_estimate,
      l.note,
      l.quantity,
      l.unit_price
    from public.finance_pnl_accrual_purchase_lines(v_start, v_end) l

    union all

    select
      v_start,
      'operating'::text,
      'C6_PAYROLL'::text,
      public.finance_pnl_accrual_label('C6_PAYROLL'),
      'shared'::text,
      g.group_name,
      g.amount,
      'payroll_period'::text,
      g.period_code || ':' || g.group_name,
      g.period_id,
      g.period_id || ':' || g.group_key,
      false,
      'payroll_bn_payslips net_pay for ' || coalesce(g.period_names, 'the month'),
      null::numeric,
      null::numeric
    from current_payslip_groups g

    union all

    select
      v_start,
      'operating'::text,
      'C6_PAYROLL'::text,
      public.finance_pnl_accrual_label('C6_PAYROLL'),
      'shared'::text,
      p.family_name,
      p.amount,
      'payroll_period'::text,
      'payout_family:' || p.family_key,
      'payout_family:' || p.family_key,
      'payout_family:' || p.family_key,
      false,
      'Non-cancelled salary payout family ' || p.family_name
        || ' (' || p.payout_count::text || ' payout(s))',
      null::numeric,
      null::numeric
    from current_payout_families p

    union all

    select
      v_start,
      'operating'::text,
      'C6_PAYROLL'::text,
      public.finance_pnl_accrual_label('C6_PAYROLL'),
      'shared'::text,
      pr.family_name,
      pr.amount,
      'payroll_period'::text,
      'payroll_last_month:' || pr.family_key,
      'prior_payout:' || pr.family_key,
      'prior_payout:' || pr.family_key,
      true,
      'PAYROLL payroll_last_month – payout family missing',
      null::numeric,
      null::numeric
    from prior_payout_families_missing pr

    union all

    select
      v_start,
      'operating'::text,
      'C6_PAYROLL'::text,
      public.finance_pnl_accrual_label('C6_PAYROLL'),
      'shared'::text,
      pr.group_name,
      pr.amount,
      'payroll_period'::text,
      'payroll_last_month:' || pr.group_name,
      'prior:' || pr.group_key,
      'prior:' || pr.group_key,
      true,
      'PAYROLL payroll_last_month — group missing from current month payslips',
      null::numeric,
      null::numeric
    from prior_payslip_groups pr
    where (select n from current_payslip_count) > 0
      and not exists (
        select 1 from current_payslip_groups c where c.group_key = pr.group_key
      )

    union all

    select
      v_start,
      'operating'::text,
      'C6_PAYROLL'::text,
      public.finance_pnl_accrual_label('C6_PAYROLL'),
      'shared'::text,
      'Payroll (prior month accrual)',
      pt.amount,
      'payroll_period'::text,
      'payroll_last_month:total',
      'prior_total',
      'prior_total',
      true,
      'PAYROLL payroll_last_month — no current payslips, payouts or payout families',
      null::numeric,
      null::numeric
    from prior_payroll_total pt
    where (select n from current_payslip_count) = 0
      and not exists (select 1 from current_payout_families)
      and not exists (select 1 from prior_payout_families_missing)
      and pt.amount > 0
  )
  select coalesce(
    jsonb_agg(
      line
      order by
        case line->>'section'
          when 'revenue' then 10
          when 'cogs' then 20
          when 'selling' then 30
          when 'operating' then 40
          when 'unclassified' then 50
          when 'capex' then 60
          else 90
        end,
        line->>'line_code',
        line->>'source',
        line->>'source_ref'
    ),
    '[]'::jsonb
  )
  into v_lines
  from (
    select jsonb_strip_nulls(
      jsonb_build_object(
        'month', to_char(month, 'YYYY-MM'),
        'section', section,
        'line_code', line_code,
        'label', line_label_en,
        'product_line', product_line,
        'counterparty', counterparty,
        'amount', amount,
        'amounts', jsonb_build_object(to_char(v_start, 'YYYY-MM'), amount),
        'source', source,
        'source_ref', source_ref,
        'source_id', source_id,
        'source_line_id', source_line_id,
        'is_estimate', is_estimate,
        'note', note,
        'quantity', quantity,
        'unit_price', unit_price
      )
    ) as line
    from base_lines
  ) x;

  -- Accrual policies. Only the five periodic cost policies are used here;
  -- PAYROLL is handled above by payroll_last_month at group level.
  v_flags := jsonb_build_array(
    jsonb_build_object(
      'code', 'inventory_not_counted',
      'detail_en', 'Inventory differences are not deducted in phase 1; inventory.status is not_counted.'
    )
  );

  select coalesce(sum((line->>'amount')::numeric), 0)
  into v_estimated_amount
  from jsonb_array_elements(v_lines) line
  where line->>'source' = 'payroll_period'
    and coalesce((line->>'is_estimate')::boolean, false);

  if coalesce(v_estimated_amount, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'payroll_last_month_estimate',
        'detail_en', 'Missing current-month payroll groups were accrued from the prior month.',
        'amount', v_estimated_amount
      )
    );
  end if;

  for v_policy in
    select *
    from public.finance_accrual_policies
    where active
      and code in ('RENT', 'ELECTRICITY', 'GAS', 'TELECOM', 'SOCIAL_INS')
    order by sort_order, code
  loop
    select coalesce(sum((line->>'amount')::numeric), 0)
    into v_already
    from jsonb_array_elements(v_lines) line
    where line->>'line_code' = v_policy.category_code
      and coalesce((line->>'is_estimate')::boolean, false) = false
      and line->>'source' in ('goods_receipt', 'approved_request_without_receipt');

    if v_already = 0 then
      select avg(m.amount), array_agg(m.month_key order by m.month_key)
      into v_basis, v_months
      from (
        select
          to_char(l.month, 'YYYY-MM') as month_key,
          sum(l.amount)::numeric as amount
        from public.finance_pnl_accrual_purchase_lines(v_prior_start, v_prior_end) l
        where l.line_code = v_policy.category_code
          and l.month >= (v_start - interval '3 months')::date
          and l.month <= (v_start - interval '1 month')::date
        group by l.month
      ) m;

      if v_basis is not null and v_basis <> 0 then
        v_section := null;
        v_product_line := null;
        select
          case
            when parent.code = 'A_COGS' then 'cogs'
            when parent.code = 'B_SELLING' then 'selling'
            when parent.code = 'C_OPERATING' then 'operating'
            when parent.code = 'D_INVESTMENT' then 'capex'
            else 'unclassified'
          end,
          coalesce(cc.product_line, 'shared')
        into v_section, v_product_line
        from public.cost_categories cc
        left join public.cost_categories parent on parent.code = cc.parent_code
        where cc.code = v_policy.category_code;

        v_section := coalesce(v_section, 'unclassified');
        v_product_line := coalesce(v_product_line, 'shared');

        v_lines := v_lines || jsonb_build_array(
          jsonb_strip_nulls(
            jsonb_build_object(
              'month', to_char(v_start, 'YYYY-MM'),
              'section', v_section,
              'line_code', v_policy.category_code,
              'label', public.finance_pnl_accrual_label(v_policy.category_code),
              'product_line', v_product_line,
              'counterparty', v_policy.code,
              'amount', round(v_basis, 0),
              'amounts', jsonb_build_object(to_char(v_start, 'YYYY-MM'), round(v_basis, 0)),
              'source', 'accrual_policy',
              'source_ref', v_policy.code,
              'source_id', v_policy.code,
              'is_estimate', true,
              'note', 'Trailing 3m average of '
                || coalesce(array_to_string(v_months, ', '), 'no complete months')
                || '; no actual ' || v_policy.category_code || ' booking in '
                || to_char(v_start, 'YYYY-MM')
            )
          )
        );

        v_flags := v_flags || jsonb_build_array(
          jsonb_build_object(
            'code', 'accrual_policy_estimated',
            'detail_en', v_policy.code || ' accrued from trailing 3m average.',
            'amount', round(v_basis, 0)
          )
        );
      else
        v_flags := v_flags || jsonb_build_array(
          jsonb_build_object(
            'code', 'accrual_policy_no_history',
            'detail_en', v_policy.code || ' has no actual booking in the month and no trailing history.'
          )
        );
      end if;
    end if;
  end loop;

  -- Totals always satisfy:
  --   gross_profit = revenue - cogs
  --   ebitda = gross_profit - selling - operating - unclassified
  with agg as (
    select
      coalesce(sum((x->>'amount')::numeric) filter (where x->>'section' = 'revenue'), 0) as revenue,
      coalesce(sum((x->>'amount')::numeric) filter (where x->>'section' = 'cogs'), 0) as cogs,
      coalesce(sum((x->>'amount')::numeric) filter (where x->>'section' = 'selling'), 0) as selling,
      coalesce(sum((x->>'amount')::numeric) filter (where x->>'section' = 'operating'), 0) as operating,
      coalesce(sum((x->>'amount')::numeric) filter (where x->>'section' = 'unclassified'), 0) as unclassified,
      coalesce(sum((x->>'amount')::numeric) filter (where x->>'section' = 'capex'), 0) as capex,
      coalesce(sum((x->>'amount')::numeric) filter (
        where coalesce((x->>'is_estimate')::boolean, false)
      ), 0) as estimate_total,
      count(*) filter (where coalesce((x->>'is_estimate')::boolean, false)) as estimate_lines,
      count(*) as line_count
    from jsonb_array_elements(v_lines) x
  ),
  calc as (
    select
      revenue,
      cogs,
      revenue - cogs as gross_profit,
      selling,
      operating,
      unclassified,
      capex,
      estimate_total,
      estimate_lines,
      line_count,
      case when revenue <> 0 then round((revenue - cogs) / revenue, 4) else null end as gross_margin,
      revenue - cogs - selling - operating - unclassified as ebitda
    from agg
  )
  select jsonb_build_object(
    'revenue', revenue,
    'cogs', cogs,
    'gross_profit', gross_profit,
    'gross_margin', gross_margin,
    'selling', selling,
    'operating', operating,
    'unclassified', unclassified,
    'ebitda', ebitda,
    'ebitda_margin', case when revenue <> 0 then round(ebitda / revenue, 4) else null end,
    'estimate_total', estimate_total,
    'estimate_lines', estimate_lines,
    'capex', capex,
    'line_count', line_count
  )
  into v_totals
  from calc;

  select jsonb_build_object(
    'revenue', coalesce((
      select jsonb_agg(x order by x->>'line_code', x->>'source', x->>'source_ref')
      from jsonb_array_elements(v_lines) x where x->>'section' = 'revenue'
    ), '[]'::jsonb),
    'cogs', coalesce((
      select jsonb_agg(x order by x->>'line_code', x->>'source', x->>'source_ref')
      from jsonb_array_elements(v_lines) x where x->>'section' = 'cogs'
    ), '[]'::jsonb),
    'selling', coalesce((
      select jsonb_agg(x order by x->>'line_code', x->>'source', x->>'source_ref')
      from jsonb_array_elements(v_lines) x where x->>'section' = 'selling'
    ), '[]'::jsonb),
    'operating', coalesce((
      select jsonb_agg(x order by x->>'line_code', x->>'source', x->>'source_ref')
      from jsonb_array_elements(v_lines) x where x->>'section' = 'operating'
    ), '[]'::jsonb),
    'unclassified', coalesce((
      select jsonb_agg(x order by x->>'line_code', x->>'source', x->>'source_ref')
      from jsonb_array_elements(v_lines) x where x->>'section' = 'unclassified'
    ), '[]'::jsonb),
    'capex', coalesce((
      select jsonb_agg(x order by x->>'line_code', x->>'source', x->>'source_ref')
      from jsonb_array_elements(v_lines) x where x->>'section' = 'capex'
    ), '[]'::jsonb)
  )
  into v_sections;

  select
    count(distinct x->>'source_id') filter (where x->>'source' = 'goods_receipt'),
    count(*) filter (where x->>'source' = 'goods_receipt'),
    coalesce(sum((x->>'amount')::numeric) filter (where x->>'source' = 'goods_receipt'), 0)
  into v_receipt_count, v_receipt_lines, v_receipt_amount
  from jsonb_array_elements(v_lines) x;

  select count(*)::integer
  into v_receipts_without_pr
  from public.goods_receipts gr
  where gr.receipt_date between v_start and v_end
    and not exists (
      select 1
      from public.payment_requests pr
      where pr.status::text in ('approved', 'pending')
        and (pr.id = gr.payment_request_id or pr.goods_receipt_id = gr.id)
    )
    and not exists (
      select 1
      from public.payment_requests pr
      where pr.status::text = 'rejected'
        and (pr.id = gr.payment_request_id or pr.goods_receipt_id = gr.id)
    );

  select count(distinct gr.id)::integer
  into v_rejected_receipts
  from public.goods_receipts gr
  join public.payment_requests pr
    on (pr.id = gr.payment_request_id or pr.goods_receipt_id = gr.id)
  where gr.receipt_date between v_start and v_end
    and pr.status::text = 'rejected';

  v_goods_receipts := jsonb_build_object(
    'count', coalesce(v_receipt_count, 0),
    'line_count', coalesce(v_receipt_lines, 0),
    'amount', coalesce(v_receipt_amount, 0),
    'without_payment_request', coalesce(v_receipts_without_pr, 0),
    'rejected_excluded', coalesce(v_rejected_receipts, 0),
    'note', 'One accrual row per goods receipt; approved or pending linked payment requests are used and rejected ones are excluded.'
  );

  select
    coalesce(sum((x->>'amount')::numeric) filter (where x->>'source' = 'supplier_bread_order'), 0),
    coalesce(sum((x->>'quantity')::numeric) filter (
      where x->>'source' = 'supplier_bread_order' and x->>'source_line_id' like '%:que'
    ), 0),
    max((x->>'unit_price')::numeric) filter (
      where x->>'source' = 'supplier_bread_order' and x->>'source_line_id' like '%:que'
    ),
    coalesce(sum((x->>'quantity')::numeric) filter (
      where x->>'source' = 'supplier_bread_order' and x->>'source_line_id' like '%:vietjet'
    ), 0),
    max((x->>'unit_price')::numeric) filter (
      where x->>'source' = 'supplier_bread_order' and x->>'source_line_id' like '%:vietjet'
    ),
    count(distinct x->>'source_id') filter (where x->>'source' = 'supplier_bread_order')
  into
    v_bread_accrued,
    v_que_quantity,
    v_que_price,
    v_vietjet_quantity,
    v_vietjet_price,
    v_bread_notifications
  from jsonb_array_elements(v_lines) x;

  select
    coalesce((
      select sum(coalesce(pri.line_total, pri.quantity * pri.unit_price, 0))
      from public.payment_request_items pri
      join public.payment_requests pr on pr.id = pri.payment_request_id
      join public.suppliers s on s.id = pr.supplier_id
      where coalesce(s.name, '') ~* 'tuy[ếệe]t[[:space:]]*anh'
        and pr.status::text = 'approved'
        and pr.payment_status::text = 'paid'
        and (coalesce(pr.paid_at, pr.approved_at, pr.created_at) at time zone 'Asia/Ho_Chi_Minh')::date
          between v_start and v_end
    ), 0),
    coalesce((
      select sum(coalesce(pri.line_total, pri.quantity * pri.unit_price, 0))
      from public.payment_request_items pri
      join public.payment_requests pr on pr.id = pri.payment_request_id
      join public.suppliers s on s.id = pr.supplier_id
      where coalesce(s.name, '') ~* 'tuy[ếệe]t[[:space:]]*anh'
        and pr.status::text = 'approved'
        and (pr.created_at at time zone 'Asia/Ho_Chi_Minh')::date between v_start and v_end
    ), 0)
  into v_bread_paid, v_bread_requested;

  v_bread_variance := coalesce(v_bread_accrued, 0) - coalesce(v_bread_paid, 0);
  v_bread_request_variance := coalesce(v_bread_accrued, 0) - coalesce(v_bread_requested, 0);

  v_bread := jsonb_build_object(
    'accrued_amount', coalesce(v_bread_accrued, 0),
    'paid_amount', coalesce(v_bread_paid, 0),
    'approved_request_amount', coalesce(v_bread_requested, 0),
    'variance_vs_paid', v_bread_variance,
    'variance_vs_approved_requests', v_bread_request_variance,
    'excluded_payment_request_amount', coalesce(v_bread_requested, 0),
    'que_quantity', coalesce(v_que_quantity, 0),
    'que_unit_price', v_que_price,
    'vietjet_quantity', coalesce(v_vietjet_quantity, 0),
    'vietjet_unit_price', v_vietjet_price,
    'notification_count', coalesce(v_bread_notifications, 0),
    'price_source', 'Latest non-rejected payment_request_items of BMQ - HKD Tuyết Anh per product kind; approved before pending, newest first',
    'note', 'Bread cost is accrued from sent production_bread_order notifications by billable que quantity and VietJet quantity. Tuyết Anh payment-request lines are excluded from expense lines to avoid double counting; variance is shown against paid and approved-request amounts.'
  );

  v_flags := v_flags || jsonb_build_array(
    jsonb_build_object(
      'code', 'goods_receipts_counted_once',
      'detail_en', coalesce(v_receipt_count, 0)::text || ' goods receipt(s) accrued once in the month.',
      'amount', coalesce(v_receipt_amount, 0)
    )
  );

  if coalesce(v_receipts_without_pr, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'receipt_without_payment_request',
        'detail_en', v_receipts_without_pr::text || ' goods receipt(s) have no approved or pending payment request and use received quantity * unit price.'
      )
    );
  end if;

  if coalesce(v_rejected_receipts, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'rejected_receipts_excluded',
        'detail_en', v_rejected_receipts::text || ' goods receipt(s) linked to a rejected payment request were excluded.'
      )
    );
  end if;

  if coalesce(v_bread_accrued, 0) = 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object('code', 'bread_supplier_missing', 'detail_en', 'No sent production_bread_order notification was valued in the month.')
    );
  end if;

  if v_que_quantity > 0 and v_que_price is null then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object('code', 'bread_que_price_missing', 'detail_en', 'No non-rejected Tuyết Anh que unit price was found; que cost is zero.')
    );
  end if;

  if v_vietjet_quantity > 0 and v_vietjet_price is null then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object('code', 'bread_vietjet_price_missing', 'detail_en', 'No non-rejected Tuyết Anh VietJet unit price was found; VietJet cost is zero.')
    );
  end if;

  if abs(coalesce(v_bread_variance, 0)) > 0.5 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'bread_supplier_payment_variance',
        'detail_en', 'Bread accrual differs from the amount paid in the month; see bread_supplier.variance_vs_paid.',
        'amount', v_bread_variance
      )
    );
  end if;

  if coalesce((v_totals->>'estimate_total')::numeric, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'estimate_included',
        'detail_en', 'Estimated lines are included in the P&L; see totals.estimate_total.',
        'amount', (v_totals->>'estimate_total')::numeric
      )
    );
  end if;

  if coalesce((v_totals->>'unclassified')::numeric, 0) <> 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object('code', 'unclassified_present', 'detail_en', 'Unclassified expense lines are present.')
    );
  end if;

  if coalesce((v_totals->>'revenue')::numeric, 0) = 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object('code', 'revenue_missing', 'detail_en', 'No approved controlled revenue lines for the month.')
    );
  end if;

  if coalesce((v_totals->>'cogs')::numeric, 0) = 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object('code', 'cogs_missing', 'detail_en', 'No COGS-classified accrual lines for the month.')
    );
  end if;

  select coalesce(jsonb_agg(f order by f->>'code', f->>'detail_en'), '[]'::jsonb)
  into v_flags
  from jsonb_array_elements(v_flags) f;

  v_result := jsonb_build_object(
    'month', to_char(v_start, 'YYYY-MM'),
    'from', v_start,
    'to', v_end,
    'currency', 'VND',
    'lines', v_lines,
    'sections', v_sections,
    'totals', v_totals,
    'inventory', jsonb_build_object(
      'status', 'not_counted',
      'note', 'chưa trừ chênh lệch tồn kho',
      'phase', 2
    ),
    'goods_receipts', v_goods_receipts,
    'bread_supplier', v_bread,
    'flags', v_flags
  );

  return v_result;
end;
$$;

revoke all on function public.finance_pnl_accrual(date) from public, anon;
grant execute on function public.finance_pnl_accrual(date) to authenticated, service_role;

comment on function public.finance_pnl_accrual(date)
  is 'Read-only single-month accrual P&L. Purchases accrue on goods_receipts.receipt_date; Tuyết Anh bread uses sent production_bread_order notifications; missing payroll groups and periodic costs are estimated and flagged. Inventory is not counted in phase 1.';
