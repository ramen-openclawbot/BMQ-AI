-- Body-only live contract for public.finance_pnl_accrual('2026-10-01').
--
-- This file intentionally has no BEGIN/ROLLBACK/SET TRANSACTION. The verify
-- script wraps it in one transaction, so every check and every temporary
-- function creation is rolled back together.
--
-- Data contract (October 2026):
--   revenue matches finance_month_lines within 100,000 VND;
--   Tuyết Anh bread cost is 100m-115m at que=1,230 and VietJet=2,300;
--   unclassified is below 80m;
--   T9 payroll totals 256,109,000 and T10 payroll totals 244,613,000;
--   T10 has exactly three per-person payroll estimates (48,320,000) and none
--   for Trần Thị Ái Mi or Trần Thị Vân Anh;
--   every goods receipt is counted once and rejected receipts are absent;
--   gross profit and EBITDA add up exactly.

do $$
declare
  v_owner uuid;
begin
  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;

  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user_roles row';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;

-- Payout month: a valid title month wins; otherwise the paid/completed/created
-- date is converted to Vietnam time and truncated to the first of that month.
do $$
declare
  v_month date;
begin
  v_month := public.finance_pnl_accrual_payout_month(
    'Lương lẻ bếp',
    '2026-10-15 03:00:00+00'::timestamptz,
    null,
    '2026-09-30 00:00:00+00'::timestamptz
  );
  if v_month <> '2026-10-01' then
    raise exception 'CHECK FAIL: unlabelled 15/10 VN payout month %, expected 2026-10-01', v_month;
  end if;

  v_month := public.finance_pnl_accrual_payout_month(
    'Lương lẻ bếp',
    '2026-10-31 16:59:59+00'::timestamptz,
    null,
    '2026-10-01 00:00:00+00'::timestamptz
  );
  if v_month <> '2026-10-01' then
    raise exception 'CHECK FAIL: 31/10 23:59 VN payout month %, expected 2026-10-01', v_month;
  end if;

  v_month := public.finance_pnl_accrual_payout_month(
    'Lương lẻ bếp',
    '2026-10-31 18:00:00+00'::timestamptz,
    null,
    '2026-10-01 00:00:00+00'::timestamptz
  );
  if v_month <> '2026-11-01' then
    raise exception 'CHECK FAIL: 01/11 01:00 VN payout month %, expected 2026-11-01', v_month;
  end if;

  v_month := public.finance_pnl_accrual_payout_month(
    'Lương lẻ T10/2026',
    '2026-12-05 03:00:00+00'::timestamptz,
    null,
    '2026-12-01 00:00:00+00'::timestamptz
  );
  if v_month <> '2026-10-01' then
    raise exception 'CHECK FAIL: title month must win over paid date, got %', v_month;
  end if;

  v_month := public.finance_pnl_accrual_payout_month(
    'Lương lẻ bếp',
    null,
    null,
    '2026-10-30 03:00:00+00'::timestamptz
  );
  if v_month is not null then
    raise exception 'CHECK FAIL: pending unlabelled payout must have no accrual month, got %', v_month;
  end if;

  v_month := public.finance_pnl_accrual_payout_month(
    'Lương T09.2026',
    '2026-12-05 03:00:00+00'::timestamptz,
    null,
    '2026-12-01 00:00:00+00'::timestamptz
  );
  if v_month <> '2026-09-01' then
    raise exception 'CHECK FAIL: dotted title month must parse to September, got %', v_month;
  end if;

  v_month := public.finance_pnl_accrual_payout_month(
    'Tạm ứng đợt 2/2026',
    '2026-10-15 03:00:00+00'::timestamptz,
    null,
    '2026-10-01 00:00:00+00'::timestamptz
  );
  if v_month <> '2026-10-01' then
    raise exception 'CHECK FAIL: "đợt 2/2026" must not parse as February, got %', v_month;
  end if;

  v_month := public.finance_pnl_accrual_payout_month(
    normalize('tháng 9/2026', NFD),
    '2026-12-05 03:00:00+00'::timestamptz,
    null,
    '2026-12-01 00:00:00+00'::timestamptz
  );
  if v_month <> '2026-09-01' then
    raise exception 'CHECK FAIL: NFD title month must parse to September, got %', v_month;
  end if;

  v_month := public.finance_pnl_accrual_payout_month(
    'Lương lẻ Bếp_T09/2026',
    '2026-10-05 03:00:00+00'::timestamptz,
    null,
    '2026-10-01 00:00:00+00'::timestamptz
  );
  if v_month <> '2026-09-01' then
    raise exception 'CHECK FAIL: underscored title month must parse to September, got %', v_month;
  end if;

  v_month := public.finance_pnl_accrual_payout_month(
    'Lương T19/2026',
    '2026-10-15 03:00:00+00'::timestamptz,
    null,
    '2026-10-01 00:00:00+00'::timestamptz
  );
  if v_month <> '2026-10-01' then
    raise exception 'CHECK FAIL: invalid T19/2026 must fall back to October, got %', v_month;
  end if;
