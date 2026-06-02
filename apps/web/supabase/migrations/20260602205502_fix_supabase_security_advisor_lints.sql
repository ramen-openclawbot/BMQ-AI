-- Fix Supabase Security Advisor findings from 2026-06-02.
-- 1) Views: make Postgres views security_invoker so RLS/permissions are evaluated
--    as the querying user instead of the view owner.
-- 2) Public tables: enable RLS and add authenticated/module-scoped policies.
--    Service-role Edge Functions continue to bypass RLS for scheduled automation.

-- Security definer view lints -------------------------------------------------
alter view public.v_shift_worker_cost set (security_invoker = true);
alter view public.v_sku_labor_cost_actual set (security_invoker = true);
alter view public.v_sku_labor_cost_monthly set (security_invoker = true);
alter view public.v_sku_labor_cost_monthly_enriched set (security_invoker = true);
alter view public.v_payroll_period_summary set (security_invoker = true);
alter view public.v_shift_total_labor_cost set (security_invoker = true);
alter view public.v_labor_cost_by_sku set (security_invoker = true);
alter view public.v_payroll_journal_draft set (security_invoker = true);

-- RLS disabled in public lints ------------------------------------------------
alter table public.po_sync_jobs enable row level security;
alter table public.po_parse_runs enable row level security;
alter table public.po_sync_schedules enable row level security;
alter table public.sales_po_documents enable row level security;
alter table public.po_sync_runtime_locks enable row level security;
alter table public.po_sync_snapshots enable row level security;
alter table public.revenue_drafts enable row level security;

-- Revenue draft review is finance-revenue scoped.
drop policy if exists "finance_revenue_select_revenue_drafts" on public.revenue_drafts;
create policy "finance_revenue_select_revenue_drafts"
  on public.revenue_drafts for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'view')
  );

drop policy if exists "finance_revenue_insert_revenue_drafts" on public.revenue_drafts;
create policy "finance_revenue_insert_revenue_drafts"
  on public.revenue_drafts for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'edit')
  );

drop policy if exists "finance_revenue_update_revenue_drafts" on public.revenue_drafts;
create policy "finance_revenue_update_revenue_drafts"
  on public.revenue_drafts for update to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'edit')
  );

drop policy if exists "finance_revenue_delete_revenue_drafts" on public.revenue_drafts;
create policy "finance_revenue_delete_revenue_drafts"
  on public.revenue_drafts for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'edit')
  );

-- Sales PO automation tables are visible to finance revenue and sales PO inbox
-- users. Writes are limited to edit permission; scheduled Edge Functions use
-- service_role and bypass RLS.
do $$
declare
  tbl_name text;
begin
  foreach tbl_name in array array[
    'po_sync_jobs',
    'po_parse_runs',
    'po_sync_schedules',
    'sales_po_documents',
    'po_sync_snapshots'
  ] loop
    execute format('drop policy if exists %I on public.%I', 'sales_po_automation_select_' || tbl_name, tbl_name);
    execute format($sql$
      create policy %I on public.%I for select to authenticated
      using (
        public.has_role((select auth.uid()), 'owner')
        or public.has_module_permission((select auth.uid()), 'finance_revenue', 'view')
        or public.has_module_permission((select auth.uid()), 'sales_po_inbox', 'view')
      )
    $sql$, 'sales_po_automation_select_' || tbl_name, tbl_name);

    execute format('drop policy if exists %I on public.%I', 'sales_po_automation_insert_' || tbl_name, tbl_name);
    execute format($sql$
      create policy %I on public.%I for insert to authenticated
      with check (
        public.has_role((select auth.uid()), 'owner')
        or public.has_module_permission((select auth.uid()), 'finance_revenue', 'edit')
        or public.has_module_permission((select auth.uid()), 'sales_po_inbox', 'edit')
      )
    $sql$, 'sales_po_automation_insert_' || tbl_name, tbl_name);

    execute format('drop policy if exists %I on public.%I', 'sales_po_automation_update_' || tbl_name, tbl_name);
    execute format($sql$
      create policy %I on public.%I for update to authenticated
      using (
        public.has_role((select auth.uid()), 'owner')
        or public.has_module_permission((select auth.uid()), 'finance_revenue', 'edit')
        or public.has_module_permission((select auth.uid()), 'sales_po_inbox', 'edit')
      )
      with check (
        public.has_role((select auth.uid()), 'owner')
        or public.has_module_permission((select auth.uid()), 'finance_revenue', 'edit')
        or public.has_module_permission((select auth.uid()), 'sales_po_inbox', 'edit')
      )
    $sql$, 'sales_po_automation_update_' || tbl_name, tbl_name);

    execute format('drop policy if exists %I on public.%I', 'sales_po_automation_delete_' || tbl_name, tbl_name);
    execute format($sql$
      create policy %I on public.%I for delete to authenticated
      using (
        public.has_role((select auth.uid()), 'owner')
        or public.has_module_permission((select auth.uid()), 'finance_revenue', 'edit')
        or public.has_module_permission((select auth.uid()), 'sales_po_inbox', 'edit')
      )
    $sql$, 'sales_po_automation_delete_' || tbl_name, tbl_name);
  end loop;
end $$;

-- Runtime locks should only be visible/writable to service_role automation.
-- Enabling RLS with no authenticated/anon policy prevents browser access while
-- service_role continues to bypass RLS.
drop policy if exists "deny_browser_po_sync_runtime_locks" on public.po_sync_runtime_locks;
create policy "deny_browser_po_sync_runtime_locks"
  on public.po_sync_runtime_locks for all to authenticated
  using (false)
  with check (false);
