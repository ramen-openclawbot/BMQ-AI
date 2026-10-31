-- KFM daily actual-delivery record, dispatch-report photos and PO-vs-delivery report.
--
-- Additive migration: no PO, production order, stock, revenue or UI change.
-- The browser reads through the security-definer RPCs below; both tables keep
-- RLS enabled with no direct client write policy.

-- ---------------------------------------------------------------------------
-- 1. Internal permission helpers
-- ---------------------------------------------------------------------------
create or replace function public.kfm_delivery_can_view(v_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.has_role(v_actor_id, 'owner')
    or public.has_module_permission(v_actor_id, 'inventory', 'view')
    or public.has_module_permission(v_actor_id, 'inventory', 'edit')
    or public.has_module_permission(v_actor_id, 'production', 'view');
$$;

create or replace function public.kfm_delivery_can_edit(v_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.has_role(v_actor_id, 'owner')
    or public.has_module_permission(v_actor_id, 'inventory', 'edit');
$$;

revoke all on function public.kfm_delivery_can_view(uuid) from public, anon;
revoke all on function public.kfm_delivery_can_edit(uuid) from public, anon;
grant execute on function public.kfm_delivery_can_view(uuid) to authenticated, service_role;
grant execute on function public.kfm_delivery_can_edit(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Actual delivered quantity by KFM PO
-- ---------------------------------------------------------------------------
create table if not exists public.kfm_po_deliveries (
  id uuid primary key default gen_random_uuid(),
  po_number text not null unique,
  customer_po_inbox_id uuid null references public.customer_po_inbox(id) on delete set null,
  delivery_date date not null,
  po_qty numeric not null check (po_qty >= 0),
  delivered_qty numeric not null check (delivered_qty >= 0),
  source text not null check (source in ('kho', 'ke_toan')),
  note text null,
  updated_by uuid null references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_kfm_po_deliveries_delivery_date
  on public.kfm_po_deliveries(delivery_date, po_number);
create index if not exists idx_kfm_po_deliveries_inbox
  on public.kfm_po_deliveries(customer_po_inbox_id);

alter table public.kfm_po_deliveries enable row level security;

-- No client policy: reads go through kfm_daily_delivery_report /
-- kfm_delivery_vs_po, writes through kfm_set_po_delivered_qty.
revoke all on table public.kfm_po_deliveries from public, anon, authenticated;
grant all on table public.kfm_po_deliveries to service_role;

-- ---------------------------------------------------------------------------
-- 3. Dispatch-report photos, one row per private storage object
-- ---------------------------------------------------------------------------
create table if not exists public.dispatch_report_photos (
  id uuid primary key default gen_random_uuid(),
  report_date date not null,
  storage_path text not null unique,
  uploaded_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_dispatch_report_photos_date
  on public.dispatch_report_photos(report_date, created_at, id);

alter table public.dispatch_report_photos enable row level security;

revoke all on table public.dispatch_report_photos from public, anon, authenticated;
grant all on table public.dispatch_report_photos to service_role;

-- Private bucket. The client uploads under '<YYYY-MM-DD>/<uuid>.<ext>' and
-- reads short-lived signed URLs; path/date consistency is enforced by the RPC.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dispatch-report-photos',
  'dispatch-report-photos',
  false,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists dispatch_report_photos_objects_select on storage.objects;
create policy dispatch_report_photos_objects_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'dispatch-report-photos'
    and public.kfm_delivery_can_view((select auth.uid()))
  );

drop policy if exists dispatch_report_photos_objects_insert on storage.objects;
create policy dispatch_report_photos_objects_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'dispatch-report-photos'
    and public.kfm_delivery_can_edit((select auth.uid()))
  );

drop policy if exists dispatch_report_photos_objects_delete on storage.objects;
create policy dispatch_report_photos_objects_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'dispatch-report-photos'
    and public.kfm_delivery_can_edit((select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 4. Daily report
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
        'created_at', p.created_at
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
-- 5. Record the actual delivered quantity for one PO
-- ---------------------------------------------------------------------------
create or replace function public.kfm_set_po_delivered_qty(
  p_po_number text,
  p_delivered_qty numeric,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_po_number text;
  v_inbox public.customer_po_inbox%rowtype;
  v_existing public.kfm_po_deliveries%rowtype;
  v_has_inbox boolean := false;
  v_has_existing boolean := false;
  v_inbox_id uuid;
  v_delivery_date date;
  v_produced_qty numeric;
  v_po_qty numeric;
  v_note text;
  v_row public.kfm_po_deliveries%rowtype;
begin
  if not public.kfm_delivery_can_edit(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_delivered_qty is null
     or p_delivered_qty::text in ('NaN', 'Infinity', '-Infinity')
     or p_delivered_qty < 0 then
    raise exception 'invalid_delivered_qty' using errcode = '22023';
  end if;

  v_po_number := upper(btrim(coalesce(p_po_number, '')));
  if v_po_number = '' then
    raise exception 'po_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing
  from public.kfm_po_deliveries d
  where upper(btrim(d.po_number)) = v_po_number;
  v_has_existing := found;

  select * into v_inbox
  from public.customer_po_inbox i
  where upper(btrim(i.po_number)) = v_po_number
    and i.po_number ilike 'PO100%'
    and i.match_status = 'approved'
  order by i.created_at desc nulls last, i.id
  limit 1;
  v_has_inbox := found;

  if not v_has_inbox and not v_has_existing then
    raise exception 'po_not_found' using errcode = 'P0002';
  end if;

  v_inbox_id := coalesce(v_existing.customer_po_inbox_id, v_inbox.id);
  v_delivery_date := coalesce(
    v_inbox.delivery_date,
    v_existing.delivery_date,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  select sum(poi.ordered_qty)
  into v_produced_qty
  from public.production_orders po
  join public.production_order_items poi
    on poi.production_order_id = po.id
  where po.source_po_inbox_id = v_inbox_id;

  v_po_qty := coalesce(v_produced_qty, v_existing.po_qty, 0);

  if p_delivered_qty > v_po_qty * 2 then
    raise exception 'invalid_delivered_qty' using errcode = '22023';
  end if;

  v_note := nullif(left(btrim(coalesce(p_note, '')), 500), '');

  insert into public.kfm_po_deliveries (
    po_number,
    customer_po_inbox_id,
    delivery_date,
    po_qty,
    delivered_qty,
    source,
    note,
    updated_by,
    updated_at
  ) values (
    v_po_number,
    v_inbox_id,
    v_delivery_date,
    v_po_qty,
    p_delivered_qty,
    'kho',
    v_note,
    v_actor,
    now()
  )
  on conflict (po_number) do update
  set delivered_qty = excluded.delivered_qty,
      po_qty = excluded.po_qty,
      delivery_date = excluded.delivery_date,
      customer_po_inbox_id = excluded.customer_po_inbox_id,
      note = excluded.note,
      source = 'kho',
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Photo metadata
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_report_photo_add(
  p_date date,
  p_storage_path text
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

  v_prefix := to_char(p_date, 'YYYY-MM-DD') || '/';
  if left(p_storage_path, length(v_prefix)) <> v_prefix
     or position('..' in p_storage_path) > 0 then
    raise exception 'invalid_storage_path' using errcode = '22023';
  end if;

  insert into public.dispatch_report_photos (
    report_date,
    storage_path,
    uploaded_by
  ) values (
    p_date,
    p_storage_path,
    v_actor
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

create or replace function public.dispatch_report_photo_remove(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.dispatch_report_photos%rowtype;
begin
  if not public.kfm_delivery_can_edit(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_id is null then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  delete from public.dispatch_report_photos p
  where p.id = p_id
  returning * into v_row;

  if not found then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Delivery vs PO for a date range
-- ---------------------------------------------------------------------------
create or replace function public.kfm_delivery_vs_po(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_rows jsonb;
  v_totals jsonb;
begin
  if not public.kfm_delivery_can_view(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_from is null
     or p_to is null
     or p_from > p_to
     or (p_to - p_from + 1) > 370 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  with inbox_pos as (
    select distinct on (upper(btrim(i.po_number)))
      upper(btrim(i.po_number)) as po_number,
      i.id as customer_po_inbox_id,
      i.delivery_date
    from public.customer_po_inbox i
    where i.delivery_date between p_from and p_to
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
      d.source
    from public.kfm_po_deliveries d
    where d.delivery_date between p_from and p_to
  ),
  combined as (
    select
      i.po_number,
      coalesce(d.customer_po_inbox_id, i.customer_po_inbox_id) as customer_po_inbox_id,
      i.delivery_date,
      d.po_qty as stored_po_qty,
      d.delivered_qty as stored_delivered_qty,
      d.source,
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
  ),
  final_rows as (
    select
      r.*,
      case
        when r.has_delivery then r.stored_delivered_qty
        else r.po_qty
      end as delivered_qty
    from resolved r
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'po_number', f.po_number,
          'delivery_date', f.delivery_date,
          'po_qty', f.po_qty,
          'delivered_qty', f.delivered_qty,
          'shortfall', f.delivered_qty - f.po_qty,
          'ratio', case
            when f.po_qty = 0 then null
            else f.delivered_qty / f.po_qty
          end,
          'is_default', not f.has_delivery,
          'source', f.source
        )
        order by f.delivery_date desc, f.po_number
      ),
      '[]'::jsonb
    ),
    jsonb_build_object(
      'po_count', count(*),
      'po_qty', coalesce(sum(f.po_qty), 0),
      'delivered_qty', coalesce(sum(f.delivered_qty), 0),
      'shortfall', coalesce(sum(f.delivered_qty - f.po_qty), 0),
      'ratio', case
        when coalesce(sum(f.po_qty), 0) = 0 then null
        else sum(f.delivered_qty) / sum(f.po_qty)
      end,
      'confirmed_count', count(*) filter (where f.has_delivery),
      'under_95_count', count(*) filter (
        where f.po_qty > 0 and f.delivered_qty < f.po_qty * 0.95
      )
    )
  into v_rows, v_totals
  from final_rows f;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'rows', v_rows,
    'totals', v_totals
  );
end;
$$;

revoke all on function public.kfm_daily_delivery_report(date) from public, anon;
revoke all on function public.kfm_set_po_delivered_qty(text, numeric, text) from public, anon;
revoke all on function public.dispatch_report_photo_add(date, text) from public, anon;
revoke all on function public.dispatch_report_photo_remove(uuid) from public, anon;
revoke all on function public.kfm_delivery_vs_po(date, date) from public, anon;

grant execute on function public.kfm_daily_delivery_report(date) to authenticated, service_role;
grant execute on function public.kfm_set_po_delivered_qty(text, numeric, text) to authenticated, service_role;
grant execute on function public.dispatch_report_photo_add(date, text) to authenticated, service_role;
grant execute on function public.dispatch_report_photo_remove(uuid) to authenticated, service_role;
grant execute on function public.kfm_delivery_vs_po(date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. September/October closing seed from accounting
-- ---------------------------------------------------------------------------
insert into public.kfm_po_deliveries (
  po_number,
  customer_po_inbox_id,
  delivery_date,
  po_qty,
  delivered_qty,
  source,
  note
)
select
  v.po_number,
  (
    select i.id
    from public.customer_po_inbox i
    where upper(btrim(i.po_number)) = v.po_number
    order by i.created_at desc nulls last, i.id
    limit 1
  ),
  v.delivery_date,
  v.po_qty,
  v.delivered_qty,
  'ke_toan',
  'Số final kế toán 31/10'
from (values
  ('PO1002684496', date '2026-10-24', 820::numeric, 776::numeric),
  ('PO1002682291', date '2026-10-21', 830::numeric, 811::numeric),
  ('PO1002674500', date '2026-10-14', 818::numeric, 646::numeric),
  ('PO1002673250', date '2026-10-13', 809::numeric, 560::numeric),
  ('PO1002670572', date '2026-10-10', 780::numeric, 765::numeric),
  ('PO1002669558', date '2026-10-09', 956::numeric, 941::numeric),
  ('PO1002668629', date '2026-10-08', 857::numeric, 851::numeric),
  ('PO1002666220', date '2026-10-06', 727::numeric, 689::numeric),
  ('PO1002662319', date '2026-10-01', 628::numeric, 594::numeric)
) as v(po_number, delivery_date, po_qty, delivered_qty)
on conflict (po_number) do update
set delivered_qty = excluded.delivered_qty,
    po_qty = excluded.po_qty,
    delivery_date = excluded.delivery_date,
    source = 'ke_toan',
    note = excluded.note;
