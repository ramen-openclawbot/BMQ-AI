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
