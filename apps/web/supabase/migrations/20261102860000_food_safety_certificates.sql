-- 2026-10-23 — Kho giấy chứng nhận ATTP.
--
-- A private certificate vault for manufacturers, kho items, suppliers and the
-- company itself.  Files live in the private bucket 'food-safety-docs' under
-- 'certs/<uuid>/<filename>'.  Every write goes through these SECURITY DEFINER
-- RPCs; the table and bucket have no client write policy.
--
-- Nothing here touches ledger posting.

-- ===========================================================================
-- 1. Certificate table
-- ===========================================================================

create table if not exists public.food_safety_certificates (
  id uuid primary key default gen_random_uuid(),
  owner_kind text not null,
  manufacturer_id uuid references public.food_manufacturers(id) on delete restrict,
  item_id uuid references public.kitchen_inventory_items(id) on delete restrict,
  supplier_id uuid references public.suppliers(id) on delete restrict,
  cert_type text not null,
  cert_no text,
  issuer text,
  issued_on date,
  expires_on date,
  file_path text not null,
  file_name text,
  mime_type text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,
  constraint food_safety_certificates_owner_kind_check
    check (owner_kind in ('manufacturer', 'item', 'supplier', 'company')),
  constraint food_safety_certificates_cert_type_check
    check (cert_type in ('attp_facility', 'coa', 'product_declaration', 'other')),
  constraint food_safety_certificates_owner_check check (
    (owner_kind = 'manufacturer'
      and manufacturer_id is not null and item_id is null and supplier_id is null)
    or (owner_kind = 'item'
      and item_id is not null and manufacturer_id is null and supplier_id is null)
    or (owner_kind = 'supplier'
      and supplier_id is not null and manufacturer_id is null and item_id is null)
    or (owner_kind = 'company'
      and manufacturer_id is null and item_id is null and supplier_id is null)
  ),
  constraint food_safety_certificates_expiry_check
    check (expires_on is null or issued_on is null or expires_on >= issued_on)
);

create index if not exists idx_food_safety_certificates_owner
  on public.food_safety_certificates (owner_kind, manufacturer_id, item_id, supplier_id);

create index if not exists idx_food_safety_certificates_expires
  on public.food_safety_certificates (expires_on)
  where archived_at is null;

alter table public.food_safety_certificates enable row level security;

drop policy if exists food_safety_certificates_select on public.food_safety_certificates;
create policy food_safety_certificates_select
  on public.food_safety_certificates
  for select
  to authenticated
  using (public.kho_lot_can_view((select auth.uid())));

revoke all on table public.food_safety_certificates from public, anon, authenticated;
grant select on table public.food_safety_certificates to authenticated;
grant all on table public.food_safety_certificates to service_role;

-- ===========================================================================
-- 2. Idempotency ledger (server-only)
-- ===========================================================================

create table if not exists public.food_cert_requests (
  request_id uuid primary key,
  cert_id uuid not null references public.food_safety_certificates(id) on delete cascade,
  action text not null check (action in ('upsert', 'archive')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.food_cert_requests enable row level security;
revoke all on table public.food_cert_requests from public, anon, authenticated;
grant all on table public.food_cert_requests to service_role;

create index if not exists idx_food_cert_requests_cert
  on public.food_cert_requests (cert_id);

-- ===========================================================================
-- 3. Private bucket + object policies
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'food-safety-docs',
  'food-safety-docs',
  false,
  20971520,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists food_safety_docs_select on storage.objects;
create policy food_safety_docs_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'food-safety-docs'
    and public.kho_item_can_edit((select auth.uid()))
    and name like 'certs/%'
  );

drop policy if exists food_safety_docs_insert on storage.objects;
create policy food_safety_docs_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'food-safety-docs'
    and public.kho_item_can_edit((select auth.uid()))
    and name like 'certs/%'
  );

-- ===========================================================================
-- 4. One certificate payload (owner display name + days_left)
-- ===========================================================================

