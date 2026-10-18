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
