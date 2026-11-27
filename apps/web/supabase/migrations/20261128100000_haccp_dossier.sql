-- 2026-11-28 — Hồ sơ HACCP bếp Quận 7 (phần dữ liệu, chưa áp production).
--
-- Seven tables of the consultant's workbook are stored in haccp_entries, one
-- row per line and a jsonb "values" object restricted to the keys declared in
-- src/lib/haccp-schema.ts. Evidence files live in the private haccp-docs bucket
-- and are linked to one entry or to the layout section.
--
-- Managers (owner or kho_item_can_edit) work through the SECURITY DEFINER RPCs.
-- A staff link stores only the SHA-256 of a 32-byte token, expires after 7, 30
-- or 90 days and can be revoked. Link RPCs are service_role-only; the
-- haccp-upload Edge Function verifies the token and calls them.
--
-- This migration never updates suppliers, purchase orders, goods receipts,
-- kitchen inventory items or payroll rows. haccp_prefill reads them and only
-- inserts into haccp_entries. It never copies salary or phone data from payroll.

create extension if not exists pgcrypto with schema extensions;

-- ===========================================================================
-- 1. Dossier rows
-- ===========================================================================

create table if not exists public.haccp_entries (
  id uuid primary key default gen_random_uuid(),
  table_id text not null,
  "values" jsonb not null default '{}'::jsonb,
  "position" integer not null default 0,
  source_key text,
  entered_by_name text not null default '',
  entered_by uuid references auth.users(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  constraint haccp_entries_table_check check (
    table_id in ('suppliers', 'team', 'staff', 'measure', 'machines', 'chemicals', 'process')
  ),
  constraint haccp_entries_values_object_check check (jsonb_typeof("values") = 'object'),
  constraint haccp_entries_position_check check ("position" >= 0),
  constraint haccp_entries_version_check check (version > 0),
  constraint haccp_entries_source_key_check check (source_key is null or btrim(source_key) <> ''),
  constraint haccp_entries_source_key_key unique (source_key)
);

create index if not exists idx_haccp_entries_table
  on public.haccp_entries (table_id, "position", created_at)
  where deleted_at is null;

create index if not exists idx_haccp_entries_source
  on public.haccp_entries (source_key)
  where source_key is not null;

-- ===========================================================================
-- 2. Evidence files
-- ===========================================================================

create table if not exists public.haccp_files (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid references public.haccp_entries(id) on delete cascade,
  layout boolean not null default false,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  uploaded_by_name text not null default '',
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  constraint haccp_files_owner_check check (
    (entry_id is not null and layout = false)
    or (entry_id is null and layout = true)
  ),
  constraint haccp_files_path_check check (
    storage_path like 'haccp/%' and position('..' in storage_path) = 0
  ),
  constraint haccp_files_name_check check (btrim(file_name) <> '' and length(file_name) <= 255),
  constraint haccp_files_size_check check (size_bytes > 0 and size_bytes <= 10485760),
  constraint haccp_files_mime_check check (
    mime_type in (
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  )
);

create index if not exists idx_haccp_files_entry
  on public.haccp_files (entry_id, created_at)
  where deleted_at is null;

create index if not exists idx_haccp_files_layout
  on public.haccp_files (created_at)
  where layout = true and deleted_at is null;

-- ===========================================================================
-- 3. Staff upload links, idempotency ledger and activity
-- ===========================================================================

create table if not exists public.haccp_upload_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  days integer not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  request_id uuid unique,
  constraint haccp_upload_links_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint haccp_upload_links_days_check check (days in (7, 30, 90)),
  constraint haccp_upload_links_expiry_check check (expires_at > created_at)
);

create index if not exists idx_haccp_upload_links_active
  on public.haccp_upload_links (expires_at)
  where revoked_at is null;

create table if not exists public.haccp_requests (
  request_id uuid primary key,
  action text not null,
  target_id uuid,
  actor uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint haccp_requests_action_check check (action in ('save', 'delete', 'add_file', 'delete_file', 'create_link', 'revoke_link'))
);

create table if not exists public.haccp_activity (
  id uuid primary key default gen_random_uuid(),
  who text not null default '',
  "text" text not null default '',
  "at" timestamptz not null default now(),
  table_id text,
  entry_id uuid,
  action text not null,
  actor uuid references auth.users(id) on delete set null
);

create index if not exists idx_haccp_activity_recent
  on public.haccp_activity ("at" desc);

-- ===========================================================================
-- 4. RLS and grants (anon has no direct access; managers read, RPCs write)
-- ===========================================================================

alter table public.haccp_entries enable row level security;
alter table public.haccp_files enable row level security;
alter table public.haccp_upload_links enable row level security;
alter table public.haccp_requests enable row level security;
alter table public.haccp_activity enable row level security;

create or replace function public.haccp_can_manage(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_actor is not null
    and (public.has_role(p_actor, 'owner') or public.kho_item_can_edit(p_actor));
$$;

revoke all on function public.haccp_can_manage(uuid) from public, anon;
grant execute on function public.haccp_can_manage(uuid) to authenticated, service_role;

drop policy if exists haccp_entries_select on public.haccp_entries;
create policy haccp_entries_select
  on public.haccp_entries
  for select
  to authenticated
  using (deleted_at is null and public.haccp_can_manage((select auth.uid())));

drop policy if exists haccp_files_select on public.haccp_files;
create policy haccp_files_select
  on public.haccp_files
  for select
  to authenticated
  using (deleted_at is null and public.haccp_can_manage((select auth.uid())));

drop policy if exists haccp_upload_links_select on public.haccp_upload_links;
create policy haccp_upload_links_select
  on public.haccp_upload_links
  for select
  to authenticated
  using (public.haccp_can_manage((select auth.uid())));

drop policy if exists haccp_activity_select on public.haccp_activity;
create policy haccp_activity_select
  on public.haccp_activity
  for select
  to authenticated
  using (public.haccp_can_manage((select auth.uid())));

revoke all on table public.haccp_entries from public, anon, authenticated;
revoke all on table public.haccp_files from public, anon, authenticated;
revoke all on table public.haccp_upload_links from public, anon, authenticated;
revoke all on table public.haccp_requests from public, anon, authenticated;
revoke all on table public.haccp_activity from public, anon, authenticated;

grant select on table public.haccp_entries to authenticated;
grant select on table public.haccp_files to authenticated;
grant select on table public.haccp_upload_links to authenticated;
grant select on table public.haccp_activity to authenticated;
grant all on table public.haccp_entries to service_role;
grant all on table public.haccp_files to service_role;
grant all on table public.haccp_upload_links to service_role;
grant all on table public.haccp_requests to service_role;
grant all on table public.haccp_activity to service_role;

-- ===========================================================================
-- 5. Private bucket for evidence
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'haccp-docs',
  'haccp-docs',
  false,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists haccp_docs_select on storage.objects;
create policy haccp_docs_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'haccp-docs'
    and public.haccp_can_manage((select auth.uid()))
    and name like 'haccp/%'
  );

drop policy if exists haccp_docs_insert on storage.objects;
create policy haccp_docs_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'haccp-docs'
    and public.haccp_can_manage((select auth.uid()))
    and name like 'haccp/%'
  );

