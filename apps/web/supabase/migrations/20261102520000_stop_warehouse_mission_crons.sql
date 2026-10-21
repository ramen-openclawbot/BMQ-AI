-- Owner 21/10: the old warehouse game, including Nhiệm vụ, is removed from the app,
-- so staff can no longer submit missions. Stop the reminders and the Zalo notify loop
-- (scheduled with the mission cards). Mission data and functions stay.
do $$
declare
  job_name text;
begin
  foreach job_name in array array['mission-reminders-hourly', 'mission-zalo-notify-every-2-min'] loop
    if exists (select 1 from cron.job where jobname = job_name) then
      perform cron.unschedule(job_name);
    end if;
  end loop;
end
$$;
