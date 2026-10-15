// Shared robot-feedback memory for the edge functions.
//
// Every human rejection / override of a robot suggestion is stored in
// public.robot_feedback (kind + subject_key + robot_choice). This module builds
// the exact same subject keys the SQL triggers build, loads the relevant rows
// through the service-role RPC and renders the short correction lines that go
// back into the question text. It is pure except for the injected RPC reader.

export type RobotFeedbackKind =
  | "alias"
  | "catalog_merge"
  | "catalog_class"
  | "finance_duplicate"
  | "routing"
  | "debt_mark";

export interface RobotFeedbackRow {
  id: string;
  kind: string;
  subject_key: string;
  robot_choice: string | null;
  human_choice: string | null;
  robot_probability: number | null;
  note: string | null;
  created_at: string | null;
  robot_label: string | null;
  human_label: string | null;
}

/** Minimal structural view of the Supabase RPC reader used here. */
export interface RobotFeedbackReader {
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

/** The alias subject key used by the SQL trigger: `supplier|normalized name`. */
export function aliasSubjectKey(supplierId: string | null | undefined, normalizedName: string): string {
  return `${supplierId ?? ""}|${normalizedName}`;
}

/** Canonical sorted pair key, identical to the SQL least/greatest form. */
export function pairSubjectKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

/** Subject key for a catalog merge suggestion. */
export function catalogMergeSubjectKey(itemId: string, otherItemId: string): string {
  return pairSubjectKey(itemId, otherItemId);
}

/** Subject key for a catalog classification suggestion. */
export function catalogClassSubjectKey(itemId: string): string {
  return itemId;
}

/** Subject key for a finance duplicate pair. */
export function financeSubjectKey(idA: string, idB: string): string {
  return pairSubjectKey(idA, idB);
}

/** Subject key for a supplier routing suggestion. */
export function routingSubjectKey(supplierId: string): string {
  return supplierId;
}

/** Subject key for a supplier debt mark (the PR/PO document id). */
export function debtMarkSubjectKey(paymentRequestId: string | null, purchaseOrderId: string | null): string {
  return String(paymentRequestId ?? purchaseOrderId ?? "");
}

/** Supplier part of an alias subject key ('' when the alias has no supplier). */
export function aliasSubjectSupplier(subjectKey: string): string {
  const at = subjectKey.indexOf("|");
  return at < 0 ? "" : subjectKey.slice(0, at);
}

/** Normalized-name part of an alias subject key. */
export function aliasSubjectName(subjectKey: string): string {
  const at = subjectKey.indexOf("|");
  return at < 0 ? subjectKey : subjectKey.slice(at + 1);
}

/** Robot choices a human has already rejected for these rows. */
export function rejectedRobotChoices(rows: readonly RobotFeedbackRow[]): Set<string> {
  const rejected = new Set<string>();
  for (const row of rows ?? []) {
    if (typeof row?.robot_choice === "string" && row.robot_choice !== "") rejected.add(row.robot_choice);
  }
  return rejected;
}

/**
 * Order corrections for the current alias subject: same supplier first, then
 * the most shared name tokens, then the most recent. Ties keep the input order.
 */
export function pickAliasCorrections(
  rows: readonly RobotFeedbackRow[],
  current: { supplierId?: string | null; normalizedName?: string | null },
  limit = 5,
): RobotFeedbackRow[] {
  const tokens = new Set(String(current.normalizedName ?? "").split(/\s+/).filter(Boolean));
  const supplier = current.supplierId ?? "";
  return [...(rows ?? [])]
    .map((row, index) => {
      const rowSupplier = aliasSubjectSupplier(row.subject_key);
      const rowTokens = aliasSubjectName(row.subject_key).split(/\s+/).filter(Boolean);
      let shared = 0;
      for (const token of rowTokens) if (tokens.has(token)) shared += 1;
      return {
        row,
        index,
        sameSupplier: supplier !== "" && rowSupplier === supplier ? 1 : 0,
        shared,
      };
    })
    .sort((left, right) =>
      right.sameSupplier - left.sameSupplier
      || right.shared - left.shared
      || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.row);
}

/**
 * One correction line for the question text, in the exact wording the owner
 * approved: `Người duyệt đã sửa trước đây: <raw name> → <chosen item>
 * (Bé Mì đã chọn <robot item>)`.
 */
export function formatAliasCorrection(row: RobotFeedbackRow): string {
  const rawName = row.note && row.note.trim() !== "" ? row.note : aliasSubjectName(row.subject_key);
  const chosen = row.human_label && row.human_label.trim() !== "" ? row.human_label : (row.human_choice ?? "");
  const robot = row.robot_label && row.robot_label.trim() !== "" ? row.robot_label : (row.robot_choice ?? "");
  return `Người duyệt đã sửa trước đây: ${rawName} → ${chosen} (Bé Mì đã chọn ${robot})`;
}

/** Append the correction lines to a base question, when there are any. */
export function withCorrections(base: string, corrections: readonly string[]): string {
  const lines = corrections.filter((line) => typeof line === "string" && line.trim() !== "");
  if (lines.length === 0) return base;
  return `${base}\n${lines.join("\n")}`;
}

/**
 * One correction line for a catalog classification question. The rejected robot
 * class and the human's resolution are kept explicit.
 */
export function formatClassCorrection(row: RobotFeedbackRow, itemName: string): string {
  const robot = row.robot_label && row.robot_label.trim() !== "" ? row.robot_label : (row.robot_choice ?? "");
  const human = row.human_label && row.human_label.trim() !== "" ? row.human_label : (row.human_choice ?? "");
  return `Người duyệt đã sửa trước đây: ${itemName} → ${human} (Bé Mì đã chọn ${robot})`;
}

/**
 * One correction line for a finance duplicate question. The CEO decision is
 * rendered in Vietnamese next to the robot's own label.
 */
export function formatFinanceCorrection(
  row: RobotFeedbackRow,
  olderNumber: string,
  newerNumber: string,
): string {
  const human = row.human_choice === "same_purchase"
    ? "cùng một lần mua"
    : row.human_choice === "different_purchase"
      ? "hai lần khác nhau"
      : (row.human_choice ?? "");
  const robot = row.robot_choice ?? "";
  return `Người duyệt đã sửa trước đây: ${olderNumber} ↔ ${newerNumber} → ${human} (Bé Mì đã chọn ${robot})`;
}

/**
 * Load feedback rows for one kind and subject set through the service-role RPC.
 * A read failure yields no rows: ranking stays available, the robot simply
 * cannot use the memory for this call.
 */
export async function loadRobotFeedback(
  reader: RobotFeedbackReader,
  kind: RobotFeedbackKind,
  keys: readonly string[],
  limit = 5,
): Promise<RobotFeedbackRow[]> {
  const distinct = [...new Set((keys ?? []).filter((key) => typeof key === "string" && key !== ""))];
  if (distinct.length === 0) return [];
  try {
    const { data, error } = await reader.rpc("get_robot_feedback_for", {
      p_kind: kind,
      p_keys: distinct,
      p_limit: limit,
    });
    if (error) return [];
    return ((data ?? []) as unknown as RobotFeedbackRow[]).map((row) => ({
      id: String(row.id ?? ""),
      kind: String(row.kind ?? kind),
      subject_key: String(row.subject_key ?? ""),
      robot_choice: row.robot_choice ?? null,
      human_choice: row.human_choice ?? null,
      robot_probability: row.robot_probability === null || row.robot_probability === undefined
        ? null
        : Number(row.robot_probability),
      note: row.note ?? null,
      created_at: row.created_at ?? null,
      robot_label: row.robot_label ?? null,
      human_label: row.human_label ?? null,
    }));
  } catch {
    return [];
  }
}
