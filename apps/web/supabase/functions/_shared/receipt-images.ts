// Shared goods-receipt image loader for the finance duplicate scan.
//
// It copies the downloadOne / downloadReceiptImages pattern from
// supabase/functions/suggest-stock-item-name/index.ts: the same four storage
// buckets and the same legacy "bucket/path" and bare-filename candidates, a
// 4 MB per-image cap, one image per side and a storage client injected by the
// caller so this module is testable without Deno or the network. It never throws:
// a missing object, a failed download or an oversized body all return null.

/** One inline image ready for the Decisions provider. */
export interface ReceiptImage {
  mime: string;
  base64: string;
}

/** Minimal structural view of the Supabase storage API this module uses. */
export interface ReceiptStorageClient {
  storage: {
    from(bucket: string): {
      download(path: string): Promise<{
        data: { arrayBuffer(): Promise<ArrayBuffer>; type?: string } | null;
        error: unknown;
      }>;
    };
  };
}

export const RECEIPT_IMAGE_BUCKETS = ["invoices", "purchase-orders", "payment-slips", "payment-requests"] as const;
export const RECEIPT_IMAGE_LEGACY_PREFIXES = ["payment-requests/", "payment-slips/", "purchase-orders/", "invoices/"] as const;
/** 4 MB per image; anything larger is skipped. */
export const RECEIPT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** One image per side of a pair. */
export const RECEIPT_IMAGE_MAX_PER_SIDE = 1;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Small dependency-free base64 encoder (works in Deno, Node and the browser). */
export function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    output += BASE64_ALPHABET[b0 >> 2];
    output += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    output += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    output += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : "=";
  }
  return output;
}

function parseStorageUrl(raw: string): { bucket: string; path: string } | null {
  try {
    const url = new URL(raw);
    const marker = "/storage/v1/object/";
    const idx = url.pathname.indexOf(marker);
    if (idx < 0) return null;
    const parts = url.pathname.slice(idx + marker.length).split("/").filter(Boolean);
    if (parts.length < 3) return null;
    if (!["public", "sign", "authenticated"].includes(parts[0])) return null;
    const bucket = parts[1];
    const path = decodeURIComponent(parts.slice(2).join("/"));
    return bucket && path ? { bucket, path } : null;
  } catch {
    return null;
  }
}

/** Every (bucket, path) the raw value could point at, preferred first. */
export function receiptImageSources(rawValue: string): Array<{ bucket: string; path: string }> {
  const input = String(rawValue ?? "").trim();
  if (!input) return [];
  if (/^https?:\/\//i.test(input)) {
    const parsed = parseStorageUrl(input);
    return parsed ? [parsed] : [];
  }
  const cleaned = input.split("?")[0].split("#")[0].replace(/^\/+/, "");
  if (!cleaned) return [];
  const seen = new Set<string>();
  const sources: Array<{ bucket: string; path: string }> = [];
  const add = (bucket: string, path: string) => {
    if (!path) return;
    const key = `${bucket}\u0000${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ bucket, path });
  };
  for (const bucket of RECEIPT_IMAGE_BUCKETS) {
    add(bucket, cleaned);
    const prefix = `${bucket}/`;
    if (cleaned.startsWith(prefix)) add(bucket, cleaned.slice(prefix.length));
    if (!cleaned.includes("/")) {
      for (const legacy of RECEIPT_IMAGE_LEGACY_PREFIXES) add(bucket, `${legacy}${cleaned}`);
    }
  }
  return sources;
}

/** Download the first readable image for one raw storage value, or null. */
export async function downloadReceiptImage(
  storage: ReceiptStorageClient,
  rawValue: string,
  maxBytes: number = RECEIPT_IMAGE_MAX_BYTES,
): Promise<ReceiptImage | null> {
  for (const { bucket, path } of receiptImageSources(rawValue)) {
    try {
      const { data, error } = await storage.storage.from(bucket).download(path);
      if (error || !data) continue;
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) continue;
      return { base64: encodeBase64(bytes), mime: data.type || "image/jpeg" };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Load at most one image per side from a receipt's main image plus product
 * photos. Missing values and failures are skipped silently.
 */
export async function downloadReceiptImages(
  storage: ReceiptStorageClient,
  imageUrl: string | null,
  productPhotos: readonly string[] = [],
  maxImages: number = RECEIPT_IMAGE_MAX_PER_SIDE,
): Promise<ReceiptImage[]> {
  const raws = [imageUrl, ...(Array.isArray(productPhotos) ? productPhotos : [])]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  const unique = [...new Set(raws.map((value) => value.trim()))];
  const images: ReceiptImage[] = [];
  const cap = Math.max(1, maxImages);
  for (const raw of unique) {
    if (images.length >= cap) break;
    const image = await downloadReceiptImage(storage, raw);
    if (image) images.push(image);
  }
  return images;
}
