-- Stop-between-files safe SECURITY DEFINER creation: create and revoke browser EXECUTE in one DO transaction.
do $migration$
begin
  execute $sql$
create or replace function public.create_kiosk_report_otp_challenge_atomic(
  p_challenge_id uuid,
  p_phone_normalized text,
  p_otp_hash text,
  p_expires_at timestamptz,
  p_request_ip text,
  p_user_agent text,
  p_actor_type text,
  p_staff_id uuid,
  p_location_id uuid,
  p_delivery_staff_id uuid
)
returns jsonb
language $sql$ || 'plpgsql' || $sql$
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_recent_id uuid;
begin
  if p_challenge_id is null
    or coalesce(p_phone_normalized, '') !~ '^84(3|5|7|8|9)[0-9]{8}$'
    or coalesce(p_otp_hash, '') !~ '^[0-9a-f]{64}$'
    or p_expires_at <= v_now
    or p_expires_at > v_now + interval '15 minutes'
    or p_actor_type not in ('report_staff', 'delivery_staff')
    or (p_actor_type = 'report_staff' and (p_staff_id is null or p_location_id is null or p_delivery_staff_id is not null))
    or (p_actor_type = 'delivery_staff' and (p_delivery_staff_id is null or p_staff_id is not null or p_location_id is not null)) then
    raise exception 'invalid_report_otp_challenge_input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('public.kiosk_report_otp_challenge:' || p_phone_normalized, 0));

  select id
    into v_recent_id
  from public.kiosk_report_otp_challenges
  where phone_normalized = p_phone_normalized
    and created_at >= v_now - interval '60 seconds'
  order by created_at desc, id desc
  limit 1;

  if v_recent_id is not null then
    return jsonb_build_object(
      'status', 'cooldown',
      'challenge_id', v_recent_id,
      'retry_after_seconds', 60
    );
  end if;

  update public.kiosk_report_otp_challenges
  set consumed_at = coalesce(consumed_at, v_now),
      send_status = 'superseded'
  where phone_normalized = p_phone_normalized
    and consumed_at is null;

  insert into public.kiosk_report_otp_challenges (
    id,
    actor_type,
    staff_id,
    delivery_staff_id,
    location_id,
    phone_normalized,
    otp_hash,
    expires_at,
    request_ip,
    user_agent
  ) values (
    p_challenge_id,
    p_actor_type,
    p_staff_id,
    p_delivery_staff_id,
    p_location_id,
    p_phone_normalized,
    p_otp_hash,
    p_expires_at,
    nullif(trim(coalesce(p_request_ip, '')), ''),
    nullif(trim(coalesce(p_user_agent, '')), '')
  );

  return jsonb_build_object(
    'status', 'created',
    'challenge_id', p_challenge_id
  );
end;
$$;
$sql$;
  revoke execute on function public.create_kiosk_report_otp_challenge_atomic(uuid, text, text, timestamptz, text, text, text, uuid, uuid, uuid) from public, anon, authenticated;
end
$migration$;
