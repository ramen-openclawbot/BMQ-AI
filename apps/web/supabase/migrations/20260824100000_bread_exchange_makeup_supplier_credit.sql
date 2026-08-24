-- Route BMQ-001 dealer exchange/makeup through Tuyet Anh physical supply.
-- Quantity is auditable independently from value: actual invoice pricing is applied
-- later by accounting, while this ledger preserves the quantity credit basis.

alter table public.tan_tao_warehouse_documents
  add column if not exists supplier_billable_quantity numeric not null default 0,
  add column if not exists supplier_credit_quantity numeric not null default 0,
  add column if not exists supplier_exchange_quantity numeric not null default 0,
  add column if not exists supplier_makeup_quantity numeric not null default 0;

alter table public.tan_tao_warehouse_documents
  drop constraint if exists tan_tao_warehouse_documents_supplier_quantities_check;
alter table public.tan_tao_warehouse_documents
  add constraint tan_tao_warehouse_documents_supplier_quantities_check check (
    supplier_billable_quantity >= 0
    and supplier_credit_quantity >= 0
    and supplier_exchange_quantity >= 0
    and supplier_makeup_quantity >= 0
    and supplier_credit_quantity = supplier_exchange_quantity + supplier_makeup_quantity
  );

create or replace function public.get_tan_tao_warehouse_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sku_id uuid;
  on_hand_quantity numeric := 0;
  reserved_quantity numeric := 0;
  incoming_quantity numeric := 0;
  atp_quantity numeric := 0;
  v_recent_documents jsonb := '[]'::jsonb;
begin
  if not public.can_view_tan_tao_warehouse() then raise exception 'forbidden' using errcode = '42501'; end if;
  select id into v_sku_id from public.product_skus where upper(sku_code) = 'BMQ-001' order by created_at asc limit 1;
  if v_sku_id is null then raise exception 'BMQ-001 is not configured' using errcode = 'P0002'; end if;

  select coalesce(sum(m.quantity), 0) into on_hand_quantity
  from public.tan_tao_warehouse_movements m where m.location_code = 'warehouse_tan_tao' and m.sku_id = v_sku_id;
  select coalesce(sum(r.quantity), 0) into reserved_quantity
  from public.tan_tao_warehouse_reservations r where r.location_code = 'warehouse_tan_tao' and r.sku_id = v_sku_id and r.status = 'active';
  select coalesce(sum(greatest(d.quantity - coalesce(received.received_quantity, 0), 0)), 0) into incoming_quantity
  from public.tan_tao_warehouse_documents d
  left join lateral (
    select sum(rd.quantity) as received_quantity from public.tan_tao_warehouse_documents rd
    where rd.source_document_id = d.id and rd.document_type = 'receipt' and rd.status = 'posted'
  ) received on true
  where d.location_code = 'warehouse_tan_tao' and d.sku_id = v_sku_id and d.document_type = 'supplier_order' and d.status = 'expected';
  atp_quantity := on_hand_quantity - reserved_quantity;

  select coalesce(jsonb_agg(to_jsonb(recent_row) order by recent_row.created_at desc), '[]'::jsonb) into v_recent_documents
  from (
    select d.id, d.document_number, d.document_type, d.status, d.quantity, d.ordered_quantity,
           d.exchange_quantity, d.makeup_quantity, d.physical_quantity,
           d.supplier_billable_quantity, d.supplier_credit_quantity,
           d.supplier_exchange_quantity, d.supplier_makeup_quantity,
           d.reference_label, d.note, d.created_at
    from public.tan_tao_warehouse_documents d
    where d.location_code = 'warehouse_tan_tao' and d.sku_id = v_sku_id order by d.created_at desc limit 30
  ) recent_row;

  return jsonb_build_object(
    'location_code', 'warehouse_tan_tao', 'location_name', 'Kho Tân Tạo', 'sku_id', v_sku_id,
    'sku_code', 'BMQ-001', 'unit', 'que', 'on_hand_quantity', on_hand_quantity,
    'reserved_quantity', reserved_quantity, 'atp_quantity', atp_quantity, 'incoming_quantity', incoming_quantity,
    'projected_quantity', on_hand_quantity + incoming_quantity - reserved_quantity,
    'needs_attention', atp_quantity < 0, 'recent_documents', v_recent_documents
  );
