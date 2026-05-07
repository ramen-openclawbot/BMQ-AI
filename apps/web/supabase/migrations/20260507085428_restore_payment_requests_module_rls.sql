-- Restore Duyet chi dashboard/table access through module permissions while
-- keeping AI Agent payment search owner-only in the Edge Function.
--
-- Context:
-- - 20260507051754 hardened payment_requests/payment_request_items to owner-only.
-- - That correctly protected direct DB access, but it also caused non-owner users
--   with legitimate Duyet chi module permission to see zero dashboard/table rows.
-- - The AI Agent chat-box search remains protected separately by the
--   owner-only `payment-agent-search` Edge Function.

alter table public.payment_requests enable row level security;
alter table public.payment_request_items enable row level security;

-- Replace owner-only direct table policies with module-permission policies.
drop policy if exists "owner_select_payment_requests" on public.payment_requests;
drop policy if exists "owner_insert_payment_requests" on public.payment_requests;
drop policy if exists "owner_update_payment_requests" on public.payment_requests;
drop policy if exists "owner_delete_payment_requests" on public.payment_requests;
drop policy if exists "payment_requests_select_by_module_permission" on public.payment_requests;
drop policy if exists "payment_requests_insert_by_module_permission" on public.payment_requests;
drop policy if exists "payment_requests_update_by_module_permission" on public.payment_requests;
drop policy if exists "payment_requests_delete_by_module_permission" on public.payment_requests;

drop policy if exists "owner_select_payment_request_items" on public.payment_request_items;
drop policy if exists "owner_insert_payment_request_items" on public.payment_request_items;
drop policy if exists "owner_update_payment_request_items" on public.payment_request_items;
drop policy if exists "owner_delete_payment_request_items" on public.payment_request_items;
drop policy if exists "payment_request_items_select_by_module_permission" on public.payment_request_items;
drop policy if exists "payment_request_items_insert_by_module_permission" on public.payment_request_items;
drop policy if exists "payment_request_items_update_by_module_permission" on public.payment_request_items;
drop policy if exists "payment_request_items_delete_by_module_permission" on public.payment_request_items;

create policy "payment_requests_select_by_module_permission"
  on public.payment_requests
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
  );

create policy "payment_requests_insert_by_module_permission"
  on public.payment_requests
  for insert
  to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payment_requests_update_by_module_permission"
  on public.payment_requests
  for update
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payment_requests_delete_by_module_permission"
  on public.payment_requests
  for delete
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payment_request_items_select_by_module_permission"
  on public.payment_request_items
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
  );

create policy "payment_request_items_insert_by_module_permission"
  on public.payment_request_items
  for insert
  to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payment_request_items_update_by_module_permission"
  on public.payment_request_items
  for update
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );

create policy "payment_request_items_delete_by_module_permission"
  on public.payment_request_items
  for delete
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  );
