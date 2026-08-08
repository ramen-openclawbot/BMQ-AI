# BMQ dealer order confirmation — ZBS/ZNS template registration

Use the same **OA ID**, **OA Name**, and **Link to OA** already registered for the BMQ dealer OTP flow.

## Registration row

- **Tên mẫu:** `BMQ - Xác nhận đơn đặt hàng`
- **Tiêu đề:** `BMQ xác nhận đơn đặt hàng`
- **Hình ảnh:** để trống

### Nội dung chính

**Đoạn văn 1**

```text
BMQ xác nhận đã nhận đơn hàng <ma_don_hang> của <ten_khach_hang>.
```

**Đoạn văn 2**

```text
Ngày đặt: <ngay_dat>. Ngày giao dự kiến: <ngay_giao>.
```

**Đoạn văn 3**

```text
Tổng số lượng đặt hàng: <tong_so_luong> sản phẩm. Tổng tiền: <tong_tien>.
```

**Đoạn văn 4**

```text
Cảm ơn Quý khách đã đặt hàng tại BMQ.
```

### CTA

- **Tên CTA 1:** `Xem chi tiết đơn`
- **Link CTA 1:** `https://dathang.banhmique.vn`
- **Tên CTA 2/3:** để trống
- **Link CTA 2/3:** để trống

### Biến số

```text
ma_don_hang
ten_khach_hang
ngay_dat
ngay_giao
tong_so_luong
tong_tien
```

### Giá trị mẫu để nhà cung cấp duyệt

```text
ma_don_hang = DOP-20260808-ABC12345
ten_khach_hang = Đại lý BMQ Mẫu
ngay_dat = 08/08/2026
ngay_giao = 09/08/2026
tong_so_luong = 100
tong_tien = 650.000 đ
```

## Activation contract

Keep `dealer_order_confirmation_enabled=false` until VietGuys/Zalo returns an approved and active template ID. Then:

1. Set the Edge Function secret `DEALER_VIETGUYS_ORDER_CONFIRM_TEMPLATE_ID` to the approved ID.
2. Deploy/verify `dealer-order-confirm-notify` without sending a real test message.
3. Enable `app_settings.dealer_order_confirmation_enabled=true`.
4. Verify the next real submitted order produces one outbox row and one provider acceptance; do not backfill old orders.

The dedicated order template must never reuse `DEALER_VIETGUYS_TEMPLATE_ID`, which remains the OTP template.
