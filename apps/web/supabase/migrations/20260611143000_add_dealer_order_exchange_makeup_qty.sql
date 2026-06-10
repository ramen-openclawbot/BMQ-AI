alter table public.dealer_order_items
  add column if not exists ordered_quantity numeric,
  add column if not exists exchange_quantity numeric not null default 0,
  add column if not exists makeup_quantity numeric not null default 0,
  add column if not exists physical_quantity numeric;

update public.dealer_order_items
set ordered_quantity = coalesce(ordered_quantity, quantity),
    exchange_quantity = coalesce(exchange_quantity, 0),
    makeup_quantity = coalesce(makeup_quantity, 0),
    physical_quantity = coalesce(physical_quantity, quantity + coalesce(exchange_quantity, 0) + coalesce(makeup_quantity, 0))
where ordered_quantity is null
   or physical_quantity is null;
