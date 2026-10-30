-- 2026-10-30 — kitchen_item_suppliers: read through a SECURITY DEFINER RPC.
--
-- The SELECT policy added in 20261103460000 calls q7_material_inventory_can_view(), which signed-in users
-- cannot execute ("permission denied for function"), so the app's direct read of the table failed with
-- "Không tải được nhà cung cấp của món này".  The table is now read only through kho_get_item_suppliers(),
-- which runs the same permission check as the definer.

create or replace function public.kho_get_item_suppliers(p_item_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result uuid[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not (
      public.q7_material_inventory_can_view(v_actor)
      or public.stock_count_can_view('q7')
      or public.stock_count_can_view('tan_tao')
      or public.kho_item_can_edit(v_actor)
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_item_id is null then
    return '{}'::uuid[];
  end if;
  select coalesce(array_agg(kis.supplier_id order by kis.created_at, kis.supplier_id), '{}'::uuid[])
    into v_result
  from public.kitchen_item_suppliers kis
  where kis.item_id = p_item_id;
  return v_result;
end;
$$;

revoke all on function public.kho_get_item_suppliers(uuid) from public, anon;
grant execute on function public.kho_get_item_suppliers(uuid) to authenticated, service_role;

-- Direct reads go through the RPC; the policy that called the unexecutable function is dropped.
drop policy if exists kitchen_item_suppliers_select on public.kitchen_item_suppliers;
revoke select on table public.kitchen_item_suppliers from authenticated;
