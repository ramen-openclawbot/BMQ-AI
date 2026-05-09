-- Option 4 revenue/PO automation schedule.
-- Runs daily at 23:59 Asia/Ho_Chi_Minh so PO evidence is available for next-day revenue review.

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
) values (
  'default',
  null,
  true,
  'tier1_only',
  'daily',
  '23:59',
  'Asia/Ho_Chi_Minh',
  7,
  'revenue_option4_po_schedule_2359: daily PO evidence sync at 23:59 Asia/Ho_Chi_Minh; trusted revenue ledger remains accounting truth; KFM XLSX valid/PDF cancellation review, Thuy direct dealer manual path, Dam/XESG sent_qty vs sold_qty inventory-aware.',
  'system',
  'system',
  now(),
  now()
)
on conflict (config_key) do update
set
  is_enabled = true,
  scope_mode = 'tier1_only',
  schedule_mode = 'daily',
  run_hour_local = '23:59',
  timezone = 'Asia/Ho_Chi_Minh',
  lookback_days = greatest(public.po_sync_schedules.lookback_days, excluded.lookback_days),
  notes = excluded.notes,
  updated_by = 'system',
  updated_at = now();
