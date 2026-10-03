-- CEO month cutover for the 2026-06-03..2026-09-30 finance backlog.
--
-- Evidence for unscanned days can be collected without closing anything
-- (finance_cutover_day_evidence). A month cutover previews and then closes every
-- still-unclosed declared day of a month in one action, carrying the QTM balance
-- forward through the same extraction_meta keys the per-day chain already reads
-- (close_approval_locked / close_decision / qtm_opening_balance / qtm_spent /
-- qtm_closing_balance), so the daily chain and finance_auto_close_day treat the
-- days as closed. A cutover can be reverted. Nothing is ever deleted.

-- ---------------------------------------------------------------------------
-- (a) Per-day evidence snapshot collected without closing.
-- ---------------------------------------------------------------------------
create table if not exists public.finance_cutover_day_evidence (
  closing_date date primary key,
  unc_evidence_total numeric not null default 0,
  unc_file_count integer not null default 0,
  qtm_spent_total numeric not null default 0,
  qtm_file_count integer not null default 0,
  low_confidence_count integer not null default 0,
  blockers jsonb not null default '[]'::jsonb,
  scanned_at timestamptz not null default now(),
  scanned_by uuid
);

-- ---------------------------------------------------------------------------
-- (b) Month cutover records.
-- ---------------------------------------------------------------------------
create table if not exists public.finance_period_cutovers (
  id uuid primary key default gen_random_uuid(),
  period_month date not null,
  from_date date not null,
  to_date date not null,
  day_count integer not null default 0,
  unc_declared_total numeric not null default 0,
  unc_evidence_total numeric not null default 0,
  unc_variance numeric not null default 0,
  qtm_opening_balance numeric not null default 0,
  qtm_topup_total numeric not null default 0,
  qtm_spent_total numeric not null default 0,
  qtm_closing_computed numeric not null default 0,
  qtm_closing_counted numeric,
  qtm_count_variance numeric not null default 0,
  days_missing_evidence jsonb not null default '[]'::jsonb,
  preview_hash text not null,
  note text,
  status text not null default 'closed' check (status in ('closed', 'reverted')),
  created_by uuid,
  created_at timestamptz not null default now(),
  reverted_by uuid,
  reverted_at timestamptz,
  revert_note text
);

create unique index if not exists uq_finance_period_cutovers_closed_month
  on public.finance_period_cutovers (period_month)
  where status = 'closed';

create index if not exists idx_finance_period_cutovers_period
  on public.finance_period_cutovers (period_month desc, status);

-- ---------------------------------------------------------------------------
-- (c) RLS: owner may select only. No direct table writes for anon/authenticated.
-- ---------------------------------------------------------------------------
alter table public.finance_cutover_day_evidence enable row level security;
alter table public.finance_period_cutovers enable row level security;

revoke all on public.finance_cutover_day_evidence from public, anon, authenticated;
revoke all on public.finance_period_cutovers from public, anon, authenticated;
grant all on public.finance_cutover_day_evidence to service_role;
grant all on public.finance_period_cutovers to service_role;
grant select on public.finance_cutover_day_evidence to authenticated;
grant select on public.finance_period_cutovers to authenticated;

drop policy if exists finance_cutover_day_evidence_owner_select on public.finance_cutover_day_evidence;
create policy finance_cutover_day_evidence_owner_select
  on public.finance_cutover_day_evidence
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'owner'));

drop policy if exists finance_period_cutovers_owner_select on public.finance_period_cutovers;
create policy finance_period_cutovers_owner_select
  on public.finance_period_cutovers
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'owner'));

