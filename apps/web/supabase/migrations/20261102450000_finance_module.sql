-- BMQ finance module, phase 1.
--
-- Read-only reporting layer for the owner / finance viewers:
--   * two configuration tables, finance_report_settings and finance_accrual_policies;
--   * one private access helper, finance_can_view(uuid);
--   * one private month-grain P&L source, finance_month_lines(date, date);
--   * five public JSON RPCs: finance_pnl, finance_variance,
--     finance_ap_rollforward, finance_accrual_schedule, finance_close_checklist.
--
-- Nothing here writes revenue, payment, invoice, classification or payroll
-- rows. The only data writes are the two configuration seeds below.

-- ===========================================================================
-- 1. Configuration tables
-- ===========================================================================

create table if not exists public.finance_report_settings (
  id boolean primary key default true check (id),
  materiality_pct numeric not null default 0.05
    check (materiality_pct >= 0 and materiality_pct <= 1),
  materiality_floor_vnd numeric not null default 5000000
    check (materiality_floor_vnd >= 0),
  ap_overdue_days integer not null default 60
    check (ap_overdue_days >= 0),
  classification_coverage_target numeric not null default 0.90
    check (classification_coverage_target >= 0 and classification_coverage_target <= 1),
  updated_at timestamptz not null default now()
);

insert into public.finance_report_settings (id)
values (true)
on conflict (id) do nothing;

create table if not exists public.finance_accrual_policies (
  code text primary key,
  name_en text not null,
  category_code text not null references public.cost_categories(code),
  basis_method text not null
    check (basis_method in ('trailing_3m_avg', 'payroll_last_month')),
  auto_reverse boolean not null default true,
  active boolean not null default true,
  sort_order integer not null default 0
);

insert into public.finance_accrual_policies (
  code, name_en, category_code, basis_method, auto_reverse, active, sort_order
)
values
  ('RENT', 'Warehouse & kitchen rent', 'C1_WAREHOUSE_RENT', 'trailing_3m_avg', true, true, 10),
  ('ELECTRICITY', 'Electricity', 'C2_ELECTRICITY', 'trailing_3m_avg', true, true, 20),
  ('GAS', 'Gas', 'C4_GAS', 'trailing_3m_avg', true, true, 30),
  ('TELECOM', 'Internet & phone', 'C5_TELECOM', 'trailing_3m_avg', true, true, 40),
  ('SOCIAL_INS', 'Social insurance', 'C7_SOCIAL_INSURANCE', 'trailing_3m_avg', true, true, 50),
  ('PAYROLL', 'Payroll', 'C6_PAYROLL', 'payroll_last_month', true, true, 60)
on conflict (code) do nothing;

alter table public.finance_report_settings enable row level security;
alter table public.finance_accrual_policies enable row level security;

drop policy if exists finance_report_settings_select on public.finance_report_settings;
create policy finance_report_settings_select
  on public.finance_report_settings
  for select
  to authenticated
  using (true);

drop policy if exists finance_accrual_policies_select on public.finance_accrual_policies;
create policy finance_accrual_policies_select
  on public.finance_accrual_policies
  for select
  to authenticated
  using (true);

revoke all on public.finance_report_settings from public, anon, authenticated;
revoke all on public.finance_accrual_policies from public, anon, authenticated;

grant select on public.finance_report_settings to authenticated;
grant select on public.finance_accrual_policies to authenticated;
grant all on public.finance_report_settings to service_role;
grant all on public.finance_accrual_policies to service_role;

-- ===========================================================================
-- 2. Private access helper
-- ===========================================================================

