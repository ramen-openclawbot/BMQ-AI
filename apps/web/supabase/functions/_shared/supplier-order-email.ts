/**
 * Vietnamese supplier order email (text + Gmail-safe HTML).
 *
 * Pure functions only: no network, no database, no secrets. Every interpolated
 * value is escaped before it reaches the HTML.
 */

export type SupplierOrderEmailLine = {
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  lineTotal: number | null;
  vatRate?: number | null;
};

export type SupplierOrderEmailDelivery = {
  label: string;
  address: string;
  contactName: string;
  contactPhone: string;
  items?: string[];
};

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
  deliveries?: SupplierOrderEmailDelivery[];
};

export type SupplierOrderEmailLinesInput = {
  poNumber: string;
  supplierName: string;
  lines: SupplierOrderEmailLine[];
  total: number | null;
  subtotal?: number | null;
  vatAmount?: number | null;
  deliveryAddress: string;
  contactName: string;
  contactPhone: string;
  note: string;
  requestedDate: string;
  uploadUrl: string;
  companyName?: string;
  taxCode?: string;
  subjectName?: string;
  deliveries?: SupplierOrderEmailDelivery[];
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

/**
 * Unit prices may be net prices with cents (for example 19.296,30 đ). Whole
 * đồng values keep the exact formatVnd output so unchanged emails stay
 * byte-identical.
 */
export function formatUnitPrice(value: number | null | undefined): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const rounded = Math.round(number * 100) / 100;
  if (Number.isInteger(rounded)) return formatVnd(rounded);
  const sign = rounded < 0 ? "-" : "";
  const [whole, decimal] = Math.abs(rounded).toFixed(2).split(".");
  return `${sign}${groupThousands(Number(whole))},${decimal} đ`;
}

export function formatVatRate(value: number | null | undefined): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const rounded = Math.round(number * 100) / 100;
  return `${String(rounded).replace(".", ",")}%`;
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

const PREVIEW_PO_LABEL = "PO mới (số cấp khi gửi)";
const PREVIEW_UPLOAD_TEXT =
  "Liên kết tải hóa đơn / phiếu giao hàng sẽ được gửi kèm khi đơn hàng được gửi.";

