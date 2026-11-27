-- Rollback-only smoke test for 20261128100000_haccp_dossier.sql.
-- Run after the migration is applied to a disposable/local database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/smoke_haccp_dossier.sql
-- Every write is rolled back; no production row is created or changed.

\set ON_ERROR_STOP on

begin;

do $$
begin
  if to_regclass('public.haccp_entries') is null
     or to_regclass('public.haccp_files') is null
     or to_regclass('public.haccp_upload_links') is null
     or to_regclass('public.haccp_requests') is null
     or to_regclass('public.haccp_activity') is null then
    raise exception 'HACCP smoke: missing table';
  end if;

  if to_regprocedure('public.haccp_manager_snapshot()') is null
     or to_regprocedure('public.haccp_prefill(text)') is null
     or to_regprocedure('public.haccp_save_entry(uuid,text,jsonb,text,integer,uuid,integer,text)') is null
     or to_regprocedure('public.haccp_delete_entry(uuid,integer,uuid,text)') is null
     or to_regprocedure('public.haccp_delete_file(uuid,uuid,text)') is null
     or to_regprocedure('public.haccp_add_file(uuid,boolean,text,text,text,bigint,text,uuid)') is null
     or to_regprocedure('public.haccp_create_upload_link(integer,uuid)') is null
     or to_regprocedure('public.haccp_link_snapshot(text)') is null then
    raise exception 'HACCP smoke: missing RPC';
  end if;

  if not exists (
    select 1 from storage.buckets where id = 'haccp-docs' and public = false
  ) then
    raise exception 'HACCP smoke: haccp-docs bucket must exist and be private';
  end if;
end $$;

do $$
declare
  v_id uuid;
  v_file_id uuid;
  v_hash text := repeat('a', 64);
begin
  insert into public.haccp_entries (table_id, "values", "position", source_key, entered_by_name)
  values (
    'suppliers',
    jsonb_build_object('name', 'Smoke NCC', 'items', 'Bột', 'phone', '0900', 'address', 'Q7', 'contact', 'Lan'),
    1,
    'smoke:supplier',
    'Smoke'
  )
  returning id into v_id;

  -- Unknown keys are rejected by the guard trigger.
  begin
    insert into public.haccp_entries (table_id, "values")
    values ('suppliers', jsonb_build_object('salary', '10000000'));
    raise exception 'HACCP smoke: unknown value key was accepted';
  exception
    when sqlstate '22023' then null;
  end;

  -- A source_key cannot be inserted twice.
  begin
    insert into public.haccp_entries (table_id, "values", source_key)
    values ('suppliers', jsonb_build_object('name', 'Smoke 2'), 'smoke:supplier');
    raise exception 'HACCP smoke: duplicate source_key was accepted';
  exception
    when unique_violation then null;
  end;

  -- Soft delete must not allow the same app row to be restored/duplicated.
  update public.haccp_entries
     set deleted_at = now()
   where id = v_id;
  begin
    insert into public.haccp_entries (table_id, "values", source_key)
    values ('suppliers', jsonb_build_object('name', 'Smoke 3'), 'smoke:supplier');
    raise exception 'HACCP smoke: deleted source_key was reused';
  exception
    when unique_violation then null;
  end;

  -- A file belongs to exactly one entry, or to the layout section.
  begin
    insert into public.haccp_files (entry_id, layout, storage_path, file_name, mime_type, size_bytes)
    values (v_id, true, 'haccp/smoke/bad.pdf', 'bad.pdf', 'application/pdf', 10);
    raise exception 'HACCP smoke: file owner check was not enforced';
  exception
    when check_violation then null;
  end;

  insert into public.haccp_files (entry_id, layout, storage_path, file_name, mime_type, size_bytes)
  values (v_id, false, 'haccp/smoke/ok.pdf', 'ok.pdf', 'application/pdf', 10)
  returning id into v_file_id;

  -- Link tokens are hash-only, 7/30/90 days and revocable.
  begin
    insert into public.haccp_upload_links (token_hash, days, expires_at)
    values ('short', 7, now() + interval '7 days');
    raise exception 'HACCP smoke: short token hash was accepted';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.haccp_upload_links (token_hash, days, expires_at)
    values (v_hash, 12, now() + interval '12 days');
    raise exception 'HACCP smoke: invalid link lifetime was accepted';
  exception
    when check_violation then null;
  end;

  insert into public.haccp_upload_links (token_hash, days, expires_at)
  values (v_hash, 30, now() + interval '30 days');

  update public.haccp_upload_links
     set revoked_at = now()
   where token_hash = v_hash;

  if not exists (
    select 1 from public.haccp_upload_links
    where token_hash = v_hash and revoked_at is not null
  ) then
    raise exception 'HACCP smoke: link revocation failed';
  end if;
end $$;

rollback;

select 'HACCP SMOKE: PASS (rolled back)' as result;
