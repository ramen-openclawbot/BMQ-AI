-- Keep the persisted source aligned with dealer-catalog and dealer-order-submit.
-- The fallback price has come from product_skus.cost_values.selling_price since
-- 2026-05-21; customer-specific overrides retain their existing source label.

alter table public.dealer_order_items
  drop constraint if exists dealer_order_items_price_source_check;

alter table public.dealer_order_items
  add constraint dealer_order_items_price_source_check
  check (price_source in ('sku_unit_price', 'cost_values_selling_price', 'customer_override'));
