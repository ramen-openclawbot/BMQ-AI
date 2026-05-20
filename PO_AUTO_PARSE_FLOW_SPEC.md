# PO Auto Parse 23:59 Flow Spec

## Mục tiêu
Tự động lấy và parse email PO lúc 23:59 hằng ngày theo giờ Việt Nam, không cần approve thủ công. Nhiều email của cùng một khách trong cùng ngày phải được merge vào cùng một PO working thay vì tạo nhiều PO rời.

## Nguyên tắc nghiệp vụ
1. Một khách hàng + một ngày giao = một PO working.
2. Email đầu tiên trong ngày có thể tạo PO ban đầu.
3. Email reply hoặc email bổ sung trong cùng ngày không tạo PO mới, mà cập nhật vào PO working hiện có.
4. User có quyền vẫn được chỉnh sửa PO sau khi hệ thống auto-parse, và lưu thành PO chính thức.
5. Hệ thống phải lưu audit cho từng lần auto-parse và từng lần chỉnh tay.

## Phân loại email
### 1. Snapshot email
Nội dung biểu diễn trạng thái hiện tại của đơn tại thời điểm gửi.
- Dùng khi email là đơn đầy đủ hoặc cập nhật lại toàn bộ.
- Ứng xử: thay thế/đồng bộ dữ liệu theo snapshot.

### 2. Delta email
Nội dung biểu diễn thay đổi trên đơn hiện có.
- Tín hiệu thường gặp: "bổ sung", "đặt thêm", "thêm", "update", "giảm", "bớt", "hủy".
- Ứng xử: cộng/trừ/chỉnh vào PO working hiện có.

## Parse rule chuẩn
Mỗi dòng là một điểm giao hàng / đại lý cấp 2.

Format thường gặp:
- `[Tên điểm] [qty_base]`
- `[Tên điểm] [qty_base] đổi [x]`
- `[Tên điểm] [qty_base] bù [x]`
- `[Tên điểm] [qty_base] bù [x], đổi [y]`
- `[Tên điểm] giảm [x]`
- `[Tên điểm] bớt [x]`

### Công thức
- `qty_base`: số đầu tiên sau tên điểm
- `qty_exchange`: số sau từ khóa `đổi`
- `qty_compensation`: số sau từ khóa `bù`
- `qty_decrease`: số sau `giảm` hoặc `bớt`
- `qty_total = qty_base + qty_exchange + qty_compensation - qty_decrease`

## Merge logic cho PO working
Khóa gom PO:
- `customer_id`
- `delivery_date`

### Với snapshot
- Nếu chưa có PO working: tạo mới.
- Nếu đã có PO working: cập nhật line items theo snapshot mới nhất, nhưng vẫn lưu audit snapshot cũ.

### Với delta
- Nếu đã có line item cùng điểm giao: cộng/trừ vào item hiện có.
- Nếu chưa có line item: thêm line item mới.
- Không tạo PO mới.

## Trạng thái PO đề xuất
- `auto_parsed`
- `user_adjusted`
- `final_saved`

## Audit đề xuất
Mỗi lần xử lý email cần lưu:
- `email_id`
- `customer_id`
- `delivery_date`
- `parse_mode`: snapshot | delta
- `raw_email_excerpt`
- `parsed_items`
- `merge_result`
- `processed_at`
- `processed_by`: system | user_id

## Scheduler đề xuất
### Trigger
- 23:59 mỗi ngày theo timezone `Asia/Saigon`

### Batch flow
1. Lấy email PO trong ngày chưa xử lý.
2. Resolve customer theo email mapping.
3. Resolve delivery_date từ subject/body.
4. Dùng KB parser config của customer để parse.
5. Phân loại email là snapshot hay delta.
6. Merge vào PO working theo `customer_id + delivery_date`.
7. Lưu audit log.
8. Đánh dấu email đã xử lý.

## Quyền chỉnh tay
User có quyền CRM / PO inbox:
- chỉnh line items
- thêm/bớt dòng
- sửa số lượng
- save thành PO chính thức

