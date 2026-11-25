-- ============================================================================
-- Rollback-only dry run for the delivery tasks migration.
--
-- This file is body-only (no begin/commit/rollback); the verify script wraps it
-- in one transaction that is always rolled back. It uses only the real dealer
-- data of 2026-11-25 and never leaves a row, bucket or cron behind.
-- ============================================================================

create temporary table if not exists _delivery_dryrun (
  task_id uuid,
  customer_id uuid,
  employee_code text,
  before_verified_at timestamptz
) on commit drop;
truncate table _delivery_dryrun;

-- Owner session for the management RPCs.
do $$
declare
  v_owner uuid;
begin
  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;

  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user_roles row';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;

-- ---------------------------------------------------------------------------
-- 1) Generation matches the real dealer orders of 2026-11-25
-- ---------------------------------------------------------------------------
do $$
declare
  v_destinations integer;
  v_quantity numeric;
  v_tasks integer;
  v_task_quantity numeric;
  v_cancelled integer;
  v_result jsonb;
begin
  select
    count(distinct coalesce(i.route_customer_id, o.customer_id)),
    coalesce(sum(i.quantity), 0)
  into v_destinations, v_quantity
  from public.dealer_orders o
  join public.dealer_order_items i on i.order_id = o.id
  where o.requested_delivery_date = '2026-11-25'
    and o.is_test = false
    and o.status <> 'cancelled';

  if v_destinations = 0 then
    raise exception 'CHECK FAIL: no real dealer orders on 2026-11-25';
  end if;

  v_result := public.generate_delivery_tasks('2026-11-25');

  select count(*), coalesce(sum(quantity), 0)
  into v_tasks, v_task_quantity
  from public.delivery_tasks
  where delivery_date = '2026-11-25';

  if v_tasks <> v_destinations then
    raise exception 'CHECK FAIL: tasks % <> distinct destinations %', v_tasks, v_destinations;
  end if;

  if v_task_quantity <> v_quantity then
    raise exception 'CHECK FAIL: task quantity % <> order quantity %', v_task_quantity, v_quantity;
  end if;

  if (v_result->>'tasks')::integer <> v_destinations then
    raise exception 'CHECK FAIL: generate RPC returned % tasks, expected %',
      v_result->>'tasks', v_destinations;
  end if;

  select count(*) into v_cancelled
  from public.delivery_tasks
  where delivery_date = '2026-11-25' and status = 'cancelled';
  if v_cancelled <> 0 then
    raise exception 'CHECK FAIL: generated % cancelled tasks', v_cancelled;
  end if;

  -- 2) Running again creates nothing.
  perform public.generate_delivery_tasks('2026-11-25');

  select count(*), coalesce(sum(quantity), 0)
  into v_tasks, v_task_quantity
  from public.delivery_tasks
  where delivery_date = '2026-11-25';

  if v_tasks <> v_destinations then
    raise exception 'CHECK FAIL: rerun changed task count to % (expected %)', v_tasks, v_destinations;
  end if;
  if v_task_quantity <> v_quantity then
    raise exception 'CHECK FAIL: rerun changed total quantity to % (expected %)',
      v_task_quantity, v_quantity;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Assignment moves a pending task to the new driver
-- ---------------------------------------------------------------------------
do $$
declare
  v_task public.delivery_tasks%rowtype;
  v_assignment jsonb;
  v_updated integer;