end $$;

-- The payroll family key must collapse all accepted title month formats.
do $$
declare
  v_family text;
begin
  v_family := public.finance_pnl_accrual_payroll_family('Lương BH T09.2026');
  if v_family <> 'lương bh' then
    raise exception 'CHECK FAIL: dotted family % != lương bh', v_family;
  end if;

  if public.finance_pnl_accrual_payroll_family('Lương BH T09-2026') <> v_family
     or public.finance_pnl_accrual_payroll_family('Lương BH T09/2026') <> v_family
     or public.finance_pnl_accrual_payroll_family('Lương BH_T09-2026_UNC') <> v_family then
    raise exception 'CHECK FAIL: payroll family formats did not collapse to %', v_family;
  end if;
end $$;

-- The live database may already carry the owner's real T4–T10 BHXH row. Reuse
-- it instead of inserting a duplicate; otherwise create it through the save RPC
-- (the only write path). The verify script rolls any inserted row back.
do $$
declare
  v_saved jsonb;
  v_existing uuid;
begin
  select a.id
  into v_existing
  from public.finance_manual_adjustments a
  where a.kind = 'opex'
    and a.category_code = 'C7_SOCIAL_INSURANCE'
    and a.period_from = '2026-04-01'
    and a.period_to = '2026-10-01'
    and a.status = 'active'
  order by a.created_at
  limit 1;

  if v_existing is not null then
    perform set_config('app.finance_dryrun_adjustment_id', v_existing::text, true);
  else
    v_saved := public.finance_manual_adjustment_save(
      p_id => null,
      p_kind => 'opex',
      p_category_code => 'C7_SOCIAL_INSURANCE',
      p_label => 'BHXH T4–T10/2026 (dry run)',
      p_period_from => '2026-04-01',
      p_period_to => '2026-10-01',
      p_total_amount => 96955830,
      p_source_ref => 'DRYRUN-BHXH-2026',
      p_note => 'Rollback-only dry run adjustment'
    );

    if v_saved is null or (v_saved->>'id') is null then
      raise exception 'CHECK FAIL: finance_manual_adjustment_save did not return an id';
    end if;

    perform set_config('app.finance_dryrun_adjustment_id', v_saved->>'id', true);
  end if;
end $$;

do $$
declare
  v_result jsonb;
  v_revenue_expected numeric;
  v_revenue numeric;
  v_cogs numeric;
  v_gross_profit numeric;
  v_selling numeric;
  v_operating numeric;
  v_unclassified numeric;
  v_ebitda numeric;
  v_bread numeric;
  v_que_price numeric;
  v_vietjet_price numeric;
  v_receipt_count integer;
  v_receipt_lines integer;
  v_bad_line record;
  v_payroll_t9 numeric;
  v_payroll_t10 numeric;
  v_actual_t10 numeric;
  v_estimate_t10 numeric;
  v_estimate_count integer;
  v_estimate_names text;
