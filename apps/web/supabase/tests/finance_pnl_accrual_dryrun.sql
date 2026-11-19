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
--   the missing payout families "lương bh gh" and
--   "lương lẻ bếp tân tạo" have is_estimate payroll lines;
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

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'payroll_period'
      and coalesce((x->>'is_estimate')::boolean, false)
      and x->>'source_ref' like '%lương bh gh%'
  ) then
    raise exception 'CHECK FAIL: missing estimated payroll family "lương bh gh"';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'lines') x
    where x->>'source' = 'payroll_period'
      and coalesce((x->>'is_estimate')::boolean, false)
      and x->>'source_ref' like '%lương lẻ bếp tân tạo%'
  ) then
    raise exception 'CHECK FAIL: missing estimated payroll family "lương lẻ bếp tân tạo"';
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

with x as (
  select public.finance_pnl_accrual('2026-10-01') as pnl
)
select jsonb_pretty(
  jsonb_build_object(
    'totals', pnl->'totals',
    'bread_supplier', pnl->'bread_supplier',
    'goods_receipts', pnl->'goods_receipts',
    'flags', pnl->'flags'
  )
) as summary
from x;
