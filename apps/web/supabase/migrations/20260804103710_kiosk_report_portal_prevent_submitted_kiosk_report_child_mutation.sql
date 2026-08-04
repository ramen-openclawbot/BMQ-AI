create or replace function public.prevent_submitted_kiosk_report_child_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_status text;
  target_report_id uuid;
begin
  target_report_id = case when tg_op = 'DELETE' then old.report_id else new.report_id end;

  select status
    into parent_status
  from public.kiosk_daily_reports
  where id = target_report_id;

  if parent_status = 'submitted' then
    raise exception 'Submitted kiosk report rows are immutable.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;