create or replace function public.finance_can_view(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or (
        p_user is not null
        and (
          public.has_role(p_user, 'owner')
          or public.has_module_permission(p_user, 'finance_cost', 'view')
          or public.has_module_permission(p_user, 'finance_revenue', 'view')
        )
      );
$$;

revoke all on function public.finance_can_view(uuid) from public, anon, authenticated;

-- ===========================================================================
-- 3. Private month-grain P&L source
-- ===========================================================================
-- One row per amount that can enter the P&L. Revenue is the controlled ledger
-- only: source_document.status in ('controlled','trusted') and the line itself
-- approved. Expenses come from cost_classification_line_details. Payroll comes
-- from non-cancelled salary_payouts.

create or replace function public.finance_month_lines(p_from date, p_to date)
returns table (
  month date,
  section text,
  line_code text,
  line_label_en text,
  product_line text,
  counterparty text,
  amount numeric,
  review_status text,
  source text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with payroll_payouts as (
    select
      sp.id,
      sp.period_name,
      sp.total_amount,
      sp.status,
      coalesce(
        case
          when pm.rx is not null
            and (pm.rx)[2] ~ '^[0-9]{1,2}$'
            and (pm.rx)[3] ~ '^[0-9]{4}$'
            and (pm.rx)[2]::integer between 1 and 12
            and (pm.rx)[3]::integer between 1900 and 2100
          then make_date((pm.rx)[3]::integer, (pm.rx)[2]::integer, 1)
        end,
        date_trunc('month', coalesce(sp.ceo_paid_at, sp.completed_at, sp.created_at))::date
      ) as month
    from public.salary_payouts sp
    cross join lateral (
      select regexp_match(
        sp.period_name,
        '(T|tháng)[[:space:]]*([0-9]{1,2})[[:space:]]*/[[:space:]]*([0-9]{4})',
        'i'
      ) as rx
    ) pm
    where sp.status <> 'cancelled'
  )
  select
    date_trunc('month', l.revenue_date)::date as month,
    'revenue'::text as section,
    l.channel as line_code,
    'Revenue — ' || l.channel as line_label_en,
    case
      when l.channel in ('BÁNH NGỘT', 'BÁNH NGỌT') then 'sweet_kitchen'
      else 'bmq_bread'
    end as product_line,
    l.customer_name as counterparty,
    l.gross_revenue as amount,
    l.review_status as review_status,
    'revenue_ledger'::text as source
  from public.revenue_ledger_lines l
  join public.revenue_source_documents d on d.id = l.source_document_id
  where d.status in ('controlled', 'trusted')
    and l.approval_status = 'approved'
    and l.revenue_date between p_from and p_to

  union all

  select
    date_trunc('month', d.source_date)::date as month,
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
    case d.category_code
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
      else 'Unclassified — ' || d.category_code
    end as line_label_en,
    case
      when d.product_line in ('bmq_bread', 'sweet_kitchen', 'shared') then d.product_line
      else 'shared'
    end as product_line,
    d.supplier_name as counterparty,
    d.line_amount as amount,
    d.review_status as review_status,
    'expense_line'::text as source
  -- Expense base = every line of an APPROVED payment request (paid or not),
  -- dated by the request (Asia/Ho_Chi_Minh). Lines without a classification
  -- row are unclassified, never dropped. invoice_items are not added: every
  -- invoice hangs off a payment request, so they would double count.
  -- Pending requests are not yet expenses; rejected ones never are.
  from (
    select
      (pr.created_at at time zone 'Asia/Ho_Chi_Minh')::date as source_date,
      coalesce(clc.category_code, 'UNMAPPED_REVIEW') as category_code,
      clc.product_line,
      coalesce(s.name, '(no supplier)') as supplier_name,
      coalesce(pri.line_total, pri.quantity * pri.unit_price, 0)::numeric as line_amount,
      coalesce(clc.review_status, 'unclassified') as review_status
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    left join public.suppliers s on s.id = pr.supplier_id
    left join public.cost_line_classifications clc
      on clc.source_type = 'payment_request_item'
      and clc.source_line_id = pri.id
    where pr.status::text = 'approved'
  ) d
  join public.cost_categories cc on cc.code = d.category_code
  left join public.cost_categories parent on parent.code = cc.parent_code
  where d.source_date between p_from and p_to

  union all

  select
    p.month,
    'operating'::text as section,
    'C6_PAYROLL_PAYOUTS'::text as line_code,
    'Payroll (salary payouts)'::text as line_label_en,
    'shared'::text as product_line,
    p.period_name as counterparty,
    p.total_amount as amount,
    p.status as review_status,
    'payroll'::text as source
  from payroll_payouts p
  where p.month between date_trunc('month', p_from)::date and date_trunc('month', p_to)::date;
$$;

revoke all on function public.finance_month_lines(date, date) from public, anon, authenticated;

-- ===========================================================================
-- 4. finance_pnl
-- ===========================================================================

create or replace function public.finance_pnl(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_start date;
  v_end date;
  v_month_count integer;
  v_result jsonb;
begin
  if not public.finance_can_view(auth.uid()) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_from is null or p_to is null then
    raise exception 'invalid_period' using errcode = '22023';
  end if;

  v_start := date_trunc('month', p_from)::date;
  v_end := date_trunc('month', p_to)::date;

  if v_end < v_start then
    raise exception 'invalid_period' using errcode = '22023';
  end if;

  v_month_count := (
    (extract(year from v_end) - extract(year from v_start)) * 12
    + (extract(month from v_end) - extract(month from v_start))
  )::integer + 1;

  if v_month_count > 24 then
    raise exception 'finance_pnl supports at most 24 months' using errcode = '22023';
  end if;

  with months as (
    select generate_series(v_start, v_end, interval '1 month')::date as month
  ),
  ml as (
    select * from public.finance_month_lines(p_from, p_to)
  ),
  settings as (
    select materiality_pct, materiality_floor_vnd, classification_coverage_target
    from public.finance_report_settings
    where id = true
  ),
  line_keys as (
    select distinct on (section, line_code)
      section, line_code, line_label_en
    from ml
    order by section, line_code, line_label_en
  ),
  line_amounts as (
    select month, section, line_code, sum(amount) as amount
    from ml
    group by month, section, line_code
  ),
  lines_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'section', x.section,
          'line_code', x.line_code,
          'label', x.label,
          'amounts', x.amounts
        )
        order by x.section_order, x.line_code
      ),
      '[]'::jsonb
    ) as value
    from (
      select
        k.section,
        k.line_code,
        k.line_label_en as label,
        case k.section
          when 'revenue' then 10
          when 'cogs' then 20
          when 'selling' then 30
          when 'operating' then 40
          when 'unclassified' then 50
          when 'capex' then 60
          else 90
        end as section_order,
        jsonb_object_agg(to_char(m.month, 'YYYY-MM'), la.amount order by m.month) as amounts
      from line_keys k
      cross join months m
      left join line_amounts la
        on la.month = m.month
        and la.section = k.section
        and la.line_code = k.line_code
      group by k.section, k.line_code, k.line_label_en
    ) x
  ),
  month_agg as (
    select
      m.month,
      sum(l.amount) filter (where l.section = 'revenue') as revenue,
      count(*) filter (where l.section = 'revenue') as revenue_lines,
      sum(l.amount) filter (where l.section = 'cogs') as cogs,
      count(*) filter (where l.section = 'cogs') as cogs_lines,
      sum(l.amount) filter (where l.section = 'selling') as selling,
      count(*) filter (where l.section = 'selling') as selling_lines,
      sum(l.amount) filter (where l.section = 'operating') as operating,
      count(*) filter (where l.section = 'operating') as operating_lines,
      sum(l.amount) filter (where l.section = 'unclassified') as unclassified,
      count(*) filter (where l.section = 'unclassified') as unclassified_lines,
      sum(l.amount) filter (where l.section = 'capex') as capex,
      count(*) filter (where l.section = 'capex') as capex_lines,
      count(*) filter (where l.source = 'expense_line') as expense_lines,
      count(*) filter (where l.source = 'payroll') as payroll_lines,
      count(*) filter (where l.section = 'operating' and l.line_code = 'C6_PAYROLL') as c6_payroll_lines
    from months m
    left join ml l on l.month = m.month
    group by m.month
  ),
  month_totals as (
    select
      month,
      revenue,
      revenue_lines,
      cogs,
      cogs_lines,
      selling,
      selling_lines,
      operating,
      operating_lines,
      unclassified,
      unclassified_lines,
      capex,
      capex_lines,
      expense_lines,
      payroll_lines,
      c6_payroll_lines,
      -- A month with revenue but no lines in an expense section counts that
      -- section as 0 (the *_missing flags say so); no revenue means null.
      case
        when revenue is not null then revenue - coalesce(cogs, 0)
        else null
      end as gross_profit,
      case
        when revenue is not null and revenue <> 0
          then round((revenue - coalesce(cogs, 0)) / revenue, 4)
        else null
      end as gross_margin
    from month_agg
  ),
  month_ebitda as (
    select
      *,
      case
        when gross_profit is not null
          then gross_profit - coalesce(selling, 0) - coalesce(operating, 0) - coalesce(unclassified, 0)
        else null
      end as ebitda
    from month_totals
  ),
  month_final as (
    select
      *,
      case
        when revenue is not null and revenue <> 0 and ebitda is not null
          then round(ebitda / revenue, 4)
        else null
      end as ebitda_margin
    from month_ebitda
  ),
  totals_json as (
    select coalesce(
      jsonb_object_agg(
        to_char(month, 'YYYY-MM'),
        jsonb_build_object(
          'revenue', revenue,
          'cogs', cogs,
          'gross_profit', gross_profit,
          'gross_margin', gross_margin,
          'selling', selling,
          'operating', operating,
          'unclassified', unclassified,
          'ebitda', ebitda,
          'ebitda_margin', ebitda_margin,
          'capex', capex
        )
        order by month
      ),
      '{}'::jsonb
    ) as value
    from month_final
  ),
  product_month as (
    select
      m.month,
      sum(l.amount) filter (where l.section = 'revenue' and l.product_line = 'bmq_bread') as bread_revenue,
      count(*) filter (where l.section = 'revenue' and l.product_line = 'bmq_bread') as bread_revenue_lines,
      sum(l.amount) filter (where l.section = 'cogs' and l.product_line = 'bmq_bread') as bread_cost,
      count(*) filter (where l.section = 'cogs' and l.product_line = 'bmq_bread') as bread_cost_lines,
      sum(l.amount) filter (where l.section = 'revenue' and l.product_line = 'sweet_kitchen') as sweet_revenue,
      count(*) filter (where l.section = 'revenue' and l.product_line = 'sweet_kitchen') as sweet_revenue_lines,
      sum(l.amount) filter (where l.section = 'cogs' and l.product_line = 'sweet_kitchen') as sweet_cost,
      count(*) filter (where l.section = 'cogs' and l.product_line = 'sweet_kitchen') as sweet_cost_lines,
      sum(l.amount) filter (
        where l.section in ('cogs', 'selling', 'operating', 'unclassified')
          and l.product_line = 'shared'
      ) as shared_costs,
      count(*) filter (
        where l.section in ('cogs', 'selling', 'operating', 'unclassified')
          and l.product_line = 'shared'
      ) as shared_lines
    from months m
    left join ml l on l.month = m.month
    group by m.month
  ),
  product_json as (
    select coalesce(
      jsonb_object_agg(
        to_char(month, 'YYYY-MM'),
        jsonb_build_object(
          'bmq_bread', jsonb_build_object(
            'revenue', bread_revenue,
            'direct_costs', bread_cost,
            'contribution', case
              when bread_revenue is not null and bread_cost is not null
                then bread_revenue - bread_cost
              else null
            end
          ),
          'sweet_kitchen', jsonb_build_object(
            'revenue', sweet_revenue,
            'direct_costs', sweet_cost,
            'contribution', case
              when sweet_revenue is not null and sweet_cost is not null
                then sweet_revenue - sweet_cost
              else null
            end
          ),
          'shared_costs', shared_costs
        )
        order by month
      ),
      '{}'::jsonb
    ) as value
    from product_month
  ),
  coverage_month as (
    select
      m.month,
      sum(l.amount) filter (where l.source = 'expense_line') as expense_total,
      sum(l.amount) filter (
        where l.source = 'expense_line' and l.section <> 'unclassified'
      ) as classified_amount,
      sum(l.amount) filter (
        where l.source = 'expense_line' and l.review_status = 'suggested'
      ) as suggested_amount,
      sum(l.amount) filter (
        where l.source = 'expense_line' and l.review_status = 'approved'
      ) as approved_amount,
      count(*) filter (where l.source = 'expense_line') as expense_lines
    from months m
    left join ml l on l.month = m.month
    group by m.month
  ),
  coverage_calc as (
    select
      month,
      expense_total,
      case when expense_total is not null then coalesce(classified_amount, 0) else null end as classified_amount,
      case when expense_total is not null then coalesce(suggested_amount, 0) else null end as suggested_amount,
      case when expense_total is not null then coalesce(approved_amount, 0) else null end as approved_amount
    from coverage_month
  ),
  coverage_json as (
    select coalesce(
      jsonb_object_agg(
        to_char(month, 'YYYY-MM'),
        jsonb_build_object(
          'expense_total', expense_total,
          'classified_amount', classified_amount,
          'classified_pct', case
            when expense_total is not null and expense_total <> 0
              then round(classified_amount / expense_total, 4)
            else null
          end,
          'suggested_amount', suggested_amount,
          'approved_amount', approved_amount
        )
        order by month
      ),
      '{}'::jsonb
    ) as value
    from coverage_calc
  ),
  flag_rows as (
    select month, 'revenue_missing'::text as code,
      'No approved controlled revenue lines for this month.'::text as detail_en
    from month_agg where revenue_lines = 0
    union all
    select month, 'cogs_missing',
      'No COGS-classified expense lines for this month.'
    from month_agg where cogs_lines = 0
    union all
    select month, 'selling_missing',
      'No selling-classified expense lines for this month.'
    from month_agg where selling_lines = 0
    union all
    select month, 'operating_missing',
      'No operating-classified expense lines for this month.'
    from month_agg where operating_lines = 0
    union all
    select month, 'unclassified_missing',
      'No unclassified expense lines for this month.'
    from month_agg where unclassified_lines = 0
    union all
    select month, 'capex_missing',
      'No capex-classified expense lines for this month.'
    from month_agg where capex_lines = 0
    union all
    select month, 'expense_missing',
      'No classified expense lines for this month.'
    from month_agg where expense_lines = 0
    union all
    select month, 'payroll_missing',
      'No non-cancelled salary payout found for this month.'
    from month_agg where payroll_lines = 0
    union all
    select month, 'payroll_double_count_risk',
      'Payroll payouts and C6_PAYROLL expense lines both exist for this month; payroll may be counted twice.'
    from month_agg where payroll_lines > 0 and c6_payroll_lines > 0
    union all
    select month, 'unclassified_present',
      'Expense lines remain on UNMAPPED_REVIEW or an inactive/legacy category.'
    from month_agg where coalesce(unclassified, 0) <> 0
    union all
    select c.month, 'coverage_below_target',
      'Classification coverage is below the configured target.'
    from coverage_calc c
    cross join settings s
    where c.expense_total is not null
      and c.expense_total <> 0
      and (c.classified_amount / c.expense_total) < s.classification_coverage_target
  ),
  flags_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'code', code,
          'month', to_char(month, 'YYYY-MM'),
          'detail_en', detail_en
        )
        order by month, code
      ),
      '[]'::jsonb
    ) as value
    from flag_rows
  )
  select jsonb_build_object(
    'from', v_start,
    'to', v_end,
    'currency', 'VND',
    'months', (
      select coalesce(jsonb_agg(to_char(month, 'YYYY-MM') order by month), '[]'::jsonb)
      from months
    ),
    'lines', (select value from lines_json),
    'totals', (select value from totals_json),
    'by_product_line', (select value from product_json),
    'coverage', (select value from coverage_json),
    'flags', (select value from flags_json)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.finance_pnl(date, date) from public, anon;
grant execute on function public.finance_pnl(date, date) to authenticated, service_role;

-- ===========================================================================
-- 5. finance_variance
-- ===========================================================================

create or replace function public.finance_variance(p_month date)
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
  v_pct numeric;
  v_floor numeric;
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
  v_prior_start := (v_start - interval '1 month')::date;
  v_prior_end := (v_start - interval '1 day')::date;

  select materiality_pct, materiality_floor_vnd
    into v_pct, v_floor
  from public.finance_report_settings
  where id = true;

  v_pct := coalesce(v_pct, 0.05);
  v_floor := coalesce(v_floor, 5000000);

  with ml as (
    select * from public.finance_month_lines(v_prior_start, v_end)
  ),
  leaf_defs as (
    select
      'leaf'::text as level,
      d.section,
      d.line_code,
      d.line_label_en as label,
      jsonb_build_object(d.section, 1) as section_signs,
      array[d.section] as scope_sections,
      array[d.line_code] as scope_line_codes,
      (d.line_code in ('C6_PAYROLL', 'C6_PAYROLL_PAYOUTS')) as always_flag,
      case d.section
        when 'revenue' then 10
        when 'cogs' then 20
        when 'selling' then 30
        when 'operating' then 40
        when 'unclassified' then 50
        when 'capex' then 60
        else 90
      end as section_order
    from (
      select distinct on (section, line_code)
        section, line_code, line_label_en
      from ml
      order by section, line_code, line_label_en
    ) d
  ),
  subtotal_defs as (
    select
      'subtotal'::text as level,
      'revenue'::text as section,
      'REVENUE_TOTAL'::text as line_code,
      'Revenue total'::text as label,
      jsonb_build_object('revenue', 1) as section_signs,
      array['revenue'] as scope_sections,
      null::text[] as scope_line_codes,
      true as always_flag,
      15 as section_order
    union all
    select
      'subtotal', 'cogs', 'COGS_TOTAL', 'COGS total',
      jsonb_build_object('cogs', 1),
      array['cogs'], null::text[], false, 25
    union all
    select
      'subtotal', 'summary', 'GROSS_PROFIT', 'Gross profit',
      jsonb_build_object('revenue', 1, 'cogs', -1),
      array['revenue', 'cogs'], null::text[], false, 30
    union all
    select
      'subtotal', 'selling', 'SELLING_TOTAL', 'Selling total',
      jsonb_build_object('selling', 1),
      array['selling'], null::text[], false, 35
    union all
    select
      'subtotal', 'operating', 'OPERATING_TOTAL', 'Operating total',
      jsonb_build_object('operating', 1),
      array['operating'], null::text[], false, 45
    union all
    select
      'subtotal', 'operating', 'PAYROLL_TOTAL', 'Payroll total',
      jsonb_build_object('operating', 1),
      array['operating'], array['C6_PAYROLL', 'C6_PAYROLL_PAYOUTS'], true, 46
    union all
    select
      'subtotal', 'unclassified', 'UNCLASSIFIED_TOTAL', 'Unclassified total',
      jsonb_build_object('unclassified', 1),
      array['unclassified'], null::text[], false, 50
    union all
    select
      'subtotal', 'summary', 'EBITDA', 'EBITDA',
      jsonb_build_object('revenue', 1, 'cogs', -1, 'selling', -1, 'operating', -1, 'unclassified', -1),
      array['revenue', 'cogs', 'selling', 'operating', 'unclassified'], null::text[], true, 55
    union all
    select
      'subtotal', 'capex', 'CAPEX_TOTAL', 'Capex total',
      jsonb_build_object('capex', 1),
      array['capex'], null::text[], false, 60
  ),
  line_defs as (
    select * from leaf_defs
    union all
    select * from subtotal_defs
  ),
  line_values as (
    select
      ld.level,
      ld.section,
      ld.line_code,
      ld.label,
      ld.section_signs,
      ld.scope_sections,
      ld.scope_line_codes,
      ld.always_flag,
      ld.section_order,
      case
        when count(d.amount) filter (where d.month = v_start) > 0
          then sum(d.amount * (ld.section_signs ->> d.section)::numeric)
            filter (where d.month = v_start)
        else null
      end as current,
      case
        when count(d.amount) filter (where d.month = v_prior_start) > 0
          then sum(d.amount * (ld.section_signs ->> d.section)::numeric)
            filter (where d.month = v_prior_start)
        else null
      end as prior
    from line_defs ld
    left join ml d
      on d.section = any(ld.scope_sections)
      and (ld.scope_line_codes is null or d.line_code = any(ld.scope_line_codes))
      and d.month in (v_start, v_prior_start)
    group by
      ld.level, ld.section, ld.line_code, ld.label, ld.section_signs,
      ld.scope_sections, ld.scope_line_codes, ld.always_flag, ld.section_order
  ),
  variance_calc as (
    select
      *,
      case when current is not null and prior is not null then current - prior else null end as delta,
      case
        when current is not null and prior is not null and prior <> 0
          then round((current - prior) / prior, 4)
        else null
      end as delta_pct,
      case
        when prior is not null then greatest(v_pct * abs(prior), v_floor)
        else null
      end as threshold
    from line_values
  ),
  variance_flag as (
    select
      *,
      case
        when always_flag then true
        when current is not null and prior is null then true
        when current is not null and prior is not null and abs(delta) >= threshold then true
        else false
      end as flagged,
      case
        when always_flag then 'always'
        when current is not null and prior is null then 'no_prior'
        when current is not null and prior is not null and abs(delta) >= threshold then 'material'
        else 'below_materiality'
      end as flag_reason
    from variance_calc
  ),
  with_drivers as (
    select
      vf.*,
      case when vf.flagged then coalesce(dr.drivers, '[]'::jsonb) else '[]'::jsonb end as drivers,
      case
        when vf.flagged and vf.delta is not null and vf.delta <> 0
          and dr.explained is not null
          and abs(dr.explained) >= 0.5 * abs(vf.delta)
          then case when vf.delta > 0 then 'Up ' else 'Down ' end
            || to_char(abs(vf.delta) / 1000000, 'FM999999999990.0') || 'M, mainly '
            || dr.phrase || '.'
        when vf.flagged then 'Driver unclear — flag for controller.'
        else null
      end as driver_text
    from variance_flag vf
    left join lateral (
      select
        jsonb_agg(
          jsonb_build_object(
            'counterparty', x.counterparty,
            'current', x.current_amount,
            'prior', x.prior_amount,
            'delta', x.delta
          )
          order by abs(x.delta) desc, x.counterparty
        ) as drivers,
        case
          when count(*) = 1 then max(x.piece)
          when count(*) = 2 then
            (array_agg(x.piece order by abs(x.delta) desc, x.counterparty))[1]
            || ' and '
            || (array_agg(x.piece order by abs(x.delta) desc, x.counterparty))[2]
          when count(*) >= 3 then
            (array_agg(x.piece order by abs(x.delta) desc, x.counterparty))[1]
            || ', '
            || (array_agg(x.piece order by abs(x.delta) desc, x.counterparty))[2]
            || ' and '
            || (array_agg(x.piece order by abs(x.delta) desc, x.counterparty))[3]
          else null
        end as phrase,
        sum(x.delta) as explained
      from (
       select * from (
        select
          d0.counterparty,
          d0.current_amount,
          d0.prior_amount,
          coalesce(d0.current_amount, 0) - coalesce(d0.prior_amount, 0) as delta,
          d0.counterparty || ' ('
            || case when coalesce(d0.current_amount, 0) - coalesce(d0.prior_amount, 0) >= 0 then '+' else '-' end
            || to_char(abs(coalesce(d0.current_amount, 0) - coalesce(d0.prior_amount, 0)) / 1000000, 'FM999999999990.0')
            || 'M)' as piece
        from (
          select
            coalesce(d.counterparty, 'Unknown') as counterparty,
            sum(d.amount * (vf.section_signs ->> d.section)::numeric)
              filter (where d.month = v_start) as current_amount,
            sum(d.amount * (vf.section_signs ->> d.section)::numeric)
              filter (where d.month = v_prior_start) as prior_amount
          from ml d
          where d.section = any(vf.scope_sections)
            and (vf.scope_line_codes is null or d.line_code = any(vf.scope_line_codes))
            and d.month in (v_start, v_prior_start)
          group by coalesce(d.counterparty, 'Unknown')
        ) d0
       ) x0
       where x0.delta is not null
         and x0.delta * (
           case when vf.delta > 0 then 1 when vf.delta < 0 then -1 else 0 end
         ) > 0
       order by abs(x0.delta) desc, x0.counterparty
       limit 3
      ) x
    ) dr on vf.flagged and vf.delta is not null and vf.delta <> 0
  ),
  variance_lines as (
    select
      level,
      section,
      line_code,
      label,
      current,
      prior,
      delta,
      delta_pct,
      null::numeric as budget,
      'not_set'::text as budget_status,
      flagged,
      flag_reason,
      drivers,
      driver_text,
      section_order
    from with_drivers
  ),
  movers as (
    select
      label,
      delta,
      row_number() over (order by abs(delta) desc, line_code) as rn
    from variance_lines
    where level = 'leaf' and delta is not null
  ),
  mover_text as (
    select string_agg(
      label || ' (' || case when delta > 0 then 'up ' else 'down ' end
        || to_char(abs(delta) / 1000000, 'FM999999999990.0') || 'M)',
      '; '
      order by rn
    ) as value
    from movers
    where rn <= 3
  )
  select jsonb_build_object(
    'month', to_char(v_start, 'YYYY-MM'),
    'prior_month', to_char(v_prior_start, 'YYYY-MM'),
    'currency', 'VND',
    'materiality', jsonb_build_object(
      'pct', v_pct,
      'floor_vnd', v_floor
    ),
    'lines', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'level', level,
            'section', section,
            'line_code', line_code,
            'label', label,
            'current', current,
            'prior', prior,
            'delta', delta,
            'delta_pct', delta_pct,
            'budget', budget,
            'budget_status', budget_status,
            'flagged', flagged,
            'flag_reason', flag_reason,
            'drivers', drivers,
            'driver_text', driver_text
          )
          order by section_order, level, line_code
        ),
        '[]'::jsonb
      )
      from variance_lines
    ),
    'summary', (
      to_char(v_start, 'YYYY-MM') || ' compared with ' || to_char(v_prior_start, 'YYYY-MM') || '. '
      || coalesce(
        (select 'Largest leaf movements: ' || value || '.' from mover_text),
        'No leaf movement is available.'
      ) || ' '
      || 'Materiality is ' || to_char(v_pct * 100, 'FM999990.0')
      || '% of the prior amount with a floor of '
      || to_char(v_floor / 1000000, 'FM999999999990.0') || 'M. '
      || 'Drivers are shown only when the top three counterparties explain at least half of a movement; otherwise the line is flagged for the controller.'
    ),
    'flags', '[]'::jsonb
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.finance_variance(date) from public, anon;
grant execute on function public.finance_variance(date) to authenticated, service_role;

