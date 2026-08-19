revoke all on function public.create_kiosk_report_otp_challenge_atomic(uuid, text, text, timestamptz, text, text, text, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_kiosk_report_otp_challenge_atomic(uuid, text, text, timestamptz, text, text, text, uuid, uuid, uuid)
  to service_role;
