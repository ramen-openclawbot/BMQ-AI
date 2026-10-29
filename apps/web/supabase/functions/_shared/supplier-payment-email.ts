/**
 * Vietnamese supplier payment email with UNC (bank transfer) evidence.
 *
 * Pure functions only: no network, no database, no secrets. Every interpolated
 * value is escaped before it reaches the HTML.
 */

import { escapeHtml, formatVnd } from "./supplier-order-email.ts";

export type SupplierPaymentEmailInput = {
  supplierName: string;
  paymentNumber: string;
  amount: number | null;
  /** ISO date (YYYY-MM-DD) or an already formatted date. */
  paymentDate: string | null;
  poNumbers: string[];
  requestNumbers: string[];
  reference: string | null;
  test: boolean;
};

export type SupplierPaymentEmail = {
  subject: string;
  text: string;
  html: string;
};

function textOrEmpty(value: unknown): string {
  return String(value ?? "").trim();
}

function displayDate(value: string | null): string {
  const text = textOrEmpty(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return text;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function joinList(values: string[]): string {
  return values.map(textOrEmpty).filter(Boolean).join(", ");
}

export function buildSupplierPaymentEmail(
  input: SupplierPaymentEmailInput,
): SupplierPaymentEmail {
  const testPrefix = input.test ? "[THỬ] " : "";
  const supplierName = textOrEmpty(input.supplierName) || "Nhà cung cấp";
  const paymentNumber = textOrEmpty(input.paymentNumber);
  const poNumbers = joinList(input.poNumbers ?? []);
  const requestNumbers = joinList(input.requestNumbers ?? []);
  const reference = textOrEmpty(input.reference);
  const paymentDate = displayDate(input.paymentDate);
  const amountText = formatVnd(input.amount);
  const subjectRef = joinList([input.poNumbers?.[0] ?? ""]) || paymentNumber;

  const subject = `${testPrefix}BMQ thông báo thanh toán ${subjectRef} – ${supplierName}`;

  const detailLines = [
    `Số tiền: ${amountText}`,
    ...(paymentDate ? [`Ngày chuyển: ${paymentDate}`] : []),
    ...(poNumbers ? [`PO: ${poNumbers}`] : []),
    ...(requestNumbers ? [`Phiếu đề nghị: ${requestNumbers}`] : []),
    ...(reference ? [`Mã giao dịch: ${reference}`] : []),
  ];

  const text = [
    `Kính gửi ${supplierName},`,
    "",
    "Bánh Mì Que (BMQ) đã thanh toán cho Quý công ty:",
    ...detailLines,
    "",
    "Ảnh UNC (ủy nhiệm chi) đính kèm email này.",
    "Mọi thắc mắc vui lòng trả lời email này.",
    "",
    "Trân trọng,",
    "Bánh Mì Que",
  ].join("\n");

  const detailRows = [
    ["Số tiền", amountText],
    ...(paymentDate ? [["Ngày chuyển", paymentDate]] : []),
    ...(poNumbers ? [["PO", poNumbers]] : []),
    ...(requestNumbers ? [["Phiếu đề nghị", requestNumbers]] : []),
    ...(reference ? [["Mã giao dịch", reference]] : []),
  ].map(([label, value]) => `
                <tr>
                  <td style="padding:6px 0;width:170px;vertical-align:top;color:#6b7280;">${
    escapeHtml(label)
  }</td>
                  <td style="padding:6px 0;vertical-align:top;font-weight:bold;">${
    escapeHtml(value)
  }</td>
                </tr>`).join("");

  const html = `
<div style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;line-height:1.55;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f5;padding:16px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:6px;">
          <tr>
            <td style="padding:20px 24px;border-bottom:3px solid #b91c1c;">
              <div style="font-size:18px;font-weight:bold;color:#b91c1c;">Bánh Mì Que (BMQ)</div>
              <div style="font-size:12px;color:#6b7280;">Thông báo thanh toán${escapeHtml(paymentNumber ? ` ${paymentNumber}` : "")}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 24px;">
              <p style="margin:0 0 12px;">Kính gửi <strong>${escapeHtml(supplierName)}</strong>,</p>
              <p style="margin:0 0 16px;">Bánh Mì Que (BMQ) đã thanh toán cho Quý công ty:</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:13px;">
${detailRows}
              </table>
              <p style="margin:16px 0 0;">Ảnh UNC (ủy nhiệm chi) đính kèm email này.</p>
              <p style="margin:12px 0 0;">Mọi thắc mắc vui lòng trả lời email này.</p>
              <p style="margin:20px 0 0;">Trân trọng,<br>Bánh Mì Que</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>`.trim();

  return { subject, text, html };
}
