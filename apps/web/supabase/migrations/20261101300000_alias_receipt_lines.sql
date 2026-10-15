-- Phiếu giao hàng trong nhiệm vụ "Sửa bí danh sai hệ số" (owner 16/10: "Phải có ảnh giao hàng a mới check lại đc").
-- get_alias_receipt_lines(alias) trả các lần nhập gần nhất của đúng bí danh đó (cùng kho, nhà cung cấp, tên chuẩn hoá),
-- cùng định dạng với get_crate_receipt_lines nhưng nhìn lại 365 ngày vì bí danh cần sửa thường lâu không nhập.
-- Chỉ đọc; quyền giống get_crate_receipt_lines / update_stock_material_alias_factor (material_alias_can_admin).

create or replace function public.get_alias_receipt_lines(
  p_alias_id uuid,
  p_limit integer default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 6), 20));
  v_alias public.stock_material_aliases%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  select * into v_alias from public.stock_material_aliases where id = p_alias_id;
  if not found then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(t) order by t.receipt_date desc, t.receipt_number desc)
    from (
      select
        b.goods_receipt_id,
        b.goods_receipt_item_id,
        b.receipt_number,
        b.receipt_date,
        b.status,
        sup.name as supplier_name,
        coalesce(
          (select c.corrected_name
             from public.stock_name_corrections c
            where c.normalized_name = b.normalized_name),
          b.raw_name
        ) as raw_name,
        public.goods_receipt_effective_quantity(
          gri.actual_quantity, gri.quantity, gri.ordered_quantity, gr.status::text
        ) as quantity,
        b.unit,
        b.unit_price,
        public.goods_receipt_effective_quantity(
          gri.actual_quantity, gri.quantity, gri.ordered_quantity, gr.status::text
        ) * b.unit_price as line_total,
        b.image_path,
        b.photo_paths
      from public.receipt_lines_for_game_base(365) b
      join public.goods_receipt_items gri on gri.id = b.goods_receipt_item_id
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      left join public.suppliers sup on sup.id = b.supplier_id
      where b.location = v_alias.location
        and b.supplier_id is not distinct from v_alias.supplier_id
        and b.normalized_name = v_alias.normalized_name
      order by b.receipt_date desc, b.receipt_number desc
      limit v_limit
    ) t
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_alias_receipt_lines(uuid, integer) from public, anon;
grant execute on function public.get_alias_receipt_lines(uuid, integer) to authenticated, service_role;
