-- Dispatch-report photos: one-time save per day, Jev document result and the
-- read-side fields the kho report needs.
--
-- Additive only. It never changes a PO, production order, stock movement,
-- revenue row or any photo object already in storage. Photos are uploaded by
-- the client exactly as before; this migration only records explicit save
-- state and the server-side Jev result for an already saved photo.
--
-- The Jev key stays in the Edge Function environment. This SQL store never
-- receives a key, a signed URL or the image bytes; it stores only the typed
-- result the service-role function writes through dispatch_report_jev_mark.

-- ---------------------------------------------------------------------------
-- 1. Photo save state + Jev result columns
-- ---------------------------------------------------------------------------
alter table public.dispatch_report_photos
  add column if not exists saved_at timestamptz null,
  add column if not exists size_bytes integer null,
  add column if not exists width integer null,
  add column if not exists height integer null,
  add column if not exists jev_status text not null default 'pending',
  add column if not exists jev_kind text null,
  add column if not exists jev_po_numbers text[] null,
  add column if not exists jev_quantities jsonb null,
  add column if not exists jev_summary text null,
  add column if not exists jev_mismatch boolean null,
  add column if not exists jev_error text null,
  add column if not exists jev_prompt_version text null,
  add column if not exists jev_checked_at timestamptz null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'dispatch_report_photos_jev_status_check'
      and conrelid = 'public.dispatch_report_photos'::regclass
  ) then
    alter table public.dispatch_report_photos
      add constraint dispatch_report_photos_jev_status_check
      check (jev_status in ('pending', 'running', 'done', 'failed', 'skipped'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'dispatch_report_photos_jev_kind_check'
      and conrelid = 'public.dispatch_report_photos'::regclass
  ) then
    alter table public.dispatch_report_photos
      add constraint dispatch_report_photos_jev_kind_check
      check (
        jev_kind is null
        or jev_kind in ('phieu_xuat_kho', 'bien_ban_giao_hang', 'hoa_don', 'khac')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'dispatch_report_photos_jev_summary_check'
      and conrelid = 'public.dispatch_report_photos'::regclass
  ) then
    alter table public.dispatch_report_photos
      add constraint dispatch_report_photos_jev_summary_check
      check (jev_summary is null or char_length(jev_summary) <= 500);
  end if;
end $$;

comment on column public.dispatch_report_photos.saved_at is
  'When the kho operator pressed Save for this report day. Null means uploaded but not saved.';
comment on column public.dispatch_report_photos.jev_status is
  'Jev classification state: pending, running, done, failed or skipped.';
comment on column public.dispatch_report_photos.jev_kind is
  'Document kind read by Jev: phieu_xuat_kho, bien_ban_giao_hang, hoa_don or khac.';
comment on column public.dispatch_report_photos.jev_po_numbers is
  'PO numbers read from the photo, normalised by the server before storage.';
comment on column public.dispatch_report_photos.jev_quantities is
  'Array of {po_number, qty} read from the photo.';
comment on column public.dispatch_report_photos.jev_summary is
  'Short Vietnamese summary returned by Jev (max 500 characters).';
comment on column public.dispatch_report_photos.jev_mismatch is
  'True when a read PO is absent from the day or its read quantity differs from delivered_qty.';

create index if not exists idx_dispatch_report_photos_saved
  on public.dispatch_report_photos(report_date, saved_at)
  where saved_at is not null;
create index if not exists idx_dispatch_report_photos_jev_status
  on public.dispatch_report_photos(jev_status, report_date);

-- ---------------------------------------------------------------------------
-- 2. Photo metadata RPC
--
-- The old two-argument signature is dropped so every caller resolves to this
-- one function. p_size_bytes/p_width/p_height default to null, therefore the
-- previous two-argument call still works unchanged.
-- ---------------------------------------------------------------------------
drop function if exists public.dispatch_report_photo_add(date, text);

create or replace function public.dispatch_report_photo_add(
  p_date date,
  p_storage_path text,
  p_size_bytes integer default null,
  p_width integer default null,
  p_height integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_prefix text;
  v_row public.dispatch_report_photos%rowtype;
begin
  if not public.kfm_delivery_can_edit(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_date is null
     or nullif(btrim(coalesce(p_storage_path, '')), '') is null then
    raise exception 'invalid_storage_path' using errcode = '22023';
  end if;

  if p_size_bytes is not null and p_size_bytes < 0 then
    raise exception 'invalid_photo_metadata' using errcode = '22023';
  end if;
  if p_width is not null and p_width < 0 then
    raise exception 'invalid_photo_metadata' using errcode = '22023';
  end if;
  if p_height is not null and p_height < 0 then
    raise exception 'invalid_photo_metadata' using errcode = '22023';
  end if;

  v_prefix := to_char(p_date, 'YYYY-MM-DD') || '/';
  if left(p_storage_path, length(v_prefix)) <> v_prefix
     or position('..' in p_storage_path) > 0 then
    raise exception 'invalid_storage_path' using errcode = '22023';
  end if;

  insert into public.dispatch_report_photos (
    report_date,
    storage_path,
    uploaded_by,
    size_bytes,
    width,
    height
  ) values (
    p_date,
    p_storage_path,
    v_actor,
    p_size_bytes,
    p_width,
    p_height
  )
  on conflict (storage_path) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row
    from public.dispatch_report_photos p
    where p.storage_path = p_storage_path;
  end if;

  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Save the photos of one report day
--
-- Only ids whose report_date equals p_date are accepted. A photo from another
-- day (or an unknown id) aborts the whole call with invalid_photo/22023 so the
-- client can never silently save a mixed-day selection. Photos already saved
-- keep their original saved_at and Jev status.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_report_save(
  p_date date,
  p_photo_ids uuid[]
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_ids uuid[];
  v_found integer;
begin
  if not public.kfm_delivery_can_edit(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_date is null then
    raise exception 'invalid_date' using errcode = '22023';
  end if;
  if p_photo_ids is null then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_photo_ids) as x where x is null) then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;

  select array_agg(distinct x order by x)
  into v_ids
  from unnest(p_photo_ids) as x;

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return '{}'::uuid[];
  end if;

  select count(*)
  into v_found
  from public.dispatch_report_photos p
  where p.id = any(v_ids)
    and p.report_date = p_date;

  if v_found <> array_length(v_ids, 1) then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;

  update public.dispatch_report_photos p
  set saved_at = coalesce(p.saved_at, now()),
      jev_status = case when p.saved_at is null then 'pending' else p.jev_status end
  where p.id = any(v_ids)
    and p.report_date = p_date;

  return v_ids;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Service-role result writer
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_report_jev_mark(
  p_id uuid,
  p_status text,
  p_kind text,
  p_po_numbers text[],
  p_quantities jsonb,
  p_summary text,
  p_mismatch boolean,
  p_error text,
  p_prompt_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.dispatch_report_photos%rowtype;
  v_po_numbers text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_id is null then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  if p_status is null
     or p_status not in ('pending', 'running', 'done', 'failed', 'skipped') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  if p_kind is not null
     and p_kind not in ('phieu_xuat_kho', 'bien_ban_giao_hang', 'hoa_don', 'khac') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;

  if p_quantities is not null and jsonb_typeof(p_quantities) <> 'array' then
    raise exception 'invalid_quantities' using errcode = '22023';
  end if;

  select array_agg(distinct upper(btrim(x)) order by upper(btrim(x)))
  into v_po_numbers
  from unnest(coalesce(p_po_numbers, '{}'::text[])) as x
  where nullif(btrim(x), '') is not null;

  if exists (
    select 1
    from public.dispatch_report_photos p
    where p.id = p_id and p.saved_at is null
  ) then
    raise exception 'photo_not_saved' using errcode = '22023';
  end if;

  update public.dispatch_report_photos p
  set jev_status = p_status,
      jev_kind = p_kind,
      jev_po_numbers = v_po_numbers,
      jev_quantities = p_quantities,
      jev_summary = left(nullif(btrim(coalesce(p_summary, '')), ''), 500),
      jev_mismatch = p_mismatch,
      jev_error = left(nullif(btrim(coalesce(p_error, '')), ''), 500),
      jev_prompt_version = left(nullif(btrim(coalesce(p_prompt_version, '')), ''), 100),
      jev_checked_at = now()
  where p.id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Daily report now exposes the save state and Jev result per photo
-- ---------------------------------------------------------------------------
create or replace function public.kfm_daily_delivery_report(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_pos jsonb;
  v_photos jsonb;
begin
  if not public.kfm_delivery_can_view(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_date is null then
    raise exception 'invalid_date' using errcode = '22023';
  end if;

  with inbox_pos as (
    select distinct on (upper(btrim(i.po_number)))
      upper(btrim(i.po_number)) as po_number,
      i.id as customer_po_inbox_id,
      i.delivery_date
    from public.customer_po_inbox i
    where i.delivery_date = p_date
      and i.po_number ilike 'PO100%'
      and i.match_status = 'approved'
      and nullif(btrim(i.po_number), '') is not null
    order by upper(btrim(i.po_number)), i.created_at asc nulls last, i.id
  ),
  delivery_pos as (
    select
      upper(btrim(d.po_number)) as po_number,
      d.customer_po_inbox_id,
      d.delivery_date,
      d.po_qty,
      d.delivered_qty,
      d.source,
      d.note,
      d.updated_at
    from public.kfm_po_deliveries d
    where d.delivery_date = p_date
  ),
  combined as (
    select
      i.po_number,
      coalesce(d.customer_po_inbox_id, i.customer_po_inbox_id) as customer_po_inbox_id,
      i.delivery_date,
      d.po_qty as stored_po_qty,
      d.delivered_qty as stored_delivered_qty,
      d.source,
      d.note,
      d.updated_at,
      (d.po_number is not null) as has_delivery
    from inbox_pos i
    left join delivery_pos d on d.po_number = i.po_number
    union all
    select
      d.po_number,
      d.customer_po_inbox_id,
      d.delivery_date,
      d.po_qty,
      d.delivered_qty,
      d.source,
      d.note,
      d.updated_at,
      true
    from delivery_pos d
    where not exists (
      select 1 from inbox_pos i where i.po_number = d.po_number
    )
  ),
  resolved as (
    select
      c.*,
      coalesce(
        (
          select sum(poi.ordered_qty)
          from public.production_orders po
          join public.production_order_items poi
            on poi.production_order_id = po.id
          where po.source_po_inbox_id = c.customer_po_inbox_id
        ),
        c.stored_po_qty,
        0
      ) as po_qty
    from combined c
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'po_number', r.po_number,
        'customer_po_inbox_id', r.customer_po_inbox_id,
        'delivery_date', r.delivery_date,
        'po_qty', r.po_qty,
        'delivered_qty', case
          when r.has_delivery then r.stored_delivered_qty
          else r.po_qty
        end,
        'is_default', not r.has_delivery,
        'source', r.source,
        'note', r.note,
        'updated_at', r.updated_at
      )
      order by r.po_number
    ),
    '[]'::jsonb
  )
  into v_pos
  from resolved r;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'storage_path', p.storage_path,
        'created_at', p.created_at,
        'saved_at', p.saved_at,
        'jev_status', p.jev_status,
        'jev_kind', p.jev_kind,
        'jev_po_numbers', p.jev_po_numbers,
        'jev_quantities', p.jev_quantities,
        'jev_summary', p.jev_summary,
        'jev_mismatch', p.jev_mismatch
      )
      order by p.created_at, p.id
    ),
    '[]'::jsonb
  )
  into v_photos
  from public.dispatch_report_photos p
  where p.report_date = p_date;

  return jsonb_build_object(
    'date', p_date,
    'pos', v_pos,
    'photos', v_photos
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.dispatch_report_photo_add(date, text, integer, integer, integer)
  from public, anon;
revoke all on function public.dispatch_report_save(date, uuid[]) from public, anon;
revoke all on function public.dispatch_report_jev_mark(
  uuid, text, text, text[], jsonb, text, boolean, text, text
) from public, anon, authenticated;

grant execute on function public.dispatch_report_photo_add(date, text, integer, integer, integer)
  to authenticated, service_role;
grant execute on function public.dispatch_report_save(date, uuid[])
  to authenticated, service_role;
grant execute on function public.dispatch_report_jev_mark(
  uuid, text, text, text[], jsonb, text, boolean, text, text
) to service_role;