begin
  v_result := public.finance_pnl_accrual('2026-10-01');

  if v_result is null or v_result->>'month' is distinct from '2026-10' then
    raise exception 'CHECK FAIL: finance_pnl_accrual did not return 2026-10';
  end if;

  select coalesce(sum(ml.amount), 0)
  into v_revenue_expected
  from public.finance_month_lines('2026-10-01', '2026-10-31') ml
  where ml.section = 'revenue';

  v_revenue := (v_result->'totals'->>'revenue')::numeric;
  if abs(v_revenue - v_revenue_expected) > 100000 then
    raise exception 'CHECK FAIL: revenue % differs from finance_month_lines % by more than 100,000',
      v_revenue, v_revenue_expected;
  end if;

  select coalesce(sum((x->>'amount')::numeric), 0)
  into v_bread
  from jsonb_array_elements(v_result->'lines') x
  where x->>'line_code' = 'A1_BREAD_BOUGHT'
    and x->>'source' = 'supplier_bread_order';

  if v_bread < 100000000 or v_bread > 115000000 then
    raise exception 'CHECK FAIL: Tuyết Anh bread cost % is outside 100m-115m', v_bread;
  end if;

  v_que_price := (v_result->'bread_supplier'->>'que_unit_price')::numeric;
  v_vietjet_price := (v_result->'bread_supplier'->>'vietjet_unit_price')::numeric;

  if v_que_price is distinct from 1230 then
    raise exception 'CHECK FAIL: que_unit_price % != 1230', v_que_price;
  end if;

  if v_vietjet_price is distinct from 2300 then
    raise exception 'CHECK FAIL: vietjet_unit_price % != 2300', v_vietjet_price;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'line_code' = 'A1_BREAD_BOUGHT'
      and x->>'source' = 'supplier_bread_order'
      and x->>'note' ~ 'PR-[A-Z0-9]+'
      and x->>'note' ~* '(approved|pending)'
  ) then
    raise exception 'CHECK FAIL: bread line note is missing the payment request/status';
  end if;

  v_unclassified := (v_result->'totals'->>'unclassified')::numeric;
  if v_unclassified >= 80000000 then
    raise exception 'CHECK FAIL: unclassified % is not below 80m', v_unclassified;
  end if;

  select coalesce(sum((x->>'amount')::numeric), 0)
  into v_payroll_t9
  from jsonb_array_elements(public.finance_pnl_accrual('2026-09-01')->'lines') x
  where x->>'line_code' = 'C6_PAYROLL'
    and x->>'source' = 'payroll_period';

  if v_payroll_t9 <> 256109000 then
    raise exception 'CHECK FAIL: T9 payroll total % != 256109000', v_payroll_t9;
  end if;

  v_payroll_t10 := (select coalesce(sum((x->>'amount')::numeric), 0)
    from jsonb_array_elements(v_result->'lines') x
    where x->>'line_code' = 'C6_PAYROLL'
      and x->>'source' = 'payroll_period');

  if v_payroll_t10 <> 244613000 then
    raise exception 'CHECK FAIL: T10 payroll total % != 244613000', v_payroll_t10;
  end if;

  select
    coalesce(sum((x->>'amount')::numeric) filter (
      where coalesce((x->>'is_estimate')::boolean, false) = false
    ), 0),
    coalesce(sum((x->>'amount')::numeric) filter (
      where coalesce((x->>'is_estimate')::boolean, false)
    ), 0),
    count(*) filter (where coalesce((x->>'is_estimate')::boolean, false)),
    string_agg(x->>'counterparty', ', ' order by x->>'counterparty') filter (
      where coalesce((x->>'is_estimate')::boolean, false)
    )
  into v_actual_t10, v_estimate_t10, v_estimate_count, v_estimate_names
  from jsonb_array_elements(v_result->'lines') x
  where x->>'line_code' = 'C6_PAYROLL'
    and x->>'source' = 'payroll_period';

  if v_actual_t10 <> 196293000 then
    raise exception 'CHECK FAIL: T10 actual payroll % != 196293000', v_actual_t10;
  end if;

  if v_estimate_t10 <> 48320000 then
    raise exception 'CHECK FAIL: T10 estimated payroll % != 48320000', v_estimate_t10;
  end if;

  if v_estimate_count <> 3 then
    raise exception 'CHECK FAIL: T10 estimated payroll has % lines, expected 3: %',
      v_estimate_count, v_estimate_names;
  end if;

  if v_actual_t10 + v_estimate_t10 <> v_payroll_t10 then
    raise exception 'CHECK FAIL: T10 actual % + estimate % != total %',
      v_actual_t10, v_estimate_t10, v_payroll_t10;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'payroll_period'
      and coalesce((x->>'is_estimate')::boolean, false)
      and lower(x->>'counterparty') like '%dũng%'
  ) or not exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'payroll_period'
      and coalesce((x->>'is_estimate')::boolean, false)
      and lower(x->>'counterparty') like '%tú trinh%'
  ) or not exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'payroll_period'
      and coalesce((x->>'is_estimate')::boolean, false)
      and lower(x->>'counterparty') like '%đạm%'
  ) then
    raise exception 'CHECK FAIL: T10 estimates must be Dũng, Tú Trinh and Đạm, found %',
      v_estimate_names;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'payroll_period'
      and coalesce((x->>'is_estimate')::boolean, false)
      and (
        lower(x->>'counterparty') like '%ái mi%'
        or lower(x->>'counterparty') like '%vân anh%'
      )
  ) then
    raise exception 'CHECK FAIL: T10 estimates include an excluded person: %', v_estimate_names;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'payroll_period'
      and coalesce((x->>'is_estimate')::boolean, false)
      and lower(x->>'counterparty') like '%xuân mai%'
  ) then
    raise exception 'CHECK FAIL: Xuân Mai was paid in T10 and must not be estimated';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'payroll_period'
      and coalesce((x->>'is_estimate')::boolean, false)
      and lower(x->>'source_ref') ~ '(dũng|tú trinh|đạm|ái mi|vân anh)'
  ) then
    raise exception 'CHECK FAIL: an estimate source_ref leaked an employee name';
  end if;

  select count(distinct x->>'source_id'), count(*)
  into v_receipt_count, v_receipt_lines
  from jsonb_array_elements(v_result->'lines') x
  where x->>'source' = 'goods_receipt';

  if v_receipt_count <> (v_result->'goods_receipts'->>'count')::integer then
    raise exception 'CHECK FAIL: goods_receipts.count % != distinct receipt ids %',
      v_result->'goods_receipts'->>'count', v_receipt_count;
  end if;

  if v_receipt_lines <> (v_result->'goods_receipts'->>'line_count')::integer then
    raise exception 'CHECK FAIL: goods_receipts.line_count % != actual lines %',
      v_result->'goods_receipts'->>'line_count', v_receipt_lines;
  end if;

  select *
  into v_bad_line
  from (
    select x->>'source_line_id' as source_line_id
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'goods_receipt'
    group by x->>'source_line_id'
    having count(*) > 1
    limit 1
  ) bad;

  if found then
    raise exception 'CHECK FAIL: duplicate goods_receipt source_line_id %', v_bad_line.source_line_id;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    join public.goods_receipts gr on gr.id::text = x->>'source_id'
    where x->>'source' = 'goods_receipt'
      and exists (
        select 1
        from public.payment_requests pr
        where pr.status::text = 'rejected'
          and (pr.id = gr.payment_request_id or pr.goods_receipt_id = gr.id)
      )
  ) then
    raise exception 'CHECK FAIL: a rejected goods receipt was counted';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'goods_receipt'
      and x->>'note' like '%from pending payment request%'
  ) then
    raise exception 'CHECK FAIL: no goods receipt was accrued from a pending payment request';
  end if;

  v_cogs := (v_result->'totals'->>'cogs')::numeric;
  v_gross_profit := (v_result->'totals'->>'gross_profit')::numeric;
  v_selling := (v_result->'totals'->>'selling')::numeric;
  v_operating := (v_result->'totals'->>'operating')::numeric;
  v_ebitda := (v_result->'totals'->>'ebitda')::numeric;

  if v_gross_profit <> v_revenue - v_cogs then
    raise exception 'CHECK FAIL: gross_profit % != revenue % - cogs %',
      v_gross_profit, v_revenue, v_cogs;
  end if;

  if v_ebitda <> v_gross_profit - v_selling - v_operating - v_unclassified then
    raise exception 'CHECK FAIL: ebitda % != gross_profit % - selling % - operating % - unclassified %',
      v_ebitda, v_gross_profit, v_selling, v_operating, v_unclassified;
  end if;

  if v_result->'inventory'->>'status' is distinct from 'not_counted' then
    raise exception 'CHECK FAIL: inventory status must be not_counted';
  end if;

  if v_result->'inventory'->>'note' is distinct from 'chưa trừ chênh lệch tồn kho' then
    raise exception 'CHECK FAIL: inventory note changed';
  end if;
