-- Late kiosk bread corrections: preserve source revisions and queue owner-review correction drafts.
-- Correction message text is full replacement wording; it is not a delta-only notice.
-- No production sends are performed by this migration.

create table if not exists public.pending_kiosk_bread_recompute (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.kiosk_daily_reports(id) on delete cascade,
  report_updated_at timestamptz not null,
  correction_audit_id uuid not null references public.kiosk_point_revenue_audit_logs(id) on delete cascade,
  original_supplier_notification_id uuid references public.dealer_order_notifications(id) on delete restrict,
  original_warehouse_notification_id uuid references public.dealer_order_notifications(id) on delete restrict,
  idempotency_key text not null,
  status text not null default 'pending_owner_review',
  created_at timestamptz not null default now(),
  constraint pending_kiosk_bread_recompute_status_check check (status in ('pending_owner_review', 'queued', 'cancelled')),
  constraint pending_kiosk_bread_recompute_key_unique unique (idempotency_key)
);

alter table public.pending_kiosk_bread_recompute enable row level security;
revoke all on table public.pending_kiosk_bread_recompute from public, anon, authenticated;
grant select, insert, update on table public.pending_kiosk_bread_recompute to service_role;

drop index if exists public.dealer_order_notifications_bread_correction_idempotency_idx;
create unique index dealer_order_notifications_bread_correction_idempotency_idx
  on public.dealer_order_notifications ((source_snapshot->>'idempotency_key'))
  where notification_type = 'production_bread_order_correction'
    and source_snapshot ? 'idempotency_key';

alter table public.dealer_order_notifications
  drop constraint if exists dealer_order_notifications_type_check;

alter table public.dealer_order_notifications
  add constraint dealer_order_notifications_type_check check (
    (notification_type = 'order' and order_id is not null and digest_date is null)
    or
    (
      notification_type in (
        'daily_dealer_digest',
        'daily_point_digest',
        'production_bread_order',
        'production_bread_order_correction',
        'warehouse_kiosk_bread_dispatch'
      )
      and order_id is null
      and digest_date is not null
    )
  );

alter table public.dealer_order_notifications
  drop constraint if exists dealer_order_notifications_status_check;

alter table public.dealer_order_notifications
  add constraint dealer_order_notifications_status_check
  check (status in ('pending_owner_review', 'pending', 'processing', 'sent', 'failed'));

drop function if exists public.get_daily_bread_vehicle_history(date);

