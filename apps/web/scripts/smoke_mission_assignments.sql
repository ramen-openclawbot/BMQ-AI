-- Rollback-only production smoke for migration
-- 20261101400000_mission_assignments.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_mission_assignments.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_mission_assignments.sql).
--
-- The file opens one transaction, applies the migration SQL inline, impersonates
-- the real owner and a real warehouse staff member through request.jwt.claims,
-- assigns a mission, checks the staff copy / progress / badge, withdraws and
-- reopens it, then checks the refusals. The final RAISE aborts the transaction,
-- so every change rolls back.
begin;

-- 2026-10-17 — Giao nhiệm vụ kho cho nhân viên (phần dữ liệu).
--
-- Additive migration on top of 20261024100000_missions.sql. It adds:
--   1. public.missions.parent_mission_id — nhiệm vụ con (bản sao) trỏ về nhiệm vụ gốc.
--   2. public.get_mission_staff() — danh sách nhân viên có thể làm nhiệm vụ kho.
--   3. public.assign_mission(uuid, uuid) — chủ sở hữu giao một nhiệm vụ đang mở.
--   4. public.unassign_mission(uuid) — thu hồi một bản giao còn mở.
--   5. public.get_mission_assignments() — danh sách các bản giao.
--
-- Bản sao giữ nguyên quy tắc chấm (check_rule / check_params), nên mission_evaluate
-- chấm bản sao bằng đúng dữ liệu sống của nhiệm vụ gốc. get_my_missions và
-- complete_mission không đổi: người nhận thấy bản sao trên bảng của mình và tự
-- hoàn thành để nhận huy hiệu của chính họ.
--
-- Không hard-code UUID / email. Không ghi đè mission_evaluate, get_my_missions,
-- complete_mission hay bất kỳ bảng / hàm sẵn có nào.

-- ===========================================================================
-- 1. Cột liên kết bản sao với nhiệm vụ gốc
-- ===========================================================================

alter table public.missions
  add column if not exists parent_mission_id uuid
    references public.missions(id) on delete cascade;

create index if not exists idx_missions_parent_mission_id
  on public.missions(parent_mission_id);

create unique index if not exists idx_missions_parent_assignee_key
  on public.missions(parent_mission_id, assignee_user_id)
  where parent_mission_id is not null;

-- ===========================================================================
-- 2. Cổng chủ sở hữu dùng chung cho 4 RPC
-- ===========================================================================
--
-- Chỉ chủ sở hữu (hoặc service_role) được giao / thu hồi / xem danh sách.
-- Điều kiện này cố ý hẹp hơn material_alias_can_admin: người sửa bí danh
-- không tự động có quyền giao nhiệm vụ.

-- ===========================================================================
-- 3. Danh sách nhân viên có thể nhận nhiệm vụ kho
-- ===========================================================================

create or replace function public.get_mission_staff()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
    where public.material_alias_can_admin(p.user_id) is true
      and p.user_id <> auth.uid()
  ) s;

  return v_rows;
end;
$$;

revoke all on function public.get_mission_staff() from public, anon;
grant execute on function public.get_mission_staff() to authenticated, service_role;

-- ===========================================================================
-- 4. Giao một nhiệm vụ đang mở cho nhân viên
-- ===========================================================================
--
-- Giao lại nhiệm vụ gốc cho chính người nhận gốc là lỗi. Giao lại cho một nhân
-- viên đã có bản sao là idempotent; bản sao đã huỷ được mở lại.

