-- Tighten Supabase advisor WARN findings from 2026-06-02.
-- Keeps app-facing RPCs available to authenticated users while removing anon
-- access to SECURITY DEFINER functions and reducing broad public/list policies.

-- 1) Function search_path mutable -------------------------------------------
alter function public.touch_cost_classification_updated_at() set search_path = public;
alter function public.set_production_location_sku_settings_updated_at() set search_path = public;
alter function public.touch_revenue_ledger_updated_at() set search_path = public;
alter function public.set_kitchen_inventory_updated_at() set search_path = public;
alter function public.prevent_closed_kitchen_inventory_movement_changes() set search_path = public;
alter function public.prevent_closed_kitchen_inventory_closing_changes() set search_path = public;

-- 2) RLS INSERT policies should not use WITH CHECK (true) --------------------
drop policy if exists "audit_insert_mini_crm_agent_ui_audit_logs" on public.mini_crm_agent_ui_audit_logs;
create policy "audit_insert_mini_crm_agent_ui_audit_logs"
  on public.mini_crm_agent_ui_audit_logs
  for insert
  to authenticated
  with check ((select auth.uid()) is not null);

drop policy if exists "audit_insert_po_revenue_post_audit" on public.po_revenue_post_audit;
create policy "audit_insert_po_revenue_post_audit"
  on public.po_revenue_post_audit
  for insert
  to authenticated
  with check ((select auth.uid()) is not null);

-- 3) Public buckets: public URL access still works for public buckets without
-- a broad storage.objects SELECT policy; removing these prevents object listing.
drop policy if exists "Public read access to dealer portal assets" on storage.objects;
drop policy if exists "Public read access to SKU images" on storage.objects;
drop policy if exists "Public read access to warehouse photos" on storage.objects;

