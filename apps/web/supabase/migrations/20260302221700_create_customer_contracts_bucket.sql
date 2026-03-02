insert into storage.buckets (id, name, public)
values ('customer-contracts', 'customer-contracts', true)
on conflict (id) do nothing;