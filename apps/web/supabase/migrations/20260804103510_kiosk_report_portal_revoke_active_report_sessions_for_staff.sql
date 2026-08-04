create or replace function public.revoke_active_report_sessions_for_staff()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.location_id is distinct from new.location_id
    or old.active is distinct from new.active
    or old.phone_normalized is distinct from new.phone_normalized then
    update public.kiosk_report_sessions
      set revoked_at = coalesce(revoked_at, now())
    where staff_id = new.id
      and revoked_at is null;
  end if;

  return new;
end;
$$;
