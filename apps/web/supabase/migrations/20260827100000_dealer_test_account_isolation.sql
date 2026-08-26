-- Server-authoritative isolation for the approved dealer test contact.
-- Test orders remain visible only to the test contact and never enter operations.

alter table public.dealer_customer_contacts
  add column if not exists is_test boolean not null default false;

alter table public.dealer_orders
  add column if not exists is_test boolean not null default false;

comment on column public.dealer_customer_contacts.is_test is
  'Server-managed test-login marker; never inferred from browser input.';
comment on column public.dealer_orders.is_test is
  'Immutable-at-source test-order marker derived from the authenticated contact.';

create or replace function public.guard_dealer_test_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approved_id constant uuid := '7f91aba5-9f55-495d-9db7-d52b1e3787b8'::uuid;
  v_approved_customer_id constant uuid := 'a2972d83-f60e-4f2f-ad5d-fcec67c11603'::uuid;
  v_approved_phone constant text := '84966998998';
begin
  if tg_op = 'DELETE' then
    if old.id = v_approved_id
       or old.is_test = true then
      raise exception 'approved_dealer_test_contact_protected' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and old.is_test = true
     and (
       new.id is distinct from old.id
       or new.customer_id is distinct from old.customer_id
       or new.phone_normalized is distinct from old.phone_normalized
       or new.is_active is distinct from true
     ) then
    raise exception 'approved_dealer_test_contact_protected' using errcode = '42501';
  end if;

  new.is_test := (
    new.id = v_approved_id
    and new.customer_id = v_approved_customer_id
    and new.phone_normalized = v_approved_phone
    and new.is_active = true
  );
  return new;
end;
$$;

revoke all on function public.guard_dealer_test_contact() from public, anon, authenticated;

drop trigger if exists guard_dealer_test_contact_trigger on public.dealer_customer_contacts;
create trigger guard_dealer_test_contact_trigger
before insert or update or delete on public.dealer_customer_contacts
for each row execute function public.guard_dealer_test_contact();

do $$
declare
  v_updated integer := 0;
begin
  update public.dealer_customer_contacts
  set is_test = true, updated_at = now()
  where id = '7f91aba5-9f55-495d-9db7-d52b1e3787b8'::uuid
    and customer_id = 'a2972d83-f60e-4f2f-ad5d-fcec67c11603'::uuid
    and phone_normalized = '84966998998'
    and is_active = true;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'approved_dealer_test_contact_not_found' using errcode = 'P0002';
  end if;
end;
$$;

update public.dealer_orders o
set is_test = true
from public.dealer_customer_contacts c
where c.id = o.contact_id
  and c.customer_id = o.customer_id
  and c.is_test = true
  and o.is_test = false;

do $$
begin
  if exists (
    select 1
    from public.tan_tao_warehouse_movements m
    join public.tan_tao_warehouse_documents d on d.id = m.document_id
    where exists (
      select 1
      from public.dealer_orders o
      where o.is_test = true
        and (
          (d.reference_type = 'dealer_order' and d.reference_id = o.id)
          or d.source_document_id in (
            select source.id
            from public.tan_tao_warehouse_documents source
            where source.reference_type = 'dealer_order'
              and source.reference_id = o.id
          )
        )
    )
  ) then
    raise exception 'test_order_has_posted_tan_tao_movement' using errcode = '23514';
  end if;
end;
$$;

update public.dealer_order_notifications n
set status = 'failed',
    attempt_count = n.max_attempts,
    locked_at = null,
    last_error = 'test_order_isolation',
    updated_at = now()
from public.dealer_orders o
where o.id = n.order_id
  and o.is_test = true
  and n.status in ('pending', 'processing');

update public.dealer_customer_order_confirmations n
set status = 'suppressed',
    locked_at = null,
    last_error = 'test_order_isolation',
    updated_at = now()
from public.dealer_orders o
where o.id = n.order_id
  and o.is_test = true
  and n.status in ('pending', 'processing', 'send_committed');

update public.tan_tao_warehouse_reservations r
set status = 'cancelled',
    released_at = now()
from public.tan_tao_warehouse_documents d,
     public.dealer_orders o
where d.id = r.document_id
  and d.reference_type = 'dealer_order'
  and d.reference_id = o.id
  and o.is_test = true
  and r.status = 'active';

update public.tan_tao_warehouse_documents d
set status = 'cancelled',
    metadata = d.metadata || jsonb_build_object(
      'test_order_isolation', true,
      'isolated_at', now()
    )