create or replace function public.food_cert_payload(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', c.id,
    'owner_kind', c.owner_kind,
    'owner_id', coalesce(c.manufacturer_id, c.item_id, c.supplier_id),
    'owner_name', case c.owner_kind
      when 'manufacturer' then fm.name
      when 'item' then kii.name
      when 'supplier' then s.name
      when 'company' then 'Công ty'
      else null
    end,
    'cert_type', c.cert_type,
    'cert_no', c.cert_no,
    'issuer', c.issuer,
    'issued_on', c.issued_on,
    'expires_on', c.expires_on,
    'days_left', case
      when c.expires_on is null then null
      else (c.expires_on - current_date)::integer
    end,
    'file_path', c.file_path,
    'file_name', c.file_name,
    'mime_type', c.mime_type,
    'note', c.note,
    'created_by', c.created_by,
    'created_at', c.created_at,
    'archived_at', c.archived_at,
    'archived_by', c.archived_by
  )
  from public.food_safety_certificates c
  left join public.food_manufacturers fm on fm.id = c.manufacturer_id
  left join public.kitchen_inventory_items kii on kii.id = c.item_id
  left join public.suppliers s on s.id = c.supplier_id
  where c.id = p_id;
$$;

revoke all on function public.food_cert_payload(uuid) from public, anon, authenticated;
grant execute on function public.food_cert_payload(uuid) to service_role;

-- ===========================================================================
-- 5. food_cert_upsert
-- ===========================================================================

