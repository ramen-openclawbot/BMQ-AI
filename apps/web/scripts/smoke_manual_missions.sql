-- Rollback-only production smoke for migration
-- 20261102150000_manual_missions.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_manual_missions.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_manual_missions.sql).
--
-- The file opens one transaction, applies the migration SQL inline, impersonates
-- the real owner and two real staff members through request.jwt.claims, creates a
-- two-assignee batch, submits / returns / resubmits / approves its first mission,
-- checks the Zalo outbox + append-only events + hourly reminders, then RAISEs so
-- every change rolls back.
begin;

-- 2026-11-02 — Thẻ nhiệm vụ thủ công GĐ1 (phần dữ liệu).
--
-- Additive migration on top of 20261024100000_missions.sql and the mission
-- assignment slices. It adds:
--   1. public.manual_mission_batches — one owner-created batch (title, due date,
--      priority, location, evidence spec).
--   2. public.missions.batch_id — each assignee gets a mission row with
--      check_rule 'manual_review'; get_my_missions and complete_mission stay
--      unchanged.
--   3. public.mission_submissions — evidence snapshots with owner review
--      (approve / return with a note).
--   4. public.mission_events — append-only audit trail for every step.
--   5. public.mission_zalo_notifications — idempotent outbox for the warehouse
--      Zalo OA group, claimed by the new mission-zalo-notify worker.
--   6. Owner + assignee RPCs for create / add assignee / cancel / submit /
--      review / read.
--   7. mission_evaluate gets one manual_review branch; every other branch and
--      get_my_missions / complete_mission / assign_mission / unassign_mission
--      are untouched.
--   8. Hourly due reminders, a 2-minute Zalo worker schedule and the private
--      mission-evidence storage bucket.
--
-- Không hard-code UUID hay email. Không ghi đè bảng / hàm sẵn có ngoài
-- mission_evaluate (chỉ thêm một nhánh manual_review ở đầu).

-- ===========================================================================
-- 1. Đợt giao nhiệm vụ thủ công + cột liên kết trên missions
-- ===========================================================================

create table if not exists public.manual_mission_batches (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  due_at timestamptz,
  priority text not null default 'normal',
  location text,
  evidence jsonb not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint manual_mission_batches_title_check
    check (char_length(btrim(title)) between 3 and 120),
  constraint manual_mission_batches_description_check
    check (description is null or char_length(description) <= 2000),
  constraint manual_mission_batches_priority_check
    check (priority in ('low', 'normal', 'high')),
  constraint manual_mission_batches_location_check
    check (location is null or location in ('tan_tao', 'q7'))
);

create index if not exists idx_manual_mission_batches_created_by
  on public.manual_mission_batches(created_by, created_at desc);

alter table public.missions
  add column if not exists batch_id uuid
    references public.manual_mission_batches(id) on delete cascade;

create index if not exists idx_missions_batch_id
  on public.missions(batch_id);

create unique index if not exists idx_missions_batch_assignee_key
  on public.missions(batch_id, assignee_user_id)
  where batch_id is not null;

