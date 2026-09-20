// Pure, dependency-injected core for the read-only Material Master learning
// suggestion endpoint.
//
// No network, database, Deno or Supabase imports live here, so the deterministic
// approved matching, the bounded candidate shortlist and the fail-safe review
// contract can be exercised with synthetic fixtures only. The transport and the
// owner-scoped data source are injected by the handler.
//
// Safety contract:
//   * exact approved matching runs in code BEFORE any model call;
//   * the model may only propose one of the offered active canonical candidates,
//     or answer none/ambiguous; an id outside the offered set is refused;
//   * Jev output is a suggestion that always requires explicit human review and
//     this server holds no write path, so no material or accounting write happens;
//   * raw request text is untrusted data; the model receives only a bounded raw
//     name/unit, the supplier display name and minimum material descriptors;
//   * budget, timeout and parent abort are enforced and a parent abort is rethrown.

export const MATERIAL_SUGGEST_MODEL = "typesafe-ai/jev";
export const MATERIAL_SUGGEST_PROMPT_VERSION = "material-suggest-2026-09-20.1";
export const MATERIAL_SUGGEST_REGISTRY_VERSION = "material-suggest-registry-2026-09-20.1";
export const MATERIAL_SUGGEST_MAX_SHORTLIST = 12;
export const MATERIAL_SUGGEST_MAX_MATERIALS = 1000;
export const MATERIAL_SUGGEST_MAX_RAW_NAME = 120;
export const MATERIAL_SUGGEST_MAX_UNIT = 24;
export const MATERIAL_SUGGEST_MAX_SUPPLIER_NAME = 80;
// Display-only floor for surfacing a model pick. It is deliberately independent
// from the chat planner's 0.6 floor and is NOT an approval threshold: this server
// has no write path, and every suggested NVL still needs explicit human
// confirmation through the existing controller RPC.
export const MATERIAL_SUGGEST_MIN_PROBABILITY = 0.5;

export class MaterialSuggestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.name = "MaterialSuggestError";
    this.code = code;
    this.status = status;
  }
}

export interface CandidateMaterial {
  id: string;
  material_code: string | null;
  canonical_name: string | null;
  normalized_name: string | null;
  default_unit: string | null;
  category: string | null;
  brand: string | null;
  specification: string | null;
  active?: boolean | null;
}

// Shared minimal serializable candidate contract. The browser hook/UI consumes
// exactly this shape (`material_id`), so the server never leaks its internal
// `id` field and the two layers cannot silently disagree on the candidate key.
export interface MaterialCandidateView {
  material_id: string;
  material_code: string | null;
  canonical_name: string | null;
  default_unit: string | null;
  category: string | null;
  brand: string | null;
  specification: string | null;
}

export const MATERIAL_CANDIDATE_REQUIRED_FIELDS = [
  "material_id",
  "material_code",
  "canonical_name",
  "default_unit",
  "category",
  "brand",
  "specification",
] as const;

export interface ScopedAliasRow {
  material_id: string;
  supplier_id: string | null;
  normalized_alias: string | null;
  approved: boolean | null;
  active: boolean | null;
}

export interface SupplierProductRow {
  material_id: string;
  supplier_id: string | null;
  normalized_supplier_product_name: string | null;
  purchase_unit: string | null;
  approved: boolean | null;
  active: boolean | null;
}

// Recognized legacy global aliases / source aliases carry no approval boolean of
// their own, so they are returned as *candidate knowledge with provenance* only and
// are never used to auto-resolve a raw line.
export interface LegacyAliasRow {
  material_id: string;
  normalized_alias: string | null;
  source: string | null;
  approved: boolean | null;
  active: boolean | null;
  supplier_id?: string | null;
  kind?: "legacy_global_alias" | "source_alias";
}

export interface MaterialEvidence {
  material_id: string;
  kind: "legacy_global_alias" | "source_alias";
  source: string | null;
  approved: boolean | null;
  matched_alias: string | null;
}

export interface MaterialMatchInput {
  request_id: string;
  raw_name: string;
  raw_code: string | null;
  raw_unit: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  source_type: string | null;
  materials: CandidateMaterial[];
  scoped_aliases: ScopedAliasRow[];
  supplier_products: SupplierProductRow[];
  legacy_aliases?: LegacyAliasRow[];
}

export interface MaterialMatch {
  kind: "exact" | "ambiguous" | "none";
  matched_by: string | null;
  material_id: string | null;
  candidates: CandidateMaterial[];
  reason: string | null;
}