end $$;

-- Manual adjustment checks: T10 is the last month of the T4–T10 window, so it
-- receives the rounding remainder; the seven monthly amounts must sum exactly.
do $$
declare
  v_result jsonb;
  v_amount numeric;
  v_total numeric;
  v_months integer;
  v_min_month numeric;
  v_max_month numeric;
  v_ebitda numeric;
  v_depreciation numeric;
  v_ebit numeric;
  v_interest numeric;
  v_other_below numeric;
  v_ebt numeric;
  v_cit numeric;
  v_net_profit numeric;
  v_cit_is_estimate boolean;
begin
  v_result := public.finance_pnl_accrual('2026-10-01');

  select (x->>'amount')::numeric
  into v_amount
  from jsonb_array_elements(v_result->'lines') x
  where x->>'line_code' = 'C7_SOCIAL_INSURANCE'
    and x->>'source' = 'manual_adjustment';

  if v_amount is null then
    raise exception 'CHECK FAIL: missing manual BHXH line in 2026-10';
  end if;

  if v_amount not in (13850832, 13850833) then
    raise exception 'CHECK FAIL: manual BHXH T10 amount % is not 13850832/13850833', v_amount;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'line_code' = 'C7_SOCIAL_INSURANCE'
      and x->>'source' = 'accrual_policy'
      and coalesce((x->>'is_estimate')::boolean, false)
  ) then
    raise exception 'CHECK FAIL: estimated SOCIAL_INS still present when a manual BHXH line exists';
  end if;

  select
    coalesce(sum((x->>'amount')::numeric), 0),
    count(*)::integer,
    min((x->>'amount')::numeric),
    max((x->>'amount')::numeric)
  into v_total, v_months, v_min_month, v_max_month
  from generate_series('2026-04-01'::date, '2026-10-01'::date, interval '1 month') g(month_start)
  cross join lateral public.finance_pnl_accrual(g.month_start::date) pnl
  cross join lateral jsonb_array_elements(pnl->'lines') x
  where x->>'line_code' = 'C7_SOCIAL_INSURANCE'
    and x->>'source' = 'manual_adjustment';

  if v_months <> 7 then
    raise exception 'CHECK FAIL: expected 7 manual BHXH months, found %', v_months;
  end if;

  if v_min_month < 13850832 or v_max_month > 13850833 then
    raise exception 'CHECK FAIL: monthly manual BHXH range %..% is outside 13850832..13850833',
      v_min_month, v_max_month;
  end if;

  if v_total <> 96955830 then
    raise exception 'CHECK FAIL: manual BHXH T4–T10 total % != 96955830', v_total;
  end if;

  v_ebitda := (v_result->'totals'->>'ebitda')::numeric;
  v_depreciation := (v_result->'totals'->>'depreciation')::numeric;
  v_ebit := (v_result->'totals'->>'ebit')::numeric;
  v_interest := (v_result->'totals'->>'interest')::numeric;
  v_other_below := (v_result->'totals'->>'other_below_ebitda')::numeric;
  v_ebt := (v_result->'totals'->>'ebt')::numeric;
  v_cit := (v_result->'totals'->>'cit')::numeric;
  v_net_profit := (v_result->'totals'->>'net_profit')::numeric;
  v_cit_is_estimate := coalesce((v_result->'totals'->>'cit_is_estimate')::boolean, false);

  if v_ebit <> v_ebitda - v_depreciation then
    raise exception 'CHECK FAIL: ebit % != ebitda % - depreciation %', v_ebit, v_ebitda, v_depreciation;
  end if;

  if v_ebt <> v_ebit - v_interest - v_other_below then
    raise exception 'CHECK FAIL: ebt % != ebit % - interest % - other_below %',
      v_ebt, v_ebit, v_interest, v_other_below;
  end if;

  if v_net_profit <> v_ebt - v_cit then
    raise exception 'CHECK FAIL: net_profit % != ebt % - cit %', v_net_profit, v_ebt, v_cit;
  end if;

  if v_cit_is_estimate is not true then
    raise exception 'CHECK FAIL: cit_is_estimate must be true without an actual CIT adjustment';
  end if;

  if v_cit <> round(greatest(v_ebt, 0) * 0.2, 0) then
    raise exception 'CHECK FAIL: estimated cit % != round(greatest(ebt %,0) * 0.2)', v_cit, v_ebt;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'below_ebitda') x
    where x->>'line_code' = 'CIT'
      and coalesce((x->>'is_estimate')::boolean, false)
  ) then
    raise exception 'CHECK FAIL: below_ebitda must contain an estimated CIT line';
  end if;
