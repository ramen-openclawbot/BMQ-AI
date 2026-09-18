# BMQ-AI Handoff

Cập nhật: 2026-09-05 11:48 +07
Repository: `ramen-openclawbot/BMQ-AI`
Production main: `e007014dfc53a0ca36eb31504d36593b2e523bf1`
Ứng dụng quản trị: https://ai.banhmique.vn
Portal đại lý: https://dathang.banhmique.vn
Portal báo cáo điểm bán: https://baocao.banhmique.vn
Vercel project đúng: `bmq-ai`

> Đây là snapshot an toàn để giao việc cho coding agent. Nhật ký vận hành chi tiết hơn được duy trì trong VNAgent Obsidian; không đưa token, secret, thông tin đăng nhập hoặc connection string vào file này.

## 1. Bắt đầu công việc

1. Đọc `AGENTS.md` trước khi thay đổi code.
2. Fetch `origin/main`, tạo branch/worktree sạch từ đúng SHA production hiện tại.
3. Trình bày plan nhỏ, liệt kê file dự kiến sửa và chờ owner approve trước khi code.
4. Sau khi code và kiểm thử local, tiếp tục chờ approval riêng trước build/commit/push nếu approval trước đó không bao gồm các bước này.
5. Không làm việc hoặc deploy từ worktree có thay đổi không liên quan.
6. Với UI đã live, kiểm tra Git history, deployment và live asset trước khi thay thế; GitHub `main` phải chứa đúng source đã được duyệt.

Các lệnh khởi đầu thường dùng:

```bash
git fetch origin
git worktree add -b <type>/<short-name> /tmp/<worktree-name> origin/main
cd /tmp/<worktree-name>/apps/web
npm install
npm run lint
npm run build
```

Chỉ chạy migration, deploy Edge Function, gửi provider message hoặc sửa dữ liệu production khi scope đó được owner phê duyệt rõ ràng.

## 2. Kiến trúc và vị trí chính

- Frontend React/Vite: `apps/web/`
- Routes: `apps/web/src/components/AppRoutes.tsx`
- Supabase migrations: `apps/web/supabase/migrations/`
- Supabase Edge Functions: `apps/web/supabase/functions/`
- Script kiểm thử/contract: `apps/web/scripts/`
- Deploy production thủ công khi thật sự cần: `cd apps/web && npm run deploy:prod`
- Production web bình thường deploy từ GitHub `main` qua Vercel project `bmq-ai`.

Không dùng Vercel project cũ/nhầm tên `web`.

## 3. Hiện trạng production mới nhất

### 3.1 Duyệt chi — bộ tổng theo đúng phạm vi lọc

PR: https://github.com/ramen-openclawbot/BMQ-AI/pull/50
Merge: `e007014dfc53a0ca36eb31504d36593b2e523bf1`
Review path: `Tài chính → Duyệt chi` / https://ai.banhmique.vn/payment-requests

Đã live:

- Ba KPI `Chờ duyệt`, `Đã duyệt`, `Từ chối` tính từ cùng tập lọc cơ sở với danh sách.
- Phạm vi cơ sở gồm ngày Việt Nam, tìm NCC/mã phiếu/sản phẩm/phiếu nhập/PO và nguồn.
- Tab/card trạng thái chỉ thu hẹp danh sách; không làm mất breakdown ba trạng thái trong KPI.
- Regression fixture `Thien an`, 01/07–04/09, chỉ nguồn nhập kho trả đúng `10.732.500 đ / 1 phiếu` và loại phiếu manual/NCC khác/ngoài kỳ.
- Không đổi database, Edge Function, approval, payment hoặc posting.

Khi sửa tiếp, bắt buộc giữ mobile và desktop dùng cùng một `stats` và cùng định nghĩa bộ lọc cơ sở.

### 3.2 Facebook Page/Messenger — backend live nhưng mặc định tắt

PRs:

- Inbox/backend foundation: https://github.com/ramen-openclawbot/BMQ-AI/pull/47
- Data Deletion validation fix: https://github.com/ramen-openclawbot/BMQ-AI/pull/48
- Secure Page connection: https://github.com/ramen-openclawbot/BMQ-AI/pull/49

