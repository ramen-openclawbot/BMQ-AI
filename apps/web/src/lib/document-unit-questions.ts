/**
 * Pure helpers for the document-unit question game (batch 2026-10-20).
 *
 * The server is authoritative: these helpers only turn the jsonb returned by
 *   public.get_document_unit_questions(text)
 *   public.answer_document_unit_question(uuid, text, numeric, text, text)
 * into safe values instead of a fake success.  normalizeDocumentUnit mirrors
 * public.normalize_document_unit() exactly.
 */

export type DocumentUnitQuestionStatus = "open" | "answered" | "skipped";
export type DocumentUnitAnswerAction = "factor" | "misread" | "skip";

export interface DocumentUnitCandidate {
  factor: number;
  source: string;
  alias_id: string | null;
  /** Every step used to build the factor, e.g. game label + standard step. */
  sources?: string[];
}

export interface DocumentUnitSampleLine {
  table: string;
  line_id: string;
  document_number: string | null;
  document_date: string | null;
  product_name: string;
  qty: number;
  unit: string;
  unit_price: number | null;
  supplier_name: string | null;
  image_path: string | null;
  created_at?: string | null;
}

export interface DocumentUnitQuestionMaterial {
  id: string;
  material_code: string | null;
  canonical_name: string;
  default_unit: string;
}

export interface DocumentUnitQuestion {
  id: string;
  batch: string;
  material_id: string;
  doc_unit: string;
  doc_unit_normalized: string;
  default_unit: string;
  line_count: number;
  candidates: DocumentUnitCandidate[];
  sample_lines: DocumentUnitSampleLine[];
  status: DocumentUnitQuestionStatus;
  action: DocumentUnitAnswerAction | null;
  factor: number | null;
  actual_unit: string | null;
  reason: string | null;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string | null;
  material: DocumentUnitQuestionMaterial | null;
  /** True when the answer RPC replayed an already answered/skipped question. */
  replay: boolean;
}

export interface DocumentUnitAnswerInput {
  action: DocumentUnitAnswerAction;
  factor?: number | null;
  actualUnit?: string | null;
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// Unit normalization (must mirror public.normalize_document_unit)
// ---------------------------------------------------------------------------

export function normalizeDocumentUnit(value: string | null | undefined): string {
  let unit = String(value ?? "").toLowerCase().trim();
  unit = unit.replace(/\s+/g, " ");

  // The whole spelling is "(kg)".
  unit = unit.replace(/^\(\s*kg\s*\)$/, "kg");
  // A package marker is not part of the unit.
  unit = unit.replace(/\s*\(\s*pack\s*\)\s*$/i, "");
  // Other parenthetical annotations are dropped too.
  unit = unit.replace(/\([^()]*\)/g, "");
  unit = unit.replace(/[()]/g, "");
  unit = unit.replace(/\s+/g, " ").trim();

  switch (unit) {
    case "ky":
    case "ký":
      return "kg";
    case "kilogram":
      return "kg";
    case "b bao":
      return "bao";
    case "hop":
    case "hôp":
      return "hộp";
    case "hộp":
      return "hộp";
    default:
      return unit;
  }
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${path} must be a string or null`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${path} must be a finite number`);
  return numeric;
}

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

function parseStatus(value: unknown, path: string): DocumentUnitQuestionStatus {
  if (value === "open" || value === "answered" || value === "skipped") return value;
  throw new TypeError(`${path} must be one of open, answered, skipped`);
}

function parseAction(value: unknown, path: string): DocumentUnitAnswerAction | null {
  if (value === null || value === undefined) return null;
  if (value === "factor" || value === "misread" || value === "skip") return value;
  throw new TypeError(`${path} must be one of factor, misread, skip`);
}

function parseCandidate(value: unknown, path: string): DocumentUnitCandidate | null {
  if (!isRecord(value)) return null;
  const factor = typeof value.factor === "number" ? value.factor : Number(value.factor);
  if (!Number.isFinite(factor) || factor <= 0) return null;

  const source = typeof value.source === "string" ? value.source : "standard_auto";
  const rawSources = Array.isArray(value.sources) ? value.sources : [];
  const sources = rawSources.filter((entry): entry is string => typeof entry === "string");
  const aliasId = typeof value.alias_id === "string" ? value.alias_id : null;

  return {
    factor,
    source,
    alias_id: aliasId,
    sources: sources.length > 0 ? sources : [source],
  };
}

function parseSampleLine(value: unknown, path: string): DocumentUnitSampleLine | null {
  if (!isRecord(value)) return null;
  const table = typeof value.table === "string" ? value.table : null;
  const lineId = typeof value.line_id === "string" ? value.line_id : null;
  const productName = typeof value.product_name === "string" ? value.product_name : null;
  const unit = typeof value.unit === "string" ? value.unit : null;
  if (table === null || lineId === null || productName === null || unit === null) return null;

  const qty = typeof value.qty === "number" ? value.qty : Number(value.qty);
  if (!Number.isFinite(qty)) return null;

  let unitPrice: number | null = null;
  if (typeof value.unit_price === "number" && Number.isFinite(value.unit_price)) {
    unitPrice = value.unit_price;
  } else if (typeof value.unit_price === "string" && value.unit_price.trim() !== "") {
    const parsed = Number(value.unit_price);
    if (Number.isFinite(parsed)) unitPrice = parsed;
  }

  return {
    table,
    line_id: lineId,
    document_number: typeof value.document_number === "string" ? value.document_number : null,
    document_date: typeof value.document_date === "string" ? value.document_date : null,
    product_name: productName,
    qty,
    unit,
    unit_price: unitPrice,
    supplier_name: typeof value.supplier_name === "string" ? value.supplier_name : null,
    image_path: typeof value.image_path === "string" ? value.image_path : null,
    created_at: typeof value.created_at === "string" ? value.created_at : null,
  };
}

