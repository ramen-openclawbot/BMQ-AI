-- One durable claim per vendor/PO, before ANY booking or trip write.
-- Unknown outcomes are deliberately not released/expired automatically.
create table public.kfm_trip_attempts (
  vendor_id bigint not null,
  order_id bigint not null,
  request_id uuid not null unique,
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  state text not null default 'sending' check (state in ('sending','unknown','verified')),
  body jsonb not null,
  baseline_asn_ids jsonb not null default '[]'::jsonb,
  load_id bigint,
  result jsonb,
  primary key (vendor_id, order_id)
);
alter table public.kfm_trip_attempts enable row level security;
revoke all on public.kfm_trip_attempts from anon, authenticated;
grant select, insert, update on public.kfm_trip_attempts to service_role;
comment on table public.kfm_trip_attempts is 'Operator KFM trip writes: durable dedupe and read-only recovery. No automatic retry or unlock.';