Latest relevant merge: `00363db35d6c1c0e492ef7b05fe71d97ad80901e`
Review path: `Marketing&Sale → Quản lý Facebook Page` / https://ai.banhmique.vn/marketing-sales/facebook-page

Đã live:

- Một Page, human-only inbox; UI tách loading, chưa cấu hình, chọn Page, connected-empty, có hội thoại và error.
- OAuth dùng server-mediated Authorization Code flow, signed one-time state, redirect allowlist và Page-bound token handling.
- Browser không nhận Page token, PSID hoặc provider internals.
- Migration `20260904090000` và các Edge Functions Page connect/health/inbox/worker đã deploy.

Trạng thái an toàn hiện tại:

- Messenger core `enabled=false`.
- Email forwarding=false; agent reply=false.
- Chưa cấu hình Page; OAuth/provider secrets chưa được provision.
- Không được bật gửi khách, forwarding, AI reply, Human Agent, retention hoặc backlog nếu chưa có approval riêng.

Trước OAuth thật cần kiểm tra App/Page/Business ownership, Meta permissions/review, Conversation Routing, privacy/Data Deletion URLs và provision secrets trực tiếp vào backend secret storage. Không đưa secret vào chat, Git hoặc browser.

### 3.3 VNAgent owner chat

Các release gần nhất:

- Conversation UI: PR #43 / `8f9e9c6`
- Recent-session picker: PR #46 / `6adf409`

Hiện trạng:

- Global Agent chat chỉ dành cho owner hoặc quyền phù hợp; server vẫn phải tự xác thực role.
- Khi mở chat, người dùng chọn tối đa ba session gần nhất hoặc tạo session mới; không tự resume localStorage cũ.
- Tool rows phải được sanitize; không lộ payload nhạy cảm.
- Kiểm tra tự nhiên bằng câu hỏi read-only; không tạo mutation giả chỉ để test.

### 3.4 Dealer portal

Các luồng live quan trọng:

- Đặt nhanh từ lịch sử: PR #32 / `780fae2`.
- Test account isolation: PR #37 / `8b42286`.
- Dedicated test-order ZBS confirmation: PR #38 / `7f866122`.
- Huỷ đơn cùng ngày qua BMQ Agent: PR #44 / `d02e940`.

Các invariant phải giữ:

- Customer identity, route validation, giá, physical quantity và test identity đều do server xác định.
- Bare quantity mặc định chỉ map vào canonical `BMQ-001`; SKU explicit luôn thắng.
- Order preview read-only cho tới thao tác submit rõ ràng.
- Similar-order guard theo customer + ngày giao + SKU + route đã validate + Đặt/Đổi/Bù; exact retry idempotent.
- Self-cancel chỉ cho đơn `submitted` của đúng session, cùng ngày Việt Nam và bắt buộc xác nhận cuối.
- Test phone `0966998998` là marker do server quản lý; mọi order test phải tách khỏi doanh thu, kho, supplier, operational Zalo, digest và domain idempotency/history thật.
- CTA ZBS phải giữ explicit order intent: `?view=orders&order=<ma_don_hang>`; không tự đoán đơn gần nhất.

### 3.5 Kho Tân Tạo

Review path: `Kho hàng → Kho Tân Tạo` / https://ai.banhmique.vn/warehouse/tan-tao

Hiện trạng:

- Ledger riêng theo location, tách on-hand, reserved, ATP và incoming.
- Supplier sent order chỉ tạo incoming; phiếu nhập được xác nhận mới post tồn.
- Dealer/kiosk order reserve quantity server-derived; confirmed dispatch mới giảm on-hand.
- Huỷ đơn giải phóng reservation; lịch sử/audit giữ nguyên.
- Physical-count UI hỗ trợ exact SKU: `BMQ-001`, `BMQ-002`, `PATE-500G`, `PATE-200G`.
- Không fuzzy-map hoặc gộp hai pack Pate; Pate không có selling price và ẩn khỏi dealer portal.

Số physical count đã ghi nhận ở lần kiểm kê gần nhất:

- BMQ-001: 52
- BMQ-002: 194
- PATE-500G: 165
- PATE-200G: 40