drop policy if exists haccp_docs_delete on storage.objects;
create policy haccp_docs_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'haccp-docs'
    and public.haccp_can_manage((select auth.uid()))
    and name like 'haccp/%'
  );

-- ===========================================================================
-- 6. Value guards
-- ===========================================================================

create or replace function public.haccp_values_valid(p_table_id text, p_values jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_key text;
  v_value jsonb;
  v_limit integer;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    return false;
  end if;

  for v_key, v_value in select key, value from jsonb_each(p_values) loop
    if not (
      case p_table_id
        when 'suppliers' then v_key = any (array['name', 'items', 'phone', 'address', 'contact'])
        when 'team' then v_key = any (array['name', 'job', 'role'])
        when 'staff' then v_key = any (array['name', 'position', 'department'])
        when 'measure' then v_key = any (array['name', 'code', 'range', 'origin', 'qty', 'place', 'calibrated'])
        when 'machines' then v_key = any (array['name', 'symbol', 'qty', 'origin', 'spec', 'year', 'maintenance', 'note'])
        when 'chemicals' then v_key = any (array['name', 'place', 'purpose', 'guide'])
        when 'process' then v_key = any (array['step', 'owner', 'detail'])
        else false
      end
    ) then
      return false;
    end if;

    if jsonb_typeof(v_value) <> 'string' then
      return false;
    end if;

    v_limit := case
      when v_key = 'phone' then 40
      when v_key in ('name', 'items', 'address', 'contact', 'purpose', 'place', 'spec', 'note', 'detail', 'step', 'owner', 'job', 'role', 'position', 'department', 'code', 'range', 'origin', 'maintenance', 'calibrated', 'guide') then 1000
      else 200
    end;
    if length(v_value #>> '{}') > v_limit then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

revoke all on function public.haccp_values_valid(text, jsonb) from public, anon, authenticated;
grant execute on function public.haccp_values_valid(text, jsonb) to service_role;

create or replace function public.haccp_entries_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not public.haccp_values_valid(new.table_id, new."values") then
    raise exception 'invalid_values' using errcode = '22023';
  end if;
  new.entered_by_name := left(coalesce(btrim(new.entered_by_name), ''), 80);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists haccp_entries_guard on public.haccp_entries;
create trigger haccp_entries_guard
  before insert or update on public.haccp_entries
  for each row execute function public.haccp_entries_guard();

-- ===========================================================================
-- 7. Payload helpers
-- ===========================================================================

create or replace function public.haccp_file_payload(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', f.id,
    'entry_id', f.entry_id,
    'layout', f.layout,
    'name', f.file_name,
    'size', f.size_bytes,
    'type', f.mime_type,
    'path', f.storage_path,
    'uploaded_by', f.uploaded_by_name,
    'created_at', f.created_at
  )
  from public.haccp_files f
  where f.id = p_id;
$$;

revoke all on function public.haccp_file_payload(uuid) from public, anon, authenticated;
grant execute on function public.haccp_file_payload(uuid) to service_role;

create or replace function public.haccp_entry_payload(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', e.id,
    'table_id', e.table_id,
    'values', e."values",
    'position', e."position",
    'version', e.version,
    'by', e.entered_by_name,
    'source_key', e.source_key,
    'created_at', e.created_at,
    'updated_at', e.updated_at,
    'files', coalesce(
      (
        select jsonb_agg(public.haccp_file_payload(f.id) order by f.created_at, f.id)
        from public.haccp_files f
        where f.entry_id = e.id and f.deleted_at is null
      ),
      '[]'::jsonb
    )
  )
  from public.haccp_entries e
  where e.id = p_id;
$$;

revoke all on function public.haccp_entry_payload(uuid) from public, anon, authenticated;
grant execute on function public.haccp_entry_payload(uuid) to service_role;

create or replace function public.haccp_log(
  p_who text,
  p_text text,
  p_table_id text,
  p_entry_id uuid,
  p_action text,
  p_actor uuid
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.haccp_activity (who, "text", table_id, entry_id, action, actor)
  values (left(coalesce(p_who, ''), 80), left(coalesce(p_text, ''), 200), p_table_id, p_entry_id, p_action, p_actor);
$$;

revoke all on function public.haccp_log(text, text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.haccp_log(text, text, text, uuid, text, uuid) to service_role;

-- ===========================================================================
-- 8. Manager snapshot
-- ===========================================================================

create or replace function public.haccp_manager_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_entries jsonb;
  v_files jsonb;
  v_link jsonb;
  v_activity jsonb;
begin
  if not public.haccp_can_manage(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(public.haccp_entry_payload(e.id) order by e.table_id, e."position", e.created_at, e.id),
    '[]'::jsonb
  )
  into v_entries
  from public.haccp_entries e
  where e.deleted_at is null;

  select coalesce(
    jsonb_agg(public.haccp_file_payload(f.id) order by f.created_at, f.id),
    '[]'::jsonb
  )
  into v_files
  from public.haccp_files f
  where f.layout = true and f.deleted_at is null;

  select jsonb_build_object(
    'id', l.id,
    'days', l.days,
    'expires_at', l.expires_at,
    'revoked_at', l.revoked_at,
    'active', l.revoked_at is null and l.expires_at > now()
  )
  into v_link
  from public.haccp_upload_links l
  order by l.created_at desc, l.id desc
  limit 1;

  select coalesce(
    jsonb_agg(jsonb_build_object('id', a.id, 'who', a.who, 'text', a."text", 'at', a."at") order by a."at" desc),
    '[]'::jsonb
  )
  into v_activity
  from (
    select * from public.haccp_activity order by "at" desc limit 5
  ) a;

  return jsonb_build_object(
    'entries', v_entries,
    'files', v_files,
    'link', coalesce(v_link, 'null'::jsonb),
    'activity', v_activity
  );
end;
$$;

revoke all on function public.haccp_manager_snapshot() from public, anon;
grant execute on function public.haccp_manager_snapshot() to authenticated, service_role;

-- ===========================================================================
-- 9. Manager writes
-- ===========================================================================

create or replace function public.haccp_save_entry(
  p_id uuid default null,
  p_table_id text default null,
  p_values jsonb default '{}'::jsonb,
  p_entered_by_name text default '',
  p_version integer default null,
  p_request_id uuid default null,
  p_position integer default null,
  p_source_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid := p_id;
  v_action text;
  v_target uuid;
  v_label text;
  v_existing integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if not public.haccp_can_manage(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_table_id is null or p_table_id not in ('suppliers', 'team', 'staff', 'measure', 'machines', 'chemicals', 'process') then
    raise exception 'invalid_table_id' using errcode = '22023';
  end if;

  if not public.haccp_values_valid(p_table_id, p_values) then
    raise exception 'invalid_values' using errcode = '22023';
  end if;

  if p_source_key is not null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'invalid_source_key' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('haccp:' || p_request_id::text));
    select r.target_id, r.action into v_target, v_action
    from public.haccp_requests r
    where r.request_id = p_request_id;
    if found then
      if v_action <> 'save' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return coalesce(public.haccp_entry_payload(v_target), '{}'::jsonb) || jsonb_build_object('replayed', true);
    end if;
  end if;

  v_label := coalesce(
    nullif(btrim(p_values ->> 'name'), ''),
    nullif(btrim(p_values ->> 'step'), ''),
    nullif(btrim(p_values ->> 'code'), ''),
    'một dòng'
  );

  if v_id is null then
    insert into public.haccp_entries (
      table_id, "values", "position", source_key, entered_by_name, entered_by, version
    ) values (
      p_table_id,
      p_values,
      greatest(coalesce(
        p_position,
        (select coalesce(max(x."position"), 0) + 1 from public.haccp_entries x where x.table_id = p_table_id)
      ), 0),
      p_source_key,
      left(coalesce(p_entered_by_name, ''), 80),
      v_actor,
      1
    )
    returning id into v_id;
  else
    if p_version is null or p_version < 1 then
      raise exception 'invalid_version' using errcode = '22023';
    end if;

    update public.haccp_entries e
       set table_id = p_table_id,
           "values" = p_values,
           "position" = coalesce(p_position, e."position"),
           entered_by_name = left(coalesce(p_entered_by_name, e.entered_by_name), 80),
           version = e.version + 1,
           updated_at = now()
     where e.id = v_id
       and e.version = p_version
       and e.deleted_at is null
    returning e.id into v_id;

    if v_id is null then
      select count(*) into v_existing
      from public.haccp_entries e
      where e.id = p_id and e.deleted_at is null;
      if v_existing > 0 then
        raise exception 'stale_version' using errcode = '40001';
      end if;
      raise exception 'entry_not_found' using errcode = 'P0002';
    end if;
  end if;

  if p_request_id is not null then
    insert into public.haccp_requests (request_id, action, target_id, actor)
    values (p_request_id, 'save', v_id, v_actor)
    on conflict (request_id) do nothing;
  end if;

  perform public.haccp_log(
    coalesce(nullif(btrim(p_entered_by_name), ''), 'Quản lý'),
    'lưu “' || v_label || '”',
    p_table_id,
    v_id,
    'save',
    v_actor
  );

  return coalesce(public.haccp_entry_payload(v_id), '{}'::jsonb) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.haccp_save_entry(uuid, text, jsonb, text, integer, uuid, integer, text) from public, anon;
grant execute on function public.haccp_save_entry(uuid, text, jsonb, text, integer, uuid, integer, text) to authenticated, service_role;

create or replace function public.haccp_delete_entry(
  p_id uuid,
  p_version integer,
  p_request_id uuid default null,
  p_who text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_action text;
  v_target uuid;
  v_table text;
  v_label text;
  v_who text := coalesce(
    nullif(btrim(coalesce(p_who, '')), ''),
    (select nullif(btrim(pr.full_name), '') from public.profiles pr where pr.user_id = v_actor),
    'Quản lý'
  );
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if not public.haccp_can_manage(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_version is null or p_version < 1 then
    raise exception 'invalid_version' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('haccp:' || p_request_id::text));
    select r.target_id, r.action into v_target, v_action
    from public.haccp_requests r
    where r.request_id = p_request_id;
    if found then
      if v_action <> 'delete' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return coalesce(public.haccp_entry_payload(v_target), '{}'::jsonb) || jsonb_build_object('replayed', true);
    end if;
  end if;

  select e.table_id, coalesce(nullif(btrim(e."values" ->> 'name'), ''), nullif(btrim(e."values" ->> 'step'), ''), 'một dòng')
    into v_table, v_label
  from public.haccp_entries e
  where e.id = p_id;

  if v_table is null then
    raise exception 'entry_not_found' using errcode = 'P0002';
  end if;

  update public.haccp_entries e
     set deleted_at = coalesce(e.deleted_at, now()),
         deleted_by = coalesce(e.deleted_by, v_actor),
         version = case when e.deleted_at is null then e.version + 1 else e.version end
   where e.id = p_id
     and (e.deleted_at is not null or (p_version is not null and e.version = p_version));

  if not found and p_version is not null and exists (
    select 1 from public.haccp_entries e where e.id = p_id and e.deleted_at is null
  ) then
    raise exception 'stale_version' using errcode = '40001';
  end if;

  if p_request_id is not null then
    insert into public.haccp_requests (request_id, action, target_id, actor)
    values (p_request_id, 'delete', p_id, v_actor)
    on conflict (request_id) do nothing;
  end if;

  perform public.haccp_log(
    v_who,
    'xoá “' || v_label || '”',
    v_table,
    p_id,
    'delete',
    v_actor
  );

  return coalesce(public.haccp_entry_payload(p_id), '{}'::jsonb) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.haccp_delete_entry(uuid, integer, uuid, text) from public, anon;
grant execute on function public.haccp_delete_entry(uuid, integer, uuid, text) to authenticated, service_role;

create or replace function public.haccp_add_file(
  p_entry_id uuid,
  p_layout boolean,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_uploaded_by_name text default '',
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_action text;
  v_target uuid;
  v_id uuid;
  v_path text := btrim(coalesce(p_storage_path, ''));
  v_mime text := lower(btrim(coalesce(p_mime_type, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if not public.haccp_can_manage(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_layout is null or (p_layout and p_entry_id is not null) or (not p_layout and p_entry_id is null) then
    raise exception 'invalid_file_owner' using errcode = '22023';
  end if;

  if v_path not like 'haccp/%' or position('..' in v_path) > 0 then
    raise exception 'invalid_file_path' using errcode = '22023';
  end if;

  if v_mime not in (
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception 'unsupported_type' using errcode = '22023';
  end if;

  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 10485760 then
    raise exception 'invalid_file_size' using errcode = '22023';
  end if;

  if p_entry_id is not null and not exists (
    select 1 from public.haccp_entries e where e.id = p_entry_id and e.deleted_at is null
  ) then
    raise exception 'entry_not_found' using errcode = 'P0002';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('haccp:' || p_request_id::text));
    select r.target_id, r.action into v_target, v_action
    from public.haccp_requests r
    where r.request_id = p_request_id;
    if found then
      if v_action <> 'add_file' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return coalesce(public.haccp_file_payload(v_target), '{}'::jsonb) || jsonb_build_object('replayed', true);
    end if;
  end if;

  insert into public.haccp_files (
    entry_id, layout, storage_path, file_name, mime_type, size_bytes, uploaded_by_name, uploaded_by
  ) values (
    p_entry_id, p_layout, v_path, left(btrim(coalesce(p_file_name, '')), 255), v_mime,
    p_size_bytes, left(coalesce(p_uploaded_by_name, ''), 80), v_actor
  )
  on conflict (storage_path) do update
    set deleted_at = null,
        file_name = excluded.file_name,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes
  returning id into v_id;

  -- A new attachment changes the row contents too. Bumping the version makes a
  -- dialog opened before the upload fail with stale_version instead of deleting
  -- evidence it never saw.
  if p_entry_id is not null then
    update public.haccp_entries e
       set version = e.version + 1,
           updated_at = now()
     where e.id = p_entry_id
       and e.deleted_at is null;
  end if;

  if p_request_id is not null then
    insert into public.haccp_requests (request_id, action, target_id, actor)
    values (p_request_id, 'add_file', v_id, v_actor)
    on conflict (request_id) do nothing;
  end if;

  perform public.haccp_log(
    coalesce(nullif(btrim(p_uploaded_by_name), ''), 'Quản lý'),
    'thêm file “' || left(btrim(coalesce(p_file_name, '')), 120) || '”',
    null,
    p_entry_id,
    'add_file',
    v_actor
  );

  return coalesce(public.haccp_file_payload(v_id), '{}'::jsonb) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.haccp_add_file(uuid, boolean, text, text, text, bigint, text, uuid) from public, anon;
grant execute on function public.haccp_add_file(uuid, boolean, text, text, text, bigint, text, uuid) to authenticated, service_role;

create or replace function public.haccp_delete_file(
  p_file_id uuid,
  p_request_id uuid default null,
  p_who text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_action text;
  v_target uuid;
  v_file public.haccp_files%rowtype;
  v_who text := coalesce(
    nullif(btrim(coalesce(p_who, '')), ''),
    (select nullif(btrim(pr.full_name), '') from public.profiles pr where pr.user_id = v_actor),
    'Quản lý'
  );
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if not public.haccp_can_manage(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('haccp:' || p_request_id::text));
    select r.target_id, r.action into v_target, v_action
    from public.haccp_requests r
    where r.request_id = p_request_id;
    if found then
      if v_action <> 'delete_file' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return coalesce(public.haccp_file_payload(v_target), '{}'::jsonb) || jsonb_build_object('replayed', true);
    end if;
  end if;

  select * into v_file from public.haccp_files f where f.id = p_file_id;
  if not found then
    raise exception 'file_not_found' using errcode = 'P0002';
  end if;

  update public.haccp_files f
     set deleted_at = coalesce(f.deleted_at, now()),
         deleted_by = coalesce(f.deleted_by, v_actor)
   where f.id = p_file_id;

  if v_file.entry_id is not null and v_file.deleted_at is null then
    update public.haccp_entries e
       set version = e.version + 1,
           updated_at = now()
     where e.id = v_file.entry_id;
  end if;

  if p_request_id is not null then
    insert into public.haccp_requests (request_id, action, target_id, actor)
    values (p_request_id, 'delete_file', p_file_id, v_actor)
    on conflict (request_id) do nothing;
  end if;

  perform public.haccp_log(
    v_who,
    'xoá file “' || left(v_file.file_name, 120) || '”',
    null,
    v_file.entry_id,
    'delete_file',
    v_actor
  );

  return coalesce(public.haccp_file_payload(p_file_id), '{}'::jsonb) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.haccp_delete_file(uuid, uuid, text) from public, anon;
grant execute on function public.haccp_delete_file(uuid, uuid, text) to authenticated, service_role;

-- ===========================================================================
-- 10. Prefill from BMQ AI (managers only; never inserts a duplicate, never
--     overwrites a row a person has edited and never restores a deleted row)
-- ===========================================================================

create or replace function public.haccp_prefill(p_table_id text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_added integer := 0;
  v_count integer := 0;
begin
  if not public.haccp_can_manage(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_table_id = 'suppliers' then
    -- Receipts are booked to the central warehouse today, so a supplier of the
    -- Q7 kitchen is one whose receipt line resolves to a Q7 pastry item (or an
    -- older receipt booked straight to q7). Item names come from the kitchen
    -- catalogue, so spelling variants on delivery notes collapse into one.
    with lines as (
      select
        gr.supplier_id,
        coalesce(nullif(btrim(q7_item.name), ''), nullif(btrim(gri.product_name), '')) as label
      from public.goods_receipts gr
      join public.suppliers s on s.id = gr.supplier_id
      join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
      left join public.kitchen_inventory_items q7_item
        on q7_item.id = public.kho_receipt_line_item(gri.id)
      where gr.status in ('confirmed', 'received')
        and gr.receipt_date >= current_date - 180
        and (
          q7_item.pastry_q7 = true
          or coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') = 'q7'
        )
    ), names as (
      select distinct on (supplier_id, public.normalize_stock_item_name(label))
        supplier_id, label
      from lines
      where label is not null
      order by supplier_id, public.normalize_stock_item_name(label), label
    ), latest as (
      select
        s.id,
        s.name,
        s.phone,
        s.address,
        s.contact_name,
        string_agg(n.label, ', ' order by n.label) as items
      from public.suppliers s
      join names n on n.supplier_id = s.id
      group by s.id, s.name, s.phone, s.address, s.contact_name
    ), numbered as (
      select latest.*, row_number() over (order by name, id) as rn
      from latest
    ), base as (
      select coalesce(max(e."position"), 0) as last_position
      from public.haccp_entries e
      where e.table_id = 'suppliers'
    )
    insert into public.haccp_entries (table_id, "values", "position", source_key, entered_by_name)
    select
      'suppliers',
      jsonb_build_object(
        'name', left(coalesce(n.name, ''), 1000),
        'items', left(coalesce(n.items, ''), 1000),
        'phone', left(coalesce(n.phone, ''), 40),
        'address', left(coalesce(n.address, ''), 1000),
        'contact', left(coalesce(n.contact_name, ''), 1000)
      ),
      b.last_position + n.rn,
      'suppliers:' || n.id::text,
      'app'
    from numbered n
    cross join base b
    on conflict (source_key) do nothing;
    get diagnostics v_count = row_count;
    v_added := v_added + v_count;

  elsif p_table_id = 'staff' then
    with latest_period as (
      select p.id
      from public.payroll_bn_periods p
      order by p.date_to desc, p.period_code desc, p.id desc
      limit 1
    ), people as (
      select
        e.employee_code,
        e.employee_name,
        coalesce(nullif(btrim(e.group_name), ''), 'Bếp bánh') as department,
        row_number() over (order by e.employee_name, e.employee_code) as rn
      from public.payroll_bn_period_employees e
      join latest_period p on p.id = e.period_id
      where e.group_name = 'Bếp bánh'
    ), base as (
      select coalesce(max(x."position"), 0) as last_position
      from public.haccp_entries x
      where x.table_id = 'staff'
    )
    insert into public.haccp_entries (table_id, "values", "position", source_key, entered_by_name)
    select
      'staff',
      jsonb_build_object(
        'name', left(coalesce(p.employee_name, ''), 1000),
        'position', '',
        'department', left(coalesce(p.department, ''), 1000)
      ),
      b.last_position + p.rn,
      'staff:' || p.employee_code,
      'app'
    from people p
    cross join base b
    on conflict (source_key) do nothing;
    get diagnostics v_count = row_count;
    v_added := v_added + v_count;

  elsif p_table_id = 'chemicals' then
    with matched as (
      select
        kii.id,
        kii.name,
        row_number() over (order by kii.name, kii.id) as rn
      from public.kitchen_inventory_items kii
      where kii.active = true
        and kii.name ~* '(^|\s)(cồn|nước rửa|nước tẩy|nước lau|tẩy rửa|javel|cloramin|khử trùng|sát khuẩn|diệt khuẩn|xà phòng)'
    ), base as (
      select coalesce(max(x."position"), 0) as last_position
      from public.haccp_entries x
      where x.table_id = 'chemicals'
    )
    insert into public.haccp_entries (table_id, "values", "position", source_key, entered_by_name)
    select
      'chemicals',
      jsonb_build_object(
        'name', left(coalesce(m.name, ''), 1000),
        'place', '',
        'purpose', '',
        'guide', ''
      ),
      b.last_position + m.rn,
      'chemicals:' || m.id::text,
      'app'
    from matched m
    cross join base b
    on conflict (source_key) do nothing;
    get diagnostics v_count = row_count;
    v_added := v_added + v_count;

  else
    raise exception 'invalid_table_id' using errcode = '22023';
  end if;

  if v_added > 0 then
    perform public.haccp_log(
      coalesce((select nullif(btrim(p.full_name), '') from public.profiles p where p.user_id = v_actor), 'Quản lý'),
      'lấy ' || v_added || ' dòng từ BMQ AI',
      p_table_id,
      null,
      'prefill',
      v_actor
    );
  end if;

  return v_added;
end;
$$;

revoke all on function public.haccp_prefill(text) from public, anon;
grant execute on function public.haccp_prefill(text) to authenticated, service_role;

-- ===========================================================================
-- 11. Link lifecycle (manager creates/revokes; only the hash is stored)
-- ===========================================================================

create or replace function public.haccp_create_upload_link(
  p_days integer,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_action text;
  v_target uuid;
  v_token text;
  v_hash text;
  v_expires timestamptz;
  v_id uuid;
begin
  if not public.haccp_can_manage(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_days is null or p_days not in (7, 30, 90) then
    raise exception 'invalid_days' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('haccp:' || p_request_id::text));
    select r.target_id, r.action into v_target, v_action
    from public.haccp_requests r
    where r.request_id = p_request_id;
    if found then
      if v_action <> 'create_link' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return coalesce(
        (
          select jsonb_build_object(
            'link_id', l.id,
            'days', l.days,
            'expires_at', l.expires_at,
            'token', null,
            'token_available', false,
            'replayed', true
          )
          from public.haccp_upload_links l
          where l.id = v_target
        ),
        '{}'::jsonb
      );
    end if;
  end if;

  update public.haccp_upload_links l
     set revoked_at = coalesce(l.revoked_at, now()),
         revoked_by = coalesce(l.revoked_by, v_actor)
   where l.revoked_at is null and l.expires_at > now();

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex');
  v_expires := now() + make_interval(days => p_days);

  insert into public.haccp_upload_links (token_hash, days, expires_at, created_by, request_id)
  values (v_hash, p_days, v_expires, v_actor, p_request_id)
  returning id into v_id;

  if p_request_id is not null then
    insert into public.haccp_requests (request_id, action, target_id, actor)
    values (p_request_id, 'create_link', v_id, v_actor)
    on conflict (request_id) do nothing;
  end if;

  perform public.haccp_log(
    coalesce((select nullif(btrim(p.full_name), '') from public.profiles p where p.user_id = v_actor), 'Quản lý'),
    'tạo link nhân viên ' || p_days || ' ngày',
    null,
    null,
    'create_link',
    v_actor
  );

  return jsonb_build_object(
    'link_id', v_id,
    'days', p_days,
    'expires_at', v_expires,
    'token', v_token,
    'token_available', true,
    'replayed', false
  );
end;
$$;

revoke all on function public.haccp_create_upload_link(integer, uuid) from public, anon;
grant execute on function public.haccp_create_upload_link(integer, uuid) to authenticated, service_role;

create or replace function public.haccp_revoke_upload_link(p_request_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_action text;
  v_revoked integer := 0;
begin
  if not public.haccp_can_manage(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('haccp:' || p_request_id::text));
    select r.action into v_action
    from public.haccp_requests r
    where r.request_id = p_request_id;
    if found then
      if v_action <> 'revoke_link' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return jsonb_build_object('revoked', true, 'replayed', true);
    end if;
  end if;

  update public.haccp_upload_links l
     set revoked_at = now(),
         revoked_by = v_actor
   where l.revoked_at is null and l.expires_at > now();
  get diagnostics v_revoked = row_count;

  if p_request_id is not null then
    insert into public.haccp_requests (request_id, action, target_id, actor)
    values (p_request_id, 'revoke_link', null, v_actor)
    on conflict (request_id) do nothing;
  end if;

  perform public.haccp_log(
    coalesce((select nullif(btrim(p.full_name), '') from public.profiles p where p.user_id = v_actor), 'Quản lý'),
    'thu hồi link nhân viên',
    null,
    null,
    'revoke_link',
    v_actor
  );

  return jsonb_build_object('revoked', true, 'count', v_revoked, 'replayed', false);
end;
$$;

revoke all on function public.haccp_revoke_upload_link(uuid) from public, anon;
grant execute on function public.haccp_revoke_upload_link(uuid) to authenticated, service_role;

-- ===========================================================================
-- 12. Link-only RPCs (service_role only)
-- ===========================================================================

create or replace function public.haccp_link_access(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := lower(btrim(coalesce(p_token_hash, '')));
  v_link public.haccp_upload_links%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if v_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('state', 'missing');
  end if;

  select * into v_link from public.haccp_upload_links l where l.token_hash = v_hash;
  if not found then
    return jsonb_build_object('state', 'missing');
  end if;
  if v_link.revoked_at is not null then
    return jsonb_build_object('state', 'revoked', 'link_id', v_link.id);
  end if;
  if v_link.expires_at <= now() then
    return jsonb_build_object('state', 'expired', 'link_id', v_link.id);
  end if;

  update public.haccp_upload_links l
     set last_used_at = now()
   where l.id = v_link.id;

  return jsonb_build_object(
    'state', 'ok',
    'link_id', v_link.id,
    'days', v_link.days,
    'expires_at', v_link.expires_at
  );
end;
$$;

revoke all on function public.haccp_link_access(text) from public, anon, authenticated;
grant execute on function public.haccp_link_access(text) to service_role;

create or replace function public.haccp_link_require(p_token_hash text)
returns public.haccp_upload_links
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := lower(btrim(coalesce(p_token_hash, '')));
  v_link public.haccp_upload_links%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_link from public.haccp_upload_links l where l.token_hash = v_hash;
  if not found then
    raise exception 'link_invalid' using errcode = 'P0002';
  end if;
  if v_link.revoked_at is not null then
    raise exception 'link_revoked' using errcode = '22023';
  end if;
  if v_link.expires_at <= now() then
    raise exception 'link_expired' using errcode = '22023';
  end if;

  update public.haccp_upload_links l
     set last_used_at = now()
   where l.id = v_link.id;

  return v_link;
end;
$$;

revoke all on function public.haccp_link_require(text) from public, anon, authenticated;
grant execute on function public.haccp_link_require(text) to service_role;

create or replace function public.haccp_link_snapshot(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link public.haccp_upload_links%rowtype;
  v_entries jsonb;
  v_files jsonb;
  v_activity jsonb;
begin
  v_link := public.haccp_link_require(p_token_hash);

  select coalesce(
    jsonb_agg(public.haccp_entry_payload(e.id) order by e.table_id, e."position", e.created_at, e.id),
    '[]'::jsonb
  )
  into v_entries
  from public.haccp_entries e
  where e.deleted_at is null;

  select coalesce(
    jsonb_agg(public.haccp_file_payload(f.id) order by f.created_at, f.id),
    '[]'::jsonb
  )
  into v_files
  from public.haccp_files f
  where f.layout = true and f.deleted_at is null;

  select coalesce(
    jsonb_agg(jsonb_build_object('id', a.id, 'who', a.who, 'text', a."text", 'at', a."at") order by a."at" desc),
    '[]'::jsonb
  )
  into v_activity
  from (
    select * from public.haccp_activity order by "at" desc limit 5
  ) a;

  return jsonb_build_object(
    'entries', v_entries,
    'files', v_files,
    'link', jsonb_build_object(
      'id', v_link.id,
      'days', v_link.days,
      'expires_at', v_link.expires_at,
      'revoked_at', v_link.revoked_at,
      'active', true
    ),
    'activity', v_activity
  );
end;
$$;

revoke all on function public.haccp_link_snapshot(text) from public, anon, authenticated;
grant execute on function public.haccp_link_snapshot(text) to service_role;

create or replace function public.haccp_link_save_entry(
  p_token_hash text,
  p_id uuid default null,
  p_table_id text default null,
  p_values jsonb default '{}'::jsonb,
  p_who text default '',
  p_version integer default null,
  p_request_id uuid default null,
  p_position integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.haccp_link_require(p_token_hash);
  return public.haccp_save_entry(
    p_id, p_table_id, p_values, p_who, p_version, p_request_id, p_position, null
  );
end;
$$;

revoke all on function public.haccp_link_save_entry(text, uuid, text, jsonb, text, integer, uuid, integer) from public, anon, authenticated;
grant execute on function public.haccp_link_save_entry(text, uuid, text, jsonb, text, integer, uuid, integer) to service_role;

create or replace function public.haccp_link_delete_entry(
  p_token_hash text,
  p_id uuid,
  p_version integer,
  p_request_id uuid default null,
  p_who text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.haccp_link_require(p_token_hash);
  return public.haccp_delete_entry(p_id, p_version, p_request_id, p_who);
end;
$$;

revoke all on function public.haccp_link_delete_entry(text, uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.haccp_link_delete_entry(text, uuid, integer, uuid, text) to service_role;

create or replace function public.haccp_link_add_file(
  p_token_hash text,
  p_entry_id uuid,
  p_layout boolean,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_who text default '',
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.haccp_link_require(p_token_hash);
  return public.haccp_add_file(
    p_entry_id, p_layout, p_storage_path, p_file_name, p_mime_type, p_size_bytes, p_who, p_request_id
  );
end;
$$;

revoke all on function public.haccp_link_add_file(text, uuid, boolean, text, text, text, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.haccp_link_add_file(text, uuid, boolean, text, text, text, bigint, text, uuid) to service_role;

create or replace function public.haccp_link_delete_file(
  p_token_hash text,
  p_file_id uuid,
  p_request_id uuid default null,
  p_who text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.haccp_link_require(p_token_hash);
  return public.haccp_delete_file(p_file_id, p_request_id, p_who);
end;
$$;

revoke all on function public.haccp_link_delete_file(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.haccp_link_delete_file(text, uuid, uuid, text) to service_role;
