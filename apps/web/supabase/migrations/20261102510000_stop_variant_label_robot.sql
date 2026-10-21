-- Owner 21/10: the warehouse game no longer has robot Sushi, so its hourly
-- auto-labelling of variant names stops (scheduled in 20261101290000).
-- Labels already written and the stock-alias-jev function stay; staff label by hand.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'be-mi-variant-labels-hourly') then
    perform cron.unschedule('be-mi-variant-labels-hourly');
  end if;
end
$$;