end;
$$;
revoke all on function public.get_tan_tao_warehouse_snapshot() from public, anon;
grant execute on function public.get_tan_tao_warehouse_snapshot() to authenticated, service_role;

create or replace function public.sync_tan_tao_sent_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_sku_id uuid; v_doc_id uuid; v_number text; v_qty numeric:=0;
  v_ordered numeric:=0; v_exchange numeric:=0; v_makeup numeric:=0; v_physical numeric:=0;
  v_supplier_exchange numeric:=0; v_supplier_makeup numeric:=0;
  v_supplier_credit numeric:=0; v_supplier_billable numeric:=0;
begin
  if new.status<>'sent' or (tg_op='UPDATE' and old.status='sent') then return new; end if;
  if new.notification_type not in ('production_bread_order','warehouse_kiosk_bread_dispatch') then return new; end if;
  select id into v_sku_id from public.product_skus where upper(sku_code)='BMQ-001' order by created_at asc limit 1;
  if v_sku_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('warehouse_tan_tao:BMQ-001',0));
  if new.notification_type='production_bread_order' then
    v_qty:=coalesce(nullif(new.source_snapshot #>> '{rounding,total_bmq,sent_quantity}','')::numeric,0);
    v_supplier_exchange:=coalesce(nullif(new.source_snapshot #>> '{supplier,exchange_quantity}','')::numeric,0);
    v_supplier_makeup:=coalesce(nullif(new.source_snapshot #>> '{supplier,makeup_quantity}','')::numeric,0);
    v_supplier_credit:=coalesce(
      nullif(new.source_snapshot #>> '{supplier,credit_quantity}','')::numeric,
      v_supplier_exchange + v_supplier_makeup
    );
    v_supplier_billable:=coalesce(
      nullif(new.source_snapshot #>> '{supplier,billable_quantity}','')::numeric,
      greatest(v_qty-v_supplier_credit,0)
    );
    if v_qty<=0 then return new; end if;
    if v_supplier_credit<>v_supplier_exchange+v_supplier_makeup
      or v_supplier_billable+v_supplier_credit<>v_qty then
      raise exception 'invalid_supplier_credit_quantity_contract' using errcode='22023';
    end if;
    v_number:='TT-SUP-'||to_char(coalesce(new.digest_date,(now() at time zone 'Asia/Ho_Chi_Minh')::date),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
    insert into public.tan_tao_warehouse_documents (
      document_number,sku_id,document_type,status,quantity,physical_quantity,
      supplier_billable_quantity,supplier_credit_quantity,supplier_exchange_quantity,supplier_makeup_quantity,
      source_authority,reference_type,reference_id,reference_label,idempotency_key,metadata
    ) values (
      v_number,v_sku_id,'supplier_order','expected',v_qty,v_qty,
      v_supplier_billable,v_supplier_credit,v_supplier_exchange,v_supplier_makeup,
      'sent_supplier_notification','production_bread_order',new.id,'BMQ - HKD Tuyết Anh','supplier-notification:'||new.id::text,
      jsonb_build_object(
        'digest_date',new.digest_date,
        'stock_effect','incoming_only',
        'supplier_credit_handling','ordered_from_supplier_and_credited_to_bakery_payable'
      )
    ) on conflict (idempotency_key) do nothing;
  else
    select coalesce(sum(coalesce(nullif(x->>'orderQuantity','')::numeric,0))),coalesce(sum(coalesce(nullif(x->>'shortageQuantity','')::numeric,0))),coalesce(sum(coalesce(nullif(x->>'returnsQuantity','')::numeric,0)+coalesce(nullif(x->>'wasteQuantity','')::numeric,0)))
      into v_ordered,v_makeup,v_exchange from jsonb_array_elements(coalesce(new.source_snapshot->'locations','[]'::jsonb)) x;
    v_physical:=v_ordered+v_exchange+v_makeup; if v_physical<=0 then return new; end if;
    v_number:='TT-OUT-'||to_char(coalesce(new.digest_date,(now() at time zone 'Asia/Ho_Chi_Minh')::date),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
    insert into public.tan_tao_warehouse_documents (document_number,sku_id,document_type,status,quantity,ordered_quantity,exchange_quantity,makeup_quantity,physical_quantity,source_authority,reference_type,reference_id,reference_label,idempotency_key,metadata)
    values (v_number,v_sku_id,'outbound_order','reserved',v_physical,v_ordered,v_exchange,v_makeup,v_physical,'sent_kiosk_dispatch_notification','warehouse_kiosk_bread_dispatch',new.id,'Điểm bán BMQ','kiosk-dispatch-notification:'||new.id::text,jsonb_build_object('digest_date',new.digest_date,'stock_effect','reservation_only'))
    on conflict (idempotency_key) do nothing returning id into v_doc_id;
    if v_doc_id is not null then insert into public.tan_tao_warehouse_reservations (document_id,sku_id,quantity,status,source_type,source_id) values (v_doc_id,v_sku_id,v_physical,'active','warehouse_kiosk_bread_dispatch',new.id); end if;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_tan_tao_sent_notification() from public,anon,authenticated;

-- Keep approved late-report supplier corrections on the same physical/credit contract.
create or replace function public.queue_late_kiosk_bread_order_corrections(
  p_report_id uuid,
  p_correction_audit_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.kiosk_daily_reports%rowtype;
  v_location public.kiosk_report_locations%rowtype;
  v_bread public.kiosk_daily_report_inventory_rows%rowtype;
  v_order_date date;
  v_supplier public.dealer_order_notifications%rowtype;
  v_warehouse public.dealer_order_notifications%rowtype;
  v_old_location jsonb;
  v_corrected_supplier_locations jsonb;
  v_corrected_locations jsonb;
  v_key_base text;
  v_supplier_key text;
  v_warehouse_key text;
  v_inserted integer := 0;
  v_row_count integer := 0;
  v_dealer numeric := 0;
  v_dealer_ordered numeric := 0;
  v_dealer_extra numeric := 0;
  v_dealer_exchange numeric := 0;
  v_dealer_makeup numeric := 0;
  v_supplier_billable numeric := 0;
  v_vietjet numeric := 0;
  v_old_vehicle numeric := 0;
  v_old_location_quantity numeric := 0;
  v_peak_sold numeric := 0;
  v_latest_closing_quantity numeric := 0;
  v_new_location numeric := 0;
  v_new_vehicle numeric := 0;
  v_total_bmq numeric := 0;
  v_total_makeup numeric := 0;
  v_total_exchange numeric := 0;
  v_total_physical numeric := 0;
  v_warehouse_lines text := '';
begin
  if auth.role() is distinct from 'service_role'
     and current_setting('app.kiosk_authorized_correction_queue', true) is distinct from 'on' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_report
  from public.kiosk_daily_reports
  where id = p_report_id and status = 'submitted'
  for update;
  if not found then return 0; end if;

  select * into v_location from public.kiosk_report_locations where id = v_report.location_id;
  select * into v_bread from public.kiosk_daily_report_inventory_rows
  where report_id = p_report_id and product_code = 'banh_mi_que';
  if not found then return 0; end if;

  v_order_date := v_report.report_date + 1;
  select * into v_supplier
  from public.dealer_order_notifications
  where notification_type = 'production_bread_order'
    and digest_date = v_order_date
    and status = 'sent'
  order by updated_at desc, id desc
  limit 1;

  select * into v_warehouse
  from public.dealer_order_notifications
  where notification_type = 'warehouse_kiosk_bread_dispatch'
    and digest_date = v_order_date
    and status = 'sent'
  order by updated_at desc, id desc
  limit 1;

  if v_supplier.id is null or v_warehouse.id is null then return 0; end if;

  select loc.value into v_old_location
  from jsonb_array_elements(coalesce(v_supplier.source_snapshot #> '{vehicle,locations}', '[]'::jsonb)) loc(value)
  where loc.value->>'locationId' = v_report.location_id::text
  limit 1;
  if v_old_location is null then return 0; end if;

  v_dealer_ordered := coalesce((v_supplier.source_snapshot #>> '{dealer,ordered_quantity}')::numeric, 0);
  v_dealer_exchange := coalesce((v_supplier.source_snapshot #>> '{dealer,exchange_quantity}')::numeric, 0);
  v_dealer_makeup := coalesce((v_supplier.source_snapshot #>> '{dealer,makeup_quantity}')::numeric, 0);
  v_dealer_extra := coalesce(
    (v_supplier.source_snapshot #>> '{dealer,extra_quantity}')::numeric,
    v_dealer_exchange + v_dealer_makeup
  );
  v_dealer := coalesce(
    (v_supplier.source_snapshot #>> '{dealer,physical_quantity}')::numeric,
    v_dealer_ordered + v_dealer_extra
  );
  v_vietjet := coalesce((v_supplier.source_snapshot #>> '{vietjet,quantity}')::numeric, 0);
  v_old_vehicle := coalesce((v_supplier.source_snapshot #>> '{vehicle,total_quantity}')::numeric, 0);
  v_old_location_quantity := coalesce((v_old_location->>'recommendedQuantity')::numeric, 0);

  with ranked as (
    select inventory.sold_quantity,
           inventory.closing_quantity,
           row_number() over (
             order by report.report_date desc, report.submitted_at desc nulls last, report.id desc
           ) as report_rank
    from public.kiosk_daily_reports report
    join public.kiosk_daily_report_inventory_rows inventory
      on inventory.report_id = report.id
     and inventory.product_code = 'banh_mi_que'
    where report.location_id = v_report.location_id
      and report.status = 'submitted'
      and report.report_date <= v_report.report_date
  )
  select coalesce(max(sold_quantity) filter (where report_rank <= 7), 0),
         coalesce(max(closing_quantity) filter (where report_rank = 1), 0)
    into v_peak_sold, v_latest_closing_quantity
  from ranked;

  v_new_location := case
    when nullif(v_old_location->>'closureReason', '') is not null then 0
    else greatest(0, ceiling(greatest(0, (v_peak_sold * 1.1) - v_latest_closing_quantity) / 10) * 10)
  end;
  v_new_vehicle := greatest(0, v_old_vehicle - v_old_location_quantity + v_new_location);
  v_total_bmq := ceiling(greatest(0, v_dealer + v_new_vehicle) / 20) * 20;
  v_supplier_billable := v_total_bmq - v_dealer_extra;

  select jsonb_agg(
    case when location.value->>'locationId' = v_report.location_id::text then
      location.value || jsonb_build_object(
        'recommendedQuantity', v_new_location,
        'peakSoldQuantity', v_peak_sold,
        'latestClosingQuantity', v_latest_closing_quantity,
        'latestReportDate', v_report.report_date,
        'latestReportSource', jsonb_build_object(
          'reportId', v_report.id,
          'reportUpdatedAt', v_report.updated_at
        )
      )
    else location.value end
    order by location.ordinality
  ) into v_corrected_supplier_locations
  from jsonb_array_elements(coalesce(v_supplier.source_snapshot #> '{vehicle,locations}', '[]'::jsonb))
       with ordinality as location(value, ordinality);

  if v_corrected_supplier_locations is null then return 0; end if;

  select jsonb_agg(
    case when location.value->>'locationId' = v_report.location_id::text then
      location.value || jsonb_build_object(
        'orderQuantity', v_new_location,
        'shortageQuantity', coalesce(v_bread.shortage_quantity, 0),
        'returnsQuantity', coalesce(v_bread.returns_quantity, 0),
        'wasteQuantity', coalesce(v_bread.waste_quantity, 0),
        'latestReportDate', v_report.report_date,
        'latestReportSource', jsonb_build_object(
          'reportId', v_report.id,
          'reportUpdatedAt', v_report.updated_at
        )
      )
    else location.value end
    order by location.ordinality
  ) into v_corrected_locations
  from jsonb_array_elements(coalesce(v_warehouse.source_snapshot->'locations', '[]'::jsonb))
       with ordinality as location(value, ordinality);

  if v_corrected_locations is null then return 0; end if;

  select coalesce(sum(coalesce((location.value->>'orderQuantity')::numeric, 0)), 0),
         coalesce(sum(coalesce((location.value->>'shortageQuantity')::numeric, 0)), 0),
         coalesce(sum(coalesce((location.value->>'returnsQuantity')::numeric, 0)
                    + coalesce((location.value->>'wasteQuantity')::numeric, 0)), 0)
    into v_new_vehicle, v_total_makeup, v_total_exchange
  from jsonb_array_elements(v_corrected_locations) location(value);
  v_total_physical := v_new_vehicle + v_total_makeup + v_total_exchange;

  select string_agg(
    concat(
      regexp_replace(coalesce(location.value->>'locationName', location.value->>'locationCode', 'Điểm bán'), '^[[:space:]]*[0-9]+[[:space:]]+', ''),
      ': đặt ', to_char(coalesce((location.value->>'orderQuantity')::numeric, 0), 'FM999999999990.###'), ' que',
      case when coalesce((location.value->>'shortageQuantity')::numeric, 0) > 0
        then ' | bù ' || to_char((location.value->>'shortageQuantity')::numeric, 'FM999999999990.###') else '' end,
      case when coalesce((location.value->>'returnsQuantity')::numeric, 0)
                     + coalesce((location.value->>'wasteQuantity')::numeric, 0) > 0
        then ' | đổi ' || to_char(
          coalesce((location.value->>'returnsQuantity')::numeric, 0)
          + coalesce((location.value->>'wasteQuantity')::numeric, 0),
          'FM999999999990.###'
        ) else '' end
    ), E'\n' order by location.ordinality
  ) into v_warehouse_lines
  from jsonb_array_elements(v_corrected_locations) with ordinality as location(value, ordinality);

  v_key_base := concat_ws(':', v_supplier.id, v_warehouse.id, p_report_id, v_report.updated_at, p_correction_audit_id);
  v_supplier_key := 'late-kiosk-bread:supplier:' || v_key_base;
  v_warehouse_key := 'late-kiosk-bread:warehouse:' || v_key_base;

  insert into public.pending_kiosk_bread_recompute (
    report_id, report_updated_at, correction_audit_id,
    original_supplier_notification_id, original_warehouse_notification_id, idempotency_key
  ) values (
    p_report_id, v_report.updated_at, p_correction_audit_id,
    v_supplier.id, v_warehouse.id, v_key_base
  ) on conflict (idempotency_key) do nothing;

  insert into public.dealer_order_notifications (
    order_id, notification_type, digest_date, channel, group_name, message_body,
    source_snapshot, status, attempt_count, max_attempts, next_attempt_at
  ) values (
    null, 'production_bread_order_correction', v_order_date, 'zalo_gmf', 'BMQ - HKD Tuyết Anh',
    concat(
      'ĐIỀU CHỈNH ĐẶT BÁNH - THAY THẾ TOÀN BỘ', E'\n',
      'Chênh lệch điểm bị sửa (', coalesce(v_location.location_name, v_location.location_code), '): ',
      to_char(abs(v_new_location - v_old_location_quantity), 'FM999999999990.###'), ' que ',
      case when v_new_location >= v_old_location_quantity then 'tăng' else 'giảm' end, E'\n',
      'Tổng đúng sau chỉnh sửa:', E'\n',
      'Đặt bánh ngày ', extract(day from v_order_date)::int, '/', extract(month from v_order_date)::int, '/', extract(year from v_order_date)::int, E'\n',
      'ĐL: ', to_char(v_dealer_ordered, 'FM999999999990.###'),
      ' | Đổi: ', to_char(v_dealer_exchange, 'FM999999999990.###'),
      ' | Bù: ', to_char(v_dealer_makeup, 'FM999999999990.###'),
      ' | Giao: ', to_char(v_dealer, 'FM999999999990.###'), E'\n',
      'Xe: ', to_char(v_new_vehicle, 'FM999999999990.###'), E'\n',
      'Tổng BMQ giao: ', to_char(v_total_bmq, 'FM999999999990.###'), E'\n',
      'Khấu trừ công nợ lò: ', to_char(v_dealer_extra, 'FM999999999990.###'), E'\n',
      'Lò tính tiền: ', to_char(v_supplier_billable, 'FM999999999990.###'), E'\n',
      'Viet Jet: ', to_char(ceiling(greatest(0, v_vietjet) / 10) * 10, 'FM999999999990.###')
    ),
    jsonb_build_object(
      'approved_by_owner', false,
      'approval_status', 'pending_owner_review',
      'full_replacement', true,
      'idempotency_key', v_supplier_key,
      'report_id', p_report_id,
      'report_updated_at', v_report.updated_at,
      'correction_audit_id', p_correction_audit_id,
      'original_supplier_notification_id', v_supplier.id,
      'original_warehouse_notification_id', v_warehouse.id,
      'vehicle', jsonb_build_object('total_quantity', v_new_vehicle, 'locations', v_corrected_supplier_locations),
      'supplier', jsonb_build_object(
        'name', 'BMQ - HKD Tuyết Anh',
        'physical_quantity', v_total_bmq,
        'billable_quantity', v_supplier_billable,
        'credit_quantity', v_dealer_extra,
        'exchange_quantity', v_dealer_exchange,
        'makeup_quantity', v_dealer_makeup,
        'credit_handling', 'ordered_from_supplier_and_credited_to_bakery_payable'
      ),
      'supplier_totals', jsonb_build_object(
        'dealer_ordered_quantity', v_dealer_ordered,
        'dealer_exchange_quantity', v_dealer_exchange,
        'dealer_makeup_quantity', v_dealer_makeup,
        'dealer_extra_quantity', v_dealer_extra,
        'dealer_physical_quantity', v_dealer,
        'supplier_billable_quantity', v_supplier_billable,
        'supplier_credit_quantity', v_dealer_extra,
        'vehicle_quantity', v_new_vehicle,
        'total_bmq', v_total_bmq,
        'vietjet', ceiling(greatest(0, v_vietjet) / 10) * 10
      )
    ),
    'pending_owner_review', 0, 5, now()
  ) on conflict ((source_snapshot->>'idempotency_key'))
      where notification_type = 'production_bread_order_correction' and source_snapshot ? 'idempotency_key'
    do nothing;
  get diagnostics v_row_count = row_count;
  v_inserted := v_inserted + v_row_count;

  insert into public.dealer_order_notifications (
    order_id, notification_type, digest_date, channel, group_name, message_body,
    source_snapshot, status, attempt_count, max_attempts, next_attempt_at
  ) values (
    null, 'production_bread_order_correction', v_order_date, 'zalo_gmf', 'BMQ - Kho Tân Tạo',
    concat(
      'ĐIỀU CHỈNH GIAO BÁNH KHO - THAY THẾ TOÀN BỘ', E'\n',
      'Chênh lệch điểm bị sửa (', coalesce(v_location.location_name, v_location.location_code), '): ',
      to_char(abs(v_new_location - v_old_location_quantity), 'FM999999999990.###'), ' que ',
      case when v_new_location >= v_old_location_quantity then 'tăng' else 'giảm' end, E'\n',
      'Tổng đúng sau chỉnh sửa:', E'\n',
      'ĐẶT BÁNH ', extract(day from v_order_date)::int, '/', extract(month from v_order_date)::int, E'\n\n',
      v_warehouse_lines, E'\n\n',
      'Tổng đặt mới: ', to_char(v_new_vehicle, 'FM999999999990.###'), ' que', E'\n',
      'Tổng bù: ', to_char(v_total_makeup, 'FM999999999990.###'), ' que', E'\n',
      'Tổng đổi: ', to_char(v_total_exchange, 'FM999999999990.###'), ' que', E'\n',
      'KHO CẦN GIAO: ', to_char(v_total_physical, 'FM999999999990.###'), ' QUE'
    ),
    jsonb_build_object(
      'approved_by_owner', false,
      'approval_status', 'pending_owner_review',
      'full_replacement', true,
      'idempotency_key', v_warehouse_key,
      'report_id', p_report_id,
      'report_updated_at', v_report.updated_at,
      'correction_audit_id', p_correction_audit_id,
      'original_supplier_notification_id', v_supplier.id,
      'original_warehouse_notification_id', v_warehouse.id,
      'corrected_locations', v_corrected_locations,
      'warehouse_totals', jsonb_build_object(
        'total_ordered', v_new_vehicle,
        'total_makeup', v_total_makeup,
        'total_exchange', v_total_exchange,
        'total_physical', v_total_physical
      )
    ),
    'pending_owner_review', 0, 5, now()
  ) on conflict ((source_snapshot->>'idempotency_key'))
      where notification_type = 'production_bread_order_correction' and source_snapshot ? 'idempotency_key'
    do nothing;
  get diagnostics v_row_count = row_count;
  v_inserted := v_inserted + v_row_count;

  return v_inserted;
end;
$$;

revoke all on function public.queue_late_kiosk_bread_order_corrections(uuid, uuid) from public, anon, authenticated;
grant execute on function public.queue_late_kiosk_bread_order_corrections(uuid, uuid) to service_role;
