-- Delivery staff OTP/session support for baocao shell access only.
-- Delivery actors share the public OTP UX, but cannot bootstrap/save kiosk reports.

alter table public.kiosk_report_otp_challenges
  add column if not exists actor_type text not null default 'report_staff',
  add column if not exists delivery_staff_id uuid references public.delivery_staff(id) on delete cascade,
  alter column staff_id drop not null,
  alter column location_id drop not null;

alter table public.kiosk_report_otp_challenges
  drop constraint if exists kiosk_report_otp_actor_type_check,
  add constraint kiosk_report_otp_actor_type_check
    check (actor_type in ('report_staff', 'delivery_staff'));

alter table public.kiosk_report_otp_challenges
  drop constraint if exists kiosk_report_otp_actor_shape_check,
  add constraint kiosk_report_otp_actor_shape_check
    check (
      (actor_type = 'report_staff' and staff_id is not null and location_id is not null and delivery_staff_id is null)
      or
      (actor_type = 'delivery_staff' and delivery_staff_id is not null and staff_id is null and location_id is null)
    ) not valid;

alter table public.kiosk_report_otp_challenges
  validate constraint kiosk_report_otp_actor_shape_check;

create index if not exists kiosk_report_otp_delivery_staff_idx
  on public.kiosk_report_otp_challenges(delivery_staff_id, created_at desc)
  where actor_type = 'delivery_staff';

alter table public.kiosk_report_sessions
  add column if not exists actor_type text not null default 'report_staff',
  add column if not exists delivery_staff_id uuid references public.delivery_staff(id) on delete cascade,
  alter column staff_id drop not null,
  alter column location_id drop not null;

alter table public.kiosk_report_sessions
  drop constraint if exists kiosk_report_sessions_actor_type_check,
  add constraint kiosk_report_sessions_actor_type_check
    check (actor_type in ('report_staff', 'delivery_staff'));

alter table public.kiosk_report_sessions
  drop constraint if exists kiosk_report_sessions_actor_shape_check,
  add constraint kiosk_report_sessions_actor_shape_check
    check (
      (actor_type = 'report_staff' and staff_id is not null and location_id is not null and delivery_staff_id is null)
      or
      (actor_type = 'delivery_staff' and delivery_staff_id is not null and staff_id is null and location_id is null)
    ) not valid;

alter table public.kiosk_report_sessions
  validate constraint kiosk_report_sessions_actor_shape_check;

create index if not exists kiosk_report_sessions_delivery_staff_idx
  on public.kiosk_report_sessions(delivery_staff_id, created_at desc)
  where actor_type = 'delivery_staff';
