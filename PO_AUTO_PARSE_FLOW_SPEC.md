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
