export interface BarcodeBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProductLabelSpec {
  id?: string;
  sku_id: string;
  sku_code?: string | null;
  product_name?: string | null;
  barcode_value?: string | null;
  partner_product_code?: string | null;
  label_template_image_url?: string | null;
  label_template_image_path?: string | null;
  barcode_crop_image_url?: string | null;
  barcode_crop_image_path?: string | null;
  barcode_crop_bbox?: BarcodeBoundingBox | null;
  barcode_crop_confidence?: number | null;
  shelf_life_days: number;
  net_weight_value?: number | null;
  net_weight_unit?: string | null;
  traceability_sheet_url?: string | null;
  is_label_scan_required?: boolean | null;
}

export interface ExtractedProductLabelData {
  product_code?: string | null;
  barcode?: string | null;
  partner_product_code?: string | null;
  product_name?: string | null;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  net_weight_value?: number | null;
  net_weight_unit?: string | null;
  barcode_bbox?: BarcodeBoundingBox | null;
  barcode_crop_confidence?: number | null;
  barcode_crop_image_url?: string | null;
  barcode_visual_match?: boolean | null;
  barcode_visual_match_confidence?: number | null;
  barcode_visual_match_reason?: string | null;
  raw_text?: string | null;
}

export interface LabelDateExpectation {
  expectedNsx: string;
  expectedHsd: string;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const addDaysUtc = (dateKey: string, days: number) => {
  const match = dateKey.match(ISO_DATE_RE);
  if (!match) return dateKey;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const expectedLabelDates = (productionDateKey: string, shelfLifeDays: number): LabelDateExpectation => {
  const expectedNsx = addDaysUtc(productionDateKey, 1);
  const expectedHsd = addDaysUtc(expectedNsx, Math.max(1, shelfLifeDays) - 1);
  return { expectedNsx, expectedHsd };
};

// HSD offset rule is shelfLifeDays - 1 from expected NSX.
export const normalizeLabelDate = (value?: string | null) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  const iso = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const vn = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (vn) {
    const year = vn[3].length === 2 ? `20${vn[3]}` : vn[3];
    return `${year}-${vn[2].padStart(2, "0")}-${vn[1].padStart(2, "0")}`;
  }
  return null;
};

export const formatDateKeyVi = (value?: string | null) => {
  const normalized = normalizeLabelDate(value) || value;
  const match = normalized?.match(ISO_DATE_RE);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "-";
};

export const normalizeLabelIdentity = (value?: string | null) => {
  if (!value) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
};

const valuesMatch = (expected?: string | null, actual?: string | null) => {
  const expectedValue = normalizeLabelIdentity(expected);
  if (!expectedValue) return true;
  return expectedValue === normalizeLabelIdentity(actual);
};

export const evaluateLabelScan = ({
  spec,
  productionDateKey,
  extracted,
}: {
  spec?: ProductLabelSpec | null;
  productionDateKey: string;
  extracted?: ExtractedProductLabelData | null;
}) => {
  if (!spec) {
    return { passed: false, reason: "SKU chưa có cấu hình tem nhãn." };
  }
  const { expectedNsx, expectedHsd } = expectedLabelDates(productionDateKey, spec.shelf_life_days || 1);
  const nsx = normalizeLabelDate(extracted?.manufacturing_date);
  const hsd = normalizeLabelDate(extracted?.expiry_date);
  const weightOk =
    spec.net_weight_value == null ||
    extracted?.net_weight_value == null ||
    Math.abs(Number(extracted.net_weight_value) - Number(spec.net_weight_value)) <= 1;

  if (nsx !== expectedNsx) return { passed: false, reason: `NSX phải là ${formatDateKeyVi(expectedNsx)}.` };
  if (hsd !== expectedHsd) return { passed: false, reason: `HSD phải là ${formatDateKeyVi(expectedHsd)}.` };
  if (!weightOk) return { passed: false, reason: "Khối lượng trên tem lệch cấu hình SKU." };
  return { passed: true, reason: "Tem nhãn đạt NSX, HSD và trọng lượng." };
};

// Regression example: production day 06/06/2026 with shelf_life_days=3 => NSX 07/06/2026, HSD 09/06/2026.
