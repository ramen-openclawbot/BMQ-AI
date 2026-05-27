export type StandardCostCodeType = "NVL" | "OPEX" | "OTHER";
export type CostReviewRouting = "none" | "needs_review";
export type ProductLine = "bmq_bread" | "sweet_kitchen" | "shared" | "general";
export type AllocationRule = "direct" | "manual" | "none";

export type OcrCostLineInput = {
  rawProductName: string;
  productCode?: string | null;
  unit?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  supplierId?: string | null;
  documentType?: "payment_request" | "invoice" | "goods_receipt" | string;
};

export type CostItemAliasMapping = {
  id?: string | null;
  source_name?: string | null;
  source_name_key: string;
  supplier_id?: string | null;
  standard_cost_code_type?: StandardCostCodeType | null;
  standard_cost_code?: string | null;
  canonical_cost_item_name?: string | null;
  category_code?: string | null;
  product_line?: ProductLine | string | null;
  allocation_rule?: AllocationRule | string | null;
  unit_conversion_note?: string | null;
  matched_finished_skus?: string[] | null;
  mapping_status?: string | null;
  active?: boolean | null;
  source_sheet_url?: string | null;
  source_review_note?: string | null;
};

export type OcrCostClassification = {
  raw_product_name: string;
  suggested_standard_cost_code: string | null;
  confirmed_standard_cost_code: string | null;
  standard_cost_code_type: StandardCostCodeType | null;
  canonical_cost_item_name: string | null;
  canonical_cost_item_source: "approved_alias" | "direct_standard_code" | "manual_override" | "fallback_ocr";
  cost_category_code: string;
  cost_product_line: ProductLine;
  cost_allocation_rule: AllocationRule;
  cost_review_routing: CostReviewRouting;
  unit_conversion_note: string | null;
  matched_finished_skus: string[];
  ocr_classification_json: Record<string, unknown>;
};

