-- Tân Tạo auto ledger: close everything dated on/before the per-SKU physical
-- cutover without posting stock, then receive expected Tuyết Anh orders and
-- dispatch active dealer/kiosk reservations for each business date after the
-- cutover up to today (Asia/Ho_Chi_Minh).
--
-- The public execute_tan_tao_warehouse_command keeps its own permission checks.
-- The daily job calls that public command with the owner/service JWT context;
-- it never inserts a movement directly.

-- ---------------------------------------------------------------------------
-- 1. Terminal "closed" status for documents that must stay auditable without
--    posting stock. Reservations already have the existing non-posting
--    'cancelled' terminal value used by the dealer cancellation release path.
-- ---------------------------------------------------------------------------

alter table public.tan_tao_warehouse_documents
  drop constraint if exists tan_tao_warehouse_documents_status_check;
alter table public.tan_tao_warehouse_documents
  add constraint tan_tao_warehouse_documents_status_check
  check (status in ('expected', 'reserved', 'posted', 'cancelled', 'closed'));

-- ---------------------------------------------------------------------------
-- 2. Run/event audit tables
-- ---------------------------------------------------------------------------

create table if not exists public.tan_tao_auto_ledger_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  mode text not null,
  dry_run boolean not null default false,
  result jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tan_tao_auto_ledger_runs_mode_check check (mode in ('close_before_cutover', 'daily'))
);

create table if not exists public.tan_tao_auto_ledger_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.tan_tao_auto_ledger_runs(id) on delete cascade,
  document_id uuid references public.tan_tao_warehouse_documents(id) on delete set null,
  reservation_id uuid references public.tan_tao_warehouse_reservations(id) on delete set null,
  action text not null,
  quantity numeric,
  business_date date,
  reason text,
  created_at timestamptz not null default now(),
  constraint tan_tao_auto_ledger_events_action_check
    check (action in ('closed_reservation', 'closed_supplier_order', 'dispatched', 'received', 'skipped')),
  constraint tan_tao_auto_ledger_events_reference_check
    check (reservation_id is not null or document_id is not null)
);

create unique index if not exists tan_tao_auto_ledger_events_unique_idx
  on public.tan_tao_auto_ledger_events(action, coalesce(reservation_id, document_id));
create index if not exists tan_tao_auto_ledger_events_run_idx
  on public.tan_tao_auto_ledger_events(run_id, created_at desc);
create index if not exists tan_tao_auto_ledger_runs_created_idx
  on public.tan_tao_auto_ledger_runs(created_at desc);

alter table public.tan_tao_auto_ledger_runs enable row level security;
alter table public.tan_tao_auto_ledger_events enable row level security;

revoke all on table public.tan_tao_auto_ledger_runs from public, anon, authenticated;
revoke all on table public.tan_tao_auto_ledger_events from public, anon, authenticated;
grant select on table public.tan_tao_auto_ledger_runs to authenticated;
grant select on table public.tan_tao_auto_ledger_events to authenticated;
grant all on table public.tan_tao_auto_ledger_runs to service_role;
grant all on table public.tan_tao_auto_ledger_events to service_role;

drop policy if exists tan_tao_auto_ledger_runs_select on public.tan_tao_auto_ledger_runs;
create policy tan_tao_auto_ledger_runs_select
  on public.tan_tao_auto_ledger_runs for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner'::public.app_role)
    or public.can_view_tan_tao_warehouse()
  );

drop policy if exists tan_tao_auto_ledger_events_select on public.tan_tao_auto_ledger_events;
create policy tan_tao_auto_ledger_events_select
  on public.tan_tao_auto_ledger_events for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner'::public.app_role)
    or public.can_view_tan_tao_warehouse()
  );

-- ---------------------------------------------------------------------------
-- 3. Internal read helpers (cutover per SKU + source business date)
-- ---------------------------------------------------------------------------

