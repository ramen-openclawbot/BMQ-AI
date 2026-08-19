create or replace function public.set_mobile_gps_attendance_pilot_actor_gate_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by, old.updated_by, new.created_by);
  return new;
end;
$$;
