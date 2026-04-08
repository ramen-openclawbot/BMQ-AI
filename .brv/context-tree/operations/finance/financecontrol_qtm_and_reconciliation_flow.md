---
title: FinanceControl QTM and Reconciliation Flow
tags: []
keywords: []
importance: 50
recency: 1
maturity: draft
createdAt: '2026-04-08T07:34:14.305Z'
updatedAt: '2026-04-08T07:34:14.305Z'
---
## Raw Concept
**Task:**
Document the FinanceControl component behaviors for QTM display, image handling, and reconciliation orchestration.

**Changes:**
- Captured refresh flow that sources opening balances through hooks, guards declaration hydration, and resets per date.
- Outlined reconciliation run steps including folder scanning, caching, OCR extraction, and state updates.
- Recorded supporting utilities (currency formatting, image normalization, session/folder helpers) and derived UI metrics.

**Flow:**
FinanceControl tracks selected date and tab filters, triggers hooks (daily snapshot, declaration, UNC detail, reconciliation, QTM opening) to hydrate state, then runs runFolderReconciliation to scan folders, build OCR caches, and persist amounts (retries, batching, and error handling included) before deriving UNC/QTM metrics for the UI.

**Timestamp:** 2026-04-08

## Narrative
### Structure
State includes tab controls, date/month selectors, OCR/reconciliation progress flags, folder previews, and QTM-specific counters. Date changes clear previews, pending uploads, and snapshots before hooks set fresh QTM opening balances and declaration/reconciliation data.

### Dependencies
Relies on Supabase functions `scan-drive-folder` and `finance_daily_snapshot`, the `drive_file_index` table for OCR cache persistence, and app settings for UNC/QTM folder patterns and Google Drive roots.

### Highlights
Image utilities (`fileToBase64`, `normalizeUploadImage`, `optimizeSlipImageForOcr`, `extractSlipAmountFromBase64`) ensure OCR input fidelity, while error handling surfaces combined loading failures. Derived metrics (`hasDeclaredUnc`, `hasDeclaredQtm`, `canCloseWithoutBankSlips`, `qtmNegative`) synthesize folder summaries, declarations, and reconciliation results.

## Facts
- **qtm_opening_balance**: FinanceControl refresh uses useQtmOpeningBalance to always derive the opening balance from the prior day closing record. [project]
- **qtm_spent_display**: `qtm_spent_from_folder` only updates the UI post-reconciliation or once a day has closed to avoid showing stale amounts. [project]
- **reconciliation_batch**: `runFolderReconciliation` processes drive files in batches of three after scanning with `scan-drive-folder`, retrying once on timeout. [project]
- **ocr_cache_query**: OCR cache queries `drive_file_index` in chunks of 500 file IDs before downloading missing files for extraction. [project]