end $$;

-- A finance viewer without payroll/salary access still gets the same payroll
-- total, but the per-person estimates must collapse to one nameless aggregate.
do $$
declare
  v_owner uuid;
  v_finance_user uuid;
  v_restricted jsonb;
  v_count integer;
  v_amount numeric;
  v_total numeric;
  v_source_line_id text;
  v_names text;
begin
  select ur.user_id
  into v_finance_user
  from public.user_roles ur
  where not public.has_role(ur.user_id, 'owner')
    and public.has_module_permission(ur.user_id, 'finance_cost', 'view')
    and not public.has_module_permission(ur.user_id, 'salary_cash', 'view')
    and not public.has_module_permission(ur.user_id, 'payroll', 'view')
  order by ur.user_id
  limit 1;

  if v_finance_user is null then
    raise notice 'SKIP: restricted payroll check because no finance-only user exists';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_finance_user::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_finance_user, 'role', 'authenticated')::text,
    true
  );

  v_restricted := public.finance_pnl_accrual('2026-10-01');

  select
    count(*),
    coalesce(sum((x->>'amount')::numeric), 0),
    min(x->>'source_line_id'),
    string_agg(x->>'counterparty', ', ' order by x->>'counterparty')
  into v_count, v_amount, v_source_line_id, v_names
  from jsonb_array_elements(v_restricted->'lines') x
  where x->>'line_code' = 'C6_PAYROLL'
    and x->>'source' = 'payroll_period'
    and coalesce((x->>'is_estimate')::boolean, false);

  if v_count <> 1 or v_amount <> 48320000
     or v_source_line_id <> 'prior_people_aggregate' then
    raise exception 'CHECK FAIL: restricted payroll estimate must be one 48,320,000 aggregate, found % / % / %',
      v_count, v_amount, v_source_line_id;
  end if;

  if v_names ~* '(dũng|tú trinh|đạm|ái mi|vân anh)' then
    raise exception 'CHECK FAIL: restricted payroll estimate leaked a person name: %', v_names;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_restricted->'flags') f
    where f->>'code' = 'payroll_person_detail_restricted'
      and not (f ? 'amount')
  ) then
    raise exception 'CHECK FAIL: restricted flag must exist without an amount';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_restricted->'flags') f
    where f->>'code' in (
      'payroll_manual_lines_deduplicated',
      'payroll_manual_lines_deduplicated_prior_month',
      'payroll_last_month_estimate',
      'payroll_unlabelled_payout_pending',
      'payroll_payout_month_fallback'
    )
      and (f ? 'amount')
  ) then
    raise exception 'CHECK FAIL: restricted dedup warning leaked an amount';
  end if;

  select coalesce(sum((x->>'amount')::numeric), 0)
  into v_total
  from jsonb_array_elements(v_restricted->'lines') x
  where x->>'line_code' = 'C6_PAYROLL'
    and x->>'source' = 'payroll_period';

  if v_total <> 244613000 then
    raise exception 'CHECK FAIL: restricted payroll total % != 244613000', v_total;
  end if;

  perform set_config('app.finance_dryrun_restricted_lines', v_count::text, true);
  perform set_config('app.finance_dryrun_restricted_amount', v_amount::text, true);
  perform set_config('app.finance_dryrun_restricted_source', v_source_line_id, true);

  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;

  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user_roles row after restricted check';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;

