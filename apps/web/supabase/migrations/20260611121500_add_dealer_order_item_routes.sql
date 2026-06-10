-- Support NPP dealer orders that split one submitted order into multiple route/customer lines.

alter table public.dealer_order_items
  add column if not exists route_customer_id uuid references public.mini_crm_customers(id) on delete restrict,
  add column if not exists route_customer_name text,
  add column if not exists route_note text;

create index if not exists dealer_order_items_route_customer_idx
  on public.dealer_order_items(route_customer_id);

comment on column public.dealer_order_items.route_customer_id is
  'Optional downstream/customer route for NPP dealer portal orders. When set, revenue parse posts the line to this customer and keeps dealer_orders.customer_id as parent NPP.';
comment on column public.dealer_order_items.route_customer_name is
  'Snapshot of downstream/customer route name at order submit time.';
comment on column public.dealer_order_items.route_note is
  'Line-level delivery note for this downstream/customer route.';
