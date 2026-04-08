---
children_hash: 8181047073b96d50c4fac2ef19cbf25e8a414ee162784a7dc464976efa59c5a0
compression_ratio: 0.13001277139208173
condensation_order: 1
covers: [ceo_daily_closing_declarations_persistence_fix.md, ceo_declaration_hydration_guard.md, ceo_declaration_ocr_state_preservation_fix.md, context.md, finance_cost_declaration_ux_improvements.md, financecontrol_qtm_and_reconciliation_flow.md, monthly_close_view_sync_fix.md, monthly_tab_selected_month_sync.md, slip_ocr_debug_logging_enhancements.md]
covers_token_total: 3915
summary_level: d1
token_count: 509
type: summary
---
### Domain: operations/finance  
- **CEO declaration state resilience**  
  - *CEO Declaration OCR State Preservation Fix*, *CEO Declaration Hydration Guard*: protect CEO declaration OCR data from stale React state or refetches by forcing `processSlipUpload` to supply explicit overrides, gating hydration while save/extract/pending OCR work occur, and enforcing “no hydration during pending work” rules, so totals/previews persist accurately.  
  - *CEO Daily Closing Declarations Persistence Fix*: close-day approval/closure now pulls UNC/QTM snapshots from the reconciliation/folder scan, writes `qtm_spent_from_folder` and `qtm_closing_balance` into `extraction_meta`, and aligns audit logs with the same snapshot to prevent stale-history drift.

- **Finance declaration UX + logging flows**  
  - *Finance Cost Declaration UX Improvements*: declared UNC/QTM slips render as previewable cards, allow deletions with backend persistence, and recalc UNC/QTM totals after removal, improving owner control over slip accuracy.  
  - *Slip OCR Debug Logging Enhancements*: per-file OCR logs (amount, confidence, raw output) plus zero-amount UI toast/debug messages now surface, aiding mobile QTM extraction diagnostics.

- **FinanceControl reconciliation orchestration**  
  - *FinanceControl QTM and Reconciliation Flow*: tracks selected date/tab filters, fires hooks to hydrate snapshots/declarations/UNC data, runs `runFolderReconciliation` (three-file batches, retries, caching via `scan-drive-folder`, `drive_file_index`), and derives UNC/QTM UI metrics (declared flags, closing balance, `qtmNegative`), all supported by image utilities and error handling for OCR fidelity.

- **Monthly close tab synchronization**  
  - *Monthly Close View Sync Fix* & *Monthly Tab Selected Month Sync*: keep `selectedMonth` tied to `startOfMonth(selectedDate)` when switching tabs or entering the monthly view, preventing April rows when a late-March day was selected, ensuring monthly grid alignment, and enforcing tab-enter synchronization rules.