Snapshot tại thời điểm release cho BMQ-001 là on-hand 52, reserved 3.068, ATP -3.016, incoming 2.740. Đây là blocker cần đối soát nguồn reservation/incoming, không phải quyền tự động cancel hoặc rewrite. Không dùng các số snapshot cũ này làm số tồn hiện tại nếu chưa read production lại.

### 3.6 Đặt bánh Tuyết Anh và Kho

Luồng 23:59 Asia/Ho_Chi_Minh đang tự động:

- Gửi một `production_bread_order` tới `BMQ - HKD Tuyết Anh`.
- Gửi một `warehouse_kiosk_bread_dispatch` riêng tới `BMQ - Kho Tân Tạo`.
- `daily_point_digest` thô vẫn tắt.

Hợp đồng hiện hành cho BMQ-001:

- Dealer và kiosk `Đổi/Bù` đều là nhu cầu giao vật lý từ Tuyết Anh.
- Kiosk `returns + waste = Đổi`; `shortage = Bù`.
- `Tổng BMQ giao = ceil20(ĐL Đặt + ĐL Đổi + ĐL Bù + Xe + kiosk Đổi + kiosk Bù)`.
- `Khấu trừ công nợ lò = toàn bộ Đổi + Bù`.
- `Lò tính tiền = Tổng BMQ giao - khấu trừ`.
- Customer revenue chỉ tính `Đặt`, không tính Đổi/Bù.
- VietJet là SKU/phần payable riêng, không cộng vào BMQ total.
- Nếu không có kiosk active/non-test thì `Xe=0`; dealer/VietJet hợp lệ vẫn phải tiếp tục, TEST-KIOSK luôn bị loại.
- Không có giá VND trong warehouse/supplier quantity ledger; kế toán dùng giá invoice thật.
- Sent rows là immutable audit; correction phải là row mới, owner-approved và idempotent.

Không khôi phục quy tắc cũ “Đổi/Bù dùng tồn nội bộ”; quy tắc này đã bị supersede ngày 24/08.

### 3.7 Báo cáo điểm bán và Hotline

Portal nhân viên: https://baocao.banhmique.vn
Quản lý: `Tài chính → Doanh thu điểm bán`

Hiện trạng:

- Hotline là một channel riêng.
- Nhân viên nhập số lượng, `Thực thu` và mã đơn/lý do tại đúng điểm thực xuất.
- Không parse `Ghi chú ca bán` để suy ra Hotline.
- Không nhập trùng Hotline vào Khách lẻ.
- Giá chính thức BMQ-001 là 14.000đ/que; Hotline ledger dùng actual received theo rule riêng, không tự ép về giá Khách lẻ.
- Submitted report chỉ được sửa bằng owner hoặc `finance_revenue can_edit`, qua audited full-report RPC với reason; không direct-update bảng nguồn.
- `daily_point_digest_enabled=false` vẫn phải giữ nếu chưa có quyết định mới.

### 3.8 Material Master, PO, nhập kho và Duyệt chi

Các invariant:

- Canonical root cho NVL/COGS là `sku_cogs_materials`; công thức tham chiếu canonical material ID.
- Supplier product aliases luôn supplier-scoped và exact normalized; OCR/fuzzy chỉ tạo suggestion, không tự link.
- Supplier/name/unit conversion chỉ được ghi sau xác nhận rõ ràng.
- `kg → g = 1000`; chỉ nhân package size khi purchase unit thật sự là Bao/Thùng/Pack và kích thước được chứng minh.
- Kho/Q7 chỉ post từ chứng từ đã ký hoặc receipt được finalize; không đoán số thực nhận.
- Phiếu nhập là trigger duy nhất cho tồn/lô/ledger; nhân viên không phải tạo tiếp side effect thủ công sau finalization.
- Finalize receipt phải atomic qua DB RPC; quantity và payable theo actual received, không theo ordered khi thiếu/dư.
- PO-linked receipt không được tạo Duyệt chi trùng. Nếu linkage dự kiến thiếu, fail closed và xử lý bằng audited repair.
- Invoice là accounting source cuối cho cost reporting; linked payment request là preliminary/audit để tránh double count.
- Không chạy blind `supabase db push`; migration history từng drift. Luôn dry-run, xác định đúng migration, apply có kiểm soát và read back remote history.

