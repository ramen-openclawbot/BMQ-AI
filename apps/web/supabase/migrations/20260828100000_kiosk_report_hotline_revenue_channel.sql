-- Add Hotline as a global kiosk revenue channel.
-- Each point records only the Hotline orders it physically fulfils; amount_vnd is actual received after discount.

insert into public.kiosk_report_channels (
  code,
  channel_name,
  display_order,
  active
) values (
  'hotline',
  'Hotline',
  5,
  true
)
on conflict (code) do update
set channel_name = excluded.channel_name,
    display_order = excluded.display_order,
    active = excluded.active,
    updated_at = now();
