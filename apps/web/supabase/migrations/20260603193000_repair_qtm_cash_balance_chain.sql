-- Repair QTM cash carry-forward after the 2026-05-08 Drive QTM rescan.
-- The 2026-05-08 qtm_spent_from_folder was corrected to 5,000,000, but
-- already-closed 2026-05-09..2026-05-11 rows still carried the older 4,639,400
-- closing balance. Keep the rows closed, but rewrite their cash-chain metadata.

create or replace function public.finance_daily_snapshot(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start_utc timestamptz;
  v_end_utc timestamptz;
  v_declaration jsonb;
  v_reconciliation jsonb;
  v_unc_detail numeric := 0;
  v_qtm_opening numeric := 0;
begin
  -- Interpret day boundaries in Asia/Saigon, compare against UTC timestamptz.
  v_start_utc := (p_date::timestamp at time zone 'Asia/Saigon');
  v_end_utc := ((p_date + 1)::timestamp at time zone 'Asia/Saigon');

  select to_jsonb(d)
    into v_declaration
  from (
    select
      closing_date,
      unc_total_declared,
      unc_extracted_amount,
      cash_fund_topup_amount,
      qtm_extracted_amount,
      notes,
      extraction_meta
    from public.ceo_daily_closing_declarations
    where closing_date = p_date
    limit 1
  ) d;

  select to_jsonb(r)
    into v_reconciliation
  from (
    select *
    from public.daily_reconciliations
    where closing_date = p_date
    limit 1
  ) r;

  -- UNC detail amount optimized for planner:
  -- Use UNION of 2 indexed branches (created_at window + invoice_date match)
  -- then dedupe by id and sum once.
  select coalesce(sum(x.total_amount), 0)
    into v_unc_detail
  from (
    select distinct on (u.id)
      u.id,
      u.total_amount
    from (
      select pr.id, pr.total_amount
      from public.payment_requests pr
      where pr.payment_method = 'bank_transfer'
        and pr.created_at >= v_start_utc
        and pr.created_at < v_end_utc
        and not (
          lower(concat_ws(' ', pr.title, pr.description, pr.notes, pr.image_url))
          ~ '(^|\W)qtm($|\W)|quỹ\s*tiền\s*mặt|quy\s*tien\s*mat|cash\s*fund'
        )

      union all

      select pr.id, pr.total_amount
      from public.payment_requests pr
      join public.invoices i on i.id = pr.invoice_id
      where pr.payment_method = 'bank_transfer'
        and i.invoice_date = p_date
        and not (
          lower(concat_ws(' ', pr.title, pr.description, pr.notes, pr.image_url))
          ~ '(^|\W)qtm($|\W)|quỹ\s*tiền\s*mặt|quy\s*tien\s*mat|cash\s*fund'
        )
    ) u
    order by u.id
  ) x;

  -- QTM opening must come from the nearest prior *closed* day. Do not let an
  -- unlocked/intermediate declaration with qtm_closing_balance=0 shadow the
  -- actual approved carry-forward.
  select coalesce(
      nullif(prev.extraction_meta->>'qtm_closing_balance', '')::numeric,
      coalesce(nullif(prev.extraction_meta->>'qtm_opening_balance', '')::numeric, 0)
        + coalesce(prev.qtm_extracted_amount, prev.cash_fund_topup_amount, 0)
        - coalesce(nullif(prev.extraction_meta->>'qtm_spent_from_folder', '')::numeric, 0)
    )
    into v_qtm_opening
  from public.ceo_daily_closing_declarations prev
  where prev.closing_date < p_date
    and coalesce((prev.extraction_meta->>'close_approval_locked')::boolean, false) = true
  order by prev.closing_date desc
  limit 1;

  if v_qtm_opening is null then
    v_qtm_opening := coalesce(nullif(v_declaration->'extraction_meta'->>'qtm_opening_balance', '')::numeric, 0);
  end if;

  return jsonb_build_object(
    'declaration', coalesce(v_declaration, 'null'::jsonb),
    'dailyReconciliation', coalesce(v_reconciliation, 'null'::jsonb),
    'uncDetailAmount', coalesce(v_unc_detail, 0),
    'qtmOpeningBalance', coalesce(v_qtm_opening, 0)
  );
end;
$$;

with repaired(closing_date, opening_balance, closing_balance) as (
  values
    ('2026-05-09'::date, -360600::numeric, -360600::numeric),
    ('2026-05-10'::date, -360600::numeric, -360600::numeric),
    ('2026-05-11'::date, -360600::numeric, 5210198::numeric)
)
update public.ceo_daily_closing_declarations d
set extraction_meta =
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            coalesce(d.extraction_meta, '{}'::jsonb),
            '{qtm_opening_balance}', to_jsonb(r.opening_balance), true
          ),
          '{qtm_closing_balance}', to_jsonb(r.closing_balance), true
        ),
        '{qtm_balance_repaired_at}', to_jsonb(now()), true
      ),
      '{qtm_balance_repair_reason}', to_jsonb('Repair stale carry-forward after 2026-05-08 QTM Drive rescan'::text), true
    ),
    updated_at = now()
from repaired r
where d.closing_date = r.closing_date
  and (
    nullif(d.extraction_meta->>'qtm_opening_balance', '')::numeric is distinct from r.opening_balance
    or nullif(d.extraction_meta->>'qtm_closing_balance', '')::numeric is distinct from r.closing_balance
  );
