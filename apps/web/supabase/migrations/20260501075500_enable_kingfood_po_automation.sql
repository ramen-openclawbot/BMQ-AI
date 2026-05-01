-- kingfood_po_automation
-- Enable the default PO automation scope for Kingfoodmart. The Gmail sync rule is
-- sender-scoped in po-gmail-sync: from dathang@kingfoodmart.com, with
-- Export-PO-Data.xlsx auto-parse and PDF-only/cancel emails routed to review.

with kingfood as (
  select id
  from public.mini_crm_customers
  where customer_code = 'b2b-kfm'
     or lower(customer_name) = 'kingfoodmart'
  order by customer_code = 'b2b-kfm' desc, created_at desc
  limit 1
)
insert into public.po_sync_schedules (
  config_key,
  customer_id,
  is_enabled,
  scope_mode,
  schedule_mode,
  run_hour_local,
  timezone,
  lookback_days,
  notes,
  created_by,
  updated_by,
  created_at,
  updated_at
)
select
  'default',
  id,
  true,
  'single_customer',
  'daily',
  '06:00',
  'Asia/Ho_Chi_Minh',
  7,
  'kingfood_po_automation: sender filter dathang@kingfoodmart.com; auto-parse Export-PO-Data.xlsx; cancel/PDF-only goes to review; trusted revenue ledger remains source of truth.',
  'system',
  'system',
  now(),
  now()
from kingfood
on conflict (config_key) do update set
  customer_id = excluded.customer_id,
  is_enabled = true,
  scope_mode = 'single_customer',
  schedule_mode = 'daily',
  run_hour_local = '06:00',
  timezone = 'Asia/Ho_Chi_Minh',
  lookback_days = 7,
  notes = excluded.notes,
  updated_by = 'system',
  updated_at = now();
