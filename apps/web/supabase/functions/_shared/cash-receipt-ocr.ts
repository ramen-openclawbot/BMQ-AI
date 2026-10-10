/**
 * Dedicated "cash receipt" OCR mode for the scan-invoice edge function.
 *
 * The cash dialog scans Vietnamese retail cash vouchers (delivery notes,
 * retail receipts, and ride-hailing / delivery-app screenshots such as
 * Siêu Tốc, Ahamove, Grab, Be, Lalamove). The generic invoice prompt happily
 * returns quantities ("6"), weights ("1kg"), distances ("7.98km"), order codes
 * or phone numbers as the amount, so this module keeps the dedicated prompt,
 * tool schema and normalization in one pure place.
 *
 * The normalized output intentionally keeps the generic envelope shape
 * (`supplier_name`, `items[]`) so older clients keep working.
 */
import { parseAmountVN, stripVietnamese } from "./bank-slip-ocr.ts";

export const CASH_RECEIPT_MAX_AMOUNT = 50_000_000;
export const CASH_RECEIPT_MAX_TEXT = 200;

/** Placeholder payee names that must be treated as "not read". */
const PLACEHOLDER_PAYEE_KEYS = new Set([
  "",
  "-",
  "--",
  "n/a",
  "na",
  "unknown",
  "khong biet",
  "khong ro",
  "khong co",
]);

/** True for empty/placeholder payee values ('Không biết', 'unknown', '-', ...). */
export const isPlaceholderPayeeName = (value: unknown): boolean => {
  const key = stripVietnamese(String(value ?? "").trim()).replace(/\s+/g, " ");
  return PLACEHOLDER_PAYEE_KEYS.has(key);
};

const safeText = (value: unknown, max = CASH_RECEIPT_MAX_TEXT): string | null => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

export const CASH_RECEIPT_SYSTEM_PROMPT = `Bạn là chuyên gia đọc chứng từ chi tiền mặt tiếng Việt: phiếu giao hàng / biên nhận bán lẻ và ảnh chụp màn hình ứng dụng giao hàng / xe công nghệ (Siêu Tốc, Ahamove, Grab, Be, Lalamove...).

Mục tiêu: lấy ĐÚNG số tiền khách đã THỰC TRẢ và nội dung ngắn gọn của chứng từ.

1. total_amount (BẮT BUỘC): số tiền thực trả, chỉ trả về phần chữ số (vd "81.000đ" -> 81000). Đây là số cạnh các nhãn:
   - "Người nhận trả tiền mặt", "Tổng", "Tổng tiền", "Tổng cộng", "Thành tiền", "Thanh toán", "Tài khoản", "Số tiền", "Thực trả", "Khách trả".
   - Với ảnh app giao hàng, số tiền thực trả là số nằm cạnh dòng "Người nhận trả tiền mặt", "Tổng tiền", "Tài khoản" hoặc "Thanh toán" (thường là dòng cuối cùng).
2. payee_name: tên cửa hàng/người bán hoặc tên tài xế/ứng dụng nhận tiền (bên thu tiền). Nếu không đọc được thì null.
3. description: nội dung ngắn gọn (vd "Ship Siêu Tốc #26XLO7TD", "Nước Bidrico 19L x6").
4. invoice_number: số hoá đơn / mã đơn nếu có, không có thì null.
5. confidence: độ tin cậy 0..1.

QUY TẮC ÂM (TUYỆT ĐỐI KHÔNG VI PHẠM):
- KHÔNG lấy số lượng, khối lượng/cân nặng (vd "1kg", "19L", "20L", "6 chai"), quãng đường/khoảng cách (vd "7.98km", "3.2 km"), mã đơn/mã vận đơn (vd "#26XLO7TD"), số điện thoại, số tài khoản, ngày giờ hay mã OTP làm total_amount.
- KHÔNG lấy địa chỉ lấy hàng (pickup) hoặc địa chỉ giao hàng (drop-off) làm payee_name.
- Nếu chứng từ chỉ có khối lượng / quãng đường / số lượng mà không có số tiền thực trả thì trả total_amount = null; KHÔNG đoán.
- Nếu không chắc, vẫn trả best guess và giảm confidence.

Rules (English):
- total_amount is the amount the customer actually PAID (label "Người nhận trả tiền mặt" / "Tổng" / "Thanh toán" / "Tài khoản"), never a quantity, weight ("1kg"), distance ("7.98km"), order code, phone number or address.
- payee_name is the shop or the app/driver receiving the money, never a pickup or drop-off address.
- description is a short meaningful summary of the document.

Trả về JSON đúng schema của tool.`;

