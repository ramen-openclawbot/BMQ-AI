-- Finance Zalo OA worker schedule: every 2 minutes.
-- The worker still fails closed while finance_zalo_notifications_enabled is false
-- or ZALO_GMF_FINANCE_GROUP_ID is unset, so this schedule alone sends nothing.
do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'finance-zalo-notify-every-2-min'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'finance-zalo-notify-every-2-min',
    '*/2 * * * *',
    $job$
      select net.http_post(
        url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/finance-zalo-notify',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-worker-secret', (
            select worker_secret::text
            from public.finance_zalo_notification_config
            where id = 'finance-zalo'
          )
        ),
        body := jsonb_build_object('batch_size', 10),
        timeout_milliseconds := 10000
      );
    $job$
  );
end;
$$;
