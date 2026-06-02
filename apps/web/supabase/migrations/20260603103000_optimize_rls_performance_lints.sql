-- Optimize Supabase performance lints for RLS policies.
-- - Wrap auth.uid() in scalar subqueries so it is evaluated once per statement.
-- - Replace overlapping SELECT/ALL policies with one policy per command to avoid multiple permissive policies.
-- Generated from live pg_policies for the Advisor CSV uploaded on 2026-06-03.

-- public.app_settings
drop policy if exists "Authenticated users can select app_settings" on public."app_settings";
drop policy if exists "owner_write_app_settings" on public."app_settings";
create policy "p_app_settings_select_access" on public."app_settings" as permissive for select to authenticated using (true);
create policy "p_app_settings_insert_access" on public."app_settings" as permissive for insert to authenticated with check (has_role((select auth.uid()), 'owner'::app_role));
create policy "p_app_settings_update_access" on public."app_settings" as permissive for update to authenticated using (has_role((select auth.uid()), 'owner'::app_role)) with check (has_role((select auth.uid()), 'owner'::app_role));
create policy "p_app_settings_delete_access" on public."app_settings" as permissive for delete to authenticated using (has_role((select auth.uid()), 'owner'::app_role));

-- public.attendance_adjustments
drop policy if exists "attendance_edit_access_adjustments" on public."attendance_adjustments";
drop policy if exists "attendance_view_access_adjustments" on public."attendance_adjustments";
drop policy if exists "owner_full_access_attendance_adjustments" on public."attendance_adjustments";
create policy "p_attendance_adjustments_select_access" on public."attendance_adjustments" as permissive for select to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'attendance'::text, 'view'::text))) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_adjustments_insert_access" on public."attendance_adjustments" as permissive for insert to authenticated with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_adjustments_update_access" on public."attendance_adjustments" as permissive for update to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role)))) with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_adjustments_delete_access" on public."attendance_adjustments" as permissive for delete to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));

-- public.attendance_events
drop policy if exists "attendance_edit_access_events" on public."attendance_events";
drop policy if exists "attendance_view_access_events" on public."attendance_events";
drop policy if exists "owner_full_access_attendance_events" on public."attendance_events";
create policy "p_attendance_events_select_access" on public."attendance_events" as permissive for select to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'attendance'::text, 'view'::text))) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_events_insert_access" on public."attendance_events" as permissive for insert to authenticated with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_events_update_access" on public."attendance_events" as permissive for update to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role)))) with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_events_delete_access" on public."attendance_events" as permissive for delete to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));

-- public.attendance_periods
drop policy if exists "attendance_edit_access_periods" on public."attendance_periods";
drop policy if exists "attendance_view_access_periods" on public."attendance_periods";
drop policy if exists "owner_full_access_attendance_periods" on public."attendance_periods";
create policy "p_attendance_periods_select_access" on public."attendance_periods" as permissive for select to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'attendance'::text, 'view'::text))) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_periods_insert_access" on public."attendance_periods" as permissive for insert to authenticated with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_periods_update_access" on public."attendance_periods" as permissive for update to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role)))) with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_periods_delete_access" on public."attendance_periods" as permissive for delete to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));

-- public.attendance_qr_checkpoints
drop policy if exists "attendance_edit_access_qr_checkpoints" on public."attendance_qr_checkpoints";
drop policy if exists "attendance_view_access_qr_checkpoints" on public."attendance_qr_checkpoints";
drop policy if exists "owner_full_access_attendance_qr_checkpoints" on public."attendance_qr_checkpoints";
create policy "p_attendance_qr_checkpoints_select_access" on public."attendance_qr_checkpoints" as permissive for select to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'attendance'::text, 'view'::text))) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_qr_checkpoints_insert_access" on public."attendance_qr_checkpoints" as permissive for insert to authenticated with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_qr_checkpoints_update_access" on public."attendance_qr_checkpoints" as permissive for update to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role)))) with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_qr_checkpoints_delete_access" on public."attendance_qr_checkpoints" as permissive for delete to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));

-- public.attendance_records
drop policy if exists "attendance_edit_access_records" on public."attendance_records";
drop policy if exists "attendance_view_access_records" on public."attendance_records";
drop policy if exists "owner_full_access_attendance_records" on public."attendance_records";
create policy "p_attendance_records_select_access" on public."attendance_records" as permissive for select to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'attendance'::text, 'view'::text))) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_records_insert_access" on public."attendance_records" as permissive for insert to authenticated with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_records_update_access" on public."attendance_records" as permissive for update to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role)))) with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_records_delete_access" on public."attendance_records" as permissive for delete to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));

