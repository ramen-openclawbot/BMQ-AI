-- Add explicit permission rows for Production Shifts and QA & Finished Goods Receiving.
-- These modules were already visible in the sidebar but were sharing the legacy
-- `production` key, which was not listed in the Quản lý người dùng permission UI.

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
select ur.user_id,
       module_keys.module_key,
       case
         when legacy.user_id is not null then legacy.can_view
         when ur.role = 'staff' then true
         else false
       end as can_view,
       case
         when legacy.user_id is not null then legacy.can_edit
         when ur.role = 'staff' then true
         else false
       end as can_edit
from public.user_roles ur
cross join (values ('production_shifts'), ('production_qa')) as module_keys(module_key)
left join public.user_module_permissions legacy
  on legacy.user_id = ur.user_id
 and legacy.module_key = 'production'
where ur.role <> 'owner'
on conflict (user_id, module_key) do nothing;
