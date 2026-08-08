-- Only the permission-gated RPC transaction may update submitted child rows.

create or replace function public.prevent_submitted_kiosk_report_child_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_status text;
  target_report_id uuid;
begin
  if current_setting('app.kiosk_report_authorized_edit', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  target_report_id = case when tg_op = 'DELETE' then old.report_id else new.report_id end;
  select status into parent_status from public.kiosk_daily_reports where id = target_report_id;
  if parent_status = 'submitted' then
    raise exception 'Submitted kiosk report rows are immutable.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