begin
  select *
  into v_task
  from public.delivery_tasks
  where delivery_date = '2026-11-25' and status = 'pending'
  order by sort_order, destination_name, id
  limit 1;

  if v_task.id is null then
    raise exception 'CHECK FAIL: no pending delivery task to assign';
  end if;

  -- The RPCs validate the code against the latest catalogue; create a
  -- temporary delivery employee inside this rollback-only transaction.
  insert into public.payroll_bn_period_employees(
    period_id,
    employee_code,
    employee_name,
    group_name,
    employment_type,
    monthly_salary,
    delivery_unit_base
  )
  select
    p.id,
    'DRYRUN_DRV',
    'Dry Run Driver',
    'Giao hàng',
    'delivery',
    2000000,
    2000000
  from public.payroll_bn_periods p
  where p.status = 'draft'
  order by p.date_from desc
  limit 1
  on conflict (period_id, employee_code) do nothing;

  if not exists (
    select 1
    from public.payroll_bn_period_employees e
    where e.employee_code = 'DRYRUN_DRV'
      and e.employment_type = 'delivery'
  ) then
    raise exception 'CHECK FAIL: could not create the dry-run delivery employee';
  end if;

  perform public.upsert_delivery_driver_setting('DRYRUN_DRV', 0.5);

  v_assignment := public.upsert_delivery_assignment(
    v_task.destination_customer_id,
    'DRYRUN_DRV',
    1.25,
    7,
    'dry run assignment'
  );

  if (v_assignment->'assignment'->>'employee_code') <> 'DRYRUN_DRV' then
    raise exception 'CHECK FAIL: assignment did not keep the driver';
  end if;

  select count(*)
  into v_updated
  from public.delivery_tasks
  where destination_customer_id = v_task.destination_customer_id
    and delivery_date = '2026-11-25'
    and status = 'pending'
    and employee_code = 'DRYRUN_DRV'
    and units = 1.25
    and sort_order = 7;

  if v_updated = 0 then
    raise exception 'CHECK FAIL: pending task did not receive the new driver/units/sort';
  end if;

  insert into _delivery_dryrun(task_id, customer_id, employee_code)
  values (v_task.id, v_task.destination_customer_id, 'DRYRUN_DRV');
end $$;

-- ---------------------------------------------------------------------------
-- 4) Fake completion attaches coordinates on a destination without them
-- ---------------------------------------------------------------------------
do $$
declare
  v_task public.delivery_tasks%rowtype;
  v_customer public.mini_crm_customers%rowtype;
  v_verified_before timestamptz;
  v_result jsonb;
begin
  select t.*
  into v_task
  from public.delivery_tasks t
  join _delivery_dryrun d on d.task_id = t.id;

  select * into v_customer
  from public.mini_crm_customers
  where id = v_task.destination_customer_id;

  v_verified_before := v_customer.location_verified_at;

  -- Guarantee the "destination has no coordinates" case even if the real
  -- customer already had a pin (rolled back with the whole transaction).
  if v_customer.location_lat is not null or v_customer.location_lng is not null then
    update public.mini_crm_customers
    set location_lat = null,
        location_lng = null,
        location_source = null
    where id = v_customer.id;
  end if;

  update _delivery_dryrun
  set before_verified_at = v_verified_before
  where task_id = v_task.id;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('role', 'service_role')::text,
    true
  );

  v_result := public.complete_delivery_task(
    p_task_id => v_task.id,
    p_employee_code => 'DRYRUN_DRV',
    p_session_id => null,
    p_device_hash => null,
    p_photo_path => 'DRYRUN/2026-11-25/proof.jpg',
    p_latitude => 10.123456,
    p_longitude => 106.654321,
    p_accuracy_m => 8,
    p_device_captured_at => now() - interval '2 minutes'
  );

  select * into v_task
  from public.delivery_tasks
  where id = v_task.id;

  if v_task.status <> 'completed' then
    raise exception 'CHECK FAIL: task status is %, expected completed', v_task.status;
  end if;
  if v_task.completed_at is null
     or abs(extract(epoch from (now() - v_task.completed_at))) > 300 then
    raise exception 'CHECK FAIL: completed_at is not the server time';
  end if;
  if v_task.latitude <> 10.123456 or v_task.longitude <> 106.654321 then
    raise exception 'CHECK FAIL: stored coordinates differ from the completion';
  end if;
  if v_task.accuracy_m <> 8 then
    raise exception 'CHECK FAIL: accuracy_m was not stored';
  end if;
  if v_task.location_attached is not true then
    raise exception 'CHECK FAIL: location_attached should be true on first completion';
  end if;
  if v_task.distance_m is not null then
    raise exception 'CHECK FAIL: distance_m should be null when coordinates were attached';
  end if;
  if v_task.photo_path <> 'DRYRUN/2026-11-25/proof.jpg' then
    raise exception 'CHECK FAIL: photo_path was not stored';
  end if;
  if (v_result->>'location_attached')::boolean is not true then
    raise exception 'CHECK FAIL: completion RPC did not report location_attached';
  end if;

  select * into v_customer
  from public.mini_crm_customers
  where id = v_task.destination_customer_id;

  if v_customer.location_lat <> 10.123456 or v_customer.location_lng <> 106.654321 then
    raise exception 'CHECK FAIL: destination coordinates were not attached';
  end if;
  if v_customer.location_source <> 'delivery_gps' then
    raise exception 'CHECK FAIL: location_source is %, expected delivery_gps', v_customer.location_source;
  end if;
  if v_customer.location_verified_at is distinct from (
    select before_verified_at from _delivery_dryrun where task_id = v_task.id
  ) then
    raise exception 'CHECK FAIL: location_verified_at must not be set by delivery completion';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5) Regenerating leaves the completed task untouched