-- public.attendance_shift_assignments
drop policy if exists "attendance_edit_access_shift_assignments" on public."attendance_shift_assignments";
drop policy if exists "attendance_view_access_shift_assignments" on public."attendance_shift_assignments";
drop policy if exists "owner_full_access_attendance_shift_assignments" on public."attendance_shift_assignments";
create policy "p_attendance_shift_assignments_select_access" on public."attendance_shift_assignments" as permissive for select to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'attendance'::text, 'view'::text))) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_shift_assignments_insert_access" on public."attendance_shift_assignments" as permissive for insert to authenticated with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_shift_assignments_update_access" on public."attendance_shift_assignments" as permissive for update to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role)))) with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_shift_assignments_delete_access" on public."attendance_shift_assignments" as permissive for delete to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));

-- public.attendance_shifts
drop policy if exists "attendance_edit_access_shifts" on public."attendance_shifts";
drop policy if exists "attendance_view_access_shifts" on public."attendance_shifts";
drop policy if exists "owner_full_access_attendance_shifts" on public."attendance_shifts";
create policy "p_attendance_shifts_select_access" on public."attendance_shifts" as permissive for select to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'attendance'::text, 'view'::text))) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_shifts_insert_access" on public."attendance_shifts" as permissive for insert to authenticated with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_shifts_update_access" on public."attendance_shifts" as permissive for update to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role)))) with check (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));
create policy "p_attendance_shifts_delete_access" on public."attendance_shifts" as permissive for delete to authenticated using (((has_module_permission((select auth.uid()), 'attendance'::text, 'edit'::text)) OR (has_role((select auth.uid()), 'owner'::app_role))));

-- public.cost_categories
drop policy if exists "finance_cost_edit_cost_categories" on public."cost_categories";
drop policy if exists "finance_cost_select_cost_categories" on public."cost_categories";
create policy "p_cost_categories_select_access" on public."cost_categories" as permissive for select to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'view'::text)))));
create policy "p_cost_categories_insert_access" on public."cost_categories" as permissive for insert to authenticated with check (has_role((select auth.uid()), 'owner'::app_role));
create policy "p_cost_categories_update_access" on public."cost_categories" as permissive for update to authenticated using (has_role((select auth.uid()), 'owner'::app_role)) with check (has_role((select auth.uid()), 'owner'::app_role));
create policy "p_cost_categories_delete_access" on public."cost_categories" as permissive for delete to authenticated using (has_role((select auth.uid()), 'owner'::app_role));

-- public.cost_classification_rules
drop policy if exists "finance_cost_edit_cost_classification_rules" on public."cost_classification_rules";
drop policy if exists "finance_cost_select_cost_classification_rules" on public."cost_classification_rules";
create policy "p_cost_classification_rules_select_access" on public."cost_classification_rules" as permissive for select to authenticated using ((((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text))) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'view'::text)))));
create policy "p_cost_classification_rules_insert_access" on public."cost_classification_rules" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text)));
create policy "p_cost_classification_rules_update_access" on public."cost_classification_rules" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text)));
create policy "p_cost_classification_rules_delete_access" on public."cost_classification_rules" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text)));

-- public.cost_item_alias_mappings
drop policy if exists "finance_cost_edit_cost_item_alias_mappings" on public."cost_item_alias_mappings";
drop policy if exists "finance_cost_select_cost_item_alias_mappings" on public."cost_item_alias_mappings";
create policy "p_cost_item_alias_mappings_select_access" on public."cost_item_alias_mappings" as permissive for select to authenticated using ((((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text))) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'view'::text)))));
create policy "p_cost_item_alias_mappings_insert_access" on public."cost_item_alias_mappings" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text)));
create policy "p_cost_item_alias_mappings_update_access" on public."cost_item_alias_mappings" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text)));
create policy "p_cost_item_alias_mappings_delete_access" on public."cost_item_alias_mappings" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text)));

