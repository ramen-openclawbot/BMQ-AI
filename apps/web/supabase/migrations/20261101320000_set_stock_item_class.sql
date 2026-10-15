-- Chọn nhóm ngay trên thẻ mặt hàng (owner 16/10: "Ko có nhóm sao ko cho phân loại nhóm lại").
-- Trước đây nhóm chỉ đặt được qua đề xuất phân loại của Bé Mì (decide_stock_catalog_suggestion);
-- khi không còn đề xuất nào, 55 mặt hàng "Chưa có nhóm" không có đường nào để xếp nhóm.
-- set_stock_item_class đặt / đổi nhóm bằng tay (item_class_source = 'manual') với cùng quyền
-- q7_material_inventory_can_edit, và gỡ đề xuất phân loại còn chờ của món đó (superseded).

create or replace function public.set_stock_item_class(
  p_item_id uuid,
  p_class text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_superseded integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_class is null or p_class not in ('raw_material', 'packaging_supply', 'finished_goods', 'non_stock') then
    raise exception 'item_class_invalid' using errcode = '22023';
  end if;

  select * into v_item from public.kitchen_inventory_items where id = p_item_id for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if v_item.merged_into_id is not null then
    raise exception 'item_merged' using errcode = '22023';
  end if;

  update public.kitchen_inventory_items
    set item_class = p_class,
        item_class_source = 'manual',
        updated_at = now()
    where id = p_item_id;

  update public.stock_catalog_suggestions
    set status = 'superseded',
        decided_by = v_actor_id,
        decided_at = now()
    where item_id = p_item_id
      and kind = 'classify'
      and status = 'pending';
  get diagnostics v_superseded = row_count;

  return jsonb_build_object(
    'item_id', p_item_id,
    'old_class', v_item.item_class,
    'item_class', p_class,
    'item_class_source', 'manual',
    'superseded_suggestions', v_superseded
  );
end;
$$;

revoke all on function public.set_stock_item_class(uuid, text) from public, anon;
grant execute on function public.set_stock_item_class(uuid, text) to authenticated, service_role;
