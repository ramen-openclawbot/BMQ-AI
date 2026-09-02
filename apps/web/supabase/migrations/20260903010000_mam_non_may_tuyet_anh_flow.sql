-- Add the approved Mầm non May price and reserve exact customer demand
-- from a sent Tuyết Anh daily bread order. Supplier rounding remains incoming
-- stock only until Kho Tân Tạo posts a physical receipt.

do $price$
declare
  v_customer_id uuid;
  v_sku_id uuid;
  v_existing_price numeric;
  v_price_id uuid;
begin
  select id into v_customer_id
  from public.mini_crm_customers
  where lower(btrim(customer_name)) = lower('Mầm non May')
  order by created_at asc
  limit 1;
  if v_customer_id is null then
    raise exception 'Mầm non May customer is not configured' using errcode = 'P0002';
  end if;

  select id into v_sku_id
  from public.product_skus
  where upper(btrim(sku_code)) = 'BMQ-001'
  order by created_at asc
  limit 1;
  if v_sku_id is null then
    raise exception 'BMQ-001 is not configured' using errcode = 'P0002';
  end if;

  select id, price_vnd_per_unit into v_price_id, v_existing_price
  from public.mini_crm_customer_price_list
  where customer_id = v_customer_id and sku_id = v_sku_id and is_active = true
  for update;

  if v_price_id is null then
    insert into public.mini_crm_customer_price_list (
      customer_id, sku_id, price_vnd_per_unit, currency, is_active
    ) values (
      v_customer_id, v_sku_id, 6500, 'VND', true
    ) returning id into v_price_id;

    insert into public.audit_logs (action, target_id, metadata)
    values (
      'mam_non_may_bmq001_price_approved',
      v_price_id,
      jsonb_build_object(
        'target_type', 'mini_crm_customer_price_list',
        'customer_id', v_customer_id,
        'sku_code', 'BMQ-001',
        'price_vnd_per_unit', 6500,
        'currency', 'VND',
        'approved_by_owner_chat', true,
        'recorded_at', now()
      )
    );
  elsif v_existing_price <> 6500 then
    raise exception 'Mầm non May has a conflicting active BMQ-001 price: %', v_existing_price using errcode = '23514';
  end if;
end
$price$;

create or replace function public.sync_tan_tao_mam_non_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mam_non jsonb;
  v_ordered_quantity numeric := 0;
  v_supplier_order_quantity numeric := 0;
  v_warehouse_surplus_quantity numeric := 0;
  v_sku_id uuid;
  v_document_id uuid;
  v_document_number text;
begin
  if new.status <> 'sent' or (tg_op = 'UPDATE' and old.status = 'sent') then
    return new;
  end if;
  if new.notification_type <> 'production_bread_order' then
    return new;
  end if;

  v_mam_non := coalesce(new.source_snapshot -> 'mam_non', '{}'::jsonb);
  if v_mam_non ->> 'rule' <> 'mam_non_may_bread_order'
     or v_mam_non ->> 'customer_name' <> 'Mầm non May'
     or upper(coalesce(v_mam_non ->> 'sku_code', '')) <> 'BMQ-001' then
    return new;
  end if;
  if coalesce(v_mam_non ->> 'ordered_quantity', '') !~ '^\d+(\.\d+)?$'
     or coalesce(v_mam_non ->> 'supplier_order_quantity', '') !~ '^\d+(\.\d+)?$'
     or coalesce(v_mam_non ->> 'warehouse_surplus_quantity', '') !~ '^\d+(\.\d+)?$' then
    raise exception 'invalid Mầm non quantity snapshot' using errcode = '22023';
  end if;

  v_ordered_quantity := (v_mam_non ->> 'ordered_quantity')::numeric;
  v_supplier_order_quantity := (v_mam_non ->> 'supplier_order_quantity')::numeric;
  v_warehouse_surplus_quantity := (v_mam_non ->> 'warehouse_surplus_quantity')::numeric;
  if v_ordered_quantity <= 0 then
    return new;
  end if;
  if v_supplier_order_quantity < v_ordered_quantity
     or v_warehouse_surplus_quantity <> v_supplier_order_quantity - v_ordered_quantity then
    raise exception 'inconsistent Mầm non supplier rounding snapshot' using errcode = '23514';
  end if;

  select id into v_sku_id
  from public.product_skus
  where upper(btrim(sku_code)) = 'BMQ-001'
  order by created_at asc
  limit 1;
  if v_sku_id is null then
    raise exception 'BMQ-001 is not configured' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('warehouse_tan_tao:BMQ-001', 0));
  v_document_number := 'TT-OUT-' || to_char(
    coalesce(new.digest_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date),
    'YYYYMMDD'
  ) || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into public.tan_tao_warehouse_documents (
    document_number, sku_id, document_type, status, quantity,
    ordered_quantity, exchange_quantity, makeup_quantity, physical_quantity,
    source_authority, reference_type, reference_id, reference_label,
    idempotency_key, note, metadata
  ) values (
    v_document_number, v_sku_id, 'outbound_order', 'reserved', v_ordered_quantity,
    v_ordered_quantity, 0, 0, v_ordered_quantity,
    'parsed_customer_po_email', 'customer_po_email', new.id, 'Mầm non May',
    'mam-non-customer-po:' || new.id::text || ':BMQ-001',
    'Giữ đúng số khách đặt; phần làm tròn chỉ thành tồn sau phiếu nhập thực tế',
    jsonb_build_object(
      'notification_id', new.id,
      'rule', 'mam_non_may_bread_order',
      'ordered_quantity', v_ordered_quantity,
      'supplier_order_quantity', v_supplier_order_quantity,
      'warehouse_surplus_quantity', v_warehouse_surplus_quantity,
      'billable_quantity', v_ordered_quantity,
      'stock_effect', 'reservation_only',
      'inbox_ids', coalesce(v_mam_non -> 'inbox_ids', '[]'::jsonb),
      'gmail_message_ids', coalesce(v_mam_non -> 'gmail_message_ids', '[]'::jsonb)
    )
  )
  on conflict (idempotency_key) do nothing
  returning id into v_document_id;

  if v_document_id is not null then
    insert into public.tan_tao_warehouse_reservations (
      document_id, sku_id, quantity, status, source_type, source_id
    ) values (
      v_document_id, v_sku_id, v_ordered_quantity, 'active', 'customer_po_email', new.id
    );
  end if;

  return new;
end;
$$;

revoke all on function public.sync_tan_tao_mam_non_reservation() from public, anon, authenticated;

drop trigger if exists tan_tao_mam_non_reservation_trigger on public.dealer_order_notifications;
create trigger tan_tao_mam_non_reservation_trigger
after insert or update on public.dealer_order_notifications
for each row execute function public.sync_tan_tao_mam_non_reservation();
