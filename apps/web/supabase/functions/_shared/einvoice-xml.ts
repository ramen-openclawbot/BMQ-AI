/**
 * Đọc hóa đơn điện tử XML theo chuẩn Tổng cục Thuế (HDon/DLHDon).
 *
 * Hàm thuần, không phụ thuộc DOM hay thư viện ngoài. Hỗ trợ cả XML có namespace
 * (`ns:HDon`) và biến thể không namespace. XML hỏng hoặc không phải hóa đơn trả
 * về null thay vì ném lỗi.
 *
 * Các trường TCT:
 *   TTChung: KHMSHDon, KHHDon, SHDon, NLap
 *   NDHDon/NBan: Ten, MST
 *   NDHDon/TToan: TgTCThue, TgTThue, TgTTTBSo
 *   NDHDon/DSHHDVu/HHDVu: THHDVu, DVTinh, SLuong, DGia, ThTien, TSuat
 */

export interface VietnamEInvoiceSeller {
  name: string | null;
  tax_code: string | null;
  taxCode: string | null;
}

export interface VietnamEInvoiceLine {
  name: string | null;
  unit: string | null;
  quantity: number | null;
  unit_price: number | null;
  unitPrice: number | null;
  amount: number | null;
  line_total: number | null;
  vat_rate: number | null;
  vatRate: number | null;
}

export interface VietnamEInvoice {
  seller: VietnamEInvoiceSeller;
  invoice_number: string | null;
  invoice_series: string | null;
  invoice_date: string | null;
  invoiceNumber: string | null;
  invoiceSeries: string | null;
  invoiceDate: string | null;
  subtotal: number | null;
  vat_amount: number | null;
  vat: number | null;
  total_amount: number | null;
  total: number | null;
  lines: VietnamEInvoiceLine[];
}

const decodeEntities = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const tagRegex = (tag: string, global = false): RegExp =>
  new RegExp(
    `<(?:(?:[\\w.-]+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${tag}>`,
    global ? "gi" : "i",
  );

const innerTag = (xml: string, tag: string): string | null => {
  const match = tagRegex(tag).exec(xml);
  return match ? match[1] : null;
};

const textTag = (xml: string, tag: string): string | null => {
  const inner = innerTag(xml, tag);
  if (inner == null) return null;
  const value = decodeEntities(inner.replace(/<[^>]*>/g, "")).trim();
  return value || null;
};

const blocksTag = (xml: string, tag: string): string[] => {
  const regex = tagRegex(tag, true);
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[1]);
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return blocks;
};

const hasTag = (xml: string, tag: string): boolean =>
  new RegExp(`<(?:[\\w.-]+:)?${tag}\\b`, "i").test(xml);

const hasBalancedTag = (xml: string, tag: string): boolean => {
  const open = (xml.match(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b`, "gi")) ?? []).length;
  const close = (xml.match(new RegExp(`<\\/(?:[\\w.-]+:)?${tag}>`, "gi")) ?? []).length;
  return open === close;
};

const parseNumber = (raw: string | null): number | null => {
  if (raw == null) return null;
  let value = raw.trim().replace(/\s/g, "").replace(/[^\d.,-]/g, "");
  if (!value) return null;
  if (value.startsWith("-")) value = `-${value.slice(1).replace(/-/g, "")}`;
  else value = value.replace(/-/g, "");

  const lastDot = value.lastIndexOf(".");
  const lastComma = value.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastDot > lastComma) value = value.replace(/,/g, "");
    else value = value.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    const parts = value.split(",");
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      value = parts.join("");
    } else {
      value = value.replace(",", ".");
    }
  } else if (lastDot >= 0) {
    const parts = value.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      value = parts.join("");
    }
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeInvoiceDate = (raw: string | null): string | null => {
  if (raw == null) return null;
  const value = raw.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  match = /^(\d{2})[/.-](\d{2})[/.-](\d{4})/.exec(value);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;

  match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  return null;
};

const readNumber = (xml: string, tag: string): number | null =>
  parseNumber(textTag(xml, tag));

export function parseVietnamEInvoiceXml(xml: string): VietnamEInvoice | null {
  try {    if (typeof xml !== "string" || !xml.trim()) return null;
    if (!hasTag(xml, "HDon") && !hasTag(xml, "DLHDon")) return null;
    for (const tag of ["HDon", "DLHDon", "TTChung", "NDHDon"]) {
      if (!hasBalancedTag(xml, tag)) return null;
    }

    const document = innerTag(xml, "DLHDon") ?? xml;
    const header = innerTag(document, "TTChung") ?? document;
    const content = innerTag(document, "NDHDon") ?? document;
    const sellerBlock = innerTag(content, "NBan") ?? content;
    const totalsBlock = innerTag(content, "TToan") ?? content;
    const lineContainer = innerTag(content, "DSHHDVu") ?? content;

    const sellerName = textTag(sellerBlock, "Ten");
    const sellerTaxCode = textTag(sellerBlock, "MST");
    const invoiceNumber = textTag(header, "SHDon");
    const invoiceSeries = textTag(header, "KHHDon") ?? textTag(header, "KHMSHDon");
    const invoiceDate = normalizeInvoiceDate(textTag(header, "NLap"));

    const subtotal = readNumber(totalsBlock, "TgTCThue");
    const vatAmount = readNumber(totalsBlock, "TgTThue");
    const totalAmount = readNumber(totalsBlock, "TgTTTBSo") ?? readNumber(totalsBlock, "TgTTTBTr");

    const lines: VietnamEInvoiceLine[] = blocksTag(lineContainer, "HHDVu").map((block) => {
      const name = textTag(block, "THHDVu") ?? textTag(block, "Ten");
      const unit = textTag(block, "DVTinh");
      const quantity = readNumber(block, "SLuong");
      const unitPrice = readNumber(block, "DGia");
      const amount = readNumber(block, "ThTien");
      const vatRate = readNumber(block, "TSuat") ?? readNumber(block, "TSuatVAT");
      return {
        name,
        unit,
        quantity,
        unit_price: unitPrice,
        unitPrice,
        amount,
        line_total: amount,
        vat_rate: vatRate,
        vatRate,
      };
    });

    if (
      sellerName == null
      && sellerTaxCode == null
      && invoiceNumber == null
      && invoiceSeries == null
      && totalAmount == null
      && subtotal == null
      && vatAmount == null
      && lines.length === 0
    ) {
      return null;
    }

    return {
      seller: {
        name: sellerName,
        tax_code: sellerTaxCode,
        taxCode: sellerTaxCode,
      },
      invoice_number: invoiceNumber,
      invoice_series: invoiceSeries,
      invoice_date: invoiceDate,
      invoiceNumber,
      invoiceSeries,
      invoiceDate,
      subtotal,
      vat_amount: vatAmount,
      vat: vatAmount,
      total_amount: totalAmount,
      total: totalAmount,
      lines,
    };
  } catch {
    return null;
  }
}

export default parseVietnamEInvoiceXml;