-- The merchant agent calls with the service role. It must still see actual
-- payroll by payslip group and payout family; only estimates are aggregated.
do $$
declare
  v_owner uuid;
  v_service jsonb;
  v_estimate_count integer;
  v_estimate_amount numeric;
  v_estimate_source text;
  v_actual_count integer;
  v_payslip_groups integer;
  v_payout_families integer;
  v_restricted_actual integer;
  v_total numeric;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('role', 'service_role')::text,
    true
  );

  v_service := public.finance_pnl_accrual('2026-10-01');

  select
    count(*),
    coalesce(sum((x->>'amount')::numeric), 0),
    min(x->>'source_line_id')
  into v_estimate_count, v_estimate_amount, v_estimate_source
  from jsonb_array_elements(v_service->'lines') x
  where x->>'line_code' = 'C6_PAYROLL'
    and x->>'source' = 'payroll_period'
    and coalesce((x->>'is_estimate')::boolean, false);

  if v_estimate_count <> 1 or v_estimate_amount <> 48320000
     or v_estimate_source <> 'prior_people_aggregate' then
    raise exception 'CHECK FAIL: service-role estimate must be one 48,320,000 aggregate, found % / % / %',
      v_estimate_count, v_estimate_amount, v_estimate_source;
  end if;

  select
    count(*),
    count(*) filter (where x->>'source_line_id' ~ '^[0-9a-f-]{36}:'),
    count(*) filter (where x->>'source_line_id' like 'payout_family:%'),
    count(*) filter (
      where x->>'source_line_id' like 'payroll_actual:%'
        or x->>'source_ref' = 'payout_family:restricted'
    )
  into
    v_actual_count,
    v_payslip_groups,
    v_payout_families,
    v_restricted_actual
  from jsonb_array_elements(v_service->'lines') x
  where x->>'line_code' = 'C6_PAYROLL'
    and x->>'source' = 'payroll_period'
    and coalesce((x->>'is_estimate')::boolean, false) = false;

  if v_actual_count < 3
     or v_payslip_groups < 1
     or v_payout_families < 1
     or v_restricted_actual <> 0 then
    raise exception 'CHECK FAIL: service role must see payslip groups and payout families, found actual=% payslip_groups=% payout_families=% restricted=%',
      v_actual_count, v_payslip_groups, v_payout_families, v_restricted_actual;
  end if;

  select coalesce(sum((x->>'amount')::numeric), 0)
  into v_total
  from jsonb_array_elements(v_service->'lines') x
  where x->>'line_code' = 'C6_PAYROLL'
    and x->>'source' = 'payroll_period';

  if v_total <> 244613000 then
    raise exception 'CHECK FAIL: service-role payroll total % != 244613000', v_total;
  end if;

  perform set_config('app.finance_dryrun_service_actual_count', v_actual_count::text, true);
  perform set_config('app.finance_dryrun_service_payslip_groups', v_payslip_groups::text, true);
  perform set_config('app.finance_dryrun_service_payout_families', v_payout_families::text, true);
  perform set_config('app.finance_dryrun_service_estimate_source', v_estimate_source, true);

  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;

  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user_roles row after service-role check';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;

