-- Heo Đất Tết — public opening time. Real dealers see only an announcement banner until opens_at,
-- can join from opens_at (20:00 on 30/11/2026, Vietnam time) and heo counts from starts_on (01/12).
-- Additive and re-runnable.
alter table public.dealer_heo_campaigns
  add column if not exists opens_at timestamptz;

update public.dealer_heo_campaigns
set opens_at = timestamptz '2026-11-30 20:00:00+07',
    updated_at = now()
where code = 'heo-tet-2026'
  and opens_at is null;
