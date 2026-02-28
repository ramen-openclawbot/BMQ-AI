---
name: po-xlsx-parse-guardrails
description: Harden and validate PO XLSX parsing for finance flows (subtotal, VAT, total, posting snapshot). Use when working on PO parse logic, invoice/order XLSX mapping, finance amount bugs, or when a parse fix must be safe against column shifts and locale number formats.
---

# PO XLSX Parse Guardrails

Apply this checklist before changing parser code.

## 1) Lock source-of-truth fields

- Read totals from explicit header names when available:
  - `Tổng tiền PO (-VAT)`
  - `Tổng thuế`
  - `Tổng tiền PO (+VAT)`
- Avoid fixed index-only logic unless template is guaranteed immutable.
- Keep runtime fallback order deterministic and documented.

## 2) Normalize money safely

- Parse locale formats robustly (`1.234.567,89`, `1,234,567.89`).
- Strip non-numeric symbols except decimal/group separators.
- Reject non-finite values and return `0` fallback.

## 3) Add sanity checks

- Enforce `total ~= subtotal + vat` within bounded tolerance.
- If parsed `total` is abnormal, recompute from parts.
- If line-based subtotal is abnormal, compare with `qty * unit_price` subtotal.

## 4) UI and posting consistency

- UI draft must display `total = subtotal + vat`.
- Save payload must persist same formula.
- Revenue post snapshot (`raw_payload.revenue_post`) must include `subtotal`, `vat`, `total`.

## 5) Mandatory tests before merge

Create/maintain fixture tests in `references/test-cases.md`:

- Normal template parse
- Shifted-column template parse
- Mixed locale number format parse
- Re-parse idempotency (same input => same totals)

Do not merge if any case fails.

## 6) Safe rollout

- Prefer canary parse (old/new compare) for parser refactors.
- Log parse metadata (`parser version`, `subtotal source`, mapped columns).
- Keep rollback path ready (previous parser version and commit hash).

## 7) Quick debugging steps

- Re-run parse on same inbox ID and compare:
  - `subtotal_amount`, `vat_amount`, `total_amount`
  - `raw_payload.parse_meta`
  - `raw_payload.revenue_post`
- If mismatch exists, trust explicit sheet totals first, then fallback chain.

## References

- Read `references/test-cases.md` before parser changes.
- Read `references/rollout-checklist.md` before deploy.