-- ===========================================================================
-- 6. finance_ap_rollforward
-- ===========================================================================

create or replace function public.finance_ap_rollforward(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_start date;
  v_next date;
  v_end date;
  v_opening numeric;
  v_additions numeric;
  v_payments numeric;
  v_adjustments numeric := 0;
  v_closing_computed numeric;
  v_closing_actual numeric;
  v_diff numeric;
  v_foot_pass boolean;
  v_overdue_days integer;
  v_overdue_count integer;
  v_overdue_amount numeric;
  v_aging jsonb;
  v_suppliers jsonb;
  v_lines jsonb;
  v_flags jsonb := '["adjustments_not_tracked"]'::jsonb;
  v_result jsonb;
begin
  if not public.finance_can_view(auth.uid()) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_month is null then
    raise exception 'invalid_period' using errcode = '22023';
  end if;

  v_start := date_trunc('month', p_month)::date;
  v_next := (v_start + interval '1 month')::date;
  v_end := (v_next - interval '1 day')::date;

  select ap_overdue_days into v_overdue_days
  from public.finance_report_settings
  where id = true;
  v_overdue_days := coalesce(v_overdue_days, 60);

  select coalesce(sum(total_amount), 0)
    into v_opening
  from public.payment_requests
  where status::text = 'approved'
    and created_at < v_start
    and (paid_at is null or paid_at >= v_start);

  select coalesce(sum(total_amount), 0)
    into v_additions
  from public.payment_requests
  where status::text = 'approved'
    and created_at >= v_start
    and created_at < v_next;

  select coalesce(sum(total_amount), 0)
    into v_payments
  from public.payment_requests
  where status::text = 'approved'
    and paid_at >= v_start
    and paid_at < v_next;

  v_adjustments := 0;
  v_closing_computed := v_opening + v_additions - v_payments - v_adjustments;

  select coalesce(sum(total_amount), 0)
    into v_closing_actual
  from public.payment_requests
  where status::text = 'approved'
    and created_at < v_next
    and (paid_at is null or paid_at >= v_next);

  v_diff := v_closing_actual - v_closing_computed;
  v_foot_pass := abs(v_diff) < 1;

  if not v_foot_pass then
    v_flags := v_flags || jsonb_build_array('foot_mismatch');
  end if;

  select count(*)::integer, coalesce(sum(total_amount), 0)
    into v_overdue_count, v_overdue_amount
  from public.payment_requests
  where status::text = 'approved'
    and created_at < v_next
    and (paid_at is null or paid_at >= v_next)
    and (v_end - created_at::date) > v_overdue_days;

  if v_overdue_count > 0 then
    v_flags := v_flags || jsonb_build_array('overdue_payables');
  end if;

  with closing as (
    select total_amount, created_at::date as created_date
    from public.payment_requests
    where status::text = 'approved'
      and created_at < v_next
      and (paid_at is null or paid_at >= v_next)
  ),
  buckets as (
    select *
    from (values
      (1, '0-30', 0, 30),
      (2, '31-60', 31, 60),
      (3, '61-90', 61, 90),
      (4, '90+', 91, null)
    ) b(ord, bucket, lo, hi)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'bucket', b.bucket,
        'count', coalesce(a.cnt, 0),
        'amount', coalesce(a.amt, 0)
      )
      order by b.ord
    ),
    '[]'::jsonb
  )
  into v_aging
  from buckets b
  left join lateral (
    select count(*)::integer as cnt, coalesce(sum(c.total_amount), 0) as amt
    from closing c
    where (v_end - c.created_date) >= b.lo
      and (b.hi is null or (v_end - c.created_date) <= b.hi)
  ) a on true;

  with closing as (
    select pr.supplier_id, pr.total_amount
    from public.payment_requests pr
    where pr.status::text = 'approved'
      and pr.created_at < v_next
      and (pr.paid_at is null or pr.paid_at >= v_next)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'supplier_id', t.supplier_id,
        'supplier_name', t.supplier_name,
        'amount', t.amount,
        'count', t.cnt
      )
      order by t.amount desc, t.supplier_name
    ),
    '[]'::jsonb
  )
  into v_suppliers
  from (
    select
      c.supplier_id,
      coalesce(s.name, 'Unknown supplier') as supplier_name,
      sum(c.total_amount) as amount,
      count(*)::integer as cnt
    from closing c
    left join public.suppliers s on s.id = c.supplier_id
    group by c.supplier_id, s.name
    order by sum(c.total_amount) desc nulls last, coalesce(s.name, 'Unknown supplier')
    limit 10
  ) t;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'code', 'opening',
      'label', 'Opening payables',
      'amount', v_opening,
      'ties_to', 'payment_requests: status = approved, created_at < period start, paid_at null or >= period start'
    ),
    jsonb_build_object(
      'code', 'additions',
      'label', 'Additions',
      'amount', v_additions,
      'ties_to', 'payment_requests: status = approved, created_at >= period start and < period end exclusive'
    ),
    jsonb_build_object(
      'code', 'payments',
      'label', 'Payments',
      'amount', v_payments,
      'ties_to', 'payment_requests: status = approved, paid_at >= period start and < period end exclusive, sum(total_amount)'
    ),
    jsonb_build_object(
      'code', 'adjustments',
      'label', 'Adjustments',
      'amount', v_adjustments,
      'ties_to', 'payment_requests: rejected/cancelled in month; no status-change timestamp exists, so amount is 0 and adjustments_not_tracked is set'
    ),
    jsonb_build_object(
      'code', 'closing_computed',
      'label', 'Closing payables (computed)',
      'amount', v_closing_computed,
      'ties_to', 'opening + additions - payments - adjustments; no plug'
    ),
    jsonb_build_object(
      'code', 'closing_actual',
      'label', 'Closing payables (actual)',
      'amount', v_closing_actual,
      'ties_to', 'payment_requests: status = approved, created_at < period end exclusive, paid_at null or >= period end exclusive'
    )
  );

  v_result := jsonb_build_object(
    'month', to_char(v_start, 'YYYY-MM'),
    'currency', 'VND',
    'opening', v_opening,
    'additions', v_additions,
    'payments', v_payments,
    'adjustments', v_adjustments,
    'closing_computed', v_closing_computed,
    'closing_actual', v_closing_actual,
    'lines', v_lines,
    'foot', jsonb_build_object(
      'pass', v_foot_pass,
      'diff', v_diff,
      'unexplained_delta', v_diff
    ),
    'aging', v_aging,
    'top_suppliers', v_suppliers,
    'overdue', jsonb_build_object(
      'days_threshold', v_overdue_days,
      'count', v_overdue_count,
      'amount', v_overdue_amount
    ),
    'flags', v_flags
  );

  return v_result;