-- public.cost_line_classifications
drop policy if exists "finance_cost_edit_cost_line_classifications" on public."cost_line_classifications";
drop policy if exists "finance_cost_select_cost_line_classifications" on public."cost_line_classifications";
create policy "p_cost_line_classifications_select_access" on public."cost_line_classifications" as permissive for select to authenticated using ((((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text))) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'view'::text)))));
create policy "p_cost_line_classifications_insert_access" on public."cost_line_classifications" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text)));
create policy "p_cost_line_classifications_update_access" on public."cost_line_classifications" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text)));
create policy "p_cost_line_classifications_delete_access" on public."cost_line_classifications" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'finance_cost'::text, 'edit'::text)));

-- public.dealer_announcements
drop policy if exists "dealer_announcements_ops_read" on public."dealer_announcements";
drop policy if exists "dealer_announcements_ops_write" on public."dealer_announcements";
create policy "p_dealer_announcements_select_access" on public."dealer_announcements" as permissive for select to authenticated using (true);
create policy "p_dealer_announcements_insert_access" on public."dealer_announcements" as permissive for insert to authenticated with check (can_manage_dealer_portal());
create policy "p_dealer_announcements_update_access" on public."dealer_announcements" as permissive for update to authenticated using (can_manage_dealer_portal()) with check (can_manage_dealer_portal());
create policy "p_dealer_announcements_delete_access" on public."dealer_announcements" as permissive for delete to authenticated using (can_manage_dealer_portal());

-- public.dealer_customer_contacts
drop policy if exists "dealer_customer_contacts_ops_read" on public."dealer_customer_contacts";
drop policy if exists "dealer_customer_contacts_ops_write" on public."dealer_customer_contacts";
create policy "p_dealer_customer_contacts_select_access" on public."dealer_customer_contacts" as permissive for select to authenticated using (true);
create policy "p_dealer_customer_contacts_insert_access" on public."dealer_customer_contacts" as permissive for insert to authenticated with check (can_manage_dealer_portal());
create policy "p_dealer_customer_contacts_update_access" on public."dealer_customer_contacts" as permissive for update to authenticated using (can_manage_dealer_portal()) with check (can_manage_dealer_portal());
create policy "p_dealer_customer_contacts_delete_access" on public."dealer_customer_contacts" as permissive for delete to authenticated using (can_manage_dealer_portal());

-- public.dealer_order_items
drop policy if exists "dealer_order_items_ops_read" on public."dealer_order_items";
drop policy if exists "dealer_order_items_ops_write" on public."dealer_order_items";
create policy "p_dealer_order_items_select_access" on public."dealer_order_items" as permissive for select to authenticated using (true);
create policy "p_dealer_order_items_insert_access" on public."dealer_order_items" as permissive for insert to authenticated with check (can_manage_dealer_portal());
create policy "p_dealer_order_items_update_access" on public."dealer_order_items" as permissive for update to authenticated using (can_manage_dealer_portal()) with check (can_manage_dealer_portal());
create policy "p_dealer_order_items_delete_access" on public."dealer_order_items" as permissive for delete to authenticated using (can_manage_dealer_portal());

-- public.dealer_orders
drop policy if exists "dealer_orders_ops_read" on public."dealer_orders";
drop policy if exists "dealer_orders_ops_write" on public."dealer_orders";
create policy "p_dealer_orders_select_access" on public."dealer_orders" as permissive for select to authenticated using (true);
create policy "p_dealer_orders_insert_access" on public."dealer_orders" as permissive for insert to authenticated with check (can_manage_dealer_portal());
create policy "p_dealer_orders_update_access" on public."dealer_orders" as permissive for update to authenticated using (can_manage_dealer_portal()) with check (can_manage_dealer_portal());
create policy "p_dealer_orders_delete_access" on public."dealer_orders" as permissive for delete to authenticated using (can_manage_dealer_portal());

-- public.drive_file_index
drop policy if exists "Authenticated users can select drive_file_index" on public."drive_file_index";
drop policy if exists "config_write_drive_file_index" on public."drive_file_index";
create policy "p_drive_file_index_select_access" on public."drive_file_index" as permissive for select to authenticated using (true);
create policy "p_drive_file_index_insert_access" on public."drive_file_index" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_drive_file_index_update_access" on public."drive_file_index" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_drive_file_index_delete_access" on public."drive_file_index" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));

