create or replace function public.prevent_submitted_kiosk_report_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'submitted' then
    raise exception 'Submitted kiosk reports are immutable.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;