-- ---------------------------------------------------------------------------
do $$
declare
  v_before public.delivery_tasks%rowtype;
  v_after public.delivery_tasks%rowtype;
begin
  select * into v_before from public.delivery_tasks
  where id = (select task_id from _delivery_dryrun);

  perform public.generate_delivery_tasks('2026-11-25');

  select * into v_after from public.delivery_tasks
  where id = v_before.id;

  if v_after.status <> 'completed' then
    raise exception 'CHECK FAIL: completed task changed status to %', v_after.status;
  end if;
  if v_after.order_ids is distinct from v_before.order_ids
     or v_after.quantity is distinct from v_before.quantity
     or v_after.items is distinct from v_before.items then
    raise exception 'CHECK FAIL: completed task order data was rewritten';
  end if;
  if v_after.completed_at is distinct from v_before.completed_at
     or v_after.latitude is distinct from v_before.latitude
     or v_after.longitude is distinct from v_before.longitude
     or v_after.photo_path is distinct from v_before.photo_path then
    raise exception 'CHECK FAIL: completed task evidence was rewritten';
  end if;
  if v_after.changed_after_completion is not false then
    raise exception 'CHECK FAIL: unchanged orders raised changed_after_completion';
  end if;
end $$;

-- Restore the owner session after the service-role completion call.
do $$
declare
  v_owner uuid;
begin
  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;

-- ---------------------------------------------------------------------------
-- 6) A 0.3 unit step is rejected
-- ---------------------------------------------------------------------------
do $$
declare
  v_customer_id uuid;
begin
  select customer_id into v_customer_id from _delivery_dryrun limit 1;

  begin
    perform public.upsert_delivery_assignment(v_customer_id, 'DRYRUN_DRV', 0.3, 0, null);
    raise exception 'CHECK FAIL: a 0.3 unit assignment was accepted';
  exception when sqlstate '22023' then
    null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6b) A cancelled point is revived when its order appears again
-- ---------------------------------------------------------------------------
do $$
declare
  v_task_id uuid;
  v_status text;
  v_quantity numeric;
begin
  select t.id
  into v_task_id
  from public.delivery_tasks t
  where t.delivery_date = '2026-11-25'
    and t.status = 'pending'
    and t.id <> (select task_id from _delivery_dryrun)
  order by t.id
  limit 1;

  if v_task_id is null then
    raise exception 'CHECK FAIL: no second pending task for the cancel/revive check';
  end if;

  update public.delivery_tasks
  set status = 'cancelled'
  where id = v_task_id;

  perform public.generate_delivery_tasks('2026-11-25');

  select status, quantity into v_status, v_quantity
  from public.delivery_tasks
  where id = v_task_id;

  if v_status <> 'pending' then
    raise exception 'CHECK FAIL: cancelled task was not revived (status %)', v_status;
  end if;
  if v_quantity is null or v_quantity <= 0 then
    raise exception 'CHECK FAIL: revived task has no quantity';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7) Delivery units per day = base 0.5 + completed units
-- ---------------------------------------------------------------------------
do $$
declare
  v_task public.delivery_tasks%rowtype;
  v_units numeric;
begin
  select * into v_task from public.delivery_tasks
  where id = (select task_id from _delivery_dryrun);

  select units into v_units
  from public.delivery_units_by_day('2026-11-25', '2026-11-25')
  where employee_code = 'DRYRUN_DRV'
    and delivery_date = '2026-11-25';

  if v_units is null then
    raise exception 'CHECK FAIL: delivery_units_by_day returned no row';
  end if;
  if v_units <> 0.5 + v_task.units then
    raise exception 'CHECK FAIL: delivery units % <> base 0.5 + task units %',
      v_units, v_task.units;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7b) A later base change is effective-dated and cannot rewrite earned units
