# BMQ source coverage — 2026-09-09

This is an inventory, not a claim that all BMQ data is connected. Public schema: 180 base tables, 17 views. This release synchronizes 24 explicit projections and exposes 14 measures. Names/counts of contract file records do not imply contents were ingested or legal validity established. Raw-only rows are not automatically exposed to the LLM.

## Remaining business work

- Customer-specific current explicit prices and dealer order header lists: owner-only exact customer lookup added; ambiguous matches require customer code. No checkout price fallback, past prices, downstream route scope, tax/contract terms or order totals. Product/order line details remain pending.
- Distributor receivables and reconciliation: adjustments/collections/dispatch-confirmation dependencies not covered by supplier-payables formula.
- Specialized Tan Tao/Q7/kitchen ledgers, inventory reservations and unit conversions: not equivalent to inventory_items.
- Manufacturing materials, actual production quantities, COGS, QA: count of production orders does not cover these.
- Attendance/payroll: define authorized fields and wage/time semantics, do not expose GPS or personal wage profiles through generic analytics.
- Contracts/policies: current contract table has zero active file records; no terms read. Customer knowledge profiles/versions need effective-version and disclosure review before retrieval.
- App page filters remain unsupported; fail closed, not global totals. Customer price/order-list scope now uses a dedicated lookup; customer financial metrics and downstream routes remain unsupported.
- No new backups/training/GBrain integration in this release.

## Complete source inventory

