-- Add cup bags to the point-of-sale inventory report.
-- This is an inventory-only supply tracked by bag; it is not sold and has no automatic breadstick consumption ratio.

insert into public.kiosk_report_products (
  code,
  product_name,
  unit,
  display_order,
  active,
  sale_allowed,
  breadstick_consumption_ratio
)
values (
  'bao_ly',
  'Bao ly',
  'túi~0.5kg',
  5,
  true,
  false,
  0
)
on conflict (code) do update
set product_name = excluded.product_name,
    unit = excluded.unit,
    display_order = excluded.display_order,
    active = true,
    sale_allowed = false,
    breadstick_consumption_ratio = 0;