end;
$$;

revoke all on function public.finance_ap_rollforward(date) from public, anon;
grant execute on function public.finance_ap_rollforward(date) to authenticated, service_role;

-- ===========================================================================
-- 7. finance_accrual_schedule
-- ===========================================================================

create or replace function public.finance_accrual_schedule(p_month date)
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
  v_is_past boolean;
  v_policy public.finance_accrual_policies%rowtype;
  v_basis numeric;
  v_months text[];
  v_already numeric;
  v_current_count integer;
  v_accrual numeric;
  v_support text;
  v_draft jsonb;
  v_policy_flags jsonb;
  v_policy_json jsonb;
  v_policies jsonb := '[]'::jsonb;
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
  v_is_past := v_start <= date_trunc('month', current_date)::date;

  for v_policy in
    select *
    from public.finance_accrual_policies
    where active
    order by sort_order, code
  loop
    v_basis := null;
    v_months := array[]::text[];
    v_already := 0;
    v_current_count := 0;

    if v_policy.basis_method = 'payroll_last_month' then
      select
        sum(ml.amount),
        array_agg(distinct to_char(ml.month, 'YYYY-MM') order by to_char(ml.month, 'YYYY-MM'))
        into v_basis, v_months
      from public.finance_month_lines(
        (v_start - interval '1 month')::date,
        v_prior_end
      ) ml
      where ml.source = 'payroll'
        and ml.month = (v_start - interval '1 month')::date;

      select coalesce(sum(ml.amount), 0), count(*)::integer
        into v_already, v_current_count
      from public.finance_month_lines(v_start, v_end) ml
      where ml.source = 'payroll';
    else
      select avg(monthly.amount), array_agg(monthly.month_key order by monthly.month_key)
        into v_basis, v_months
      from (
        select
          ml.month,
          to_char(ml.month, 'YYYY-MM') as month_key,
          sum(ml.amount) as amount
        from public.finance_month_lines(v_prior_start, v_prior_end) ml
        where ml.source = 'expense_line'
          and ml.line_code = v_policy.category_code
          and ml.month >= (v_start - interval '3 months')::date
          and ml.month <= (v_start - interval '1 month')::date
        group by ml.month
      ) monthly;

      select coalesce(sum(ml.amount), 0), count(*)::integer
        into v_already, v_current_count
      from public.finance_month_lines(v_start, v_end) ml
      where ml.source = 'expense_line'
        and ml.line_code = v_policy.category_code;
    end if;

    v_months := coalesce(v_months, array[]::text[]);
    v_support := 'Avg of '
      || coalesce(nullif(array_to_string(v_months, ', '), ''), 'no complete months')
      || ' per cost classification';

    v_accrual := case
      when v_is_past and v_basis is not null
        then greatest(v_basis - v_already, 0)
      else null
    end;

    v_policy_flags := '[]'::jsonb;
    if v_basis is null then
      v_policy_flags := v_policy_flags || jsonb_build_array('no_history');
    end if;
    if not v_is_past then
      v_policy_flags := v_policy_flags || jsonb_build_array('future_period');
    end if;
    if v_current_count = 0 then
      v_policy_flags := v_policy_flags || jsonb_build_array('no_current_bookings');
    end if;

    v_draft := case
      when v_accrual is null then null
      else jsonb_build_object(
        'debit', v_policy.name_en || ' expense',
        'credit', 'Accrued expenses',
        'amount', v_accrual,
        'memo', v_policy.name_en || ' — ' || to_char(v_start, 'YYYY-MM')
          || ' accrual per ' || v_support
          || case when v_policy.auto_reverse
            then '; reverses on day 1 of next period'
            else ''
          end
      )
    end;

    v_policy_json := jsonb_build_object(
      'code', v_policy.code,
      'name_en', v_policy.name_en,
      'category_code', v_policy.category_code,
      'basis_method', v_policy.basis_method,
      'basis', v_basis,
      'months_used', to_jsonb(v_months),
      'already_booked', v_already,
      'accrual', v_accrual,
      'support', v_support,
      'draft_je', v_draft,
      'status', 'draft — not posted',
      'flags', v_policy_flags
    );

    v_policies := v_policies || jsonb_build_array(v_policy_json);
  end loop;

  v_result := jsonb_build_object(
    'month', to_char(v_start, 'YYYY-MM'),
    'currency', 'VND',
    'policies', v_policies
  );

  return v_result;
