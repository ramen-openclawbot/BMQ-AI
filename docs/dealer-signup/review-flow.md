# Duyệt đại lý mới — luồng máy chủ (review flow)

Tài liệu này mô tả phần máy chủ của luồng duyệt đại lý mới. Đã áp migration
và deploy lên production ngày 03/11/2026 (giao diện: tab "Đại lý mới" trong CRM,
trang `/dai-ly-moi/bank-slip`, dải nhắc trên trang đặt hàng). Test dùng email giả.

## 1. Trạng thái hồ sơ (`dealer_signup_applications.status`)

| Trạng thái | Ý nghĩa |
| --- | --- |
| `rejected_too_close` | Hồ sơ quá gần đại lý hiện có (giữ nguyên hành vi cũ). |
| `manual_review` | Cần nhân sự CRM xét tay. |
| `contract_sent` | Trạng thái cũ của hồ sơ eligible đã gửi hợp đồng (vẫn được chấp nhận khi duyệt tay). |
| `email_failed` | Gửi email/HĐ lỗi; vẫn có thể duyệt tay hoặc gửi lại. |
| `approved_waiting_slip` | Đã duyệt, đã tạo khách CRM, đang chờ bank slip. |
| `active` | Khách đã upload bank slip hợp lệ, được đặt bánh. |
| `rejected_manual` | Nhân sự CRM từ chối; bắt buộc có lý do. |

`mini_crm_customers.dealer_onboarding_status`:

| Giá trị | Ý nghĩa |
| --- | --- |
| `waiting_slip` | Đã duyệt nhưng chưa có bank slip. Đăng nhập OTP được, **bị chặn đặt bánh ở máy chủ**. |
| `active` | Đã có bank slip; đặt bánh bình thường. |
| `NULL` | Khách cũ / khách thường; giữ nguyên hành vi trước đây. |

`order_locked` **không** được dùng cho khách chờ bank slip vì khóa này chặn cả
đăng nhập. Khóa công nợ hiện tại vẫn hoạt động độc lập.

## 2. Duyệt tự động (eligible)

1. `dealer-signup-submit` tạo hồ sơ, tạo PDF hợp đồng từ mẫu.
2. Gọi `dealer_signup_approve` với `p_mode='auto'`, `p_reviewer=NULL`:
   - tạo đúng một `mini_crm_customers` với `is_active=true`,
     `order_locked=false`, `dealer_onboarding_status='waiting_slip'`,
     vị trí từ hồ sơ, `location_source='dealer_signup'`;
   - tạo `dealer_customer_contacts` với SĐT đăng ký (định dạng `84...`), nhờ đó
     khách đăng nhập OTP qua luồng `dealer-auth-start` / `dealer-auth-verify`
     hiện có;
   - chuyển hồ sơ sang `approved_waiting_slip`.
3. Lưu chính PDF đó vào bucket riêng tư `dealer-signup-docs` tại
   `<application_id>/contract-draft.pdf` và gọi `dealer_signup_set_contract_draft`.
4. Gửi **một** thư hợp đồng cho khách (BMQ nhận bản sao `cc`) kèm PDF và đoạn
   hướng dẫn đăng nhập + link upload bank slip.
5. Nếu `dealer_signup_approve` lỗi (ví dụ SĐT đã thuộc khách khác — mã `23505`):
   không gửi hợp đồng, chuyển hồ sơ về `manual_review`,
   `last_error_code='duplicate_phone'` và gửi thư xét tay cho BMQ + thư đã nhận
   hồ sơ cho khách.
6. Nếu lưu PDF lỗi: hồ sơ vẫn `approved_waiting_slip`, ghi `last_error_code`,
   không gửi hợp đồng. Dùng `regenerate_contract` + `resend_slip_link` để xử lý.

## 3. Duyệt tay

`dealer-signup-review` (JWT, kiểm tra quyền ở máy chủ):

