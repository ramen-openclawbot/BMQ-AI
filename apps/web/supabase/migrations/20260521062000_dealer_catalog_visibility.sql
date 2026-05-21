-- Dealer portal catalog visibility for finished SKU catalog

alter table public.product_skus
  add column if not exists hide_from_dealer_portal boolean not null default false;

create index if not exists idx_product_skus_dealer_portal_visible
  on public.product_skus (sku_code asc)
  where hide_from_dealer_portal = false;