end;
$$;

revoke all on function public.finance_accrual_schedule(date) from public, anon;
grant execute on function public.finance_accrual_schedule(date) to authenticated, service_role;

-- ===========================================================================
-- 8. finance_close_checklist
-- ===========================================================================

create or replace function public.finance_close_checklist(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_start date;
  v_end date;
  v_pnl jsonb;
  v_ap jsonb;
  v_coverage jsonb;
  v_target numeric;
  v_classified_pct numeric;
  v_checks jsonb := '[]'::jsonb;
  v_check jsonb;
  v_approved_lines integer;
  v_pending_lines integer;
  v_approved_amount numeric;
  v_review_count integer;
  v_review_amount numeric;
  v_payroll_count integer;
  v_payroll_amount numeric;
  v_c6_count integer;
  v_legacy_count integer;
  v_legacy_amount numeric;
  v_overdue jsonb;
  v_overdue_count integer;
  v_overdue_amount numeric;
  v_foot jsonb;
  v_foot_pass boolean;
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

  v_pnl := public.finance_pnl(v_start, v_end);
  v_ap := public.finance_ap_rollforward(v_start);
  v_coverage := coalesce(v_pnl -> 'coverage' -> to_char(v_start, 'YYYY-MM'), '{}'::jsonb);
  v_classified_pct := (v_coverage ->> 'classified_pct')::numeric;

  select classification_coverage_target
    into v_target
  from public.finance_report_settings
  where id = true;
  v_target := coalesce(v_target, 0.90);

  select
    count(*) filter (where l.approval_status = 'approved')::integer,
    count(*) filter (where coalesce(l.approval_status, 'pending') = 'pending')::integer,
    coalesce(sum(l.gross_revenue) filter (where l.approval_status = 'approved'), 0)
    into v_approved_lines, v_pending_lines, v_approved_amount
  from public.revenue_ledger_lines l
  join public.revenue_source_documents d on d.id = l.source_document_id
  where d.status in ('controlled', 'trusted')
    and l.revenue_date between v_start and v_end;

  v_check := jsonb_build_object(
    'code', 'REVENUE_CONTROLLED',
    'title_en', 'Controlled revenue approved',
    'status', case
      when v_approved_lines = 0 then 'fail'
      when v_pending_lines > 0 then 'warn'
      else 'pass'
    end,
    'value', jsonb_build_object(
      'approved_lines', v_approved_lines,
      'pending_lines', v_pending_lines,
      'approved_amount', v_approved_amount
    ),
    'detail_en', case
      when v_approved_lines = 0 then 'No approved controlled revenue line exists for the month.'
      when v_pending_lines > 0 then 'Approved controlled revenue exists, but some controlled lines are still pending approval.'
      else 'Approved controlled revenue lines exist for the month.'
    end
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  v_check := jsonb_build_object(
    'code', 'EXPENSE_COVERAGE',
    'title_en', 'Expense classification coverage',
    'status', case
      when v_classified_pct is null then 'info'
      when v_classified_pct >= v_target then 'pass'
      else 'warn'
    end,
    'value', jsonb_build_object(
      'classified_pct', v_classified_pct,
      'target', v_target,
      'classified_amount', v_coverage -> 'classified_amount',
      'expense_total', v_coverage -> 'expense_total'
    ),
    'detail_en', case
      when v_classified_pct is null then 'No classified expense data is available for the month.'
      when v_classified_pct >= v_target then 'Classified expense coverage meets the configured target.'
      else 'Classified expense coverage is below the configured target.'
    end
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  select count(*)::integer, coalesce(sum(line_amount), 0)
    into v_review_count, v_review_amount
  from public.cost_classification_line_details
  where source_date between v_start and v_end
    and (review_status = 'needs_review' or category_code = 'UNMAPPED_REVIEW');

  v_check := jsonb_build_object(
    'code', 'REVIEW_QUEUE',
    'title_en', 'Classification review queue',
    'status', case when v_review_count > 0 then 'warn' else 'pass' end,
    'value', jsonb_build_object(
      'line_count', v_review_count,
      'amount', v_review_amount
    ),
    'detail_en', case
      when v_review_count > 0 then 'Expense lines still need classification review.'
      else 'No expense line is waiting for classification review.'
    end
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  select count(*)::integer, coalesce(sum(amount), 0)
    into v_payroll_count, v_payroll_amount
  from public.finance_month_lines(v_start, v_end)
  where source = 'payroll';

  select count(*)::integer
    into v_c6_count
  from public.finance_month_lines(v_start, v_end)
  where source = 'expense_line' and line_code = 'C6_PAYROLL';

  v_check := jsonb_build_object(
    'code', 'PAYROLL_RECORDED',
    'title_en', 'Payroll recorded',
    'status', case when v_payroll_count > 0 then 'pass' else 'fail' end,
    'value', jsonb_build_object(
      'payout_count', v_payroll_count,
      'amount', v_payroll_amount
    ),
    'detail_en', case
      when v_payroll_count > 0 then 'A non-cancelled salary payout is recorded for the month.'
      else 'No non-cancelled salary payout is recorded for the month.'
    end
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  v_check := jsonb_build_object(
    'code', 'PAYROLL_DOUBLE_COUNT',
    'title_en', 'Payroll double-count risk',
    'status', case when v_payroll_count > 0 and v_c6_count > 0 then 'warn' else 'pass' end,
    'value', jsonb_build_object(
      'payout_count', v_payroll_count,
      'c6_expense_lines', v_c6_count
    ),
    'detail_en', case
      when v_payroll_count > 0 and v_c6_count > 0
        then 'Salary payouts and C6_PAYROLL expense lines both exist; payroll may be counted twice.'
      else 'No payroll payout and C6_PAYROLL overlap was found.'
    end
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  v_overdue := coalesce(v_ap -> 'overdue', '{}'::jsonb);
  v_overdue_count := coalesce((v_overdue ->> 'count')::integer, 0);
  v_overdue_amount := coalesce((v_overdue ->> 'amount')::numeric, 0);

  v_check := jsonb_build_object(
    'code', 'AP_OVERDUE',
    'title_en', 'AP overdue',
    'status', case when v_overdue_count > 0 then 'warn' else 'pass' end,
    'value', jsonb_build_object(
      'count', v_overdue_count,
      'amount', v_overdue_amount,
      'days_threshold', v_overdue -> 'days_threshold'
    ),
    'detail_en', case
      when v_overdue_count > 0 then 'Some unpaid payables are older than the configured overdue threshold.'
      else 'No unpaid payable is older than the configured overdue threshold.'
    end
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  v_foot := coalesce(v_ap -> 'foot', '{}'::jsonb);
  v_foot_pass := coalesce((v_foot ->> 'pass')::boolean, false);

  v_check := jsonb_build_object(
    'code', 'AP_ROLLFORWARD_FOOT',
    'title_en', 'AP roll-forward foot',
    'status', case when v_foot_pass then 'pass' else 'fail' end,
    'value', v_foot,
    'detail_en', case
      when v_foot_pass then 'Opening plus additions minus payments minus adjustments ties to the independently measured closing balance.'
      else 'The AP roll-forward does not tie; the unexplained delta is reported without a plug.'
    end
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  select count(*)::integer, coalesce(sum(d.line_amount), 0)
    into v_legacy_count, v_legacy_amount
  from public.cost_classification_line_details d
  join public.cost_categories cc on cc.code = d.category_code
  where d.source_date between v_start and v_end
    and cc.is_active = false;

  v_check := jsonb_build_object(
    'code', 'LEGACY_CATEGORIES',
    'title_en', 'Legacy categories',
    'status', case when v_legacy_count > 0 then 'warn' else 'pass' end,
    'value', jsonb_build_object(
      'line_count', v_legacy_count,
      'amount', v_legacy_amount
    ),
    'detail_en', case
      when v_legacy_count > 0 then 'Amounts remain on inactive or legacy cost categories.'
      else 'No amount remains on an inactive or legacy cost category.'
    end
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  v_check := jsonb_build_object(
    'code', 'BUDGET',
    'title_en', 'Budget',
    'status', 'info',
    'value', jsonb_build_object('budget_status', 'not_set'),
    'detail_en', 'No budget is set. Variance output uses budget_status not_set and never invents a budget.'
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  v_check := jsonb_build_object(
    'code', 'COLLECTIONS',
    'title_en', 'Collections and AR',
    'status', 'info',
    'value', jsonb_build_object(
      'collections_recorded', false,
      'ar_available', false
    ),
    'detail_en', 'Customer collections are not recorded, so AR and collection metrics are not available.'
  );
  v_checks := v_checks || jsonb_build_array(v_check);

  v_result := jsonb_build_object(
    'month', to_char(v_start, 'YYYY-MM'),
    'checks', v_checks
  );

  return v_result;
end;
$$;

revoke all on function public.finance_close_checklist(date) from public, anon;
grant execute on function public.finance_close_checklist(date) to authenticated, service_role;