function parseMaterial(value: unknown): DocumentUnitQuestionMaterial | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.canonical_name !== "string") return null;
  return {
    id: value.id,
    material_code: typeof value.material_code === "string" ? value.material_code : null,
    canonical_name: value.canonical_name,
    default_unit: typeof value.default_unit === "string" ? value.default_unit : "",
  };
}

/** One question row; a replay answer carries the same shape plus `replay`. */
export function parseDocumentUnitQuestion(
  raw: unknown,
  path = "documentUnitQuestion",
): DocumentUnitQuestion {
  const row = asRecord(raw, path);
  const candidatesRaw = Array.isArray(row.candidates) ? row.candidates : [];
  const samplesRaw = Array.isArray(row.sample_lines) ? row.sample_lines : [];

  return {
    id: asString(row.id, `${path}.id`),
    batch: asString(row.batch, `${path}.batch`),
    material_id: asString(row.material_id, `${path}.material_id`),
    doc_unit: asString(row.doc_unit, `${path}.doc_unit`),
    doc_unit_normalized: asString(row.doc_unit_normalized, `${path}.doc_unit_normalized`),
    default_unit: asString(row.default_unit, `${path}.default_unit`),
    line_count: asNumber(row.line_count, `${path}.line_count`),
    candidates: candidatesRaw
      .map((entry, index) => parseCandidate(entry, `${path}.candidates[${index}]`))
      .filter((entry): entry is DocumentUnitCandidate => entry !== null),
    sample_lines: samplesRaw
      .map((entry, index) => parseSampleLine(entry, `${path}.sample_lines[${index}]`))
      .filter((entry): entry is DocumentUnitSampleLine => entry !== null),
    status: parseStatus(row.status, `${path}.status`),
    action: parseAction(row.action, `${path}.action`),
    factor: asNullableNumber(row.factor, `${path}.factor`),
    actual_unit: asNullableString(row.actual_unit, `${path}.actual_unit`),
    reason: asNullableString(row.reason, `${path}.reason`),
    answered_by: asNullableString(row.answered_by, `${path}.answered_by`),
    answered_at: asNullableString(row.answered_at, `${path}.answered_at`),
    created_at: asNullableString(row.created_at, `${path}.created_at`),
    material: parseMaterial(row.material),
    replay: row.replay === true,
  };
}

/**
 * Parse the jsonb returned by get_document_unit_questions (a bare array).
 * A `{questions: [...]}` wrapper and null are tolerated, and a broken row is
 * skipped instead of hiding the whole batch.
 */
export function parseDocumentUnitQuestions(raw: unknown): DocumentUnitQuestion[] {
  if (raw === null || raw === undefined) return [];
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (isRecord(raw) && Array.isArray(raw.questions)) {
    list = raw.questions;
  } else {
    return [];
  }

  const out: DocumentUnitQuestion[] = [];
  for (const entry of list) {
    try {
      out.push(parseDocumentUnitQuestion(entry));
    } catch {
      // A corrupt row must not hide the rest of the batch.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display + validation
// ---------------------------------------------------------------------------

function formatFactor(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const fixed = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed.replace(".", ",");
}

/** "100 (từ game)", "0,04 (game + đổi chuẩn)", "0,2 (đổi chuẩn)". */
export function candidateLabel(
  candidate: Pick<DocumentUnitCandidate, "factor" | "source" | "sources">,
): string {
  const used = new Set<string>([candidate.source, ...(candidate.sources ?? [])]);
  const hasGame = used.has("game_alias_factor");
  const hasStandard = used.has("standard_auto");
  const hasMisread = used.has("misread_standard");
  const hasApproved = used.has("approved_conversion");

  let description: string;
  if (hasGame && hasStandard) {
    description = "game + đổi chuẩn";
  } else if (hasGame) {
    description = "từ game";
  } else if (hasMisread) {
    description = "đọc sai + đổi chuẩn";
  } else if (hasApproved) {
    description = "quy đổi đã duyệt";
  } else if (hasStandard) {
    description = "đổi chuẩn";
  } else {
    description = candidate.source === "approved_conversion" ? "quy đổi đã duyệt" : "đổi chuẩn";
  }

  return `${formatFactor(candidate.factor)} (${description})`;
}

/** Short Vietnamese validation error, or null when the answer can be sent. */
export function validateAnswer(
  action: DocumentUnitAnswerAction | string,
  factor?: number | null,
  actualUnit?: string | null,
): string | null {
  const normalized = String(action ?? "").trim().toLowerCase();

  if (normalized === "skip") return null;

  if (normalized === "factor") {
    if (factor === null || factor === undefined || !Number.isFinite(factor) || factor <= 0) {
      return "Hệ số phải lớn hơn 0";
    }
    return null;
  }

  if (normalized === "misread") {
    if (actualUnit === null || actualUnit === undefined || actualUnit.trim() === "") {
      return "Cần nhập đơn vị thực tế";
    }
    if (factor !== null && factor !== undefined && (!Number.isFinite(factor) || factor <= 0)) {
      return "Hệ số phải lớn hơn 0";
    }
    return null;
  }

  return "Thao tác không hợp lệ";
}