- `approve`: owner hoặc `crm:edit` gọi `dealer_signup_approve` với
  `p_mode='manual'`, reviewer là user hiện tại; sau đó tạo PDF, lưu
  `contract-draft.pdf`, gọi `dealer_signup_set_contract_draft`, gửi thư chúc
  mừng kèm link bank slip. Lỗi PDF hoặc email **không hoàn tác** việc duyệt:
  trả `contract_ready` / `email_sent` và ghi `last_error_code`.
- `regenerate_contract`: owner / `crm:edit`, tạo lại PDF cho hồ sơ đã duyệt.
- `resend_slip_link`: owner / `crm:edit`, xoay token mới (14 ngày) và gửi lại
  thư chúc mừng.
- `reject`: owner / `crm:edit`, bắt buộc lý do 1–500 ký tự, gửi thư từ chối.
  Chỉ áp dụng cho hồ sơ chưa duyệt.
- `download` (`contract_draft` | `contract_signed` | `slip`): owner,
  `crm:view`, `crm:edit` hoặc `accounting:edit`; trả signed URL 5 phút.
- `upload_signed_contract` (multipart): owner, `crm:edit` hoặc
  `accounting:edit`; lưu `contract-signed-<timestamp>.<ext>`.

Duyệt lại cùng một hồ sơ trả kết quả cũ (`already_approved=true`), không tạo
thêm khách, PDF hay thư.

## 4. Bank slip

`dealer-signup-slip` là function công khai (`verify_jwt=false`):

- `GET ?token=...`: trả `valid` / `expired` / `used` / `invalid`, tên hộ kinh
  doanh và mã hồ sơ. Không trả CCCD, SĐT hay đường dẫn kho. Sau khi kích hoạt,
  token bị xóa khỏi hồ sơ nên lần kiểm tra kế tiếp trả `invalid`; cả `used` và
  `invalid` đều bị chặn upload.
- `POST` multipart: xác thực bằng token trong link **hoặc** phiên đăng nhập
  dealer (`x-dealer-session`). Với phiên dealer, chỉ hồ sơ
  `approved_waiting_slip` của chính `crm_customer_id` đó được nhận.
- File hợp lệ: JPEG/PNG/WebP/PDF, kiểm tra bằng magic bytes, tối đa 10 MB.
- Lưu `slip-<timestamp>.<ext>`, gọi `dealer_signup_activate`:
  - `mini_crm_customers.dealer_onboarding_status='active'`;
  - lưu `slip_storage_path`, `slip_uploaded_at`, xóa `slip_token_hash`;
  - hồ sơ sang `active`.
- Gửi một thư báo BMQ. Không phụ thuộc hợp đồng đã đóng dấu.
- Rate limit theo IP băm, action `slip`, 10 lần/giờ.

Token bank slip: 32 byte ngẫu nhiên base64url, chỉ lưu SHA-256, hạn 14 ngày.
Token, khóa và thông tin Gmail không bao giờ được log hoặc trả về.

## 5. Chặn đặt bánh

`dealer-order-submit` đọc `dealer_onboarding_status` từ phiên. Nếu
`waiting_slip`, trả HTTP 403 trước khi gọi `submit_dealer_order_guarded`:

```json
{
  "success": false,
  "code": "dealer_awaiting_bank_slip",
  "error": "Tài khoản đang chờ bank slip. Vui lòng upload bank slip để bắt đầu đặt bánh."
}
```

`dealer-session-status` trả thêm `onboarding_status` để giao diện hiện lời nhắc.
`dealer-auth-start` / `dealer-auth-verify` và RPC `submit_dealer_order_guarded`
không bị sửa.

## 6. Quyền

| Việc | owner | crm:view | crm:edit | accounting:edit |
| --- | --- | --- | --- | --- |
| Duyệt / từ chối / tạo lại HĐ / gửi lại link | ✅ | ❌ | ✅ | ❌ |
| Tải hợp đồng / bank slip | ✅ | ✅ | ✅ | ✅ |
| Upload hợp đồng đã đóng dấu | ✅ | ❌ | ✅ | ✅ |

