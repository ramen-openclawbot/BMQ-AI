-- ============================================================================
-- BMQ-AI | RBAC Data Repair Script (safe, no ON CONFLICT on user_roles)
-- Purpose:
--   1) Fix thuy@bmq.vn mapping (profiles/user_roles/user_module_permissions)
--   2) Audit all non-owner users
--   3) Re-apply default permissions for all non-owner users
-- Notes:
--   - Designed to avoid ON CONFLICT on public.user_roles (may have no unique user_id)
--   - Uses UPDATE + INSERT WHERE NOT EXISTS patterns
-- ============================================================================

begin;

-- ============================================================================
-- A) FIX SPECIFIC USER: thuy@bmq.vn
-- ============================================================================

-- A1) Snapshot ids for target user
create temp table tmp_fix_target as
select
  (select id from auth.users where lower(email) = 'thuy@bmq.vn' limit 1) as auth_user_id,
  (select user_id from public.profiles where lower(email) = 'thuy@bmq.vn' limit 1) as profile_user_id;

-- A2) Sanity check: must have auth user
-- (If auth_user_id is null, stop and create/invite user first)
select * from tmp_fix_target;

-- A3) Move profiles.user_id -> auth.users.id (if mismatched)
update public.profiles p
set user_id = t.auth_user_id
from tmp_fix_target t
where lower(p.email) = 'thuy@bmq.vn'
  and t.auth_user_id is not null
  and p.user_id is distinct from t.auth_user_id;

-- A4) Move/merge role from old profile_user_id -> auth_user_id
-- 4.1 Update existing role row on auth_user_id (if exists)
update public.user_roles ur_target
set role = ur_old.role
from tmp_fix_target t
join public.user_roles ur_old on ur_old.user_id = t.profile_user_id
where t.auth_user_id is not null
  and ur_target.user_id = t.auth_user_id;

-- 4.2 Insert role row if auth_user_id does not have one yet
insert into public.user_roles (user_id, role)
select t.auth_user_id, ur_old.role
from tmp_fix_target t
join public.user_roles ur_old on ur_old.user_id = t.profile_user_id
where t.auth_user_id is not null
  and not exists (
    select 1
    from public.user_roles ur
    where ur.user_id = t.auth_user_id
  );

-- A5) Move/merge permissions from old profile_user_id -> auth_user_id
-- 5.1 Update existing target rows by module_key
update public.user_module_permissions target
set
  can_view = src.can_view,
  can_edit = src.can_edit
from tmp_fix_target t
join public.user_module_permissions src
  on src.user_id = t.profile_user_id
where t.auth_user_id is not null
  and target.user_id = t.auth_user_id
  and target.module_key = src.module_key;

-- 5.2 Insert missing target rows
insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
select t.auth_user_id, src.module_key, src.can_view, src.can_edit
from tmp_fix_target t
join public.user_module_permissions src
  on src.user_id = t.profile_user_id
where t.auth_user_id is not null
  and not exists (
    select 1
    from public.user_module_permissions x
    where x.user_id = t.auth_user_id
      and x.module_key = src.module_key
  );

-- A6) Cleanup old role/permission rows if old_id != new_id
delete from public.user_module_permissions ump
using tmp_fix_target t
where t.profile_user_id is not null
  and t.auth_user_id is not null
  and t.profile_user_id <> t.auth_user_id
  and ump.user_id = t.profile_user_id;

delete from public.user_roles ur
using tmp_fix_target t
where t.profile_user_id is not null
  and t.auth_user_id is not null
  and t.profile_user_id <> t.auth_user_id
  and ur.user_id = t.profile_user_id;


-- ============================================================================
-- B) AUDIT ALL NON-OWNER USERS
-- ============================================================================

-- B1) Core audit table (only users with non-owner role)
create temp table tmp_non_owner_audit as
select
  au.id as auth_user_id,
  lower(au.email) as auth_email,
  p.user_id as profile_user_id,
  lower(p.email) as profile_email,
  ur.role,
  (p.user_id is not null) as has_profile,
  coalesce(perm.perm_count, 0) as perm_count
from public.user_roles ur
join auth.users au on au.id = ur.user_id
left join public.profiles p on p.user_id = au.id
left join (
  select user_id, count(*) as perm_count
  from public.user_module_permissions
  group by user_id
) perm on perm.user_id = au.id
where ur.role <> 'owner'
order by lower(au.email);

-- View audit summary
select * from tmp_non_owner_audit;

-- B2) Orphan profiles (profile points to deleted/nonexistent auth.users)
select p.*
from public.profiles p
left join auth.users au on au.id = p.user_id
where au.id is null
order by lower(coalesce(p.email, ''));

-- B3) Orphan roles
select ur.*
from public.user_roles ur
left join auth.users au on au.id = ur.user_id
where au.id is null;

-- B4) Orphan permissions
select ump.user_id, count(*) as perm_rows
from public.user_module_permissions ump
left join auth.users au on au.id = ump.user_id
where au.id is null
group by ump.user_id;


-- ============================================================================
-- C) RE-APPLY DEFAULT PERMISSIONS FOR ALL NON-OWNER USERS
-- ============================================================================

-- C1) Build desired matrix
create temp table tmp_module_keys as
select unnest(array[
  'dashboard','reports','niraan_dashboard','finance_cost','finance_revenue','crm',
  'sales_po_inbox','purchase_orders','inventory','goods_receipts','sku_costs',
  'suppliers','invoices','payment_requests','low_stock','settings'
]) as module_key;

create temp table tmp_desired_permissions as
select
  ur.user_id,
  mk.module_key,
  case
    when ur.role = 'staff' then mk.module_key in (
      'dashboard','reports','finance_cost','finance_revenue','crm','sales_po_inbox',
      'purchase_orders','inventory','goods_receipts','sku_costs','suppliers','invoices',
      'payment_requests','low_stock','settings'
    )
    when ur.role = 'warehouse' then mk.module_key in (
      'dashboard','purchase_orders','inventory','goods_receipts','suppliers','invoices','low_stock','settings'
    )
    when ur.role = 'viewer' then mk.module_key in ('dashboard','inventory','low_stock','settings')
    else false
  end as can_view,
  case
    when ur.role = 'staff' then mk.module_key in (
      'dashboard','finance_cost','finance_revenue','crm','sales_po_inbox',
      'purchase_orders','suppliers','invoices','payment_requests'
    )
    when ur.role = 'warehouse' then mk.module_key in ('inventory','goods_receipts')
    when ur.role = 'viewer' then false
    else false
  end as can_edit
from public.user_roles ur
join auth.users au on au.id = ur.user_id
cross join tmp_module_keys mk
where ur.role <> 'owner';

-- C2) Update existing rows
update public.user_module_permissions target
set
  can_view = d.can_view,
  can_edit = d.can_edit
from tmp_desired_permissions d
where target.user_id = d.user_id
  and target.module_key = d.module_key;

-- C3) Insert missing rows
insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
select d.user_id, d.module_key, d.can_view, d.can_edit
from tmp_desired_permissions d
where not exists (
  select 1
  from public.user_module_permissions x
  where x.user_id = d.user_id
    and x.module_key = d.module_key
);

-- C4) Final verification for thuy@bmq.vn
select
  au.id as auth_user_id,
  au.email,
  ur.role,
  ump.module_key,
  ump.can_view,
  ump.can_edit
from auth.users au
left join public.user_roles ur on ur.user_id = au.id
left join public.user_module_permissions ump on ump.user_id = au.id
where lower(au.email) = 'thuy@bmq.vn'
order by ump.module_key;

commit;

-- ============================================================================
-- END
-- ============================================================================
