drop trigger if exists prevent_submitted_kiosk_report_inventory_mutation on public.kiosk_daily_report_inventory_rows;
create trigger prevent_submitted_kiosk_report_inventory_mutation
before insert or update or delete on public.kiosk_daily_report_inventory_rows
for each row execute function public.prevent_submitted_kiosk_report_child_mutation();

drop trigger if exists prevent_submitted_kiosk_report_channel_mutation on public.kiosk_daily_report_channel_rows;
create trigger prevent_submitted_kiosk_report_channel_mutation
before insert or update or delete on public.kiosk_daily_report_channel_rows
for each row execute function public.prevent_submitted_kiosk_report_child_mutation();

alter table public.kiosk_report_locations enable row level security;
alter table public.kiosk_report_staff enable row level security;
alter table public.kiosk_report_products enable row level security;
alter table public.kiosk_report_channels enable row level security;
alter table public.kiosk_report_otp_challenges enable row level security;
alter table public.kiosk_report_auth_rate_limits enable row level security;
alter table public.kiosk_report_sessions enable row level security;
alter table public.kiosk_daily_reports enable row level security;
alter table public.kiosk_daily_report_inventory_rows enable row level security;
alter table public.kiosk_daily_report_channel_rows enable row level security;

-- No broad authenticated policies are added. Public and owner operations go through Edge Functions.

insert into public.kiosk_report_products (code, product_name, unit, display_order, active)
values
  ('banh_mi_que', 'Bánh mì que', 'que', 1, true),
  ('pate', 'Pate', 'hộp', 2, true),
  ('ot', 'Ớt', 'phần', 3, true),
  ('banh_mi_say', 'Bánh mì sấy', 'gói', 4, true)
on conflict (code) do update
set product_name = excluded.product_name,
    unit = excluded.unit,
    display_order = excluded.display_order,
    active = true,
    updated_at = now();

insert into public.kiosk_report_channels (code, channel_name, display_order, active)
values
  ('khach_le', 'Khách lẻ', 1, true),
  ('shopeefood', 'ShopeeFood', 2, true),
  ('grabfood', 'GrabFood', 3, true),
  ('befood', 'beFood', 4, true)
on conflict (code) do update
set channel_name = excluded.channel_name,
    display_order = excluded.display_order,
    active = true,
    updated_at = now();
