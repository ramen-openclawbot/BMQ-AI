-- BMQ finance module: per-person payroll in the accrual P&L.
--
-- Replaces public.finance_pnl_accrual(date) so that:
--   * actual salary payouts are read from salary_payout_lines, grouped by the
--     payout family, and a manual line is dropped when the same person already
--     has a published payslip that month (employee_code LL-xx is only unique
--     inside one payout, so people are matched by a normalized full name);
--   * the person key applies Unicode NFC, folds non-breaking spaces and
--     collapses whitespace, so composed/decomposed Vietnamese names match;
--   * a person who was paid manually last month but has no payslip here and no
--     current payout is estimated per person from that prior manual amount;
--   * when a prior payslip group is absent this month, only that group's people
--     who were not paid this month are estimated, summed per person;
--   * a prior-month payroll total (payslips plus de-duplicated manual lines,
--     including payouts whose title has no month by paid/completed date) is used
--     once when the current month has neither payslips nor payouts;
--   * public.finance_payroll_carry_exclusions can exclude a person from the
--     estimate of one exact month, including the no-current-payroll fallback;
--     actual payout lines are never excluded;
--   * actual payroll keeps the old payslip-group and payout-family lines for
--     every finance viewer; only the owner receives named per-person estimates,
--     while every other caller gets one nameless aggregate with the same total
--     (and warning amounts are owner-only).
--
-- The previous migration 20261120180758_finance_net_profit_adjustments.sql is
-- unchanged. The function keeps its finance_can_view gate, SECURITY DEFINER,
-- search_path and execute grants, and all non-payroll P&L behavior is copied
-- verbatim. Live rollback verification assumes the earlier finance and
-- manual-adjustment migrations are already applied.

-- ===========================================================================
-- 1. Normalized person key and month-scoped carry exclusions
-- ===========================================================================

-- employee_code LL-xx is only meaningful inside one payslip/payout, so people
-- are matched by full name. NFC plus NBSP folding keeps composed/decomposed
-- Vietnamese names and pasted non-breaking spaces on the same key.
create or replace function public.finance_pnl_accrual_person_key(p_name text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select lower(btrim(regexp_replace(
    replace(normalize(coalesce(p_name, ''), NFC), chr(160), ' '),
    '[[:space:]]+',
    ' ',
    'g'
  )));
$$;

revoke all on function public.finance_pnl_accrual_person_key(text) from public, anon, authenticated;

-- A title month is parsed once, with NFC normalization, underscore treated as a
-- boundary, and / . - separators. Invalid values (T19/2026) return null so the
-- caller can both fall back and raise the fallback warning.
create or replace function public.finance_pnl_accrual_payout_title_month(p_period_name text)
returns date
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  with parsed as (
    select regexp_match(
      replace(normalize(coalesce(p_period_name, ''), NFC), '_', ' '),
      '\m(T|tháng)[[:space:]]*([0-9]{1,2})[[:space:]]*[/.-][[:space:]]*([0-9]{4})',
      'i'
    ) as m
  )
  select case
    when (m)[2] ~ '^[0-9]{1,2}$'
      and (m)[3] ~ '^[0-9]{4}$'
      and (m)[2]::integer between 1 and 12
      and (m)[3]::integer between 1900 and 2100
    then make_date((m)[3]::integer, (m)[2]::integer, 1)
  end
  from parsed;
$$;

revoke all on function public.finance_pnl_accrual_payout_title_month(text) from public, anon, authenticated;

-- The accrual month comes from the title when it has a valid month; otherwise
-- it falls back to the paid/completed date in Vietnam time. created_at is kept
-- in the signature for callers but is deliberately not used: a pending
-- unlabelled payout must not move from one reported month to another.
create or replace function public.finance_pnl_accrual_payout_month(
  p_period_name text,
  p_ceo_paid_at timestamptz,
  p_completed_at timestamptz,
  p_created_at timestamptz
)
returns date
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    public.finance_pnl_accrual_payout_title_month(p_period_name),
    case
      when p_ceo_paid_at is not null or p_completed_at is not null then
        date_trunc(
          'month',
          (
            coalesce(p_ceo_paid_at, p_completed_at)
            at time zone 'Asia/Ho_Chi_Minh'
          )
        )::date
    end
  );
$$;

