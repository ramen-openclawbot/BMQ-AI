-- 2026-10-18 — Staff pickers list only people who can actually log in.
--
-- Owner 18/10 (IMG_5848): "Giao việc mới" listed six kfm-selftest-…@selftest.invalid
-- accounts. They are leftovers of the 12/09 KFM portal self-test: the auth users were
-- deleted, but their profiles + 'viewer' roles stayed, so get_manual_mission_staff
-- (any user_roles row) picked them up. A mission for them would also fail the
-- missions.assignee_user_id -> auth.users foreign key.
--
-- get_mission_staff and get_manual_mission_staff now require a live auth account
-- (not deleted, not banned) and skip reserved '.invalid' test addresses. Bodies are
-- copied from the live definitions (pg_get_functiondef, 18/10); only the FROM
-- clause gains the auth.users join. Grants unchanged.

CREATE OR REPLACE FUNCTION public.get_mission_staff()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_rows jsonb := '[]'::jsonb;
begin
  if not (
    public.has_role(auth.uid(), 'owner')
    or coalesce(auth.role(), '') = 'service_role'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', s.user_id,
           'name', s.name,
           'email', s.email,
           'badges', s.badges,
           'level', public.mission_level_for(s.badges),
           'open_missions', s.open_missions
         ) order by s.name nulls last, s.user_id), '[]'::jsonb)
  into v_rows
  from (
    select
      p.user_id,
      coalesce(nullif(btrim(p.full_name), ''), p.email) as name,
      p.email,
      (
        select count(*)::integer
        from public.mission_badge_awards aw
        where aw.user_id = p.user_id
      ) as badges,
      (
        select count(*)::integer
        from public.missions m
        where m.assignee_user_id = p.user_id
          and m.status = 'open'
      ) as open_missions
    from public.profiles p
    join auth.users au
      on au.id = p.user_id
     and au.deleted_at is null
     and (au.banned_until is null or au.banned_until < now())
     and coalesce(au.email, '') not ilike '%.invalid'
    where public.material_alias_can_admin(p.user_id) is true
      and p.user_id <> auth.uid()
  ) s;

  return v_rows;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_manual_mission_staff()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_rows jsonb := '[]'::jsonb;
begin
  if not (
    public.has_role(auth.uid(), 'owner')
    or coalesce(auth.role(), '') = 'service_role'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', s.user_id,
           'name', s.name,
           'email', s.email,
           'level', public.mission_level_for(s.badges),
           'open_missions', s.open_missions
         ) order by s.name nulls last, s.user_id), '[]'::jsonb)
  into v_rows
  from (
    select
      p.user_id,
      coalesce(nullif(btrim(p.full_name), ''), p.email) as name,
      p.email,
      (
        select count(*)::integer
        from public.mission_badge_awards aw
        where aw.user_id = p.user_id
      ) as badges,
      (
        select count(*)::integer
        from public.missions m
        where m.assignee_user_id = p.user_id
          and m.status = 'open'
      ) as open_missions
    from public.profiles p
    join auth.users au
      on au.id = p.user_id
     and au.deleted_at is null
     and (au.banned_until is null or au.banned_until < now())
     and coalesce(au.email, '') not ilike '%.invalid'
    where p.user_id <> auth.uid()
      and exists (
        select 1
        from public.user_roles ur
        where ur.user_id = p.user_id
      )
  ) s;

  return v_rows;
end;
$function$;

revoke all on function public.get_mission_staff() from public, anon;
grant execute on function public.get_mission_staff() to authenticated, service_role;
revoke all on function public.get_manual_mission_staff() from public, anon;
grant execute on function public.get_manual_mission_staff() to authenticated, service_role;