from public.dealer_orders o
where d.reference_type = 'dealer_order'
  and d.reference_id = o.id
  and o.is_test = true
  and d.status = 'reserved';

create index if not exists dealer_orders_customer_test_submitted_idx
  on public.dealer_orders (customer_id, is_test, submitted_at desc);

drop index if exists public.dealer_orders_client_submission_uidx;
create unique index dealer_orders_client_submission_uidx
  on public.dealer_orders (customer_id, is_test, client_submission_id)
  where client_submission_id is not null;

create or replace function public.derive_dealer_order_test_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_is_test boolean;
begin
  if new.contact_id is null then
    new.is_test := false;
    return new;
  end if;

  select c.is_test
    into v_contact_is_test
  from public.dealer_customer_contacts c
  where c.id = new.contact_id
    and c.customer_id = new.customer_id;

  if not found then
    raise exception 'dealer_order_contact_customer_mismatch' using errcode = '23514';
  end if;

  new.is_test := coalesce(v_contact_is_test, false);
  return new;
end;
$$;

revoke all on function public.derive_dealer_order_test_flag() from public, anon, authenticated;

drop trigger if exists derive_dealer_order_test_flag_trigger on public.dealer_orders;
create trigger derive_dealer_order_test_flag_trigger
before insert or update of contact_id, customer_id, is_test on public.dealer_orders
for each row execute function public.derive_dealer_order_test_flag();

create or replace function public.submit_dealer_order_guarded(
  p_customer_id uuid,
  p_contact_id uuid,
  p_session_id uuid,
  p_client_submission_id uuid,
  p_order_fingerprint text,
  p_duplicate_action text,
  p_order_number text,
  p_submitted_at timestamptz,
  p_requested_delivery_date date,
  p_delivery_note text,
  p_customer_note text,
  p_customer_snapshot jsonb,
  p_subtotal_amount_vnd numeric,
  p_total_amount_vnd numeric,
  p_lines jsonb,
  p_notification_body text,
  p_require_empty_delivery_date boolean default false
)
returns table (
  result text,
  order_id uuid,
  order_number text,
  submitted_at timestamptz,
  total_amount_vnd numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.dealer_orders%rowtype;
  v_order public.dealer_orders%rowtype;
  v_line jsonb;
  v_is_test boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select c.is_test
    into v_is_test
  from public.dealer_customer_contacts c
  where c.id = p_contact_id
    and c.customer_id = p_customer_id
    and c.is_active;
  if not found then
    raise exception 'dealer_order_contact_customer_mismatch' using errcode = '23514';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id_required';
  end if;
  if coalesce(length(p_order_fingerprint), 0) <> 64 then
    raise exception 'invalid_order_fingerprint';
  end if;
  if p_duplicate_action is not null
     and p_duplicate_action not in ('add', 'continue') then
    raise exception 'invalid_duplicate_action';
  end if;
  if jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1
     or jsonb_array_length(p_lines) > 200 then
    raise exception 'invalid_order_lines';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_customer_id::text, 0)
  );

  select o.*
    into v_existing
  from public.dealer_orders o
  where o.customer_id = p_customer_id
    and o.client_submission_id = p_client_submission_id
    and o.is_test = v_is_test
  limit 1;

  if found then
    return query select
      'existing'::text,
      v_existing.id,
      v_existing.order_number,
      v_existing.submitted_at,
      v_existing.total_amount_vnd;
    return;
  end if;

  if p_require_empty_delivery_date then
    select o.*
      into v_existing
    from public.dealer_orders o
    where o.customer_id = p_customer_id
      and o.requested_delivery_date = p_requested_delivery_date
      and o.is_test = v_is_test
      and o.status <> 'cancelled'
    order by o.submitted_at desc
    limit 1
    for update;

    if found then
      return query select
        'target_date_exists'::text,
        v_existing.id,
        v_existing.order_number,
        v_existing.submitted_at,
        v_existing.total_amount_vnd;
      return;
    end if;
  end if;

  select o.*
    into v_existing
  from public.dealer_orders o
  where o.customer_id = p_customer_id
    and o.order_fingerprint = p_order_fingerprint
    and o.is_test = v_is_test
    and o.status <> 'cancelled'
    and o.submitted_at >= p_submitted_at - interval '30 minutes'
    and o.submitted_at <= p_submitted_at + interval '30 minutes'
  order by o.submitted_at desc
  limit 1
  for update;

  if found
     and p_duplicate_action is distinct from 'add'
     and p_duplicate_action is distinct from 'continue' then
    return query select
      'duplicate'::text,
      v_existing.id,
      v_existing.order_number,
      v_existing.submitted_at,
      v_existing.total_amount_vnd;
    return;
  end if;

  insert into public.dealer_orders (
    order_number,
    customer_id,
    contact_id,
    session_id,
    status,
    currency,
    subtotal_amount_vnd,
    total_amount_vnd,
    requested_delivery_date,
    delivery_note,
    customer_note,
    customer_snapshot,
    submitted_at,
    client_submission_id,
    order_fingerprint,
    is_test
  ) values (
    p_order_number,
    p_customer_id,
    p_contact_id,
    p_session_id,
    'submitted',
    'VND',
    p_subtotal_amount_vnd,
    p_total_amount_vnd,
    p_requested_delivery_date,
    p_delivery_note,
    p_customer_note,
    coalesce(p_customer_snapshot, '{}'::jsonb),
    p_submitted_at,
    p_client_submission_id,
    p_order_fingerprint,
    v_is_test
  )
  returning * into v_order;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    insert into public.dealer_order_items (
      order_id,
      sku_id,
      sku_code,
      product_name,
      unit,
      quantity,
      ordered_quantity,
      exchange_quantity,
      makeup_quantity,
      physical_quantity,
      unit_price_vnd,
      line_total_vnd,
      price_source,
      route_customer_id,
      route_customer_name,
      route_note
    ) values (
      v_order.id,
      (v_line->>'sku_id')::uuid,
      v_line->>'sku_code',
      v_line->>'product_name',
      v_line->>'unit',
      (v_line->>'quantity')::numeric,
      (v_line->>'ordered_quantity')::numeric,
      coalesce((v_line->>'exchange_quantity')::numeric, 0),
      coalesce((v_line->>'makeup_quantity')::numeric, 0),
      (v_line->>'physical_quantity')::numeric,
      (v_line->>'unit_price_vnd')::numeric,
      (v_line->>'line_total_vnd')::numeric,
      v_line->>'price_source',
      nullif(v_line->>'route_customer_id', '')::uuid,
      nullif(v_line->>'route_customer_name', ''),
      nullif(v_line->>'route_note', '')
    );
  end loop;

  if not v_is_test then
    insert into public.dealer_order_notifications (
      order_id,
      notification_type,
      channel,
      group_name,
      message_body,
      status,
      next_attempt_at
    ) values (
      v_order.id,
      'order',
      'zalo_gmf',
      'BMQ - Kho Tân Tạo',
      p_notification_body,
      'pending',
      p_submitted_at
    );
  end if;

  return query select
    'created'::text,
    v_order.id,
    v_order.order_number,
    v_order.submitted_at,
    v_order.total_amount_vnd;