-- Keep the family key aligned with the title parser so "Lương BH T09.2026",
-- "Lương BH T09-2026" and "Lương BH T09/2026" collapse to one family.
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
                lower(replace(normalize(coalesce(p_name, ''), NFC), '_', ' ')),
                '\m(T|tháng)[[:space:]]*([0-9]{1,2})[[:space:]]*[/.-][[:space:]]*([0-9]{4})',
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

revoke all on function public.finance_pnl_accrual_payout_month(text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

create table if not exists public.finance_payroll_carry_exclusions (
  id uuid primary key default gen_random_uuid(),
  month date not null,
  person_name text not null,
  person_key text generated always as (
    public.finance_pnl_accrual_person_key(person_name)
  ) stored,
  reason text not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint finance_payroll_carry_exclusions_month_check check (
    extract(day from month) = 1
  ),
  constraint finance_payroll_carry_exclusions_month_person_unique
    unique (month, person_key)
);

alter table public.finance_payroll_carry_exclusions enable row level security;

-- Only the SECURITY DEFINER P&L function reads this table; no API role gets a
-- grant or a policy, so anon, authenticated and service_role cannot read or
-- write it directly.
revoke all on public.finance_payroll_carry_exclusions from public, anon, authenticated;
revoke all on public.finance_payroll_carry_exclusions from service_role;

insert into public.finance_payroll_carry_exclusions (month, person_name, reason)
values
  ('2026-10-01', 'Trần Thị Ái Mi', 'Chủ yêu cầu không mang lương T9 qua T10'),
  ('2026-10-01', 'Trần Thị Vân Anh', 'Chủ yêu cầu không mang lương T9 qua T10')
on conflict (month, person_key) do nothing;

comment on table public.finance_payroll_carry_exclusions
  is 'Month-scoped people who must not receive a payroll_last_month estimate. Read only by finance_pnl_accrual; actual payout lines are never excluded.';

-- ===========================================================================
-- 2. Replacement public.finance_pnl_accrual(date)
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
  v_revenue numeric;
  v_cogs numeric;
  v_gross_profit numeric;
  v_gross_margin numeric;
  v_selling numeric;
  v_operating numeric;
  v_unclassified numeric;
  v_capex numeric;
  v_estimate_total numeric;
  v_estimate_lines integer;
  v_line_count integer;
  v_ebitda numeric;
  v_ebitda_margin numeric;
  v_depreciation numeric;
  v_interest numeric;
  v_other_below numeric;
  v_cit_actual numeric;
  v_cit_count integer;
  v_cit_rate numeric := 0.20;
  v_cit numeric;
  v_cit_is_estimate boolean;
  v_ebit numeric;
  v_ebt numeric;
  v_net_profit numeric;
  v_net_margin numeric;
  v_below_ebitda jsonb := '[]'::jsonb;
  v_can_view_payroll_people boolean;
  v_payroll_name_conflicts integer;
  v_manual_dedup_count integer;
  v_manual_dedup_amount numeric;
  v_prior_manual_dedup_count integer;
  v_prior_manual_dedup_amount numeric;
  v_unlabelled_pending_count integer;
  v_unlabelled_pending_amount numeric;
  v_payout_fallback_count integer;
  v_payout_fallback_amount numeric;
  v_cross_source_name_count integer;
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

  -- Actual payroll follows the old group/family P&L. Only the owner gets named
  -- per-person estimates; every other caller gets one nameless aggregate.
  v_can_view_payroll_people := public.has_role(auth.uid(), 'owner');

  -- Base lines: controlled revenue, purchase accrual by receipt date, and the
  -- month's payroll. Missing prior-month payroll people are added below with
  -- the same source but is_estimate = true.
  with
  payroll_periods_month as (
    select p.id, p.period_code, p.period_name
    from public.payroll_bn_periods p
    where date_trunc('month', p.date_from)::date = v_start
  ),
  current_payslip_rows as (
    select
      ps.employee_name,
      ps.employee_code,
      public.finance_pnl_accrual_person_key(ps.employee_name) as person_key,
      coalesce(nullif(ps.group_name, ''), 'Chưa phân nhóm') as group_name,
      lower(btrim(coalesce(nullif(ps.group_name, ''), 'Chưa phân nhóm'))) as group_key,
      ps.net_pay,
      p.id as period_id,
      p.period_code,
      p.period_name
    from public.payroll_bn_payslips ps
    join payroll_periods_month p on p.id = ps.period_id
  ),
  current_payslip_groups as (
    select
      group_key,
      min(group_name) as group_name,
      sum(net_pay)::numeric as amount,
      count(*)::integer as line_count,
      min(period_code) as period_code,
      min(period_id::text) as period_id,
      string_agg(distinct period_name, ', ') as period_names
    from current_payslip_rows
    group by group_key
  ),
  current_payslip_count as (
    select count(*)::integer as n
    from current_payslip_rows
  ),
  current_payslip_persons as (
    select person_key
    from current_payslip_rows
    group by person_key
    having sum(net_pay) > 0
  ),
  prior_payslip_rows as (
    select
      ps.employee_name,
      ps.employee_code,
      public.finance_pnl_accrual_person_key(ps.employee_name) as person_key,
      coalesce(nullif(ps.group_name, ''), 'Chưa phân nhóm') as group_name,
      lower(btrim(coalesce(nullif(ps.group_name, ''), 'Chưa phân nhóm'))) as group_key,
      ps.net_pay,
      p.period_name
    from public.payroll_bn_payslips ps
    join public.payroll_bn_periods p on p.id = ps.period_id
    where date_trunc('month', p.date_from)::date = (v_start - interval '1 month')::date
  ),
  prior_payslip_person_groups as (
    select
      person_key,
      group_key,
      min(employee_name) as employee_name,
      min(group_name) as group_name,
      sum(net_pay)::numeric as amount,
      count(distinct employee_code)::integer as employee_code_count,
      string_agg(distinct period_name, ', ') as period_names
    from prior_payslip_rows
    group by person_key, group_key
  ),
  prior_payslip_persons as (
    select person_key
    from prior_payslip_person_groups
    group by person_key
    having sum(amount) > 0
  ),
  payout_base as (
    select
      sp.id,
      sp.payout_number,
      sp.period_name,
      sp.total_amount,
      sp.payroll_period_id,
      sp.ceo_paid_at,
      sp.completed_at,
      sp.created_at,
      public.finance_pnl_accrual_payroll_family(sp.period_name) as family_key
    from public.salary_payouts sp
    where sp.status <> 'cancelled'
      and not exists (
        select 1
        from public.payroll_bn_payslips ps
        where ps.period_id = sp.payroll_period_id
      )
  ),
  payout_base_month as (
    select
      pb.*,
      public.finance_pnl_accrual_payout_month(
        pb.period_name,
        pb.ceo_paid_at,
        pb.completed_at,
        pb.created_at
      ) as effective_month
    from payout_base pb
  ),
  payout_line_base as (
    select
      pb.id,
      pb.payout_number,
      pb.period_name,
      pb.family_key,
      pb.effective_month,
      spl.employee_name,
      public.finance_pnl_accrual_person_key(spl.employee_name) as person_key,
      spl.net_pay
    from payout_base_month pb
    join public.salary_payout_lines spl on spl.payout_id = pb.id
  ),
  current_manual_lines as (
    select pl.*
    from payout_line_base pl
    where pl.effective_month = v_start
      and not exists (
        select 1
        from current_payslip_persons cp
        where cp.person_key = pl.person_key
      )
  ),
  prior_payslip_missing_groups as (
    select pg.*
    from prior_payslip_person_groups pg
    where pg.amount > 0
      and not exists (
        select 1 from current_payslip_groups cg where cg.group_key = pg.group_key
      )
      and not exists (
        select 1 from current_payslip_persons cp where cp.person_key = pg.person_key
      )
      and not exists (
        select 1 from current_manual_lines cm where cm.person_key = pg.person_key
      )
      and not exists (
        select 1
        from public.finance_payroll_carry_exclusions e
        where e.month = v_start
          and e.person_key = pg.person_key
      )
  ),
  prior_payslip_missing as (
    select
      person_key,
      min(employee_name) as employee_name,
      sum(amount)::numeric as amount,
      string_agg(distinct group_name, ', ' order by group_name) as group_names,
      string_agg(distinct period_names, ', ') as period_names
    from prior_payslip_missing_groups
    group by person_key
    having sum(amount) > 0
  ),
  prior_manual_lines as (
    select pl.*
    from payout_line_base pl
    where pl.effective_month = (v_start - interval '1 month')::date
      and not exists (
        select 1
        from prior_payslip_persons pp
        where pp.person_key = pl.person_key
      )
  ),
  current_payout_families as (
    select
      family_key,
      min(period_name) as family_name,
      sum(net_pay)::numeric as amount,
      count(*)::integer as payout_line_count,
      string_agg(distinct payout_number, ', ' order by payout_number) as payout_numbers,
      string_agg(distinct period_name, ', ' order by period_name) as source_names
    from current_manual_lines
    group by family_key
    having sum(net_pay) <> 0
  ),
  prior_manual_persons as (
    select
      person_key,
      min(employee_name) as employee_name,
      sum(net_pay)::numeric as amount,
      string_agg(distinct period_name, ', ' order by period_name) as source_names,
      string_agg(distinct family_key, ', ' order by family_key) as family_names
    from prior_manual_lines
    group by person_key
    having sum(net_pay) > 0
  ),
  prior_manual_missing as (
    select pm.*
    from prior_manual_persons pm
    where not exists (
        select 1 from current_payslip_persons cp where cp.person_key = pm.person_key
      )
      and not exists (
        select 1 from current_manual_lines cm where cm.person_key = pm.person_key
      )
      and not exists (
        select 1
        from public.finance_payroll_carry_exclusions e
        where e.month = v_start
          and e.person_key = pm.person_key
      )
  ),
  estimate_per_person as (
    select (
      (select n from current_payslip_count) > 0
      or exists (select 1 from current_payout_families)
    ) as enabled
  ),
  prior_actual_total as (
    select (
      coalesce((
        select sum(pg.amount)
        from prior_payslip_person_groups pg
        where not exists (
          select 1
          from public.finance_payroll_carry_exclusions e
          where e.month = v_start
            and e.person_key = pg.person_key
        )
      ), 0)
      + coalesce((
        select sum(pl.net_pay)
        from prior_manual_lines pl
        where not exists (
          select 1
          from public.finance_payroll_carry_exclusions e
          where e.month = v_start
            and e.person_key = pl.person_key
        )
      ), 0)
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
        || ' (' || p.payout_line_count::text || ' line(s), '
        || p.payout_numbers || ')',
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
      pm.employee_name,
      pm.amount,
      'payroll_period'::text,
      'payroll_last_month:' || pm.family_names,
      'prior_person:' || pm.person_key,
      'prior_person:' || pm.person_key || ':manual',
      true,
      'PAYROLL payroll_last_month — manual payout ' || pm.source_names
        || ' (no current-month payslip or payout)',
      null::numeric,
      null::numeric
    from prior_manual_missing pm
    where (select enabled from estimate_per_person)
      and v_can_view_payroll_people

    union all

    select
      v_start,
      'operating'::text,
      'C6_PAYROLL'::text,
      public.finance_pnl_accrual_label('C6_PAYROLL'),
      'shared'::text,
      pp.employee_name,
      pp.amount,
      'payroll_period'::text,
      'payroll_last_month:' || pp.group_names,
      'prior_person:' || pp.person_key,
      'prior_person:' || pp.person_key || ':payslip',
      true,
      'PAYROLL payroll_last_month — payslip ' || pp.period_names
        || ' for missing group ' || pp.group_names,
      null::numeric,
      null::numeric
    from prior_payslip_missing pp
    where (select enabled from estimate_per_person)
      and v_can_view_payroll_people

    union all

    select
      v_start,
      'operating'::text,
      'C6_PAYROLL'::text,
      public.finance_pnl_accrual_label('C6_PAYROLL'),
      'shared'::text,
      'Payroll (prior month estimate)',
      pa.amount,
      'payroll_period'::text,
      'payroll_last_month:total',
      'prior_people_aggregate',
      'prior_people_aggregate',
      true,
      'PAYROLL payroll_last_month — estimated prior-month payroll (person detail restricted)',
      null::numeric,
      null::numeric
    from (
      select sum(amount)::numeric as amount
      from (
        select amount from prior_manual_missing
        union all
        select amount from prior_payslip_missing
      ) people
    ) pa
    where not v_can_view_payroll_people
      and (select enabled from estimate_per_person)
      and pa.amount > 0

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
      'PAYROLL payroll_last_month — no current payslips or salary payouts; actual prior-month payroll',
      null::numeric,
      null::numeric
    from prior_actual_total pt
    where not (select enabled from estimate_per_person)
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

  -- Manual opex and revenue deductions join the normal P&L sections. Below-
  -- EBITDA kinds are collected separately after the section totals.
  v_lines := v_lines || coalesce((
    select jsonb_agg(line order by line->>'line_code', line->>'source_ref')
    from (
      select jsonb_strip_nulls(
        jsonb_build_object(
          'month', to_char(v_start, 'YYYY-MM'),
          'section',
            case
              when a.kind = 'revenue_deduction' then 'revenue'
              when parent.code = 'A_COGS' then 'cogs'
              when parent.code = 'B_SELLING' then 'selling'
              when parent.code = 'C_OPERATING' then 'operating'
              when parent.code = 'D_INVESTMENT' then 'capex'
              else 'unclassified'
            end,
          'line_code',
            coalesce(
              a.category_code,
              case
                when a.kind = 'revenue_deduction' then 'REVENUE_DEDUCTION'
                else 'UNMAPPED_REVIEW'
              end
            ),
          'label', a.label,
          'product_line', coalesce(cc.product_line, 'shared'),
          'counterparty', a.source_ref,
          'amount',
            case when a.kind = 'revenue_deduction' then -a.amount else a.amount end,
          'amounts', jsonb_build_object(
            to_char(v_start, 'YYYY-MM'),
            case when a.kind = 'revenue_deduction' then -a.amount else a.amount end
          ),
          'source', 'manual_adjustment',
          'source_ref', coalesce(a.source_ref, a.adjustment_id::text),
          'source_id', a.adjustment_id::text,
          'source_line_id', a.adjustment_id::text || ':' || to_char(v_start, 'YYYY-MM'),
          'is_estimate', false,
          'note', a.note
        )
      ) as line
      from public.finance_manual_adjustment_month_lines(v_start) a
      left join public.cost_categories cc on cc.code = a.category_code
      left join public.cost_categories parent on parent.code = cc.parent_code
      where a.kind in ('opex', 'revenue_deduction')
    ) section_lines
  ), '[]'::jsonb);

  -- Accrual policies. Only the five periodic cost policies are used here;
  -- PAYROLL is handled above by the per-person / aggregate payroll lines.
  v_flags := jsonb_build_array(
    jsonb_build_object(
      'code', 'inventory_not_counted',
      'detail_en', 'Inventory differences are not deducted in phase 1; inventory.status is not_counted.'
    )
  );

  -- A manual line is de-duplicated only by normalized name. Count what was
  -- dropped so a homonym or a separate bonus is visible instead of vanishing.
  select
    count(*) filter (where m.pm = v_start),
    coalesce(sum(spl.net_pay) filter (where m.pm = v_start), 0),
    count(*) filter (where m.pm = (v_start - interval '1 month')::date),
    coalesce(sum(spl.net_pay) filter (
      where m.pm = (v_start - interval '1 month')::date
    ), 0)
  into
    v_manual_dedup_count,
    v_manual_dedup_amount,
    v_prior_manual_dedup_count,
    v_prior_manual_dedup_amount
  from public.salary_payout_lines spl
  join public.salary_payouts sp on sp.id = spl.payout_id
  cross join lateral (
    select public.finance_pnl_accrual_payout_month(
      sp.period_name,
      sp.ceo_paid_at,
      sp.completed_at,
      sp.created_at
    ) as pm
  ) m
  where sp.status <> 'cancelled'
    and not exists (
      select 1
      from public.payroll_bn_payslips linked
      where linked.period_id = sp.payroll_period_id
    )
    and m.pm in (v_start, (v_start - interval '1 month')::date)
    and exists (
      select 1
      from public.payroll_bn_payslips ps
      join public.payroll_bn_periods p on p.id = ps.period_id
      where date_trunc('month', p.date_from)::date = m.pm
        and public.finance_pnl_accrual_person_key(ps.employee_name)
          = public.finance_pnl_accrual_person_key(spl.employee_name)
      group by public.finance_pnl_accrual_person_key(ps.employee_name)
      having sum(ps.net_pay) > 0
    );

  if coalesce(v_manual_dedup_count, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'payroll_manual_lines_deduplicated',
        'detail_en', v_manual_dedup_count::text
          || ' manual payout line(s) were removed because the same normalized name has a payslip this month; review possible homonyms or extra bonuses.'
      ) || case
        when v_can_view_payroll_people
        then jsonb_build_object('amount', coalesce(v_manual_dedup_amount, 0))
        else '{}'::jsonb
      end
    );
  end if;

  if coalesce(v_prior_manual_dedup_count, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'payroll_manual_lines_deduplicated_prior_month',
        'detail_en', v_prior_manual_dedup_count::text
          || ' prior-month manual payout line(s) were removed because the same normalized name has a prior payslip; review possible homonyms or extra bonuses.'
      ) || case
        when v_can_view_payroll_people
        then jsonb_build_object('amount', coalesce(v_prior_manual_dedup_amount, 0))
        else '{}'::jsonb
      end
    );
  end if;

  select
    count(*),
    coalesce(sum(sp.total_amount), 0)
  into v_unlabelled_pending_count, v_unlabelled_pending_amount
  from public.salary_payouts sp
  where sp.status <> 'cancelled'
    and not exists (
      select 1
      from public.payroll_bn_payslips linked
      where linked.period_id = sp.payroll_period_id
    )
    and (sp.created_at at time zone 'Asia/Ho_Chi_Minh')::date
      between (v_start - interval '3 months')::date and v_end
    and public.finance_pnl_accrual_payout_month(
      sp.period_name,
      sp.ceo_paid_at,
      sp.completed_at,
      sp.created_at
    ) is null;

  select
    count(*),
    coalesce(sum(sp.total_amount), 0)
  into v_payout_fallback_count, v_payout_fallback_amount
  from public.salary_payouts sp
  where sp.status <> 'cancelled'
    and not exists (
      select 1
      from public.payroll_bn_payslips linked
      where linked.period_id = sp.payroll_period_id
    )
    and public.finance_pnl_accrual_payout_month(
      sp.period_name,
      sp.ceo_paid_at,
      sp.completed_at,
      sp.created_at
    ) = v_start
    and public.finance_pnl_accrual_payout_title_month(sp.period_name) is null;

  select count(distinct pm.person_key)
  into v_cross_source_name_count
  from (
    select public.finance_pnl_accrual_person_key(spl.employee_name) as person_key
    from public.salary_payout_lines spl
    join public.salary_payouts sp on sp.id = spl.payout_id
    where sp.status <> 'cancelled'
      and not exists (
        select 1
        from public.payroll_bn_payslips linked
        where linked.period_id = sp.payroll_period_id
      )
      and public.finance_pnl_accrual_payout_month(
        sp.period_name,
        sp.ceo_paid_at,
        sp.completed_at,
        sp.created_at
      ) = (v_start - interval '1 month')::date
      and not exists (
        select 1
        from public.payroll_bn_payslips prior_ps
        join public.payroll_bn_periods prior_p on prior_p.id = prior_ps.period_id
        where date_trunc('month', prior_p.date_from)::date
          = (v_start - interval '1 month')::date
          and public.finance_pnl_accrual_person_key(prior_ps.employee_name)
            = public.finance_pnl_accrual_person_key(spl.employee_name)
      )
  ) pm
  where exists (
    select 1
    from public.payroll_bn_payslips ps
    join public.payroll_bn_periods p on p.id = ps.period_id
    where date_trunc('month', p.date_from)::date = v_start
      and public.finance_pnl_accrual_person_key(ps.employee_name)
        = pm.person_key
    group by public.finance_pnl_accrual_person_key(ps.employee_name)
    having sum(ps.net_pay) > 0
  );

  if coalesce(v_unlabelled_pending_count, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'payroll_unlabelled_payout_pending',
        'detail_en', v_unlabelled_pending_count::text
          || ' unlabelled salary payout(s) are pending and have no accrual month yet.'
      ) || case
        when v_can_view_payroll_people
        then jsonb_build_object('amount', coalesce(v_unlabelled_pending_amount, 0))
        else '{}'::jsonb
      end
    );
  end if;

  if coalesce(v_payout_fallback_count, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'payroll_payout_month_fallback',
        'detail_en', v_payout_fallback_count::text
          || ' salary payout(s) in this month have no recognised title month and were dated by payment date.'
      ) || case
        when v_can_view_payroll_people
        then jsonb_build_object('amount', coalesce(v_payout_fallback_amount, 0))
        else '{}'::jsonb
      end
    );
  end if;

  if coalesce(v_cross_source_name_count, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'payroll_name_matched_across_sources',
        'detail_en', v_cross_source_name_count::text
          || ' prior-month manual payee name(s) also appear on a current payslip; review possible homonyms.'
      )
    );
  end if;

  select coalesce(sum((line->>'amount')::numeric), 0)
  into v_estimated_amount
  from jsonb_array_elements(v_lines) line
  where line->>'source' = 'payroll_period'
    and coalesce((line->>'is_estimate')::boolean, false);

  if coalesce(v_estimated_amount, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'payroll_last_month_estimate',
        'detail_en', 'Missing current-month payroll people were accrued from the prior month.'
      ) || case
        when v_can_view_payroll_people
        then jsonb_build_object('amount', v_estimated_amount)
        else '{}'::jsonb
      end
    );
  end if;

  if not v_can_view_payroll_people and exists (
    select 1
    from jsonb_array_elements(v_lines) line
    where line->>'source_line_id' = 'prior_people_aggregate'
  ) then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'payroll_person_detail_restricted',
        'detail_en', 'Per-person payroll estimates are aggregated; only payroll totals are shown.'
      )
    );
  end if;

  select count(*)::integer
  into v_payroll_name_conflicts
  from (
    select person_key
    from (
      select
        ps.period_id,
        public.finance_pnl_accrual_person_key(ps.employee_name) as person_key,
        ps.employee_code
      from public.payroll_bn_payslips ps
      join public.payroll_bn_periods p on p.id = ps.period_id
      where date_trunc('month', p.date_from)::date in (
        v_start,
        (v_start - interval '1 month')::date
      )
    ) payslip_names
    group by period_id, person_key
    having count(distinct employee_code) > 1

    union

    select person_key
    from (
      select
        spl.payout_id,
        public.finance_pnl_accrual_person_key(spl.employee_name) as person_key,
        spl.employee_code
      from public.salary_payout_lines spl
      join public.salary_payouts sp on sp.id = spl.payout_id
      where sp.status <> 'cancelled'
        and not exists (
          select 1
          from public.payroll_bn_payslips linked
          where linked.period_id = sp.payroll_period_id
        )
        and public.finance_pnl_accrual_payout_month(
          sp.period_name,
          sp.ceo_paid_at,
          sp.completed_at,
          sp.created_at
        ) in (
          v_start,
          (v_start - interval '1 month')::date
        )
    ) payout_names
    group by payout_id, person_key
    having count(distinct employee_code) > 1
  ) conflicts;

  if coalesce(v_payroll_name_conflicts, 0) > 0 then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'payroll_duplicate_employee_name',
        'detail_en', v_payroll_name_conflicts::text
          || ' normalized payroll name(s) map to more than one employee code; review possible homonyms.',
        'count', v_payroll_name_conflicts
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

    -- A manual opex line is the real booking for its category even when this
    -- month's rounded allocation happens to be zero; never add the estimate.
    if v_already = 0 and exists (
      select 1
      from public.finance_manual_adjustment_month_lines(v_start) a
      where a.kind = 'opex'
        and a.category_code = v_policy.category_code
    ) then
      continue;
    end if;

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
  --   ebit = ebitda - depreciation
  --   ebt = ebit - interest - other_below_ebitda
  --   net_profit = ebt - cit
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
  )
  select
    revenue,
    cogs,
    revenue - cogs,
    selling,
    operating,
    unclassified,
    capex,
    estimate_total,
    estimate_lines,
    line_count,
    case when revenue <> 0 then round((revenue - cogs) / revenue, 4) else null end,
    revenue - cogs - selling - operating - unclassified
  into
    v_revenue,
    v_cogs,
    v_gross_profit,
    v_selling,
    v_operating,
    v_unclassified,
    v_capex,
    v_estimate_total,
    v_estimate_lines,
    v_line_count,
    v_gross_margin,
    v_ebitda
  from agg;

  v_ebitda_margin := case
    when v_revenue <> 0 then round(v_ebitda / v_revenue, 4)
    else null
  end;

  -- Below-EBITDA manual adjustments. They never feed the section totals.
  select
    coalesce(sum(a.amount) filter (where a.kind = 'depreciation'), 0),
    coalesce(sum(a.amount) filter (where a.kind = 'interest'), 0),
    coalesce(sum(a.amount) filter (where a.kind = 'other_below_ebitda'), 0),
    coalesce(sum(a.amount) filter (where a.kind = 'cit'), 0),
    count(*) filter (where a.kind = 'cit')
  into v_depreciation, v_interest, v_other_below, v_cit_actual, v_cit_count
  from public.finance_manual_adjustment_month_lines(v_start) a;

  select coalesce(jsonb_agg(line order by line->>'line_code', line->>'source_ref'), '[]'::jsonb)
  into v_below_ebitda
  from (
    select jsonb_strip_nulls(
      jsonb_build_object(
        'line_code',
          case a.kind
            when 'depreciation' then 'DEPRECIATION'
            when 'interest' then 'INTEREST'
            when 'other_below_ebitda' then 'OTHER_BELOW'
            when 'cit' then 'CIT'
          end,
        'label', a.label,
        'amount', a.amount,
        'source', 'manual_adjustment',
        'source_ref', coalesce(a.source_ref, a.adjustment_id::text),
        'source_id', a.adjustment_id::text,
        'is_estimate', false,
        'note', a.note
      )
    ) as line
    from public.finance_manual_adjustment_month_lines(v_start) a
    where a.kind in ('depreciation', 'interest', 'other_below_ebitda', 'cit')
  ) below_lines;

  v_ebit := v_ebitda - v_depreciation;
  v_ebt := v_ebit - v_interest - v_other_below;

  if v_cit_count = 0 then
    select coalesce(
      nullif(to_jsonb(s)->>'cit_rate', '')::numeric,
      nullif(to_jsonb(s)->>'corporate_income_tax_rate', '')::numeric,
      0.20
    )
    into v_cit_rate
    from public.finance_report_settings s
    limit 1;

    v_cit_rate := coalesce(v_cit_rate, 0.20);
    v_cit := round(greatest(v_ebt, 0) * v_cit_rate, 0);
    v_cit_is_estimate := true;

    v_below_ebitda := v_below_ebitda || jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'line_code', 'CIT',
          'label', 'Corporate income tax (estimated)',
          'amount', v_cit,
          'source', 'cit_estimate',
          'source_ref', 'CIT_ESTIMATE',
          'is_estimate', true,
          'note', 'Estimated at ' || round(v_cit_rate * 100, 2)::text || '% of positive EBT'
        )
      )
    );
  else
    v_cit := v_cit_actual;
    v_cit_is_estimate := false;
  end if;

  v_net_profit := v_ebt - v_cit;
  v_net_margin := case
    when v_revenue <> 0 then round(v_net_profit / v_revenue, 4)
    else null
  end;

  v_totals := jsonb_build_object(
    'revenue', v_revenue,
    'cogs', v_cogs,
    'gross_profit', v_gross_profit,
    'gross_margin', v_gross_margin,
    'selling', v_selling,
    'operating', v_operating,
    'unclassified', v_unclassified,
    'ebitda', v_ebitda,
    'ebitda_margin', v_ebitda_margin,
    'estimate_total', v_estimate_total + case when v_cit_is_estimate then v_cit else 0 end,
    'estimate_lines', v_estimate_lines + case when v_cit_is_estimate then 1 else 0 end,
    'capex', v_capex,
    'line_count', v_line_count,
    'depreciation', v_depreciation,
    'ebit', v_ebit,
    'interest', v_interest,
    'other_below_ebitda', v_other_below,
    'ebt', v_ebt,
    'cit', v_cit,
    'cit_is_estimate', v_cit_is_estimate,
    'net_profit', v_net_profit,
    'net_margin', v_net_margin
  );

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

  if v_cit_is_estimate then
    v_flags := v_flags || jsonb_build_array(
      jsonb_build_object(
        'code', 'cit_estimated',
        'detail_en', 'Corporate income tax is estimated at '
          || round(v_cit_rate * 100, 2)::text || '% of positive EBT.',
        'amount', v_cit
      )
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
    'below_ebitda', v_below_ebitda,
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
  is 'Read-only single-month accrual P&L. Purchases accrue on goods_receipts.receipt_date; Tuyết Anh bread uses sent production_bread_order notifications; payroll uses published payslips plus per-person salary payout lines, de-duplicated by normalized name, and estimates missing prior-month payroll people (or the prior actual total when the month has no payroll yet). Manual adjustments add opex/revenue deductions and below-EBITDA depreciation, interest, other and CIT; net profit is derived after an estimated 20% CIT when no actual CIT adjustment exists. Inventory is not counted in phase 1.';
