-- Phiếu giao hàng trong nhiệm vụ "Dọn đơn vị lạ trên phiếu" (owner 16/10: "Thêm ảnh phiếu giao hàng vào nhiệm vụ").
-- get_unit_variant_receipt_lines(unit) trả các dòng phiếu nhập gần nhất ghi đúng đơn vị lạ đó
-- (so khớp lower(btrim(unit)) như stock_unknown_purchase_unit_rows), cùng định dạng với get_crate_receipt_lines.
-- Cửa sổ ngày mặc định 60 như nhiệm vụ wh-unknown-units. Chỉ đọc; quyền giống resolve_unknown_purchase_unit.

create or replace function public.get_unit_variant_receipt_lines(
  p_unit text,
  p_days integer default 60,
  p_limit integer default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_variant text := lower(btrim(coalesce(p_unit, '')));
  v_days integer := greatest(1, least(coalesce(p_days, 60), 365));
  v_limit integer := greatest(1, least(coalesce(p_limit, 8), 20));
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;
  if v_variant = '' then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(t) order by t.receipt_date desc, t.receipt_number desc)
    from (
      select
        gr.id as goods_receipt_id,
        gri.id as goods_receipt_item_id,
        gr.receipt_number,
        gr.receipt_date,
        gr.status::text as status,
        sup.name as supplier_name,
        coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as raw_name,
        public.goods_receipt_effective_quantity(
          gri.actual_quantity, gri.quantity, gri.ordered_quantity, gr.status::text
        ) as quantity,
        nullif(btrim(gri.unit), '') as unit,
        gri.unit_price,
        public.goods_receipt_effective_quantity(
          gri.actual_quantity, gri.quantity, gri.ordered_quantity, gr.status::text
        ) * gri.unit_price as line_total,
        nullif(btrim(gr.image_url), '') as image_path,
        coalesce(gr.product_photos, '{}'::text[]) as photo_paths
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      left join public.suppliers sup on sup.id = gr.supplier_id
      where lower(btrim(gri.unit)) = v_variant
        and gr.receipt_date >= v_today - v_days
      order by gr.receipt_date desc, gr.receipt_number desc
      limit v_limit
    ) t
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_unit_variant_receipt_lines(text, integer, integer) from public, anon;
grant execute on function public.get_unit_variant_receipt_lines(text, integer, integer) to authenticated, service_role;
