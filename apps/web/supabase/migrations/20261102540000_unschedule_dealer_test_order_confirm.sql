-- Stop the dealer-test-order-confirm-notify-every-minute cron job (TEST order
-- confirmation). The job may not exist on every environment.
DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'dealer-test-order-confirm-notify-every-minute';
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
  END IF;
END $$;