create function public.get_daily_bread_vehicle_history(p_cutoff_date date)
returns table (
  report_id uuid,
  location_id uuid,
  location_code text,
  report_date date,
  report_updated_at timestamptz,
  sold_quantity numeric,
  closing_quantity numeric
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
  with ranked as (
    select
      report.id as report_id,
      location.id as location_id,
      location.location_code,
      report.report_date,
      report.updated_at as report_updated_at,
      inventory.sold_quantity,
      inventory.closing_quantity,
      row_number() over (partition by report.location_id order by report.report_date desc, report.updated_at desc, report.id desc) as report_rank
    from public.kiosk_report_locations location
    left join public.kiosk_daily_reports report
      on report.location_id = location.id
     and report.status = 'submitted'
     and report.report_date <= p_cutoff_date
    left join public.kiosk_daily_report_inventory_rows inventory
      on inventory.report_id = report.id
     and inventory.product_code = 'banh_mi_que'
    where location.active = true
      and coalesce(location.location_code, '') not ilike 'TEST%'
  )
  select ranked.report_id, ranked.location_id, ranked.location_code, ranked.report_date,
         ranked.report_updated_at, ranked.sold_quantity, ranked.closing_quantity
  from ranked
  where ranked.report_rank <= 7
  order by ranked.location_code, ranked.report_date desc nulls last;
end;
$$;

revoke all on function public.get_daily_bread_vehicle_history(date) from public, anon, authenticated;
grant execute on function public.get_daily_bread_vehicle_history(date) to service_role;

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
  v_dealer_extra := coalesce((v_supplier.source_snapshot #>> '{dealer,extra_quantity}')::numeric, 0);
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
  v_total_bmq := ceiling(greatest(0, v_dealer + v_new_vehicle) / 10) * 10;

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
      'ĐL: ', to_char(v_dealer, 'FM999999999990.###'),
      case when v_dealer_extra > 0 then concat(
        ' (đặt ', to_char(v_dealer_ordered, 'FM999999999990.###'),
        ' + đổi/bù ', to_char(v_dealer_extra, 'FM999999999990.###'), ')'
      ) else '' end, E'\n',
      'Xe: ', to_char(v_new_vehicle, 'FM999999999990.###'), E'\n',
      'Tổng BMQ: ', to_char(v_total_bmq, 'FM999999999990.###'), E'\n',
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
      'supplier_totals', jsonb_build_object(
        'dealer_ordered_quantity', v_dealer_ordered,
        'dealer_extra_quantity', v_dealer_extra,
        'dealer_physical_quantity', v_dealer,
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

create or replace function public.approve_late_kiosk_bread_order_corrections(p_recompute_id uuid)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_marker public.pending_kiosk_bread_recompute%rowtype;
  v_approved_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_marker
  from public.pending_kiosk_bread_recompute
  where id = p_recompute_id and status = 'pending_owner_review'
  for update;
  if not found then return; end if;

  return query
  update public.dealer_order_notifications notification
  set status = 'pending',
      source_snapshot = jsonb_set(
        jsonb_set(notification.source_snapshot, '{approved_by_owner}', 'true'::jsonb, true),
        '{approval_status}', '"approved"'::jsonb, true
      ),
      next_attempt_at = now(),
      updated_at = now()
  where notification.notification_type = 'production_bread_order_correction'
    and notification.status = 'pending_owner_review'
    and notification.source_snapshot->>'correction_audit_id' = v_marker.correction_audit_id::text
    and notification.source_snapshot->>'report_id' = v_marker.report_id::text
  returning notification.id;
  get diagnostics v_approved_count = row_count;
  if v_approved_count <> 2 then
    raise exception 'late_kiosk_bread_correction_pair_incomplete' using errcode = 'P0001';
  end if;

  update public.pending_kiosk_bread_recompute
  set status = 'queued'
  where id = v_marker.id;
end;
$$;

revoke all on function public.approve_late_kiosk_bread_order_corrections(uuid) from public, anon, authenticated;
grant execute on function public.approve_late_kiosk_bread_order_corrections(uuid) to service_role;

-- Keep audited point-report corrections aligned with the effective retail price.
-- Historical reports before 2026-08-15 remain at 12,000 VND; later reports use 14,000 VND.

create or replace function public.save_kiosk_point_report_correction(
  p_report_id uuid,
  p_report_notes text,
  p_inventory_rows jsonb,
  p_channel_rows jsonb,
  p_review_status text,
  p_review_note text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_report public.kiosk_daily_reports%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_review_note text := nullif(btrim(coalesce(p_review_note, '')), '');
  v_before jsonb;
  v_after jsonb;
  v_before_bread jsonb;
  v_after_bread jsonb;
  v_breadstick_sold numeric(12,3) := 0;
  v_later record;
  v_cascade_report_id uuid;
  v_cascade_ids jsonb := '[]'::jsonb;
  v_audit_id uuid;
  v_queued_corrections integer := 0;
begin
  if v_actor is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_revenue', 'edit')
  ) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  if v_reason is null
     or length(v_reason) < 10
     or lower(regexp_replace(v_reason, '[[:space:]]+', ' ', 'g')) in (
       'đã kiểm', 'đã kiểm tra', 'da kiem', 'da kiem tra',
       'chỉnh sửa', 'update data', 'checked data'
     )
     or length(v_reason) > 500 then
    raise exception 'invalid_kiosk_report_edit_reason' using errcode = '22023';
  end if;
  if length(coalesce(p_report_notes, '')) > 2000 then
    raise exception 'kiosk_report_note_too_long' using errcode = '22023';
  end if;
  if p_review_status not in ('in_review', 'reviewed') then
    raise exception 'invalid_point_revenue_review_status' using errcode = '22023';
  end if;
  if v_review_note is not null and length(v_review_note) > 2000 then
    raise exception 'point_revenue_note_too_long' using errcode = '22023';
  end if;
  if p_inventory_rows is null or jsonb_typeof(p_inventory_rows) <> 'array' then
    raise exception 'invalid_kiosk_report_inventory_rows' using errcode = '22023';
  end if;
  if p_channel_rows is null or jsonb_typeof(p_channel_rows) <> 'array' then
    raise exception 'invalid_kiosk_report_channel_rows' using errcode = '22023';
  end if;

  select report.* into v_report
  from public.kiosk_daily_reports report
  where report.id = p_report_id
  for update;
  if not found or v_report.status <> 'submitted' then
    raise exception 'kiosk_report_not_submitted' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_report.location_id::text, 0));

  if (select count(*) from jsonb_array_elements(p_inventory_rows)) < 1
    or (select count(*) from jsonb_array_elements(p_inventory_rows)) <>
       (select count(*) from public.kiosk_daily_report_inventory_rows where report_id = p_report_id)
    or exists (
      select 1 from jsonb_array_elements(p_inventory_rows) input
      left join public.kiosk_daily_report_inventory_rows source
        on source.report_id = p_report_id and source.product_code = input->>'product_code'
      where source.id is null
        or coalesce(input->>'opening_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'received_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'shortage_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'transfer_quantity', '') !~ '^-?\d+(\.\d{1,3})?$'
        or coalesce(input->>'waste_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'returns_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'sold_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'consumed_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or (input->>'opening_quantity')::numeric > 1000000000
        or (input->>'received_quantity')::numeric > 1000000000
        or (input->>'shortage_quantity')::numeric > 1000000000
        or abs((input->>'transfer_quantity')::numeric) > 1000000000
        or (input->>'waste_quantity')::numeric > 1000000000
        or (input->>'returns_quantity')::numeric > 1000000000
        or (input->>'sold_quantity')::numeric > 1000000000
        or (input->>'consumed_quantity')::numeric > 1000000000
        or length(coalesce(input->>'notes', '')) > 1000
    )
    or exists (
      select 1 from jsonb_array_elements(p_inventory_rows) input
      group by input->>'product_code' having count(*) > 1
    ) then raise exception 'invalid_kiosk_report_inventory_rows' using errcode = '22023'; end if;

  if (select count(*) from jsonb_array_elements(p_channel_rows)) < 1
    or (select count(*) from jsonb_array_elements(p_channel_rows)) <>
       (select count(*) from public.kiosk_daily_report_channel_rows where report_id = p_report_id)
    or exists (
      select 1 from jsonb_array_elements(p_channel_rows) input
      left join public.kiosk_daily_report_channel_rows source
        on source.report_id = p_report_id and source.channel_code = lower(btrim(input->>'channel_code'))
      where source.id is null
        or coalesce(input->>'quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'amount_vnd', '') !~ '^\d+(\.0{1,2})?$'
        or (input->>'quantity')::numeric > 1000000000
        or (input->>'amount_vnd')::numeric > 999999999999
        or length(coalesce(input->>'notes', '')) > 1000
    )
    or exists (
      select 1 from jsonb_array_elements(p_channel_rows) input
      group by lower(btrim(input->>'channel_code')) having count(*) > 1
    ) then raise exception 'invalid_kiosk_report_channel_rows' using errcode = '22023'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_inventory_rows) input
    join public.kiosk_report_products product on product.code = input->>'product_code'
    where not product.sale_allowed and (input->>'sold_quantity')::numeric > 0
  ) then raise exception 'ingredient_retail_sale_forbidden' using errcode = '22023'; end if;

  select coalesce(sum((input->>'quantity')::numeric), 0) into v_breadstick_sold
  from jsonb_array_elements(p_channel_rows) input;
  v_breadstick_sold := coalesce(v_breadstick_sold, 0);

  v_before := public.get_kiosk_point_report_detail(p_report_id);
  select jsonb_build_object(
    'opening_quantity', row_data->'opening_quantity',
    'received_quantity', row_data->'received_quantity',
    'shortage_quantity', row_data->'shortage_quantity',
    'transfer_quantity', row_data->'transfer_quantity',
    'waste_quantity', row_data->'waste_quantity',
    'returns_quantity', row_data->'returns_quantity',
    'sold_quantity', row_data->'sold_quantity',
    'closing_quantity', row_data->'closing_quantity'
  ) into v_before_bread
  from jsonb_array_elements(coalesce(v_before->'inventory_rows', '[]'::jsonb)) row_data
  where row_data->>'product_code' = 'banh_mi_que'
  limit 1;
  perform set_config('app.kiosk_report_authorized_edit', 'on', true);

  update public.kiosk_daily_reports
  set notes = nullif(btrim(coalesce(p_report_notes, '')), ''),
      updated_at = now()
  where id = p_report_id;

  update public.kiosk_daily_report_inventory_rows target
  set opening_quantity = (input.row_data->>'opening_quantity')::numeric,
      received_quantity = (input.row_data->>'received_quantity')::numeric,
      shortage_quantity = (input.row_data->>'shortage_quantity')::numeric,
      transfer_quantity = (input.row_data->>'transfer_quantity')::numeric,
      waste_quantity = (input.row_data->>'waste_quantity')::numeric,
      returns_quantity = (input.row_data->>'returns_quantity')::numeric,
      sold_quantity = case
        when target.product_code = 'banh_mi_que' then v_breadstick_sold
        when product.sale_allowed then (input.row_data->>'sold_quantity')::numeric
        else 0
      end,
      consumed_quantity = case
        when target.product_code = 'ot' then (input.row_data->>'consumed_quantity')::numeric
        else round(v_breadstick_sold * product.breadstick_consumption_ratio, 3)
      end,
      notes = nullif(btrim(coalesce(input.row_data->>'notes', '')), ''),
      updated_at = now()
  from jsonb_array_elements(p_inventory_rows) input(row_data)
  join public.kiosk_report_products product on product.code = input.row_data->>'product_code'
  where target.report_id = p_report_id and target.product_code = input.row_data->>'product_code';

  update public.kiosk_daily_report_channel_rows target
  set quantity = (input.row_data->>'quantity')::numeric,
      amount_vnd = case
        when target.channel_code = 'khach_le' then round(
          (input.row_data->>'quantity')::numeric
          * case when v_report.report_date < date '2026-08-15' then 12000 else 14000 end
        )
        else (input.row_data->>'amount_vnd')::numeric
      end,
      notes = nullif(btrim(coalesce(input.row_data->>'notes', '')), ''),
      updated_at = now()
  from jsonb_array_elements(p_channel_rows) input(row_data)
  where target.report_id = p_report_id
    and target.channel_code = lower(btrim(input.row_data->>'channel_code'));

  delete from public.kiosk_point_revenue_adjustments where report_id = p_report_id;

  for v_later in
    select later.id from public.kiosk_daily_reports later
    where later.location_id = v_report.location_id and later.report_date > v_report.report_date
    order by later.report_date, later.id
  loop
    update public.kiosk_daily_report_inventory_rows target
    set opening_quantity = greatest(0, source.closing_quantity),
        opening_reconciliation_required = source.closing_quantity < 0,
        updated_at = now()
    from public.kiosk_daily_reports later_report
    join public.kiosk_daily_report_inventory_rows source
      on source.report_id = later_report.opening_source_report_id
    where later_report.id = v_later.id
      and target.report_id = later_report.id
      and source.product_code = target.product_code;
    if found then
      update public.kiosk_daily_reports set updated_at = now() where id = v_later.id;
      v_cascade_ids := v_cascade_ids || to_jsonb(v_later.id);
    end if;
  end loop;

  insert into public.kiosk_point_revenue_reviews (
    report_id, review_status, review_note, reviewed_by, reviewed_at,
    created_by, updated_by, created_at, updated_at
  ) values (
    p_report_id, p_review_status, v_review_note,
    case when p_review_status = 'reviewed' then v_actor else null end,
    case when p_review_status = 'reviewed' then now() else null end,
    v_actor, v_actor, now(), now()
  ) on conflict (report_id) do update
  set review_status = excluded.review_status,
      review_note = excluded.review_note,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      updated_by = excluded.updated_by,
      updated_at = now();

  v_after := public.get_kiosk_point_report_detail(p_report_id)
    || jsonb_build_object('cascade_updated_reports', v_cascade_ids);
  select jsonb_build_object(
    'opening_quantity', row_data->'opening_quantity',
    'received_quantity', row_data->'received_quantity',
    'shortage_quantity', row_data->'shortage_quantity',
    'transfer_quantity', row_data->'transfer_quantity',
    'waste_quantity', row_data->'waste_quantity',
    'returns_quantity', row_data->'returns_quantity',
    'sold_quantity', row_data->'sold_quantity',
    'closing_quantity', row_data->'closing_quantity'
  ) into v_after_bread
  from jsonb_array_elements(coalesce(v_after->'inventory_rows', '[]'::jsonb)) row_data
  where row_data->>'product_code' = 'banh_mi_que'
  limit 1;

  insert into public.kiosk_point_revenue_audit_logs (
    report_id, actor_id, action, before_payload, after_payload, note
  ) values (p_report_id, v_actor, 'edit_report', v_before, v_after, v_reason)
  returning id into v_audit_id;

  if v_before_bread is distinct from v_after_bread then
    perform set_config('app.kiosk_authorized_correction_queue', 'on', true);
    select public.queue_late_kiosk_bread_order_corrections(p_report_id, v_audit_id)
      into v_queued_corrections;
    for v_cascade_report_id in
      select value::uuid from jsonb_array_elements_text(v_cascade_ids) cascade(value)
    loop
      v_queued_corrections := v_queued_corrections
        + public.queue_late_kiosk_bread_order_corrections(v_cascade_report_id, v_audit_id);
    end loop;
  end if;

  return jsonb_build_object(
    'report_id', p_report_id,
    'review_status', p_review_status,
    'cascade_updated_reports', v_cascade_ids,
    'queued_bread_corrections', v_queued_corrections,
    'updated_at', now()
  );
end;
$$;

revoke all on function public.save_kiosk_point_report_correction(uuid, text, jsonb, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.save_kiosk_point_report_correction(uuid, text, jsonb, jsonb, text, text, text) to authenticated;
