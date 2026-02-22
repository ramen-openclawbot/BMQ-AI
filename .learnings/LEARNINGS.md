## [LRN-20260222-001] correction

**Logged**: 2026-02-22T16:10:00+07:00
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
Auto-seed SKU flow claimed success but SKU was not visible due silent failure.

### Details
User reported "Chưa có SKU thành phẩm" after assistant said sample SKU would be auto-created. Root cause likely insert payload in ensureBmcbSampleSku missed required field(s) and errors were swallowed in useEffect catch.

### Suggested Action
Include required fields in insert payload (unit_price), and stop swallowing errors silently; log to console and/or surface toast for diagnostics.

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/pages/SkuCostsManagement.tsx
- Tags: sku, silent-failure, validation

---