| Source | Kind | Connection status |
|---|---|---|
| ai_function_rate_limits | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| app_settings | BASE TABLE | Pending source projection + business contract + reconciliation |
| attendance_adjustments | BASE TABLE | Pending source projection + business contract + reconciliation |
| attendance_events | BASE TABLE | Pending source projection + business contract + reconciliation |
| attendance_geofence_location_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| attendance_geofence_locations | BASE TABLE | Pending source projection + business contract + reconciliation |
| attendance_periods | BASE TABLE | Pending source projection + business contract + reconciliation |
| attendance_qr_checkpoints | BASE TABLE | Pending source projection + business contract + reconciliation |
| attendance_records | BASE TABLE | Pending source projection + business contract + reconciliation |
| attendance_records_trusted_gps_context | BASE TABLE | Pending source projection + business contract + reconciliation |
| attendance_shift_assignments | BASE TABLE | Pending source projection + business contract + reconciliation |
| attendance_shifts | BASE TABLE | Pending source projection + business contract + reconciliation |
| audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| cash_fund_topups | BASE TABLE | Pending source projection + business contract + reconciliation |
| ceo_daily_closing_declarations | BASE TABLE | Pending source projection + business contract + reconciliation |
| cost_categories | BASE TABLE | Pending source projection + business contract + reconciliation |
| cost_classification_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| cost_classification_category_summary | VIEW | Derived view; reconcile underlying sources first |
| cost_classification_line_details | VIEW | Derived view; reconcile underlying sources first |
| cost_classification_monthly_summary | VIEW | Derived view; reconcile underlying sources first |
| cost_classification_ocr_backfill_preview | VIEW | Derived view; reconcile underlying sources first |
| cost_classification_rules | BASE TABLE | Pending source projection + business contract + reconciliation |
| cost_item_alias_mappings | BASE TABLE | Pending source projection + business contract + reconciliation |
| cost_line_classifications | BASE TABLE | Pending source projection + business contract + reconciliation |
| customer_debt_period_adjustment_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| customer_debt_period_adjustments | BASE TABLE | Pending source projection + business contract + reconciliation |
| customer_po_inbox | BASE TABLE | Pending source projection + business contract + reconciliation |
| daily_reconciliations | BASE TABLE | Pending source projection + business contract + reconciliation |
| dealer_announcements | BASE TABLE | Pending source projection + business contract + reconciliation |
| dealer_customer_contacts | BASE TABLE | Pending source projection + business contract + reconciliation |
| dealer_customer_order_confirmations | BASE TABLE | Pending source projection + business contract + reconciliation |
| dealer_notification_worker_config | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| dealer_order_cancellation_events | BASE TABLE | Pending source projection + business contract + reconciliation |
| dealer_order_items | BASE TABLE | Raw only; detail query not yet exposed |
| dealer_order_notifications | BASE TABLE | Pending source projection + business contract + reconciliation |
| dealer_orders | BASE TABLE | Raw + governed measure |
| dealer_otp_challenges | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| dealer_sessions | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| dealer_test_order_confirmations | BASE TABLE | Pending source projection + business contract + reconciliation |
| delivery_staff | BASE TABLE | Pending source projection + business contract + reconciliation |
| delivery_staff_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| drive_file_index | BASE TABLE | Pending source projection + business contract + reconciliation |
| drive_import_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| drive_sync_config | BASE TABLE | Operational/audit source; not a business metric by default |
| employee_wage_profiles | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| facebook_data_deletion_requests | BASE TABLE | Pending source projection + business contract + reconciliation |
| facebook_instinct_reply_audit | BASE TABLE | Operational/audit source; not a business metric by default |
| facebook_instinct_reply_nonces | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| facebook_messenger_conversations | BASE TABLE | Pending source projection + business contract + reconciliation |
| facebook_messenger_email_outbox | BASE TABLE | Pending source projection + business contract + reconciliation |
| facebook_messenger_messages | BASE TABLE | Pending source projection + business contract + reconciliation |
| facebook_messenger_outbox | BASE TABLE | Pending source projection + business contract + reconciliation |
| facebook_messenger_settings | BASE TABLE | Pending source projection + business contract + reconciliation |
| facebook_messenger_webhook_events | BASE TABLE | Pending source projection + business contract + reconciliation |
| facebook_page_oauth_candidates | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| facebook_page_oauth_states | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| facebook_platform_identities | BASE TABLE | Pending source projection + business contract + reconciliation |
| finance_daily_close_runs | BASE TABLE | Pending source projection + business contract + reconciliation |
| finance_payment_auto_approval_matches | BASE TABLE | Pending source projection + business contract + reconciliation |
| goods_receipt_auto_issue_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| goods_receipt_auto_issues | BASE TABLE | Pending source projection + business contract + reconciliation |
| goods_receipt_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| goods_receipts | BASE TABLE | Raw + governed measure |
| inventory_batches | BASE TABLE | Pending source projection + business contract + reconciliation |
| inventory_items | BASE TABLE | Raw + governed measure |
| inventory_movements | BASE TABLE | Pending source projection + business contract + reconciliation |
| invoice_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| invoices | BASE TABLE | Pending source projection + business contract + reconciliation |
| kfm_daily_material_issue_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| kfm_daily_material_issue_sources | BASE TABLE | Pending source projection + business contract + reconciliation |
| kfm_daily_material_issues | BASE TABLE | Pending source projection + business contract + reconciliation |
| kiosk_daily_report_channel_rows | BASE TABLE | Raw + governed measure |
| kiosk_daily_report_inventory_rows | BASE TABLE | Raw only; detail query not yet exposed |
| kiosk_daily_reports | BASE TABLE | Raw + governed measure |
| kiosk_point_revenue_adjustments | BASE TABLE | Pending source projection + business contract + reconciliation |
| kiosk_point_revenue_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| kiosk_point_revenue_reviews | BASE TABLE | Pending source projection + business contract + reconciliation |
| kiosk_report_auth_rate_limits | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| kiosk_report_channels | BASE TABLE | Raw only; detail query not yet exposed |
| kiosk_report_locations | BASE TABLE | Raw only; detail query not yet exposed |
| kiosk_report_otp_challenges | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| kiosk_report_products | BASE TABLE | Raw only; detail query not yet exposed |
| kiosk_report_sessions | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| kiosk_report_staff | BASE TABLE | Pending source projection + business contract + reconciliation |
| kitchen_inventory_import_batches | BASE TABLE | Pending source projection + business contract + reconciliation |
| kitchen_inventory_import_rows | BASE TABLE | Pending source projection + business contract + reconciliation |
| kitchen_inventory_item_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| kitchen_inventory_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| kitchen_inventory_monthly_closings | BASE TABLE | Pending source projection + business contract + reconciliation |
| kitchen_inventory_movement_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| kitchen_inventory_movements | BASE TABLE | Pending source projection + business contract + reconciliation |
| kitchen_other_costs | BASE TABLE | Pending source projection + business contract + reconciliation |
| material_master_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| material_master_enforcement_config | BASE TABLE | Operational/audit source; not a business metric by default |
| material_master_shadow_rollout_dashboard | VIEW | Derived view; reconcile underlying sources first |
| material_price_history | BASE TABLE | Pending source projection + business contract + reconciliation |
| material_resolution_requests | BASE TABLE | Pending source projection + business contract + reconciliation |
| material_scoped_aliases | BASE TABLE | Pending source projection + business contract + reconciliation |
| material_supplier_products | BASE TABLE | Pending source projection + business contract + reconciliation |
| material_supplier_unit_scan_evidence | BASE TABLE | Pending source projection + business contract + reconciliation |
| material_unit_conversions | BASE TABLE | Pending source projection + business contract + reconciliation |
| mini_crm_agent_ui_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| mini_crm_customer_contracts | BASE TABLE | Raw + governed measure |
| mini_crm_customer_emails | BASE TABLE | Pending source projection + business contract + reconciliation |
| mini_crm_customer_price_list | BASE TABLE | Raw + owner-scoped current explicit price lookup |
| mini_crm_customers | BASE TABLE | Raw + governed measure |
| mini_crm_knowledge_change_requests | BASE TABLE | Pending source projection + business contract + reconciliation |
| mini_crm_knowledge_profile_versions | BASE TABLE | Pending source projection + business contract + reconciliation |
| mini_crm_knowledge_profiles | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| mini_crm_po_template_learning_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| mini_crm_po_templates | BASE TABLE | Pending source projection + business contract + reconciliation |
| mobile_gps_attendance_event_coordinate_details | VIEW | Derived view; reconcile underlying sources first |
| mobile_gps_attendance_event_summaries | VIEW | Derived view; reconcile underlying sources first |
| mobile_gps_attendance_events | BASE TABLE | Pending source projection + business contract + reconciliation |
| mobile_gps_attendance_manual_overrides | BASE TABLE | Pending source projection + business contract + reconciliation |
| mobile_gps_attendance_pilot_actor_gate_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| mobile_gps_attendance_pilot_actor_gates | BASE TABLE | Pending source projection + business contract + reconciliation |
| mobile_gps_attendance_pilot_event_summaries | VIEW | Derived view; reconcile underlying sources first |
| mobile_gps_attendance_retention_policy_config | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| mobile_gps_attendance_retention_policy_status | VIEW | Derived view; reconcile underlying sources first |
| mobile_gps_attendance_sync_results | BASE TABLE | Pending source projection + business contract + reconciliation |
| order_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| orders | BASE TABLE | Pending source projection + business contract + reconciliation |
| payment_allocations | BASE TABLE | Raw + governed measure |
| payment_request_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| payment_requests | BASE TABLE | Raw + governed measure |
| payments | BASE TABLE | Pending source projection + business contract + reconciliation |
| payroll_adjustments | BASE TABLE | Pending source projection + business contract + reconciliation |
| payroll_lines | BASE TABLE | Pending source projection + business contract + reconciliation |
| payroll_runs | BASE TABLE | Pending source projection + business contract + reconciliation |
| pending_kiosk_bread_recompute | BASE TABLE | Operational/audit source; not a business metric by default |
| po_dispatch_revenue_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| po_dispatch_revenue_confirmation_lines | BASE TABLE | Pending source projection + business contract + reconciliation |
| po_dispatch_revenue_confirmations | BASE TABLE | Pending source projection + business contract + reconciliation |
| po_parse_runs | BASE TABLE | Pending source projection + business contract + reconciliation |
| po_revenue_post_audit | BASE TABLE | Operational/audit source; not a business metric by default |
| po_sync_jobs | BASE TABLE | Operational/audit source; not a business metric by default |
| po_sync_runtime_locks | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| po_sync_schedules | BASE TABLE | Operational/audit source; not a business metric by default |
| po_sync_snapshots | BASE TABLE | Operational/audit source; not a business metric by default |
| product_label_specs | BASE TABLE | Pending source projection + business contract + reconciliation |
| product_skus | BASE TABLE | Raw + governed measure |
| production_location_sku_settings | BASE TABLE | Pending source projection + business contract + reconciliation |
| production_material_issue_check_actuals | BASE TABLE | Pending source projection + business contract + reconciliation |
| production_material_issue_checks | BASE TABLE | Pending source projection + business contract + reconciliation |
| production_material_issue_events | BASE TABLE | Pending source projection + business contract + reconciliation |
| production_material_issue_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| production_material_issues | BASE TABLE | Pending source projection + business contract + reconciliation |
| production_order_items | BASE TABLE | Raw only; detail query not yet exposed |
| production_orders | BASE TABLE | Raw + governed measure |
| production_shift_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| production_shift_workers | BASE TABLE | Pending source projection + business contract + reconciliation |
| production_shifts | BASE TABLE | Pending source projection + business contract + reconciliation |
| profiles | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| purchase_order_items | BASE TABLE | Raw only; detail query not yet exposed |
| purchase_orders | BASE TABLE | Raw + governed measure |
| q7_inventory_movements | BASE TABLE | Pending source projection + business contract + reconciliation |
| q7_inventory_opening_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| q7_inventory_openings | BASE TABLE | Pending source projection + business contract + reconciliation |
| q7_material_issue_material_mappings | BASE TABLE | Pending source projection + business contract + reconciliation |
| qa_inspection_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| qa_inspections | BASE TABLE | Pending source projection + business contract + reconciliation |
| qa_label_checks | BASE TABLE | Pending source projection + business contract + reconciliation |
| revenue_auto_daily_parse_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| revenue_draft_daily_review_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| revenue_drafts | BASE TABLE | Pending source projection + business contract + reconciliation |
| revenue_ledger_line_audit_logs | BASE TABLE | Operational/audit source; not a business metric by default |
| revenue_ledger_lines | BASE TABLE | Raw + governed measure |
| revenue_monthly_parse_lines | BASE TABLE | Pending source projection + business contract + reconciliation |
| revenue_monthly_parse_runs | BASE TABLE | Pending source projection + business contract + reconciliation |
| revenue_source_documents | BASE TABLE | Raw + governed measure |
| sales_po_documents | BASE TABLE | Pending source projection + business contract + reconciliation |
| sku_cogs_material_aliases | BASE TABLE | Pending source projection + business contract + reconciliation |
| sku_cogs_materials | BASE TABLE | Pending source projection + business contract + reconciliation |
| sku_cogs_version_formulations | BASE TABLE | Pending source projection + business contract + reconciliation |
| sku_cogs_versions | BASE TABLE | Pending source projection + business contract + reconciliation |
| sku_formulations | BASE TABLE | Pending source projection + business contract + reconciliation |
| supplier_aliases | BASE TABLE | Pending source projection + business contract + reconciliation |
| supplier_product_aliases | BASE TABLE | Pending source projection + business contract + reconciliation |
| supplier_scan_templates | BASE TABLE | Pending source projection + business contract + reconciliation |
| suppliers | BASE TABLE | Raw only; detail query not yet exposed |
| tan_tao_warehouse_documents | BASE TABLE | Pending source projection + business contract + reconciliation |
| tan_tao_warehouse_movements | BASE TABLE | Pending source projection + business contract + reconciliation |
| tan_tao_warehouse_reservations | BASE TABLE | Pending source projection + business contract + reconciliation |
| user_invitations | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| user_module_permissions | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| user_roles | BASE TABLE | Excluded from analytics by default; security/config or sensitive profile review |
| v_labor_cost_by_sku | VIEW | Derived view; reconcile underlying sources first |
| v_payroll_journal_draft | VIEW | Derived view; reconcile underlying sources first |
| v_payroll_period_summary | VIEW | Derived view; reconcile underlying sources first |
| v_shift_total_labor_cost | VIEW | Derived view; reconcile underlying sources first |
| v_shift_worker_cost | VIEW | Derived view; reconcile underlying sources first |
| v_sku_labor_cost_actual | VIEW | Derived view; reconcile underlying sources first |
| v_sku_labor_cost_monthly | VIEW | Derived view; reconcile underlying sources first |
| v_sku_labor_cost_monthly_enriched | VIEW | Derived view; reconcile underlying sources first |
| warehouse_dispatch_items | BASE TABLE | Pending source projection + business contract + reconciliation |
| warehouse_dispatches | BASE TABLE | Raw + governed measure |

