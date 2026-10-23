/**
 * Vietnamese supplier order email (text + Gmail-safe HTML).
 *
 * Pure functions only: no network, no database, no secrets. Every interpolated
 * value is escaped before it reaches the HTML.
 */

export type SupplierOrderEmailInput = {
  poNumber: string;
  supplierName: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  lineTotal: number | null;
  deliveryAddress: string;
  contactName: string;
  contactPhone: string;
  note: string;
  requestedDate: string;
  uploadUrl: string;
  companyName?: string;
  taxCode?: string;
};

export type SupplierOrderEmail = {
  subject: string;
  text: string;
  html: string;
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function groupThousands(value: number): string {
  const rounded = Math.round(Math.abs(value));
  const digits = String(rounded);
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return value < 0 ? `-${out}` : out;
}

export function formatVnd(value: number | null | undefined): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `${groupThousands(number)} đ`;
}

export function formatQuantity(value: number | null | undefined): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const rounded = Math.round(number * 1000) / 1000;
  const sign = rounded < 0 ? "-" : "";
  const [whole, decimal = ""] = String(Math.abs(rounded)).split(".");
  const trimmed = decimal.replace(/0+$/, "");
  return `${sign}${groupThousands(Number(whole))}${trimmed ? `,${trimmed}` : ""}`;
}

function displayDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return String(value ?? "");
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function buildSupplierOrderEmail(
  input: SupplierOrderEmailInput,
): SupplierOrderEmail {
  const companyName = input.companyName || "Công ty CP Thực phẩm BMQ";
  const taxCode = input.taxCode || "0311840107";
  const subject = `BMQ đặt hàng ${input.poNumber} – ${input.productName}`;
  const requestedDate = displayDate(input.requestedDate);
  const note = String(input.note ?? "").trim();

  const textLines = [
    `Kính gửi ${input.supplierName},`,
    "",
    `${companyName} xin gửi Quý công ty đơn đặt hàng ${input.poNumber}.`,
    "",
    "Tên hàng | Số lượng | Đơn vị | Đơn giá | Thành tiền",
    `${input.productName} | ${formatQuantity(input.quantity)} | ${input.unit} | ${formatVnd(input.unitPrice)} | ${formatVnd(input.lineTotal)}`,
    "",
    `Tổng cộng: ${formatVnd(input.lineTotal)}`,
    "",
    `Địa chỉ giao hàng: ${input.deliveryAddress}`,
    `Người nhận: ${input.contactName} - ${input.contactPhone}`,
    `Ngày đặt hàng: ${requestedDate}`,
    ...(note ? [`Ghi chú: ${note}`] : []),
    "",
    `Sau khi giao hàng, Quý công ty vui lòng tải lên hóa đơn / phiếu giao hàng tại đây: ${input.uploadUrl}`,
    "",
    "Vui lòng trả lời (reply) email này nếu cần trao đổi thêm.",
    "",
    "Trân trọng,",
    companyName,
    `Mã số thuế: ${taxCode}`,
  ];

  const html = `
<div style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;line-height:1.55;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f5;padding:16px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:6px;">
          <tr>
            <td style="padding:20px 24px;border-bottom:3px solid #b91c1c;">
              <div style="font-size:18px;font-weight:bold;color:#b91c1c;">${escapeHtml(companyName)}</div>
              <div style="font-size:12px;color:#6b7280;">Mã số thuế: ${escapeHtml(taxCode)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 24px;">
              <p style="margin:0 0 12px;">Kính gửi <strong>${escapeHtml(input.supplierName)}</strong>,</p>
              <p style="margin:0 0 16px;">${escapeHtml(companyName)} xin gửi Quý công ty đơn đặt hàng <strong>${escapeHtml(input.poNumber)}</strong> với nội dung sau:</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:13px;">
                <tr>
                  <th align="left" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Tên hàng</th>
                  <th align="right" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Số lượng</th>
                  <th align="left" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Đơn vị</th>
                  <th align="right" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Đơn giá</th>
                  <th align="right" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Thành tiền</th>
                </tr>
                <tr>
                  <td style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(input.productName)}</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(formatQuantity(input.quantity))}</td>
                  <td style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(input.unit)}</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(formatVnd(input.unitPrice))}</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(formatVnd(input.lineTotal))}</td>
                </tr>
                <tr>
                  <td colspan="4" align="right" style="padding:8px;border:1px solid #d1d5db;font-weight:bold;">Tổng cộng</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;font-weight:bold;">${escapeHtml(formatVnd(input.lineTotal))}</td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;font-size:13px;">
                <tr>
                  <td style="padding:4px 0;width:150px;vertical-align:top;color:#6b7280;">Địa chỉ giao hàng</td>
                  <td style="padding:4px 0;vertical-align:top;">${escapeHtml(input.deliveryAddress)}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0;vertical-align:top;color:#6b7280;">Người nhận</td>
                  <td style="padding:4px 0;vertical-align:top;">${escapeHtml(input.contactName)} - ${escapeHtml(input.contactPhone)}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0;vertical-align:top;color:#6b7280;">Ngày đặt hàng</td>
                  <td style="padding:4px 0;vertical-align:top;">${escapeHtml(requestedDate)}</td>
                </tr>
                ${
                  note
                    ? `<tr>
                  <td style="padding:4px 0;vertical-align:top;color:#6b7280;">Ghi chú</td>
                  <td style="padding:4px 0;vertical-align:top;">${escapeHtml(note)}</td>
                </tr>`
                    : ""
                }
              </table>
              <p style="margin:20px 0 12px;">Sau khi giao hàng, Quý công ty vui lòng tải lên <strong>hóa đơn / phiếu giao hàng</strong> tại liên kết bên dưới:</p>
              <p style="margin:0 0 16px;">
                <a href="${escapeHtml(input.uploadUrl)}" style="display:inline-block;padding:11px 18px;background-color:#b91c1c;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:bold;">Tải lên hóa đơn / phiếu giao hàng</a>
              </p>
              <p style="margin:0 0 8px;font-size:12px;color:#6b7280;word-break:break-all;">${escapeHtml(input.uploadUrl)}</p>
              <p style="margin:16px 0 0;">Vui lòng trả lời (reply) email này nếu cần trao đổi thêm.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
              <div style="font-weight:bold;color:#1f2937;">${escapeHtml(companyName)}</div>
              <div>Mã số thuế: ${escapeHtml(taxCode)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>`.trim();

  return {
    subject,
    text: textLines.join("\n"),
    html,
  };
}
