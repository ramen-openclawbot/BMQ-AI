-- Remove duplicated field: default_revenue_channel (replaced by customer_group mapping)
alter table if exists public.mini_crm_customers
  drop column if exists default_revenue_channel;
