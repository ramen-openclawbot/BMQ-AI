-- Atomically suppress stale/concurrent retail fast orders for an already-used delivery date.
-- Keep ordinary and NPP submissions on the existing duplicate-warning contract.

drop function if exists public.submit_dealer_order_guarded(
  uuid, uuid, uuid, uuid, text, text, text, timestamptz, date,
  text, text, jsonb, numeric, numeric, jsonb, text
);

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
begin
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
    order_fingerprint
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
    p_order_fingerprint
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