-- public.drive_import_logs
drop policy if exists "Authenticated users can select drive_import_logs" on public."drive_import_logs";
drop policy if exists "config_write_drive_import_logs" on public."drive_import_logs";
create policy "p_drive_import_logs_select_access" on public."drive_import_logs" as permissive for select to authenticated using (true);
create policy "p_drive_import_logs_insert_access" on public."drive_import_logs" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_drive_import_logs_update_access" on public."drive_import_logs" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_drive_import_logs_delete_access" on public."drive_import_logs" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));

-- public.drive_sync_config
drop policy if exists "Authenticated users can select drive_sync_config" on public."drive_sync_config";
drop policy if exists "config_write_drive_sync_config" on public."drive_sync_config";
create policy "p_drive_sync_config_select_access" on public."drive_sync_config" as permissive for select to authenticated using (true);
create policy "p_drive_sync_config_insert_access" on public."drive_sync_config" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_drive_sync_config_update_access" on public."drive_sync_config" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_drive_sync_config_delete_access" on public."drive_sync_config" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));

-- public.employee_wage_profiles
drop policy if exists "owner_full_access_employee_wage_profiles" on public."employee_wage_profiles";
drop policy if exists "payroll_edit_employee_wage_profiles" on public."employee_wage_profiles";
drop policy if exists "payroll_view_employee_wage_profiles" on public."employee_wage_profiles";
create policy "p_employee_wage_profiles_select_access" on public."employee_wage_profiles" as permissive for select to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'payroll'::text, 'view'::text)))));
create policy "p_employee_wage_profiles_insert_access" on public."employee_wage_profiles" as permissive for insert to authenticated with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));
create policy "p_employee_wage_profiles_update_access" on public."employee_wage_profiles" as permissive for update to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text)))) with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));
create policy "p_employee_wage_profiles_delete_access" on public."employee_wage_profiles" as permissive for delete to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));

-- public.goods_receipt_items
drop policy if exists "Authenticated users can select goods_receipt_items" on public."goods_receipt_items";
drop policy if exists "ops_write_goods_receipt_items" on public."goods_receipt_items";
create policy "p_goods_receipt_items_select_access" on public."goods_receipt_items" as permissive for select to authenticated using (true);
create policy "p_goods_receipt_items_insert_access" on public."goods_receipt_items" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_goods_receipt_items_update_access" on public."goods_receipt_items" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_goods_receipt_items_delete_access" on public."goods_receipt_items" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));

-- public.goods_receipts
drop policy if exists "Authenticated users can select goods_receipts" on public."goods_receipts";
drop policy if exists "ops_write_goods_receipts" on public."goods_receipts";
create policy "p_goods_receipts_select_access" on public."goods_receipts" as permissive for select to authenticated using (true);
create policy "p_goods_receipts_insert_access" on public."goods_receipts" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_goods_receipts_update_access" on public."goods_receipts" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_goods_receipts_delete_access" on public."goods_receipts" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));

-- public.inventory_batches
drop policy if exists "Authenticated users can select inventory_batches" on public."inventory_batches";
drop policy if exists "ops_write_inventory_batches" on public."inventory_batches";
create policy "p_inventory_batches_select_access" on public."inventory_batches" as permissive for select to authenticated using (true);
create policy "p_inventory_batches_insert_access" on public."inventory_batches" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_inventory_batches_update_access" on public."inventory_batches" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_inventory_batches_delete_access" on public."inventory_batches" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));

-- public.inventory_items
drop policy if exists "Authenticated users can select inventory_items" on public."inventory_items";
drop policy if exists "ops_write_inventory_items" on public."inventory_items";
create policy "p_inventory_items_select_access" on public."inventory_items" as permissive for select to authenticated using (true);
create policy "p_inventory_items_insert_access" on public."inventory_items" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_inventory_items_update_access" on public."inventory_items" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_inventory_items_delete_access" on public."inventory_items" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));

-- public.invoice_items
drop policy if exists "Authenticated users can select invoice_items" on public."invoice_items";
drop policy if exists "finance_write_invoice_items" on public."invoice_items";
create policy "p_invoice_items_select_access" on public."invoice_items" as permissive for select to authenticated using (true);
create policy "p_invoice_items_insert_access" on public."invoice_items" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_invoice_items_update_access" on public."invoice_items" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_invoice_items_delete_access" on public."invoice_items" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));