export type OcrCostClassifierResult = {
  resolved: boolean;
  display_standard_cost_label: string | null;
  classification: OcrCostClassification;
};

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export function normalizeOcrCostKey(value: unknown): string {
  return String(value || "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeStandardCode(value: unknown): string {
  return String(value || "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function formatStandardCostLabel(
  codeType: StandardCostCodeType | null | undefined,
  code: string | null | undefined,
  canonicalName: string | null | undefined,
): string | null {
  if (!codeType || !code || !canonicalName) return null;
  return `${codeType} · ${code} — ${canonicalName}`;
}

function asProductLine(value: unknown): ProductLine {
  if (value === "bmq_bread" || value === "sweet_kitchen" || value === "shared" || value === "general") return value;
  return "general";
}

function asAllocationRule(value: unknown): AllocationRule {
  if (value === "direct" || value === "manual" || value === "none") return value;
  return "manual";
}

function isApprovedMapping(row: CostItemAliasMapping): boolean {
  return row.active !== false && row.mapping_status === "approved" && !!row.standard_cost_code_type && !!row.standard_cost_code;
}

function supplierRank(row: CostItemAliasMapping, supplierId?: string | null): number {
  if (!row.supplier_id || row.supplier_id === ZERO_UUID) return 1;
  if (supplierId && row.supplier_id === supplierId) return 2;
  return 0;
}

function chooseSingleMapping(
  rows: CostItemAliasMapping[],
  supplierId?: string | null,
): { mapping: CostItemAliasMapping | null; ambiguous: boolean } {
  const candidates = rows
    .filter(isApprovedMapping)
    .map((row) => ({ row, rank: supplierRank(row, supplierId) }))
    .filter((item) => item.rank > 0)
    .sort((a, b) => b.rank - a.rank);

  if (!candidates.length) return { mapping: null, ambiguous: false };

  const topRank = candidates[0].rank;
  const top = candidates.filter((item) => item.rank === topRank).map((item) => item.row);
  const uniqueCodes = new Set(top.map((row) => `${row.standard_cost_code_type}:${row.standard_cost_code}`));
  if (uniqueCodes.size > 1) return { mapping: null, ambiguous: true };
  return { mapping: top[0], ambiguous: false };
}

function fallbackResult(input: OcrCostLineInput, reason: string, extra: Record<string, unknown> = {}): OcrCostClassifierResult {
  const rawName = String(input.rawProductName || "").trim();
  return {
    resolved: false,
    display_standard_cost_label: null,
    classification: {
      raw_product_name: rawName,
      suggested_standard_cost_code: null,
      confirmed_standard_cost_code: null,
      standard_cost_code_type: null,
      canonical_cost_item_name: rawName || null,
      canonical_cost_item_source: "fallback_ocr",
      cost_category_code: "UNMAPPED_REVIEW",
      cost_product_line: "general",
      cost_allocation_rule: "manual",
      cost_review_routing: "needs_review",
      unit_conversion_note: null,
      matched_finished_skus: [],
      ocr_classification_json: {
        classifier_version: "ocr-standard-cost-v1",
        source: "fallback_ocr",
        reason,
        document_type: input.documentType || null,
        product_code: input.productCode || null,
        unit: input.unit || null,
        quantity: input.quantity ?? null,
        unit_price: input.unitPrice ?? null,
        ...extra,
      },
    },
  };
}

function resultFromMapping(
  input: OcrCostLineInput,
  mapping: CostItemAliasMapping,
  source: "approved_alias" | "direct_standard_code",
): OcrCostClassifierResult {
  const codeType = mapping.standard_cost_code_type || null;
  const code = mapping.standard_cost_code || null;
  const canonicalName = mapping.canonical_cost_item_name || mapping.source_name || String(input.rawProductName || "").trim();
  return {
    resolved: true,
    display_standard_cost_label: formatStandardCostLabel(codeType, code, canonicalName),
    classification: {
      raw_product_name: String(input.rawProductName || "").trim(),
      suggested_standard_cost_code: code,
      confirmed_standard_cost_code: code,
      standard_cost_code_type: codeType,
      canonical_cost_item_name: canonicalName || null,
      canonical_cost_item_source: source,
      cost_category_code: mapping.category_code || "UNMAPPED_REVIEW",
      cost_product_line: asProductLine(mapping.product_line),
      cost_allocation_rule: asAllocationRule(mapping.allocation_rule),
      cost_review_routing: "none",
      unit_conversion_note: mapping.unit_conversion_note || null,
      matched_finished_skus: Array.isArray(mapping.matched_finished_skus) ? mapping.matched_finished_skus : [],
      ocr_classification_json: {
        classifier_version: "ocr-standard-cost-v1",
        source,
        mapping_id: mapping.id || null,
        source_name: mapping.source_name || null,
        source_name_key: mapping.source_name_key || null,
        source_sheet_url: mapping.source_sheet_url || null,
        source_review_note: mapping.source_review_note || null,
        document_type: input.documentType || null,
        product_code: input.productCode || null,
        unit: input.unit || null,
        quantity: input.quantity ?? null,
        unit_price: input.unitPrice ?? null,
      },
    },
  };
}

export function classifyOcrCostLineFromMappings(
  input: OcrCostLineInput,
  mappings: CostItemAliasMapping[],
): OcrCostClassifierResult {
  const rawName = String(input.rawProductName || "").trim();
  if (!rawName) return fallbackResult(input, "empty_raw_product_name");

  const rawKey = normalizeOcrCostKey(rawName);
  const aliasMatches = mappings.filter((row) => normalizeOcrCostKey(row.source_name_key) === rawKey);
  const aliasChoice = chooseSingleMapping(aliasMatches, input.supplierId);
  if (aliasChoice.ambiguous) return fallbackResult(input, "ambiguous_approved_alias", { source_name_key: rawKey });
  if (aliasChoice.mapping) return resultFromMapping(input, aliasChoice.mapping, "approved_alias");

  const codeCandidates = [input.productCode, rawName]
    .map(normalizeStandardCode)
    .filter(Boolean);
  if (codeCandidates.length) {
    const directMatches = mappings.filter((row) => {
      if (!isApprovedMapping(row)) return false;
      return codeCandidates.includes(normalizeStandardCode(row.standard_cost_code));
    });
    const directChoice = chooseSingleMapping(directMatches, input.supplierId);
    if (directChoice.ambiguous) return fallbackResult(input, "ambiguous_direct_standard_code", { product_code: input.productCode || null });
    if (directChoice.mapping) return resultFromMapping(input, directChoice.mapping, "direct_standard_code");
  }

  const reviewRows = mappings.filter((row) => row.active !== false && normalizeOcrCostKey(row.source_name_key) === rawKey);
  if (reviewRows.some((row) => row.mapping_status === "needs_review")) {
    return fallbackResult(input, "existing_mapping_needs_review", { source_name_key: rawKey });
  }

  return fallbackResult(input, "no_approved_mapping", { source_name_key: rawKey });
}

export function toCostLinePayload(result: OcrCostClassifierResult): Record<string, unknown> {
  return { ...result.classification };
}

export async function fetchApprovedCostItemAliasMappings(
  supabaseClient: {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (column: string, value: unknown) => {
          limit: (count: number) => Promise<{ data: CostItemAliasMapping[] | null; error: { message?: string } | null }>;
        };
      };
    };
  },
  limit = 2000,
): Promise<CostItemAliasMapping[]> {
  const { data, error } = await supabaseClient
    .from("cost_item_alias_mappings")
    .select(
      "id,source_name,source_name_key,supplier_id,standard_cost_code_type,standard_cost_code,canonical_cost_item_name,category_code,product_line,allocation_rule,unit_conversion_note,matched_finished_skus,mapping_status,active,source_sheet_url,source_review_note",
    )
    .eq("active", true)
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load cost item alias mappings: ${error.message || "unknown error"}`);
  }

  return (data || []).filter(isApprovedMapping);
}
