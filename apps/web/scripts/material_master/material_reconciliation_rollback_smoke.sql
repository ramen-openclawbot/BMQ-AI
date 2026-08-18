-- Task 3 executable rollback-only smoke for approved reconciliation linking.
-- Usage: concatenate Task2 migration + Task3 migration + this file into psql/supabase db query.
-- This file is standalone (BEGIN/ROLLBACK). Do not wrap it in another BEGIN.

begin;

create or replace function pg_temp.safe_count(p_regclass text)
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

create temp table task3_smoke_counts_before as
select
  pg_temp.safe_count('public.production_material_issue_items') as production_material_issue_items,
  pg_temp.safe_count('public.q7_material_inventory_movements') as q7_material_inventory_movements,
  (select count(*) from public.material_master_audit_logs) as material_master_audit_logs;
grant select on task3_smoke_counts_before to service_role;

create or replace function pg_temp.assert_sqlstate(p_name text, p_sql text, p_expected text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
  raise exception 'expected % for %', p_expected, p_name;
exception when others then
  if sqlstate <> p_expected then
    raise exception 'unexpected SQLSTATE for %, got %, expected %, message %', p_name, sqlstate, p_expected, sqlerrm;
  end if;
end;
$$;

do $$
begin
  if to_regprocedure('public.apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text)') is null then
    raise exception 'missing apply_approved_material_reconciliation signature';
  end if;
  if to_regprocedure('public.link_approved_material_resolution(uuid, text, uuid, uuid, text)') is null then
    raise exception 'missing link_approved_material_resolution signature';
  end if;
  if has_function_privilege('anon', 'public.apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text)', 'execute') then
    raise exception 'anon must not execute apply_approved_material_reconciliation';
  end if;
  if not has_function_privilege('authenticated', 'public.apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text)', 'execute') then
    raise exception 'authenticated material-master users need atomic RPC execute path';
  end if;
  if not has_function_privilege('service_role', 'public.apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text)', 'execute') then
    raise exception 'service_role automation needs atomic RPC execute path';
  end if;
  if has_function_privilege('service_role', 'public.guard_canonical_material_link_update()', 'execute') then
    raise exception 'service_role must not execute trigger helper directly';
  end if;
end $$;

-- Synthetic fixture. Direct DML is deliberate and rolled back.
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1', 'authenticated', 'authenticated', 'task3-smoke@example.invalid', '', now(), now(), now())
on conflict (id) do nothing;

insert into public.sku_cogs_materials (id, material_code, canonical_name, normalized_name, default_unit, active, version, created_by, updated_by)
values ('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2', 'NVL-T3-SMOKE', 'Task3 Smoke Material', public.material_master_normalize('Task3 Smoke Material'), 'kg', true, 1, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1');

insert into public.kitchen_inventory_items (id, item_code, normalized_key, item_type, name, unit)
values (
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3',
  'T3-SMOKE-KITCHEN',
  public.material_master_normalize('Task3 Smoke Kitchen Item'),
  'ingredient',
  'Task3 Smoke Material',
  'kg'
);

insert into public.product_skus (id, sku_code, product_name, unit, sku_type)
values (
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4',
  'T3-SMOKE-SKU',
  'Task3 Smoke SKU Material',
  'kg',
  'raw_material'
);

create temp table task3_source_before as
select id, item_code, name, unit, canonical_material_id, material_resolution_status, material_resolution_request_id
from public.kitchen_inventory_items
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3';
grant select on task3_source_before to service_role;

-- Switch only after all direct fixture DML: service_role intentionally lacks
-- direct business DML privileges. All business actions below exercise RPCs.
set role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1', true);

create temp table task3_apply as
select public.apply_approved_material_reconciliation(
  'kitchen_inventory',
  'kitchen_inventory_items',
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3',
  'Task3 Smoke Material',
  'T3-SMOKE-KITCHEN',
  'kg',
  null,
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
  'normalized_canonical_name',
  'Task3 smoke exact approval'
) as response;

do $$
declare
  v_response jsonb;
  v_after record;
  v_before record;
begin
  select response into v_response from task3_apply;
  if v_response->>'status' <> 'linked' or v_response->>'source_table' <> 'kitchen_inventory_items' or v_response->>'source_id' <> 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3' or v_response->>'material_id' <> 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2' or v_response->>'request_id' is null then
    raise exception 'atomic apply response mismatch: %', v_response;
  end if;

  select * into v_before from task3_source_before;
  select id, item_code, name, unit, canonical_material_id, material_resolution_status, material_resolution_request_id into v_after
  from public.kitchen_inventory_items where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3';
  if v_after.item_code <> v_before.item_code or v_after.name <> v_before.name or v_after.unit <> v_before.unit then
    raise exception 'atomic apply changed protected source name/code/unit fields';
  end if;
  if v_after.canonical_material_id <> 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2' or v_after.material_resolution_status <> 'linked' or v_after.material_resolution_request_id is null then
    raise exception 'atomic apply did not update exactly canonical/status/request fields';
  end if;
end $$;

create temp table task3_apply_again as
select public.apply_approved_material_reconciliation(
  'kitchen_inventory',
  'kitchen_inventory_items',
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3',
  'Task3 Smoke Material',
  'T3-SMOKE-KITCHEN',
  'kg',
  null,
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
  'normalized_canonical_name',
  'Task3 smoke exact approval repeat'
) as response;

do $$
declare v_response jsonb;
begin
  select response into v_response from task3_apply_again;
  if v_response->>'status' <> 'linked_unchanged' then
    raise exception 'repeat atomic apply must be linked_unchanged: %', v_response;
  end if;
end $$;

-- Direct protected-column DML bypass probes: service_role/authenticated cannot spoof this.
select pg_temp.assert_sqlstate('direct protected service_role product_skus DML', $sql$
  update public.product_skus
  set canonical_material_id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
      material_resolution_status = 'direct_bypass',
      material_resolution_request_id = (select (response->>'request_id')::uuid from task3_apply)
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4'
$sql$, '42501');

set role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1', true);
select pg_temp.assert_sqlstate('direct protected authenticated product_skus DML', $sql$
  update public.product_skus
  set canonical_material_id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
      material_resolution_status = 'direct_bypass',
      material_resolution_request_id = (select (response->>'request_id')::uuid from task3_apply)
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4'
$sql$, '42501');

set role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1', true);
select pg_temp.assert_sqlstate('wrong source table', $sql$
  select public.apply_approved_material_reconciliation('purchase_order','purchase_order_items','aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3','Task3 Smoke Material','T3-SMOKE-KITCHEN','kg',null,'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2','normalized_canonical_name','wrong source')
$sql$, '22023');

select pg_temp.assert_sqlstate('wrong material', $sql$
  select public.apply_approved_material_reconciliation('kitchen_inventory','kitchen_inventory_items','aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3','Task3 Smoke Material','T3-SMOKE-KITCHEN','kg',null,gen_random_uuid(),'normalized_canonical_name','wrong material')
$sql$, '23514');

select pg_temp.assert_sqlstate('unit drift', $sql$
  select public.apply_approved_material_reconciliation('kitchen_inventory','kitchen_inventory_items','aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3','Task3 Smoke Material','T3-SMOKE-KITCHEN','bao',null,'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2','normalized_canonical_name','unit drift')
$sql$, '23514');

select pg_temp.assert_sqlstate('bad exact evidence', $sql$
  select public.apply_approved_material_reconciliation('kitchen_inventory','kitchen_inventory_items','aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3','Task3 Smoke Material','T3-SMOKE-KITCHEN','kg',null,'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2','fuzzy_name_suggestion','bad evidence')
$sql$, '23514');

-- Protected Q7/history/ledger counts must not change (audit append may increase inside the transaction).
do $$
declare b record; a record;
begin
  select * into b from task3_smoke_counts_before;
  select
    pg_temp.safe_count('public.production_material_issue_items') as production_material_issue_items,
    pg_temp.safe_count('public.q7_material_inventory_movements') as q7_material_inventory_movements,
    (select count(*) from public.material_master_audit_logs) as material_master_audit_logs
  into a;
  if a.production_material_issue_items is distinct from b.production_material_issue_items or a.q7_material_inventory_movements is distinct from b.q7_material_inventory_movements then
    raise exception 'protected production_material_issue_items or q7_material_inventory_movements changed';
  end if;
  if a.material_master_audit_logs <= b.material_master_audit_logs then
    raise exception 'expected audited link event inside rollback transaction';
  end if;
end $$;

rollback;

-- Post-rollback absence checks: should return zero rows if executed after the rollback.
select count(*) as task3_smoke_material_rows_after_rollback
from public.sku_cogs_materials
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2';
select count(*) as task3_smoke_source_rows_after_rollback
from public.kitchen_inventory_items
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3';
select count(*) as task3_smoke_sku_rows_after_rollback
from public.product_skus
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4';
