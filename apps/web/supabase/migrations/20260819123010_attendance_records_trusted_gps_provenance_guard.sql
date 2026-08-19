-- Task6 hardening: guard trusted GPS provenance on attendance_records.
-- Ordinary attendance editors keep normal manual DML, but cannot spoof or detach mobile GPS lineage.
-- Threat model: PostgREST service_role bypasses RLS but must not directly create, alter,
-- detach, or delete mobile GPS provenance by raw DML. A custom GUC alone is forgeable,
-- so this guard trusts it only when it names a same-transaction/same-backend row in a
-- DB-owned context table whose ACL is revoked from service_role/authenticated callers.

create table if not exists public.attendance_records_trusted_gps_context (
  context_token uuid primary key,
  txid bigint not null,
  backend_pid integer not null,
  purpose text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint attendance_records_trusted_gps_context_purpose_check
    check (purpose = 'mobile_gps_attendance_sync')
);

revoke all on table public.attendance_records_trusted_gps_context from public, anon, authenticated, service_role;

create or replace function public.guard_attendance_records_trusted_gps_provenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_text text := nullif(current_setting('attendance_records.trusted_gps_token', true), '');
  v_trusted boolean := false;
begin
  if v_token_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select exists (
      select 1
      from public.attendance_records_trusted_gps_context c
      where c.context_token = v_token_text::uuid
        and c.txid = txid_current()
        and c.backend_pid = pg_backend_pid()
        and c.purpose = 'mobile_gps_attendance_sync'
    ) into v_trusted;
  end if;

  if TG_OP = 'INSERT' then
    if (NEW.source_type is null or NEW.source_type = 'manual')
       and NEW.source_event_id is null
       and NEW.source_actor_type is null
       and NEW.source_distance_m is null
       and NEW.source_accuracy_m is null then
      return NEW;
    end if;

    if not v_trusted then
      raise exception 'attendance_records_gps_provenance_insert_forbidden' using errcode = '42501';
    end if;
    return NEW;
  elsif TG_OP = 'UPDATE' then
    if OLD.source_type is not distinct from NEW.source_type
       and OLD.source_event_id is not distinct from NEW.source_event_id
       and OLD.source_actor_type is not distinct from NEW.source_actor_type
       and OLD.source_distance_m is not distinct from NEW.source_distance_m
       and OLD.source_accuracy_m is not distinct from NEW.source_accuracy_m then
      return NEW;
    end if;

    if not v_trusted then
      raise exception 'attendance_records_gps_provenance_update_forbidden' using errcode = '42501';
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    if OLD.source_type = 'mobile_gps' or OLD.source_event_id is not null then
      raise exception 'attendance_records_gps_provenance_delete_forbidden' using errcode = '42501';
    end if;
    return OLD;
  end if;

  raise exception 'attendance_records_gps_provenance_unknown_operation' using errcode = '42501';
end;
$$;

revoke all on function public.guard_attendance_records_trusted_gps_provenance() from public, anon, authenticated, service_role;

drop trigger if exists guard_attendance_records_trusted_gps_provenance on public.attendance_records;
create trigger guard_attendance_records_trusted_gps_provenance
  before insert or update or delete on public.attendance_records
  for each row execute function public.guard_attendance_records_trusted_gps_provenance();

comment on function public.guard_attendance_records_trusted_gps_provenance() is
  'Task6 guard: only DB-owned trusted sync context may write attendance_records mobile GPS provenance; GPS rows cannot be directly deleted.';