-- ---------------------------------------------------------------------------
-- finance_cutover_preview: read-only preview of one month of the backlog.
-- ---------------------------------------------------------------------------
create or replace function public.finance_cutover_preview(p_month date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_month_start date;
  v_month_end date;
  v_days jsonb := '[]'::jsonb;
  v_day_count integer := 0;
  v_unc_declared_total numeric := 0;
  v_unc_evidence_total numeric := 0;
  v_unc_variance numeric := 0;
  v_qtm_topup_total numeric := 0;
  v_qtm_spent_total numeric := 0;
  v_qtm_opening numeric := 0;
  v_prior_closing numeric;
  v_qtm_closing_computed numeric := 0;
  v_missing jsonb := '[]'::jsonb;
  v_prior_unclosed_date date;
  v_prior_unclosed boolean := false;
  v_decl record;
  v_evidence public.finance_cutover_day_evidence%rowtype;
  v_payload jsonb;
begin
  if not public.has_role(auth.uid(), 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_month is null then
    raise exception 'month_required' using errcode = '22023';
  end if;

  v_month_start := date_trunc('month', p_month)::date;
  v_month_end := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;

  -- QTM opening: the latest locked day strictly before the month, otherwise the
  -- closing of the latest closed cutover that ended before the month.
  select coalesce(
           nullif(d.extraction_meta->>'qtm_closing_balance', '')::numeric,
           coalesce(nullif(d.extraction_meta->>'qtm_opening_balance', '')::numeric, 0)
             + coalesce(d.qtm_extracted_amount, d.cash_fund_topup_amount, 0)
             - coalesce(nullif(d.extraction_meta->>'qtm_spent_from_folder', '')::numeric, 0)
         )
  into v_prior_closing
  from public.ceo_daily_closing_declarations d
  where d.closing_date < v_month_start
    and coalesce(d.extraction_meta->>'close_approval_locked', 'false') = 'true'
  order by d.closing_date desc
  limit 1;

  if v_prior_closing is null then
    select c.qtm_closing_computed
    into v_prior_closing
    from public.finance_period_cutovers c
    where c.status = 'closed'
      and c.to_date < v_month_start
    order by c.to_date desc, c.created_at desc
    limit 1;
  end if;

  v_qtm_opening := coalesce(v_prior_closing, 0);

  -- Any declared but unlocked day before this month blocks a cutover.
  select min(d.closing_date)
  into v_prior_unclosed_date
  from public.ceo_daily_closing_declarations d
  where d.closing_date < v_month_start
    and coalesce(d.extraction_meta->>'close_approval_locked', 'false') <> 'true';

  v_prior_unclosed := v_prior_unclosed_date is not null;

  -- Declared days of the month that are still unlocked.
  for v_decl in
    select d.closing_date,
           coalesce(d.unc_total_declared, 0) as unc_declared,
           coalesce(d.cash_fund_topup_amount, 0) as qtm_topup
    from public.ceo_daily_closing_declarations d
    where d.closing_date between v_month_start and v_month_end
      and coalesce(d.extraction_meta->>'close_approval_locked', 'false') <> 'true'
    order by d.closing_date asc
  loop
    select * into v_evidence
    from public.finance_cutover_day_evidence e
    where e.closing_date = v_decl.closing_date;

    if found then
      v_days := v_days || jsonb_build_array(jsonb_build_object(
        'closing_date', v_decl.closing_date,
        'unc_declared', v_decl.unc_declared,
        'unc_evidence_total', v_evidence.unc_evidence_total,
        'unc_file_count', v_evidence.unc_file_count,
        'qtm_topup', v_decl.qtm_topup,
        'qtm_spent_total', v_evidence.qtm_spent_total,
        'qtm_file_count', v_evidence.qtm_file_count,
        'low_confidence_count', v_evidence.low_confidence_count,
        'evidence_scanned', true,
        'blockers', coalesce(v_evidence.blockers, '[]'::jsonb)
      ));

      v_unc_evidence_total := v_unc_evidence_total + coalesce(v_evidence.unc_evidence_total, 0);
      v_qtm_spent_total := v_qtm_spent_total + coalesce(v_evidence.qtm_spent_total, 0);
    else
      v_days := v_days || jsonb_build_array(jsonb_build_object(
        'closing_date', v_decl.closing_date,
        'unc_declared', v_decl.unc_declared,
        'unc_evidence_total', 0,
        'unc_file_count', 0,
        'qtm_topup', v_decl.qtm_topup,
        'qtm_spent_total', 0,
        'qtm_file_count', 0,
        'low_confidence_count', 0,
        'evidence_scanned', false,
        'blockers', '[]'::jsonb
      ));
      v_missing := v_missing || to_jsonb(v_decl.closing_date);
    end if;

    v_unc_declared_total := v_unc_declared_total + v_decl.unc_declared;
    v_qtm_topup_total := v_qtm_topup_total + v_decl.qtm_topup;
    v_day_count := v_day_count + 1;
  end loop;

  v_unc_variance := v_unc_declared_total - v_unc_evidence_total;
  v_qtm_closing_computed := v_qtm_opening + v_qtm_topup_total - v_qtm_spent_total;

  v_payload := jsonb_build_object(
    'period_month', v_month_start,
    'from_date', v_month_start,
    'to_date', v_month_end,
    'day_count', v_day_count,
    'days', v_days,
    'unc_declared_total', v_unc_declared_total,
    'unc_evidence_total', v_unc_evidence_total,
    'unc_variance', v_unc_variance,
    'qtm_opening_balance', v_qtm_opening,
    'qtm_topup_total', v_qtm_topup_total,
    'qtm_spent_total', v_qtm_spent_total,
    'qtm_closing_computed', v_qtm_closing_computed,
    'days_missing_evidence', v_missing,
    'prior_unclosed_before_month', v_prior_unclosed,
    'prior_unclosed_before_month_date', v_prior_unclosed_date
  );

  return v_payload || jsonb_build_object('preview_hash', md5(v_payload::text));
end;
$$;

-- ---------------------------------------------------------------------------
-- finance_cutover_close_month: lock every unclosed declared day of the month.
-- ---------------------------------------------------------------------------
create or replace function public.finance_cutover_close_month(
  p_month date,
  p_expected_hash text,
  p_qtm_counted numeric default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_month_start date;
  v_month_end date;
  v_existing public.finance_period_cutovers%rowtype;
  v_preview jsonb;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_cutover_id uuid;
  v_running numeric := 0;
  v_topup numeric := 0;
  v_spent numeric := 0;
  v_closing numeric := 0;
  v_last_date date;
  v_day record;
  v_locked_count integer := 0;
  v_summary jsonb;
begin
  if not public.has_role(auth.uid(), 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_month is null then
    raise exception 'month_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('finance_period_cutover'));

  v_month_start := date_trunc('month', p_month)::date;
  v_month_end := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;

  -- Idempotent repeat: the unique closed cutover for the month is returned as-is.
  select * into v_existing
  from public.finance_period_cutovers
  where period_month = v_month_start
    and status = 'closed'
  order by created_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'ok', true,
      'already_closed', true,
      'cutover_id', v_existing.id,
      'period_month', v_existing.period_month,
      'summary', to_jsonb(v_existing)
    );
  end if;

  if exists (
    select 1
    from public.ceo_daily_closing_declarations d
    where d.closing_date < v_month_start
      and coalesce(d.extraction_meta->>'close_approval_locked', 'false') <> 'true'
  ) then
    raise exception 'prior_month_unclosed' using errcode = 'P0001';
  end if;

  v_preview := public.finance_cutover_preview(v_month_start);

  if v_preview->>'preview_hash' is distinct from p_expected_hash then
    raise exception 'preview_changed' using errcode = 'P0001';
  end if;

  if v_note is null and (
    (v_preview->>'unc_variance')::numeric <> 0
    or (
      p_qtm_counted is not null
      and p_qtm_counted is distinct from (v_preview->>'qtm_closing_computed')::numeric
    )
  ) then
    raise exception 'note_required' using errcode = '22023';
  end if;

  v_running := (v_preview->>'qtm_opening_balance')::numeric;

  insert into public.finance_period_cutovers (
    period_month,
    from_date,
    to_date,
    day_count,
    unc_declared_total,
    unc_evidence_total,
    unc_variance,
    qtm_opening_balance,
    qtm_topup_total,
    qtm_spent_total,
    qtm_closing_computed,
    qtm_closing_counted,
    qtm_count_variance,
    days_missing_evidence,
    preview_hash,
    note,
    status,
    created_by,
    created_at
  ) values (
    v_month_start,
    v_month_start,
    v_month_end,
    (v_preview->>'day_count')::integer,
    (v_preview->>'unc_declared_total')::numeric,
    (v_preview->>'unc_evidence_total')::numeric,
    (v_preview->>'unc_variance')::numeric,
    v_running,
    (v_preview->>'qtm_topup_total')::numeric,
    (v_preview->>'qtm_spent_total')::numeric,
    (v_preview->>'qtm_closing_computed')::numeric,
    p_qtm_counted,
    case
      when p_qtm_counted is null then 0
      else p_qtm_counted - (v_preview->>'qtm_closing_computed')::numeric
    end,
    coalesce(v_preview->'days_missing_evidence', '[]'::jsonb),
    p_expected_hash,
    v_note,
    'closed',
    v_actor,
    now()
  )
  returning id into v_cutover_id;

  select max(d.closing_date)
  into v_last_date
  from public.ceo_daily_closing_declarations d
  where d.closing_date between v_month_start and v_month_end
    and coalesce(d.extraction_meta->>'close_approval_locked', 'false') <> 'true';

  for v_day in
    select d.id,
           d.closing_date,
           coalesce(d.cash_fund_topup_amount, 0) as qtm_topup,
           coalesce(d.extraction_meta, '{}'::jsonb) as meta,
           coalesce(e.qtm_spent_total, 0) as qtm_spent
    from public.ceo_daily_closing_declarations d
    left join public.finance_cutover_day_evidence e
      on e.closing_date = d.closing_date
    where d.closing_date between v_month_start and v_month_end
      and coalesce(d.extraction_meta->>'close_approval_locked', 'false') <> 'true'
    order by d.closing_date asc
    for update of d
  loop
    v_topup := coalesce(v_day.qtm_topup, 0);
    v_spent := coalesce(v_day.qtm_spent, 0);
    v_closing := v_running + v_topup - v_spent;

    -- The counted balance, when supplied, is authoritative for the last day.
    if v_day.closing_date = v_last_date and p_qtm_counted is not null then
      v_closing := p_qtm_counted;
    end if;

    update public.ceo_daily_closing_declarations
    set extraction_meta = (
          coalesce(v_day.meta, '{}'::jsonb)
          || jsonb_build_object(
               -- Values this cutover overwrites, restored exactly by finance_cutover_revert.
               'cutover_prev', jsonb_build_object(
                 'close_approval_locked', v_day.meta->'close_approval_locked',
                 'close_decision', v_day.meta->'close_decision',
                 'qtm_opening_balance', v_day.meta->'qtm_opening_balance',
                 'qtm_spent_from_folder', v_day.meta->'qtm_spent_from_folder',
                 'qtm_closing_balance', v_day.meta->'qtm_closing_balance'
               ),
               'close_approval_locked', true,
               'close_decision', 'cutover_month',
               'cutover_id', v_cutover_id,
               'qtm_opening_balance', v_running,
               -- Same key the daily close and the monthly table read.
               'qtm_spent_from_folder', v_spent,
               'qtm_closing_balance', v_closing
             )
        ) || jsonb_build_object(
          'finance_auto_close_audit_log',
          coalesce(v_day.meta->'finance_auto_close_audit_log', '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object(
                 'action', 'cutover_month_close',
                 'cutover_id', v_cutover_id,
                 'at', now(),
                 'by', v_actor
               ))
        ),
        updated_at = now()
    where id = v_day.id;

    v_running := v_closing;
    v_locked_count := v_locked_count + 1;
  end loop;

  select to_jsonb(c) into v_summary
  from public.finance_period_cutovers c
  where c.id = v_cutover_id;

  return jsonb_build_object(
    'ok', true,
    'already_closed', false,
    'cutover_id', v_cutover_id,
    'period_month', v_month_start,
    'from_date', v_month_start,
    'to_date', v_month_end,
    'day_count', v_locked_count,
    'summary', v_summary
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- finance_cutover_revert: unlock the days written by one cutover.
-- ---------------------------------------------------------------------------
create or replace function public.finance_cutover_revert(
  p_cutover_id uuid,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_cutover public.finance_period_cutovers%rowtype;
  v_day record;
  v_day_count integer := 0;
begin
  if not public.has_role(auth.uid(), 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_cutover_id is null then
    raise exception 'cutover_required' using errcode = '22023';
  end if;

  if v_note is null then
    raise exception 'note_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('finance_period_cutover'));

  select * into v_cutover
  from public.finance_period_cutovers
  where id = p_cutover_id
  for update;

  if not found then
    raise exception 'cutover_not_found' using errcode = 'P0002';
  end if;

  if v_cutover.status <> 'closed' then
    return jsonb_build_object(
      'ok', true,
      'already_reverted', true,
      'cutover_id', v_cutover.id,
      'status', v_cutover.status
    );
  end if;

  if exists (
    select 1
    from public.finance_period_cutovers c
    where c.status = 'closed'
      and c.period_month > v_cutover.period_month
  ) then
    raise exception 'later_cutover_exists' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.ceo_daily_closing_declarations d
    where d.closing_date > v_cutover.to_date
      and coalesce(d.extraction_meta->>'close_approval_locked', 'false') = 'true'
      and coalesce(d.extraction_meta->>'close_decision', '') <> 'cutover_month'
  ) then
    raise exception 'later_day_closed' using errcode = 'P0001';
  end if;

  for v_day in
    select d.id,
           coalesce(d.extraction_meta, '{}'::jsonb) as meta
    from public.ceo_daily_closing_declarations d
    where d.extraction_meta->>'cutover_id' = p_cutover_id::text
    order by d.closing_date asc
    for update
  loop
    update public.ceo_daily_closing_declarations
    -- Restore exactly what the cutover overwrote: keys that did not exist before
    -- are removed again, keys that existed get their previous value back.
    set extraction_meta = (
          (
            coalesce(v_day.meta, '{}'::jsonb)
            - 'cutover_id'
            - 'cutover_prev'
            - 'close_approval_locked'
            - 'close_decision'
            - 'qtm_opening_balance'
            - 'qtm_spent_from_folder'
            - 'qtm_closing_balance'
          )
          || jsonb_strip_nulls(coalesce(v_day.meta->'cutover_prev', '{}'::jsonb))
          || jsonb_build_object(
               'finance_auto_close_audit_log',
               coalesce(v_day.meta->'finance_auto_close_audit_log', '[]'::jsonb)
                 || jsonb_build_array(jsonb_build_object(
                      'action', 'cutover_month_revert',
                      'cutover_id', p_cutover_id,
                      'at', now(),
                      'by', v_actor
                    ))
             )
        ),
        updated_at = now()
    where id = v_day.id;

    v_day_count := v_day_count + 1;
  end loop;

  update public.finance_period_cutovers
  set status = 'reverted',
      reverted_by = v_actor,
      reverted_at = now(),
      revert_note = v_note
  where id = p_cutover_id;

  return jsonb_build_object(
    'ok', true,
    'already_reverted', false,
    'cutover_id', p_cutover_id,
    'period_month', v_cutover.period_month,
    'day_count', v_day_count
  );
end;
$$;

revoke all on function public.finance_cutover_preview(date) from public, anon;
revoke all on function public.finance_cutover_close_month(date, text, numeric, text) from public, anon;
revoke all on function public.finance_cutover_revert(uuid, text) from public, anon;

grant execute on function public.finance_cutover_preview(date) to authenticated;
grant execute on function public.finance_cutover_close_month(date, text, numeric, text) to authenticated;
grant execute on function public.finance_cutover_revert(uuid, text) to authenticated;

comment on table public.finance_cutover_day_evidence is 'Per-day UNC/QTM Drive evidence collected without closing the day. OCR results are cached in drive_file_index by the finance-auto-close-day edge function.';
comment on table public.finance_period_cutovers is 'CEO month cutovers: one row per closed/reverted month of the finance backlog. Closing locks every unclosed declared day of the month and carries QTM forward; reverted rows preserve history (no deletes).';
comment on function public.finance_cutover_preview(date) is 'Read-only owner preview of one backlog month: declared vs scanned UNC, QTM opening/topup/spend/closing, missing evidence days, prior unclosed month and a canonical preview_hash.';
comment on function public.finance_cutover_close_month(date, text, numeric, text) is 'Owner-only month cutover: idempotent on already-closed months, requires the preview hash, optional counted QTM balance, locks all unclosed declared days in date order and appends an audit entry.';
comment on function public.finance_cutover_revert(uuid, text) is 'Owner-only cutover revert: requires a note, refuses when a later cutover or a later non-cutover closed day exists, and resets the cutover days to close_approval_locked=false without deleting data.';