create or replace function public.food_cert_upsert(
  p_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_cert_type text,
  p_cert_no text,
  p_issuer text,
  p_issued_on date,
  p_expires_on date,
  p_file_path text,
  p_file_name text,
  p_mime_type text,
  p_note text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cert_id uuid := p_id;
  v_manufacturer_id uuid;
  v_item_id uuid;
  v_supplier_id uuid;
  v_file_path text := nullif(btrim(coalesce(p_file_path, '')), '');
  v_request_cert_id uuid;
  v_request_action text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_owner_kind is null
     or p_owner_kind not in ('manufacturer', 'item', 'supplier', 'company') then
    raise exception 'invalid_owner_kind' using errcode = '22023';
  end if;

  if p_cert_type is null
     or p_cert_type not in ('attp_facility', 'coa', 'product_declaration', 'other') then
    raise exception 'invalid_cert_type' using errcode = '22023';
  end if;

  if p_owner_kind = 'manufacturer' then
    if p_owner_id is null or not exists (
      select 1 from public.food_manufacturers fm where fm.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_manufacturer_id := p_owner_id;
  elsif p_owner_kind = 'item' then
    if p_owner_id is null or not exists (
      select 1 from public.kitchen_inventory_items kii where kii.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_item_id := p_owner_id;
  elsif p_owner_kind = 'supplier' then
    if p_owner_id is null or not exists (
      select 1 from public.suppliers s where s.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_supplier_id := p_owner_id;
  elsif p_owner_id is not null then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;

  if v_file_path is null then
    raise exception 'file_required' using errcode = '22023';
  end if;

  if v_file_path not like 'certs/%' or position('..' in v_file_path) > 0 then
    raise exception 'invalid_file_path' using errcode = '22023';
  end if;

  if p_issued_on is not null and p_expires_on is not null and p_expires_on < p_issued_on then
    raise exception 'invalid_expiry_date' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('food_cert:' || p_request_id::text));

    select r.cert_id, r.action
      into v_request_cert_id, v_request_action
      from public.food_cert_requests r
     where r.request_id = p_request_id;

    if v_request_cert_id is not null then
      if v_request_action <> 'upsert' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return public.food_cert_payload(v_request_cert_id) || jsonb_build_object('replayed', true);
    end if;
  end if;

  if p_id is null then
    insert into public.food_safety_certificates (
      owner_kind, manufacturer_id, item_id, supplier_id,
      cert_type, cert_no, issuer, issued_on, expires_on,
      file_path, file_name, mime_type, note, created_by
    ) values (
      p_owner_kind, v_manufacturer_id, v_item_id, v_supplier_id,
      p_cert_type, nullif(btrim(coalesce(p_cert_no, '')), ''),
      nullif(btrim(coalesce(p_issuer, '')), ''),
      p_issued_on, p_expires_on,
      v_file_path, nullif(btrim(coalesce(p_file_name, '')), ''),
      nullif(btrim(coalesce(p_mime_type, '')), ''),
      nullif(btrim(coalesce(p_note, '')), ''), v_actor
    )
    returning id into v_cert_id;
  else
    update public.food_safety_certificates c
       set owner_kind = p_owner_kind,
           manufacturer_id = v_manufacturer_id,
           item_id = v_item_id,
           supplier_id = v_supplier_id,
           cert_type = p_cert_type,
           cert_no = nullif(btrim(coalesce(p_cert_no, '')), ''),
           issuer = nullif(btrim(coalesce(p_issuer, '')), ''),
           issued_on = p_issued_on,
           expires_on = p_expires_on,
           file_path = v_file_path,
           file_name = nullif(btrim(coalesce(p_file_name, '')), ''),
           mime_type = nullif(btrim(coalesce(p_mime_type, '')), ''),
           note = nullif(btrim(coalesce(p_note, '')), '')
     where c.id = p_id
       and c.archived_at is null;

    if not found then
      raise exception 'cert_not_found' using errcode = 'P0002';
    end if;
  end if;

  if p_request_id is not null then
    insert into public.food_cert_requests (request_id, cert_id, action, created_by)
    values (p_request_id, v_cert_id, 'upsert', v_actor)
    on conflict (request_id) do nothing;
  end if;

  return public.food_cert_payload(v_cert_id) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.food_cert_upsert(uuid, text, uuid, text, text, text, date, date, text, text, text, text, uuid) from public, anon;
grant execute on function public.food_cert_upsert(uuid, text, uuid, text, text, text, date, date, text, text, text, text, uuid) to authenticated, service_role;

-- ===========================================================================
-- 6. food_cert_archive
-- ===========================================================================

create or replace function public.food_cert_archive(
  p_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_request_cert_id uuid;
  v_request_action text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('food_cert:' || p_request_id::text));

    select r.cert_id, r.action
      into v_request_cert_id, v_request_action
      from public.food_cert_requests r
     where r.request_id = p_request_id;

    if v_request_cert_id is not null then
      if v_request_action <> 'archive' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return public.food_cert_payload(v_request_cert_id) || jsonb_build_object('replayed', true);
    end if;
  end if;

  update public.food_safety_certificates c
     set archived_at = coalesce(c.archived_at, now()),
         archived_by = coalesce(c.archived_by, v_actor)
   where c.id = p_id;

  if not found then
    raise exception 'cert_not_found' using errcode = 'P0002';
  end if;

  if p_request_id is not null then
    insert into public.food_cert_requests (request_id, cert_id, action, created_by)
    values (p_request_id, p_id, 'archive', v_actor)
    on conflict (request_id) do nothing;
  end if;

  return public.food_cert_payload(p_id) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.food_cert_archive(uuid, uuid) from public, anon;
grant execute on function public.food_cert_archive(uuid, uuid) to authenticated, service_role;

-- ===========================================================================
-- 7. food_cert_list
-- ===========================================================================

create or replace function public.food_cert_list(
  p_owner_kind text default null,
  p_owner_id uuid default null,
  p_expiring_days integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_lot_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_owner_kind is not null
     and p_owner_kind not in ('manufacturer', 'item', 'supplier', 'company') then
    raise exception 'invalid_owner_kind' using errcode = '22023';
  end if;

  if p_expiring_days is not null and (p_expiring_days < 0 or p_expiring_days > 3650) then
    raise exception 'invalid_expiring_days' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(
           public.food_cert_payload(c.id)
           order by c.created_at desc, c.id desc
         ), '[]'::jsonb)
    into v_result
    from public.food_safety_certificates c
   where c.archived_at is null
     and (p_owner_kind is null or c.owner_kind = p_owner_kind)
     and (
       p_owner_id is null
       or (c.owner_kind = 'manufacturer' and c.manufacturer_id = p_owner_id)
       or (c.owner_kind = 'item' and c.item_id = p_owner_id)
       or (c.owner_kind = 'supplier' and c.supplier_id = p_owner_id)
     )
     and (
       p_expiring_days is null
       or (c.expires_on is not null and c.expires_on <= current_date + p_expiring_days)
     );

  return v_result;
end;
$$;

revoke all on function public.food_cert_list(text, uuid, integer) from public, anon;
grant execute on function public.food_cert_list(text, uuid, integer) to authenticated, service_role;

-- ===========================================================================
-- 8. food_manufacturer_list
-- ===========================================================================

create or replace function public.food_manufacturer_list(p_query text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_query text := public.normalize_stock_item_name(p_query);
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_lot_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', fm.id,
           'name', fm.name,
           'address', fm.address,
           'tax_code', fm.tax_code,
           'note', fm.note,
           'created_at', fm.created_at,
           'updated_at', fm.updated_at
         ) order by fm.name, fm.id), '[]'::jsonb)
    into v_result
    from public.food_manufacturers fm
   where v_query is null
      or fm.normalized_name like '%' || v_query || '%';

  return v_result;
end;
$$;

revoke all on function public.food_manufacturer_list(text) from public, anon;
grant execute on function public.food_manufacturer_list(text) to authenticated, service_role;
