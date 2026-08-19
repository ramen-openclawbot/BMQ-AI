create or replace function public.verify_kiosk_report_otp_atomic(
  p_challenge_id uuid,
  p_phone_normalized text,
  p_otp_hash text,
  p_session_token_hash text,
  p_session_expires_at timestamptz,
  p_request_ip text,
  p_user_agent text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_challenge public.kiosk_report_otp_challenges%rowtype;
  v_staff public.kiosk_report_staff%rowtype;
  v_delivery_staff public.delivery_staff%rowtype;
  v_location public.kiosk_report_locations%rowtype;
  v_attempts integer;
  v_session public.kiosk_report_sessions%rowtype;
begin
  if coalesce(p_phone_normalized, '') !~ '^84(3|5|7|8|9)[0-9]{8}$'
    or coalesce(p_otp_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_session_token_hash, '') !~ '^[0-9a-f]{64}$'
    or p_session_expires_at <= v_now
    or p_session_expires_at > v_now + interval '24 hours' then
    raise exception 'invalid_report_otp_verification_input';
  end if;

  select *
    into v_challenge
  from public.kiosk_report_otp_challenges
  where id = p_challenge_id
    and phone_normalized = p_phone_normalized
  for update;

  if not found
    or v_challenge.consumed_at is not null
    or v_challenge.expires_at <= v_now then
    return jsonb_build_object('status', 'otp_invalid_or_expired');
  end if;

  if v_challenge.attempts >= v_challenge.max_attempts then
    update public.kiosk_report_otp_challenges
    set consumed_at = coalesce(consumed_at, v_now),
        send_status = 'max_attempts'
    where id = v_challenge.id;

    return jsonb_build_object('status', 'otp_max_attempts');
  end if;

  v_attempts := v_challenge.attempts + 1;

  if v_challenge.otp_hash is distinct from p_otp_hash then
    update public.kiosk_report_otp_challenges
    set attempts = v_attempts,
        consumed_at = case when v_attempts >= max_attempts then v_now else null end,
        send_status = case when v_attempts >= max_attempts then 'max_attempts' else send_status end
    where id = v_challenge.id;

    return jsonb_build_object(
      'status',
      case when v_attempts >= v_challenge.max_attempts then 'otp_max_attempts' else 'otp_invalid_or_expired' end
    );
  end if;

  if v_challenge.actor_type = 'delivery_staff' then
    select *
      into v_delivery_staff
    from public.delivery_staff
    where id = v_challenge.delivery_staff_id;

    if v_delivery_staff.id is null
      or v_delivery_staff.active is not true
      or v_delivery_staff.phone_normalized <> p_phone_normalized then
      update public.kiosk_report_otp_challenges
      set attempts = v_attempts,
          consumed_at = v_now,
          send_status = 'staff_inactive'
      where id = v_challenge.id;

      return jsonb_build_object('status', 'report_staff_inactive');
    end if;

    update public.kiosk_report_otp_challenges
    set attempts = v_attempts,
        consumed_at = v_now,
        send_status = 'verified'
    where id = v_challenge.id;

    insert into public.kiosk_report_sessions (
      actor_type,
      delivery_staff_id,
      token_hash,
      expires_at,
      last_seen_at,
      request_ip,
      user_agent
    )
    values (
      'delivery_staff',
      v_delivery_staff.id,
      p_session_token_hash,
      p_session_expires_at,
      v_now,
      nullif(trim(coalesce(p_request_ip, '')), ''),
      nullif(trim(coalesce(p_user_agent, '')), '')
    )
    returning * into v_session;

    return jsonb_build_object(
      'status', 'verified',
      'actor_type', 'delivery_staff',
      'expires_at', v_session.expires_at,
      'delivery_staff', jsonb_build_object(
        'id', v_delivery_staff.id,
        'full_name', v_delivery_staff.full_name,
        'actor_type', 'delivery_staff'
      )
    );
  end if;

  select *
    into v_staff
  from public.kiosk_report_staff
  where id = v_challenge.staff_id;

  select *
    into v_location
  from public.kiosk_report_locations
  where id = v_challenge.location_id;

  if v_staff.id is null
    or v_location.id is null
    or v_staff.active is not true
    or v_location.active is not true
    or v_staff.phone_normalized <> p_phone_normalized
    or v_staff.location_id <> v_location.id then
    update public.kiosk_report_otp_challenges
    set attempts = v_attempts,
        consumed_at = v_now,
        send_status = 'staff_inactive'
    where id = v_challenge.id;

    return jsonb_build_object('status', 'report_staff_inactive');
  end if;

  update public.kiosk_report_otp_challenges
  set attempts = v_attempts,
      consumed_at = v_now,
      send_status = 'verified'
  where id = v_challenge.id;

  insert into public.kiosk_report_sessions (
    actor_type,
    staff_id,
    location_id,
    token_hash,
    expires_at,
    last_seen_at,
    request_ip,
    user_agent
  )
  values (
    'report_staff',
    v_staff.id,
    v_location.id,
    p_session_token_hash,
    p_session_expires_at,
    v_now,
    nullif(trim(coalesce(p_request_ip, '')), ''),
    nullif(trim(coalesce(p_user_agent, '')), '')
  )
  returning * into v_session;

  return jsonb_build_object(
    'status', 'verified',
    'actor_type', 'report_staff',
    'expires_at', v_session.expires_at,
    'staff', jsonb_build_object(
      'id', v_staff.id,
      'full_name', v_staff.full_name,
      'actor_type', 'report_staff'
    ),
    'location', jsonb_build_object(
      'code', v_location.location_code,
      'name', v_location.location_name,
      'address', v_location.address
    )
  );
end;
$$;
