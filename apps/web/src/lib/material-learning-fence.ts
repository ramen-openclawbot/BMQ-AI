// Pure, dependency-free decision helpers for the Material Master suggestion UI.
// They make the request/auth generation fence, the synchronous double-click guard
// and the durable-outcome recovery comparison directly testable without a DOM.

export interface ResolutionIntent {
  action: "resolve_existing" | "create_new" | "reject";
  materialId: string;
  createFields?: {
    material_code?: string | null;
    canonical_name?: string | null;
    default_unit?: string | null;
  } | null;
}

export interface DurableResolutionLike {
  status: string | null;
  resolved_material_id: string | null;
  canonical_name?: string | null;
  default_unit?: string | null;
  material_code?: string | null;
}

export type RecoveryDecision = "blocked" | "already-done" | "conflict" | "retry" | "needs-review";

/** Synchronous in-flight gate: a second call before `exit()` is rejected. */
export function createSubmitGate() {
  let inFlight = false;
  return {
    tryEnter(): boolean {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    exit(): void {
      inFlight = false;
    },
  };
}

/**
 * Monotonic generation fence. A response may only be applied when the token it
 * captured is still the current generation, so an A→B→A switch rejects the stale
 * first-A response.
 */
export function createGenerationFence() {
  let generation = 0;
  return {
    next(): number {
      generation += 1;
      return generation;
    },
    current(): number {
      return generation;
    },
    isCurrent(token: number): boolean {
      return token === generation;
    },
  };
}

const sameField = (left: string | null | undefined, right: string | null | undefined) => (left ?? "").trim() === (right ?? "").trim();

/** Does the durable row represent exactly the action/material that was submitted? */
export function outcomeMatchesIntent(row: DurableResolutionLike, intended: ResolutionIntent): boolean {
  if (intended.action === "reject") return row.status === "rejected" && row.resolved_material_id == null;
  if (intended.action === "resolve_existing") return row.status === "resolved_existing" && row.resolved_material_id === intended.materialId;
  if (row.status !== "created_new" || typeof row.resolved_material_id !== "string" || !row.resolved_material_id) return false;
  // An unchanged create_new is only the same intent when the actual canonical
  // fields match the submitted create payload; a terminal id alone can belong to a
  // different name/unit created by someone else.
  const wanted = intended.createFields;
  if (!wanted || !sameField(row.canonical_name, wanted.canonical_name) || !sameField(row.default_unit, wanted.default_unit)) return false;
  const code = (wanted.material_code ?? "").trim();
  return !code || sameField(row.material_code, code);
}

/**
 * Classify the recovery read after an uncertain confirmation:
 * - blocked: the exact durable request could not be re-read, so no blind repeat;
 * - retry: the row is still pending (or missing), the write did not land;
 * - already-done: the durable outcome matches the intended action/material;
 * - needs-review: a terminal created_new exists but the canonical fields cannot be
 *   confirmed against the submitted payload, so it must be reviewed, not overwritten;
 * - conflict: the row terminates at a different outcome and must not be overwritten.
 */
export function classifyRecovery(row: DurableResolutionLike | null, intended: ResolutionIntent, readFailed = false): RecoveryDecision {
  if (readFailed) return "blocked";
  if (!row || !row.status || row.status === "pending") return "retry";
  if (outcomeMatchesIntent(row, intended)) return "already-done";
  if (intended.action === "create_new" && row.status === "created_new") return "needs-review";
  return "conflict";
}
