-- BMQ finance module, accrual P&L phase 2: manual adjustments and net profit.
--
-- Adds:
--   * public.finance_manual_adjustments, an owner/finance-editable journal of
--     manual accruals (opex, revenue deduction, depreciation, interest, other
--     below EBITDA, CIT);
--   * public.finance_manual_adjustment_save(...) and
--     public.finance_manual_adjustment_void(...), the only write paths;
--   * public.finance_manual_adjustment_month_lines(date), which spreads an
--     adjustment evenly over its first-to-last month and gives the rounding
--     remainder to the last month;
--   * a replacement public.finance_pnl_accrual(date) that adds the manual
--     lines, reports below-EBITDA lines separately, and derives EBIT, EBT,
--     CIT and net profit.
--
-- This file never writes a business table outside finance_manual_adjustments.
-- The existing migration 20261119085657_finance_pnl_accrual.sql is unchanged.

-- ===========================================================================
-- 1. Manual adjustment journal
-- ===========================================================================

create table if not exists public.finance_manual_adjustments (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in (
      'opex',
      'depreciation',
      'interest',
      'other_below_ebitda',
      'cit',
      'revenue_deduction'
    )),
  category_code text,
  label text not null,
  period_from date not null,
  period_to date not null,
  total_amount numeric not null check (total_amount > 0),
  source_ref text,
  note text,
  status text not null default 'active' check (status in ('active', 'void')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_manual_adjustments_period_check check (
    period_from <= period_to
    and extract(day from period_from) = 1
    and extract(day from period_to) = 1
  ),
  constraint finance_manual_adjustments_below_ebitda_category_check check (
    kind not in ('depreciation', 'interest', 'other_below_ebitda', 'cit')
    or category_code is null
  )
);

create index if not exists finance_manual_adjustments_active_period_idx
  on public.finance_manual_adjustments (kind, period_from, period_to)
  where status = 'active';

alter table public.finance_manual_adjustments enable row level security;

-- Self-only wrapper for the RLS policy: it answers for the caller only, so
-- finance_can_view(uuid) does not have to be opened to every signed-in user.
create or replace function public.finance_can_view_self()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.finance_can_view(auth.uid()), false);
$$;

revoke all on function public.finance_can_view_self() from public, anon;
grant execute on function public.finance_can_view_self() to authenticated;

drop policy if exists finance_manual_adjustments_select on public.finance_manual_adjustments;
create policy finance_manual_adjustments_select
  on public.finance_manual_adjustments
  for select
  to authenticated
  using (public.finance_can_view_self());

revoke all on public.finance_manual_adjustments from public, anon, authenticated;
grant select on public.finance_manual_adjustments to authenticated;
grant all on public.finance_manual_adjustments to service_role;


-- ===========================================================================
-- 2. Owner / finance write RPCs
-- ===========================================================================

