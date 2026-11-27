-- 2026-11-28 — HACCP suppliers: one source for contact facts.
--
-- A supplier row linked by source_key 'suppliers:<uuid>' now borrows name,
-- phone, address and contact from public.suppliers; only items stay in
-- haccp_entries. A manager save writes phone/address/contact_name back to
-- public.suppliers (never the name or another column). The staff link is
-- read-only for that table and cannot add or delete supplier files.
--
-- Also adds haccp_supplier_papers(), which reads kho_attp_checklist(180) and
-- returns current certificate metadata for each linked HACCP supplier row.

-- ===========================================================================
-- 1. Linked supplier payload
-- ===========================================================================

create or replace function public.haccp_entry_payload(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    jsonb_build_object(
      'id', e.id,
      'table_id', e.table_id,
      'values', case
        when s.id is not null then jsonb_build_object(
          'name', left(coalesce(s.name, ''), 1000),
          'items', coalesce(e."values" ->> 'items', ''),
          -- Contact facts come only from the catalogue (the backfill below copies
          -- earlier HACCP edits into blank catalogue columns first). Cap the
          -- display at the save limits so a long legacy value cannot block an
          -- items-only save.
          'phone', left(coalesce(btrim(s.phone), ''), 40),
          'address', left(coalesce(btrim(s.address), ''), 1000),
          'contact', left(coalesce(btrim(s.contact_name), ''), 120)
        )
        else e."values"
      end,
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
    || case
      when s.id is not null then jsonb_build_object('linked', true, 'supplier_id', s.id)
      else '{}'::jsonb
    end
  from public.haccp_entries e
  left join public.suppliers s
    on e.table_id = 'suppliers'
   and e.source_key = 'suppliers:' || s.id::text
  where e.id = p_id;
$$;

revoke all on function public.haccp_entry_payload(uuid) from public, anon, authenticated;
grant execute on function public.haccp_entry_payload(uuid) to service_role;

-- One-time, non-destructive backfill: fill only blank catalogue contact
-- columns from the HACCP row managers/staff edited before this switch.  A
-- non-blank catalogue value always wins; names and other columns are untouched.
update public.suppliers s
   set phone = coalesce(
         nullif(btrim(s.phone), ''),
         nullif(btrim(e."values" ->> 'phone'), '')
       ),
       address = coalesce(
         nullif(btrim(s.address), ''),
         nullif(btrim(e."values" ->> 'address'), '')
       ),
       contact_name = coalesce(
         nullif(btrim(s.contact_name), ''),
         -- suppliers_contact_name_length_check allows 120 characters.
         case when length(btrim(e."values" ->> 'contact')) <= 120
              then nullif(btrim(e."values" ->> 'contact'), '') end
       )
  from public.haccp_entries e
 where e.table_id = 'suppliers'
   and e.deleted_at is null
   and e.source_key = 'suppliers:' || s.id::text
   and (
     nullif(btrim(s.phone), '') is null
     or nullif(btrim(s.address), '') is null
     or nullif(btrim(s.contact_name), '') is null
   );

-- ===========================================================================
-- 2. Manager save writes the three contact columns back to the catalogue
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
  v_source_key text;
  v_prev_values jsonb;
  v_store_values jsonb := p_values;
  v_supplier_id uuid;
  v_supplier_name text;
  v_new_phone text;
  v_new_address text;
  v_new_contact text;
  v_phone_requested boolean := false;
  v_address_requested boolean := false;
  v_contact_requested boolean := false;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    -- The public staff link is never allowed to save a supplier row, even if
    -- it tries to rename the table while keeping the same id.
    if p_table_id = 'suppliers'
       or (
         p_id is not null
         and exists (
           select 1 from public.haccp_entries e
           where e.id = p_id and e.table_id = 'suppliers'
         )
       ) then
      raise exception 'supplier_read_only' using errcode = '42501';
    end if;
  elsif not public.haccp_can_manage(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
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

  -- A linked supplier row owns only its items; the contact facts belong to the
  -- catalogue. Update phone/address/contact_name before the HACCP row so both
  -- write or both roll back.
  if v_id is not null and p_table_id = 'suppliers' then
    select e.source_key, e."values"
      into v_source_key, v_prev_values
    from public.haccp_entries e
    where e.id = v_id and e.deleted_at is null;

    -- The dialog sends only contact fields that differ from what it displayed.
    -- Merge the rest back so items-only saves keep the stored contact snapshot.
    if v_source_key like 'suppliers:%' then
      v_store_values := coalesce(v_prev_values, '{}'::jsonb) || p_values;
      begin
        v_supplier_id := substring(v_source_key from 11)::uuid;
      exception
        when invalid_text_representation then
          v_supplier_id := null;
      end;
    end if;

    if v_supplier_id is not null
       and not exists (select 1 from public.suppliers x where x.id = v_supplier_id) then
      v_supplier_id := null;
    end if;

    if v_supplier_id is not null then
      -- The client sends only fields changed from the values it displayed.
      -- Presence therefore means a deliberate edit; items-only saves omit the
      -- contact keys and cannot overwrite a newer supplier-page value.
      v_phone_requested := p_values ? 'phone';
      v_address_requested := p_values ? 'address';
      v_contact_requested := p_values ? 'contact';

      if (v_phone_requested or v_address_requested or v_contact_requested)
         and not (
           public.has_role(v_actor, 'owner')
           or public.has_role(v_actor, 'staff')
           or public.has_role(v_actor, 'warehouse')
         ) then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;

      v_new_phone := nullif(left(btrim(coalesce(p_values ->> 'phone', '')), 40), '');
      v_new_address := nullif(left(btrim(coalesce(p_values ->> 'address', '')), 1000), '');
      if length(btrim(coalesce(p_values ->> 'contact', ''))) > 120 then
        raise exception 'invalid_values' using errcode = '22023', detail = 'contact_max_120';
      end if;
      v_new_contact := nullif(btrim(coalesce(p_values ->> 'contact', '')), '');

      update public.suppliers s
         set phone = case
               when v_phone_requested
                 and not (
                   length(btrim(coalesce(s.phone, ''))) > 40
                   and (p_values ->> 'phone') = left(btrim(s.phone), 40)
                 )
                 then v_new_phone
               else s.phone
             end,
             address = case
               when v_address_requested
                 and not (
                   length(btrim(coalesce(s.address, ''))) > 1000
                   and (p_values ->> 'address') = left(btrim(s.address), 1000)
                 )
                 then v_new_address
               else s.address
             end,
             contact_name = case
               when v_contact_requested
                 and not (
                   length(btrim(coalesce(s.contact_name, ''))) > 120
                   and (p_values ->> 'contact') = left(btrim(s.contact_name), 120)
                 )
                 then v_new_contact
               else s.contact_name
             end
       where s.id = v_supplier_id
         and (
           (
             v_phone_requested
             and s.phone is distinct from v_new_phone
             -- A long catalogue value is shown truncated in HACCP; saving that
             -- unchanged display must not write the truncated value back.
             and not (
               length(btrim(coalesce(s.phone, ''))) > 40
               and (p_values ->> 'phone') = left(btrim(s.phone), 40)
             )
           )
           or (
             v_address_requested
             and s.address is distinct from v_new_address
             and not (
               length(btrim(coalesce(s.address, ''))) > 1000
               and (p_values ->> 'address') = left(btrim(s.address), 1000)
             )
           )
           or (
             v_contact_requested
             and s.contact_name is distinct from v_new_contact
             and not (
               length(btrim(coalesce(s.contact_name, ''))) > 120
               and (p_values ->> 'contact') = left(btrim(s.contact_name), 120)
             )
           )
         )
       returning s.name into v_supplier_name;

      if v_supplier_name is not null then
        perform public.haccp_log(
          coalesce(nullif(btrim(p_entered_by_name), ''), 'Quản lý'),
          'cập nhật danh mục NCC “' || left(v_supplier_name, 120) || '”',
          'suppliers',
          v_id,
          'save',
          v_actor
        );
      end if;
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
      v_store_values,
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
           "values" = v_store_values,
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

-- ===========================================================================
-- 3. Supplier rows cannot receive a new attachment
-- ===========================================================================

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

  -- Only catalogue-linked supplier rows are read-only; a manually added
  -- supplier row (for example a transport provider) may still hold evidence.
  if p_entry_id is not null and exists (
    select 1 from public.haccp_entries e
    where e.id = p_entry_id
      and e.table_id = 'suppliers'
      and exists (
        select 1 from public.suppliers s
        where e.source_key = 'suppliers:' || s.id::text
      )
  ) then
    raise exception 'supplier_papers_in_attp' using errcode = '22023';
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

-- ===========================================================================
-- 4. Link wrappers reject every supplier row for that table
-- ===========================================================================

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
  if p_table_id = 'suppliers'
     or (
       p_id is not null
       and exists (
         select 1 from public.haccp_entries e
         where e.id = p_id and e.table_id = 'suppliers'
       )
     ) then
    raise exception 'supplier_read_only' using errcode = '42501';
  end if;
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
  if exists (
    select 1 from public.haccp_entries e
    where e.id = p_id and e.table_id = 'suppliers'
  ) then
    raise exception 'supplier_read_only' using errcode = '42501';
  end if;
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
  if p_entry_id is not null and exists (
    select 1 from public.haccp_entries e
    where e.id = p_entry_id and e.table_id = 'suppliers'
  ) then
    raise exception 'supplier_read_only' using errcode = '42501';
  end if;
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
  if exists (
    select 1
    from public.haccp_files f
    join public.haccp_entries e on e.id = f.entry_id
    where f.id = p_file_id and e.table_id = 'suppliers'
  ) then
    raise exception 'supplier_read_only' using errcode = '42501';
  end if;
  return public.haccp_delete_file(p_file_id, p_request_id, p_who);
end;
$$;

revoke all on function public.haccp_link_delete_file(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.haccp_link_delete_file(text, uuid, uuid, text) to service_role;

-- ===========================================================================
-- 5. Current ATTP papers per linked supplier row
-- ===========================================================================

create or replace function public.haccp_supplier_papers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_check jsonb;
  v_result jsonb;
begin
  if not public.haccp_can_manage(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_check := public.kho_attp_checklist(180);

  with linked_entries as (
    select e.id as entry_id, s.id as supplier_id, s.name as supplier_name
    from public.haccp_entries e
    join public.suppliers s on e.source_key = 'suppliers:' || s.id::text
    where e.table_id = 'suppliers'
      and e.deleted_at is null
  ), totals as (
    select
      (x ->> 'supplier_id')::uuid as supplier_id,
      coalesce((x -> 'totals' ->> 'done')::integer, 0) as done,
      coalesce((x -> 'totals' ->> 'total')::integer, 0) as total,
      coalesce((x -> 'totals' ->> 'pct')::integer, 0) as pct,
      x as payload
    from jsonb_array_elements(coalesce(v_check -> 'suppliers', '[]'::jsonb)) x
  ), supplier_certs as (
    select distinct
      t.supplier_id,
      (r ->> 'cert_id')::uuid as cert_id
    from totals t
    cross join lateral jsonb_array_elements(coalesce(t.payload -> 'items', '[]'::jsonb)) as item(value)
    cross join lateral jsonb_array_elements(coalesce(item.value -> 'requirements', '[]'::jsonb)) as r(value)
    where r.value ->> 'cert_id' is not null
      and r.value ->> 'state' in ('ok', 'warn')
  ), vault_certs as (
    -- The checklist only covers items that need a paper.  Supplier-level
    -- certificates in the vault are still current evidence even when the
    -- supplier has no recent receipt or all of its items have profile 'none'.
    select c.supplier_id, c.id as cert_id
    from public.food_safety_certificates c
    where c.archived_at is null
      and c.owner_kind = 'supplier'
      and c.supplier_id is not null
      and c.review_status = 'confirmed'
      and (c.expires_on is null or c.expires_on >= current_date)
  ), cert_ids as (
    select supplier_id, cert_id from supplier_certs
    union
    select supplier_id, cert_id from vault_certs
  ), cert_docs as (
    select
      ci.supplier_id,
      c.id,
      c.cert_type,
      c.cert_no,
      c.expires_on,
      c.file_path,
      c.file_name,
      c.mime_type
    from cert_ids ci
    join public.food_safety_certificates c on c.id = ci.cert_id
    where c.archived_at is null
  ), papers as (
    select
      d.supplier_id,
      jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'cert_type', d.cert_type,
          'cert_no', d.cert_no,
          'expires_on', d.expires_on,
          'file_path', d.file_path,
          'file_name', d.file_name,
          'mime_type', d.mime_type
        )
        order by d.expires_on nulls last, d.id
      ) as paper_list
    from cert_docs d
    group by d.supplier_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'entry_id', le.entry_id,
        'supplier_id', le.supplier_id,
        'supplier_name', le.supplier_name,
        'done', coalesce(t.done, 0),
        'total', coalesce(t.total, 0),
        'pct', coalesce(t.pct, 0),
        'papers', coalesce(p.paper_list, '[]'::jsonb)
      )
      order by le.supplier_name, le.entry_id
    ),
    '[]'::jsonb
  )
  into v_result
  from linked_entries le
  left join totals t on t.supplier_id = le.supplier_id
  left join papers p on p.supplier_id = le.supplier_id;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.haccp_supplier_papers() from public, anon;
grant execute on function public.haccp_supplier_papers() to authenticated, service_role;