-- ---------------------------------------------------------------------------
do $$
declare
  v_task_units numeric;
  v_units numeric;
  v_effective date;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  select units into v_task_units
  from public.delivery_tasks
  where id = (select task_id from _delivery_dryrun);

  v_effective := (public.upsert_delivery_driver_setting('DRYRUN_DRV', 1.0)->>'effective_from')::date;
  if v_effective <> v_today + 1 then
    raise exception 'CHECK FAIL: base change effective_from % <> tomorrow %',
      v_effective, v_today + 1;
  end if;

  select units into v_units
  from public.delivery_units_by_day('2026-11-25', '2026-11-25')
  where employee_code = 'DRYRUN_DRV'
    and delivery_date = '2026-11-25';

  if v_units <> 0.5 + v_task_units then
    raise exception 'CHECK FAIL: base change rewrote 2026-11-25 units (% <> %)',
      v_units, 0.5 + v_task_units;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8) Anonymous and non-payroll users cannot read; browser writes stay closed
-- ---------------------------------------------------------------------------
do $$
begin
  if has_table_privilege('anon', 'public.delivery_tasks', 'SELECT') then
    raise exception 'CHECK FAIL: anon has SELECT on delivery_tasks';
  end if;
  if has_table_privilege('anon', 'public.delivery_destination_assignments', 'SELECT') then
    raise exception 'CHECK FAIL: anon has SELECT on delivery_destination_assignments';
  end if;
  if has_table_privilege('anon', 'public.delivery_driver_setting_history', 'SELECT') then
    raise exception 'CHECK FAIL: anon has SELECT on delivery_driver_setting_history';
  end if;
  if has_table_privilege('anon', 'public.payroll_bn_delivery_extras', 'SELECT') then
    raise exception 'CHECK FAIL: anon has SELECT on payroll_bn_delivery_extras';
  end if;
  if has_function_privilege('anon', 'public.list_delivery_tasks(date)', 'EXECUTE') then
    raise exception 'CHECK FAIL: anon can execute list_delivery_tasks';
  end if;
  if has_function_privilege('anon', 'public.generate_delivery_tasks(date)', 'EXECUTE') then
    raise exception 'CHECK FAIL: anon can execute generate_delivery_tasks';
  end if;
  if has_table_privilege('authenticated', 'public.delivery_tasks', 'INSERT')
     or has_table_privilege('authenticated', 'public.delivery_tasks', 'UPDATE')
     or has_table_privilege('authenticated', 'public.delivery_tasks', 'DELETE') then
    raise exception 'CHECK FAIL: browsers can write delivery_tasks directly';
  end if;
  if has_table_privilege('authenticated', 'public.delivery_destination_assignments', 'INSERT')
     or has_table_privilege('authenticated', 'public.delivery_destination_assignments', 'UPDATE')
     or has_table_privilege('authenticated', 'public.delivery_destination_assignments', 'DELETE') then
    raise exception 'CHECK FAIL: browsers can write delivery_destination_assignments directly';
  end if;
end $$;

do $$
declare
  v_nobody uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claim.sub', v_nobody::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_nobody, 'role', 'authenticated')::text,
    true
  );

  begin
    perform public.list_delivery_tasks('2026-11-25');
    raise exception 'CHECK FAIL: a user without payroll permission read delivery tasks';
  exception when sqlstate '42501' then
    null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 9) The pg_cron session (no JWT) can generate tasks
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
  v_before integer;
  v_after integer;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);

  select count(*) into v_before from public.delivery_tasks where delivery_date = '2026-11-25';
  perform public.generate_delivery_tasks('2026-11-25');
  select count(*) into v_after from public.delivery_tasks where delivery_date = '2026-11-25';

  if v_after <> v_before then
    raise exception 'CHECK FAIL: cron-style generation changed the task count';
  end if;

  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;