create or replace function public.tan_tao_auto_ledger_cutover(p_sku_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  -- A SKU count is posted at "now" (record_tan_tao_stock_count has no date), so the
  -- 16/10 physical file was posted on 17/10. The kho's material-ledger cutover
  -- carries the real count date; take the earlier of the two so deliveries on the
  -- day after the physical count are still dispatched.
  select case
    when x.doc_date is null then null
    else least(x.doc_date, coalesce(public.stock_ledger_cutover_date('tan_tao'), x.doc_date))
  end
  from (
    select (d.created_at at time zone 'Asia/Ho_Chi_Minh')::date as doc_date
    from public.tan_tao_warehouse_documents d
    where d.sku_id = p_sku_id
      and d.document_type = 'stock_count'
      and d.status = 'posted'
    order by d.created_at desc, d.id desc
    limit 1
  ) x
  right join (select 1) one on true;
$$;

create or replace function public.tan_tao_auto_ledger_business_date(p_document_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_document public.tan_tao_warehouse_documents;
  v_business_date date;
begin
  select * into v_document
  from public.tan_tao_warehouse_documents
  where id = p_document_id;
  if not found then
    return null;
  end if;

  if v_document.reference_type = 'dealer_order' and v_document.reference_id is not null then
    select o.requested_delivery_date into v_business_date
    from public.dealer_orders o
    where o.id = v_document.reference_id;
  elsif v_document.reference_type in (
    'warehouse_kiosk_bread_dispatch',
    'production_bread_order',
    'production_bread_order_correction',
    'customer_po_email'
  ) and v_document.reference_id is not null then
    select n.digest_date into v_business_date
    from public.dealer_order_notifications n
    where n.id = v_document.reference_id;
  end if;

  if v_business_date is null then
    v_business_date := coalesce(
      case
        when coalesce(v_document.metadata ->> 'digest_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          then (v_document.metadata ->> 'digest_date')::date
      end,
      case
        when coalesce(v_document.metadata ->> 'expected_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          then (v_document.metadata ->> 'expected_date')::date
      end,
      case
        when coalesce(v_document.metadata ->> 'business_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          then (v_document.metadata ->> 'business_date')::date
      end,
      (v_document.created_at at time zone 'Asia/Ho_Chi_Minh')::date
    );
  end if;

  return v_business_date;
end;
$$;

revoke all on function public.tan_tao_auto_ledger_cutover(uuid) from public, anon, authenticated;
revoke all on function public.tan_tao_auto_ledger_business_date(uuid) from public, anon, authenticated;
grant execute on function public.tan_tao_auto_ledger_cutover(uuid) to service_role;
grant execute on function public.tan_tao_auto_ledger_business_date(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Close every open item dated on/before the cutover (or p_before)
-- ---------------------------------------------------------------------------

create or replace function public.close_tan_tao_open_before(
  p_before date default null,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_run_id uuid;
  v_run_date date := coalesce(p_before, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_reservation record;
  v_supplier record;
  v_business_date date;
  v_cutover date;
  v_event_id uuid;
  v_closed_reservations integer := 0;
  v_closed_supplier_orders integer := 0;
  v_closed_quantity numeric := 0;
  v_skipped_count integer := 0;
  v_skipped_reasons jsonb := '{}'::jsonb;
  v_cutover_by_sku jsonb := '{}'::jsonb;
  v_items jsonb := '{}'::jsonb;
  v_item jsonb;
  v_sku_code text;
  v_items_array jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  -- The scheduler has no JWT; treat that invocation as the service role.
  if v_actor is null and coalesce(auth.role(), '') <> 'service_role' then
    perform set_config('request.jwt.claim.role', 'service_role', true);
  end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_role(v_actor, 'owner'::public.app_role) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tan_tao_auto_ledger', 0));

  if not p_dry_run then
    insert into public.tan_tao_auto_ledger_runs (
      run_date, mode, dry_run, result, created_by
    ) values (
      v_run_date, 'close_before_cutover', false, '{}'::jsonb, v_actor
    ) returning id into v_run_id;
  end if;

  for v_reservation in
    select
      r.id as reservation_id,
      r.document_id,
      r.sku_id,
      r.quantity,
      d.sku_code_snapshot
    from public.tan_tao_warehouse_reservations r
    join public.tan_tao_warehouse_documents d on d.id = r.document_id
    where r.status = 'active'
    order by r.id
    for update of r, d
  loop
    v_sku_code := coalesce(v_reservation.sku_code_snapshot, 'BMQ-001');
    v_business_date := public.tan_tao_auto_ledger_business_date(v_reservation.document_id);
    v_cutover := public.tan_tao_auto_ledger_cutover(v_reservation.sku_id);
    v_cutover_by_sku := v_cutover_by_sku || jsonb_build_object(v_sku_code, v_cutover);

    if v_business_date is null then
      continue;
    end if;
    if p_before is not null then
      if v_business_date > p_before then
        continue;
      end if;
    else
      if v_cutover is null or v_business_date > v_cutover then
        continue;
      end if;
    end if;

    if exists (
      select 1 from public.tan_tao_auto_ledger_events e
      where e.action = 'closed_reservation'
        and e.reservation_id = v_reservation.reservation_id
    ) then
      v_skipped_count := v_skipped_count + 1;
      v_skipped_reasons := jsonb_set(
        v_skipped_reasons,
        array['already_evented'],
        to_jsonb(coalesce((v_skipped_reasons ->> 'already_evented')::integer, 0) + 1),
        true
      );
      v_item := coalesce(
        v_items -> v_sku_code,
        jsonb_build_object(
          'sku_code', v_sku_code,
          'closed_reservations', 0,
          'closed_supplier_orders', 0,
          'closed_quantity', 0,
          'skipped_count', 0,
          'skipped_by_reason', '{}'::jsonb
        )
      );
      v_item := jsonb_set(
        v_item,
        '{skipped_count}',
        to_jsonb(coalesce((v_item ->> 'skipped_count')::integer, 0) + 1),
        true
      );
      v_item := jsonb_set(
        v_item,
        '{skipped_by_reason,already_evented}',
        to_jsonb(coalesce((v_item #>> '{skipped_by_reason,already_evented}')::integer, 0) + 1),
        true
      );
      v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);
      continue;
    end if;

    if p_dry_run then
      v_closed_reservations := v_closed_reservations + 1;
      v_closed_quantity := v_closed_quantity + v_reservation.quantity;
    else
      insert into public.tan_tao_auto_ledger_events (
        run_id, document_id, reservation_id, action, quantity, business_date, reason
      ) values (
        v_run_id, v_reservation.document_id, v_reservation.reservation_id,
        'closed_reservation', v_reservation.quantity, v_business_date, 'before_cutover'
      )
      on conflict (action, coalesce(reservation_id, document_id)) do nothing
      returning id into v_event_id;

      if v_event_id is null then
        continue;
      end if;

      update public.tan_tao_warehouse_reservations
      set status = 'cancelled', released_at = now()
      where id = v_reservation.reservation_id and status = 'active';
      update public.tan_tao_warehouse_documents
      set status = 'closed',
          metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'auto_closed_at', now(),
            'auto_closed_reason', 'before_cutover'
          )
      where id = v_reservation.document_id
        and status not in ('closed', 'cancelled', 'posted');

      v_closed_reservations := v_closed_reservations + 1;
      v_closed_quantity := v_closed_quantity + v_reservation.quantity;
    end if;

    v_item := coalesce(
      v_items -> v_sku_code,
      jsonb_build_object(
        'sku_code', v_sku_code,
        'closed_reservations', 0,
        'closed_supplier_orders', 0,
        'closed_quantity', 0,
        'skipped_count', 0,
        'skipped_by_reason', '{}'::jsonb
      )
    );
    v_item := jsonb_set(
      v_item,
      '{closed_reservations}',
      to_jsonb(coalesce((v_item ->> 'closed_reservations')::integer, 0) + 1),
      true
    );
    v_item := jsonb_set(
      v_item,
      '{closed_quantity}',
      to_jsonb(coalesce((v_item ->> 'closed_quantity')::numeric, 0) + v_reservation.quantity),
      true
    );
    v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);
  end loop;

  for v_supplier in
    select
      d.id as document_id,
      d.sku_id,
      d.quantity,
      d.sku_code_snapshot
    from public.tan_tao_warehouse_documents d
    where d.document_type = 'supplier_order'
      and d.status = 'expected'
    order by d.id
    for update of d
  loop
    v_sku_code := coalesce(v_supplier.sku_code_snapshot, 'BMQ-001');
    v_business_date := public.tan_tao_auto_ledger_business_date(v_supplier.document_id);
    v_cutover := public.tan_tao_auto_ledger_cutover(v_supplier.sku_id);
    v_cutover_by_sku := v_cutover_by_sku || jsonb_build_object(v_sku_code, v_cutover);

    if v_business_date is null then
      continue;
    end if;
    if p_before is not null then
      if v_business_date > p_before then
        continue;
      end if;
    else
      if v_cutover is null or v_business_date > v_cutover then
        continue;
      end if;
    end if;

    if exists (
      select 1 from public.tan_tao_auto_ledger_events e
      where e.action = 'closed_supplier_order'
        and e.document_id = v_supplier.document_id
    ) then
      v_skipped_count := v_skipped_count + 1;
      v_skipped_reasons := jsonb_set(
        v_skipped_reasons,
        array['already_evented'],
        to_jsonb(coalesce((v_skipped_reasons ->> 'already_evented')::integer, 0) + 1),
        true
      );
      v_item := coalesce(
        v_items -> v_sku_code,
        jsonb_build_object(
          'sku_code', v_sku_code,
          'closed_reservations', 0,
          'closed_supplier_orders', 0,
          'closed_quantity', 0,
          'skipped_count', 0,
          'skipped_by_reason', '{}'::jsonb
        )
      );
      v_item := jsonb_set(
        v_item,
        '{skipped_count}',
        to_jsonb(coalesce((v_item ->> 'skipped_count')::integer, 0) + 1),
        true
      );
      v_item := jsonb_set(
        v_item,
        '{skipped_by_reason,already_evented}',
        to_jsonb(coalesce((v_item #>> '{skipped_by_reason,already_evented}')::integer, 0) + 1),
        true
      );
      v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);
      continue;
    end if;

    if p_dry_run then
      v_closed_supplier_orders := v_closed_supplier_orders + 1;
      v_closed_quantity := v_closed_quantity + v_supplier.quantity;
    else
      insert into public.tan_tao_auto_ledger_events (
        run_id, document_id, reservation_id, action, quantity, business_date, reason
      ) values (
        v_run_id, v_supplier.document_id, null,
        'closed_supplier_order', v_supplier.quantity, v_business_date, 'before_cutover'
      )
      on conflict (action, coalesce(reservation_id, document_id)) do nothing
      returning id into v_event_id;

      if v_event_id is null then
        continue;
      end if;

      update public.tan_tao_warehouse_documents
      set status = 'closed',
          metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'auto_closed_at', now(),
            'auto_closed_reason', 'before_cutover'
          )
      where id = v_supplier.document_id and status = 'expected';

      v_closed_supplier_orders := v_closed_supplier_orders + 1;
      v_closed_quantity := v_closed_quantity + v_supplier.quantity;
    end if;

    v_item := coalesce(
      v_items -> v_sku_code,
      jsonb_build_object(
        'sku_code', v_sku_code,
        'closed_reservations', 0,
        'closed_supplier_orders', 0,
        'closed_quantity', 0,
        'skipped_count', 0,
        'skipped_by_reason', '{}'::jsonb
      )
    );
    v_item := jsonb_set(
      v_item,
      '{closed_supplier_orders}',
      to_jsonb(coalesce((v_item ->> 'closed_supplier_orders')::integer, 0) + 1),
      true
    );
    v_item := jsonb_set(
      v_item,
      '{closed_quantity}',
      to_jsonb(coalesce((v_item ->> 'closed_quantity')::numeric, 0) + v_supplier.quantity),
      true
    );
    v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);
  end loop;

  select coalesce(jsonb_agg(entry.value order by entry.value ->> 'sku_code'), '[]'::jsonb)
  into v_items_array
  from jsonb_each(v_items) entry;

  v_result := jsonb_build_object(
    'mode', 'close_before_cutover',
    'dry_run', p_dry_run,
    'before', p_before,
    'cutover_by_sku', v_cutover_by_sku,
    'closed_reservations', v_closed_reservations,
    'closed_supplier_orders', v_closed_supplier_orders,
    'closed_quantity', v_closed_quantity,
    'skipped_count', v_skipped_count,
    'skipped_by_reason', v_skipped_reasons,
    'items', v_items_array,
    'run_id', v_run_id
  );

  if not p_dry_run then
    update public.tan_tao_auto_ledger_runs
    set result = v_result
    where id = v_run_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.close_tan_tao_open_before(date, boolean) from public, anon, authenticated;
grant execute on function public.close_tan_tao_open_before(date, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Daily receive + dispatch job
-- ---------------------------------------------------------------------------

create or replace function public.run_tan_tao_daily_ledger(
  p_as_of date default (now() at time zone 'Asia/Ho_Chi_Minh')::date,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_run_id uuid;
  v_supplier record;
  v_reservation record;
  v_business_date date;
  v_cutover date;
  v_sku_code text;
  v_quantity numeric;
  v_received numeric;
  v_reason text;
  v_receipt_result jsonb;
  v_dispatch_result jsonb;
  v_order_status text;
  v_order_is_test boolean;
  v_notice_status text;
  v_source_id uuid;
  v_received_count integer := 0;
  v_received_quantity numeric := 0;
  v_dispatched_count integer := 0;
  v_dispatched_quantity numeric := 0;
  v_skipped_count integer := 0;
  v_skipped_reasons jsonb := '{}'::jsonb;
  v_items jsonb := '{}'::jsonb;
  v_item jsonb;
  v_items_array jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  -- The scheduler has no JWT; treat that invocation as the service role.
  if v_actor is null and coalesce(auth.role(), '') <> 'service_role' then
    perform set_config('request.jwt.claim.role', 'service_role', true);
  end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_role(v_actor, 'owner'::public.app_role) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tan_tao_auto_ledger', 0));

  if not p_dry_run then
    insert into public.tan_tao_auto_ledger_runs (
      run_date, mode, dry_run, result, created_by
    ) values (
      v_as_of, 'daily', false, '{}'::jsonb, v_actor
    ) returning id into v_run_id;
  end if;

  -- First receive every expected supplier order, in business-date order.
  for v_supplier in
    select
      d.id as document_id,
      d.document_number,
      d.sku_id,
      d.sku_code_snapshot,
      d.quantity,
      d.reference_type,
      d.reference_id,
      d.reference_label,
      public.tan_tao_auto_ledger_business_date(d.id) as auto_business_date
    from public.tan_tao_warehouse_documents d
    where d.document_type = 'supplier_order'
      and d.status = 'expected'
    order by public.tan_tao_auto_ledger_business_date(d.id) nulls last, d.id
    for update of d
  loop
    v_sku_code := coalesce(v_supplier.sku_code_snapshot, 'BMQ-001');
    v_business_date := v_supplier.auto_business_date;
    v_cutover := public.tan_tao_auto_ledger_cutover(v_supplier.sku_id);
    v_reason := null;

    if v_business_date is null then
      v_reason := 'missing_business_date';
    elsif v_cutover is null then
      v_reason := 'cutover_not_set';
    elsif v_business_date <= v_cutover then
      v_reason := 'before_cutover';
    elsif v_business_date > v_as_of then
      continue;
    end if;

    if v_reason is null then
      select coalesce(sum(rd.quantity), 0) into v_received
      from public.tan_tao_warehouse_documents rd
      where rd.source_document_id = v_supplier.document_id
        and rd.document_type = 'receipt'
        and rd.status = 'posted';

      v_quantity := v_supplier.quantity - v_received;
      if v_quantity <= 0 then
        v_reason := 'already_received';
      elsif p_dry_run then
        v_received_count := v_received_count + 1;
        v_received_quantity := v_received_quantity + v_quantity;
        v_item := coalesce(
          v_items -> v_sku_code,
          jsonb_build_object(
            'sku_code', v_sku_code,
            'cutover_date', v_cutover,
            'received_count', 0,
            'received_quantity', 0,
            'dispatched_count', 0,
            'dispatched_quantity', 0,
            'closed_quantity', 0,
            'skipped_count', 0,
            'skipped_by_reason', '{}'::jsonb
          )
        );
        v_item := jsonb_set(
          v_item,
          '{received_count}',
          to_jsonb(coalesce((v_item ->> 'received_count')::integer, 0) + 1),
          true
        );
        v_item := jsonb_set(
          v_item,
          '{received_quantity}',
          to_jsonb(coalesce((v_item ->> 'received_quantity')::numeric, 0) + v_quantity),
          true
        );
        v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);
      else
        v_receipt_result := null;
        begin
          v_receipt_result := public.execute_tan_tao_warehouse_command(
            p_command_type => 'receipt',
            p_idempotency_key => 'auto-receipt:' || v_supplier.document_id::text,
            p_quantity => v_quantity,
            p_reference_label => v_supplier.reference_label,
            p_reference_type => coalesce(v_supplier.reference_type, 'auto_ledger'),
            p_reference_id => v_supplier.reference_id,
            p_source_document_number => v_supplier.document_number,
            p_note => 'Tự nhập theo ngày giao ' || v_business_date::text
          );
        exception when others then
          if sqlerrm like '%fully_received_supplier_order%'
             or sqlerrm like '%receipt_exceeds_remaining%' then
            v_reason := 'already_received';
          else
            v_reason := 'receipt_failed';
          end if;
        end;

        if v_reason is null and coalesce(v_receipt_result ->> 'status', '') = 'existing' then
          v_reason := 'already_received';
        end if;

        if v_reason is null then
          insert into public.tan_tao_auto_ledger_events (
            run_id, document_id, reservation_id, action, quantity, business_date, reason
          ) values (
            v_run_id, v_supplier.document_id, null,
            'received', v_quantity, v_business_date, null
          )
          on conflict (action, coalesce(reservation_id, document_id)) do nothing;

          v_received_count := v_received_count + 1;
          v_received_quantity := v_received_quantity + v_quantity;
          v_item := coalesce(
            v_items -> v_sku_code,
            jsonb_build_object(
              'sku_code', v_sku_code,
              'cutover_date', v_cutover,
              'received_count', 0,
              'received_quantity', 0,
              'dispatched_count', 0,
              'dispatched_quantity', 0,
              'closed_quantity', 0,
              'skipped_count', 0,
              'skipped_by_reason', '{}'::jsonb
            )
          );
          v_item := jsonb_set(
            v_item,
            '{received_count}',
            to_jsonb(coalesce((v_item ->> 'received_count')::integer, 0) + 1),
            true
          );
          v_item := jsonb_set(
            v_item,
            '{received_quantity}',
            to_jsonb(coalesce((v_item ->> 'received_quantity')::numeric, 0) + v_quantity),
            true
          );
          v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);
        end if;
      end if;
    end if;

    if v_reason is not null then
      v_skipped_count := v_skipped_count + 1;
      v_skipped_reasons := jsonb_set(
        v_skipped_reasons,
        array[v_reason],
        to_jsonb(coalesce((v_skipped_reasons ->> v_reason)::integer, 0) + 1),
        true
      );
      v_item := coalesce(
        v_items -> v_sku_code,
        jsonb_build_object(
          'sku_code', v_sku_code,
          'cutover_date', v_cutover,
          'received_count', 0,
          'received_quantity', 0,
          'dispatched_count', 0,
          'dispatched_quantity', 0,
          'closed_quantity', 0,
          'skipped_count', 0,
          'skipped_by_reason', '{}'::jsonb
        )
      );
      v_item := jsonb_set(
        v_item,
        '{skipped_count}',
        to_jsonb(coalesce((v_item ->> 'skipped_count')::integer, 0) + 1),
        true
      );
      v_item := jsonb_set(
        v_item,
        array['skipped_by_reason', v_reason],
        to_jsonb(coalesce((v_item #>> array['skipped_by_reason', v_reason])::integer, 0) + 1),
        true
      );
      v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);

      if not p_dry_run then
        insert into public.tan_tao_auto_ledger_events (
          run_id, document_id, reservation_id, action, quantity, business_date, reason
        ) values (
          v_run_id, v_supplier.document_id, null,
          'skipped', v_supplier.quantity, v_business_date, v_reason
        )
        on conflict (action, coalesce(reservation_id, document_id)) do nothing;
      end if;
    end if;
  end loop;

  -- Then dispatch every active reservation of a non-cancelled source.
  for v_reservation in
    select
      r.id as reservation_id,
      r.document_id,
      r.sku_id,
      r.quantity,
      r.source_type,
      r.source_id,
      d.document_number,
      d.status as document_status,
      d.reference_type,
      d.reference_id,
      d.reference_label,
      d.sku_code_snapshot,
      public.tan_tao_auto_ledger_business_date(d.id) as auto_business_date
    from public.tan_tao_warehouse_reservations r
    join public.tan_tao_warehouse_documents d on d.id = r.document_id
    where r.status = 'active'
    order by public.tan_tao_auto_ledger_business_date(d.id) nulls last, r.id
    for update of r, d
  loop
    v_sku_code := coalesce(v_reservation.sku_code_snapshot, 'BMQ-001');
    v_business_date := v_reservation.auto_business_date;
    v_cutover := public.tan_tao_auto_ledger_cutover(v_reservation.sku_id);
    v_reason := null;

    if v_business_date is null then
      v_reason := 'missing_business_date';
    elsif v_cutover is null then
      v_reason := 'cutover_not_set';
    elsif v_business_date <= v_cutover then
      v_reason := 'before_cutover';
    elsif v_business_date > v_as_of then
      continue;
    end if;

    if v_reason is null and v_reservation.document_status in ('cancelled', 'closed') then
      v_reason := 'cancelled_order';
    end if;

    if v_reason is null then
      v_source_id := coalesce(v_reservation.reference_id, v_reservation.source_id);
      if v_reservation.reference_type = 'dealer_order'
         or v_reservation.source_type = 'dealer_order' then
        v_order_status := null;
        v_order_is_test := false;
        select o.status, o.is_test into v_order_status, v_order_is_test
        from public.dealer_orders o
        where o.id = v_source_id;
        if not found then
          v_reason := 'missing_source_document';
        elsif v_order_status = 'cancelled' then
          v_reason := 'cancelled_order';
        elsif coalesce(v_order_is_test, false) then
          v_reason := 'test_order';
        end if;
      elsif v_reservation.reference_type = 'warehouse_kiosk_bread_dispatch'
         or v_reservation.source_type = 'warehouse_kiosk_bread_dispatch' then
        v_notice_status := null;
        select n.status into v_notice_status
        from public.dealer_order_notifications n
        where n.id = v_source_id;
        if found and v_notice_status = 'cancelled' then
          v_reason := 'cancelled_order';
        end if;
      end if;
    end if;

    if v_reason is null and p_dry_run then
      v_dispatched_count := v_dispatched_count + 1;
      v_dispatched_quantity := v_dispatched_quantity + v_reservation.quantity;
      v_item := coalesce(
        v_items -> v_sku_code,
        jsonb_build_object(
          'sku_code', v_sku_code,
          'cutover_date', v_cutover,
          'received_count', 0,
          'received_quantity', 0,
          'dispatched_count', 0,
          'dispatched_quantity', 0,
          'closed_quantity', 0,
          'skipped_count', 0,
          'skipped_by_reason', '{}'::jsonb
        )
      );
      v_item := jsonb_set(
        v_item,
        '{dispatched_count}',
        to_jsonb(coalesce((v_item ->> 'dispatched_count')::integer, 0) + 1),
        true
      );
      v_item := jsonb_set(
        v_item,
        '{dispatched_quantity}',
        to_jsonb(coalesce((v_item ->> 'dispatched_quantity')::numeric, 0) + v_reservation.quantity),
        true
      );
      v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);
    elsif v_reason is null then
      v_dispatch_result := null;
      begin
        v_dispatch_result := public.execute_tan_tao_warehouse_command(
          p_command_type => 'dispatch',
          p_idempotency_key => 'auto-dispatch:' || v_reservation.reservation_id::text,
          p_reference_label => v_reservation.reference_label,
          p_reference_type => coalesce(v_reservation.reference_type, 'auto_ledger'),
          p_reference_id => v_reservation.reference_id,
          p_source_document_number => v_reservation.document_number,
          p_note => 'Tự xuất theo ngày giao ' || v_business_date::text
        );
      exception when others then
        if sqlerrm like '%insufficient_on_hand_stock%' then
          v_reason := 'insufficient_stock';
        elsif sqlerrm like '%active_reservation_not_found%' then
          v_reason := 'already_dispatched';
        else
          v_reason := 'dispatch_failed';
        end if;
      end;

      if v_reason is null and coalesce(v_dispatch_result ->> 'status', '') = 'existing' then
        v_reason := 'already_dispatched';
      end if;

      if v_reason is null then
        insert into public.tan_tao_auto_ledger_events (
          run_id, document_id, reservation_id, action, quantity, business_date, reason
        ) values (
          v_run_id, v_reservation.document_id, v_reservation.reservation_id,
          'dispatched', v_reservation.quantity, v_business_date, null
        )
        on conflict (action, coalesce(reservation_id, document_id)) do nothing;

        v_dispatched_count := v_dispatched_count + 1;
        v_dispatched_quantity := v_dispatched_quantity + v_reservation.quantity;
        v_item := coalesce(
          v_items -> v_sku_code,
          jsonb_build_object(
            'sku_code', v_sku_code,
            'cutover_date', v_cutover,
            'received_count', 0,
            'received_quantity', 0,
            'dispatched_count', 0,
            'dispatched_quantity', 0,
            'closed_quantity', 0,
            'skipped_count', 0,
            'skipped_by_reason', '{}'::jsonb
          )
        );
        v_item := jsonb_set(
          v_item,
          '{dispatched_count}',
          to_jsonb(coalesce((v_item ->> 'dispatched_count')::integer, 0) + 1),
          true
        );
        v_item := jsonb_set(
          v_item,
          '{dispatched_quantity}',
          to_jsonb(coalesce((v_item ->> 'dispatched_quantity')::numeric, 0) + v_reservation.quantity),
          true
        );
        v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);
      end if;
    end if;

    if v_reason is not null then
      v_skipped_count := v_skipped_count + 1;
      v_skipped_reasons := jsonb_set(
        v_skipped_reasons,
        array[v_reason],
        to_jsonb(coalesce((v_skipped_reasons ->> v_reason)::integer, 0) + 1),
        true
      );
      v_item := coalesce(
        v_items -> v_sku_code,
        jsonb_build_object(
          'sku_code', v_sku_code,
          'cutover_date', v_cutover,
          'received_count', 0,
          'received_quantity', 0,
          'dispatched_count', 0,
          'dispatched_quantity', 0,
          'closed_quantity', 0,
          'skipped_count', 0,
          'skipped_by_reason', '{}'::jsonb
        )
      );
      v_item := jsonb_set(
        v_item,
        '{skipped_count}',
        to_jsonb(coalesce((v_item ->> 'skipped_count')::integer, 0) + 1),
        true
      );
      v_item := jsonb_set(
        v_item,
        array['skipped_by_reason', v_reason],
        to_jsonb(coalesce((v_item #>> array['skipped_by_reason', v_reason])::integer, 0) + 1),
        true
      );
      v_items := jsonb_set(v_items, array[v_sku_code], v_item, true);

      if not p_dry_run then
        insert into public.tan_tao_auto_ledger_events (
          run_id, document_id, reservation_id, action, quantity, business_date, reason
        ) values (
          v_run_id, v_reservation.document_id, v_reservation.reservation_id,
          'skipped', v_reservation.quantity, v_business_date, v_reason
        )
        on conflict (action, coalesce(reservation_id, document_id)) do nothing;
      end if;
    end if;
  end loop;

  select coalesce(jsonb_agg(entry.value order by entry.value ->> 'sku_code'), '[]'::jsonb)
  into v_items_array
  from jsonb_each(v_items) entry;

  v_result := jsonb_build_object(
    'mode', 'daily',
    'as_of', v_as_of,
    'dry_run', p_dry_run,
    'received_count', v_received_count,
    'received_quantity', v_received_quantity,
    'dispatched_count', v_dispatched_count,
    'dispatched_quantity', v_dispatched_quantity,
    'closed_count', 0,
    'skipped_count', v_skipped_count,
    'skipped_by_reason', v_skipped_reasons,
    'on_hand_delta', v_received_quantity - v_dispatched_quantity,
    'items', v_items_array,
    'run_id', v_run_id
  );

  if not p_dry_run then
    update public.tan_tao_auto_ledger_runs
    set result = v_result
    where id = v_run_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.run_tan_tao_daily_ledger(date, boolean) from public, anon, authenticated;
grant execute on function public.run_tan_tao_daily_ledger(date, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Owner-readable status
-- ---------------------------------------------------------------------------

create or replace function public.get_tan_tao_auto_ledger_status(p_limit integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 14), 1), 100);
  v_runs jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (
       public.has_role((select auth.uid()), 'owner'::public.app_role)
       or public.can_view_tan_tao_warehouse()
     ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', recent.id,
      'run_date', recent.run_date,
      'mode', recent.mode,
      'dry_run', recent.dry_run,
      'created_by', recent.created_by,
      'created_at', recent.created_at,
      'result', recent.result,
      'totals', coalesce(recent.result -> 'items', '[]'::jsonb)
    ) order by recent.created_at desc, recent.id desc
  ), '[]'::jsonb)
  into v_runs
  from (
    select r.*
    from public.tan_tao_auto_ledger_runs r
    order by r.created_at desc, r.id desc
    limit v_limit
  ) recent;

  return jsonb_build_object(
    'generated_at', now(),
    'limit', v_limit,
    'runs', v_runs
  );
end;
$$;

revoke all on function public.get_tan_tao_auto_ledger_status(integer) from public, anon, authenticated;
grant execute on function public.get_tan_tao_auto_ledger_status(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Daily schedule at 22:00 Asia/Ho_Chi_Minh (15:00 UTC)
-- ---------------------------------------------------------------------------

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'tan-tao-daily-ledger'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'tan-tao-daily-ledger',
    '0 15 * * *',
    $job$ select public.run_tan_tao_daily_ledger(); $job$
  );
end;
$$;