export const CASH_RECEIPT_TOOL = {
  type: "function",
  function: {
    name: "extract_cash_receipt",
    description:
      "Extract the amount actually paid, the payee and a short description from a Vietnamese cash voucher or delivery-app screenshot",
    parameters: {
      type: "object",
      properties: {
        total_amount: {
          type: "number",
          description:
            "Số tiền khách thực trả (chỉ chữ số). KHÔNG lấy số lượng, cân nặng, quãng đường, mã đơn, số điện thoại hay địa chỉ.",
        },
        payee_name: {
          type: "string",
          description: "Tên cửa hàng hoặc tài xế/ứng dụng nhận tiền; không lấy địa chỉ lấy/giao hàng.",
        },
        description: {
          type: "string",
          description: "Nội dung ngắn gọn, vd 'Ship Siêu Tốc #26XLO7TD', 'Nước Bidrico 19L x6'.",
        },
        invoice_number: { type: "string", description: "Số hoá đơn / mã đơn nếu có." },
        confidence: { type: "number", description: "Độ tin cậy 0..1." },
      },
      required: ["total_amount"],
    },
  },
} as const;

export type CashReceiptRaw = {
  total_amount?: unknown;
  payee_name?: unknown;
  description?: unknown;
  invoice_number?: unknown;
  confidence?: unknown;
  [key: string]: unknown;
};

export interface CashReceiptItem {
  product_name: string;
  quantity: 1;
  unit: "lần";
  unit_price: number;
}

export interface NormalizedCashReceipt {
  supplier_name: string | null;
  invoice_number: string | null;
  total_amount: number | null;
  description: string | null;
  confidence: number | null;
  items: CashReceiptItem[];
}

/**
 * Normalize an extract_cash_receipt payload into the generic scan-invoice
 * envelope. Rejects a non-positive or absurd amount (> 50,000,000) as null so
 * the operator has to type it by hand instead of saving a wrong figure.
 */
export const normalizeCashReceipt = (raw: CashReceiptRaw | null | undefined): NormalizedCashReceipt => {
  const source = raw && typeof raw === "object" ? raw : {};

  const parsed = parseAmountVN(source.total_amount);
  const totalAmount = parsed !== null && parsed > 0 && parsed <= CASH_RECEIPT_MAX_AMOUNT ? parsed : null;

  const rawPayee = safeText(source.payee_name);
  const supplierName = rawPayee && !isPlaceholderPayeeName(rawPayee) ? rawPayee : null;

  const description = safeText(source.description);
  const invoiceNumber = safeText(source.invoice_number);

  const confidenceNumber = Number(source.confidence);
  const confidence = Number.isFinite(confidenceNumber)
    ? Math.min(Math.max(confidenceNumber, 0), 1)
    : null;

  const items: CashReceiptItem[] = totalAmount === null
    ? []
    : [{
      product_name: description ?? invoiceNumber ?? "Chi tiền mặt",
      quantity: 1,
      unit: "lần",
      unit_price: totalAmount,
    }];

  return {
    supplier_name: supplierName,
    invoice_number: invoiceNumber,
    total_amount: totalAmount,
    description,
    confidence,
    items,
  };
};