export interface MaterialEvaluatorInput {
  raw_name: string;
  raw_unit: string | null;
  supplier_name: string | null;
  candidates: CandidateMaterial[];
}

export interface MaterialEvaluation {
  // A passed-through canonical material id, or the explicit none/ambiguous tokens.
  choice: string;
  probability: number;
}

export type MaterialEvaluator = (input: MaterialEvaluatorInput, signal: AbortSignal) => Promise<MaterialEvaluation>;

export interface MaterialSuggestJevAudit {
  attempted: boolean;
  model: string | null;
  prompt_version: string;
  registry_version: string;
  choice: string | null;
  probability: number | null;
  fallback: string | null;
}

export interface MaterialSuggestionResult {
  request_id: string;
  outcome: "exact" | "ambiguous" | "suggested" | "no_match" | "shortlist_only";
  matched_by: string | null;
  used_jev: boolean;
  requires_review: true;
  candidates: MaterialCandidateView[];
  candidate_count: number;
  total_candidate_count: number;
  shortlist_truncated: boolean;
  suggested_material_id: string | null;
  reason: string | null;
  evidence: MaterialEvidence[];
  jev: MaterialSuggestJevAudit | null;
}

export interface MaterialSuggestDataSource {
  loadMatchInput(requestId: string, signal: AbortSignal): Promise<MaterialMatchInput | null>;
}

