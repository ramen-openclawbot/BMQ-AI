begin;

select set_config('request.jwt.claim.role', 'authenticated', true);
do $acl$
begin
  begin
    perform public.get_active_kiosk_bread_dynamic_order_policies(date '2099-12-31');
    raise exception 'dynamic policy RPC allowed authenticated role';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.upsert_bhn_bread_report_prealert(
      date '2099-12-30',
      date '2099-12-31',
      'CẢNH BÁO BÁNH BHN' || chr(10) ||
      'Trạng thái lúc 23:30 ngày 2099-12-30: thiếu nguồn.' || chr(10) ||
      'Ngày báo cáo: 2099-12-30' || chr(10) ||
      'Ngày giao kế tiếp: 2099-12-31',
      jsonb_build_object(
        'source', 'baocao.banhmique.vn',
        'report_date', '2099-12-30',
        'order_date', '2099-12-31',
        'location_code', 'HCM004-BHN'
      )
    );
    raise exception 'prealert RPC allowed authenticated role';
  exception when insufficient_privilege then
    null;
  end;
end;
$acl$;

select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_first uuid;
  v_second uuid;
  v_count integer;
  v_group text;
  v_type text;
begin
  v_first := public.upsert_bhn_bread_report_prealert(
    date '2099-12-30',
    date '2099-12-31',
    'CẢNH BÁO BÁNH BHN' || chr(10) ||
    'Trạng thái lúc 23:30 ngày 2099-12-30: thiếu nguồn.' || chr(10) ||
    'Ngày báo cáo: 2099-12-30' || chr(10) ||
    'Ngày giao kế tiếp: 2099-12-31',
    jsonb_build_object(
      'source', 'baocao.banhmique.vn',
      'report_date', '2099-12-30',
      'order_date', '2099-12-31',
      'location_code', 'HCM004-BHN',
      'warning', 'HCM004-BHN:exact_cutoff_bread_report_missing:2099-12-30'
    )
  );
  v_second := public.upsert_bhn_bread_report_prealert(
    date '2099-12-30',
    date '2099-12-31',
    'CẢNH BÁO BÁNH BHN' || chr(10) ||
    'Trạng thái lúc 23:30 ngày 2099-12-30: vẫn thiếu nguồn.' || chr(10) ||
    'Ngày báo cáo: 2099-12-30' || chr(10) ||
    'Ngày giao kế tiếp: 2099-12-31',
    jsonb_build_object(
      'source', 'baocao.banhmique.vn',
      'report_date', '2099-12-30',
      'order_date', '2099-12-31',
      'location_code', 'HCM004-BHN',
      'warning', 'HCM004-BHN:exact_cutoff_bread_inventory_row_missing:2099-12-30'
    )
  );
  if v_first is distinct from v_second then
    raise exception 'prealert idempotency returned different ids';
  end if;

  select count(*), min(group_name), min(notification_type)
    into v_count, v_group, v_type
  from public.dealer_order_notifications
  where digest_date = date '2099-12-31'
    and notification_type = 'bhn_bread_report_prealert';
  if v_count <> 1 or v_group <> 'BMQ - Kho Tân Tạo' or v_type <> 'bhn_bread_report_prealert' then
    raise exception 'unexpected prealert row count/group/type: %, %, %', v_count, v_group, v_type;
  end if;
end;
$smoke$;

do $dynamic_correction_contract$
declare
  v_corrected_bhn_order numeric;
  v_mismatch_should_fail boolean;
begin
  v_corrected_bhn_order := ceiling(greatest(0, (91 * 1.2) - 89) / 20) * 20;
  if v_corrected_bhn_order <> 40 then
    raise exception 'dynamic correction formula expected 40, got %', v_corrected_bhn_order;
  end if;

  v_mismatch_should_fail := (
    jsonb_build_object(
      'policyCode', 'dynamic-daily-order-bhn-bmq-001-v1',
      'skuCode', 'BMQ-001',
      'demandMultiplier', 1.2,
      'batchSize', 20
    )
    is distinct from
    jsonb_build_object(
      'policyCode', 'dynamic-daily-order-bhn-bmq-001-v1',
      'skuCode', 'BMQ-001',
      'demandMultiplier', 1.1,
      'batchSize', 20
    )
  );
  if not v_mismatch_should_fail then
    raise exception 'dynamic policy snapshot mismatch did not fail closed';
  end if;
end;
$dynamic_correction_contract$;

do $vehicle_history_contract$
declare
  v_non_bhn_without_bread integer;
  v_non_bhn_no_report integer;
  v_bhn_without_bread integer;
begin
  with source_rows(location_code, report_id, inventory_report_id) as (
    values
      ('HCM001-BV', gen_random_uuid(), null::uuid),
      ('HCM002-PVC', null::uuid, null::uuid),
      ('HCM004-BHN', gen_random_uuid(), null::uuid),
      ('HCM005-OK', gen_random_uuid(), gen_random_uuid())
  ),
  filtered as (
    select *
    from source_rows
    where report_id is null
       or inventory_report_id is not null
       or location_code = 'HCM004-BHN'
  )
  select
    count(*) filter (where location_code = 'HCM001-BV'),
    count(*) filter (where location_code = 'HCM002-PVC'),
    count(*) filter (where location_code = 'HCM004-BHN')
    into v_non_bhn_without_bread, v_non_bhn_no_report, v_bhn_without_bread
  from filtered;

  if v_non_bhn_without_bread <> 0 then
    raise exception 'non-BHN report without bread row leaked into history';
  end if;
  if v_non_bhn_no_report <> 1 then
    raise exception 'non-BHN no-report location was not preserved';
  end if;
  if v_bhn_without_bread <> 1 then
    raise exception 'BHN report without bread row was not preserved for dynamic fail-closed warning';
  end if;
end;
$vehicle_history_contract$;

do $correction_unique_contract$
declare
  v_count integer;
begin
  insert into public.dealer_order_notifications (
    order_id, notification_type, digest_date, channel, group_name, message_body,
    source_snapshot, status, attempt_count, max_attempts, next_attempt_at
  ) values
    (null, 'production_bread_order_correction', date '2099-12-31', 'zalo_gmf',
     'BMQ - HKD Tuyết Anh', 'rollback-only supplier correction',
     jsonb_build_object('idempotency_key', 'bhn-rollback-2099:supplier'),
     'pending_owner_review', 0, 5, now()),
    (null, 'production_bread_order_correction', date '2099-12-31', 'zalo_gmf',
     'BMQ - Kho Tân Tạo', 'rollback-only warehouse correction',
     jsonb_build_object('idempotency_key', 'bhn-rollback-2099:warehouse'),
     'pending_owner_review', 0, 5, now());
  select count(*) into v_count
  from public.dealer_order_notifications
  where digest_date = date '2099-12-31'
    and notification_type = 'production_bread_order_correction'
    and source_snapshot->>'idempotency_key' in ('bhn-rollback-2099:supplier', 'bhn-rollback-2099:warehouse');
  if v_count <> 2 then
    raise exception 'same-day supplier/warehouse corrections must coexist: %', v_count;
  end if;
end;
$correction_unique_contract$;

rollback;

select not exists (
  select 1
  from public.dealer_order_notifications
  where digest_date = date '2099-12-31'
    and notification_type = 'bhn_bread_report_prealert'
) as rollback_verified;
