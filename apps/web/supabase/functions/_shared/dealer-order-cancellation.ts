const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SELF_CANCELLATION_ORDERS = 20;

export function normalizeSelfCancellationIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SELF_CANCELLATION_ORDERS) return null;
  const normalized = value.map((item) => typeof item === "string" ? item.trim().toLowerCase() : "");
  if (normalized.some((item) => !UUID_PATTERN.test(item))) return null;
  return [...new Set(normalized)];
}
