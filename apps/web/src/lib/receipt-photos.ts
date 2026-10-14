/**
 * Photos of one goods receipt: the main delivery note (`goods_receipts.image_url`, the one OCR reads)
 * plus extra photos (`goods_receipts.product_photos`: page 2 of the note, the goods themselves…).
 * Owner 14/10: Mai could only attach one photo per receipt.
 */
export interface ReceiptPhoto {
  path: string;
  main: boolean;
}

const clean = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Main photo first, then extras; blanks and repeats dropped. */
export function receiptPhotos(imageUrl: unknown, extras: unknown): ReceiptPhoto[] {
  const main = clean(imageUrl);
  const seen = new Set<string>(main ? [main] : []);
  const list: ReceiptPhoto[] = main ? [{ path: main, main: true }] : [];
  for (const raw of Array.isArray(extras) ? extras : []) {
    const path = clean(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    list.push({ path, main: false });
  }
  return list;
}

/** Extras after appending `added` (never repeating the main photo or an existing extra). */
export function appendExtraPhotos(imageUrl: unknown, extras: unknown, added: string[]): string[] {
  return receiptPhotos(imageUrl, [...(Array.isArray(extras) ? extras : []), ...added]).filter((p) => !p.main).map((p) => p.path);
}

/** Extras without `path`. */
export function removeExtraPhoto(imageUrl: unknown, extras: unknown, path: string): string[] {
  return receiptPhotos(imageUrl, extras).filter((p) => !p.main && p.path !== path).map((p) => p.path);
}

/**
 * A new main photo replaces the old one; the old main is kept as the first extra so a second
 * "Tải/chụp phiếu" never loses the earlier photo.
 */
export function replaceMainPhoto(imageUrl: unknown, extras: unknown, newMain: string): string[] {
  const old = clean(imageUrl);
  const rest = receiptPhotos(null, extras).map((p) => p.path);
  return receiptPhotos(newMain, old && old !== newMain ? [old, ...rest] : rest).filter((p) => !p.main).map((p) => p.path);
}