-- Mở rộng constraints check_rule mà không chép lại danh sách hiện tại: đọc định
-- nghĩa sống từ pg_constraint, thêm 'manual_review' và giữ nguyên mọi giá trị
-- cũ (phiên khác cũng thêm rule vào đây).
do $mission_check_rule$
declare
  v_definition text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid)
  into v_definition
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'missions'
    and c.conname = 'missions_check_rule_check';

  if v_definition is null then
    -- Không thấy constraint (database lạ): dựng lại từ các rule đang có trong
    -- dữ liệu, cộng thêm manual_review, thay vì hard-code danh sách.
    select array_agg(distinct m.check_rule)
    into v_values
    from public.missions m
    where m.check_rule is not null;

    v_values := coalesce(v_values, '{}'::text[]) || 'manual_review'::text;

    execute format(
      'alter table public.missions add constraint missions_check_rule_check check (check_rule = any (%L::text[]))',
      v_values
    );
    raise notice 'missions_check_rule_check created with % values', cardinality(v_values);
  elsif position('manual_review' in v_definition) = 0 then
    select array_agg(distinct m[1])
    into v_values
    from regexp_matches(v_definition, '''([^'']+)''::text', 'g') as r(m);

    if v_values is null then
      select array_agg(distinct m.check_rule)
      into v_values
      from public.missions m
      where m.check_rule is not null;
    end if;

    v_values := coalesce(v_values, '{}'::text[]) || 'manual_review'::text;

    execute 'alter table public.missions drop constraint missions_check_rule_check';
    execute format(
      'alter table public.missions add constraint missions_check_rule_check check (check_rule = any (%L::text[]))',
      v_values
    );
    raise notice 'missions_check_rule_check extended with manual_review';
  end if;
end;
$mission_check_rule$;

-- ===========================================================================
-- 2. Bài nộp bằng chứng và nhật ký sự kiện (chỉ ghi thêm)
-- ===========================================================================

create table if not exists public.mission_submissions (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.missions(id) on delete cascade,
  submitted_by uuid not null,
  note text,
  number_value numeric,
  photo_paths text[] not null default '{}'::text[],
  checklist jsonb not null default '[]'::jsonb,
  review_status text not null default 'pending',
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  rating smallint,
  created_at timestamptz not null default now(),
  constraint mission_submissions_note_check
    check (note is null or char_length(note) <= 1000),
  constraint mission_submissions_photo_paths_check
    check (cardinality(photo_paths) <= 8),
  constraint mission_submissions_review_status_check
    check (review_status in ('pending', 'approved', 'returned')),
  constraint mission_submissions_review_note_check
    check (review_note is null or char_length(review_note) <= 500),
  constraint mission_submissions_rating_check
    check (rating is null or rating between 1 and 5)
);

create index if not exists idx_mission_submissions_mission_created
  on public.mission_submissions(mission_id, created_at desc);

create unique index if not exists idx_mission_submissions_pending
  on public.mission_submissions(mission_id)
  where review_status = 'pending';

create table if not exists public.mission_events (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid references public.missions(id) on delete cascade,
  batch_id uuid,
  actor_id uuid,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint mission_events_event_type_check
    check (event_type in (
      'created',
      'assigned',
      'submitted',
      'approved',
      'returned',
      'cancelled',
      'due_soon',
      'overdue'
    ))
);

create index if not exists idx_mission_events_mission_created
  on public.mission_events(mission_id, created_at desc);

create index if not exists idx_mission_events_batch_created
  on public.mission_events(batch_id, created_at desc);

-- Chỉ ghi thêm: một sự kiện đã ghi không được sửa hay xoá (cùng kiểu
-- mission_badge_awards_append_only).
create or replace function public.mission_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'mission_events_append_only' using errcode = '42501';
end;
$$;

revoke all on function public.mission_events_append_only() from public, anon, authenticated;
grant execute on function public.mission_events_append_only() to service_role;

drop trigger if exists mission_events_append_only on public.mission_events;
create trigger mission_events_append_only
  before update or delete on public.mission_events
  for each row execute function public.mission_events_append_only();

-- ===========================================================================
-- 3. Outbox Zalo OA kho + cấu hình worker (chỉ service_role)
-- ===========================================================================

create table if not exists public.mission_zalo_notifications (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  mission_id uuid,
  batch_id uuid,
  dedupe_key text not null unique,
  message_body text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  sent_at timestamptz,
  provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mission_zalo_notifications_event_type_check
    check (event_type in ('assigned', 'submitted', 'approved', 'returned', 'due_soon', 'overdue')),
  constraint mission_zalo_notifications_message_check
    check (char_length(message_body) between 1 and 4000),
  constraint mission_zalo_notifications_status_check
    check (status in ('pending', 'processing', 'sent', 'failed', 'suppressed')),
  constraint mission_zalo_notifications_attempts_check
    check (attempts >= 0)
);

create index if not exists mission_zalo_notifications_retry_idx
  on public.mission_zalo_notifications(status, next_attempt_at, created_at)
  where status in ('pending', 'processing');

create table if not exists public.mission_zalo_notification_config (
  id text primary key,
  enabled boolean not null default true,
  worker_secret uuid not null default gen_random_uuid(),
  constraint mission_zalo_notification_config_id_check check (id = 'mission-zalo')
);

insert into public.mission_zalo_notification_config (id, enabled)
values ('mission-zalo', true)
on conflict (id) do nothing;

alter table public.mission_zalo_notifications enable row level security;
alter table public.mission_zalo_notification_config enable row level security;

revoke all on table public.mission_zalo_notifications from public, anon, authenticated;
grant all on table public.mission_zalo_notifications to service_role;

revoke all on table public.mission_zalo_notification_config from public, anon, authenticated;
grant all on table public.mission_zalo_notification_config to service_role;

-- Internal helper: insert one notice once per dedupe key. Returns true only when
-- the row was actually inserted (callers use it to keep reminder events
-- idempotent). Chỉ service_role / security-definer RPC gọi được.
create or replace function public.enqueue_mission_notice(
  p_event text,
  p_mission uuid,
  p_batch uuid,
  p_dedupe text,
  p_body text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted boolean := false;
begin
  if p_event is null or p_event not in ('assigned', 'submitted', 'approved', 'returned', 'due_soon', 'overdue') then
    raise exception 'invalid_notice_event' using errcode = '22023';
  end if;

  insert into public.mission_zalo_notifications (
    event_type, mission_id, batch_id, dedupe_key, message_body
  ) values (
    p_event, p_mission, p_batch, p_dedupe, p_body
  )
  on conflict (dedupe_key) do nothing
  returning true into v_inserted;

  return coalesce(v_inserted, false);
end;
$$;

revoke all on function public.enqueue_mission_notice(text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.enqueue_mission_notice(text, uuid, uuid, text, text)
  to service_role;

-- Service-role claim, mirroring claim_finance_zalo_notifications: pending rows
-- due now plus stale processing locks, FOR UPDATE SKIP LOCKED.
create or replace function public.claim_mission_zalo_notifications(batch_size integer default 10)
returns table (
  id uuid,
  event_type text,
  mission_id uuid,
  batch_id uuid,
  message_body text,
  attempts integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select n.id
    from public.mission_zalo_notifications n
    where n.attempts < 5
      and n.next_attempt_at <= now()
      and (
        n.status = 'pending'
        or (n.status = 'processing' and n.locked_at < now() - interval '15 minutes')
      )
    order by n.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(batch_size, 10), 50))
  ), claimed as (
    update public.mission_zalo_notifications n
    set status = 'processing',
        attempts = n.attempts + 1,
        locked_at = now(),
        updated_at = now()
    from picked
    where n.id = picked.id
    returning n.id,
              n.event_type,
              n.mission_id,
              n.batch_id,
              n.message_body,
              n.attempts
  )
  select claimed.id,
         claimed.event_type,
         claimed.mission_id,
         claimed.batch_id,
         claimed.message_body,
         claimed.attempts
  from claimed;
end;
$$;

revoke all on function public.claim_mission_zalo_notifications(integer)
  from public, anon, authenticated;
grant execute on function public.claim_mission_zalo_notifications(integer)
  to service_role;

comment on function public.claim_mission_zalo_notifications(integer)
  is 'Service-role claim for the manual-mission Zalo outbox (FOR UPDATE SKIP LOCKED, stale-lock recovery).';

-- ===========================================================================
-- 4. RLS và quyền bảng
-- ===========================================================================

alter table public.manual_mission_batches enable row level security;
alter table public.mission_submissions enable row level security;
alter table public.mission_events enable row level security;

drop policy if exists manual_mission_batches_select on public.manual_mission_batches;
create policy manual_mission_batches_select on public.manual_mission_batches
  for select to authenticated
  using (
    created_by = (select auth.uid())
    or public.has_role((select auth.uid()), 'owner')
    or exists (
      select 1
      from public.missions m
      where m.batch_id = manual_mission_batches.id
        and m.assignee_user_id = (select auth.uid())
    )
  );

drop policy if exists mission_submissions_select on public.mission_submissions;
create policy mission_submissions_select on public.mission_submissions
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or exists (
      select 1
      from public.missions m
      left join public.manual_mission_batches b on b.id = m.batch_id
      where m.id = mission_submissions.mission_id
        and (
          m.assignee_user_id = (select auth.uid())
          or b.created_by = (select auth.uid())
        )
    )
  );

drop policy if exists mission_events_select on public.mission_events;
create policy mission_events_select on public.mission_events
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or exists (
      select 1
      from public.missions m
      where m.id = mission_events.mission_id
        and m.assignee_user_id = (select auth.uid())
    )
    or exists (
      select 1
      from public.manual_mission_batches b
      where b.id = mission_events.batch_id
        and b.created_by = (select auth.uid())
    )
  );

-- Clients read only; every write goes through a SECURITY DEFINER RPC.
revoke all on table public.manual_mission_batches from public, anon, authenticated;
grant select on table public.manual_mission_batches to authenticated;
grant all on table public.manual_mission_batches to service_role;

revoke all on table public.mission_submissions from public, anon, authenticated;
grant select on table public.mission_submissions to authenticated;
grant all on table public.mission_submissions to service_role;

revoke all on table public.mission_events from public, anon, authenticated;
grant select on table public.mission_events to authenticated;
grant all on table public.mission_events to service_role;

-- ===========================================================================
-- 5. Helper nội bộ cho tên / hạn / bằng chứng
-- ===========================================================================

-- Tên hiển thị: full_name đã trim, nếu rỗng thì dùng email (đúng quy ước
-- get_mission_staff / get_mission_assignments).
create or replace function public.manual_mission_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email)
  from public.profiles p
  where p.user_id = p_user_id;
$$;

revoke all on function public.manual_mission_name(uuid) from public, anon, authenticated;
grant execute on function public.manual_mission_name(uuid) to service_role;

-- Hạn hiển thị dd/MM HH24:MI theo giờ Việt Nam.
create or replace function public.manual_mission_due_text(p_due timestamptz)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select to_char(p_due at time zone 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI');
$$;

revoke all on function public.manual_mission_due_text(timestamptz) from public, anon, authenticated;
grant execute on function public.manual_mission_due_text(timestamptz) to service_role;

-- Chuẩn hoá yêu cầu minh chứng. Mặc định photo/note 'optional', number null,
-- checklist rỗng. Mọi giá trị sai kiểu / ngoài khoảng đều raise 'invalid_evidence'.
create or replace function public.manual_mission_evidence_normalize(p_evidence jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_root jsonb;
  v_photo text;
  v_note text;
  v_number jsonb;
  v_label text;
  v_unit text;
  v_checklist jsonb := '[]'::jsonb;
  v_clean jsonb := '[]'::jsonb;
  v_item jsonb;
  v_item_text text;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) = 'null' then
    v_root := '{}'::jsonb;
  elsif jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'invalid_evidence' using errcode = '22023';
  else
    v_root := p_evidence;
  end if;

  -- photo: none | optional | required
  if not (v_root ? 'photo') or v_root -> 'photo' = 'null'::jsonb then
    v_photo := 'optional';
  else
    if jsonb_typeof(v_root -> 'photo') <> 'string' then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;
    v_photo := v_root ->> 'photo';
    if v_photo not in ('none', 'optional', 'required') then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;
  end if;

  -- note: none | optional | required
  if not (v_root ? 'note') or v_root -> 'note' = 'null'::jsonb then
    v_note := 'optional';
  else
    if jsonb_typeof(v_root -> 'note') <> 'string' then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;
    v_note := v_root ->> 'note';
    if v_note not in ('none', 'optional', 'required') then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;
  end if;

  -- number: null hoặc {label 1-40, unit 0-12}
  if not (v_root ? 'number') or v_root -> 'number' = 'null'::jsonb then
    v_number := null;
  else
    if jsonb_typeof(v_root -> 'number') <> 'object' then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;
    if not ((v_root -> 'number') ? 'label')
       or jsonb_typeof(v_root -> 'number' -> 'label') <> 'string' then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;
    v_label := btrim(v_root -> 'number' ->> 'label');
    if char_length(v_label) < 1 or char_length(v_label) > 40 then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;

    v_unit := '';
    if (v_root -> 'number') ? 'unit' and v_root -> 'number' -> 'unit' <> 'null'::jsonb then
      if jsonb_typeof(v_root -> 'number' -> 'unit') <> 'string' then
        raise exception 'invalid_evidence' using errcode = '22023';
      end if;
      v_unit := btrim(v_root -> 'number' ->> 'unit');
    end if;
    if char_length(v_unit) > 12 then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;

    v_number := jsonb_build_object('label', v_label, 'unit', v_unit);
  end if;

  -- checklist: mảng 0-10 chuỗi 1-80 ký tự
  if not (v_root ? 'checklist') or v_root -> 'checklist' = 'null'::jsonb then
    v_checklist := '[]'::jsonb;
  else
    if jsonb_typeof(v_root -> 'checklist') <> 'array' then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;
    if jsonb_array_length(v_root -> 'checklist') > 10 then
      raise exception 'invalid_evidence' using errcode = '22023';
    end if;

    for v_item in select value from jsonb_array_elements(v_root -> 'checklist') loop
      if jsonb_typeof(v_item) <> 'string' then
        raise exception 'invalid_evidence' using errcode = '22023';
      end if;
      v_item_text := btrim(v_item #>> '{}');
      if char_length(v_item_text) < 1 or char_length(v_item_text) > 80 then
        raise exception 'invalid_evidence' using errcode = '22023';
      end if;
      v_clean := v_clean || jsonb_build_array(v_item_text);
    end loop;
    v_checklist := v_clean;
  end if;

  return jsonb_build_object(
    'photo', v_photo,
    'note', v_note,
    'number', v_number,
    'checklist', v_checklist
  );
end;
$$;

revoke all on function public.manual_mission_evidence_normalize(jsonb)
  from public, anon, authenticated;
grant execute on function public.manual_mission_evidence_normalize(jsonb)
  to service_role;

-- ===========================================================================
-- 6. RPC chủ sở hữu: danh sách nhân viên, tạo đợt, thêm người, huỷ
-- ===========================================================================

-- Nhân viên có ít nhất một dòng user_roles, bỏ chính người gọi.
create or replace function public.get_manual_mission_staff()
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
    where p.user_id <> auth.uid()
      and exists (
        select 1
        from public.user_roles ur
        where ur.user_id = p.user_id
      )
  ) s;

  return v_rows;
end;
$$;

revoke all on function public.get_manual_mission_staff() from public, anon;
grant execute on function public.get_manual_mission_staff() to authenticated, service_role;

-- Tạo một đợt thủ công + một missions row cho mỗi người nhận.
create or replace function public.create_manual_mission(
  p_title text,
  p_description text,
  p_assignee_ids uuid[],
  p_due_at timestamptz,
  p_priority text,
  p_location text,
  p_evidence jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cached jsonb;
  v_title text := btrim(coalesce(p_title, ''));
  v_description text;
  v_priority text := coalesce(nullif(btrim(p_priority), ''), 'normal');
  v_location text := nullif(btrim(p_location), '');
  v_assignees uuid[];
  v_assignee_count integer;
  v_evidence jsonb;
  v_batch public.manual_mission_batches%rowtype;
  v_mission public.missions%rowtype;
  v_first_mission uuid;
  v_missions jsonb := '[]'::jsonb;
  v_names text;
  v_body text;
  v_result jsonb;
  v_uid uuid;
  v_name text;
begin
  if not (
    public.has_role(auth.uid(), 'owner')
    or coalesce(auth.role(), '') = 'service_role'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_actor is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('manual_mission_create:' || p_request_id::text));
    select r.result into v_cached
    from public.mission_requests r
    where r.request_id = p_request_id
      and r.kind = 'create_manual_mission';
    if found and v_cached is not null then
      return v_cached;
    end if;
  end if;

  if char_length(v_title) < 3 or char_length(v_title) > 120 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;

  if p_description is not null and char_length(p_description) > 2000 then
    raise exception 'description_too_long' using errcode = '22023';
  end if;
  v_description := nullif(btrim(coalesce(p_description, '')), '');

  v_assignees := coalesce(p_assignee_ids, '{}'::uuid[]);
  if cardinality(v_assignees) = 0 or cardinality(v_assignees) > 20 then
    raise exception 'invalid_assignee_count' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_assignees) u where u is null) then
    raise exception 'assignee_not_allowed' using errcode = '22023';
  end if;

  select count(distinct u)::integer
  into v_assignee_count
  from unnest(v_assignees) u;
  if v_assignee_count <> cardinality(v_assignees) then
    raise exception 'invalid_assignee_count' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(v_assignees) u
    where u = v_actor
      or not exists (
        select 1 from public.user_roles ur where ur.user_id = u
      )
  ) then
    raise exception 'assignee_not_allowed' using errcode = '22023';
  end if;

  if v_priority not in ('low', 'normal', 'high') then
    raise exception 'invalid_priority' using errcode = '22023';
  end if;

  if v_location is not null and v_location not in ('tan_tao', 'q7') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;

  if p_due_at is not null and p_due_at < now() - interval '1 hour' then
    raise exception 'due_in_past' using errcode = '22023';
  end if;

  v_evidence := public.manual_mission_evidence_normalize(p_evidence);

  insert into public.manual_mission_batches (
    title, description, due_at, priority, location, evidence, created_by
  ) values (
    v_title, v_description, p_due_at, v_priority, v_location, v_evidence, v_actor
  )
  returning * into v_batch;

  insert into public.mission_events (batch_id, actor_id, event_type, payload)
  values (
    v_batch.id,
    v_actor,
    'created',
    jsonb_build_object(
      'batch_id', v_batch.id,
      'title', v_batch.title,
      'assignee_count', cardinality(v_assignees)
    )
  );

  foreach v_uid in array v_assignees loop
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
      batch_id,
      created_by
    ) values (
      'manual-'
        || left(replace(v_batch.id::text, '-', ''), 10)
        || '@'
        || left(replace(v_uid::text, '-', ''), 8),
      'manual',
      v_batch.title,
      v_batch.description,
      v_uid,
      'manual_review',
      '{}'::jsonb,
      'cham_chi',
      100,
      'open',
      v_batch.id,
      v_actor
    )
    returning * into v_mission;

    if v_first_mission is null then
      v_first_mission := v_mission.id;
    end if;

    v_name := public.manual_mission_name(v_uid);

    v_missions := v_missions || jsonb_build_array(jsonb_build_object(
      'mission_id', v_mission.id,
      'assignee_user_id', v_uid,
      'assignee_name', v_name
    ));

    insert into public.mission_events (mission_id, batch_id, actor_id, event_type, payload)
    values (
      v_mission.id,
      v_batch.id,
      v_actor,
      'assigned',
      jsonb_build_object(
        'mission_id', v_mission.id,
        'assignee_user_id', v_uid,
        'assignee_name', v_name
      )
    );
  end loop;

  select string_agg(coalesce(public.manual_mission_name(u.uid), ''), ', ' order by u.ord)
  into v_names
  from unnest(v_assignees) with ordinality as u(uid, ord);

  v_body := '📌 Nhiệm vụ mới: ' || v_batch.title
    || E'\n' || 'Giao cho: ' || coalesce(v_names, '')
    || case
         when v_batch.due_at is not null
           then E'\n' || 'Hạn: ' || public.manual_mission_due_text(v_batch.due_at)
         else ''
       end
    || case
         when v_batch.description is not null and btrim(v_batch.description) <> ''
           then E'\n' || left(v_batch.description, 200)
         else ''
       end
    || E'\n' || 'https://ai.banhmique.vn/warehouse/game?mission=' || v_first_mission::text;

  perform public.enqueue_mission_notice(
    'assigned',
    v_first_mission,
    v_batch.id,
    'assigned:' || v_batch.id::text,
    v_body
  );

  v_result := jsonb_build_object(
    'batch_id', v_batch.id,
    'missions', v_missions
  );

  if p_request_id is not null then
    insert into public.mission_requests (request_id, user_id, kind, result)
    values (p_request_id, v_actor, 'create_manual_mission', v_result)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.create_manual_mission(text, text, uuid[], timestamptz, text, text, jsonb, uuid)
  from public, anon;
grant execute on function public.create_manual_mission(text, text, uuid[], timestamptz, text, text, jsonb, uuid)
  to authenticated, service_role;

-- Thêm một người nhận vào đợt đã có; mở lại row đã huỷ, còn row đang mở thì
-- trả nguyên trạng (idempotent).
create or replace function public.add_manual_mission_assignee(
  p_batch_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_batch public.manual_mission_batches%rowtype;
  v_mission public.missions%rowtype;
  v_name text;
  v_body text;
begin
  if not (
    public.has_role(auth.uid(), 'owner')
    or coalesce(auth.role(), '') = 'service_role'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_actor is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_batch
  from public.manual_mission_batches
  where id = p_batch_id
  for update;
  if not found then
    raise exception 'batch_not_found' using errcode = 'P0002';
  end if;

  if p_user_id is null
     or p_user_id = v_actor
     or not exists (select 1 from public.user_roles ur where ur.user_id = p_user_id) then
    raise exception 'assignee_not_allowed' using errcode = '22023';
  end if;

  select * into v_mission
  from public.missions
  where batch_id = p_batch_id
    and assignee_user_id = p_user_id
  for update;

  if found then
    if v_mission.status <> 'cancelled' then
      return jsonb_build_object(
        'mission_id', v_mission.id,
        'status', v_mission.status
      );
    end if;

    update public.missions
      set status = 'open',
          completed_at = null,
          completed_by = null
      where id = v_mission.id
      returning * into v_mission;
  else
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
      batch_id,
      created_by
    ) values (
      'manual-'
        || left(replace(v_batch.id::text, '-', ''), 10)
        || '@'
        || left(replace(p_user_id::text, '-', ''), 8),
      'manual',
      v_batch.title,
      v_batch.description,
      p_user_id,
      'manual_review',
      '{}'::jsonb,
      'cham_chi',
      100,
      'open',
      v_batch.id,
      v_actor
    )
    returning * into v_mission;
  end if;

  v_name := public.manual_mission_name(p_user_id);

  insert into public.mission_events (mission_id, batch_id, actor_id, event_type, payload)
  values (
    v_mission.id,
    v_batch.id,
    v_actor,
    'assigned',
    jsonb_build_object(
      'mission_id', v_mission.id,
      'assignee_user_id', p_user_id,
      'assignee_name', v_name
    )
  );

  v_body := '📌 Nhiệm vụ mới: ' || v_batch.title
    || E'\n' || 'Giao cho: ' || coalesce(v_name, '')
    || case
         when v_batch.due_at is not null
           then E'\n' || 'Hạn: ' || public.manual_mission_due_text(v_batch.due_at)
         else ''
       end
    || case
         when v_batch.description is not null and btrim(v_batch.description) <> ''
           then E'\n' || left(v_batch.description, 200)
         else ''
       end
    || E'\n' || 'https://ai.banhmique.vn/warehouse/game?mission=' || v_mission.id::text;

  perform public.enqueue_mission_notice(
    'assigned',
    v_mission.id,
    v_batch.id,
    'assigned:' || v_mission.id::text,
    v_body
  );

  return jsonb_build_object(
    'mission_id', v_mission.id,
    'status', v_mission.status
  );
end;
$$;

revoke all on function public.add_manual_mission_assignee(uuid, uuid) from public, anon;
grant execute on function public.add_manual_mission_assignee(uuid, uuid) to authenticated, service_role;

-- Huỷ một mission thủ công (idempotent); không gửi notice.
create or replace function public.cancel_manual_mission(p_mission_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
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

  if v_mission.batch_id is null then
    raise exception 'not_manual' using errcode = '22023';
  end if;

  if v_mission.status = 'completed' then
    raise exception 'mission_completed' using errcode = '22023';
  end if;

  if v_mission.status <> 'cancelled' then
    update public.missions
      set status = 'cancelled'
      where id = p_mission_id;
  end if;

  insert into public.mission_events (mission_id, batch_id, actor_id, event_type, payload)
  values (
    p_mission_id,
    v_mission.batch_id,
    v_actor,
    'cancelled',
    jsonb_build_object('mission_id', p_mission_id)
  );

  return jsonb_build_object(
    'mission_id', p_mission_id,
    'status', 'cancelled'
  );
end;
$$;

revoke all on function public.cancel_manual_mission(uuid) from public, anon;
grant execute on function public.cancel_manual_mission(uuid) to authenticated, service_role;

-- ===========================================================================
-- 7. Người nhận nộp bằng chứng
-- ===========================================================================

create or replace function public.submit_manual_mission(
  p_mission_id uuid,
  p_note text,
  p_number numeric,
  p_photo_paths text[],
  p_checklist jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cached jsonb;
  v_mission public.missions%rowtype;
  v_batch public.manual_mission_batches%rowtype;
  v_evidence jsonb;
  v_photo_spec text;
  v_note_spec text;
  v_number_spec jsonb;
  v_checklist_spec jsonb;
  v_paths text[];
  v_path text;
  v_note text;
  v_checklist jsonb := '[]'::jsonb;
  v_item jsonb;
  v_submission public.mission_submissions%rowtype;
  v_body text;
  v_name text;
  v_result jsonb;
  v_submitter uuid;
begin
  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('manual_mission_submit:' || p_request_id::text));
    select r.result into v_cached
    from public.mission_requests r
    where r.request_id = p_request_id
      and r.kind = 'submit_manual_mission';
    if found and v_cached is not null then
      return v_cached;
    end if;
  end if;

  select * into v_mission
  from public.missions
  where id = p_mission_id
  for update;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if v_mission.batch_id is null then
    raise exception 'not_manual' using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or v_mission.assignee_user_id <> v_actor then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  if v_mission.status <> 'open' then
    raise exception 'mission_not_open' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.mission_submissions s
    where s.mission_id = p_mission_id
      and s.review_status = 'pending'
  ) then
    raise exception 'already_submitted' using errcode = '22023';
  end if;

  select * into v_batch
  from public.manual_mission_batches
  where id = v_mission.batch_id;

  v_evidence := v_batch.evidence;
  v_photo_spec := coalesce(v_evidence ->> 'photo', 'optional');
  v_note_spec := coalesce(v_evidence ->> 'note', 'optional');
  v_number_spec := v_evidence -> 'number';

  v_paths := coalesce(p_photo_paths, '{}'::text[]);
  if cardinality(v_paths) > 8 then
    raise exception 'invalid_photo_path' using errcode = '22023';
  end if;
  foreach v_path in array v_paths loop
    if v_path is null
       or v_path = ''
       or position('..' in v_path) > 0
       or left(v_path, char_length(p_mission_id::text) + 1) <> (p_mission_id::text || '/') then
      raise exception 'invalid_photo_path' using errcode = '22023';
    end if;
  end loop;

  if v_photo_spec = 'required' and cardinality(v_paths) = 0 then
    raise exception 'photo_required' using errcode = '22023';
  end if;
  if v_photo_spec = 'none' and cardinality(v_paths) > 0 then
    raise exception 'photo_not_allowed' using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  if v_note_spec = 'required' and v_note is null then
    raise exception 'note_required' using errcode = '22023';
  end if;
  if v_note_spec = 'none' and v_note is not null then
    raise exception 'note_not_allowed' using errcode = '22023';
  end if;

  if v_number_spec is null or v_number_spec = 'null'::jsonb then
    if p_number is not null then
      raise exception 'number_not_allowed' using errcode = '22023';
    end if;
  elsif p_number is null then
    raise exception 'number_required' using errcode = '22023';
  end if;

  v_checklist_spec := coalesce(v_evidence -> 'checklist', '[]'::jsonb);
  if jsonb_array_length(v_checklist_spec) > 0 then
    if p_checklist is null or jsonb_typeof(p_checklist) <> 'array' then
      raise exception 'checklist_incomplete' using errcode = '22023';
    end if;
    if jsonb_array_length(p_checklist) <> jsonb_array_length(v_checklist_spec) then
      raise exception 'checklist_incomplete' using errcode = '22023';
    end if;

    for v_item in select value from jsonb_array_elements(p_checklist) loop
      if jsonb_typeof(v_item) <> 'boolean' or v_item <> 'true'::jsonb then
        raise exception 'checklist_incomplete' using errcode = '22023';
      end if;
      v_checklist := v_checklist || jsonb_build_array(true);
    end loop;
  else
    if p_checklist is not null then
      if jsonb_typeof(p_checklist) <> 'array' then
        raise exception 'checklist_incomplete' using errcode = '22023';
      end if;
      if jsonb_array_length(p_checklist) <> 0 then
        raise exception 'checklist_incomplete' using errcode = '22023';
      end if;
    end if;
  end if;

  v_submitter := coalesce(v_actor, v_mission.assignee_user_id);

  insert into public.mission_submissions (
    mission_id,
    submitted_by,
    note,
    number_value,
    photo_paths,
    checklist,
    review_status
  ) values (
    p_mission_id,
    v_submitter,
    v_note,
    p_number,
    v_paths,
    v_checklist,
    'pending'
  )
  returning * into v_submission;

  insert into public.mission_events (mission_id, batch_id, actor_id, event_type, payload)
  values (
    p_mission_id,
    v_mission.batch_id,
    v_submitter,
    'submitted',
    jsonb_build_object('submission_id', v_submission.id)
  );

  v_name := public.manual_mission_name(v_mission.assignee_user_id);
  v_body := '📨 ' || coalesce(v_name, '') || ' đã nộp: ' || v_mission.title || ' — chờ duyệt'
    || E'\n' || 'https://ai.banhmique.vn/warehouse/game?mission=' || p_mission_id::text;

  perform public.enqueue_mission_notice(
    'submitted',
    p_mission_id,
    v_mission.batch_id,
    'submitted:' || v_submission.id::text,
    v_body
  );

  v_result := jsonb_build_object(
    'id', v_submission.id,
    'mission_id', v_submission.mission_id,
    'submitted_by', v_submission.submitted_by,
    'note', v_submission.note,
    'number_value', v_submission.number_value,
    'photo_paths', to_jsonb(v_submission.photo_paths),
    'checklist', v_submission.checklist,
    'review_status', v_submission.review_status,
    'reviewed_by', v_submission.reviewed_by,
    'reviewed_at', v_submission.reviewed_at,
    'review_note', v_submission.review_note,
    'rating', v_submission.rating,
    'created_at', v_submission.created_at
  );

  if p_request_id is not null then
    insert into public.mission_requests (request_id, user_id, kind, result)
    values (p_request_id, v_submitter, 'submit_manual_mission', v_result)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.submit_manual_mission(uuid, text, numeric, text[], jsonb, uuid)
  from public, anon;
grant execute on function public.submit_manual_mission(uuid, text, numeric, text[], jsonb, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 8. Chủ sở hữu duyệt / trả lại
-- ===========================================================================

create or replace function public.review_manual_mission(
  p_submission_id uuid,
  p_approve boolean,
  p_rating smallint,
  p_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_submission public.mission_submissions%rowtype;
  v_mission public.missions%rowtype;
  v_note text;
  v_before integer := 0;
  v_after integer;
  v_level_before jsonb;
  v_level_after jsonb;
  v_award_id uuid;
  v_badge_awarded boolean := false;
  v_name text;
  v_body text;
  v_result jsonb;
begin
  if not (
    public.has_role(auth.uid(), 'owner')
    or coalesce(auth.role(), '') = 'service_role'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_actor is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_submission
  from public.mission_submissions
  where id = p_submission_id
  for update;
  if not found then
    raise exception 'submission_not_found' using errcode = 'P0002';
  end if;

  select * into v_mission
  from public.missions
  where id = v_submission.mission_id
  for update;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if v_submission.review_status <> 'pending' then
    raise exception 'already_reviewed' using errcode = '22023';
  end if;

  -- A withdrawn (cancelled) mission can no longer be approved or returned.
  if v_mission.status <> 'open' then
    raise exception 'mission_not_open' using errcode = '22023';
  end if;

  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'rating_invalid' using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;

  v_name := public.manual_mission_name(v_mission.assignee_user_id);

  if coalesce(p_approve, false) then
    select count(*)::integer into v_before
    from public.mission_badge_awards aw
    where aw.user_id = v_mission.assignee_user_id;
    v_level_before := public.mission_level_for(v_before);

    insert into public.mission_badge_awards (user_id, badge_code, mission_id)
    values (v_mission.assignee_user_id, v_mission.badge_code, v_mission.id)
    on conflict (mission_id) do nothing
    returning id into v_award_id;
    v_badge_awarded := v_award_id is not null;

    select count(*)::integer into v_after
    from public.mission_badge_awards aw
    where aw.user_id = v_mission.assignee_user_id;
    v_level_after := public.mission_level_for(v_after);

    update public.mission_submissions
      set review_status = 'approved',
          reviewed_by = v_actor,
          reviewed_at = now(),
          review_note = v_note,
          rating = p_rating
      where id = p_submission_id;

    update public.missions
      set status = 'completed',
          completed_at = now(),
          completed_by = v_mission.assignee_user_id
      where id = v_mission.id;

    insert into public.mission_events (mission_id, batch_id, actor_id, event_type, payload)
    values (
      v_mission.id,
      v_mission.batch_id,
      v_actor,
      'approved',
      jsonb_build_object(
        'submission_id', p_submission_id,
        'rating', p_rating,
        'badge_awarded', v_badge_awarded
      )
    );

    v_body := '✅ Đã duyệt: ' || v_mission.title || ' — ' || coalesce(v_name, '') || ' nhận 🐝 Chăm chỉ'
      || case
           when p_rating is not null
             then ' (' || p_rating::text || '★)'
           else ''
         end;

    perform public.enqueue_mission_notice(
      'approved',
      v_mission.id,
      v_mission.batch_id,
      'approved:' || p_submission_id::text,
      v_body
    );

    v_result := jsonb_build_object(
      'submission_id', p_submission_id,
      'mission_id', v_mission.id,
      'review_status', 'approved',
      'rating', p_rating,
      'badge_awarded', v_badge_awarded,
      'level_before', v_level_before,
      'level_after', v_level_after
    );
  else
    if v_note is null then
      raise exception 'note_required' using errcode = '22023';
    end if;

    update public.mission_submissions
      set review_status = 'returned',
          reviewed_by = v_actor,
          reviewed_at = now(),
          review_note = v_note,
          rating = p_rating
      where id = p_submission_id;

    insert into public.mission_events (mission_id, batch_id, actor_id, event_type, payload)
    values (
      v_mission.id,
      v_mission.batch_id,
      v_actor,
      'returned',
      jsonb_build_object(
        'submission_id', p_submission_id,
        'note', v_note
      )
    );

    v_body := '↩️ Trả lại cho ' || coalesce(v_name, '') || ': ' || v_mission.title
      || E'\n' || 'Lý do: ' || v_note
      || E'\n' || 'https://ai.banhmique.vn/warehouse/game?mission=' || v_mission.id::text;

    perform public.enqueue_mission_notice(
      'returned',
      v_mission.id,
      v_mission.batch_id,
      'returned:' || p_submission_id::text,
      v_body
    );

    v_result := jsonb_build_object(
      'submission_id', p_submission_id,
      'mission_id', v_mission.id,
      'review_status', 'returned',
      'rating', p_rating,
      'badge_awarded', false,
      'level_before', null,
      'level_after', null
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.review_manual_mission(uuid, boolean, smallint, text)
  from public, anon;
grant execute on function public.review_manual_mission(uuid, boolean, smallint, text)
  to authenticated, service_role;

-- ===========================================================================
-- 9. RPC đọc
-- ===========================================================================

create or replace function public.get_my_manual_missions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_rows jsonb := '[]'::jsonb;
begin
  if v_actor is null then
    if coalesce(auth.role(), '') = 'service_role' then
      return '[]'::jsonb;
    end if;
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'mission_id', m.id,
           'batch_id', m.batch_id,
           'title', m.title,
           'due_at', b.due_at,
           'priority', b.priority,
           'location', b.location,
           'evidence', b.evidence,
           'created_by_name', public.manual_mission_name(b.created_by),
           'created_at', m.created_at,
           'review_state', latest.review_status,
           'last_submission', case
             when latest.id is null then null
             else jsonb_build_object(
               'id', latest.id,
               'note', latest.note,
               'number_value', latest.number_value,
               'photo_paths', to_jsonb(latest.photo_paths),
               'checklist', latest.checklist,
               'review_status', latest.review_status,
               'review_note', latest.review_note,
               'rating', latest.rating,
               'created_at', latest.created_at
             )
           end,
           'submissions_count', (
             select count(*)::integer
             from public.mission_submissions s
             where s.mission_id = m.id
           )
         ) order by
           case when m.status = 'open' then 0 else 1 end,
           m.created_at desc,
           m.id), '[]'::jsonb)
  into v_rows
  from public.missions m
  join public.manual_mission_batches b on b.id = m.batch_id
  left join lateral (
    select s.*
    from public.mission_submissions s
    where s.mission_id = m.id
    order by s.created_at desc, s.id desc
    limit 1
  ) latest on true
  where m.assignee_user_id = v_actor
    and m.status in ('open', 'completed');

  return v_rows;
end;
$$;

revoke all on function public.get_my_manual_missions() from public, anon;
grant execute on function public.get_my_manual_missions() to authenticated, service_role;

create or replace function public.get_manual_missions_overview(p_limit integer default 60)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 60), 200));
  v_rows jsonb := '[]'::jsonb;
begin
  if not (
    public.has_role(auth.uid(), 'owner')
    or coalesce(auth.role(), '') = 'service_role'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'batch_id', b.id,
           'title', b.title,
           'description', b.description,
           'due_at', b.due_at,
           'priority', b.priority,
           'location', b.location,
           'evidence', b.evidence,
           'created_at', b.created_at,
           'assignees', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'mission_id', m.id,
                      'user_id', m.assignee_user_id,
                      'name', public.manual_mission_name(m.assignee_user_id),
                      'status', m.status,
                      'review_state', latest.review_status,
                      'completed_at', m.completed_at,
                      'last_submission', case
                        when latest.id is null then null
                        else jsonb_build_object(
                          'id', latest.id,
                          'note', latest.note,
                          'number_value', latest.number_value,
                          'photo_paths', to_jsonb(latest.photo_paths),
                          'checklist', latest.checklist,
                          'review_status', latest.review_status,
                          'review_note', latest.review_note,
                          'rating', latest.rating,
                          'created_at', latest.created_at
                        )
                      end
                    ) order by public.manual_mission_name(m.assignee_user_id), m.id),
                    '[]'::jsonb)
             from public.missions m
             left join lateral (
               select s.*
               from public.mission_submissions s
               where s.mission_id = m.id
               order by s.created_at desc, s.id desc
               limit 1
             ) latest on true
             where m.batch_id = b.id
           )
         ) order by b.created_at desc, b.id desc), '[]'::jsonb)
  into v_rows
  from (
    select *
    from public.manual_mission_batches b
    where exists (
      select 1
      from public.missions m
      where m.batch_id = b.id
        and m.status <> 'cancelled'
    )
    order by b.created_at desc, b.id desc
    limit v_limit
  ) b;

  return v_rows;
end;
$$;

revoke all on function public.get_manual_missions_overview(integer) from public, anon;
grant execute on function public.get_manual_missions_overview(integer) to authenticated, service_role;

create or replace function public.get_mission_submissions(p_mission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_mission public.missions%rowtype;
  v_rows jsonb := '[]'::jsonb;
begin
  select * into v_mission
  from public.missions
  where id = p_mission_id;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if v_mission.assignee_user_id <> v_actor
       and not public.has_role(v_actor, 'owner') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'mission_id', s.mission_id,
           'submitted_by', s.submitted_by,
           'note', s.note,
           'number_value', s.number_value,
           'photo_paths', to_jsonb(s.photo_paths),
           'checklist', s.checklist,
           'review_status', s.review_status,
           'reviewed_by', s.reviewed_by,
           'reviewed_at', s.reviewed_at,
           'review_note', s.review_note,
           'rating', s.rating,
           'created_at', s.created_at
         ) order by s.created_at desc, s.id desc), '[]'::jsonb)
  into v_rows
  from public.mission_submissions s
  where s.mission_id = p_mission_id;

  return v_rows;
end;
$$;

revoke all on function public.get_mission_submissions(uuid) from public, anon;
grant execute on function public.get_mission_submissions(uuid) to authenticated, service_role;

-- ===========================================================================
-- 10. Chấm điểm mission_evaluate + một nhánh manual_review
-- ===========================================================================
-- Bản sao nguyên văn định nghĩa hiện hành (20261101450000_mission_assignee_access.sql),
-- chỉ thêm nhánh manual_review ở đầu chuỗi if. Khi định nghĩa lại hàm này, giữ
-- nguyên nhánh manual_review.

create or replace function public.mission_evaluate(p_mission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mission public.missions%rowtype;
  v_done boolean := false;
  v_total integer := 0;
  v_left integer := 0;
  v_detail jsonb := '[]'::jsonb;
  v_alias_id uuid;
  v_bad_factor numeric;
  v_bad_item uuid;
  v_alias public.stock_material_aliases%rowtype;
  v_alias_found boolean;
  v_item_name text;
  v_item_unit text;
  v_fixed boolean;
  v_rows jsonb;
  v_index integer;
  v_active integer;
  v_name_changed boolean;
  v_pair boolean;
  v_a uuid;
  v_b uuid;
  v_row public.kitchen_inventory_items%rowtype;
  v_days integer;
  v_initial integer;
  v_groups integer;
  v_ignored integer;
  v_location text;
  v_review jsonb;
  v_counts jsonb;
  v_linked integer;
  v_batch text;
  v_question_total integer := 0;
  v_question_open integer := 0;
  v_question_answered integer := 0;
  v_question_skipped integer := 0;
  v_bom_open integer := 0;
  v_bom_excluded integer := 0;
  v_bom_resolved integer := 0;
  v_bom_total integer := 0;
  v_recipe public.tan_tao_recipes%rowtype;
  v_recipe_total integer := 0;
  v_recipe_open integer := 0;
  v_recipe_answered integer := 0;
  v_recipe_not_used integer := 0;
  v_recipe_code text;
  v_sku_code text;
  v_since date;
  v_sku_counted_at timestamptz;
  v_sku_counted_qty numeric;
begin
  select * into v_mission from public.missions where id = p_mission_id;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  -- Keep the manual_review branch when redefining mission_evaluate (manual missions).
  if v_mission.check_rule = 'manual_review' then
    select exists (
      select 1
      from public.mission_submissions s
      where s.mission_id = p_mission_id
        and s.review_status = 'approved'
    ) into v_done;

    v_total := 1;
    v_left := case when v_done then 0 else 1 end;
    v_detail := '[]'::jsonb;

  elsif v_mission.check_rule = 'stock_alias_factor_fixed' then
    v_rows := coalesce(v_mission.check_params -> 'aliases', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_alias_id := (v_rows -> v_index ->> 'id')::uuid;
      v_bad_factor := (v_rows -> v_index ->> 'bad_factor')::numeric;
      v_bad_item := (v_rows -> v_index ->> 'bad_item_id')::uuid;

      select * into v_alias from public.stock_material_aliases a where a.id = v_alias_id;
      v_alias_found := found;

      if not v_alias_found then
        v_fixed := true;
        v_item_name := null;
        v_item_unit := null;
      else
        select k.name, k.unit into v_item_name, v_item_unit
        from public.kitchen_inventory_items k
        where k.id = v_alias.kitchen_inventory_item_id;

        v_fixed := (v_alias.conversion_factor is distinct from v_bad_factor)
          or (v_alias.kitchen_inventory_item_id is distinct from v_bad_item);
      end if;

      if not v_fixed then
        v_left := v_left + 1;
      end if;

      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'id', v_alias_id,
        'name', case when v_alias_found then v_alias.normalized_name else null end,
        'unit', case when v_alias_found then v_alias.unit else null end,
        'factor', case when v_alias_found then v_alias.conversion_factor else null end,
        'item_name', v_item_name,
        'item_unit', v_item_unit,
        'fixed', v_fixed
      ));
    end loop;
    v_done := (v_left = 0);

  elsif v_mission.check_rule = 'stock_duplicate_resolved' then
    v_rows := coalesce(v_mission.check_params -> 'items', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    v_active := 0;
    v_name_changed := false;
    v_pair := false;

    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_a := (v_rows -> v_index ->> 'id')::uuid;
      select * into v_row from public.kitchen_inventory_items k where k.id = v_a;
      if not found then
        v_name_changed := true;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_a,
          'code', null,
          'name', null,
          'unit', null,
          'active', false,
          'on_hand', 0,
          'alias_count', 0
        ));
      else
        if coalesce(v_row.active, false) then
          v_active := v_active + 1;
        end if;
        if v_row.name is distinct from (v_rows -> v_index ->> 'name') then
          v_name_changed := true;
        end if;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_row.id,
          'code', v_row.item_code,
          'name', v_row.name,
          'unit', v_row.unit,
          'active', coalesce(v_row.active, false),
          'on_hand', coalesce((
            select sum(case m.movement_type
                         when 'receipt' then m.quantity
                         when 'production_usage' then -m.quantity
                         when 'adjustment' then m.quantity
                         else 0 end)
            from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = v_row.id
          ), 0),
          'alias_count', (
            select count(*)
            from public.stock_material_aliases a
            where a.kitchen_inventory_item_id = v_row.id
          )
        ));
      end if;
    end loop;

    if v_total = 2 then
      v_a := (v_rows -> 0 ->> 'id')::uuid;
      v_b := (v_rows -> 1 ->> 'id')::uuid;
      select exists (
        select 1 from public.stock_item_distinct_pairs p
        where p.item_a = least(v_a, v_b)
          and p.item_b = greatest(v_a, v_b)
      ) into v_pair;
    end if;

    v_done := (v_active < 2) or v_name_changed or v_pair;
    v_left := case when v_done then 0 else 1 end;

  elsif v_mission.check_rule = 'stock_unknown_units_cleared' then
    v_days := coalesce((v_mission.check_params ->> 'days')::integer, 60);
    v_initial := coalesce((v_mission.check_params ->> 'initial')::integer, 0);
    v_total := v_initial;

    select count(distinct lower(btrim(r.unit)))::integer into v_groups
    from public.stock_unknown_purchase_unit_rows(v_days) r;

    select count(*)::integer into v_ignored
    from public.stock_unit_ignored_variants g
    where exists (
      select 1
      from public.stock_unknown_purchase_unit_rows(v_days) r
      where g.variant = lower(btrim(r.unit))
    );

    v_left := greatest(coalesce(v_groups, 0) - coalesce(v_ignored, 0), 0);
    v_done := (v_left = 0);

    select coalesce(jsonb_agg(jsonb_build_object(
             'unit', r.unit,
             'line_count', r.line_count,
             'example_name', r.example_name,
             'source_table', r.source_table
           ) order by r.line_count desc, r.unit asc, r.source_table asc), '[]'::jsonb)
    into v_detail
    from public.stock_unknown_purchase_unit_rows(v_days) r;

  elsif v_mission.check_rule = 'material_links_done' then
    v_location := v_mission.check_params ->> 'location';
    v_counts := public.material_link_counts_internal(v_location);
    v_left := coalesce((v_counts ->> 'total')::int, 0);
    v_linked := coalesce((v_counts ->> 'linked_total')::int, 0);
    v_total := v_left + v_linked;
    v_done := (v_left = 0 and v_total > 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'location', v_location,
      'remaining', v_left,
      'linked', v_linked,
      'exact', coalesce((v_counts ->> 'exact')::int, 0),
      'skipped', coalesce((v_counts ->> 'skipped')::int, 0)
    ));

  elsif v_mission.check_rule = 'stock_count_questions_done' then
    v_batch := v_mission.check_params ->> 'batch';

    select
      count(*)::integer,
      (count(*) filter (where q.status = 'open'))::integer,
      (count(*) filter (where q.status = 'answered'))::integer,
      (count(*) filter (where q.status = 'skipped'))::integer
    into v_question_total, v_question_open, v_question_answered, v_question_skipped
    from public.stock_count_unit_questions q
    where q.batch = v_batch;

    v_total := coalesce(v_question_total, 0);
    v_left := coalesce(v_question_open, 0);
    v_done := (v_total > 0 and v_left = 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'count_questions',
      'batch', v_batch,
      'total', v_total,
      'open', v_left,
      'answered', coalesce(v_question_answered, 0),
      'skipped', coalesce(v_question_skipped, 0)
    ));

  elsif v_mission.check_rule = 'q7_bom_mismatch_resolved' then
    v_review := public.get_q7_bom_mismatch_review();
    v_bom_total := coalesce(jsonb_array_length(v_review), 0);
    select
      count(*) filter (where (r ->> 'open')::boolean = true)::integer,
      count(*) filter (where (r ->> 'excluded')::boolean = true)::integer,
      count(*) filter (where (r ->> 'resolved')::boolean = true)::integer
    into v_bom_open, v_bom_excluded, v_bom_resolved
    from jsonb_array_elements(v_review) r;

    v_total := v_bom_total;
    v_left := coalesce(v_bom_open, 0);
    v_done := (
      v_left = 0
      and exists (
        select 1
        from public.production_material_issues pmi
        where pmi.location_code = 'q7'
          and pmi.is_current = true
          and pmi.issue_date > public.stock_ledger_cutover_date('q7')
      )
    );
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'bom_mismatch',
      'open', v_left,
      'resolved', coalesce(v_bom_resolved, 0),
      'excluded', coalesce(v_bom_excluded, 0),
      'total', v_total
    ));

  elsif v_mission.check_rule = 'tan_tao_recipe_done' then
    v_recipe_code := v_mission.check_params ->> 'code';

    select * into v_recipe
    from public.tan_tao_recipes r
    where r.code = v_recipe_code;

    if not found then
      v_total := 0;
      v_left := 0;
      v_done := false;
      v_detail := jsonb_build_array(jsonb_build_object(
        'kind', 'recipe',
        'code', v_recipe_code,
        'open', 0,
        'answered', 0,
        'not_used', 0,
        'batch_set', false
      ));
    else
      select
        count(*)::integer,
        (count(*) filter (where l.status = 'open'))::integer,
        (count(*) filter (where l.status = 'answered'))::integer,
        (count(*) filter (where l.status = 'not_used'))::integer
      into v_recipe_total, v_recipe_open, v_recipe_answered, v_recipe_not_used
      from public.tan_tao_recipe_lines l
      where l.recipe_id = v_recipe.id;

      v_done := (v_recipe.status = 'complete');
      v_total := coalesce(v_recipe_total, 0) + 1;
      v_left := case
        when v_done then 0
        else coalesce(v_recipe_open, 0)
          + case when coalesce(v_recipe.batch_output_kg, 0) > 0 then 0 else 1 end
      end;
      v_detail := jsonb_build_array(jsonb_build_object(
        'kind', 'recipe',
        'code', v_recipe.code,
        'open', coalesce(v_recipe_open, 0),
        'answered', coalesce(v_recipe_answered, 0),
        'not_used', coalesce(v_recipe_not_used, 0),
        'batch_set', coalesce(v_recipe.batch_output_kg, 0) > 0
      ));
    end if;

  elsif v_mission.check_rule = 'sku_counted' then
    v_sku_code := v_mission.check_params ->> 'sku_code';
    v_since := (v_mission.check_params ->> 'since')::date;

    select d.created_at, d.quantity
    into v_sku_counted_at, v_sku_counted_qty
    from public.tan_tao_warehouse_documents d
    where d.document_type = 'stock_count'
      and d.status = 'posted'
      and lower(btrim(d.sku_code_snapshot)) = lower(btrim(v_sku_code))
      and (d.created_at at time zone 'Asia/Ho_Chi_Minh')::date >= v_since
    order by d.created_at desc, d.id desc
    limit 1;

    v_done := found;
    v_total := 1;
    v_left := case when v_done then 0 else 1 end;
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'sku_count',
      'sku_code', v_sku_code,
      'since', v_since,
      'counted_at', v_sku_counted_at,
      'counted_qty', v_sku_counted_qty
    ));

  else
    raise exception 'unknown_check_rule' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'done', v_done,
    'total', v_total,
    'left', v_left,
    'detail', v_detail
  );
end;
$$;

revoke all on function public.mission_evaluate(uuid) from public, anon, authenticated;
grant execute on function public.mission_evaluate(uuid) to service_role;

-- ===========================================================================
-- 11. Nhắc hạn 24 giờ / quá hạn
-- ===========================================================================

create or replace function public.enqueue_mission_reminders()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_mission record;
  v_name text;
  v_body text;
  v_link text;
  v_due_soon integer := 0;
  v_overdue integer := 0;
begin
  -- Serialise concurrent scheduler runs; dedupe keys still guard each notice.
  perform pg_advisory_xact_lock(hashtext('mission_reminders'));

  for v_mission in
    select m.id, m.batch_id, m.title, m.assignee_user_id, b.due_at
    from public.missions m
    join public.manual_mission_batches b on b.id = m.batch_id
    where m.status = 'open'
      and b.due_at is not null
      and b.due_at <= now() + interval '24 hours'
    order by b.due_at asc, m.id
  loop
    v_name := public.manual_mission_name(v_mission.assignee_user_id);
    v_link := 'https://ai.banhmique.vn/warehouse/game?mission=' || v_mission.id::text;

    if v_mission.due_at < now() then
      v_body := '⚠️ Quá hạn: ' || v_mission.title || ' — ' || coalesce(v_name, '')
        || E'\n' || v_link;
      if public.enqueue_mission_notice(
           'overdue',
           v_mission.id,
           v_mission.batch_id,
           'overdue:' || v_mission.id::text,
           v_body
         ) then
        insert into public.mission_events (mission_id, batch_id, event_type, payload)
        values (
          v_mission.id,
          v_mission.batch_id,
          'overdue',
          jsonb_build_object('due_at', v_mission.due_at)
        );
        v_overdue := v_overdue + 1;
      end if;
    else
      v_body := '⏰ Còn dưới 24 giờ: ' || v_mission.title || ' — ' || coalesce(v_name, '')
        || E'\n' || v_link;
      if public.enqueue_mission_notice(
           'due_soon',
           v_mission.id,
           v_mission.batch_id,
           'due_soon:' || v_mission.id::text,
           v_body
         ) then
        insert into public.mission_events (mission_id, batch_id, event_type, payload)
        values (
          v_mission.id,
          v_mission.batch_id,
          'due_soon',
          jsonb_build_object('due_at', v_mission.due_at)
        );
        v_due_soon := v_due_soon + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'due_soon', v_due_soon,
    'overdue', v_overdue
  );
end;
$$;

revoke all on function public.enqueue_mission_reminders() from public, anon, authenticated;
grant execute on function public.enqueue_mission_reminders() to service_role;

-- ===========================================================================
-- 12. Lịch chạy (pg_cron) + bucket bằng chứng
-- ===========================================================================

do $mission_cron$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'mission-reminders-hourly'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'mission-reminders-hourly',
    '10 * * * *',
    $job$ select public.enqueue_mission_reminders(); $job$
  );

  for existing_job_id in
    select jobid from cron.job where jobname = 'mission-zalo-notify-every-2-min'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'mission-zalo-notify-every-2-min',
    '*/2 * * * *',
    $job$
      select net.http_post(
        url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/mission-zalo-notify',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-worker-secret', (
            select worker_secret::text
            from public.mission_zalo_notification_config
            where id = 'mission-zalo'
          )
        ),
        body := jsonb_build_object('batch_size', 10),
        timeout_milliseconds := 10000
      );
    $job$
  );
end;
$mission_cron$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'mission-evidence',
  'mission-evidence',
  false,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic'
  ]
)
on conflict (id) do nothing;

drop policy if exists mission_evidence_objects_insert on storage.objects;
create policy mission_evidence_objects_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'mission-evidence'
    and exists (
      select 1
      from public.missions m
      where m.id::text = (storage.foldername(name))[1]
        and m.batch_id is not null
        and m.status = 'open'
        and m.assignee_user_id = (select auth.uid())
    )
  );

drop policy if exists mission_evidence_objects_select on storage.objects;
create policy mission_evidence_objects_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'mission-evidence'
    and (
      public.has_role((select auth.uid()), 'owner')
      or exists (
        select 1
        from public.missions m
        where m.id::text = (storage.foldername(name))[1]
          and m.assignee_user_id = (select auth.uid())
      )
    )
  );

-- ===========================================================================
-- Smoke assertions (toàn bộ nằm trong một transaction, kết thúc bằng RAISE)
-- ===========================================================================
do $smoke_manual_missions$
declare
  v_owner uuid;
  v_staff uuid;
  v_staff2 uuid;
  v_assignees uuid[];
  v_batch uuid;
  v_mission uuid;
  v_created jsonb;
  v_my jsonb;
  v_result jsonb;
  v_submission uuid;
  v_submission2 uuid;
  v_notice integer;
  v_event integer;
  v_probe integer;
  v_reminder_batch uuid;
  v_reminder_mission uuid;
  v_due_soon_before integer;
  v_due_soon_after integer;
  v_existing uuid;
  v_eval jsonb;
  v_evidence jsonb;
begin
  -- Chủ sở hữu thật và hai nhân viên thật có dòng user_roles (không hard-code
  -- UUID / email).
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;

  select array_agg(u.user_id order by u.first_seen, u.user_id)
  into v_assignees
  from (
    select ur.user_id, min(ur.created_at) as first_seen
    from public.user_roles ur
    where ur.user_id <> v_owner
      and not public.has_role(ur.user_id, 'owner')
    group by ur.user_id
    order by min(ur.created_at), ur.user_id
    limit 2
  ) u;

  if coalesce(array_length(v_assignees, 1), 0) < 2 then
    raise exception 'SMOKE_RESULT FAIL no_staff';
  end if;
  v_staff := v_assignees[1];
  v_staff2 := v_assignees[2];

  v_evidence := jsonb_build_object(
    'photo', 'required',
    'note', 'optional',
    'number', jsonb_build_object('label', 'Số thùng', 'unit', 'thùng'),
    'checklist', jsonb_build_array('Kiểm tra niêm phong', 'Đếm đủ thùng')
  );

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- (1) Tạo đợt 2 người: 2 missions, 1 notice assigned, event created + 2 assigned.
  v_created := public.create_manual_mission(
    'Smoke nhiệm vụ thủ công ' || left(replace(gen_random_uuid()::text, '-', ''), 6),
    'Nhiệm vụ tạo bởi smoke, sẽ rollback.',
    v_assignees,
    now() + interval '2 days',
    'high',
    'tan_tao',
    v_evidence,
    gen_random_uuid()
  );

  v_batch := (v_created ->> 'batch_id')::uuid;
  if v_batch is null or jsonb_array_length(v_created -> 'missions') <> 2 then
    raise exception 'SMOKE_RESULT FAIL create_batch_missions %', v_created;
  end if;
  v_mission := (v_created -> 'missions' -> 0 ->> 'mission_id')::uuid;

  select count(*)::integer into v_probe
  from public.missions m
  where m.batch_id = v_batch
    and m.check_rule = 'manual_review'
    and m.area = 'manual'
    and m.status = 'open'
    and m.assignee_user_id in (v_staff, v_staff2);
  if v_probe <> 2 then
    raise exception 'SMOKE_RESULT FAIL create_batch_missions count=%', v_probe;
  end if;

  select count(*)::integer into v_notice
  from public.mission_zalo_notifications n
  where n.batch_id = v_batch
    and n.event_type = 'assigned';
  if v_notice <> 1 then
    raise exception 'SMOKE_RESULT FAIL create_batch_notice count=%', v_notice;
  end if;

  select count(*)::integer into v_event
  from public.mission_events e
  where e.batch_id = v_batch
    and e.event_type = 'created';
  if v_event <> 1 then
    raise exception 'SMOKE_RESULT FAIL create_batch_events created=%', v_event;
  end if;
  select count(*)::integer into v_event
  from public.mission_events e
  where e.batch_id = v_batch
    and e.event_type = 'assigned';
  if v_event <> 2 then
    raise exception 'SMOKE_RESULT FAIL create_batch_events assigned=%', v_event;
  end if;

  -- (2) Nhân viên thấy mission trên bảng cũ, tiến độ chưa xong.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_my := public.get_my_missions(null);
  if not exists (
    select 1
    from jsonb_array_elements(v_my -> 'missions') x
    where (x ->> 'id')::uuid = v_mission
      and (x -> 'progress' ->> 'done')::boolean is false
  ) then
    raise exception 'SMOKE_RESULT FAIL staff_board_progress %', v_my;
  end if;

  -- (3) Nộp thiếu ảnh: photo_required.
  v_probe := 0;
  begin
    perform public.submit_manual_mission(
      v_mission, 'Hàng đủ', 10, '{}'::text[], '[true,true]'::jsonb, gen_random_uuid()
    );
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%photo_required%' then
      raise exception 'SMOKE_RESULT FAIL photo_required: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL photo_required accepted';
  end if;

  -- (4) Nộp hợp lệ: pending + notice submitted + event submitted.
  v_result := public.submit_manual_mission(
    v_mission,
    'Hàng đủ',
    10,
    array[v_mission::text || '/a.jpg'],
    '[true,true]'::jsonb,
    gen_random_uuid()
  );
  v_submission := (v_result ->> 'id')::uuid;
  if (v_result ->> 'review_status') <> 'pending' then
    raise exception 'SMOKE_RESULT FAIL submit_pending %', v_result;
  end if;

  select count(*)::integer into v_notice
  from public.mission_zalo_notifications n
  where n.mission_id = v_mission
    and n.event_type = 'submitted';
  if v_notice <> 1 then
    raise exception 'SMOKE_RESULT FAIL submit_notice count=%', v_notice;
  end if;

  select count(*)::integer into v_event
  from public.mission_events e
  where e.mission_id = v_mission
    and e.event_type = 'submitted';
  if v_event <> 1 then
    raise exception 'SMOKE_RESULT FAIL submit_pending event=%', v_event;
  end if;

  -- (5) Nộp lần hai khi đang pending: already_submitted.
  v_probe := 0;
  begin
    perform public.submit_manual_mission(
      v_mission,
      'Hàng đủ',
      10,
      array[v_mission::text || '/a.jpg'],
      '[true,true]'::jsonb,
      gen_random_uuid()
    );
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%already_submitted%' then
      raise exception 'SMOKE_RESULT FAIL second_submit: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL second_submit accepted';
  end if;

  -- (6) Chủ sở hữu trả lại thiếu lý do: note_required.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_probe := 0;
  begin
    perform public.review_manual_mission(v_submission, false, null, null);
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%note_required%' then
      raise exception 'SMOKE_RESULT FAIL return_note_required: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL return_note_required accepted';
  end if;

  -- (7) Trả lại kèm lý do: returned + notice returned; mission vẫn open.
  v_result := public.review_manual_mission(v_submission, false, null, 'Thiếu ảnh mặt sau');
  if (v_result ->> 'review_status') <> 'returned' then
    raise exception 'SMOKE_RESULT FAIL return_notice %', v_result;
  end if;
  select count(*)::integer into v_notice
  from public.mission_zalo_notifications n
  where n.mission_id = v_mission
    and n.event_type = 'returned';
  if v_notice <> 1 then
    raise exception 'SMOKE_RESULT FAIL return_notice count=%', v_notice;
  end if;
  select count(*)::integer into v_event
  from public.mission_events e
  where e.mission_id = v_mission
    and e.event_type = 'returned';
  if v_event <> 1 then
    raise exception 'SMOKE_RESULT FAIL return_notice event=%', v_event;
  end if;
  select count(*)::integer into v_probe
  from public.missions m
  where m.id = v_mission
    and m.status = 'open';
  if v_probe <> 1 then
    raise exception 'SMOKE_RESULT FAIL return_notice mission_not_open';
  end if;

  -- (8) Nhân viên nộp lại sau khi bị trả.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_result := public.submit_manual_mission(
    v_mission,
    'Đã bổ sung ảnh mặt sau',
    10,
    array[v_mission::text || '/b.jpg'],
    '[true,true]'::jsonb,
    gen_random_uuid()
  );
  v_submission2 := (v_result ->> 'id')::uuid;
  if (v_result ->> 'review_status') <> 'pending' then
    raise exception 'SMOKE_RESULT FAIL resubmit_pending %', v_result;
  end if;

  -- (9) Duyệt 5 sao: mission completed, badge cham_chi, notice approved.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_result := public.review_manual_mission(v_submission2, true, 5::smallint, null);
  if (v_result ->> 'review_status') <> 'approved' then
    raise exception 'SMOKE_RESULT FAIL approve_mission %', v_result;
  end if;
  if (v_result ->> 'badge_awarded')::boolean is not true then
    raise exception 'SMOKE_RESULT FAIL approve_badge %', v_result;
  end if;

  select count(*)::integer into v_probe
  from public.missions m
  where m.id = v_mission
    and m.status = 'completed'
    and m.completed_by = v_staff;
  if v_probe <> 1 then
    raise exception 'SMOKE_RESULT FAIL approve_mission completed=%', v_probe;
  end if;
  select count(*)::integer into v_probe
  from public.mission_badge_awards aw
  where aw.mission_id = v_mission
    and aw.user_id = v_staff
    and aw.badge_code = 'cham_chi';
  if v_probe <> 1 then
    raise exception 'SMOKE_RESULT FAIL approve_badge count=%', v_probe;
  end if;
  select count(*)::integer into v_notice
  from public.mission_zalo_notifications n
  where n.mission_id = v_mission
    and n.event_type = 'approved';
  if v_notice <> 1 then
    raise exception 'SMOKE_RESULT FAIL approve_notice count=%', v_notice;
  end if;
  select count(*)::integer into v_event
  from public.mission_events e
  where e.mission_id = v_mission
    and e.event_type = 'approved';
  if v_event <> 1 then
    raise exception 'SMOKE_RESULT FAIL approve_notice event=%', v_event;
  end if;

  -- (10) Bảng cũ của nhân viên báo xong.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_my := public.get_my_missions(null);
  if not exists (
    select 1
    from jsonb_array_elements(v_my -> 'missions') x
    where (x ->> 'id')::uuid = v_mission
      and (x ->> 'status') = 'completed'
      and (x -> 'progress' ->> 'done')::boolean is true
  ) then
    raise exception 'SMOKE_RESULT FAIL staff_board_done %', v_my;
  end if;

  -- (11) Nhân viên gọi duyệt: forbidden.
  v_probe := 0;
  begin
    perform public.review_manual_mission(v_submission2, true, null, null);
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%forbidden%' then
      raise exception 'SMOKE_RESULT FAIL staff_review_forbidden: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL staff_review_forbidden accepted';
  end if;

  -- (12) Người khác nộp mission của staff: forbidden.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff2, 'role', 'authenticated')::text, true);
  v_probe := 0;
  begin
    perform public.submit_manual_mission(
      v_mission,
      'Chen ngang',
      10,
      array[v_mission::text || '/c.jpg'],
      '[true,true]'::jsonb,
      gen_random_uuid()
    );
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%forbidden%' then
      raise exception 'SMOKE_RESULT FAIL other_submit_forbidden: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL other_submit_forbidden accepted';
  end if;

  -- (13) Tạo với hạn đã qua: due_in_past.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_probe := 0;
  begin
    perform public.create_manual_mission(
      'Smoke quá hạn',
      null,
      v_assignees[1:1],
      now() - interval '2 hours',
      'normal',
      null,
      v_evidence,
      gen_random_uuid()
    );
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%due_in_past%' then
      raise exception 'SMOKE_RESULT FAIL create_due_in_past: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL create_due_in_past accepted';
  end if;

  -- (14) Nhắc hạn: mission hạn 2 giờ -> 1 notice due_soon; chạy lại không thêm.
  v_created := public.create_manual_mission(
    'Smoke nhắc hạn',
    null,
    v_assignees[1:1],
    now() + interval '2 hours',
    'normal',
    null,
    jsonb_build_object('photo', 'none', 'note', 'none'),
    gen_random_uuid()
  );
  v_reminder_batch := (v_created ->> 'batch_id')::uuid;
  v_reminder_mission := (v_created -> 'missions' -> 0 ->> 'mission_id')::uuid;

  select count(*)::integer into v_due_soon_before
  from public.mission_zalo_notifications n
  where n.mission_id = v_reminder_mission
    and n.event_type = 'due_soon';

  v_result := public.enqueue_mission_reminders();

  select count(*)::integer into v_due_soon_after
  from public.mission_zalo_notifications n
  where n.mission_id = v_reminder_mission
    and n.event_type = 'due_soon';
  if v_due_soon_after <> v_due_soon_before + 1 then
    raise exception 'SMOKE_RESULT FAIL reminder_due_soon before=% after=% result=%',
      v_due_soon_before, v_due_soon_after, v_result;
  end if;

  v_result := public.enqueue_mission_reminders();

  select count(*)::integer into v_notice
  from public.mission_zalo_notifications n
  where n.mission_id = v_reminder_mission
    and n.event_type = 'due_soon';
  if v_notice <> v_due_soon_after then
    raise exception 'SMOKE_RESULT FAIL reminder_idempotent notices=% expected=%',
      v_notice, v_due_soon_after;
  end if;
  select count(*)::integer into v_event
  from public.mission_events e
  where e.mission_id = v_reminder_mission
    and e.event_type = 'due_soon';
  if v_event <> 1 then
    raise exception 'SMOKE_RESULT FAIL reminder_idempotent events=%', v_event;
  end if;

  -- (15) mission_events là append-only.
  v_probe := 0;
  begin
    update public.mission_events
      set payload = payload
      where id = (
        select e.id from public.mission_events e
        order by e.created_at, e.id
        limit 1
      );
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%mission_events_append_only%' then
      raise exception 'SMOKE_RESULT FAIL events_append_only: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL events_append_only accepted';
  end if;

  -- (16) Nhiệm vụ cũ vẫn chấm được (không có nhánh nào bị đổi).
  select m.id into v_existing
  from public.missions m
  where m.status = 'open'
    and m.check_rule <> 'manual_review'
  order by case
             when m.check_rule in (
               'stock_alias_factor_fixed',
               'stock_duplicate_resolved',
               'stock_unknown_units_cleared'
             ) then 0
             else 1
           end,
           m.created_at,
           m.id
  limit 1;

  if v_existing is null then
    insert into public.missions (
      code, area, title, assignee_user_id,
      check_rule, check_params, badge_code, sort_order, created_by
    ) values (
      'smoke-existing-' || left(replace(gen_random_uuid()::text, '-', ''), 10),
      'warehouse',
      'Smoke nhiệm vụ cũ',
      v_owner,
      'stock_alias_factor_fixed',
      jsonb_build_object('aliases', '[]'::jsonb),
      'cham_chi',
      999,
      v_owner
    )
    returning id into v_existing;
  end if;

  v_eval := public.mission_evaluate(v_existing);
  if v_eval is null or not (v_eval ? 'done') then
    raise exception 'SMOKE_RESULT FAIL existing_evaluate %', v_eval;
  end if;

  raise exception 'SMOKE_RESULT PASS: manual missions';
end;
$smoke_manual_missions$;

rollback;