-- 4) SECURITY DEFINER functions: remove default PUBLIC/anon execute access.
-- Grant service_role for automation/Edge Functions and grant authenticated only
-- for RPCs or RBAC helper functions that the browser/RLS policies need.
revoke execute on function public.add_manual_revenue_ledger_line(jsonb,text) from public, anon, authenticated;
revoke execute on function public.apply_kitchen_inventory_import_batch(uuid) from public, anon, authenticated;
revoke execute on function public.approve_revenue_monthly_parse(uuid,boolean,uuid) from public, anon, authenticated;
revoke execute on function public.attendance_bulk_upsert_roster(jsonb) from public, anon, authenticated;
revoke execute on function public.attendance_copy_week_roster(date,date,text[]) from public, anon, authenticated;
revoke execute on function public.can_access_kitchen_inventory(boolean) from public, anon, authenticated;
revoke execute on function public.can_edit_po_dispatch_revenue_confirmation(uuid) from public, anon, authenticated;
revoke execute on function public.can_edit_production_q7() from public, anon, authenticated;
revoke execute on function public.can_manage_dealer_portal() from public, anon, authenticated;
revoke execute on function public.cleanup_expired_rate_limits() from public, anon, authenticated;
revoke execute on function public.close_kitchen_inventory_month(date) from public, anon, authenticated;
revoke execute on function public.confirm_po_dispatch_revenue(uuid,text) from public, anon, authenticated;
revoke execute on function public.create_production_material_issue(uuid,date) from public, anon, authenticated;
revoke execute on function public.edit_revenue_draft_daily_review(uuid,numeric,text,boolean) from public, anon, authenticated;
revoke execute on function public.edit_revenue_ledger_line(uuid,jsonb,text) from public, anon, authenticated;
revoke execute on function public.ensure_purchase_order_receipt_queue(uuid) from public, anon, authenticated;
revoke execute on function public.finalize_goods_receipt(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.generate_production_material_issue_number(date) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_paid_payment_request_cost_classification() from public, anon, authenticated;
revoke execute on function public.has_module_permission(uuid,text,text) from public, anon, authenticated;
revoke execute on function public.has_role(uuid,public.app_role) from public, anon, authenticated;
revoke execute on function public.increment_supplier_template_hit(text) from public, anon, authenticated;
revoke execute on function public.next_payment_number() from public, anon, authenticated;
revoke execute on function public.payroll_calculate_run(uuid) from public, anon, authenticated;
revoke execute on function public.payroll_resolve_wage_profile(text,date) from public, anon, authenticated;
revoke execute on function public.record_payment_allocations(jsonb,public.payment_method_type,date,text,text) from public, anon, authenticated;
revoke execute on function public.reject_revenue_monthly_parse(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.revise_po_dispatch_revenue(uuid,jsonb,text) from public, anon, authenticated;
revoke execute on function public.set_payment_request_paid_at() from public, anon, authenticated;
revoke execute on function public.sync_payment_allocation_parent_status() from public, anon, authenticated;
revoke execute on function public.sync_payment_request_payment_status(uuid) from public, anon, authenticated;
revoke execute on function public.update_batch_expiry_once(uuid,date) from public, anon, authenticated;
revoke execute on function public.upsert_po_dispatch_revenue_confirmation(uuid,uuid,jsonb,text) from public, anon, authenticated;

-- Service role keeps all SECURITY DEFINER routines for automation/Edge Functions.
grant execute on function public.add_manual_revenue_ledger_line(jsonb,text) to service_role;
grant execute on function public.apply_kitchen_inventory_import_batch(uuid) to service_role;
grant execute on function public.approve_revenue_monthly_parse(uuid,boolean,uuid) to service_role;
grant execute on function public.attendance_bulk_upsert_roster(jsonb) to service_role;
grant execute on function public.attendance_copy_week_roster(date,date,text[]) to service_role;
grant execute on function public.can_access_kitchen_inventory(boolean) to service_role;
grant execute on function public.can_edit_po_dispatch_revenue_confirmation(uuid) to service_role;
grant execute on function public.can_edit_production_q7() to service_role;
grant execute on function public.can_manage_dealer_portal() to service_role;
grant execute on function public.cleanup_expired_rate_limits() to service_role;
grant execute on function public.close_kitchen_inventory_month(date) to service_role;
grant execute on function public.confirm_po_dispatch_revenue(uuid,text) to service_role;
grant execute on function public.create_production_material_issue(uuid,date) to service_role;
grant execute on function public.edit_revenue_draft_daily_review(uuid,numeric,text,boolean) to service_role;
grant execute on function public.edit_revenue_ledger_line(uuid,jsonb,text) to service_role;
grant execute on function public.ensure_purchase_order_receipt_queue(uuid) to service_role;
grant execute on function public.finalize_goods_receipt(uuid,uuid) to service_role;
grant execute on function public.generate_production_material_issue_number(date) to service_role;
grant execute on function public.handle_new_user() to service_role;
grant execute on function public.handle_paid_payment_request_cost_classification() to service_role;
grant execute on function public.has_module_permission(uuid,text,text) to service_role;
grant execute on function public.has_role(uuid,public.app_role) to service_role;
grant execute on function public.increment_supplier_template_hit(text) to service_role;
grant execute on function public.next_payment_number() to service_role;
grant execute on function public.payroll_calculate_run(uuid) to service_role;
grant execute on function public.payroll_resolve_wage_profile(text,date) to service_role;
grant execute on function public.record_payment_allocations(jsonb,public.payment_method_type,date,text,text) to service_role;
grant execute on function public.reject_revenue_monthly_parse(uuid,uuid) to service_role;
grant execute on function public.revise_po_dispatch_revenue(uuid,jsonb,text) to service_role;
grant execute on function public.set_payment_request_paid_at() to service_role;
grant execute on function public.sync_payment_allocation_parent_status() to service_role;
grant execute on function public.sync_payment_request_payment_status(uuid) to service_role;
grant execute on function public.update_batch_expiry_once(uuid,date) to service_role;
grant execute on function public.upsert_po_dispatch_revenue_confirmation(uuid,uuid,jsonb,text) to service_role;

-- Authenticated browser/RLS-facing routines that remain intentionally callable.
grant execute on function public.add_manual_revenue_ledger_line(jsonb,text) to authenticated;
grant execute on function public.attendance_bulk_upsert_roster(jsonb) to authenticated;
grant execute on function public.attendance_copy_week_roster(date,date,text[]) to authenticated;
grant execute on function public.can_access_kitchen_inventory(boolean) to authenticated;
grant execute on function public.can_edit_po_dispatch_revenue_confirmation(uuid) to authenticated;
grant execute on function public.can_edit_production_q7() to authenticated;
grant execute on function public.can_manage_dealer_portal() to authenticated;
grant execute on function public.close_kitchen_inventory_month(date) to authenticated;
grant execute on function public.confirm_po_dispatch_revenue(uuid,text) to authenticated;
grant execute on function public.edit_revenue_draft_daily_review(uuid,numeric,text,boolean) to authenticated;
grant execute on function public.edit_revenue_ledger_line(uuid,jsonb,text) to authenticated;
grant execute on function public.ensure_purchase_order_receipt_queue(uuid) to authenticated;
grant execute on function public.has_module_permission(uuid,text,text) to authenticated;
grant execute on function public.has_role(uuid,public.app_role) to authenticated;
grant execute on function public.payroll_calculate_run(uuid) to authenticated;
grant execute on function public.payroll_resolve_wage_profile(text,date) to authenticated;
grant execute on function public.record_payment_allocations(jsonb,public.payment_method_type,date,text,text) to authenticated;
grant execute on function public.update_batch_expiry_once(uuid,date) to authenticated;
grant execute on function public.upsert_po_dispatch_revenue_confirmation(uuid,uuid,jsonb,text) to authenticated;
