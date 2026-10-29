# BMQ Merchant Agent — GĐ1

Dịch vụ Python chạy merchant agent của Anthropic trên Claude Agent SDK, nối trực
tiếp dữ liệu BMQ qua Supabase. Server chỉ chạy trên localhost và chỉ cho tài
khoản có role `owner` của BMQ.

## Chạy

```bash
cd services/merchant-agent
/opt/homebrew/bin/python3.11 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env   # nếu cần, rồi export các biến
set -a; source .env; set +a
.venv/bin/python -m bmq_merchant.server
```

Mặc định server ở `http://127.0.0.1:8767`. Kiểm tra bằng
`curl http://127.0.0.1:8767/health`.

## Biến môi trường

| Biến | Bắt buộc | Mặc định |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Có | — |
| `SUPABASE_URL` | Không | `https://cxntbdvfsikwmitapony.supabase.co` |
| `SUPABASE_ANON_KEY` | Không | dùng service key nếu trống |
| `MERCHANT_MODEL` | Không | `claude-haiku-5-5` |
| `MERCHANT_ANALYSIS_MODEL` | Không | cùng model chính |
| `HOST` | Không | `127.0.0.1` |
| `PORT` | Không | `8767` |
| `ALLOWED_ORIGIN` | Không | `https://ai.banhmique.vn` |
| `MERCHANT_SKILLS_DIR` | Không | thư mục skills của reference repo |

**Quan trọng:** phải bỏ `ANTHROPIC_API_KEY` khỏi môi trường. SDK sẽ dùng phiên
đăng nhập Claude Code đã xác thực trên máy. Khi khởi động, server tự xóa biến
này nếu có và ghi warning, nhưng không bao giờ in giá trị khóa.

## API

- `GET /health`
- `POST /v1/chat` — body `{session_id?, message, page?, attachments?}`, `Authorization: Bearer <Supabase JWT>`
- `GET /v1/changes`
- `POST /v1/changes/{change_id}/approve` — body tuỳ chọn `{category_code?}`
- `POST /v1/changes/{change_id}/discard`

`attachments` chỉ nhận tối đa 1 ảnh:
`{kind:"image", mime_type:"image/jpeg"|"image/png"|"image/webp", data_base64:"..."}`.
Ảnh giải mã tối đa 6 MB; `message` được phép rỗng khi có ảnh.

Lỗi trả về `{error, code}` bằng tiếng Việt, không chứa khóa hay chi tiết nội bộ.

## Duyệt chi từ bankslip trong chatbox

Khi owner gửi 1 ảnh bankslip, `POST /v1/chat` chạy luồng đọc bankslip
**không gọi model** (giống shortcut snapshot doanh thu):

1. Gọi edge function `payment-unc-approve` mode `extract` bằng **token của
   owner** (không bao giờ dùng service key) để lấy OCR, `file_sha256` và
   `storage_path`.
2. Chặn trùng: nếu `payment_unc_evidence` đã có cùng `file_sha256` hoặc cùng
   reference đã chuẩn hoá, trả thẻ `already_recorded` và không stage gì. Nếu đã
   có thẻ `bank_slip_payment` staged/approved cùng file thì trả lại thẻ đó.
3. Học người nhận từ lịch sử UNC (cùng số tài khoản) trước, sau đó mới so tên
   nhà cung cấp (bỏ dấu, bỏ tiền tố công ty). Không khớp thì chỉ trả lời hướng
   dẫn tạo phiếu trong Duyệt chi, không stage.
4. Nếu có phiếu pending/unpaid cùng nhà cung cấp và còn lại đúng số tiền thì
   đề xuất `pay_existing` (phiếu cũ nhất); ngược lại đề xuất `create_new` với
   tiêu đề `<nội dung chuyển khoản> (bankslip dd/mm)`.
5. Chọn loại chi phí: lịch sử 6 phiếu gần nhất của nhà cung cấp (ưu tiên
   `approved`, bỏ `OPEX_GENERAL`/`UNMAPPED_REVIEW`); chỉ khi không có lịch sử
   mới gọi `cost-classify-sushi` mode `suggest` bằng token owner. Jev không ghi
   dữ liệu.
6. Stage đúng **một** dòng `merchant_staged_changes` kind `bank_slip_payment` và
   trả text + khối ui `{type:"bank_slip_payment", payload:{change_id,
   status:"staged", ...}}`.

**Chưa ghi gì vào `payment_requests`, `payments`, `payment_unc_evidence` hay
`cost_line_classifications` trước khi owner bấm Duyệt.** Hủy thẻ cũng không ghi
gì.

Khi Duyệt (có thể gửi `category_code` để đè loại chi phí đề xuất):

1. Kiểm tra loại chi phí còn hiệu lực, đánh dấu change `approved`.
2. RPC `merchant_prepare_bank_slip_request` tạo hoặc tái sử dụng đúng một phiếu
   pending (`prepared_request_id` giữ idempotency). Phiếu mới dùng
   `payment_method = bank_transfer`, `requires_receipt = false`, ngày tạo nằm
   trong tháng chuyển tiền để vào đúng kỳ của báo cáo chi phí.
3. Gọi `payment-unc-approve` mode `confirm` bằng token owner với
   `idempotency_key = unc:<file_sha256>` và bankslip làm chứng từ UNC. Đây là
   đường duyệt chi hiện có, nên trigger Zalo duyệt chi vẫn chạy như các phiếu
   khác.
4. RPC `merchant_finalize_bank_slip_payment` ghi loại chi phí đã duyệt
   (`manual_override`, `review_status = approved`, audit log) và đánh dấu change
   `applied`.

