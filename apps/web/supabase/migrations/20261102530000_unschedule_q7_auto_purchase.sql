-- Stop the q7-auto-purchase-daily cron job; the auto-purchase page and forecast
-- code were removed. The job may not exist on every environment.
DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'q7-auto-purchase-daily';
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
  END IF;
END $$;