create or replace function public.assign_mission(
  p_mission_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_mission public.missions%rowtype;
  v_root public.missions%rowtype;
  v_copy public.missions%rowtype;
  v_copy_found boolean := false;
  v_assignee_name text;
  v_created boolean := false;
  v_reopened boolean := false;
  v_code text;
begin
  if not (
    public.has_role(auth.uid(), 'owner')
    or coalesce(auth.role(), '') = 'service_role'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_mission
  from public.missions
  where id = p_mission_id
  for update;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if v_mission.status <> 'open' then
    raise exception 'mission_not_open' using errcode = '22023';
  end if;

  if v_mission.parent_mission_id is null then
    v_root := v_mission;
  else
    select * into v_root
    from public.missions
    where id = v_mission.parent_mission_id
    for update;
    if not found then
      raise exception 'mission_not_found' using errcode = 'P0002';
    end if;
    if v_root.status <> 'open' then
      raise exception 'mission_not_open' using errcode = '22023';
    end if;
  end if;

  if p_user_id is null or not public.material_alias_can_admin(p_user_id) then
    raise exception 'assignee_not_allowed' using errcode = '22023';
  end if;

  if p_user_id = v_root.assignee_user_id then
    raise exception 'already_assignee' using errcode = '22023';
  end if;

  select * into v_copy
  from public.missions
  where parent_mission_id = v_root.id
    and assignee_user_id = p_user_id
  limit 1;
  v_copy_found := found;

  if v_copy_found then
    if v_copy.status = 'cancelled' then
      update public.missions
        set status = 'open',
            completed_at = null,
            completed_by = null
        where id = v_copy.id;
      select * into v_copy from public.missions where id = v_copy.id;
      v_reopened := true;
    end if;
  else
    v_code := v_root.code || '@' || left(replace(p_user_id::text, '-', ''), 8);
    insert into public.missions (
      code,
      area,
      title,
      description,
      assignee_user_id,
      check_rule,
      check_params,
      badge_code,
      sort_order,
      status,
      parent_mission_id,
      created_by
    ) values (
      v_code,
      v_root.area,
      v_root.title,
      v_root.description,
      p_user_id,
      v_root.check_rule,
      v_root.check_params,
      v_root.badge_code,
      v_root.sort_order,
      'open',
      v_root.id,
      auth.uid()
    )
    returning * into v_copy;
    v_created := true;
  end if;

  select coalesce(nullif(btrim(p.full_name), ''), p.email)
  into v_assignee_name
  from public.profiles p
  where p.user_id = p_user_id;

  return jsonb_build_object(
    'mission_id', v_copy.id,
    'parent_mission_id', v_root.id,
    'assignee_user_id', p_user_id,
    'assignee_name', v_assignee_name,
    'status', v_copy.status,
    'created', v_created,
    'reopened', v_reopened
  );
end;
$$;

revoke all on function public.assign_mission(uuid, uuid) from public, anon;
grant execute on function public.assign_mission(uuid, uuid) to authenticated, service_role;

-- ===========================================================================
-- 5. Thu hồi một bản giao còn mở
-- ===========================================================================
--
-- Chỉ huỷ bản sao; nhiệm vụ gốc không bao giờ bị huỷ ở đây. Huỷ lại một bản
-- sao đã huỷ là idempotent.

create or replace function public.unassign_mission(p_mission_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_mission public.missions%rowtype;
begin
  if not (
    public.has_role(auth.uid(), 'owner')
    or coalesce(auth.role(), '') = 'service_role'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_mission
  from public.missions
  where id = p_mission_id
  for update;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if v_mission.parent_mission_id is null then
    raise exception 'not_an_assignment' using errcode = '22023';
  end if;

  if v_mission.status = 'completed' then
    raise exception 'mission_completed' using errcode = '22023';
  end if;

  if v_mission.status <> 'cancelled' then
    update public.missions
      set status = 'cancelled'
      where id = p_mission_id;
  end if;

  return jsonb_build_object(
    'mission_id', p_mission_id,
    'status', 'cancelled'
  );
end;
$$;

revoke all on function public.unassign_mission(uuid) from public, anon;
grant execute on function public.unassign_mission(uuid) to authenticated, service_role;

-- ===========================================================================
-- 6. Danh sách các bản giao (đang mở và đã hoàn thành)
-- ===========================================================================

create or replace function public.get_mission_assignments()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
           'mission_id', m.id,
           'parent_mission_id', m.parent_mission_id,
           'assignee_user_id', m.assignee_user_id,
           'assignee_name', coalesce(nullif(btrim(p.full_name), ''), p.email),
           'status', m.status,
           'completed_at', m.completed_at,
           'progress', public.mission_evaluate(m.id)
         ) order by m.parent_mission_id, coalesce(nullif(btrim(p.full_name), ''), p.email)),
         '[]'::jsonb)
  into v_rows
  from public.missions m
  left join public.profiles p on p.user_id = m.assignee_user_id
  where m.parent_mission_id is not null
    and m.status in ('open', 'completed');

  return v_rows;
end;
$$;

revoke all on function public.get_mission_assignments() from public, anon;
grant execute on function public.get_mission_assignments() to authenticated, service_role;

-- ===========================================================================
-- Smoke assertions (toàn bộ nằm trong một transaction, kết thúc bằng RAISE)
-- ===========================================================================
do $smoke_mission_assignments$
declare
  v_owner uuid;
  v_staff uuid;
  v_root uuid;
  v_copy uuid;
  v_result jsonb;
  v_progress jsonb;
  v_my jsonb;
  v_assignments jsonb;
  v_staff_list jsonb;
  v_complete jsonb;
  v_count integer;
  v_badges_before integer;
  v_badges_after integer;
  v_probe integer;
begin
  -- Chủ sở hữu thật và một nhân viên kho thật (không hard-code UUID / email).
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;

  select p.user_id into v_staff
  from public.profiles p
  where public.material_alias_can_admin(p.user_id) is true
    and p.user_id <> v_owner
    and not public.has_role(p.user_id, 'owner')
  order by p.created_at, p.user_id
  limit 1;
  if v_staff is null then
    raise exception 'SMOKE_RESULT FAIL no_staff';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- Nhiệm vụ gốc tạm, quy tắc chấm đã xong để có thể hoàn thành bản sao.
  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, created_by
  ) values (
    'smoke-assign-' || left(replace(gen_random_uuid()::text, '-', ''), 12),
    'warehouse', 'Smoke giao nhiệm vụ', 'Nhiệm vụ tạm cho smoke giao nhiệm vụ.',
    v_owner, 'stock_alias_factor_fixed', jsonb_build_object('aliases', '[]'::jsonb),
    'cham_chi', 999, v_owner
  )
  returning id into v_root;

  v_progress := public.mission_evaluate(v_root);

  -- (1) Chủ sở hữu giao nhiệm vụ: có bản sao đúng gốc và đúng người nhận.
  v_result := public.assign_mission(v_root, v_staff);
  if coalesce((v_result ->> 'created')::boolean, false) is not true then
    raise exception 'SMOKE_RESULT FAIL assign_created %', v_result;
  end if;
  if coalesce((v_result ->> 'reopened')::boolean, false) is not false then
    raise exception 'SMOKE_RESULT FAIL assign_reopened_unexpected %', v_result;
  end if;
  if (v_result ->> 'parent_mission_id')::uuid <> v_root then
    raise exception 'SMOKE_RESULT FAIL assign_parent %', v_result;
  end if;
  if (v_result ->> 'assignee_user_id')::uuid <> v_staff then
    raise exception 'SMOKE_RESULT FAIL assign_assignee %', v_result;
  end if;
  v_copy := (v_result ->> 'mission_id')::uuid;

  select count(*)::integer into v_count
  from public.missions m
  where m.parent_mission_id = v_root and m.assignee_user_id = v_staff;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL assign_copy_count %', v_count;
  end if;

  -- (2) Nhân viên thấy bản sao trên bảng của mình, tiến độ bằng nhiệm vụ gốc.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_my := public.get_my_missions(null);
  if not exists (
    select 1
    from jsonb_array_elements(v_my -> 'missions') x
    where (x ->> 'id')::uuid = v_copy
      and x -> 'progress' = v_progress
  ) then
    raise exception 'SMOKE_RESULT FAIL staff_copy_progress %', v_my;
  end if;

  -- (3) Giao lại: created=false, không sinh bản sao thứ hai.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_result := public.assign_mission(v_root, v_staff);
  if coalesce((v_result ->> 'created')::boolean, true) is not false then
    raise exception 'SMOKE_RESULT FAIL assign_again_created %', v_result;
  end if;
  if (v_result ->> 'mission_id')::uuid <> v_copy then
    raise exception 'SMOKE_RESULT FAIL assign_again_mission %', v_result;
  end if;
  select count(*)::integer into v_count
  from public.missions m
  where m.parent_mission_id = v_root and m.assignee_user_id = v_staff;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL assign_again_copy_count %', v_count;
  end if;

  -- (4) Thu hồi: bản sao cancelled và biến mất khỏi bảng của nhân viên.
  v_result := public.unassign_mission(v_copy);
  if (v_result ->> 'status') <> 'cancelled' then
    raise exception 'SMOKE_RESULT FAIL unassign_status %', v_result;
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_my := public.get_my_missions(null);
  if exists (
    select 1
    from jsonb_array_elements(v_my -> 'missions') x
    where (x ->> 'id')::uuid = v_copy
  ) then
    raise exception 'SMOKE_RESULT FAIL unassign_still_listed';
  end if;

  -- (5) Giao lại bản đã huỷ: mở lại, created=false, reopened=true.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_result := public.assign_mission(v_root, v_staff);
  if coalesce((v_result ->> 'created')::boolean, true) is not false
     or coalesce((v_result ->> 'reopened')::boolean, false) is not true
     or (v_result ->> 'status') <> 'open' then
    raise exception 'SMOKE_RESULT FAIL assign_reopen %', v_result;
  end if;

  -- (6) Nhân viên gọi giao nhiệm vụ: forbidden.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_probe := 0;
  begin
    perform public.assign_mission(v_root, v_staff);
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%forbidden%' then
      raise exception 'SMOKE_RESULT FAIL forbidden_assign: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL forbidden_assign accepted';
  end if;

  -- (7) Giao cho chính người nhận gốc: already_assignee.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_probe := 0;
  begin
    perform public.assign_mission(v_root, v_owner);
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%already_assignee%' then
      raise exception 'SMOKE_RESULT FAIL already_assignee: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL already_assignee accepted';
  end if;

  -- (8) Thu hồi nhiệm vụ gốc: not_an_assignment.
  v_probe := 0;
  begin
    perform public.unassign_mission(v_root);
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%not_an_assignment%' then
      raise exception 'SMOKE_RESULT FAIL not_an_assignment: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL not_an_assignment accepted';
  end if;

  -- (9) get_mission_staff bỏ chính người gọi, vẫn có nhân viên kho.
  v_staff_list := public.get_mission_staff();
  if exists (
    select 1
    from jsonb_array_elements(v_staff_list) x
    where (x ->> 'user_id')::uuid = v_owner
  ) then
    raise exception 'SMOKE_RESULT FAIL staff_list_has_owner';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(v_staff_list) x
    where (x ->> 'user_id')::uuid = v_staff
  ) then
    raise exception 'SMOKE_RESULT FAIL staff_list_missing_staff';
  end if;

  -- (10) get_mission_assignments liệt kê bản sao.
  v_assignments := public.get_mission_assignments();
  if not exists (
    select 1
    from jsonb_array_elements(v_assignments) x
    where (x ->> 'mission_id')::uuid = v_copy
      and (x ->> 'parent_mission_id')::uuid = v_root
  ) then
    raise exception 'SMOKE_RESULT FAIL assignments_missing_copy';
  end if;

  -- (11) Nhân viên tự hoàn thành và nhận huy hiệu của chính họ.
  select count(*)::integer into v_badges_before
  from public.mission_badge_awards aw
  where aw.user_id = v_staff;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_complete := public.complete_mission(v_copy, gen_random_uuid());
  if (v_complete -> 'badge') is null or (v_complete -> 'badge') = 'null'::jsonb then
    raise exception 'SMOKE_RESULT FAIL staff_badge %', v_complete;
  end if;
  select count(*)::integer into v_badges_after
  from public.mission_badge_awards aw
  where aw.user_id = v_staff;
  if v_badges_after <> v_badges_before + 1 then
    raise exception 'SMOKE_RESULT FAIL staff_badge_count before=% after=%',
      v_badges_before, v_badges_after;
  end if;
  v_my := public.get_my_missions(null);
  if not exists (
    select 1
    from jsonb_array_elements(v_my -> 'missions') x
    where (x ->> 'id')::uuid = v_copy
      and (x ->> 'status') = 'completed'
  ) then
    raise exception 'SMOKE_RESULT FAIL staff_completed_copy';
  end if;

  raise exception 'SMOKE_RESULT PASS: mission assignments';
end;
$smoke_mission_assignments$;

rollback;