export interface MaterialSuggestOptions {
  deadlineAt?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeMaterialKey(value?: string | null): string {
  const folded = (value ?? "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return folded.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Tone marks change only the tone of a vowel; shape marks (circumflex ``ô``, breve
// ``ă``, horn ``ơ``) change the letter itself. Folding every diacritic makes
// ``BỘ`` and ``BƠ`` both ``bo``, so an exact canonical match additionally requires
// the shape-preserving key to agree. An ASCII raw term can still match a stored
// ASCII normalized name, because its own shape is plain ASCII too.
const TONE_MARKS = /[\u0300\u0301\u0303\u0309\u0323]/g;
const NON_KEY = /[^a-z0-9\s\u0302\u0306\u031b]/g;

export function shapeMaterialKey(value?: string | null): string {
  const decomposed = (value ?? "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .toLowerCase();
  return decomposed.replace(TONE_MARKS, "").replace(NON_KEY, " ").replace(/\s+/g, " ").trim();
}

function canonicalNameMatches(name: string | null | undefined, key: string, shape: string): boolean {
  return Boolean(name) && normalizeMaterialKey(name) === key && shapeMaterialKey(name) === shape;
}

function boundedText(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function activeMaterials(materials: CandidateMaterial[]): CandidateMaterial[] {
  return materials.filter((material) => Boolean(material.id) && material.active !== false);
}

function candidatesByIds(materials: CandidateMaterial[], ids: Set<string>): CandidateMaterial[] {
  return materials.filter((material) => ids.has(material.id));
}

function boundedCandidates(materials: CandidateMaterial[]): CandidateMaterial[] {
  return materials.slice(0, MATERIAL_SUGGEST_MAX_SHORTLIST);
}

function overlapScore(material: CandidateMaterial, key: string): number {
  if (!key) return 0;
  const tokens = new Set(key.split(" "));
  const haystack = normalizeMaterialKey([
    material.canonical_name,
    material.material_code,
    material.brand,
    material.specification,
    material.category,
  ].filter(Boolean).join(" "));
  return haystack.split(" ").filter((token) => tokens.has(token)).length;
}

function shortlist(materials: CandidateMaterial[], key: string): { offered: CandidateMaterial[]; total: number; truncated: boolean } {
  const total = materials.length;
  if (total <= MATERIAL_SUGGEST_MAX_SHORTLIST) return { offered: materials, total, truncated: false };
  const ranked = [...materials].sort((left, right) => overlapScore(right, key) - overlapScore(left, key)
    || (left.canonical_name || "").localeCompare(right.canonical_name || "")
    || left.id.localeCompare(right.id));
  return { offered: ranked.slice(0, MATERIAL_SUGGEST_MAX_SHORTLIST), total, truncated: true };
}

// Deterministic, fail-safe matching. Precedence: exact canonical code, exact
// canonical name, an evidenced single-member canonical category, then a unique
// approved active supplier-scoped alias or supplier product. Any disagreement or
// multi-member category is ambiguous and never guessed; a group term such as
// "bơ" is compared only as a whole normalized token, so "BỘ PEERLESS" can never
// be folded into it.
export function matchMaterial(input: MaterialMatchInput): MaterialMatch {
  const materials = activeMaterials(input.materials);
  const key = normalizeMaterialKey(input.raw_name);
  if (!key) {
    return { kind: "none", matched_by: null, material_id: null, candidates: materials, reason: "raw_name_empty" };
  }

  const shape = shapeMaterialKey(input.raw_name);
  const codeKey = normalizeMaterialKey(input.raw_code);
  const codeMatches = codeKey ? materials.filter((material) => normalizeMaterialKey(material.material_code) === codeKey) : [];
  const nameMatches = materials.filter((material) => canonicalNameMatches(material.canonical_name, key, shape)
    || canonicalNameMatches(material.normalized_name, key, shape));
  // A code and a name that point at different canonical rows is a disagreement:
  // clarify instead of silently letting the code win.
  const combined = new Set([...codeMatches.map((material) => material.id), ...nameMatches.map((material) => material.id)]);
  if (combined.size > 1) {
    const source = codeMatches.length > 0 && nameMatches.length > 0 ? "canonical_code_name_conflict" : "canonical_name_conflict";
    return { kind: "ambiguous", matched_by: source, material_id: null, candidates: boundedCandidates([...codeMatches, ...nameMatches]), reason: "Mã và tên NVL không cùng trỏ về một dòng đang dùng." };
  }
  const canonical = codeMatches[0] || nameMatches[0] || null;
  const canonicalSource = codeMatches[0] ? "material_code" : nameMatches[0] ? "canonical_name" : null;

  const categoryMatches = materials.filter((material) => material.category && normalizeMaterialKey(material.category) === key);
  if (!canonical && categoryMatches.length > 0) {
    // A group term must never collapse onto a single SKU, not even a one-member
    // category: the evidenced membership is clarified, never guessed.
    return { kind: "ambiguous", matched_by: "canonical_category_group", material_id: null, candidates: boundedCandidates(categoryMatches), reason: "Tên này là một nhóm NVL; cần chọn đúng dòng cụ thể." };
  }

  const supplierId = input.supplier_id;
  const aliasTargets = new Set<string>();
  const productTargets = new Set<string>();
  if (supplierId) {
    for (const alias of input.scoped_aliases) {
      if (alias.approved !== true || alias.active !== true || alias.supplier_id !== supplierId) continue;
      if (alias.normalized_alias && normalizeMaterialKey(alias.normalized_alias) === key) aliasTargets.add(alias.material_id);
    }
    for (const product of input.supplier_products) {
      if (product.approved !== true || product.active !== true || product.supplier_id !== supplierId) continue;
      if (product.normalized_supplier_product_name && normalizeMaterialKey(product.normalized_supplier_product_name) === key) productTargets.add(product.material_id);
    }
  }
  const scopedIds = new Set([...aliasTargets, ...productTargets]);
  // Conflict is checked on the raw target set before any orphan/inactive filtering,
  // so a target that no longer exists cannot be silently erased to let another win.
  if (scopedIds.size > 1) {
    return { kind: "ambiguous", matched_by: "approved_supplier_mapping_conflict", material_id: null, candidates: boundedCandidates(candidatesByIds(materials, scopedIds)), reason: "Tên hàng Nhà cung cấp khớp nhiều NVL đã duyệt." };
  }
  const scopedTargetId = scopedIds.size === 1 ? [...scopedIds][0] : null;
  const scoped = scopedTargetId ? materials.find((material) => material.id === scopedTargetId) || null : null;
  const scopedSource = scoped ? (aliasTargets.size > 0 ? "approved_supplier_alias" : "approved_supplier_product") : null;
  const matchedProduct = scoped && supplierId
    ? input.supplier_products.find((product) => product.approved === true && product.active === true
      && product.supplier_id === supplierId && product.material_id === scoped.id
      && product.normalized_supplier_product_name
      && normalizeMaterialKey(product.normalized_supplier_product_name) === key) ?? null
    : null;

  const primary = canonical;
  if (primary && scoped && primary.id !== scoped.id) {
    return { kind: "ambiguous", matched_by: "canonical_scoped_conflict", material_id: null, candidates: boundedCandidates([primary, scoped]), reason: "Tên chuẩn và tên Nhà cung cấp đã duyệt trỏ về hai NVL khác nhau." };
  }
  if (primary) {
    return { kind: "exact", matched_by: canonicalSource, material_id: primary.id, candidates: [primary], reason: null };
  }
  if (scoped) {
    if (matchedProduct && packMismatch(input.raw_unit, matchedProduct.purchase_unit)) {
      return { kind: "ambiguous", matched_by: "unit_pack_mismatch", material_id: null, candidates: [scoped], reason: "Đơn vị/quy cách nguồn không khớp quy cách đã duyệt (ví dụ 2,5kg và 25kg); cần anh kiểm tra, không tự quy đổi." };
    }
    return { kind: "exact", matched_by: scopedSource, material_id: scoped.id, candidates: [scoped], reason: null };
  }
  return { kind: "none", matched_by: null, material_id: null, candidates: materials, reason: null };
}

function packSignature(value: string | null | undefined): { quantity: number; unit: string } | null {
  const match = (value ?? "").toLowerCase().replace(/,/g, ".").match(/^(\d+(?:\.\d+)?)\s*([a-z\u00e0-\u1ef9]+)/);
  if (!match) return null;
  return { quantity: Number(match[1]), unit: match[2] };
}

// A request unit such as "2.5kg" against an approved product purchase unit of
// "25kg" is a pack conflict: it must be surfaced as review evidence, never as an
// exact approved authority.
function packMismatch(requestUnit: string | null | undefined, approvedUnit: string | null | undefined): boolean {
  const requested = packSignature(requestUnit);
  const approved = packSignature(approvedUnit);
  return Boolean(requested && approved && requested.unit === approved.unit && requested.quantity !== approved.quantity);
}

function collectAliasEvidence(input: MaterialMatchInput, key: string, activeIds: Set<string>): MaterialEvidence[] {
  const evidence = new Map<string, MaterialEvidence>();
  for (const alias of input.legacy_aliases ?? []) {
    if (alias.active === false || !alias.material_id || !activeIds.has(alias.material_id)) continue;
    if (!alias.normalized_alias || normalizeMaterialKey(alias.normalized_alias) !== key) continue;
    const kind: MaterialEvidence["kind"] = alias.kind ?? (alias.supplier_id ? "source_alias" : "legacy_global_alias");
    evidence.set(`${kind}|${alias.material_id}|${alias.source ?? ""}`, {
      material_id: alias.material_id,
      kind,
      source: alias.source,
      approved: alias.approved ?? null,
      matched_alias: alias.normalized_alias,
    });
  }
  return [...evidence.values()];
}

function jevAudit(
  attempted: boolean,
  choice: string | null,
  probability: number | null,
  fallback: string | null,
): MaterialSuggestJevAudit {
  return {
    attempted,
    model: attempted ? MATERIAL_SUGGEST_MODEL : null,
    prompt_version: MATERIAL_SUGGEST_PROMPT_VERSION,
    registry_version: MATERIAL_SUGGEST_REGISTRY_VERSION,
    choice,
    probability,
    fallback,
  };
}

function toCandidateView(material: CandidateMaterial): MaterialCandidateView {
  return {
    material_id: material.id,
    material_code: material.material_code ?? null,
    canonical_name: material.canonical_name ?? null,
    default_unit: material.default_unit ?? null,
    category: material.category ?? null,
    brand: material.brand ?? null,
    specification: material.specification ?? null,
  };
}

function buildResult(
  requestId: string,
  outcome: MaterialSuggestionResult["outcome"],
  matchedBy: string | null,
  candidates: CandidateMaterial[],
  totalCandidates: number,
  suggestedMaterialId: string | null,
  reason: string | null,
  usedJev: boolean,
  jev: MaterialSuggestJevAudit | null,
  evidence: MaterialEvidence[] = [],
): MaterialSuggestionResult {
  const offered = boundedCandidates(candidates).map(toCandidateView);
  return {
    request_id: requestId,
    outcome,
    matched_by: matchedBy,
    used_jev: usedJev,
    requires_review: true,
    candidates: offered,
    candidate_count: offered.length,
    total_candidate_count: totalCandidates,
    shortlist_truncated: totalCandidates > offered.length,
    suggested_material_id: suggestedMaterialId,
    reason,
    evidence,
    jev,
  };
}

export async function suggestMaterialResolution(
  dataSource: MaterialSuggestDataSource,
  evaluator: MaterialEvaluator | null,
  requestId: string,
  signal: AbortSignal,
  options: MaterialSuggestOptions = {},
): Promise<MaterialSuggestionResult> {
  const id = (requestId ?? "").trim();
  if (!UUID_PATTERN.test(id)) throw new MaterialSuggestError("invalid_request_id", 400);
  signal.throwIfAborted();

  const input = await dataSource.loadMatchInput(id, signal);
  if (!input) throw new MaterialSuggestError("request_not_found", 404);
  if (input.materials.length > MATERIAL_SUGGEST_MAX_MATERIALS) throw new MaterialSuggestError("candidate_catalog_truncated", 503);
  signal.throwIfAborted();

  const match = matchMaterial(input);
  if (match.kind === "exact") {
    return buildResult(id, "exact", match.matched_by, match.candidates, 1, match.material_id, null, false, null);
  }

  const key = normalizeMaterialKey(input.raw_name);
  const activeIds = new Set(activeMaterials(input.materials).map((material) => material.id));
  // Recognized legacy/source alias knowledge is offered as provenance evidence on
  // review outcomes; it never becomes an automatic resolution.
  const evidence = collectAliasEvidence(input, key, activeIds);
  if (match.kind === "ambiguous") {
    return buildResult(id, "ambiguous", match.matched_by, match.candidates, match.candidates.length, null, match.reason, false, null, evidence);
  }

  const { offered, total, truncated } = shortlist(activeMaterials(input.materials), key);
  const shortlistReason = "Chưa có khớp đã duyệt. Danh sách dưới đây chỉ là ứng viên để anh chọn.";

  if (!evaluator) {
    return buildResult(id, "shortlist_only", null, offered, total, null, shortlistReason, false, jevAudit(false, null, null, "jev_disabled"), evidence);
  }
  const remaining = options.deadlineAt === undefined ? Infinity : options.deadlineAt - Date.now();
  if (remaining <= 0) {
    return buildResult(id, "shortlist_only", null, offered, total, null, shortlistReason, false, jevAudit(false, null, null, "material_jev_deadline_exceeded"), evidence);
  }

  let evaluation: MaterialEvaluation;
  try {
    evaluation = await evaluator({
      raw_name: boundedText(input.raw_name, MATERIAL_SUGGEST_MAX_RAW_NAME) ?? "",
      raw_unit: boundedText(input.raw_unit, MATERIAL_SUGGEST_MAX_UNIT),
      supplier_name: boundedText(input.supplier_name, MATERIAL_SUGGEST_MAX_SUPPLIER_NAME),
      candidates: offered,
    }, signal);
  } catch (error) {
    // Parent cancellation is an abort, never a silent fallback.
    signal.throwIfAborted();
    const fallback = error instanceof MaterialSuggestError ? error.code : "material_jev_unavailable";
    return buildResult(id, "shortlist_only", null, offered, total, null, `${shortlistReason} AI chưa trả kết quả dùng được.`, true, jevAudit(true, null, null, fallback), evidence);
  }
  signal.throwIfAborted();

  const probability = Number.isFinite(evaluation.probability) ? evaluation.probability : null;
  if (evaluation.choice === "none") {
    return buildResult(id, "no_match", null, offered, total, null, "AI không thấy NVL đang dùng nào phù hợp; anh vẫn có thể chọn thủ công.", true, jevAudit(true, "none", probability, null), evidence);
  }
  if (evaluation.choice === "ambiguous") {
    return buildResult(id, "ambiguous", "material_jev_ambiguous", offered, total, null, "AI thấy nhiều NVL cùng phù hợp; cần anh chọn.", true, jevAudit(true, "ambiguous", probability, null), evidence);
  }
  const suggested = offered.find((material) => material.id === evaluation.choice) || null;
  if (!suggested) {
    return buildResult(id, "shortlist_only", null, offered, total, null, `${shortlistReason} AI trả về NVL không nằm trong danh sách đã đề xuất.`, true, jevAudit(true, null, null, "material_jev_unknown_candidate"), evidence);
  }
  if (probability !== null && probability < MATERIAL_SUGGEST_MIN_PROBABILITY) {
    return buildResult(id, "shortlist_only", null, offered, total, null, `${shortlistReason} Độ tin cậy của AI thấp nên không đề xuất tự động.`, true, jevAudit(true, suggested.id, probability, "material_jev_below_display_floor"), evidence);
  }
  return buildResult(id, "suggested", "material_jev", offered, total, suggested.id, "AI đề xuất một NVL; anh phải tự kiểm tra rồi bấm lưu.", true, jevAudit(true, suggested.id, probability, null), evidence);
}
