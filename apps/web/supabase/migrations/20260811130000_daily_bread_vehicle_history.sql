-- Return exactly the latest seven submitted bread inventory rows per active
-- non-test kiosk location. This avoids a global Edge query limit starving
-- older/newer locations as the fleet grows.

create or replace function public.get_daily_bread_vehicle_history(
  p_cutoff_date date
)
returns table (
  location_id uuid,
  location_code text,
  report_date date,
  sold_quantity numeric,
  closing_quantity numeric
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with active_locations as (
    select location.id, location.location_code
    from public.kiosk_report_locations location
    where location.active = true
      and upper(coalesce(location.location_code, '')) not like 'TEST%'
  ),
  ranked_reports as (
    select
      report.location_id,
      report.report_date,
      inventory.sold_quantity,
      inventory.closing_quantity,
      row_number() over (
        partition by report.location_id
        order by report.report_date desc, report.submitted_at desc nulls last, report.id desc
      ) as report_rank
    from public.kiosk_daily_reports report
    join active_locations location on location.id = report.location_id
    join public.kiosk_daily_report_inventory_rows inventory
      on inventory.report_id = report.id
     and inventory.product_code = 'banh_mi_que'
    where report.status = 'submitted'
      and report.report_date <= p_cutoff_date
  )
  select
    location.id,
    location.location_code,
    report.report_date,
    report.sold_quantity,
    report.closing_quantity
  from active_locations location
  left join ranked_reports report
    on report.location_id = location.id
   and report.report_rank <= 7
  order by location.location_code asc, report.report_date desc nulls last;
end;
$$;

revoke all on function public.get_daily_bread_vehicle_history(date)
  from public, anon, authenticated;
grant execute on function public.get_daily_bread_vehicle_history(date)
  to service_role;
