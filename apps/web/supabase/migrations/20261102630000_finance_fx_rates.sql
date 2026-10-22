-- ===========================================================================
-- Finance FX rates (Vietcombank USD transfer)
-- ===========================================================================
-- One row per Vietnam calendar date. The daily worker stores the transfer
-- rate published by Vietcombank for that date; weekends/holidays may repeat
-- the previous business day's published rate. Source VND amounts stay intact.

create table if not exists public.finance_fx_rates (
  rate_date date primary key,
  currency text not null default 'USD' check (currency = 'USD'),
  vnd_per_usd numeric(12, 2) not null check (vnd_per_usd > 0),
  source text not null default 'vietcombank_transfer',
  fetched_at timestamptz not null default now()
);

alter table public.finance_fx_rates enable row level security;

-- No client policy: finance_can_view is not executable by authenticated, so
-- the table is read only through the SECURITY DEFINER RPC below.
revoke all on public.finance_fx_rates from public, anon, authenticated;
grant all on public.finance_fx_rates to service_role;

-- ===========================================================================
-- Monthly average FX RPC
-- ===========================================================================
-- Returns one entry per calendar month from the month containing p_from
-- through p_to. The current/final month is month-to-date: rows after p_to are
-- never included. Months without rows keep vnd_per_usd = null.

create or replace function public.finance_fx_monthly(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_month date;
  v_month_end date;
  v_days integer;
  v_avg numeric;
  v_first date;
  v_last date;
  v_source text;
  v_result jsonb := '[]'::jsonb;
begin
  if not public.finance_can_view(auth.uid()) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid_period' using errcode = '22023';
  end if;

  v_month := date_trunc('month', p_from)::date;

  while v_month <= p_to loop
    v_month_end := least((v_month + interval '1 month - 1 day')::date, p_to);

    select
      count(*)::integer,
      round(avg(vnd_per_usd), 2),
      min(rate_date),
      max(rate_date),
      (array_agg(source order by rate_date desc))[1]
    into v_days, v_avg, v_first, v_last, v_source
    from public.finance_fx_rates
    where currency = 'USD'
      and rate_date >= v_month
      and rate_date <= v_month_end;

    v_result := v_result || jsonb_build_array(
      jsonb_build_object(
        'month', to_char(v_month, 'YYYY-MM'),
        'vnd_per_usd', v_avg,
        'days', v_days,
        'first_date', v_first,
        'last_date', v_last,
        'source', v_source
      )
    );

    v_month := (v_month + interval '1 month')::date;
  end loop;

  return v_result;
end;
$$;

revoke all on function public.finance_fx_monthly(date, date) from public, anon;
grant execute on function public.finance_fx_monthly(date, date) to authenticated;

-- ===========================================================================
-- Daily Vietcombank sync schedule (02:15 UTC = 09:15 Asia/Ho_Chi_Minh)
-- ===========================================================================

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'finance-fx-sync-daily'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'finance-fx-sync-daily',
    '15 2 * * *',
    $job$
      select net.http_post(
        url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/finance-fx-sync',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-worker-secret', (
            select worker_secret::text
            from public.finance_zalo_notification_config
            where id = 'finance-zalo'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$
  );
end;
$$;