end;
$$;

revoke all on function public.submit_dealer_order_guarded(
  uuid, uuid, uuid, uuid, text, text, text, timestamptz, date,
  text, text, jsonb, numeric, numeric, jsonb, text, boolean
) from public, anon, authenticated;
grant execute on function public.submit_dealer_order_guarded(
  uuid, uuid, uuid, uuid, text, text, text, timestamptz, date,
  text, text, jsonb, numeric, numeric, jsonb, text, boolean
) to service_role;

create or replace function public.suppress_test_dealer_order_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.dealer_orders o
    where o.id = new.order_id and o.is_test = true
  ) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.suppress_test_dealer_order_notification() from public, anon, authenticated;

drop trigger if exists suppress_test_dealer_order_notification_trigger on public.dealer_order_notifications;
create trigger suppress_test_dealer_order_notification_trigger
before insert or update of order_id on public.dealer_order_notifications
for each row execute function public.suppress_test_dealer_order_notification();

create or replace function public.suppress_test_dealer_customer_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.dealer_orders o
    where o.id = new.order_id and o.is_test = true
  ) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.suppress_test_dealer_customer_confirmation() from public, anon, authenticated;

drop trigger if exists suppress_test_dealer_customer_confirmation_trigger on public.dealer_customer_order_confirmations;
create trigger suppress_test_dealer_customer_confirmation_trigger
before insert or update of order_id on public.dealer_customer_order_confirmations
for each row execute function public.suppress_test_dealer_customer_confirmation();

create or replace function public.sync_tan_tao_dealer_order_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku_id uuid;
  v_order public.dealer_orders;
  v_doc_id uuid;
  v_number text;
  v_ordered numeric := 0;
  v_exchange numeric := 0;
  v_makeup numeric := 0;
  v_physical numeric := 0;
