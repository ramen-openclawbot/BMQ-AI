-- Task5 executable rollback-only smoke for GRN canonical material controller.
-- Safe shape: BEGIN fixture/actions/assertions/ROLLBACK, followed by dynamic absence SELECTs.

begin;

select 'task5 exact grn link idempotent' as step;

create or replace function pg_temp.task5_safe_count(p_regclass text)
returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  if to_regclass(p_regclass) is null then
    return null;
  end if;
  execute format('select count(*) from %s', p_regclass) into v_count;
  return v_count;
end;
$$;

create or replace function pg_temp.task5_assert_sqlstate(p_name text, p_sql text, p_expected text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
  raise exception 'expected SQLSTATE % for %', p_expected, p_name;
exception when others then
  if sqlstate <> p_expected then
    raise exception 'unexpected SQLSTATE for %, got %, expected %, message %', p_name, sqlstate, p_expected, sqlerrm;
  end if;
end;
$$;

create temp table task5_smoke_counts_before as
select
  pg_temp.task5_safe_count('public.inventory_items') as inventory_items,
  pg_temp.task5_safe_count('public.inventory_batches') as inventory_batches,
  pg_temp.task5_safe_count('public.inventory_transactions') as inventory_transactions,
  pg_temp.task5_safe_count('public.payment_requests') as payment_requests,
  pg_temp.task5_safe_count('public.payment_request_items') as payment_request_items,
  pg_temp.task5_safe_count('public.production_material_issue_items') as production_material_issue_items,
  pg_temp.task5_safe_count('public.q7_material_inventory_movements') as q7_material_inventory_movements,
  pg_temp.task5_safe_count('public.q7_material_issue_material_mappings') as q7_material_issue_material_mappings,
  pg_temp.task5_safe_count('public.material_master_audit_logs') as material_master_audit_logs;
grant select on task5_smoke_counts_before to service_role;

-- Fixed synthetic IDs. Abort instead of reusing any unexpected production row.
do $$
begin
  if exists (select 1 from auth.users where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51') then raise exception 'Task5 smoke synthetic auth user collision'; end if;
  if exists (select 1 from public.suppliers where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52') then raise exception 'Task5 smoke synthetic supplier collision'; end if;
  if exists (select 1 from public.sku_cogs_materials where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53' or material_code = 'NVL-T5-GRN-SMOKE' or normalized_name = public.material_master_normalize('Task5 GRN Smoke Exact Flour')) then raise exception 'Task5 smoke synthetic material collision'; end if;
  if exists (select 1 from public.goods_receipts where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb55' or receipt_number = 'GRN-T5-SMOKE-ROLLBACK') then raise exception 'Task5 smoke synthetic receipt collision'; end if;
  if exists (select 1 from public.goods_receipt_items where id in ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb57')) then raise exception 'Task5 smoke synthetic receipt item collision'; end if;
end $$;

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', 'authenticated', 'authenticated', 'task5-grn-smoke@example.invalid', '', now(), now(), now());

insert into public.user_roles (user_id, role)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', 'owner')
on conflict do nothing;

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', 'material_master', true, true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', 'goods_receipts', true, true)
on conflict (user_id, module_key) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;

insert into public.suppliers (id, name, category, created_by, short_code)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52', 'Task5 GRN Smoke Supplier', 'rollback smoke', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', 'T5GRN');

insert into public.sku_cogs_materials (id, material_code, canonical_name, normalized_name, default_unit, active, version, created_by, updated_by)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53', 'NVL-T5-GRN-SMOKE', 'Task5 GRN Smoke Exact Flour', public.material_master_normalize('Task5 GRN Smoke Exact Flour'), 'kg', true, 1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51');

insert into public.material_supplier_products (id, material_id, supplier_id, supplier_product_code, supplier_product_name, normalized_supplier_product_name, purchase_unit, base_quantity, base_unit, approved, approved_by, approved_at, active, created_by)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb54', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52', 'T5-GRN-SP', 'Task5 GRN Smoke Exact Flour', public.material_master_normalize('Task5 GRN Smoke Exact Flour'), 'kg', 1, 'kg', true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', now(), true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51');

insert into public.material_price_history (material_id, supplier_product_id, price_type, price, price_unit, effective_from, effective_to, approved, approved_by, approved_at, created_by)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb54', 'purchase_price', 42000, 'kg', current_date, null, true, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', now(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51');

insert into public.goods_receipts (id, receipt_number, supplier_id, receipt_date, image_url, status, total_quantity, notes, created_by, payable_status)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb55', 'GRN-T5-SMOKE-ROLLBACK', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52', current_date, 'task5-smoke://delivery-note', 'confirmed', 3, 'Task5 rollback-only fixture', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', 'not_generated');

insert into public.goods_receipt_items (id, goods_receipt_id, product_name, quantity, unit, ordered_quantity, actual_quantity, unit_price, line_status, notes)
values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb55', 'Task5 GRN Smoke Exact Flour', 1, 'kg', 1, 1, 42000, 'du', 'exact resolvable line'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb57', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb55', 'Task5 GRN Smoke Unresolved Spice', 2, 'kg', 2, 2, 21000, 'du', 'intentionally unresolved line');

create temp table task5_exact_line_before as
select id, product_name, quantity, actual_quantity, unit_price, canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name
from public.goods_receipt_items
where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56';
grant select on task5_exact_line_before to service_role;

-- Switch after direct fixture DML; runtime actions below exercise service-role/auth claims and RPC/trigger paths.
set role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', true);
select set_config('request.jwt.claims', jsonb_build_object('role','service_role','sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51')::text, true);

create temp table task5_apply_first as
select public.apply_goods_receipt_item_material_resolution(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53',
  'Task5 GRN Smoke Exact Flour',
  'NVL-T5-GRN-SMOKE',
  'kg',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52',
  'match_delivery_note',
  'Task5 smoke exact GRN link'
) as response;
grant select on task5_apply_first to service_role;

create temp table task5_apply_second as
select public.apply_goods_receipt_item_material_resolution(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53',
  'Task5 GRN Smoke Exact Flour',
  'NVL-T5-GRN-SMOKE',
  'kg',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52',
  'match_delivery_note',
  'Task5 smoke exact GRN link repeat'
) as response;
grant select on task5_apply_second to service_role;

do $$
declare
  v_first jsonb;
  v_second jsonb;
  v_before record;
  v_after record;
begin
  select response into v_first from task5_apply_first;
  select response into v_second from task5_apply_second;
  if v_first->>'status' <> 'linked' or v_first->>'source_table' <> 'goods_receipt_items' or v_first->>'source_id' <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56' or v_first->>'material_id' <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53' or v_first->>'request_id' is null then
    raise exception 'Task5 first exact apply response mismatch: %', v_first;
  end if;
  if v_second->>'status' <> 'linked_unchanged' or v_second->>'request_id' <> v_first->>'request_id' then
    raise exception 'Task5 repeat exact apply did not preserve request id: first %, second %', v_first, v_second;
  end if;
  select * into v_before from task5_exact_line_before;
  select id, product_name, quantity, actual_quantity, unit_price, canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name
  into v_after
  from public.goods_receipt_items where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56';
  if v_after.product_name <> v_before.product_name or v_after.quantity <> v_before.quantity or v_after.actual_quantity <> v_before.actual_quantity or v_after.unit_price <> v_before.unit_price then
    raise exception 'Task5 exact apply changed immutable GR item source values';
  end if;
  if v_after.canonical_material_id <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53' or v_after.material_resolution_status <> 'resolved_exact' or v_after.material_resolution_request_id <> (v_first->>'request_id')::uuid or v_after.raw_product_name <> 'Task5 GRN Smoke Exact Flour' then
    raise exception 'Task5 exact apply did not update only canonical/status/request/raw snapshot: %', row_to_json(v_after);
  end if;
end $$;

select pg_temp.task5_assert_sqlstate('wrong material negative exact', $sql$
  select public.apply_goods_receipt_item_material_resolution('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56', gen_random_uuid(), 'Task5 GRN Smoke Exact Flour', 'NVL-T5-GRN-SMOKE', 'kg', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52', 'match_delivery_note', 'wrong material')
$sql$, '23514');
select pg_temp.task5_assert_sqlstate('wrong unit negative exact', $sql$
  select public.apply_goods_receipt_item_material_resolution('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53', 'Task5 GRN Smoke Exact Flour', 'NVL-T5-GRN-SMOKE', 'bag', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52', 'match_delivery_note', 'wrong unit')
$sql$, '23514');
select pg_temp.task5_assert_sqlstate('wrong supplier negative exact', $sql$
  select public.apply_goods_receipt_item_material_resolution('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53', 'Task5 GRN Smoke Exact Flour', 'NVL-T5-GRN-SMOKE', 'kg', gen_random_uuid(), 'match_delivery_note', 'wrong supplier')
$sql$, '23514');
select pg_temp.task5_assert_sqlstate('raw drift negative exact', $sql$
  select public.apply_goods_receipt_item_material_resolution('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53', 'Task5 GRN Smoke Drifted Flour', 'NVL-T5-GRN-SMOKE', 'kg', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52', 'match_delivery_note', 'raw drift')
$sql$, '23514');

do $$
declare v_line public.goods_receipt_items%rowtype;
begin
  select * into v_line from public.goods_receipt_items where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56';
  if v_line.canonical_material_id <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53' or v_line.material_resolution_status <> 'resolved_exact' or v_line.material_resolution_request_id <> (select (response->>'request_id')::uuid from task5_apply_first) then
    raise exception 'Task5 negative exact calls changed linked line';
  end if;
end $$;

select 'task5 spoofed guc service_role 42501' as step;
select set_config('material_master.goods_receipt_item_resolution', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb57', true);
select pg_temp.task5_assert_sqlstate('direct protected service_role goods_receipt_items DML', $sql$
  update public.goods_receipt_items
  set canonical_material_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53',
      material_resolution_status = 'resolved_exact',
      material_resolution_request_id = (select (response->>'request_id')::uuid from task5_apply_first),
      raw_product_name = 'Task5 GRN Smoke Unresolved Spice'
  where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb57'
$sql$, '42501');
select set_config('material_master.goods_receipt_item_resolution', '', true);

select 'task5 spoofed guc authenticated 42501' as step;
set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', true);
select set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51')::text, true);
select set_config('material_master.goods_receipt_item_resolution', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb57', true);
select pg_temp.task5_assert_sqlstate('direct protected authenticated goods_receipt_items DML', $sql$
  update public.goods_receipt_items
  set canonical_material_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53',
      material_resolution_status = 'resolved_exact',
      material_resolution_request_id = (select (response->>'request_id')::uuid from task5_apply_first),
      raw_product_name = 'Task5 GRN Smoke Unresolved Spice'
  where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb57'
$sql$, '42501');
select set_config('material_master.goods_receipt_item_resolution', '', true);

set role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51', true);
select set_config('request.jwt.claims', jsonb_build_object('role','service_role','sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51')::text, true);

select 'task5 shadow readiness reports blockers' as step;
insert into public.material_master_enforcement_config(source_type, mode, updated_by)
values ('goods_receipt', 'shadow', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51')
on conflict (source_type) do update set mode = 'shadow', updated_by = excluded.updated_by, updated_at = now();

create temp table task5_shadow_ready as
select public.assert_goods_receipt_materials_ready('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb55', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51') as response;
grant select on task5_shadow_ready to service_role;

do $$
declare
  v_response jsonb;
  b record;
  a record;
begin
  select response into v_response from task5_shadow_ready;
  if coalesce((v_response->>'ready')::boolean, true) is not false or v_response->>'mode' <> 'shadow' or jsonb_array_length(v_response->'blockers') = 0 then
    raise exception 'Task5 shadow readiness expected ready=false/mode=shadow/blockers: %', v_response;
  end if;
  select * into b from task5_smoke_counts_before;
  select
    pg_temp.task5_safe_count('public.inventory_items') as inventory_items,
    pg_temp.task5_safe_count('public.inventory_batches') as inventory_batches,
    pg_temp.task5_safe_count('public.inventory_transactions') as inventory_transactions,
    pg_temp.task5_safe_count('public.payment_requests') as payment_requests,
    pg_temp.task5_safe_count('public.payment_request_items') as payment_request_items,
    pg_temp.task5_safe_count('public.production_material_issue_items') as production_material_issue_items,
    pg_temp.task5_safe_count('public.q7_material_inventory_movements') as q7_material_inventory_movements,
    pg_temp.task5_safe_count('public.q7_material_issue_material_mappings') as q7_material_issue_material_mappings
  into a;
  if a.inventory_items is distinct from b.inventory_items or a.inventory_batches is distinct from b.inventory_batches or a.inventory_transactions is distinct from b.inventory_transactions or a.payment_requests is distinct from b.payment_requests or a.payment_request_items is distinct from b.payment_request_items or a.production_material_issue_items is distinct from b.production_material_issue_items or a.q7_material_inventory_movements is distinct from b.q7_material_inventory_movements or a.q7_material_issue_material_mappings is distinct from b.q7_material_issue_material_mappings then
    raise exception 'Task5 shadow readiness mutated protected stock/payable/history/Q7 counts';
  end if;
end $$;

select 'task5 enforced unresolved finalization blocked before mutation' as step;
insert into public.material_master_enforcement_config(source_type, mode, updated_by)
values ('goods_receipt', 'enforced', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51')
on conflict (source_type) do update set mode = 'enforced', updated_by = excluded.updated_by, updated_at = now();

select pg_temp.task5_assert_sqlstate('enforced unresolved finalize wrapper blocks before unchecked finalizer', $sql$
  select public.finalize_goods_receipt('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb55', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51')
$sql$, '23514');

do $$
declare
  b record;
  a record;
  v_receipt record;
  v_unresolved record;
begin
  select * into b from task5_smoke_counts_before;
  select
    pg_temp.task5_safe_count('public.inventory_items') as inventory_items,
    pg_temp.task5_safe_count('public.inventory_batches') as inventory_batches,
    pg_temp.task5_safe_count('public.inventory_transactions') as inventory_transactions,
    pg_temp.task5_safe_count('public.payment_requests') as payment_requests,
    pg_temp.task5_safe_count('public.payment_request_items') as payment_request_items,
    pg_temp.task5_safe_count('public.production_material_issue_items') as production_material_issue_items,
    pg_temp.task5_safe_count('public.q7_material_inventory_movements') as q7_material_inventory_movements,
    pg_temp.task5_safe_count('public.q7_material_issue_material_mappings') as q7_material_issue_material_mappings
  into a;
  if a.inventory_items is distinct from b.inventory_items or a.inventory_batches is distinct from b.inventory_batches or a.inventory_transactions is distinct from b.inventory_transactions or a.payment_requests is distinct from b.payment_requests or a.payment_request_items is distinct from b.payment_request_items or a.production_material_issue_items is distinct from b.production_material_issue_items or a.q7_material_inventory_movements is distinct from b.q7_material_inventory_movements or a.q7_material_issue_material_mappings is distinct from b.q7_material_issue_material_mappings then
    raise exception 'Task5 enforced blocker did not preserve protected counts before unchecked finalizer';
  end if;
  select status, payable_status, payment_request_id, finalized_at, finalized_by into v_receipt from public.goods_receipts where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb55';
  if v_receipt.status <> 'confirmed' or v_receipt.payable_status <> 'not_generated' or v_receipt.payment_request_id is not null or v_receipt.finalized_at is not null or v_receipt.finalized_by is not null then
    raise exception 'Task5 enforced blocker allowed finalize receipt mutation: %', row_to_json(v_receipt);
  end if;
  select canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name into v_unresolved from public.goods_receipt_items where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb57';
  if v_unresolved.canonical_material_id is not null or v_unresolved.material_resolution_status is not null or v_unresolved.material_resolution_request_id is not null or v_unresolved.raw_product_name is not null then
    raise exception 'Task5 unresolved line changed unexpectedly: %', row_to_json(v_unresolved);
  end if;
end $$;

select 'task5 protected history/q7/ledger counts unchanged' as step;
do $$
declare
  b record;
  a record;
begin
  select * into b from task5_smoke_counts_before;
  select
    pg_temp.task5_safe_count('public.inventory_items') as inventory_items,
    pg_temp.task5_safe_count('public.inventory_batches') as inventory_batches,
    pg_temp.task5_safe_count('public.inventory_transactions') as inventory_transactions,
    pg_temp.task5_safe_count('public.payment_requests') as payment_requests,
    pg_temp.task5_safe_count('public.payment_request_items') as payment_request_items,
    pg_temp.task5_safe_count('public.production_material_issue_items') as production_material_issue_items,
    pg_temp.task5_safe_count('public.q7_material_inventory_movements') as q7_material_inventory_movements,
    pg_temp.task5_safe_count('public.q7_material_issue_material_mappings') as q7_material_issue_material_mappings,
    pg_temp.task5_safe_count('public.material_master_audit_logs') as material_master_audit_logs
  into a;
  if a.inventory_items is distinct from b.inventory_items or a.inventory_batches is distinct from b.inventory_batches or a.inventory_transactions is distinct from b.inventory_transactions or a.payment_requests is distinct from b.payment_requests or a.payment_request_items is distinct from b.payment_request_items or a.production_material_issue_items is distinct from b.production_material_issue_items or a.q7_material_inventory_movements is distinct from b.q7_material_inventory_movements or a.q7_material_issue_material_mappings is distinct from b.q7_material_issue_material_mappings then
    raise exception 'Task5 protected stock/payable/history/Q7/ledger counts changed';
  end if;
  if a.material_master_audit_logs <= b.material_master_audit_logs then
    raise exception 'Task5 smoke expected rollback-only material audit events';
  end if;
end $$;

rollback;

-- Post-rollback absence checks use dynamic SQL so the file is safe even when Task2-created tables roll back too.
create or replace function pg_temp.task5_safe_absence_count(p_regclass text, p_where text)
returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  if to_regclass(p_regclass) is null then
    return null;
  end if;
  execute format('select count(*) from %s where %s', p_regclass, p_where) into v_count;
  return v_count;
end;
$$;

select
  pg_temp.task5_safe_absence_count('auth.users', $$id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb51'$$) as task5_auth_users_after_rollback,
  pg_temp.task5_safe_absence_count('public.suppliers', $$id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb52'$$) as task5_suppliers_after_rollback,
  pg_temp.task5_safe_absence_count('public.sku_cogs_materials', $$id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb53' or material_code = 'NVL-T5-GRN-SMOKE'$$) as task5_materials_after_rollback,
  pg_temp.task5_safe_absence_count('public.material_supplier_products', $$id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb54'$$) as task5_supplier_products_after_rollback,
  pg_temp.task5_safe_absence_count('public.goods_receipts', $$id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb55' or receipt_number = 'GRN-T5-SMOKE-ROLLBACK'$$) as task5_receipts_after_rollback,
  pg_temp.task5_safe_absence_count('public.goods_receipt_items', $$id in ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb56','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb57')$$) as task5_receipt_items_after_rollback,
  pg_temp.task5_safe_absence_count('public.material_resolution_requests', $$source_table = 'goods_receipt_items' and source_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb55'$$) as task5_requests_after_rollback;
