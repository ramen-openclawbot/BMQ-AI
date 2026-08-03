-- Run warehouse Zalo delivery only during the approved Vietnam evening window.
-- Supabase pg_cron evaluates these expressions in UTC. Vietnam is UTC+7 year-round:
--   13:00-15:30 UTC = 20:00-22:30 Asia/Ho_Chi_Minh
--   16:00,16:30,16:59 UTC = 23:00,23:30,23:59 Asia/Ho_Chi_Minh

do $schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname in (
      'dealer-warehouse-notify-every-2-minutes',
      'dealer-warehouse-notify-vn-20-22-30',
      'dealer-warehouse-notify-vn-23-final'
    )
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'dealer-warehouse-notify-vn-20-22-30',
    '0,30 13-15 * * *',
    $job$
      select net.http_post(
        url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/dealer-warehouse-notify',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-worker-secret', (
            select worker_secret::text
            from public.dealer_notification_worker_config
            where id = 'warehouse-zalo'
          )
        ),
        body := jsonb_build_object('batch_size', 10),
        timeout_milliseconds := 10000
      );
    $job$
  );

  perform cron.schedule(
    'dealer-warehouse-notify-vn-23-final',
    '0,30,59 16 * * *',
    $job$
      select net.http_post(
        url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/dealer-warehouse-notify',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-worker-secret', (
            select worker_secret::text
            from public.dealer_notification_worker_config
            where id = 'warehouse-zalo'
          )
        ),
        body := jsonb_build_object('batch_size', 10),
        timeout_milliseconds := 10000
      );
    $job$
  );
end;
$schedule$;