begin
  if new.notification_type <> 'order' or new.order_id is null then return new; end if;
  select * into v_order from public.dealer_orders where id = new.order_id;
  if not found or v_order.status = 'cancelled' or v_order.is_test = true then return new; end if;
  select id into v_sku_id from public.product_skus where upper(sku_code) = 'BMQ-001' order by created_at asc limit 1;
  if v_sku_id is null then return new; end if;
  select
    coalesce(sum(coalesce(i.ordered_quantity, i.quantity, 0)), 0),
    coalesce(sum(i.exchange_quantity), 0),
    coalesce(sum(i.makeup_quantity), 0)
    into v_ordered, v_exchange, v_makeup
  from public.dealer_order_items i
  where i.order_id = new.order_id and upper(i.sku_code) = 'BMQ-001';
  v_physical := v_ordered + v_exchange + v_makeup;
  if v_physical <= 0 then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('warehouse_tan_tao:BMQ-001', 0));
  v_number := 'TT-OUT-' || to_char((now() at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  insert into public.tan_tao_warehouse_documents (
    document_number, sku_id, document_type, status, quantity, ordered_quantity,
    exchange_quantity, makeup_quantity, physical_quantity, source_authority,
    reference_type, reference_id, reference_label, idempotency_key, metadata
  ) values (
    v_number, v_sku_id, 'outbound_order', 'reserved', v_physical, v_ordered,
    v_exchange, v_makeup, v_physical, 'dealer_order_submit_outbox', 'dealer_order',
    new.order_id, coalesce(v_order.customer_snapshot->>'name', v_order.order_number),
    'dealer-order:' || new.order_id::text,
    jsonb_build_object('notification_id', new.id, 'billable_quantity', v_ordered, 'stock_effect', 'reservation_only')
  ) on conflict (idempotency_key) do nothing returning id into v_doc_id;
  if v_doc_id is not null then
    insert into public.tan_tao_warehouse_reservations (
      document_id, sku_id, quantity, status, source_type, source_id
    ) values (v_doc_id, v_sku_id, v_physical, 'active', 'dealer_order', new.order_id);
  end if;
  return new;
end;
$$;
revoke all on function public.sync_tan_tao_dealer_order_reservation() from public, anon, authenticated;

create or replace function public.claim_dealer_order_notifications(batch_size integer default 10)
returns table (
  id uuid,
  order_id uuid,
  channel text,
  group_name text,
  message_body text,
  attempt_count integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with selected as (
    select n.id
    from public.dealer_order_notifications n
    where n.channel = 'zalo_gmf'
      and (
        n.order_id is null
        or exists (
          select 1 from public.dealer_orders o
          where o.id = n.order_id and o.is_test = false
        )
      )
      and n.attempt_count < n.max_attempts
      and n.next_attempt_at <= now()
      and (
        n.status = 'pending'
        or (n.status = 'processing' and n.locked_at < now() - interval '15 minutes')
      )
    order by
      case when n.notification_type in (
        'daily_dealer_digest', 'daily_point_digest',
        'production_bread_order', 'warehouse_kiosk_bread_dispatch'
      ) then 0 else 1 end,
      n.created_at asc,
      n.notification_type asc
    for update skip locked
    limit greatest(1, least(coalesce(batch_size, 10), 50))
  ), updated as (
    update public.dealer_order_notifications n
    set status = 'processing',
        locked_at = now(),
        attempt_count = n.attempt_count + 1,
        updated_at = now()
    from selected
    where n.id = selected.id
    returning n.*
  )
  select
    updated.id, updated.order_id, updated.channel, updated.group_name,
    updated.message_body, updated.attempt_count, updated.max_attempts
  from updated
  order by
    case when updated.notification_type in (
      'daily_dealer_digest', 'daily_point_digest',
      'production_bread_order', 'warehouse_kiosk_bread_dispatch'
    ) then 0 else 1 end,
    updated.created_at asc,
    updated.notification_type asc;
end;
$$;
revoke all on function public.claim_dealer_order_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_dealer_order_notifications(integer) to service_role;

create or replace function public.claim_dealer_order_notification_by_id(p_notification_id uuid)
returns setof public.dealer_order_notifications
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  update public.dealer_order_notifications notification
  set status = 'processing',
      attempt_count = notification.attempt_count + 1,
      locked_at = now(),
      updated_at = now()
  where notification.id = p_notification_id
    and notification.notification_type = 'production_bread_order_correction'
    and notification.status = 'pending'
    and notification.next_attempt_at <= now()
    and coalesce((notification.source_snapshot->>'approved_by_owner')::boolean, false)
    and (
      notification.order_id is null
      or exists (
        select 1 from public.dealer_orders o
        where o.id = notification.order_id and o.is_test = false
      )
    )
  returning notification.*;
end;
$$;
revoke all on function public.claim_dealer_order_notification_by_id(uuid) from public, anon, authenticated;
grant execute on function public.claim_dealer_order_notification_by_id(uuid) to service_role;

create or replace function public.claim_dealer_customer_order_confirmations(batch_size integer default 10)
returns table (
  id uuid,
  order_id uuid,
  contact_id uuid,
  template_key text,
  payload jsonb,
  attempt_count integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.dealer_customer_order_confirmations n
  set status = 'suppressed',
      locked_at = null,
      last_error = case when o.is_test then 'test_order_isolation' else 'order_not_submitted_before_send' end,
      updated_at = now()
  from public.dealer_orders o
  where o.id = n.order_id
    and (o.status <> 'submitted' or o.is_test = true)
    and n.status in ('pending', 'processing', 'send_committed');

  return query
  with picked as (
    select n.id
    from public.dealer_customer_order_confirmations n
    join public.dealer_orders o on o.id = n.order_id
    where n.channel = 'zalo_zbs'
      and o.status = 'submitted'
      and o.is_test = false
      and n.contact_id is not null
      and n.attempt_count < n.max_attempts
      and n.next_attempt_at <= now()
      and n.status = 'pending'
    order by n.created_at asc
    for update of n skip locked
    limit greatest(1, least(coalesce(batch_size, 10), 50))
  ), claimed as (
    update public.dealer_customer_order_confirmations n
    set status = 'processing',
        attempt_count = n.attempt_count + 1,
        locked_at = now(),
        updated_at = now()
    from picked
    where n.id = picked.id
    returning n.*
  )
  select
    claimed.id, claimed.order_id, claimed.contact_id, claimed.template_key,
    claimed.payload, claimed.attempt_count, claimed.max_attempts
  from claimed;
end;
$$;
revoke all on function public.claim_dealer_customer_order_confirmations(integer) from public, anon, authenticated;
grant execute on function public.claim_dealer_customer_order_confirmations(integer) to service_role;

create or replace function public.commit_dealer_customer_order_confirmation_send(p_confirmation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  committed boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.dealer_customer_order_confirmations n
  set status = 'send_committed', updated_at = now()
  where n.id = p_confirmation_id
    and n.status = 'processing'
    and exists (
      select 1 from public.dealer_orders o
      where o.id = n.order_id
        and o.status = 'submitted'
        and o.is_test = false
    )
  returning true into committed;

  return coalesce(committed, false);
end;
$$;
revoke all on function public.commit_dealer_customer_order_confirmation_send(uuid) from public, anon, authenticated;
grant execute on function public.commit_dealer_customer_order_confirmation_send(uuid) to service_role;

drop function if exists public.dealer_order_history_summary(uuid, timestamptz, timestamptz);

create or replace function public.dealer_order_history_summary(
  p_customer_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_is_test boolean default false
)
returns table (
  order_count bigint,
  total_physical_quantity numeric,
  total_amount_vnd numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with filtered_orders as (
    select o.id, o.total_amount_vnd
    from public.dealer_orders o
    where o.customer_id = p_customer_id
      and o.is_test = p_is_test
      and o.status <> 'cancelled'
      and o.submitted_at >= p_start
      and o.submitted_at < p_end
  ),
  physical_by_order as (
    select
      i.order_id,
      sum(
        coalesce(
          i.physical_quantity,
          coalesce(i.ordered_quantity, i.quantity)
            + i.exchange_quantity
            + i.makeup_quantity
        )
      ) as physical_quantity
    from public.dealer_order_items i
    join filtered_orders o on o.id = i.order_id
    group by i.order_id
  )
  select
    count(*)::bigint as order_count,
    coalesce(sum(coalesce(p.physical_quantity, 0)), 0)::numeric as total_physical_quantity,
    coalesce(sum(o.total_amount_vnd), 0)::numeric as total_amount_vnd
  from filtered_orders o
  left join physical_by_order p on p.order_id = o.id;
$$;

revoke all on function public.dealer_order_history_summary(uuid, timestamptz, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.dealer_order_history_summary(uuid, timestamptz, timestamptz, boolean)
  to service_role;