-- public.invoices
drop policy if exists "Authenticated users can select invoices" on public."invoices";
drop policy if exists "finance_write_invoices" on public."invoices";
create policy "p_invoices_select_access" on public."invoices" as permissive for select to authenticated using (true);
create policy "p_invoices_insert_access" on public."invoices" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_invoices_update_access" on public."invoices" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_invoices_delete_access" on public."invoices" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));

-- public.kitchen_inventory_movements
drop policy if exists "Kitchen inventory insert manual movements" on public."kitchen_inventory_movements";
drop policy if exists "Kitchen inventory view movements" on public."kitchen_inventory_movements";
create policy "p_kitchen_inventory_movements_select_access" on public."kitchen_inventory_movements" as permissive for select to authenticated using (can_access_kitchen_inventory(false));
create policy "p_kitchen_inventory_movements_insert_access" on public."kitchen_inventory_movements" as permissive for insert to authenticated with check ((can_access_kitchen_inventory(true) AND (source = ANY (ARRAY['manual_daily'::text, 'adjustment'::text])) AND (created_by = (select auth.uid()))));

-- public.mini_crm_knowledge_change_requests
drop policy if exists "Authenticated users can read KB change requests" on public."mini_crm_knowledge_change_requests";
drop policy if exists "crm_write_mini_crm_knowledge_change_requests" on public."mini_crm_knowledge_change_requests";
create policy "p_mini_crm_knowledge_change_requests_select_access" on public."mini_crm_knowledge_change_requests" as permissive for select to authenticated using (true);
create policy "p_mini_crm_knowledge_change_requests_insert_access" on public."mini_crm_knowledge_change_requests" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_mini_crm_knowledge_change_requests_update_access" on public."mini_crm_knowledge_change_requests" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_mini_crm_knowledge_change_requests_delete_access" on public."mini_crm_knowledge_change_requests" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));

-- public.mini_crm_knowledge_profile_versions
drop policy if exists "Authenticated users can read KB versions" on public."mini_crm_knowledge_profile_versions";
drop policy if exists "crm_write_mini_crm_knowledge_profile_versions" on public."mini_crm_knowledge_profile_versions";
create policy "p_mini_crm_knowledge_profile_versions_select_access" on public."mini_crm_knowledge_profile_versions" as permissive for select to authenticated using (true);
create policy "p_mini_crm_knowledge_profile_versions_insert_access" on public."mini_crm_knowledge_profile_versions" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_mini_crm_knowledge_profile_versions_update_access" on public."mini_crm_knowledge_profile_versions" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_mini_crm_knowledge_profile_versions_delete_access" on public."mini_crm_knowledge_profile_versions" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));

-- public.payroll_adjustments
drop policy if exists "owner_full_access_payroll_adjustments" on public."payroll_adjustments";
drop policy if exists "payroll_edit_payroll_adjustments" on public."payroll_adjustments";
drop policy if exists "payroll_view_payroll_adjustments" on public."payroll_adjustments";
create policy "p_payroll_adjustments_select_access" on public."payroll_adjustments" as permissive for select to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'payroll'::text, 'view'::text)))));
create policy "p_payroll_adjustments_insert_access" on public."payroll_adjustments" as permissive for insert to authenticated with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));
create policy "p_payroll_adjustments_update_access" on public."payroll_adjustments" as permissive for update to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text)))) with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));
create policy "p_payroll_adjustments_delete_access" on public."payroll_adjustments" as permissive for delete to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));

-- public.payroll_lines
drop policy if exists "owner_full_access_payroll_lines" on public."payroll_lines";
drop policy if exists "payroll_edit_payroll_lines" on public."payroll_lines";
drop policy if exists "payroll_view_payroll_lines" on public."payroll_lines";
create policy "p_payroll_lines_select_access" on public."payroll_lines" as permissive for select to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'payroll'::text, 'view'::text)))));
create policy "p_payroll_lines_insert_access" on public."payroll_lines" as permissive for insert to authenticated with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));
create policy "p_payroll_lines_update_access" on public."payroll_lines" as permissive for update to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text)))) with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));
create policy "p_payroll_lines_delete_access" on public."payroll_lines" as permissive for delete to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));