-- When the month has no payslip or payout yet, the fallback must still honour
-- this month's exclusions. The check is skipped visibly if November payroll or
-- a November exclusion already exists in the mutable live data.
do $$
declare
  v_id uuid;
  v_result jsonb;
  v_amount numeric;
  v_expected numeric;
  v_excluded numeric;
  v_count integer;
  v_source_line_id text;
begin
  if exists (
    select 1
    from public.payroll_bn_payslips ps
    join public.payroll_bn_periods p on p.id = ps.period_id
    where date_trunc('month', p.date_from)::date = '2026-11-01'
  ) or exists (
    select 1
    from public.salary_payouts sp
    where sp.status <> 'cancelled'
      and public.finance_pnl_accrual_payout_month(
        sp.period_name,
        sp.ceo_paid_at,
        sp.completed_at,
        sp.created_at
      ) = '2026-11-01'
  ) then
    raise notice 'SKIP: T11 fallback check because November payroll already exists';
    return;
  end if;

  if exists (
    select 1
    from public.finance_payroll_carry_exclusions e
    where e.month = '2026-11-01'
  ) then
    raise notice 'SKIP: T11 fallback check because November exclusions already exist';
    return;
  end if;

  select coalesce(sum((x->>'amount')::numeric), 0)
  into v_expected
  from jsonb_array_elements(public.finance_pnl_accrual('2026-10-01')->'lines') x
  where x->>'line_code' = 'C6_PAYROLL'
    and x->>'source' = 'payroll_period'
    and coalesce((x->>'is_estimate')::boolean, false) = false;

  select coalesce(sum(spl.net_pay), 0)
  into v_excluded
  from public.salary_payout_lines spl
  join public.salary_payouts sp on sp.id = spl.payout_id
  where sp.status <> 'cancelled'
    and public.finance_pnl_accrual_payout_month(
      sp.period_name,
      sp.ceo_paid_at,
      sp.completed_at,
      sp.created_at
    ) = '2026-10-01'
    and public.finance_pnl_accrual_person_key(spl.employee_name)
      = public.finance_pnl_accrual_person_key('Nguyễn Thị Xuân Mai')
    and not exists (
      select 1
      from public.payroll_bn_payslips ps
      join public.payroll_bn_periods p on p.id = ps.period_id
      where date_trunc('month', p.date_from)::date = '2026-10-01'
        and public.finance_pnl_accrual_person_key(ps.employee_name)
          = public.finance_pnl_accrual_person_key(spl.employee_name)
    );

  if coalesce(v_excluded, 0) <= 0 then
    raise notice 'SKIP: T11 fallback check because Xuân Mai has no T10 manual line';
    return;
  end if;

  v_expected := v_expected - v_excluded;

  insert into public.finance_payroll_carry_exclusions (month, person_name, reason)
  values ('2026-11-01', 'Nguyễn Thị Xuân Mai', 'dry-run fallback exclusion')
  on conflict (month, person_key) do nothing
  returning id into v_id;

  v_result := public.finance_pnl_accrual('2026-11-01');

  select
    coalesce(sum((x->>'amount')::numeric), 0),
    count(*),
    min(x->>'source_line_id')
  into v_amount, v_count, v_source_line_id
  from jsonb_array_elements(v_result->'lines') x
  where x->>'line_code' = 'C6_PAYROLL'
    and x->>'source' = 'payroll_period'
    and coalesce((x->>'is_estimate')::boolean, false);

  if v_count <> 1 or v_amount <> v_expected
     or v_source_line_id <> 'prior_total' then
    raise exception 'CHECK FAIL: T11 fallback with exclusion must be one % prior_total line, found % / % / %',
      v_expected, v_count, v_amount, v_source_line_id;
  end if;

  if v_id is not null then
    delete from public.finance_payroll_carry_exclusions where id = v_id;
  end if;
