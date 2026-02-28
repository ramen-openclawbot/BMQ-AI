# Parser Rollout Checklist

## Before deploy
- Confirm parser version bump in parse metadata.
- Confirm fallback order is documented in code comments.
- Confirm fixture tests pass.

## Deploy
- Deploy function.
- Parse 1 known-good PO and 1 previously-broken PO.

## After deploy
- Verify UI values:
  - Tạm tính
  - VAT
  - Tổng = Tạm tính + VAT
- Verify finance posted snapshot uses same totals.
- Capture commit hash and deployment timestamp in handoff.

## Rollback trigger
Rollback immediately when:
- total drifts after re-parse,
- VAT/subtotal becomes unstable,
- finance posted amount differs from PO quick view for same record.
