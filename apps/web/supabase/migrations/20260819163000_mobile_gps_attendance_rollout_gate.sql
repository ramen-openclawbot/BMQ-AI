-- Task10: default-off per-actor rollout gate for mobile GPS attendance.
-- No automatic enable/seed: a frontend deploy must not expose or call attendance until an owner/attendance.edit actor gate is explicitly enabled.

create table if not exists public.mobile_gps_attendance_pilot_actor_gates (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null,
  actor_id uuid not null,
  enabled boolean not null default false,
  reason_note text,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  unique(actor_type, actor_id),
  constraint mobile_gps_attendance_pilot_actor_gates_actor_type_check check (actor_type in ('report_staff', 'delivery_staff')),
  constraint mobile_gps_attendance_pilot_actor_gates_reason_note_check check (reason_note is null or length(btrim(reason_note)) between 8 and 1000)
);

create table if not exists public.mobile_gps_attendance_pilot_actor_gate_audit_logs (
  id uuid primary key default gen_random_uuid(),
  gate_id uuid not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor_type text,
  actor_id uuid,
  changed_by uuid,
  before_payload jsonb,
  after_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists mobile_gps_attendance_pilot_actor_gates_enabled_idx
  on public.mobile_gps_attendance_pilot_actor_gates(actor_type, actor_id)
  where enabled is true;
