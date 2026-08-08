-- Permission-gated, fully audited correction of submitted kiosk reports.

alter table public.kiosk_point_revenue_audit_logs
  drop constraint if exists kiosk_point_revenue_audit_logs_action_check;
alter table public.kiosk_point_revenue_audit_logs
  add constraint kiosk_point_revenue_audit_logs_action_check
  check (action in ('save_review', 'mark_reviewed', 'edit_report'));

create or replace function public.prevent_submitted_kiosk_report_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('app.kiosk_report_authorized_edit', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if old.status = 'submitted' then
    raise exception 'Submitted kiosk reports are immutable.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
