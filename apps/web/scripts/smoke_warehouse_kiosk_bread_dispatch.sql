begin;
select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_first uuid;
  v_second uuid;
  v_count integer;
  v_group text;
  v_status text;
begin
  v_first := public.upsert_warehouse_kiosk_bread_dispatch(
    date '2099-12-31',
    'Đặt bánh 31/12' || chr(10) || 'Điểm bán 10' || chr(10) || 'Tc: 10 bù0 đổi0',
    jsonb_build_object('source', 'baocao.banhmique.vn', 'order_date', '2099-12-31', 'locations', '[]'::jsonb)
  );
  v_second := public.upsert_warehouse_kiosk_bread_dispatch(
    date '2099-12-31',
    'Đặt bánh 31/12' || chr(10) || 'Điểm bán 20' || chr(10) || 'Tc: 20 bù0 đổi0',
    jsonb_build_object('source', 'baocao.banhmique.vn', 'order_date', '2099-12-31', 'locations', '[]'::jsonb)
  );
  if v_first is distinct from v_second then
    raise exception 'idempotent upsert returned different ids';
  end if;

  select count(*), min(group_name), min(status)
    into v_count, v_group, v_status
  from public.dealer_order_notifications
  where digest_date = date '2099-12-31'
    and notification_type = 'warehouse_kiosk_bread_dispatch';
  if v_count <> 1 or v_group <> 'BMQ - Kho Tân Tạo' or v_status <> 'pending' then
    raise exception 'unexpected dispatch row count/group/status: %, %, %', v_count, v_group, v_status;
  end if;

  update public.dealer_order_notifications
  set status = 'sent', sent_at = now()
  where id = v_first;
  v_second := public.upsert_warehouse_kiosk_bread_dispatch(
    date '2099-12-31',
    'Đặt bánh 31/12' || chr(10) || 'Điểm bán 30' || chr(10) || 'Tc: 30 bù0 đổi0',
    jsonb_build_object('source', 'baocao.banhmique.vn', 'order_date', '2099-12-31', 'locations', '[]'::jsonb)
  );
  select status into v_status
  from public.dealer_order_notifications
  where id = v_first;
  if v_second is distinct from v_first or v_status <> 'sent' then
    raise exception 'sent dispatch was reset or duplicated';
  end if;
end;
$smoke$;

rollback;
select to_regprocedure('public.upsert_warehouse_kiosk_bread_dispatch(date,text,jsonb)') is null as rollback_verified;
