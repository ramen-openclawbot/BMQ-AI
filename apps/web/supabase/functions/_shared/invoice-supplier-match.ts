/**
 * Shared supplier resolution for document OCR flows.
 *
 * Extracted verbatim from supabase/functions/scan-invoice/index.ts so the CEO
 * cash-expense scan can reuse the exact same alias + scoring rules without
 * changing the scan-invoice response shape or behaviour.
 */

export type SupplierLite = { id: string; name: string };

export type SupplierAliasRow = {
  id: string;
  supplier_id: string;
  alias_text: string;
  alias_key: string;
  active: boolean;
};

export const normalizeSupplierText = (v: string): string =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const supplierAcronymOf = (v: string): string => {
  const tokens = normalizeSupplierText(v)
    .split(" ")
    .filter((x) => x && x.length > 1);

  // Important: support short supplier tokens like "STC", "VPM", ...
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t.length >= 2 && t.length <= 8) return t;
  }

  return tokens.map((x) => x[0]).join("");
};

export const scoreSupplierMatch = (scanned: string, candidate: string): number => {
  const a = normalizeSupplierText(scanned);
  const b = normalizeSupplierText(candidate);
  if (!a || !b) return 0;

  const acA = supplierAcronymOf(a);
  const acB = supplierAcronymOf(b);
  if (a === b) return 100;
  if (acA && (b.includes(acA) || acA === acB)) return 97;
  if (a.includes(b) || b.includes(a)) return 90;

  const at = a.split(" ").filter(Boolean);
  const bt = b.split(" ").filter(Boolean);
  const inter = at.filter((t) => bt.includes(t)).length;
  if (!inter) return 0;

  const coverage = inter / Math.max(at.length, bt.length);
  return Math.round(coverage * 85);
};

export interface SupplierMatch {
  id: string;
  name: string;
  score: number;
  source: "alias" | "scoring";
}

export interface SupplierMatchParams {
  /** Seller/supplier name read by OCR. */
  scannedSupplierName: string;
  /** Additional seller candidates the model returned (scan-invoice only). */
  sellerNameCandidates?: readonly unknown[];
  aliases: readonly SupplierAliasRow[];
  suppliers: readonly SupplierLite[];
  /** Resolve an alias supplier id that is not already in `suppliers`. */
  resolveSupplier: (supplierId: string) => Promise<SupplierLite | null>;
}

/**
 * Alias-first, then name scoring, exactly like the original inline scan-invoice
 * block. Aliases come first (score 100 exact / 95 contains), then a scored name
 * match is accepted only at score >= 90.
 */
export async function matchInvoiceSupplier(
  params: SupplierMatchParams,
): Promise<SupplierMatch | null> {
  const scannedSupplierName = String(params.scannedSupplierName || "").trim();
  const candidateTexts = Array.from(new Set([
    scannedSupplierName,
    ...((Array.isArray(params.sellerNameCandidates) ? params.sellerNameCandidates : []) as string[]),
  ].map((x) => String(x || "").trim()).filter(Boolean)));

  let match: SupplierMatch | null = null;

  if (candidateTexts.length && params.aliases.length) {
    for (const candidate of candidateTexts) {
      const key = normalizeSupplierText(candidate);
      if (!key) continue;

      const directAlias = params.aliases.find((a) => a.alias_key === key);
      if (directAlias) {
        const hit = await params.resolveSupplier(directAlias.supplier_id);
        if (hit) {
          match = { id: hit.id, name: hit.name, score: 100, source: "alias" };
          break;
        }
      }

      const containsAlias = params.aliases.find((a) => key.includes(a.alias_key) || a.alias_key.includes(key));
      if (containsAlias) {
        const hit = await params.resolveSupplier(containsAlias.supplier_id);
        if (hit) {
          match = { id: hit.id, name: hit.name, score: 95, source: "alias" };
          break;
        }
      }
    }
  }

  if (!match && scannedSupplierName && params.suppliers.length) {
    const ranked = params.suppliers
      .map((s) => ({ ...s, score: scoreSupplierMatch(scannedSupplierName, s.name) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best && best.score >= 90) {
      match = { id: best.id, name: best.name, score: best.score, source: "scoring" };
    }
  }

  return match;
}
