-- Owner 23/10: the "Đặt hàng" card in the item detail was hidden for every user.
-- The client read q7_purchase_item_settings directly, but that table's RLS calls
-- q7_material_inventory_can_view(), which authenticated cannot execute, so the
-- select failed and the card stayed hidden. This definer RPC is the card's gate:
-- it returns the order supplier for owners / purchase editors, else null.

create or replace function public.supplier_order_setting(p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if p_item_id is null then
    return null;
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.has_role(v_actor, 'owner')
         or public.has_module_permission(v_actor, 'purchase_orders', 'edit')
       ) then
      return null;
    end if;
  end if;

  select jsonb_build_object(
    'supplier_id', s.supplier_id,
    'supplier_name', btrim(su.name),
    'po_unit', s.po_unit
  )
  into v_result
  from public.q7_purchase_item_settings s
  join public.suppliers su on su.id = s.supplier_id
  where s.kitchen_inventory_item_id = p_item_id
    and s.po_unit is not null
    and s.po_unit_factor is not null;

  return v_result;
end;
$$;

revoke all on function public.supplier_order_setting(uuid) from public, anon;
grant execute on function public.supplier_order_setting(uuid) to authenticated, service_role;
