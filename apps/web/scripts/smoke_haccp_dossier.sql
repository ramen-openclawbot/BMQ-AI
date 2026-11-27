-- Rollback-only smoke test for 20261128100000_haccp_dossier.sql and
-- 20261128120000_haccp_prefill_q7_skus.sql.
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

-- Call the Q7/SKU prefill as a real owner, then prove a second press is a no-op.
-- The JWT claim settings and every inserted row are local to this transaction.
do $$
declare
  v_actor uuid;
  v_first integer;
  v_second integer;
begin
  select ur.user_id
    into v_actor
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.created_at, ur.id
  limit 1;

  if v_actor is null then
    raise notice 'HACCP smoke: no owner account, skipping prefill call';
    return;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_first := public.haccp_prefill('suppliers');
  v_second := public.haccp_prefill('suppliers');
  if v_second <> 0 then
    raise exception 'HACCP smoke: prefill suppliers duplicated % rows on the second call', v_second;
  end if;

  perform public.haccp_prefill('staff');
  perform public.haccp_prefill('chemicals');
  raise notice 'HACCP smoke: prefill suppliers first=%, repeat=%', v_first, v_second;
end $$;

-- Single-source supplier contact facts + link read-only + ATTP papers.
do $$
declare
  v_actor uuid;
  v_supplier_id uuid;
  v_supplier_name text;
  v_entry_id uuid;
  v_token text;
  v_hash text;
  v_payload jsonb;
begin
  select ur.user_id
    into v_actor
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.created_at, ur.id
  limit 1;

  if v_actor is null then
    raise notice 'HACCP smoke: no owner account, skipping supplier test';
    return;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select s.id, s.name
    into v_supplier_id, v_supplier_name
  from public.suppliers s
  where not exists (
    select 1 from public.haccp_entries e
    where e.source_key = 'suppliers:' || s.id::text
  )
  order by s.id
  limit 1;

  if v_supplier_id is null then
    raise notice 'HACCP smoke: every supplier already has a HACCP row, skipping supplier test';
    return;
  end if;

  insert into public.haccp_entries (table_id, "values", source_key, entered_by_name)
  values (
    'suppliers',
    jsonb_build_object(
      'name', 'Tên trong HACCP không được dùng',
      'items', 'Bột mì',
      'phone', '000',
      'address', 'Địa chỉ cũ',
      'contact', 'Người cũ'
    ),
    'suppliers:' || v_supplier_id::text,
    'app'
  )
  returning id into v_entry_id;

  perform public.haccp_save_entry(
    p_id => v_entry_id,
    p_table_id => 'suppliers',
    p_values => jsonb_build_object(
      'name', 'Tên trong HACCP không được dùng',
      'items', 'Bột mì',
      'phone', '0909 123 456',
      'address', 'Địa chỉ mới',
      'contact', 'Chị Lan'
    ),
    p_entered_by_name => 'Smoke',
    p_version => 1,
    p_request_id => gen_random_uuid(),
    p_position => null,
    p_source_key => null
  );

  if not exists (
    select 1 from public.suppliers s
    where s.id = v_supplier_id
      and s.name = v_supplier_name
      and s.phone = '0909 123 456'
      and s.address = 'Địa chỉ mới'
      and s.contact_name = 'Chị Lan'
  ) then
    raise exception 'HACCP smoke: manager save did not sync supplier phone/address/contact only';
  end if;

  v_payload := public.haccp_entry_payload(v_entry_id);
  if v_payload -> 'values' ->> 'items' <> 'Bột mì'
     or v_payload -> 'values' ->> 'name' <> v_supplier_name
     or v_payload ->> 'supplier_id' <> v_supplier_id::text then
    raise exception 'HACCP smoke: linked supplier payload is not single-source';
  end if;

  -- An items-only save must not overwrite a newer catalogue phone.
  update public.suppliers
     set phone = '0999 999 999'
   where id = v_supplier_id;
  perform public.haccp_save_entry(
    p_id => v_entry_id,
    p_table_id => 'suppliers',
    p_values => jsonb_build_object(
      'name', v_supplier_name,
      'items', 'Bột mì mới'
    ),
    p_entered_by_name => 'Smoke',
    p_version => (select version from public.haccp_entries where id = v_entry_id),
    p_request_id => gen_random_uuid(),
    p_position => null,
    p_source_key => null
  );
  if (select phone from public.suppliers where id = v_supplier_id) <> '0999 999 999' then
    raise exception 'HACCP smoke: items-only save overwrote a newer supplier phone';
  end if;

  -- A legacy catalogue phone over 40 chars must not block an items-only save
  -- and must not be written back truncated.
  update public.suppliers
     set phone = '0900 000 101 / 0900 000 102 / gặp chị Lan'
   where id = v_supplier_id;
  v_payload := public.haccp_entry_payload(v_entry_id);
  perform public.haccp_save_entry(
    p_id => v_entry_id,
    p_table_id => 'suppliers',
    p_values => jsonb_build_object(
      'name', v_supplier_name,
      'items', 'Bột mì 3',
      'phone', left(v_payload -> 'values' ->> 'phone', 40)
    ),
    p_entered_by_name => 'Smoke',
    p_version => (select version from public.haccp_entries where id = v_entry_id),
    p_request_id => gen_random_uuid(),
    p_position => null,
    p_source_key => null
  );
  if (select phone from public.suppliers where id = v_supplier_id)
     <> '0900 000 101 / 0900 000 102 / gặp chị Lan' then
    raise exception 'HACCP smoke: over-long catalogue phone was truncated on save';
  end if;

  -- A staff link can never save this row.
  v_payload := public.haccp_create_upload_link(7, gen_random_uuid());
  v_token := v_payload ->> 'token';
  v_hash := encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex');

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor, 'role', 'service_role')::text,
    true
  );

  begin
    perform public.haccp_link_save_entry(
      p_token_hash => v_hash,
      p_id => v_entry_id,
      p_table_id => 'suppliers',
      p_values => jsonb_build_object(
        'name', 'Link sửa',
        'items', 'Bột mì',
        'phone', '000',
        'address', 'x',
        'contact', 'x'
      ),
      p_who => 'Smoke link',
      p_version => 2,
      p_request_id => gen_random_uuid(),
      p_position => null
    );
    raise exception 'HACCP smoke: staff link saved a supplier row';
  exception
    when others then
      if sqlerrm not like '%supplier_read_only%' then
        raise;
      end if;
  end;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text,
    true
  );

  v_payload := public.haccp_supplier_papers();
  if jsonb_typeof(v_payload) <> 'array' then
    raise exception 'HACCP smoke: haccp_supplier_papers did not return an array';
  end if;
end $$;

rollback;

select 'HACCP SMOKE: PASS (rolled back)' as result;
