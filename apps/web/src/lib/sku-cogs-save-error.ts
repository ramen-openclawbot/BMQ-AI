export type SkuCogsSaveErrorRow = {
  material_code?: string | null;
  name?: string | null;
  ingredient_name?: string | null;
  displayName?: string | null;
};

const BLOCKER_MARKER = "sku_cogs_material_blocked_before_publish:";

const BLOCKER_LABELS: Record<string, string> = {
  missing_standard_cost: "chưa có giá chuẩn",
  missing_purchase_price: "chưa có giá mua",
  unit_unmapped: "chưa khớp đơn vị",
  supplier_unmapped: "chưa gắn nhà cung cấp",
};

const UNKNOWN_BLOCKER_LABEL = "chưa xác định được NVL";

const blockerLabel = (reason: unknown): string => {
  const key = String(reason ?? "").trim();
  return BLOCKER_LABELS[key] ?? UNKNOWN_BLOCKER_LABEL;
};

const rowCode = (row: SkuCogsSaveErrorRow | undefined): string =>
  String(row?.material_code ?? "").trim();

const rowName = (row: SkuCogsSaveErrorRow | undefined): string =>
  String(row?.name ?? row?.ingredient_name ?? row?.displayName ?? "").trim();

/** Reads the first balanced JSON object out of a message tail. */
const extractJsonObject = (text: string): string | null => {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

/**
 * Turns a raw save_sku_cogs PostgREST error into a short Vietnamese sentence
 * listing the blocked form rows. `rows` is the COGS formulation list sent to the
 * RPC (same order), used to show each row's material code/name.
 *
 * Returns null when the message is not a recognisable material blocker error.
 */
export function describeSkuCogsSaveError(
  message: unknown,
  rows: SkuCogsSaveErrorRow[] = [],
): string | null {
  if (typeof message !== "string") return null;
  const markerIndex = message.indexOf(BLOCKER_MARKER);
  if (markerIndex < 0) return null;

  const jsonText = extractJsonObject(message.slice(markerIndex + BLOCKER_MARKER.length));
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const blockedRows = Array.isArray((parsed as { blockers?: unknown })?.blockers)
    ? ((parsed as { blockers: unknown[] }).blockers)
    : [];
  if (blockedRows.length === 0) return null;

  const safeRows = Array.isArray(rows) ? rows : [];
  const described = blockedRows.map((entry) => {
    const item = (entry ?? {}) as { row?: unknown; blockers?: unknown };
    const rowNo = Number(item.row);
    const hasRow = Number.isFinite(rowNo);
    const row = hasRow ? safeRows[rowNo - 1] : undefined;
    const identity = [rowCode(row), rowName(row)].filter(Boolean).join(" – ");
    const reasons = Array.isArray(item.blockers) && item.blockers.length > 0
      ? Array.from(new Set(item.blockers.map(blockerLabel)))
      : [UNKNOWN_BLOCKER_LABEL];
    const where = hasRow ? `dòng ${rowNo}` : "một dòng NVL";
    const ident = identity ? ` (${identity})` : "";
    return `${where}${ident} ${reasons.join(", ")}`;
  });

  return `Không lưu được SKU: ${described.join("; ")}.`;
}
