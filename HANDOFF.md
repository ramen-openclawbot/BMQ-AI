# BMQ-AI Handoff

Cập nhật: 2026-08-06 11:40 +07
Repo: `/Users/c.o.t.e/.openclaw/workspace-BMQ-AI`  
Branch: `main`  
Latest pushed commit trước bản cập nhật handoff: `caceb84 feat(kiosk): add manual chili usage`
Production: `https://ai.banhmique.vn`  
Vercel project: `bmq-ai`

## Trạng thái mới nhất (authoritative)

- Production migration `20260805170000_dealer_warehouse_daily_digest.sql` đã được áp dụng; `supabase migration list --linked` ngày 2026-08-06 hiển thị local/remote cùng version `20260805170000`.
- Supabase Edge Function `dealer-warehouse-notify` đang `ACTIVE`, version 4 trên project `cxntbdvfsikwmitapony`.
- Các ghi chú lịch sử bên dưới nói migration này chưa áp dụng đã hết hiệu lực; luôn ưu tiên trạng thái mới nhất trong mục này.

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

## QUYỀN THỰC THI VÀ GIT

- Tôi cho phép bạn triển khai, chạy test/build, commit và push `main` cho đúng nhiệm vụ tôi giao sau khi đã xác minh đầy đủ; không cần hỏi lại một câu approve máy móc nếu phạm vi đã rõ.
- Checkout hiện tại có thể đang chậm hơn `origin/main` và chứa thay đổi local của agent khác. Tuyệt đối không reset, stash, checkout, sửa, stage hoặc commit các file local chưa rõ chủ sở hữu.
- Trước khi làm, chạy `git fetch origin` và kiểm tra `git status`.
- Nếu checkout chính dirty hoặc lệch `origin/main`, hãy tạo clean worktree mới từ đúng `origin/main` và chỉ làm nhiệm vụ trong worktree đó.
- Không force-push.
- Trước khi push, fetch lại và xác nhận push là fast-forward.
- Chỉ stage đúng file thuộc phạm vi nhiệm vụ; kiểm tra staged diff và secret scan.
- Sau push, xác minh commit trên `origin/main`, Vercel/Supabase tương ứng và đúng custom production domain.
- Handoff cũ có các ghi chú lịch sử nói migration `20260805170000` chưa áp dụng. Trạng thái mới nhất ở đầu handoff là authoritative: migration này đã được áp dụng và `dealer-warehouse-notify` đang `ACTIVE` v4.