## Điểm cắm kỹ thuật trong repo hiện tại
### Hiện trạng
- Web app đã có `MiniCrm.tsx` với logic parse UI/manual.
- Chưa thấy scheduler/backend batch job rõ ràng trong `apps/backend`.
- Chưa thấy Supabase Edge Function/scheduled job structure trong repo hiện tại.

### Khuyến nghị cắm flow
#### Option A, nhanh nhất và hợp kiến trúc hiện tại
- Tạo backend management command mới trong `apps/backend/.../management/commands/`
- Ví dụ: `process_daily_sales_po_emails.py`
- Command này thực hiện batch parse + merge.
- Scheduler bên ngoài (cron trên server hoặc platform scheduler) chạy command lúc 23:59 Asia/Saigon.

#### Option B, nếu muốn đẩy hết sang Supabase/serverless
- Tạo Edge Function hoặc scheduled function mới để pull email rows và xử lý merge.
- Nhưng repo hiện tại chưa có structure Supabase functions sẵn, nên sẽ tốn bước dựng nền hơn.

## Khuyến nghị triển khai
Ưu tiên Option A:
1. Viết management command chạy batch.
2. Tái sử dụng parser rules đã có ở Mini CRM nhưng chuyển về shared logic/backend-safe.
3. Sau khi batch ổn mới nối scheduler 23:59.
4. Sau cùng mới tinh chỉnh UI trạng thái `auto_parsed / user_adjusted / final_saved`.

## Revenue guardrail
- PO automation là lớp **operational/order evidence**; không phải nguồn chốt doanh thu kế toán.
- Cuối tháng đối soát với trusted ledger/CSV; ledger là accounting source of truth.
- Parsed PO/email output must carry evidence status and reconciliation notes before any production revenue posting.

## Customer rules locked 2026-05-09

Trial-period rule outputs/config live in `apps/web/supabase/po-automation-rules/`. Do not move these rules into app KB/customer CRM until the trial is reviewed.

### Kingfoodmart / KFM XLSX with PDF and cancellation fallback
- Sender: `dathang@kingfoodmart.com`.
- Primary accepted input: `Export-PO-Data.xlsx`; parse and validate XLSX totals before staging PO evidence.
- PDF-only fallback: if an email has PDF but no valid `Export-PO-Data.xlsx`, keep status `pdf_only_needs_review`; do not auto-post revenue.
- Cancellation fallback: cancellation subjects/bodies become `cancel_signal`; do not create a normal pending revenue draft.
- Accounting guardrail: KFM PO parse is operational evidence. Trusted revenue ledger remains accounting truth.

### Thúy / direct company dealer aggregation text
- Sender: `mi@bmq.vn`.
- User-confirmed channel scope: this is **kênh đại lý trực tiếp của công ty, không qua NPP**. Do not map these lines under Tony/Anh Thanh or any other NPP parent.
- Subject pattern: `Đặt bánh đại lý D.M` or `Đặt bánh đại lý D.M.YYYY`; subject date is the delivery/service date. If the subject omits year, use the email received year.
- Body format is numbered or unnumbered route/customer lines, for example:
  - `1. Bach Đằng 80`
  - `2. Thích Quảng Đức 140`
  - `3. Phạm Phú Thứ 160 đổi 6`
  - `4. Lạc Long Quân 40 đổi 6`
- Parse rule:
  1. Strip quoted replies/signatures before parsing.
  2. Ignore the list ordinal (`1.`, `2.`, ...); it is not the customer name.
  3. Match `route/customer name + ordered_qty` with optional `đổi N` and optional `bù N` / `bu N`.
  4. Normalize route aliases into direct-dealer CRM customers, for example Bạch Đằng, Thích Quảng Đức, Phạm Phú Thứ, Lạc Long Quân, Lê Văn Lương, Hồng Lạc, Tây Hòa, Bình Chánh, Nguyễn Sơn, Nguyễn Trãi, Nguyễn Trọng Tuyển, Phú Hòa, Nguyễn Văn Đậu, Võ Văn Ngân, Long An, Kinh Dương Vương, Tân Hòa Đông, HAGL, Vũng Tàu, Cà Mau, Lê Đại Hành, Phú Mỹ, PJ's Coffee, Cần Thơ, Gò Dầu.
  5. Preserve every raw line, message id, subject, timestamp, service date, parsed route/customer, customer id if matched, quantities, and confidence.
