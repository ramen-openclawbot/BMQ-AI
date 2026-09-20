// Shared, dependency-free contract for the read-only Material Master learning
// suggestion response.
//
// The server core (`supabase/functions/material-learning-suggest/material-suggest.ts`)
// emits candidates under `material_id`; this module is the browser-side parser that
// validates that exact serializable shape before the UI can use it. It has no
// imports, so the same parser can be exercised against a real server response in a
// cross-layer integration test.

export interface MaterialLearningCandidate {
  material_id: string;
  material_code: string | null;
  canonical_name: string | null;
  default_unit: string | null;
  category: string | null;
  brand: string | null;
  specification: string | null;
}

export interface MaterialLearningEvidence {
  material_id: string;
  kind: "legacy_global_alias" | "source_alias";
  source: string | null;
  approved: boolean | null;
  matched_alias: string | null;
}

export interface MaterialLearningSuggestion {
  request_id: string;
  outcome: "exact" | "ambiguous" | "suggested" | "no_match" | "shortlist_only" | "unavailable";
  matched_by: string | null;
  used_jev: boolean;
  requires_review: true;
  candidates: MaterialLearningCandidate[];
  candidate_count: number;
  total_candidate_count: number;
  shortlist_truncated: boolean;
  suggested_material_id: string | null;
  reason: string | null;
  evidence: MaterialLearningEvidence[];
  jev: {
    attempted: boolean;
    model: string | null;
    prompt_version: string | null;
    registry_version: string | null;
    choice: string | null;
    probability: number | null;
    fallback: string | null;
  } | null;
}

const OUTCOMES = new Set(["exact", "ambiguous", "suggested", "no_match", "shortlist_only", "unavailable"]);
// Every candidate field is required to be present; the text fields may be null but
// must never be an unexpected type or `undefined`.
export const MATERIAL_LEARNING_CANDIDATE_FIELDS = [
  "material_id",
  "material_code",
  "canonical_name",
  "default_unit",
  "category",
  "brand",
  "specification",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(record: Record<string, unknown>, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(record, field)) throw new Error(`Gợi ý NVL thiếu trường ứng viên: ${field}.`);
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Gợi ý NVL có trường ứng viên sai kiểu: ${field}.`);
  return value;
}

function parseCandidate(value: unknown): MaterialLearningCandidate {
  if (!isRecord(value)) throw new Error("Gợi ý NVL có ứng viên không hợp lệ.");
  const materialId = nullableString(value, "material_id");
  if (!materialId || !materialId.trim()) throw new Error("Gợi ý NVL trả về ứng viên thiếu material_id.");
  return {
    material_id: materialId,
    material_code: nullableString(value, "material_code"),
    canonical_name: nullableString(value, "canonical_name"),
    default_unit: nullableString(value, "default_unit"),
    category: nullableString(value, "category"),
    brand: nullableString(value, "brand"),
    specification: nullableString(value, "specification"),
  };
}

function parseEvidence(value: unknown): MaterialLearningEvidence[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Gợi ý NVL trả sai danh sách bằng chứng.");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("Gợi ý NVL có bằng chứng không hợp lệ.");
    const materialId = entry.material_id;
    if (typeof materialId !== "string" || !materialId.trim()) throw new Error("Bằng chứng NVL thiếu material_id.");
    if (entry.kind !== "legacy_global_alias" && entry.kind !== "source_alias") throw new Error("Bằng chứng NVL sai loại.");
    return {
      material_id: materialId,
      kind: entry.kind,
      source: nullableString(entry, "source"),
      approved: typeof entry.approved === "boolean" ? entry.approved : null,
      matched_alias: nullableString(entry, "matched_alias"),
    };
  });
}

/**
 * Validate the serializable server response and return the typed browser value.
 * Throws when the payload does not belong to `requestId`, has an invalid outcome,
 * has an undefined/duplicated candidate id, or points at an id outside the offered
 * candidate set.
 */
export function parseMaterialLearningSuggestion(raw: unknown, requestId: string): MaterialLearningSuggestion {
  if (!isRecord(raw)) throw new Error("Gợi ý NVL trả dữ liệu không hợp lệ.");
  if (raw.request_id !== requestId) throw new Error("Gợi ý trả sai dòng cần xác nhận.");
  const outcome = raw.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) throw new Error("Gợi ý NVL trả kết quả không hợp lệ.");
  if (!Array.isArray(raw.candidates)) throw new Error("Gợi ý NVL thiếu danh sách ứng viên.");

  const candidates = raw.candidates.map(parseCandidate);
  const offered = new Set<string>();
  for (const candidate of candidates) {
    if (offered.has(candidate.material_id)) throw new Error("Gợi ý NVL trả về ứng viên trùng material_id.");
    offered.add(candidate.material_id);
  }

  const candidateCount = raw.candidate_count;
  const totalCandidateCount = raw.total_candidate_count;
  if (typeof candidateCount !== "number" || !Number.isInteger(candidateCount) || candidateCount < 0) {
    throw new Error("Gợi ý NVL thiếu số ứng viên hợp lệ.");
  }
  if (typeof totalCandidateCount !== "number" || !Number.isInteger(totalCandidateCount) || totalCandidateCount < candidateCount) {
    throw new Error("Gợi ý NVL thiếu tổng số ứng viên hợp lệ.");
  }
  if (candidateCount !== candidates.length) throw new Error("Gợi ý NVL có số ứng viên không khớp danh sách.");
  if (typeof raw.shortlist_truncated !== "boolean") throw new Error("Gợi ý NVL thiếu cờ giới hạn ứng viên.");

  const suggested = raw.suggested_material_id;
  if (suggested !== null && typeof suggested !== "string") throw new Error("Gợi ý NVL trả sai mã NVL đề xuất.");
  if (typeof suggested === "string" && !offered.has(suggested)) {
    throw new Error("Gợi ý trả về NVL không nằm trong danh sách đã đề xuất.");
  }
  if (typeof raw.requires_review !== "boolean" || raw.requires_review !== true) throw new Error("Gợi ý NVL thiếu cờ cần xác nhận.");
  if (typeof raw.used_jev !== "boolean") throw new Error("Gợi ý NVL thiếu cờ đã dùng AI.");
  if (raw.matched_by !== null && typeof raw.matched_by !== "string") throw new Error("Gợi ý NVL trả sai nguồn khớp.");
  if (raw.reason !== null && typeof raw.reason !== "string") throw new Error("Gợi ý NVL trả sai lý do.");
  if (raw.jev !== null && !isRecord(raw.jev)) throw new Error("Gợi ý NVL trả sai thông tin AI.");

  return {
    request_id: requestId,
    outcome: outcome as MaterialLearningSuggestion["outcome"],
    matched_by: (raw.matched_by ?? null) as string | null,
    used_jev: raw.used_jev,
    requires_review: true,
    candidates,
    candidate_count: candidateCount,
    total_candidate_count: totalCandidateCount,
    shortlist_truncated: raw.shortlist_truncated,
    suggested_material_id: (suggested ?? null) as string | null,
    reason: (raw.reason ?? null) as string | null,
    evidence: parseEvidence(raw.evidence),
    jev: (raw.jev ?? null) as MaterialLearningSuggestion["jev"],
  };
}
