/**
 * Browser mirror of the server's `public.material_master_normalize`
 * (`normalize_ocr_cost_key`): fold Vietnamese diacritics to ASCII, drop
 * punctuation to spaces, collapse whitespace and lowercase. Used only to group
 * unresolved source names for display so two spellings of one name are counted
 * together; the server remains authoritative for approved matching.
 */
export function normalizeMaterialName(value?: string | null): string {
  const folded = (value ?? "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return folded.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Shape-preserving companion key: drop tone marks but keep the letter shape
 * (circumflex/breve/horn). This keeps `BỘ PEERLESS` and `BƠ PEERLESS` in separate
 * coverage groups instead of folding both to `bo peerless`.
 */
export function shapeMaterialName(value?: string | null): string {
  const decomposed = (value ?? "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .toLowerCase();
  return decomposed
    .replace(/[\u0300\u0301\u0303\u0309\u0323]/g, "")
    .replace(/[^a-z0-9\s\u0302\u0306\u031b]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
