-- Harden payment request finance data: owner-only direct table access.
--
-- Context:
-- - AI Agent payment search now uses owner-gated Edge Function `payment-agent-search`.
-- - Previous RLS still allowed any authenticated user to SELECT payment_requests
--   and payment_request_items directly, which allowed bypassing the AI Agent UI/function.
--
-- Scope intentionally limited to payment request data tables. Suppliers remain
-- shared operational master data and are not restricted here.

alter table public.payment_requests enable row level security;
alter table public.payment_request_items enable row level security;

-- Remove broad authenticated read policies and broad FOR ALL write policies.
-- The FOR ALL policies also apply to SELECT, so they must be replaced by
-- command-specific owner-only policies.
drop policy if exists "Authenticated users can select payment_requests" on public.payment_requests;
drop policy if exists "payment_requests_select" on public.payment_requests;
drop policy if exists "finance_write_payment_requests" on public.payment_requests;
drop policy if exists "finance_insert_payment_requests" on public.payment_requests;
drop policy if exists "finance_update_payment_requests" on public.payment_requests;
drop policy if exists "finance_delete_payment_requests" on public.payment_requests;
drop policy if exists "owner_select_payment_requests" on public.payment_requests;
drop policy if exists "owner_insert_payment_requests" on public.payment_requests;
drop policy if exists "owner_update_payment_requests" on public.payment_requests;
drop policy if exists "owner_delete_payment_requests" on public.payment_requests;

drop policy if exists "Authenticated users can select payment_request_items" on public.payment_request_items;
drop policy if exists "payment_request_items_select" on public.payment_request_items;
drop policy if exists "finance_write_payment_request_items" on public.payment_request_items;
drop policy if exists "finance_insert_payment_request_items" on public.payment_request_items;
drop policy if exists "finance_update_payment_request_items" on public.payment_request_items;
drop policy if exists "finance_delete_payment_request_items" on public.payment_request_items;
drop policy if exists "owner_select_payment_request_items" on public.payment_request_items;
drop policy if exists "owner_insert_payment_request_items" on public.payment_request_items;
drop policy if exists "owner_update_payment_request_items" on public.payment_request_items;
drop policy if exists "owner_delete_payment_request_items" on public.payment_request_items;

create policy "owner_select_payment_requests"
  on public.payment_requests
  for select
  to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

create policy "owner_insert_payment_requests"
  on public.payment_requests
  for insert
  to authenticated
  with check (public.has_role((select auth.uid()), 'owner'));

create policy "owner_update_payment_requests"
  on public.payment_requests
  for update
  to authenticated
  using (public.has_role((select auth.uid()), 'owner'))
  with check (public.has_role((select auth.uid()), 'owner'));

create policy "owner_delete_payment_requests"
  on public.payment_requests
  for delete
  to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

create policy "owner_select_payment_request_items"
  on public.payment_request_items
  for select
  to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

create policy "owner_insert_payment_request_items"
  on public.payment_request_items
  for insert
  to authenticated
  with check (public.has_role((select auth.uid()), 'owner'));

create policy "owner_update_payment_request_items"
  on public.payment_request_items
  for update
  to authenticated
  using (public.has_role((select auth.uid()), 'owner'))
  with check (public.has_role((select auth.uid()), 'owner'));

create policy "owner_delete_payment_request_items"
  on public.payment_request_items
  for delete
  to authenticated
  using (public.has_role((select auth.uid()), 'owner'));