end $$;

-- A stranger without owner/finance edit rights must be rejected by both write
-- RPCs. The owner claim is restored afterwards for the summary query.
do $$
declare
  v_owner uuid;
  v_adjustment_id uuid := current_setting('app.finance_dryrun_adjustment_id', true)::uuid;
  v_stranger uuid := gen_random_uuid();
  v_denied boolean := false;
begin
  perform set_config('request.jwt.claim.sub', v_stranger::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_stranger, 'role', 'authenticated')::text,
    true
  );

  begin
    perform public.finance_manual_adjustment_save(
      p_id => null,
      p_kind => 'opex',
      p_category_code => 'C7_SOCIAL_INSURANCE',
      p_label => 'Unauthorized adjustment',
      p_period_from => '2026-01-01',
      p_period_to => '2026-01-01',
      p_total_amount => 1,
      p_source_ref => 'DRYRUN-DENIED',
      p_note => 'must be rejected'
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;

  if not v_denied then
    raise exception 'CHECK FAIL: a stranger was allowed to save a manual adjustment';
  end if;

  v_denied := false;
  begin
    perform public.finance_manual_adjustment_void(v_adjustment_id);
  exception when insufficient_privilege then
    v_denied := true;
  end;

  if not v_denied then
    raise exception 'CHECK FAIL: a stranger was allowed to void a manual adjustment';
  end if;

  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;

  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user_roles row after denial checks';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;

with x as (
  select public.finance_pnl_accrual('2026-10-01') as pnl
)
select jsonb_pretty(
  jsonb_build_object(
    'totals', pnl->'totals',
    'payroll', jsonb_build_object(
      't10_total', coalesce((
        select sum((line->>'amount')::numeric)
        from jsonb_array_elements(pnl->'lines') line
        where line->>'line_code' = 'C6_PAYROLL'
          and line->>'source' = 'payroll_period'
      ), 0),
      't10_estimate', coalesce((
        select sum((line->>'amount')::numeric)
        from jsonb_array_elements(pnl->'lines') line
        where line->>'line_code' = 'C6_PAYROLL'
          and line->>'source' = 'payroll_period'
          and coalesce((line->>'is_estimate')::boolean, false)
      ), 0),
      't10_estimate_people', coalesce((
        select jsonb_agg(line->>'counterparty' order by line->>'counterparty')
        from jsonb_array_elements(pnl->'lines') line
        where line->>'line_code' = 'C6_PAYROLL'
          and line->>'source' = 'payroll_period'
          and coalesce((line->>'is_estimate')::boolean, false)
      ), '[]'::jsonb),
      't9_total', coalesce((
        select sum((line->>'amount')::numeric)
        from jsonb_array_elements(public.finance_pnl_accrual('2026-09-01')->'lines') line
        where line->>'line_code' = 'C6_PAYROLL'
          and line->>'source' = 'payroll_period'
      ), 0)
    ),
    'service_role_payroll', jsonb_build_object(
      'actual_lines', current_setting('app.finance_dryrun_service_actual_count', true),
      'payslip_group_lines', current_setting('app.finance_dryrun_service_payslip_groups', true),
      'payout_family_lines', current_setting('app.finance_dryrun_service_payout_families', true),
      'estimate_source_line_id', current_setting('app.finance_dryrun_service_estimate_source', true)
    ),
    'restricted_payroll_estimate', jsonb_build_object(
      'lines', current_setting('app.finance_dryrun_restricted_lines', true),
      'amount', current_setting('app.finance_dryrun_restricted_amount', true),
      'source_line_id', current_setting('app.finance_dryrun_restricted_source', true)
    ),
    'manual_bhxh', coalesce((
      select line
      from jsonb_array_elements(pnl->'lines') line
      where line->>'line_code' = 'C7_SOCIAL_INSURANCE'
        and line->>'source' = 'manual_adjustment'
      limit 1
    ), '{}'::jsonb),
    'below_ebitda', pnl->'below_ebitda',
    'bread_supplier', pnl->'bread_supplier',
    'goods_receipts', pnl->'goods_receipts',
    'flags', pnl->'flags'
  )
) as summary
from x;
