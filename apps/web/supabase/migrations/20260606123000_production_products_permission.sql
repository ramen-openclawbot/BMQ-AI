-- Dedicated permission key for Production Product Management / label-spec page.
-- Keep existing Q7-planning users working by copying their production_q7 access once.

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
select
  p.user_id,
  'production_products' as module_key,
  coalesce(q7.can_view, ur.role in ('owner', 'staff')) as can_view,
  coalesce(q7.can_edit, ur.role in ('owner', 'staff')) as can_edit
from public.profiles p
join auth.users au on au.id = p.user_id
left join public.user_roles ur on ur.user_id = p.user_id
left join public.user_module_permissions q7
  on q7.user_id = p.user_id
 and q7.module_key = 'production_q7'
where not exists (
  select 1
  from public.user_module_permissions existing
  where existing.user_id = p.user_id
    and existing.module_key = 'production_products'
)
on conflict (user_id, module_key) do nothing;