- Quantity/revenue rule:
  - `ordered_qty` / first quantity after the route is revenue quantity.
  - `đổi` and `bù` are non-revenue operational quantities; preserve them as `exchange_qty` and `makeup_qty`.
  - `physical_qty = ordered_qty + exchange_qty + makeup_qty`.
  - Observed T4 working price is `6,500 VND/unit`; gross candidate amount is `ordered_qty * 6,500`.
- Double-count guardrails:
  - Treat Thúy lines as direct company dealer evidence, not NPP child evidence.
  - Do not also count the same `(service_date, route/customer, product)` from Tony/Dam/other alternate trace emails unless manually approved.
  - Email parser output remains evidence/manual revenue candidate; production revenue remains trusted ledger / Quản lý doanh thu.
  - Scheduler should keep status `line_level_manual_revenue_ready` in review/manual path, not auto-post it as final revenue.
- April/T4 2026 analysis:
  - Parsed April Thúy aggregation evidence: `25` messages, `250` counted parsed lines, `25` service dates.
  - Candidate revenue evidence: `27,553` ordered units / `179,094,500 VND` at `6,500 VND/unit`.
  - This was previously part of “Other agency” preliminary coverage (`179,094,500 VND` vs trusted other-agency slice `220,370,000 VND`, `81.3%` coverage); final accounting still follows trusted ledger.
- Missing-day rule: if Thúy email evidence is absent for a day but the trusted ledger has approved rows, accept that day as ledger-only accounting truth rather than parser failure.
- Artifacts: `/tmp/bmq_revenue_t4_email_lines_v2_channel_rules.csv`, `/tmp/bmq_revenue_t4_email_summary_v2_channel_rules.md`.

### Tony Thanh / Anh Thanh NPP text evidence
- Sender: `tonythanh@hotmail.com`.
- Parent customer: `Đại lý cấp 1 - Anh Thanh`; route/child customers are evidence aliases, not separate revenue parent customers.
- Date rule: `ledger_date = po_order_date + 1 day`.
- Quantity rule: `ordered_qty` is revenue quantity; `đổi`/`bù` are operational/non-revenue; `physical_qty = ordered_qty + exchange_qty + makeup_qty`.
- Reply/update guardrail: `cập nhật`/`bổ sung`/reply emails require reconciliation semantics; keep raw lines and review labels instead of silently auto-merging ambiguous content.
- Accounting guardrail: PO/email remains evidence; trusted ledger/CSV remains accounting truth.

### Vietjet cumulative XLSX evidence
- Senders: `vietjetair.com`.
- XLSX attachments are cumulative schedules; do not sum every attachment.
- Parse only `TỔNG CỘNG THEO NGÀY` rows, use the previous detail row Excel serial date as `service_date`, product `40000294` / `Bánh mì`, quantity one-based column `19`, and unit price from CRM/price list (observed T4 `25,000 VND`).
- Monthly preview/reconciliation must dedupe by `(service_date, product_code)` and keep the latest Gmail/message timestamp.
- Accounting guardrail: cumulative XLSX output is evidence/review data until reconciled to trusted ledger.

### Coopmart / Saigon Co-op manual trusted-ledger guardrail
- Sender: `mai-hnp@saigonco-op.com.vn`.
- Current decision: do not run Coopmart parse automation for revenue; files are mostly empty templates and high-value Coop revenue is primarily trusted-ledger/manual.
- Parser should mark these rows as manual/trusted-ledger-only guardrail or review, not auto-post PO revenue.

### Dam/XESG / inventory-aware text evidence
- Sender: `damvovan33@gmail.com`.
- Subject pattern: `Đặt bánh điểm bán D/M/YYYY`; service date is direct from subject, with no +1 day shift.
- Parsed route quantities are `sent_qty` / order evidence, not final `sold_qty`.
- Trusted ledger provides accounting `sold_qty` and revenue when sent-vs-sold deltas exist.
- T4 inventory note: preserve the `662 bánh` inventory/unsold delta in metadata/docs so automation does not auto-post sent quantity as sold revenue.
