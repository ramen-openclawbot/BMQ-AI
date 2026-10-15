-- Xếp nhóm nhiều món cùng lúc trên kệ (owner 16/10: "Cho chọn nhiều món để phân loại cùng lúc").
-- set_stock_items_class gọi set_stock_item_class cho từng món trong một giao dịch: một món lỗi thì cả lô
-- không đổi. Cùng quyền (q7_material_inventory_can_edit), tối đa 200 món mỗi lần.

create or replace function public.set_stock_items_class(
  p_item_ids uuid[],
  p_class text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_superseded integer := 0;
  v_result jsonb;
begin
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_item_ids, '{}')) x where x is not null;
  if cardinality(v_ids) = 0 then
    raise exception 'item_ids_required' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 200 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;

  foreach v_id in array v_ids loop
    v_result := public.set_stock_item_class(v_id, p_class);
    v_superseded := v_superseded + coalesce((v_result ->> 'superseded_suggestions')::integer, 0);
  end loop;

  return jsonb_build_object(
    'item_class', p_class,
    'updated', cardinality(v_ids),
    'superseded_suggestions', v_superseded
  );
end;
$$;

revoke all on function public.set_stock_items_class(uuid[], text) from public, anon;
grant execute on function public.set_stock_items_class(uuid[], text) to authenticated, service_role;
