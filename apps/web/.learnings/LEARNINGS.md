## [LRN-20260304-001] correction

**Logged**: 2026-03-04T21:43:00+07:00
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Sai cột join khi truy vấn invoice -> purchase order (`i.purchase_order_id` không tồn tại).

### Details
Trong hỗ trợ debug invoice `INV-PR-MLACJY4D`, đã gửi SQL dùng `left join public.purchase_orders p on p.id = i.purchase_order_id` và user nhận lỗi `42703 column does not exist`.
Cần kiểm tra schema thực tế trước khi gửi SQL join, hoặc dùng truy vấn an toàn chỉ đọc trường có sẵn rồi mở rộng sau.

### Suggested Action
- Trước khi gửi SQL debug, chạy truy vấn introspect cột bảng (`information_schema.columns`) hoặc đọc type/schema hiện tại.
- Với truy vấn hỗ trợ nhanh cho user, ưu tiên query bảng `invoices` riêng trước; chỉ join khi đã xác nhận tên khóa.

### Metadata
- Source: user_feedback
- Related Files: src/hooks/useInvoices.ts, supabase/migrations/
- Tags: sql, debug, schema-mismatch, correction

---
