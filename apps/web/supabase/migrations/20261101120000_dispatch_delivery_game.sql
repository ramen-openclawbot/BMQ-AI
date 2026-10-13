-- 2026-11-01 — Kho 2D: Cổng giao hàng (phần dữ liệu; chưa gồm giao diện game).
--
-- Additive migration on top of 20261101100000_stock_name_corrections.sql. It adds:
--   1. warehouse_dispatch_items.delivered_qty (numeric >= 0) and
--      warehouse_dispatches.delivered_at / delivered_by — the actual-delivery
--      record the game writes.
--   2. public.warehouse_dispatch_evidence and a private 'dispatch-evidence'
--      bucket: photos live under '<dispatch_id>/<file>'. Clients may upload /
--      read objects under the inventory permission, but the evidence rows are
--      only written by record_dispatch_delivery (service definer).
--   3. public.get_dispatch_game_queue() — the open dispatch queue (pending /
--      picked / dispatched, last 14 days) with its lines, customer, revenue
--      status, evidence count and can_edit.
--   4. public.record_dispatch_delivery(...) — server-authority record of the
--      delivered quantities + photos, idempotent by request_id. It updates the
--      matching po_dispatch_revenue_confirmation_lines billable / confirmed
--      amounts (delivered_qty x unit price), writes the before/after revenue
--      audit, then walks the dispatch to 'delivered' through
--      transition_warehouse_dispatch_status. Stock is only ever deducted by the
--      existing 'dispatched' step, never here.
--   5. public.warehouse_dispatch_delivery_requests — the idempotency ledger.
--   6. A shortfall on any line (delivered_qty < quantity) must carry a
--      shortfall_action: 'return_stock' puts the difference back into
--      inventory_items with a 'dispatch_return' ledger row, 'write_off' leaves
--      stock alone but requires a >= 3 character note. Both are recorded in
--      public.warehouse_dispatch_shortfalls. delivered_qty > quantity is
--      rejected outright (over_delivery_not_allowed).
--
-- The dispatch creation flow, upsert_po_dispatch_revenue_confirmation,
-- confirm_po_dispatch_revenue and the old Xuất kho page keep their exact
-- behaviour. This migration is not applied by the change itself; the Maestro
-- applies it later.

-- ===========================================================================
-- 1. Delivery columns
-- ===========================================================================

alter table public.warehouse_dispatch_items
  add column if not exists delivered_qty numeric(15,3);

alter table public.warehouse_dispatch_items
  drop constraint if exists warehouse_dispatch_items_delivered_qty_check;
alter table public.warehouse_dispatch_items
  add constraint warehouse_dispatch_items_delivered_qty_check
  check (delivered_qty is null or delivered_qty >= 0);

alter table public.warehouse_dispatches
  add column if not exists delivered_at timestamptz,
  add column if not exists delivered_by uuid references auth.users(id) on delete set null;

comment on column public.warehouse_dispatch_items.delivered_qty is
  'Số lượng thực giao, ghi bởi public.record_dispatch_delivery (Kho 2D).';
comment on column public.warehouse_dispatches.delivered_at is
  'Thời điểm ghi nhận giao hàng thực tế (Kho 2D).';
comment on column public.warehouse_dispatches.delivered_by is
  'Người ghi nhận giao hàng thực tế (Kho 2D).';

-- ===========================================================================
-- 1b. inventory_movements.movement_type gains 'dispatch_return'
-- ===========================================================================
-- public.inventory_movement_type is an enum, so the return-stock ledger row
-- needs this label. It is only referenced inside the record_dispatch_delivery
-- body below; PL/pgSQL resolves the SQL statements on first execution (after
-- this migration commits), so the "unsafe use of new value added in the same
-- transaction" rule does not bite.
alter type public.inventory_movement_type add value if not exists 'dispatch_return';

-- ===========================================================================
-- 2. Permission helpers — same inventory gate as
--    public.transition_warehouse_dispatch_status
-- ===========================================================================

