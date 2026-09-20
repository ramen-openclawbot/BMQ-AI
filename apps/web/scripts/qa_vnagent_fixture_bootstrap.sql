-- VNAgent generation — isolated PostgreSQL QA bootstrap.
--
-- This recreates the minimal Supabase-shaped objects the migrations depend on:
--   * `auth.users` + `auth.uid()` (reads request.jwt.claim.sub)
--   * the `app_role` enum and `public.has_role(uuid, app_role)`
--
-- Fixture identities (documented so a fresh test DB is reproducible):
--   * OWNER = 00000000-0000-4000-8000-000000000001  -> has_role(., 'owner') = true
--   * STAFF = 00000000-0000-4000-8000-000000000002  -> never owner
-- The cluster-level roles anon/authenticated/service_role are created by the
-- container image; the migrations grant to them.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type app_role as enum ('owner', 'staff');
  end if;
end;
$$;

create or replace function auth.uid() returns uuid
language sql
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- Deterministic QA role lookup: only the fixture owner is an owner.
create or replace function public.has_role(p_user uuid, p_role app_role) returns boolean
language sql
as $$
  select p_user = '00000000-0000-4000-8000-000000000001'::uuid and p_role = 'owner'
$$;
