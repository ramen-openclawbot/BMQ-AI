/**
 * Pure mirror of the server transition rules in
 * `public.transition_warehouse_dispatch_status`.
 *
 * The server stays authoritative; this module exists so the UI can reason about
 * the same ordered transitions without any network/DB access, keeping the two
 * definitions testable together.
 */
export const DISPATCH_STATUSES = ["pending", "picked", "dispatched", "delivered"] as const;

export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

const NEXT_STATUS: Record<DispatchStatus, DispatchStatus | null> = {
  pending: "picked",
  picked: "dispatched",
  dispatched: "delivered",
  delivered: null,
};

export function isDispatchStatus(value: string): value is DispatchStatus {
  return (DISPATCH_STATUSES as readonly string[]).includes(value);
}

/**
 * Returns true when the ordered transition is allowed. Repeating the current
 * status is treated as an idempotent no-op (the server returns
 * `{ idempotent: true }` and never deducts stock again).
 */
export function canTransition(from: string, to: string): boolean {
  if (!isDispatchStatus(from) || !isDispatchStatus(to)) return false;
  if (from === to) return true;
  return NEXT_STATUS[from] === to;
}

/** The next status in the ordered flow, or null at the terminal status. */
export function nextStatus(from: string): DispatchStatus | null {
  return isDispatchStatus(from) ? NEXT_STATUS[from] : null;
}