-- ---------------------------------------------------------------------------
-- 10) Bucket and cron are installed exactly as required
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'delivery-proofs' and public = false) then
    raise exception 'CHECK FAIL: private delivery-proofs bucket is missing';
  end if;

  if not exists (
    select 1 from cron.job where jobname = 'delivery-tasks-generate-daily'
  ) then
    raise exception 'CHECK FAIL: delivery-tasks-generate-daily cron is missing';
  end if;

  if not exists (
    select 1 from cron.job where jobname = 'delivery-tasks-refresh'
  ) then
    raise exception 'CHECK FAIL: delivery-tasks-refresh cron is missing';
  end if;

  if not exists (
    select 1 from cron.job where jobname = 'delivery-proofs-retention-daily'
  ) then
    raise exception 'CHECK FAIL: delivery-proofs-retention-daily cron is missing';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 10b) Delivery extras are attributed and restricted to delivery employees
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
  v_period_id uuid;
  v_author uuid;
begin
  select ur.user_id
  into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;

  select p.id
  into v_period_id
  from public.payroll_bn_periods p
  where p.status = 'draft'
  order by p.date_from desc
  limit 1;

  if v_period_id is null then
    raise exception 'CHECK FAIL: no draft period for the delivery extra check';
  end if;

  insert into public.payroll_bn_delivery_extras(
    period_id, employee_code, amount, note
  ) values (
    v_period_id, 'DRYRUN_DRV', 150000, 'dry run extra'
  );

  select created_by
  into v_author
  from public.payroll_bn_delivery_extras
  where period_id = v_period_id
    and employee_code = 'DRYRUN_DRV'
    and note = 'dry run extra'
  order by created_at desc
  limit 1;

  if v_author is distinct from v_owner then
    raise exception 'CHECK FAIL: delivery extra created_by % <> owner %',
      v_author, v_owner;
  end if;

  begin
    insert into public.payroll_bn_delivery_extras(
      period_id, employee_code, amount, note
    ) values (
      v_period_id, 'NOT_A_DRIVER', 1000, 'must be rejected'
    );
    raise exception 'CHECK FAIL: a delivery extra was accepted for a non-driver';
  exception when sqlstate '22023' then
    null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 11) Owner reopen stores reason/evidence and allows an old task to complete
-- ---------------------------------------------------------------------------
do $$
declare
  v_task_id uuid;
  v_task public.delivery_tasks%rowtype;
  v_owner uuid;
begin
  select task_id into v_task_id from _delivery_dryrun limit 1;

  -- Move to a date without a payroll period so the normal window would reject it.
  update public.delivery_tasks
  set delivery_date = '2026-08-15'
  where id = v_task_id;

  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  perform public.reopen_delivery_task(v_task_id, 'dry run reopen');

  select * into v_task from public.delivery_tasks where id = v_task_id;
  if v_task.status <> 'pending' then
    raise exception 'CHECK FAIL: reopen did not return the task to pending';
  end if;
  if v_task.reopen_reason <> 'dry run reopen'
     or v_task.reopened_at is null
     or v_task.reopened_by is null
     or v_task.reopen_evidence is null then
    raise exception 'CHECK FAIL: reopen reason/actor/evidence was not stored';
  end if;
  if v_task.photo_path is not null or v_task.completed_at is not null then
    raise exception 'CHECK FAIL: reopen did not clear the completion evidence';
  end if;

  -- The first completion attached this pin; reopen must remove it (unless a
  -- later CRM pin replaced it, which this dry run does not do).
  if exists (
    select 1
    from public.mini_crm_customers c
    where c.id = v_task.destination_customer_id
      and c.location_lat is not null
  ) then
    raise exception 'CHECK FAIL: reopen left the delivery-attached pin behind';
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('role', 'service_role')::text,
    true
  );

  perform public.complete_delivery_task(
    p_task_id => v_task_id,
    p_employee_code => 'DRYRUN_DRV',
    p_session_id => null,
    p_device_hash => null,
    p_photo_path => 'DRYRUN/2026-08-15/proof2.jpg',
    p_latitude => 10.123456,
    p_longitude => 106.654321,
    p_accuracy_m => 9,
    p_device_captured_at => now()
  );

  select * into v_task from public.delivery_tasks where id = v_task_id;
  if v_task.status <> 'completed' then
    raise exception 'CHECK FAIL: reopened old task could not be completed';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;
