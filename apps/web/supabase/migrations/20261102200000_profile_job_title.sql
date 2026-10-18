-- 2026-11-02 — Thẻ nhiệm vụ ghi chức danh thật của nhân viên.
--
-- Additive migration on top of 20261102190000_merchant_guard_notes.sql. It adds:
--   1. public.profiles.job_title (text, nullable) — chức danh hiển thị trên thẻ.
--   2. Gieo chức danh cho bốn tài khoản BMQ, tra theo email đăng nhập.
--   3. public.get_my_missions trả thêm khóa cấp cao 'job_title' của người gọi
--      (null khi chưa đặt). Mọi khóa khác và mọi RPC khác giữ nguyên.
--
-- This migration is additive and idempotent. The Maestro applies it; it does not
-- apply itself.

-- ===========================================================================
-- 1. Chức danh trên hồ sơ
-- ===========================================================================

alter table public.profiles
  add column if not exists job_title text;

-- ===========================================================================
-- 2. Gieo chức danh cho bốn tài khoản BMQ
-- ===========================================================================

update public.profiles p
set job_title = v.t
from auth.users u,
     (values
       ('ramen@bmq.vn', 'CEO'),
       ('ketoantruong@bmq.vn', 'Kế toán trưởng'),
       ('xuanmai@bmq.vn', 'Kế toán kho'),
       ('mi@bmq.vn', 'Thủ kho')
     ) as v(e, t)
where u.id = p.user_id
  and lower(u.email) = v.e;

-- ===========================================================================
-- 3. get_my_missions trả thêm chức danh của người gọi
-- ===========================================================================

-- (1) Nhiệm vụ của tôi: danh sách + huy hiệu + cấp + phần thưởng gần đây.
create or replace function public.get_my_missions(p_user uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_target uuid;
  v_missions jsonb := '[]'::jsonb;
  v_badges_total integer := 0;
  v_by_code jsonb := '{}'::jsonb;
  v_level jsonb;
  v_next jsonb;
  v_recent jsonb := '[]'::jsonb;
  v_job_title text;
begin
  v_target := coalesce(p_user, v_actor);

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if v_target is distinct from v_actor and not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  if v_target is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'code', m.code,
           'title', m.title,
           'description', m.description,
           'area', m.area,
           'status', m.status,
           'sort_order', m.sort_order,
           'badge', case when b.code is null then null else jsonb_build_object(
             'code', b.code, 'name', b.name, 'icon', b.icon
           ) end,
           'completed_at', m.completed_at,
           'progress', public.mission_evaluate(m.id)
         ) order by
           case m.status when 'open' then 0 else 1 end,
           case when m.status = 'open' then m.sort_order end asc nulls last,
           m.completed_at desc nulls last,
           m.created_at asc), '[]'::jsonb)
  into v_missions
  from public.missions m
  left join public.mission_badges b on b.code = m.badge_code
  where m.assignee_user_id = v_target
    and m.status in ('open', 'completed');

  select count(*)::integer into v_badges_total
  from public.mission_badge_awards aw
  where aw.user_id = v_target;

  select coalesce(jsonb_object_agg(c.badge_code, c.n), '{}'::jsonb)
  into v_by_code
  from (
    select aw.badge_code, count(*)::integer as n
    from public.mission_badge_awards aw
    where aw.user_id = v_target
    group by aw.badge_code
  ) c;

  v_level := public.mission_level_for(v_badges_total);

  select jsonb_build_object('level', l.level, 'title', l.title, 'min_badges', l.min_badges)
  into v_next
  from public.mission_levels l
  where l.min_badges > v_badges_total
  order by l.min_badges asc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'badge_code', x.badge_code,
           'mission_title', x.mission_title,
           'awarded_at', x.awarded_at
         ) order by x.awarded_at desc), '[]'::jsonb)
  into v_recent
  from (
    select aw.badge_code, m.title as mission_title, aw.awarded_at
    from public.mission_badge_awards aw
    left join public.missions m on m.id = aw.mission_id
    where aw.user_id = v_target
    order by aw.awarded_at desc
    limit 5
  ) x;

  select nullif(btrim(p.job_title), '')
  into v_job_title
  from public.profiles p
  where p.user_id = v_target;

  return jsonb_build_object(
    'missions', v_missions,
    'badges', jsonb_build_object('total', v_badges_total, 'by_code', v_by_code),
    'level', v_level,
    'next_level', v_next,
    'recent_awards', v_recent,
    'job_title', v_job_title
  );
end;
$$;

revoke all on function public.get_my_missions(uuid) from public, anon;
grant execute on function public.get_my_missions(uuid) to authenticated, service_role;