create or replace function public.dispatch_delivery_can_view(v_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.has_role(v_actor_id, 'owner')
    or public.has_module_permission(v_actor_id, 'inventory', 'view')
    or public.has_module_permission(v_actor_id, 'inventory', 'edit');
$$;

create or replace function public.dispatch_delivery_can_edit(v_actor_id uuid)
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

revoke all on function public.dispatch_delivery_can_view(uuid) from public, anon;
revoke all on function public.dispatch_delivery_can_edit(uuid) from public, anon;
grant execute on function public.dispatch_delivery_can_view(uuid) to authenticated, service_role;
grant execute on function public.dispatch_delivery_can_edit(uuid) to authenticated, service_role;

-- ===========================================================================
-- 3. warehouse_dispatch_evidence + private bucket
-- ===========================================================================

create table if not exists public.warehouse_dispatch_evidence (
  id uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null references public.warehouse_dispatches(id) on delete cascade,
  storage_path text not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  constraint warehouse_dispatch_evidence_storage_path_check
    check (char_length(btrim(storage_path)) between 1 and 500),
  constraint warehouse_dispatch_evidence_dispatch_path_unique
    unique (dispatch_id, storage_path)
);

create index if not exists idx_warehouse_dispatch_evidence_dispatch
  on public.warehouse_dispatch_evidence(dispatch_id, uploaded_at);

alter table public.warehouse_dispatch_evidence enable row level security;

-- Read only for authenticated; the security-definer RPC (and service_role) is
-- the only writer.
revoke all on table public.warehouse_dispatch_evidence from public, anon, authenticated;
grant select on table public.warehouse_dispatch_evidence to authenticated;
grant all on table public.warehouse_dispatch_evidence to service_role;

drop policy if exists warehouse_dispatch_evidence_select on public.warehouse_dispatch_evidence;
create policy warehouse_dispatch_evidence_select
  on public.warehouse_dispatch_evidence
  for select
  to authenticated
  using (public.dispatch_delivery_can_view((select auth.uid())));

-- Private bucket: clients upload under their inventory permission and reads go
-- through short-lived signed URLs. New objects must sit under a dispatch id
-- folder; the evidence table itself stays service-definer-write-only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dispatch-evidence',
  'dispatch-evidence',
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

drop policy if exists dispatch_evidence_objects_select on storage.objects;
create policy dispatch_evidence_objects_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'dispatch-evidence'
    and public.dispatch_delivery_can_view((select auth.uid()))
  );

drop policy if exists dispatch_evidence_objects_insert on storage.objects;
create policy dispatch_evidence_objects_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'dispatch-evidence'
    and public.dispatch_delivery_can_edit((select auth.uid()))
    and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  );

-- ===========================================================================
-- 4. Idempotency ledger (server-only)
-- ===========================================================================

