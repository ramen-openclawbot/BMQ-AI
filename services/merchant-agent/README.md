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
- `POST /v1/chat` — body `{session_id?, message, page?}`, `Authorization: Bearer <Supabase JWT>`
- `GET /v1/changes`
- `POST /v1/changes/{change_id}/approve`
- `POST /v1/changes/{change_id}/discard`

Lỗi trả về `{error, code}` bằng tiếng Việt, không chứa khóa hay chi tiết nội bộ.

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

## Kiểm thử

```bash
cd services/merchant-agent
.venv/bin/pytest -q
```

Test dùng `respx` để chặn toàn bộ HTTP; không gọi Supabase, Claude hay mạng thật,
và không cần `SUPABASE_SERVICE_ROLE_KEY` hay phiên đăng nhập Claude.
