-- 2026-10-19 — Khớp công thức Q7: which products each BOM line is deducted for.
--
-- Owner 19/10 (IMG_5903): accountants must see what a recipe ingredient is being
-- deducted for to judge whether it is right. get_q7_bom_line_products returns, for
-- the given canonical materials, every current Q7 material-issue line after the
-- cutover (same scope as q7_bom_mismatch_review_internal), grouped by finished
-- product and issue. Read-only; same gate as get_q7_bom_mismatch_review.

create or replace function public.get_q7_bom_line_products(p_canonical_material_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cutover date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.q7_material_inventory_can_view(v_actor)
      or public.mission_actor_holds(v_actor, 'q7_bom_mismatch_resolved')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_cutover := public.stock_ledger_cutover_date('q7');
  if v_cutover is null or coalesce(cardinality(p_canonical_material_ids), 0) = 0 then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'canonical_material_id', x.canonical_material_id,
             'sku_id', x.finished_sku_id,
             'product', x.product,
             'sku_code', x.sku_code,
             'issue_id', x.issue_id,
             'issue_number', x.issue_number,
             'issue_date', x.issue_date,
             'qty', x.qty,
             'unit', x.unit
           ) order by x.product, x.issue_date, x.issue_number)
    from (
      select i.canonical_material_id,
             i.finished_sku_id,
             coalesce(nullif(btrim(s.product_name), ''), s.sku_code, 'Không rõ sản phẩm') as product,
             s.sku_code,
             pi.id as issue_id,
             pi.issue_number,
             pi.issue_date,
             round(sum(coalesce(i.required_qty, 0))::numeric, 3) as qty,
             lower(btrim(min(i.source_unit))) as unit
      from public.production_material_issue_items i
      join public.production_material_issues pi on pi.id = i.material_issue_id
      left join public.product_skus s on s.id = i.finished_sku_id
      where i.canonical_material_id = any(p_canonical_material_ids)
        and pi.location_code = 'q7'
        and pi.is_current = true
        and pi.issue_date > v_cutover
        and pi.status not in ('cancelled', 'needs_review')
      group by i.canonical_material_id, i.finished_sku_id, s.product_name, s.sku_code, pi.id, pi.issue_number, pi.issue_date
    ) x
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_q7_bom_line_products(uuid[]) from public, anon;
grant execute on function public.get_q7_bom_line_products(uuid[]) to authenticated, service_role;