create table if not exists public.warehouse_dispatch_delivery_requests (
  request_id uuid primary key,
  dispatch_id uuid not null references public.warehouse_dispatches(id) on delete cascade,
  result jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_warehouse_dispatch_delivery_requests_dispatch
  on public.warehouse_dispatch_delivery_requests(dispatch_id);

alter table public.warehouse_dispatch_delivery_requests enable row level security;

-- No client policy at all: only the security-definer RPC (and service_role)
-- touches this table.
revoke all on table public.warehouse_dispatch_delivery_requests from public, anon, authenticated;
grant all on table public.warehouse_dispatch_delivery_requests to service_role;

-- ===========================================================================
-- 4b. warehouse_dispatch_shortfalls
-- =========================================================================

create table if not exists public.warehouse_dispatch_shortfalls (
  id uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null references public.warehouse_dispatches(id) on delete cascade,
  dispatch_item_id uuid not null references public.warehouse_dispatch_items(id) on delete cascade,
  shortfall_qty numeric(15,3) not null,
  action text not null,
  note text,
  inventory_movement_id uuid,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint warehouse_dispatch_shortfalls_dispatch_item_unique unique (dispatch_item_id),
  constraint warehouse_dispatch_shortfalls_qty_check check (shortfall_qty > 0),
  constraint warehouse_dispatch_shortfalls_action_check
    check (action in ('return_stock', 'write_off'))
);

create index if not exists idx_warehouse_dispatch_shortfalls_dispatch
  on public.warehouse_dispatch_shortfalls(dispatch_id, created_at);

alter table public.warehouse_dispatch_shortfalls enable row level security;

-- Read only for authenticated; the security-definer RPC (and service_role) is
-- the only writer.
revoke all on table public.warehouse_dispatch_shortfalls from public, anon, authenticated;
grant select on table public.warehouse_dispatch_shortfalls to authenticated;
grant all on table public.warehouse_dispatch_shortfalls to service_role;

drop policy if exists warehouse_dispatch_shortfalls_select on public.warehouse_dispatch_shortfalls;
create policy warehouse_dispatch_shortfalls_select
  on public.warehouse_dispatch_shortfalls
  for select
  to authenticated
  using (public.dispatch_delivery_can_view((select auth.uid())));

comment on table public.warehouse_dispatch_shortfalls is
  'Per dispatch line shortfall recorded by public.record_dispatch_delivery: return_stock (added back to inventory_items with a dispatch_return movement) or write_off (note required). One row per dispatch item; the request-id ledger prevents a retry from counting twice.';

-- ===========================================================================
-- 5. public.get_dispatch_game_queue()
-- ===========================================================================

create or replace function public.get_dispatch_game_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_can_edit boolean;
  v_result jsonb := '[]'::jsonb;
begin
  -- Same reader gate as the rest of the warehouse game: owner / inventory
  -- view / inventory edit.
  if not public.dispatch_delivery_can_view(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  v_can_edit := public.dispatch_delivery_can_edit(v_actor);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id,
           'dispatch_number', d.dispatch_number,
           'status', d.status,
           'dispatch_date', d.dispatch_date,
           'delivered_date', d.delivered_date,
           'customer_id', d.customer_id,
           'customer_name', c.customer_name,
           'amount_status', rc.amount_status,
           'confirmation_id', rc.id,
           'evidence_count', (
             select count(*)
             from public.warehouse_dispatch_evidence e
             where e.dispatch_id = d.id
           ),
           'can_edit', v_can_edit,
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', i.id,
                      'product_name', i.product_name,
                      'unit', i.unit,
                      'quantity', i.quantity,
                      'delivered_qty', i.delivered_qty
                    ) order by i.created_at, i.id)
             from public.warehouse_dispatch_items i
             where i.dispatch_id = d.id
           ), '[]'::jsonb)
         ) order by d.dispatch_date, d.created_at, d.id), '[]'::jsonb)
  into v_result
  from public.warehouse_dispatches d
  left join public.mini_crm_customers c on c.id = d.customer_id
  left join public.po_dispatch_revenue_confirmations rc
    on rc.warehouse_dispatch_id = d.id
   and rc.status <> 'cancelled'
  where d.status in ('pending', 'picked', 'dispatched')
    and d.dispatch_date is not null
    and d.dispatch_date >= v_today - 14;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.get_dispatch_game_queue() from public, anon;
grant execute on function public.get_dispatch_game_queue() to authenticated, service_role;

comment on function public.get_dispatch_game_queue() is
  'Owner / inventory view: the open (pending, picked, dispatched) warehouse dispatches of the last 14 days with their lines, customer, revenue amount_status, evidence count and can_edit. Ordered by dispatch_date.';

-- ===========================================================================
-- 6. public.record_dispatch_delivery(...)
-- ===========================================================================