export function buildSupplierOrderEmailLines(
  input: SupplierOrderEmailLinesInput,
): SupplierOrderEmail {
  const companyName = input.companyName || "Công ty CP Thực phẩm BMQ";
  const taxCode = input.taxCode || "0311840107";
  const poLabel = String(input.poNumber ?? "").trim() || PREVIEW_PO_LABEL;
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const subjectName = input.subjectName
    || (lines.length === 1 ? lines[0].productName : input.supplierName);
  const subject = `BMQ đặt hàng ${poLabel} – ${subjectName}`;
  const requestedDate = displayDate(input.requestedDate);
  const note = String(input.note ?? "").trim();
  const uploadUrl = String(input.uploadUrl ?? "").trim();
  const deliveries = Array.isArray(input.deliveries) ? input.deliveries : [];
  const multiDelivery = deliveries.length >= 2;
  const singleDelivery = deliveries.length === 1 ? deliveries[0] : null;
  const deliveryAddress = singleDelivery?.address ?? input.deliveryAddress;
  const contactName = singleDelivery?.contactName ?? input.contactName;
  const contactPhone = singleDelivery?.contactPhone ?? input.contactPhone;
  const total = input.total;
  const vatAmount = typeof input.vatAmount === "number"
      && Number.isFinite(input.vatAmount)
    ? input.vatAmount
    : 0;
  const hasVat = vatAmount > 0;
  const derivedSubtotal = lines.reduce(
    (sum, line) =>
      sum
      + (typeof line.lineTotal === "number" && Number.isFinite(line.lineTotal)
        ? line.lineTotal
        : 0),
    0,
  );
  const subtotal = typeof input.subtotal === "number"
      && Number.isFinite(input.subtotal)
    ? input.subtotal
    : derivedSubtotal;

  const totalTextLines = hasVat
    ? [
        `Cộng tiền hàng: ${formatVnd(subtotal)}`,
        `Thuế GTGT: ${formatVnd(vatAmount)}`,
        `Tổng cộng: ${formatVnd(total)}`,
      ]
    : [`Tổng cộng: ${formatVnd(total)}`];

  const deliveryTextLines = multiDelivery
    ? [
        "Địa chỉ giao hàng",
        "",
        ...deliveries.flatMap((delivery, index) => {
          const items = Array.isArray(delivery.items) ? delivery.items : [];
          return [
            `${delivery.label}: ${delivery.address}`,
            `Người nhận: ${delivery.contactName} - ${delivery.contactPhone}`,
            ...(items.length > 0
              ? [`Món giao về đây: ${items.join(", ")}`]
              : []),
            ...(index < deliveries.length - 1 ? [""] : []),
          ];
        }),
      ]
    : [
        `Địa chỉ giao hàng: ${deliveryAddress}`,
        `Người nhận: ${contactName} - ${contactPhone}`,
      ];

  const textLines = [
    `Kính gửi ${input.supplierName},`,
    "",
    `${companyName} xin gửi Quý công ty đơn đặt hàng ${poLabel}.`,
    "",
    "Tên hàng | Số lượng | Đơn vị | Đơn giá | Thành tiền",
    ...lines.map((line) =>
      `${line.productName} | ${formatQuantity(line.quantity)} | ${line.unit} | ${formatUnitPrice(line.unitPrice)} | ${formatVnd(line.lineTotal)}`
    ),
    "",
    ...totalTextLines,
    "",
    ...deliveryTextLines,
    `Ngày đặt hàng: ${requestedDate}`,
    ...(note ? [`Ghi chú: ${note}`] : []),
    "",
    uploadUrl
      ? `Sau khi giao hàng, Quý công ty vui lòng tải lên hóa đơn / phiếu giao hàng tại đây: ${uploadUrl}`
      : `Sau khi giao hàng, Quý công ty vui lòng tải lên hóa đơn / phiếu giao hàng. ${PREVIEW_UPLOAD_TEXT}`,
    "",
    "Vui lòng trả lời (reply) email này nếu cần trao đổi thêm.",
    "",
    "Trân trọng,",
    companyName,
    `Mã số thuế: ${taxCode}`,
  ];

  const htmlRows = lines.map((line) => `
                <tr>
                  <td style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(line.productName)}</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(formatQuantity(line.quantity))}</td>
                  <td style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(line.unit)}</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;white-space:nowrap;">${escapeHtml(formatUnitPrice(line.unitPrice))}</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;white-space:nowrap;">${escapeHtml(formatVnd(line.lineTotal))}</td>${hasVat ? `
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;">${escapeHtml(formatVatRate(line.vatRate))}</td>` : ""}
                </tr>`).join("");

  const summaryHtml = hasVat
    ? `                <tr>
                  <td colspan="5" align="right" style="padding:8px;border:1px solid #d1d5db;">Cộng tiền hàng</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;white-space:nowrap;">${escapeHtml(formatVnd(subtotal))}</td>
                </tr>
                <tr>
                  <td colspan="5" align="right" style="padding:8px;border:1px solid #d1d5db;">Thuế GTGT</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;white-space:nowrap;">${escapeHtml(formatVnd(vatAmount))}</td>
                </tr>
                <tr>
                  <td colspan="5" align="right" style="padding:8px;border:1px solid #d1d5db;font-weight:bold;">Tổng cộng</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;font-weight:bold;white-space:nowrap;">${escapeHtml(formatVnd(total))}</td>
                </tr>`
    : `                <tr>
                  <td colspan="4" align="right" style="padding:8px;border:1px solid #d1d5db;font-weight:bold;">Tổng cộng</td>
                  <td align="right" style="padding:8px;border:1px solid #d1d5db;font-weight:bold;white-space:nowrap;">${escapeHtml(formatVnd(total))}</td>
                </tr>`;

  const uploadHtml = uploadUrl
    ? `<p style="margin:20px 0 12px;">Sau khi giao hàng, Quý công ty vui lòng tải lên <strong>hóa đơn / phiếu giao hàng</strong> tại liên kết bên dưới:</p>
              <p style="margin:0 0 16px;">
                <a href="${escapeHtml(uploadUrl)}" style="display:inline-block;padding:11px 18px;background-color:#b91c1c;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:bold;">Tải lên hóa đơn / phiếu giao hàng</a>
              </p>
              <p style="margin:0 0 8px;font-size:12px;color:#6b7280;word-break:break-all;">${escapeHtml(uploadUrl)}</p>`
    : `<p style="margin:20px 0 12px;">Sau khi giao hàng, Quý công ty vui lòng tải lên <strong>hóa đơn / phiếu giao hàng</strong>.</p>
              <p style="margin:0 0 16px;color:#6b7280;">${escapeHtml(PREVIEW_UPLOAD_TEXT)}</p>`;

  const deliveryHtmlRows = multiDelivery
    ? `                <tr>
                  <td colspan="2" style="padding:4px 0;vertical-align:top;color:#6b7280;font-weight:bold;">Địa chỉ giao hàng</td>
                </tr>${
      deliveries.map((delivery) => {
        const items = Array.isArray(delivery.items) ? delivery.items : [];
        return `
                <tr>
                  <td colspan="2" style="padding:4px 0;vertical-align:top;">
                    <div>${escapeHtml(delivery.label)}: ${escapeHtml(delivery.address)}</div>
                    <div>Người nhận: ${escapeHtml(delivery.contactName)} - ${escapeHtml(delivery.contactPhone)}</div>${
          items.length > 0
            ? `
                    <div>Món giao về đây: ${escapeHtml(items.join(", "))}</div>`
            : ""
        }
                  </td>
                </tr>`;
      }).join("")
    }`
    : `                <tr>
                  <td style="padding:4px 0;width:150px;vertical-align:top;color:#6b7280;">Địa chỉ giao hàng</td>
                  <td style="padding:4px 0;vertical-align:top;">${escapeHtml(deliveryAddress)}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0;vertical-align:top;color:#6b7280;">Người nhận</td>
                  <td style="padding:4px 0;vertical-align:top;">${escapeHtml(contactName)} - ${escapeHtml(contactPhone)}</td>
                </tr>`;

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
              <p style="margin:0 0 16px;">${escapeHtml(companyName)} xin gửi Quý công ty đơn đặt hàng <strong>${escapeHtml(poLabel)}</strong> với nội dung sau:</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:13px;">
                <tr>
                  <th align="left" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Tên hàng</th>
                  <th align="right" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Số lượng</th>
                  <th align="left" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Đơn vị</th>
                  <th align="right" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Đơn giá</th>
                  <th align="right" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">Thành tiền</th>${hasVat ? `
                  <th align="right" style="padding:8px;border:1px solid #d1d5db;background-color:#f3f4f6;">% VAT</th>` : ""}
                </tr>${htmlRows}
${summaryHtml}
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;font-size:13px;">
${deliveryHtmlRows}
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
              ${uploadHtml}
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

export function buildSupplierOrderEmail(
  input: SupplierOrderEmailInput,
): SupplierOrderEmail {
  return buildSupplierOrderEmailLines({
    poNumber: input.poNumber,
    supplierName: input.supplierName,
    lines: [{
      productName: input.productName,
      quantity: input.quantity,
      unit: input.unit,
      unitPrice: input.unitPrice,
      lineTotal: input.lineTotal,
    }],
    total: input.lineTotal,
    deliveryAddress: input.deliveryAddress,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    note: input.note,
    requestedDate: input.requestedDate,
    uploadUrl: input.uploadUrl,
    companyName: input.companyName,
    taxCode: input.taxCode,
    subjectName: input.productName,
    deliveries: input.deliveries,
  });
}
