/**
 * Vietnamese supplier order cancellation email (text + Gmail-safe HTML).
 *
 * Pure functions only: no network, no database, no secrets. Every interpolated
 * value is escaped before it reaches the HTML.
 */

import {
  escapeHtml,
  formatQuantity,
  formatVnd,
} from "./supplier-order-email.ts";

export type SupplierOrderCancelEmailLine = {
  productName: string;
  quantity: number;
  unit: string;
};

export type SupplierOrderCancelEmailInput = {
  poNumber: string;
  supplierName: string;
  sentAt: string | null | undefined;
  reason: string;
  lines: SupplierOrderCancelEmailLine[];
  total: number | null;
};

export type SupplierOrderCancelEmail = {
  subject: string;
  text: string;
  html: string;
};

const COMPANY_NAME = "Công ty CP Thực phẩm BMQ";
const TAX_CODE = "0311840107";

function displaySentDate(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function lineLabel(line: SupplierOrderCancelEmailLine): string {
  const unit = String(line.unit ?? "").trim();
  return `${formatQuantity(line.quantity)}${unit ? ` ${unit}` : ""}`;
}

export function buildSupplierOrderCancelEmail(
  input: SupplierOrderCancelEmailInput,
): SupplierOrderCancelEmail {
  const poNumber = String(input.poNumber ?? "").trim();
  const supplierName = String(input.supplierName ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  const sentDate = displaySentDate(input.sentAt);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const total = input.total;

  const subject = `[HUỶ ĐƠN] BMQ huỷ đơn đặt hàng ${poNumber} – ${supplierName}`;

  const textLines = [
    `Kính gửi ${supplierName},`,
    "",
    `${COMPANY_NAME} xin HUỶ đơn đặt hàng ${poNumber} đã gửi ngày ${sentDate}.`,
    ...(reason ? [`Lý do: ${reason}`] : []),
    ...lines.map((line) => `• ${line.productName}: ${lineLabel(line)}`),
    "",
    `Tổng giá trị đơn huỷ: ${formatVnd(total)}`,
    "",
    "Quý công ty vui lòng KHÔNG giao đơn này. Nếu hàng đã chuẩn bị hoặc đang giao, vui lòng trả lời email này để BMQ phối hợp.",
    "",
    "Trân trọng,",
    COMPANY_NAME,
  ];

  const htmlRows = lines.map((line) => `
                <tr>
                  <td style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(line.productName)}</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;white-space:nowrap;">${escapeHtml(formatQuantity(line.quantity))}</td>
                  <td style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(line.unit)}</td>
                </tr>`).join("");

  const reasonHtml = reason
    ? `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;font-size:13px;">
                <tr>
                  <td style="padding:4px 0;width:90px;vertical-align:top;color:#6b7280;">Lý do huỷ</td>
                  <td style="padding:4px 0;vertical-align:top;font-weight:bold;">${escapeHtml(reason)}</td>
                </tr>
              </table>`
    : "";

  const html = `
<div style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;line-height:1.55;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f5;padding:16px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:6px;">
          <tr>
            <td style="padding:20px 24px;border-bottom:3px solid #b91c1c;">
              <div style="font-size:18px;font-weight:bold;color:#b91c1c;">${escapeHtml(COMPANY_NAME)}</div>
              <div style="font-size:12px;color:#6b7280;">Mã số thuế: ${escapeHtml(TAX_CODE)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;background-color:#fef2f2;border:1px solid #b91c1c;border-radius:4px;">
                <tr>
                  <td style="padding:12px 14px;color:#991b1b;font-weight:bold;">
                    ĐƠN ĐẶT HÀNG ĐÃ BỊ HUỶ — Quý công ty vui lòng KHÔNG giao đơn này.
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 12px;">Kính gửi <strong>${escapeHtml(supplierName)}</strong>,</p>
              <p style="margin:0 0 16px;">${escapeHtml(COMPANY_NAME)} xin <strong>HUỶ</strong> đơn đặt hàng <strong>${escapeHtml(poNumber)}</strong> đã gửi ngày ${escapeHtml(sentDate)}.</p>
              ${reasonHtml}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:13px;">
                <tr>
                  <th align="left" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Tên hàng</th>
                  <th align="right" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Số lượng</th>
                  <th align="left" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Đơn vị</th>
                </tr>${htmlRows}
                <tr>
                  <td colspan="2" align="right" style="padding:8px;border:1px solid #d1d5db;font-weight:bold;">Tổng giá trị đơn huỷ</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;font-weight:bold;white-space:nowrap;">${escapeHtml(formatVnd(total))}</td>
                </tr>
              </table>
              <p style="margin:16px 0 0;color:#991b1b;font-weight:bold;">Quý công ty vui lòng KHÔNG giao đơn này. Nếu hàng đã chuẩn bị hoặc đang giao, vui lòng trả lời email này để BMQ phối hợp.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
              <div style="font-weight:bold;color:#1f2937;">${escapeHtml(COMPANY_NAME)}</div>
              <div>Mã số thuế: ${escapeHtml(TAX_CODE)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>`.trim();

  return { subject, text: textLines.join("\n"), html };
}
