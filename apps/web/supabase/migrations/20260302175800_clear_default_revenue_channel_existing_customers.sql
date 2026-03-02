-- Clear legacy default_revenue_channel values for existing CRM customers
update public.mini_crm_customers
set default_revenue_channel = null
where default_revenue_channel is not null;