-- public.payroll_runs
drop policy if exists "owner_full_access_payroll_runs" on public."payroll_runs";
drop policy if exists "payroll_edit_payroll_runs" on public."payroll_runs";
drop policy if exists "payroll_view_payroll_runs" on public."payroll_runs";
create policy "p_payroll_runs_select_access" on public."payroll_runs" as permissive for select to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'payroll'::text, 'view'::text)))));
create policy "p_payroll_runs_insert_access" on public."payroll_runs" as permissive for insert to authenticated with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));
create policy "p_payroll_runs_update_access" on public."payroll_runs" as permissive for update to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text)))) with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));
create policy "p_payroll_runs_delete_access" on public."payroll_runs" as permissive for delete to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'payroll'::text, 'edit'::text))));

-- public.product_skus
drop policy if exists "Authenticated users can select product_skus" on public."product_skus";
drop policy if exists "ops_write_product_skus" on public."product_skus";
create policy "p_product_skus_select_access" on public."product_skus" as permissive for select to authenticated using (true);
create policy "p_product_skus_insert_access" on public."product_skus" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_product_skus_update_access" on public."product_skus" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_product_skus_delete_access" on public."product_skus" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));

-- public.production_material_issue_items
drop policy if exists "production_material_issue_items_edit" on public."production_material_issue_items";
drop policy if exists "production_material_issue_items_view" on public."production_material_issue_items";
create policy "p_production_material_issue_items_select_access" on public."production_material_issue_items" as permissive for select to authenticated using ((((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text))) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'view'::text)))));
create policy "p_production_material_issue_items_insert_access" on public."production_material_issue_items" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text)));
create policy "p_production_material_issue_items_update_access" on public."production_material_issue_items" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text)));
create policy "p_production_material_issue_items_delete_access" on public."production_material_issue_items" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text)));

-- public.production_material_issues
drop policy if exists "production_material_issues_edit" on public."production_material_issues";
drop policy if exists "production_material_issues_view" on public."production_material_issues";
create policy "p_production_material_issues_select_access" on public."production_material_issues" as permissive for select to authenticated using ((((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text))) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'view'::text)))));
create policy "p_production_material_issues_insert_access" on public."production_material_issues" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text)));
create policy "p_production_material_issues_update_access" on public."production_material_issues" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text)));
create policy "p_production_material_issues_delete_access" on public."production_material_issues" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'edit'::text)));

-- public.production_shift_workers
drop policy if exists "owner_full_access_production_shift_workers" on public."production_shift_workers";
drop policy if exists "production_edit_shift_workers" on public."production_shift_workers";
drop policy if exists "production_view_shift_workers" on public."production_shift_workers";
create policy "p_production_shift_workers_select_access" on public."production_shift_workers" as permissive for select to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'production'::text, 'edit'::text)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_module_permission((select auth.uid()), 'production'::text, 'view'::text) OR has_module_permission((select auth.uid()), 'payroll'::text, 'view'::text)))));
create policy "p_production_shift_workers_insert_access" on public."production_shift_workers" as permissive for insert to authenticated with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'production'::text, 'edit'::text))));
create policy "p_production_shift_workers_update_access" on public."production_shift_workers" as permissive for update to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'production'::text, 'edit'::text)))) with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'production'::text, 'edit'::text))));
create policy "p_production_shift_workers_delete_access" on public."production_shift_workers" as permissive for delete to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (has_module_permission((select auth.uid()), 'production'::text, 'edit'::text))));

-- public.profiles
drop policy if exists "owner_delete_profiles" on public."profiles";
drop policy if exists "owner_insert_profiles" on public."profiles";
drop policy if exists "owner_update_profiles" on public."profiles";
drop policy if exists "profiles_select" on public."profiles";
drop policy if exists "users_update_own_profile" on public."profiles";
create policy "p_profiles_select_access" on public."profiles" as permissive for select to authenticated using (true);
create policy "p_profiles_insert_access" on public."profiles" as permissive for insert to authenticated with check (has_role((select auth.uid()), 'owner'::app_role));
create policy "p_profiles_update_access" on public."profiles" as permissive for update to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR (((select auth.uid()) = id)))) with check (((has_role((select auth.uid()), 'owner'::app_role)) OR (((select auth.uid()) = id))));
create policy "p_profiles_delete_access" on public."profiles" as permissive for delete to authenticated using (has_role((select auth.uid()), 'owner'::app_role));

-- public.purchase_order_items
drop policy if exists "Authenticated users can select purchase_order_items" on public."purchase_order_items";
drop policy if exists "ops_write_purchase_order_items" on public."purchase_order_items";
create policy "p_purchase_order_items_select_access" on public."purchase_order_items" as permissive for select to authenticated using (true);
create policy "p_purchase_order_items_insert_access" on public."purchase_order_items" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_purchase_order_items_update_access" on public."purchase_order_items" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_purchase_order_items_delete_access" on public."purchase_order_items" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));

