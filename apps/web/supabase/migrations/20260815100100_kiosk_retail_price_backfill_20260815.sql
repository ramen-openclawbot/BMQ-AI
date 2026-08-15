-- Correct reports already submitted on/after the approved retail price effective date.
-- The immutable source rows are changed only under the authorized-edit guard and every
-- corrected report receives a before/after audit row. Raw reports before 2026-08-15 remain unchanged.

create temporary table kiosk_retail_price_14000_backfill on commit preserve rows as
select
  report.id as report_id,
  jsonb_build_object(
    'report', to_jsonb(report),
    'inventory_rows', coalesce((
      select jsonb_agg(to_jsonb(inventory) order by inventory.product_code)
      from public.kiosk_daily_report_inventory_rows inventory
      where inventory.report_id = report.id
    ), '[]'::jsonb),
    'channel_rows', coalesce((
      select jsonb_agg(to_jsonb(channel_row) order by channel_row.channel_code)
      from public.kiosk_daily_report_channel_rows channel_row
      where channel_row.report_id = report.id
    ), '[]'::jsonb)
  ) as before_payload
from public.kiosk_daily_reports report
where report.status = 'submitted'
  and report.report_date >= date '2026-08-15'
  and exists (
    select 1
    from public.kiosk_daily_report_channel_rows source
    where source.report_id = report.id
      and source.channel_code = 'khach_le'
      and source.amount_vnd <> round(source.quantity * 14000)
  );

select set_config('app.kiosk_report_authorized_edit', 'on', true);

update public.kiosk_daily_report_channel_rows source
set amount_vnd = round(source.quantity * 14000)
where source.channel_code = 'khach_le'
  and source.report_id in (
    select target.report_id
    from kiosk_retail_price_14000_backfill target
  );

insert into public.kiosk_point_revenue_audit_logs (
  report_id,
  actor_id,
  action,
  before_payload,
  after_payload,
  note
)
select
  target.report_id,
  null,
  'edit_report',
  target.before_payload,
  jsonb_build_object(
    'report', to_jsonb(report),
    'inventory_rows', coalesce((
      select jsonb_agg(to_jsonb(inventory) order by inventory.product_code)
      from public.kiosk_daily_report_inventory_rows inventory
      where inventory.report_id = report.id
    ), '[]'::jsonb),
    'channel_rows', coalesce((
      select jsonb_agg(to_jsonb(channel_row) order by channel_row.channel_code)
      from public.kiosk_daily_report_channel_rows channel_row
      where channel_row.report_id = report.id
    ), '[]'::jsonb)
  ),
  'system_release:kiosk_retail_price_14000_effective_20260815'
from kiosk_retail_price_14000_backfill target
join public.kiosk_daily_reports report on report.id = target.report_id;

drop table kiosk_retail_price_14000_backfill;