Nếu confirm lỗi, change thành `failed` với thông báo tiếng Việt và phiếu đã
chuẩn bị vẫn pending; duyệt lại sẽ dùng lại `prepared_request_id` và cùng
idempotency key. Nếu timeout/chưa rõ kết quả, server đọc lại trạng thái phiếu
trước khi quyết định, không gọi confirm mù lần hai.

## Quyền và ghi dữ liệu

- Xác thực: gọi Supabase Auth `/auth/v1/user`, sau đó RPC `has_role(uid, 'owner')`.
- Đọc: revenue ledger, dealer orders, SKU, giá đại lý.
- Ghi: mọi thay đổi chỉ được ghi vào `public.merchant_staged_changes` (staged).
- Áp dụng: chỉ sau khi owner bấm duyệt; kind `price` gọi
  `merchant_apply_price_change`, kind `promotion`/`campaign` gọi
  `merchant_apply_announcement`. Kind `listing`/`inventory` chưa hỗ trợ ở GĐ1.
- SQL phân tích chạy qua RPC `merchant_analysis_query` với role
  `merchant_analyst`, transaction read-only, timeout 5 giây và tối đa 1000 dòng.

## Snapshot doanh thu

Chủ doanh nghiệp gửi đúng một trong các câu lệnh sau trong chat Dashboard:

- `Snapshot doanh thu`
- `Chụp nhanh doanh thu`
- `Revenue snapshot`

Endpoint `POST /v1/chat` nhận diện lệnh này và trả ngay khối ui
`revenue_snapshot` version 1 kèm text tóm tắt tiếng Việt, **không gọi model**.
Câu dài hơn như `snapshot doanh thu tháng trước` vẫn đi luồng chat bình thường.

Model cũng có tool MCP `bmq_revenue_snapshot` dùng chung engine
`bmq_merchant/revenue_snapshot.py`; tool đẩy cùng khối ui vào `pending_ui` và
trả text + JSON payload.

Cửa sổ so sánh:

- Kỳ hiện tại: ngày 01 tháng này đến hôm nay (MTD).
- Kỳ trước: ngày 01 tháng trước đến `min(ngày hôm nay, ngày cuối tháng trước)`.
  Ví dụ 31/03 so với 01/02..28/02; 15/01 so với 01/12..15/12.

Nguồn dữ liệu đọc qua `SupabaseClient` hiện có (mỗi nguồn lỗi riêng, không biến
lỗi thành 0; tối đa 20.000 dòng/nguồn):

- `revenue_ledger_lines` — dòng `approval_status = approved`, source document
  `controlled`/`trusted`; gộp theo nhóm kênh đại lý, B2B/siêu thị, xe bán lẻ,
  bánh ngọt, khác.
- `kiosk_report_locations` + `kiosk_daily_reports` — báo cáo điểm bán đã nộp,
  doanh thu theo kênh giao hàng, điểm thiếu báo cáo hôm qua.
- `dealer_orders` — đơn không test, không huỷ, quy đổi `submitted_at` sang giờ
  Việt Nam.
- `revenue_auto_daily_parse_logs` — nhật ký job 23:59 trong 7 ngày gần nhất.

Ngưỡng cờ (hằng số ở đầu module để chỉnh và test):

| Cờ | Ngưỡng | Mức |
| --- | --- | --- |
| `channel_drop` | cùng kỳ ≥ 5.000.000 và delta ≤ -30% | high nếu ≤ -50%, còn lại medium |
| `channel_spike` | delta ≥ 50% và kỳ này ≥ 5.000.000 | medium |
| `channel_silent` | im lặng ≥ 2 ngày và tháng trước có số ≥ nửa số ngày | high |
| `kiosk_missing_reports` | còn điểm chưa nộp báo cáo hôm qua | medium; high nếu ≥ nửa số điểm |
| `kiosk_channel_drop` | kênh giao hàng cùng kỳ ≥ 2.000.000 và delta ≤ -30% | medium |
| `auto_job_failed` | có ngày failed hoặc started quá 2 giờ | high |
| `auto_job_missing` | ngày trong 7 ngày qua không có dòng nhật ký | medium |
| `dealer_orders_zero` | 0 đơn trong 2 ngày và tháng trước ≥ 1 đơn/ngày | high |
| `data_source_error` | một nguồn đọc lỗi | info |

Câu caveat trong payload: `Số đã kiểm soát theo sổ doanh thu, chưa phải số kiểm toán.`

Chạy test cục bộ bằng venv của worktree hiện tại:

```bash
cd services/merchant-agent
"/Volumes/Samsung SSD 9100 PRO 1TB Media/VNAgent/worktrees/bmq-ai-merchant-agent-20261018/services/merchant-agent/.venv/bin/python" -m pytest -q
```

## Migration

File `apps/web/supabase/migrations/20261102180000_merchant_agent.sql` đã được
viết nhưng **chưa được áp dụng**. Không tự chạy migration này khi deploy GĐ1.
Luồng bankslip dùng thêm
`apps/web/supabase/migrations/20261103450000_merchant_bank_slip_payment.sql`
(cũng chưa được áp dụng bởi coding agent).

## Kiểm thử

```bash
cd services/merchant-agent
.venv/bin/pytest -q
```

Test dùng `respx` để chặn toàn bộ HTTP; không gọi Supabase, Claude hay mạng thật,
và không cần `SUPABASE_SERVICE_ROLE_KEY` hay phiên đăng nhập Claude.
