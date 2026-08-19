create or replace function public.audit_mobile_gps_attendance_pilot_actor_gate_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.mobile_gps_attendance_pilot_actor_gate_audit_logs(
    gate_id,
    action,
    actor_type,
    actor_id,
    changed_by,
    before_payload,
    after_payload
  ) values (
    coalesce(new.id, old.id),
    lower(tg_op),
    coalesce(new.actor_type, old.actor_type),
    coalesce(new.actor_id, old.actor_id),
    auth.uid(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;
