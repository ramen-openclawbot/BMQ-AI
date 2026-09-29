# BMQ-AI Handoff

Cập nhật: 2026-08-06 11:40 +07
Repo: `/Users/c.o.t.e/.openclaw/workspace-BMQ-AI`  
Branch: `main`  
Latest pushed commit trước bản cập nhật handoff: `caceb84 feat(kiosk): add manual chili usage`
Production: `https://ai.banhmique.vn`  
Vercel project: `bmq-ai`

## Theo dõi: OTP Zalo ZNS relay (cập nhật 2026-09-29 23:05 +07)

**Trạng thái:** đang chạy tạm trên máy ảo `ubuntu-mini` (Multipass) trên Mac mini, chờ thuê máy chủ cloud có IP tĩnh mới rồi chuyển.

**Đường gửi OTP hiện tại**

- Edge Functions `report-auth-start` (baocao.banhmique.vn) và `dealer-auth-start` gọi `sendDealerOtpZns` trong `apps/web/supabase/functions/_shared/dealer.ts`.
- Khi Supabase có secrets `DEALER_OTP_RELAY_URL` và `DEALER_OTP_RELAY_SECRET`, yêu cầu đi qua relay (ký HMAC, header `X-BMQ-Relay-Timestamp` / `X-BMQ-Relay-Signature`): `https://otp-relay.vnagent.ai/send` → Cloudflare Tunnel `bmq-otp-relay` → container `bmq-otp-relay-relay-1` và `bmq-otp-relay-cloudflared-1` tại `/opt/bmq-otp-relay` trong VM `ubuntu-mini` → VietGuys `https://api-v2.vietguys.biz:4438/zalo/v4/send`.
- Relay tồn tại vì VietGuys chỉ nhận yêu cầu từ IP whitelist. IP hiện tại là `14.161.32.215`, tức đường internet tại chỗ đặt Mac mini (VM và Mac dùng chung). Source relay: `ops/otp-relay/`.
- VM `ubuntu-mini` còn chạy Hermes gateway, `supabase_db` (Docker) và `vnagent-obsidian-sync`. Cấu hình 2 CPU, 1,9 GB RAM; process qemu trên Mac chiếm khoảng 3,3 GB RAM; đĩa VM nằm trên ổ 1 TB.

**Sự cố 2026-09-29**

- 16:05–22:43: 33 OTP báo cáo và 7 OTP đại lý thất bại với lỗi `VietGuys ZBS Mobile OTP send failed: provider returned non-JSON response (<!doctype html> …)`, tức trang lỗi của Cloudflare.
- Nguyên nhân: VM `ubuntu-mini` bị tắt sáng 29/09, nên tunnel `bmq-otp-relay` còn 0 kết nối.
- Khắc phục 22:45: `multipass start ubuntu-mini`. Tunnel có lại 4 kết nối, `otp-relay.vnagent.ai` trả JSON. OTP báo cáo lúc 22:46:51 `verified`, OTP đại lý lúc 22:46:24 `sent`.
- Không có cảnh báo tự động, nên lỗi kéo dài khoảng 7 giờ đến khi chủ phát hiện.

**Quy tắc tạm thời**

- Không tắt hoặc suspend `ubuntu-mini` khi relay chưa chuyển đi. Tắt VM là mất OTP đăng nhập cho cả trang báo cáo lẫn đại lý.
- Kiểm tra nhanh:
  - `cloudflared tunnel list`: tunnel `bmq-otp-relay` phải có kết nối.
  - `curl -X POST https://otp-relay.vnagent.ai/`: phải trả JSON (`404 not_found`), không phải HTML.
  - Bảng `kiosk_report_otp_challenges` và `dealer_otp_challenges`: xem cột `send_status` và `send_error`.

**Việc tiếp theo** (anh Tâm chuẩn bị máy và IP; agent triển khai)

1. Anh Tâm thuê một máy chủ cloud nhỏ (Google Cloud hoặc nhà cung cấp trong nước) kèm IP tĩnh (reserved), và nhờ VietGuys whitelist IP mới. Hỏi thêm VietGuys có cho gọi API không cần whitelist không; nếu có thì bỏ hẳn relay.
2. Triển khai relay lên máy mới theo `ops/otp-relay/README.md` (Docker Compose, dùng Caddy hoặc Cloudflare Tunnel). File `.env` có `RELAY_SECRET` giống secret trên Supabase.
3. Đổi Supabase secret `DEALER_OTP_RELAY_URL` sang relay mới, thử một OTP thật, rồi kiểm tra `send_status`.
4. Giữ relay tại văn phòng làm dự phòng. Sửa `sendDealerOtpZns` để thử relay chính trước; chỉ chuyển sang relay dự phòng khi lỗi đã xác định (trả về không phải JSON, hoặc không kết nối được), để không gửi trùng OTP khi chưa rõ kết quả.
5. Thêm cảnh báo: khi OTP lỗi liên tiếp (ví dụ từ 3 lỗi trong 15 phút) hoặc relay không trả JSON thì báo Discord cho anh Tâm.
6. Khi relay mới đã ổn định, cân nhắc bỏ relay khỏi `ubuntu-mini` hoặc giảm RAM của VM.

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
