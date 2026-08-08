-- Permission-gated full report detail for the management editor.

create or replace function public.get_kiosk_point_report_detail(p_report_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_revenue', 'view')
    or public.has_module_permission(v_actor, 'finance_revenue', 'edit')
  ) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;

  select jsonb_build_object(
    'report_id', report.id,
    'report_date', report.report_date,
    'report_notes', report.notes,
    'location_name', report.location_name_snapshot,
    'staff_name', report.staff_name_snapshot,
    'status', report.status,
    'inventory_rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_code', row.product_code,
        'product_name', row.product_name_snapshot,
        'opening_quantity', row.opening_quantity,
        'received_quantity', row.received_quantity,
        'shortage_quantity', row.shortage_quantity,
        'transfer_quantity', row.transfer_quantity,
        'waste_quantity', row.waste_quantity,
        'returns_quantity', row.returns_quantity,
        'sold_quantity', row.sold_quantity,
        'consumed_quantity', row.consumed_quantity,
        'closing_quantity', row.closing_quantity,
        'opening_reconciliation_required', row.opening_reconciliation_required,
        'notes', row.notes,
        'consumption_is_manual', row.product_code = 'ot',
        'breadstick_consumption_ratio', coalesce(product.breadstick_consumption_ratio, 0)
      ) order by product.display_order, row.product_code)
      from public.kiosk_daily_report_inventory_rows row
      left join public.kiosk_report_products product on product.code = row.product_code
      where row.report_id = report.id
    ), '[]'::jsonb),
    'channel_rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel_code', row.channel_code,
        'channel_name', row.channel_name_snapshot,
        'quantity', row.quantity,
        'amount_vnd', coalesce(adjustment.corrected_amount_vnd, row.amount_vnd),
        'source_amount_vnd', row.amount_vnd,
        'notes', row.notes
      ) order by channel.display_order, row.channel_code)
      from public.kiosk_daily_report_channel_rows row
      left join public.kiosk_report_channels channel on channel.code = row.channel_code
      left join public.kiosk_point_revenue_adjustments adjustment
        on adjustment.report_id = row.report_id and adjustment.channel_code = row.channel_code
      where row.report_id = report.id
    ), '[]'::jsonb)
  ) into v_result
  from public.kiosk_daily_reports report
  where report.id = p_report_id and report.status = 'submitted';

  if v_result is null then raise exception 'kiosk_report_not_submitted' using errcode = 'P0002'; end if;
  return v_result;
end;
$$;

revoke all on function public.get_kiosk_point_report_detail(uuid) from public, anon, authenticated;
grant execute on function public.get_kiosk_point_report_detail(uuid) to authenticated;