create or replace function public.record_dispatch_delivery(
  p_dispatch_id uuid,
  p_lines jsonb,
  p_photo_paths text[],
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_dispatch public.warehouse_dispatches%rowtype;
  v_paths text[];
  v_photo_count integer;
  v_path text;
  v_line jsonb;
  v_line_count integer;
  v_item_id_text text;
  v_item_id uuid;
  v_delivered numeric;
  v_item public.warehouse_dispatch_items%rowtype;
  v_item_ids uuid[] := '{}';
  v_owned integer;
  v_confirm public.po_dispatch_revenue_confirmations%rowtype;
  v_old_header jsonb;
  v_old_lines jsonb;
  v_new_lines jsonb;
  v_matched_line_id uuid;
  v_source_key text;
  v_revenue_lines integer := 0;
  v_header_billable numeric := 0;
  v_header_confirmed numeric;
  v_revenue_pending boolean := false;
  v_status text;
  v_result jsonb;
  v_item_quantity numeric;
  v_shortfall numeric;
  v_shortfall_action text;
  v_shortfall_note text;
  v_movement_id uuid;
  v_inventory public.inventory_items%rowtype;
  v_inventory_matches integer;
  v_returned_qty numeric := 0;
  v_written_off_qty numeric := 0;
begin
  -- Actor + permission: owner or inventory edit (the same gate the existing
  -- transition_warehouse_dispatch_status enforces).
  if not public.dispatch_delivery_can_edit(v_actor) then
    raise exception 'dispatch_delivery_forbidden' using errcode = '42501';
  end if;

  if p_dispatch_id is null then
    raise exception 'dispatch_id_required' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines_required' using errcode = '22023';
  end if;

  -- At least one photo, at most eight, every one under this dispatch folder.
  v_paths := p_photo_paths;
  v_photo_count := coalesce(array_length(v_paths, 1), 0);
  if v_photo_count < 1 then
    raise exception 'evidence_required' using errcode = '22023';
  end if;
  if v_photo_count > 8 then
    raise exception 'too_many_photos' using errcode = '22023';
  end if;
  foreach v_path in array v_paths loop
    if v_path is null or btrim(v_path) = '' or v_path ~ '\.\.' then
      raise exception 'evidence_path_invalid' using errcode = '22023';
    end if;
    if v_path !~* ('^' || p_dispatch_id::text || '/') then
      raise exception 'evidence_path_not_in_dispatch' using errcode = '22023';
    end if;
  end loop;

  -- Idempotency: the same request returns the stored result unchanged. The
  -- advisory lock serialises concurrent retries of the same request.
  perform pg_advisory_xact_lock(
    hashtextextended('dispatch_delivery_request:' || p_request_id::text, 0)
  );
  select r.result into v_existing
  from public.warehouse_dispatch_delivery_requests r
  where r.request_id = p_request_id;
  if found then
    return v_existing;
  end if;

  select * into v_dispatch
  from public.warehouse_dispatches
  where id = p_dispatch_id
  for update;
  if not found then
    raise exception 'dispatch_not_found' using errcode = 'P0002';
  end if;
  if v_dispatch.status::text = 'delivered' then
    raise exception 'dispatch_already_delivered' using errcode = 'P0001';
  end if;

  -- Validate every line before any write: known id shape, non-negative finite
  -- quantity and no duplicate line.
  v_line_count := jsonb_array_length(p_lines);
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line_invalid' using errcode = '22023';
    end if;

    v_item_id_text := nullif(btrim(coalesce(v_line ->> 'item_id', '')), '');
    if v_item_id_text is null
       or v_item_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'line_invalid' using errcode = '22023';
    end if;

    if jsonb_typeof(v_line -> 'delivered_qty') is distinct from 'number' then
      raise exception 'quantity_invalid' using errcode = '22023';
    end if;
    v_delivered := (v_line ->> 'delivered_qty')::numeric;
    if v_delivered is null or v_delivered < 0
       or v_delivered::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'quantity_invalid' using errcode = '22023';
    end if;

    -- Read the ordered quantity of the line (it must belong to this dispatch)
    -- and validate the shortfall choice before any write.
    select i.quantity into v_item_quantity
    from public.warehouse_dispatch_items i
    where i.id = v_item_id_text::uuid
      and i.dispatch_id = p_dispatch_id;
    if not found then
      raise exception 'line_not_in_dispatch' using errcode = '22023';
    end if;

    if v_delivered > v_item_quantity then
      raise exception 'over_delivery_not_allowed' using errcode = '22023',
        detail = format('item_id=%s ordered=%s delivered=%s', v_item_id_text, v_item_quantity, v_delivered);
    end if;

    -- A full delivery ignores any shortfall choice; a short one must say how
    -- the difference is settled, and a write-off needs a real reason.
    if v_delivered < v_item_quantity then
      v_shortfall_action := lower(btrim(coalesce(v_line ->> 'shortfall_action', '')));
      if v_shortfall_action not in ('return_stock', 'write_off') then
        raise exception 'shortfall_action_required' using errcode = '22023',
          detail = format('item_id=%s ordered=%s delivered=%s', v_item_id_text, v_item_quantity, v_delivered);
      end if;
      if v_shortfall_action = 'write_off' then
        v_shortfall_note := nullif(btrim(coalesce(v_line ->> 'shortfall_note', '')), '');
        if v_shortfall_note is null or char_length(v_shortfall_note) < 3 then
          raise exception 'shortfall_note_required' using errcode = '22023',
            detail = format('item_id=%s', v_item_id_text);
        end if;
      end if;
    end if;

    if (v_item_id_text::uuid) = any (v_item_ids) then
      raise exception 'duplicate_line' using errcode = '22023';
    end if;
    v_item_ids := v_item_ids || v_item_id_text::uuid;
  end loop;

  -- Every line must belong to this dispatch.
  select count(*) into v_owned
  from public.warehouse_dispatch_items i
  where i.id = any (v_item_ids)
    and i.dispatch_id = p_dispatch_id;
  if v_owned <> v_line_count then
    raise exception 'line_not_in_dispatch' using errcode = '22023';
  end if;

  -- Lock the confirmation (if any) before the lines, so a concurrent confirm
  -- cannot race the revenue rewrite.
  select * into v_confirm
  from public.po_dispatch_revenue_confirmations
  where warehouse_dispatch_id = p_dispatch_id
    and status <> 'cancelled'
  order by updated_at desc
  limit 1
  for update;

  -- A month-end audited / revised confirmation belongs to finance: record the
  -- delivery but leave its revenue untouched and flag it for review.
  if v_confirm.id is not null
     and (v_confirm.status = 'revised' or v_confirm.amount_status = 'month_end_audit_adjusted') then
    v_confirm := null;
    v_revenue_pending := true;
  end if;

  if v_confirm.id is not null then
    v_old_header := to_jsonb(v_confirm);
    select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb)
    into v_old_lines
    from public.po_dispatch_revenue_confirmation_lines l
    where l.confirmation_id = v_confirm.id;
  else
    -- No confirmation yet: still record the delivery and tell the game the
    -- revenue side is pending.
    v_revenue_pending := true;
  end if;

  -- Write the delivered quantities and, when a confirmation exists, the
  -- matching revenue line: billable = delivered and confirmed = delivered x
  -- unit price.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_item_id := (v_line ->> 'item_id')::uuid;
    v_delivered := (v_line ->> 'delivered_qty')::numeric;

    select * into v_item
    from public.warehouse_dispatch_items
    where id = v_item_id;
    if not found then
      raise exception 'line_not_in_dispatch' using errcode = '22023';
    end if;

    update public.warehouse_dispatch_items
    set delivered_qty = v_delivered
    where id = v_item_id;

    if v_confirm.id is not null then
      v_source_key := nullif(btrim(coalesce(v_line ->> 'source_line_key', '')), '');
      select l.id into v_matched_line_id
      from public.po_dispatch_revenue_confirmation_lines l
      where l.confirmation_id = v_confirm.id
        and (
          (v_source_key is not null and l.source_line_key = v_source_key)
          or lower(btrim(l.product_name)) = lower(btrim(v_item.product_name))
        )
      order by
        case when v_source_key is not null and l.source_line_key = v_source_key then 0 else 1 end,
        l.id
      limit 1;

      -- Only lines with a unit price are recomputed; a manual / unpriced line
      -- keeps its amount and the delivery is flagged for finance review.
      if v_matched_line_id is not null then
        update public.po_dispatch_revenue_confirmation_lines
        set billable_qty = v_delivered,
            confirmed_revenue_amount_vat_included = round(v_delivered * unit_price_vat_included, 2)
        where id = v_matched_line_id
          and unit_price_vat_included is not null;
        if found then
          v_revenue_lines := v_revenue_lines + 1;
        else
          v_revenue_pending := true;
        end if;
      else
        v_revenue_pending := true;
      end if;
      v_matched_line_id := null;
    end if;
  end loop;

  if v_confirm.id is not null then
    -- The header total is only final when every line has an amount; sum()
    -- would otherwise silently skip unallocated lines.
    select coalesce(sum(l.billable_qty), 0),
           case when bool_and(l.confirmed_revenue_amount_vat_included is not null)
                then sum(l.confirmed_revenue_amount_vat_included) end
    into v_header_billable, v_header_confirmed
    from public.po_dispatch_revenue_confirmation_lines l
    where l.confirmation_id = v_confirm.id;

    update public.po_dispatch_revenue_confirmations
    set billable_qty_total = v_header_billable,
        confirmed_revenue_amount_vat_included = v_header_confirmed,
        amount_status = case
          when v_header_confirmed is not null then 'confirmed_dispatch_amount'
          else amount_status
        end,
        amount_basis = case
          when v_header_confirmed is not null then 'delivered_qty_confirmed'
          else amount_basis
        end
    where id = v_confirm.id;

    select * into v_confirm
    from public.po_dispatch_revenue_confirmations
    where id = v_confirm.id;

    select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb)
    into v_new_lines
    from public.po_dispatch_revenue_confirmation_lines l
    where l.confirmation_id = v_confirm.id;

    -- Before / after audit.
    insert into public.po_dispatch_revenue_audit_logs (
      confirmation_id,
      customer_po_inbox_id,
      warehouse_dispatch_id,
      action,
      actor_id,
      old_values,
      new_values,
      note
    ) values (
      v_confirm.id,
      v_confirm.customer_po_inbox_id,
      p_dispatch_id,
      'delivery_recorded',
      v_actor,
      jsonb_build_object('header', v_old_header, 'lines', v_old_lines),
      jsonb_build_object('header', to_jsonb(v_confirm), 'lines', v_new_lines),
      'Ghi nhận số thực giao (Kho 2D)'
    );
  end if;

  -- Evidence rows: idempotent per (dispatch_id, storage_path).
  foreach v_path in array v_paths loop
    insert into public.warehouse_dispatch_evidence (dispatch_id, storage_path, uploaded_by)
    values (p_dispatch_id, v_path, v_actor)
    on conflict (dispatch_id, storage_path) do nothing;
  end loop;

  -- Walk the dispatch to 'delivered' through the existing transition wrapper.
  -- Stock is only deducted by the 'dispatched' step, so a dispatch that is
  -- already 'dispatched' never deducts twice.
  v_status := v_dispatch.status::text;
  if v_status = 'pending' then
    perform public.transition_warehouse_dispatch_status(p_dispatch_id, 'picked');
    v_status := 'picked';
  end if;
  if v_status = 'picked' then
    perform public.transition_warehouse_dispatch_status(p_dispatch_id, 'dispatched');
    v_status := 'dispatched';
  end if;
  if v_status = 'dispatched' then
    perform public.transition_warehouse_dispatch_status(p_dispatch_id, 'delivered');
    v_status := 'delivered';
  end if;

  update public.warehouse_dispatches
  set delivered_by = v_actor,
      delivered_at = coalesce(delivered_at, now())
  where id = p_dispatch_id;

  -- Shortfall settlement, after the dispatch is 'delivered'. The 'dispatched'
  -- step already deducted the full ordered quantity, so return_stock puts the
  -- difference back (same name match / lock as transition_warehouse_dispatch_status)
  -- with a 'dispatch_return' ledger row, while write_off leaves stock unchanged.
  -- Both are recorded once per line; the request-id ledger makes a retry return
  -- the stored result before reaching here.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_item_id := (v_line ->> 'item_id')::uuid;
    v_delivered := (v_line ->> 'delivered_qty')::numeric;

    select * into v_item
    from public.warehouse_dispatch_items
    where id = v_item_id;

    v_shortfall := v_item.quantity - v_delivered;
    if v_shortfall <= 0 then
      continue;
    end if;

    v_shortfall_action := lower(btrim(coalesce(v_line ->> 'shortfall_action', '')));
    v_shortfall_note := nullif(btrim(coalesce(v_line ->> 'shortfall_note', '')), '');
    v_movement_id := null;

    if v_shortfall_action = 'return_stock' then
      select count(*) into v_inventory_matches
      from public.inventory_items
      where lower(btrim(name)) = lower(btrim(v_item.product_name));
      if v_inventory_matches = 0 then
        raise exception 'inventory_item_not_found' using errcode = 'P0001', detail = v_item.product_name;
      elsif v_inventory_matches > 1 then
        raise exception 'inventory_item_ambiguous' using errcode = 'P0001', detail = v_item.product_name;
      end if;

      select * into v_inventory
      from public.inventory_items
      where lower(btrim(name)) = lower(btrim(v_item.product_name))
      for update;

      update public.inventory_items
      set quantity = quantity + v_shortfall,
          updated_at = now()
      where id = v_inventory.id;

      insert into public.inventory_movements (
        movement_type,
        inventory_item_id,
        quantity,
        unit,
        reference_type,
        reference_id,
        movement_date,
        notes,
        created_by
      ) values (
        'dispatch_return'::public.inventory_movement_type,
        v_inventory.id,
        v_shortfall,
        v_item.unit,
        'warehouse_dispatch',
        p_dispatch_id,
        (now() at time zone 'Asia/Ho_Chi_Minh')::date,
        'Trả lại kho từ ' || v_dispatch.dispatch_number,
        v_actor
      )
      returning id into v_movement_id;

      v_returned_qty := v_returned_qty + v_shortfall;
    else
      v_written_off_qty := v_written_off_qty + v_shortfall;
    end if;

    insert into public.warehouse_dispatch_shortfalls (
      dispatch_id,
      dispatch_item_id,
      shortfall_qty,
      action,
      note,
      inventory_movement_id,
      actor_id
    ) values (
      p_dispatch_id,
      v_item_id,
      v_shortfall,
      v_shortfall_action,
      v_shortfall_note,
      v_movement_id,
      v_actor
    )
    on conflict (dispatch_item_id) do nothing;
  end loop;

  v_result := jsonb_build_object(
    'dispatch_id', p_dispatch_id,
    'status', v_status,
    'revenue_pending', v_revenue_pending,
    'evidence_count', v_photo_count,
    'delivered_line_count', v_line_count,
    'revenue_line_count', v_revenue_lines,
    'shortfall_returned_qty', v_returned_qty,
    'shortfall_written_off_qty', v_written_off_qty,
    'idempotent', false
  );

  insert into public.warehouse_dispatch_delivery_requests (
    request_id, dispatch_id, result, created_by
  ) values (
    p_request_id, p_dispatch_id, v_result, v_actor
  )
  on conflict (request_id) do nothing;

  return v_result;
end;
$$;

revoke all on function public.record_dispatch_delivery(uuid, jsonb, text[], uuid) from public, anon;
grant execute on function public.record_dispatch_delivery(uuid, jsonb, text[], uuid) to authenticated, service_role;

comment on function public.record_dispatch_delivery(uuid, jsonb, text[], uuid) is
  'Owner / inventory edit: records the actual delivered quantities and 1..8 evidence photos of one dispatch (photos must live under <dispatch_id>/), is idempotent by request_id, updates the matching po_dispatch_revenue_confirmation_lines billable / confirmed amounts with a before/after audit, moves the dispatch to delivered through transition_warehouse_dispatch_status, then settles every short line as return_stock (adds back to inventory_items with a dispatch_return movement) or write_off (note >= 3 chars, stock unchanged). delivered_qty > quantity is rejected (over_delivery_not_allowed).';