create or replace function public.finance_manual_adjustment_save(p_id uuid, p_kind text, p_category_code text, p_label text, p_period_from date, p_period_to date, p_total_amount numeric, p_source_ref text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.finance_manual_adjustments%rowtype;
  v_category_code text := nullif(btrim(coalesce(p_category_code, '')), '');
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
  v_source_ref text := nullif(btrim(coalesce(p_source_ref, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_cost', 'edit')
    or public.has_module_permission(v_actor, 'finance_revenue', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_kind is null or p_kind not in (
    'opex',
    'depreciation',
    'interest',
    'other_below_ebitda',
    'cit',
    'revenue_deduction'
  ) then
    raise exception 'invalid_manual_adjustment_kind' using errcode = '22023';
  end if;

  if p_period_from is null or p_period_to is null then
    raise exception 'invalid_manual_adjustment_period' using errcode = '22023';
  end if;

  if p_period_from > p_period_to
     or extract(day from p_period_from) <> 1
     or extract(day from p_period_to) <> 1 then
    raise exception 'invalid_manual_adjustment_period' using errcode = '22023';
  end if;

  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'invalid_manual_adjustment_amount' using errcode = '22023';
  end if;

  if v_label is null or length(v_label) > 200 then
    raise exception 'invalid_manual_adjustment_label' using errcode = '22023';
  end if;

  if length(coalesce(v_source_ref, '')) > 200 then
    raise exception 'manual_adjustment_source_ref_too_long' using errcode = '22023';
  end if;

  if length(coalesce(v_note, '')) > 2000 then
    raise exception 'manual_adjustment_note_too_long' using errcode = '22023';
  end if;

  if p_kind = 'opex' then
    if v_category_code is null then
      raise exception 'manual_adjustment_category_required' using errcode = '22023';
    end if;
    if not exists (
      select 1
      from public.cost_categories cc
      where cc.code = v_category_code
        and cc.is_active
    ) then
      raise exception 'manual_adjustment_unknown_category' using errcode = '22023';
    end if;
  elsif p_kind in ('depreciation', 'interest', 'other_below_ebitda', 'cit') then
    if v_category_code is not null then
      raise exception 'manual_adjustment_category_must_be_null' using errcode = '22023';
    end if;
  end if;

  if p_id is null then
    insert into public.finance_manual_adjustments (
      kind,
      category_code,
      label,
      period_from,
      period_to,
      total_amount,
      source_ref,
      note,
      created_by
    ) values (
      p_kind,
      v_category_code,
      v_label,
      p_period_from,
      p_period_to,
      p_total_amount,
      v_source_ref,
      v_note,
      v_actor
    )
    returning * into v_row;
  else
    select *
    into v_row
    from public.finance_manual_adjustments a
    where a.id = p_id
    for update;

    if not found then
      raise exception 'manual_adjustment_not_found' using errcode = 'P0002';
    end if;

    if v_row.status <> 'active' then
      raise exception 'manual_adjustment_is_void' using errcode = '22023';
    end if;

    update public.finance_manual_adjustments
    set kind = p_kind,
        category_code = v_category_code,
        label = v_label,
        period_from = p_period_from,
        period_to = p_period_to,
        total_amount = p_total_amount,
        source_ref = v_source_ref,
        note = v_note,
        updated_at = now()
    where id = p_id
    returning * into v_row;
  end if;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.finance_manual_adjustment_save(uuid, text, text, text, date, date, numeric, text, text) from public, anon, authenticated;
grant execute on function public.finance_manual_adjustment_save(uuid, text, text, text, date, date, numeric, text, text) to authenticated, service_role;

create or replace function public.finance_manual_adjustment_void(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.finance_manual_adjustments%rowtype;
begin
  if v_actor is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_cost', 'edit')
    or public.has_module_permission(v_actor, 'finance_revenue', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_id is null then
    raise exception 'invalid_manual_adjustment_id' using errcode = '22023';
  end if;

  select *
  into v_row
  from public.finance_manual_adjustments a
  where a.id = p_id
  for update;

  if not found then
    raise exception 'manual_adjustment_not_found' using errcode = 'P0002';
  end if;

  if v_row.status = 'void' then
    return to_jsonb(v_row);
  end if;

  update public.finance_manual_adjustments
  set status = 'void',
      updated_at = now()
  where id = p_id
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.finance_manual_adjustment_void(uuid) from public, anon, authenticated;
grant execute on function public.finance_manual_adjustment_void(uuid) to authenticated, service_role;

-- ===========================================================================
-- 3. Month allocation helper
-- ===========================================================================
-- An active adjustment covers every month from period_from to period_to. Each
-- month receives round(total_amount / month_count); the last month receives the
-- remainder so the sum of the months is exactly total_amount.

create or replace function public.finance_manual_adjustment_month_lines(p_month date)
returns table (
  adjustment_id uuid,
  kind text,
  category_code text,
  label text,
  period_from date,
  period_to date,
  total_amount numeric,
  month_index integer,
  month_count integer,
  amount numeric,
  source_ref text,
  note text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with params as (
    select date_trunc('month', p_month)::date as month_start
  ),
  active as (
    select
      a.*,
      (
        (extract(year from a.period_to)::integer
          - extract(year from a.period_from)::integer) * 12
        + (extract(month from a.period_to)::integer
          - extract(month from a.period_from)::integer)
        + 1
      ) as month_count,
      (
        (extract(year from (select month_start from params))::integer
          - extract(year from a.period_from)::integer) * 12
        + (extract(month from (select month_start from params))::integer
          - extract(month from a.period_from)::integer)
        + 1
      ) as month_index
    from public.finance_manual_adjustments a
    where a.status = 'active'
      and a.period_from <= (select month_start from params)
      and a.period_to >= (select month_start from params)
  )
  select
    a.id,
    a.kind,
    a.category_code,
    a.label,
    a.period_from,
    a.period_to,
    a.total_amount,
    a.month_index,
    a.month_count,
    case
      when a.month_index = a.month_count then
        a.total_amount
          - round(a.total_amount / a.month_count, 0) * (a.month_count - 1)
      else
        round(a.total_amount / a.month_count, 0)
    end as amount,
    a.source_ref,
    a.note
  from active a
  order by a.period_from, a.created_at, a.id;
$$;

revoke all on function public.finance_manual_adjustment_month_lines(date) from public, anon, authenticated;
grant execute on function public.finance_manual_adjustment_month_lines(date) to service_role;

comment on table public.finance_manual_adjustments
  is 'Manual accrual adjustments (opex, revenue deduction, depreciation, interest, other below EBITDA, CIT) spread evenly by month. Written only through finance_manual_adjustment_save/void.';

comment on function public.finance_manual_adjustment_month_lines(date)
  is 'Returns the active manual adjustment amount allocated to the requested month; the final month absorbs the rounding remainder.';
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
  is 'Read-only single-month accrual P&L. Purchases accrue on goods_receipts.receipt_date; Tuyết Anh bread uses sent production_bread_order notifications; missing payroll groups and periodic costs are estimated and flagged. Manual adjustments add opex/revenue deductions and below-EBITDA depreciation, interest, other and CIT; net profit is derived after an estimated 20% CIT when no actual CIT adjustment exists. Inventory is not counted in phase 1.';
