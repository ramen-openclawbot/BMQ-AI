# BMQ-AI Handoff

Cập nhật: 2026-05-28 06:35 +07  
Repo: `/Users/c.o.t.e/.openclaw/workspace-BMQ-AI`  
Branch: `main`  
Latest pushed commit: `ec78263 Improve payment request delete affordance`  
Production: `https://ai.banhmique.vn`  
Vercel project: `bmq-ai`

## Current Status

Production web deploys from GitHub `origin/main` to Vercel project `bmq-ai`. The accidental Vercel project `web` was deleted after approval and must not be used.

Manual production deploy command, only when GitHub auto-sync is not enough:

```bash
cd apps/web
npm run deploy:prod
```

The script resolves back to repo root and runs Vercel against `bmq-ai`.

## Recent Completed Work

### OCR cost classification

Commit: `200ee82 Add OCR cost classification workflow`

- Added OCR standard cost metadata on PR/invoice items.
- Added approved alias mappings and canonical reporting.
- Deployed Supabase Edge Functions `scan-invoice` and `create-invoice-from-pr`.
- Applied only the intended OCR migrations to production because migration history had drift.
- Reporting now uses invoice-final canonical data and avoids PR + invoice double counting.

### Payment allocations

Commit: `03170d3 Add payment allocation tracking`

- Added `payments` and `payment_allocations`.
- Extended payment status with `partial` and `overpaid`.
- Bulk paid flow creates payment allocations across selected PRs.
- Detail dialog can record partial payments.
- Production repair verified: 456 payments, 467 allocations, 0 paid PR without allocation.

### Vercel project safety

Commit: `0d16b76 Fix BMQ AI Vercel deploy target`

- Fixed ignored local `.vercel` link from wrong project `web` to correct project `bmq-ai`.
- Added `scripts/deploy-bmq-ai-vercel.sh`.
- Added `apps/web` script `npm run deploy:prod`.
- Vercel project `web` was later deleted after explicit approval.

### Duyệt chi UI

Recent commits:

```text
621781f Redesign payment requests page
f95579e Fix payment requests date filtering
e8a55c1 Refine payment request row interactions
ec78263 Improve payment request delete affordance
```

Current behavior:

- Header/sidebar unchanged.
- Content redesigned with date range, status/search filters, KPI cards, compact table, pagination.
- Date range uses real native date inputs.
- KPI widgets and table use the same date-filtered source.
- Pagination has spacing so the chatbox icon does not cover next/previous buttons.
- Clicking a table row opens payment request detail.
- Checkbox/delete controls stop row-click propagation.
- Old eye/view icon and duplicate pencil detail button were removed.
- Dark mode uses semantic theme tokens instead of bright hard-coded neon colors.
- Delete trash icon uses subtle destructive red styling and thickens on hover.

Primary files:

```text
apps/web/src/pages/PaymentRequests.tsx
apps/web/src/hooks/usePaymentRequests.ts
apps/web/src/components/dialogs/PaymentRequestDetailsDialog.tsx
```

## Verification

Latest Duyệt chi changes passed:

```bash
cd apps/web
npx tsc --noEmit --pretty false
npx eslint src/pages/PaymentRequests.tsx --max-warnings=0
git diff --check
npm run build
```

Build has existing Vite warnings for chunk size / stale Browserslist data only.

## Operational Rules

- Do not run blind `supabase db push`; production migration history has had drift. Use transaction dry-run/selective apply for new migrations.
- Do not commit unrelated local files:
  - `apps/web/supabase/.temp/cli-latest`
  - `.brv/config.json`
  - `.brv/context-tree/_manifest.json`
  - `apps/web/supabase/.temp/linked-project.json`
- For web release, prefer commit + push to `main`; Vercel auto-syncs from GitHub.
- Keep UI edits scoped; do not touch header/sidebar unless explicitly requested.

## Next Actions

1. Wait for Vercel to finish auto-syncing commit `ec78263`.
2. Verify live `https://ai.banhmique.vn` → **Duyệt chi**:
   - row click opens detail;
   - checkbox does not open detail;
   - trash icon is red and visible on hover in dark mode;
   - KPI cards filter by date;
   - pagination is clear of chat widget.
3. If more UI screenshots arrive, patch `PaymentRequests.tsx`, run the same checks, then commit/push.