-- public.purchase_orders
drop policy if exists "Authenticated users can select purchase_orders" on public."purchase_orders";
drop policy if exists "ops_write_purchase_orders" on public."purchase_orders";
create policy "p_purchase_orders_select_access" on public."purchase_orders" as permissive for select to authenticated using (true);
create policy "p_purchase_orders_insert_access" on public."purchase_orders" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_purchase_orders_update_access" on public."purchase_orders" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));
create policy "p_purchase_orders_delete_access" on public."purchase_orders" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role) OR has_role((select auth.uid()), 'warehouse'::app_role)));

-- public.revenue_ledger_lines
drop policy if exists "finance_read_revenue_ledger_lines" on public."revenue_ledger_lines";
drop policy if exists "finance_write_revenue_ledger_lines" on public."revenue_ledger_lines";
create policy "p_revenue_ledger_lines_select_access" on public."revenue_ledger_lines" as permissive for select to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_revenue_ledger_lines_insert_access" on public."revenue_ledger_lines" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_revenue_ledger_lines_update_access" on public."revenue_ledger_lines" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_revenue_ledger_lines_delete_access" on public."revenue_ledger_lines" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));

-- public.revenue_monthly_parse_lines
drop policy if exists "finance_owner_write_revenue_monthly_parse_lines" on public."revenue_monthly_parse_lines";
drop policy if exists "finance_read_revenue_monthly_parse_lines" on public."revenue_monthly_parse_lines";
create policy "p_revenue_monthly_parse_lines_select_access" on public."revenue_monthly_parse_lines" as permissive for select to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)))));
create policy "p_revenue_monthly_parse_lines_insert_access" on public."revenue_monthly_parse_lines" as permissive for insert to authenticated with check (has_role((select auth.uid()), 'owner'::app_role));
create policy "p_revenue_monthly_parse_lines_update_access" on public."revenue_monthly_parse_lines" as permissive for update to authenticated using (has_role((select auth.uid()), 'owner'::app_role)) with check (has_role((select auth.uid()), 'owner'::app_role));
create policy "p_revenue_monthly_parse_lines_delete_access" on public."revenue_monthly_parse_lines" as permissive for delete to authenticated using (has_role((select auth.uid()), 'owner'::app_role));

-- public.revenue_monthly_parse_runs
drop policy if exists "finance_owner_write_revenue_monthly_parse_runs" on public."revenue_monthly_parse_runs";
drop policy if exists "finance_read_revenue_monthly_parse_runs" on public."revenue_monthly_parse_runs";
create policy "p_revenue_monthly_parse_runs_select_access" on public."revenue_monthly_parse_runs" as permissive for select to authenticated using (((has_role((select auth.uid()), 'owner'::app_role)) OR ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)))));
create policy "p_revenue_monthly_parse_runs_insert_access" on public."revenue_monthly_parse_runs" as permissive for insert to authenticated with check (has_role((select auth.uid()), 'owner'::app_role));
create policy "p_revenue_monthly_parse_runs_update_access" on public."revenue_monthly_parse_runs" as permissive for update to authenticated using (has_role((select auth.uid()), 'owner'::app_role)) with check (has_role((select auth.uid()), 'owner'::app_role));
create policy "p_revenue_monthly_parse_runs_delete_access" on public."revenue_monthly_parse_runs" as permissive for delete to authenticated using (has_role((select auth.uid()), 'owner'::app_role));

-- public.revenue_source_documents
drop policy if exists "finance_read_revenue_source_documents" on public."revenue_source_documents";
drop policy if exists "finance_write_revenue_source_documents" on public."revenue_source_documents";
create policy "p_revenue_source_documents_select_access" on public."revenue_source_documents" as permissive for select to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_revenue_source_documents_insert_access" on public."revenue_source_documents" as permissive for insert to authenticated with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_revenue_source_documents_update_access" on public."revenue_source_documents" as permissive for update to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role))) with check ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
create policy "p_revenue_source_documents_delete_access" on public."revenue_source_documents" as permissive for delete to authenticated using ((has_role((select auth.uid()), 'owner'::app_role) OR has_role((select auth.uid()), 'staff'::app_role)));