## 4. Việc đang mở hoặc cần xác minh tự nhiên

1. **Duyệt chi:** theo dõi lần sử dụng finance tự nhiên để xác nhận KPI theo NCC/ngày/nguồn tiếp tục khớp list.
2. **Facebook Messenger:** chưa activation. Cần provider ownership/configuration và secret provisioning trước OAuth; mọi send/forward/AI vẫn cần approval riêng.
3. **Mầm non May:** flow 597 customer quantity → 600 Tuyết Anh đã live; cần xác minh natural revenue close dùng 597 và surplus chỉ thành tồn sau receipt thực tế.
4. **Kho Tân Tạo:** đối soát reservation/incoming BMQ-001 trước khi tin ATP; không bulk repair nếu chưa có exact owner decision.
5. **GPS attendance:** foundation live nhưng pilot actor mặc định tắt; cần tọa độ được xác nhận và bật từng actor sau approval, payroll vẫn preview-only.
6. **Zalo/worker:** ưu tiên kiểm tra lần gửi tự nhiên; không tạo order/report/message giả chỉ để smoke production.

## 5. Quy tắc dữ liệu và side effect

- Finance là dữ liệu live: thiếu ba số 0 trong VND chỉ được normalize qua rule/audit đã duyệt, không sửa đoán trực tiếp.
- Mọi correction production phải có exact target, rehearsal/guard khi phù hợp, before/after audit và readback.
- Không hard-delete sent notification, approved ledger hoặc lịch sử cần audit.
- Không resend row ở trạng thái `send_committed` hoặc `sent`.
- Provider accepted/queued không đồng nghĩa handset delivered.
- Không gửi email/Zalo/Messenger nếu chưa có approval cho lần gửi hoặc automation đã được phê duyệt từ trước.
- Không tạo fixture production thật nếu rollback-only smoke hoặc test local có thể chứng minh hành vi.
- Không ghi token, API key, password, cookie, OTP, private URL có credential hoặc connection string vào Git, PR, log hay chat.

## 6. Kiểm thử và release gate

Chọn gate đúng scope; tối thiểu:

```bash
cd apps/web
npm run lint
npm run build
git diff --check
```

Ngoài ra:

- Chạy focused Python/Deno/contract tests tương ứng trước full gates.
- Migration: compile/transaction smoke, ACL/RLS checks, rerun/idempotency và remote history readback.
- Edge Function: unit/contract tests, auth/CORS fail-closed, deploy version và downloaded-source parity khi cần.
- UI: mobile + desktop responsive QA, no overflow, permission modes và exact route/custom-domain markers.
- Finance/order side effects: kiểm tra idempotency, duplicate domain, immutable history và no unintended downstream writes.
- Trước merge/deploy, thực hiện independent scoped blocker review nếu thay đổi ảnh hưởng security, finance, kho hoặc external provider.
- Chỉ tuyên bố production live sau khi exact Git SHA, deployment status, custom domain và backend state đều được đọc lại.

## 7. Git hygiene

Không commit các file local/temp không liên quan, ví dụ:

```text
apps/web/supabase/.temp/cli-latest
apps/web/supabase/.temp/linked-project.json
supabase/.temp/
.brv/config.json
.brv/context-tree/_manifest.json
```

Stage file cụ thể thay vì `git add .`. Trước commit:

```bash
git status --short
git diff --check
git diff --cached --stat
git diff --cached
```

## 8. Checklist bàn giao lại

Khi agent hoàn tất một task, báo ngắn gọn:

- Scope đã làm và file đã đổi.
- Test/gate đã chạy cùng kết quả thật.
- Commit/PR/deployment URL và exact SHA nếu có.
- Production readback hoặc lý do chưa thể xác minh.
- Side effect đã hoặc chưa xảy ra.
- Blocker/risk còn lại và exact bước tiếp theo.
- Menu path + direct URL để owner review.

Không được dùng “done/live/verified” nếu chưa có output thực chứng minh tiêu chí tương ứng.