Quyền được kiểm tra ở máy chủ bằng `user_roles` + `has_module_permission`; client
không thể tự khai báo quyền.

## 7. Biến môi trường

| Biến | Dùng cho | Ghi chú |
| --- | --- | --- |
| `DEALER_SIGNUP_PUBLIC_BASE_URL` | Domain link bank slip trong email | Mặc định `https://dathang.banhmique.vn`; đổi khi staging. |
| `DEALER_SIGNUP_BMQ_EMAIL` | Nhận hồ sơ / bank slip / thư xét tay | Đã dùng ở luồng submit hiện có. |
| `DEALER_SIGNUP_GMAIL_REFRESH_TOKEN_KEY` | Key `app_settings` chứa refresh token | Mặc định `order_gmail_refresh_token`. |
| `DEALER_SIGNUP_GMAIL_FROM` | From của thư | Mặc định `BMQ Đại lý <order@bmq.vn>`. |
| `DEALER_SIGNUP_REPLY_TO` | Reply-To | Mặc định `order@bmq.vn`. |
| `DEALER_SIGNUP_IP_SALT` | Băm IP rate limit | Nên đặt riêng; fallback service role key. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth | Đã có ở các function gửi mail khác. |

Bucket `dealer-signup-docs` được tạo riêng tư, giới hạn 10 MB và chỉ service_role
đọc/ghi; người dùng tải qua signed URL 5 phút.

## 8. Nhóm khách mặc định

Luồng tạo khách hiện tại của Mini CRM dùng `customer_group='banhmi_agency'`
(Đại lý) và `product_group='banhmi'`. `dealer_signup_approve` dùng đúng hai giá
trị này khi caller không truyền nhóm khác.

## 9. Deploy

1. Rà soát migration `20261103650000_dealer_signup_review.sql`.
2. Áp migration lên môi trường đích theo quy trình hiện tại.
3. Deploy các function đã đổi/thêm:
   - `dealer-signup-submit` (đã có, nay có thêm nhánh duyệt tự động)
   - `dealer-signup-review` (mới)
   - `dealer-signup-slip` (mới)
   - `dealer-order-submit` (thêm chặn waiting_slip)
   - `dealer-session-status` (trả onboarding_status)
4. Kiểm tra `config.toml`: `dealer-signup-review` và `dealer-signup-slip` có
   `verify_jwt=false` (JWT/token được kiểm tra trong code); `dealer-signup-review`
   có `static_files` chứa hai font Noto Sans.
5. Đặt các biến môi trường ở mục 7.
6. Kiểm tra bucket `dealer-signup-docs` là private và không có policy cho
   `anon`/`authenticated`.
7. Chạy smoke test bằng tài khoản test trước khi dùng dữ liệu thật.

## 10. Kiểm thử

```bash
cd apps/web
deno test --allow-read --allow-env \
  supabase/functions/_shared/dealer-signup-review.test.ts \
  supabase/functions/_shared/dealer-onboarding.test.ts \
  supabase/functions/dealer-signup-review/ \
  supabase/functions/dealer-signup-slip/ \
  supabase/functions/dealer-signup-submit/
deno check \
  supabase/functions/dealer-signup-review/index.ts \
  supabase/functions/dealer-signup-slip/index.ts \
  supabase/functions/dealer-signup-submit/index.ts \
  supabase/functions/dealer-order-submit/index.ts \
  supabase/functions/dealer-session-status/index.ts
npx vitest run src/lib/dealer-signup-api.test.ts
```

Các nhánh cũ vẫn phải xanh:
`_shared/dealer-signup-distance.test.ts`, `_shared/dealer-signup-contract.test.ts`,
`_shared/dealer-order-lock.test.ts`.
