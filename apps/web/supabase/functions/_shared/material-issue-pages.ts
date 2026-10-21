/**
 * Page-image storage contract for signed Q7 material issue PDFs.
 *
 * The browser renders the signed PDF pages to JPEG and uploads them beside the
 * PDF in the same private bucket. This module owns the object paths, the
 * multipart field validation and the manifest shape so the upload and check
 * Edge Functions agree without sharing request-scoped code.
 */
export const MAX_PAGES = 8;
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;

const SHA256_RE = /^[a-f0-9]{64}$/;
const PAGE_FIELD_RE = /^page_(\d+)$/;

export type ParsedPageImage = {
  page: number;
  bytes: Uint8Array;
};

export type ManifestPageInput = {
  page: number;
  path: string;
  sha256: string;
  bytes: number;
};

export type PageManifestEntry = {
  path: string;
  sha256: string;
  bytes: number;
  page: number;
};

export type PageManifest = {
  pdf_sha256: string;
  pages: PageManifestEntry[];
};

export type ManifestFailureCode = "pages_missing" | "pages_mismatch";

export type ValidateManifestResult =
  | { ok: true; pages: PageManifestEntry[] }
  | { ok: false; code: ManifestFailureCode };

export class MaterialIssuePagesError extends Error {
  readonly code: ManifestFailureCode;

  constructor(code: ManifestFailureCode, message: string) {
    super(message);
    this.name = "MaterialIssuePagesError";
    this.code = code;
  }
}

export const pagesPrefix = (signedPath: string) => `${signedPath}.pages`;

export const pagePath = (signedPath: string, page: number) => `${pagesPrefix(signedPath)}/p${page}.jpg`;

export const manifestPath = (signedPath: string) => `${pagesPrefix(signedPath)}/manifest.json`;

const isJpeg = (bytes: Uint8Array) =>
  bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const toBytes = async (value: unknown): Promise<Uint8Array | null> => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  return null;
};

/**
 * Validate the multipart `page_1..page_N` fields and return their bytes in page
 * order. `declaredCount` is the submitted `page_count`; it must match exactly.
 */
export async function parsePageFields(
  entries: Iterable<readonly [string, unknown]>,
  declaredCount: number,
): Promise<ParsedPageImage[]> {
  if (!Number.isInteger(declaredCount) || declaredCount < 1 || declaredCount > MAX_PAGES) {
    throw new MaterialIssuePagesError("pages_missing", "Số trang ảnh không hợp lệ.");
  }

  const fields = new Map<string, unknown>();
  for (const [name, value] of entries) {
    if (fields.has(name)) {
      throw new MaterialIssuePagesError("pages_mismatch", "Ảnh trang bị trùng.");
    }
    fields.set(name, value);
  }

  const pageFields = Array.from(fields.keys()).filter((name) => PAGE_FIELD_RE.test(name));
  if (pageFields.length !== declaredCount) {
    throw new MaterialIssuePagesError("pages_missing", "Thiếu ảnh trang của phiếu.");
  }

  const pages: ParsedPageImage[] = [];
  for (let page = 1; page <= declaredCount; page += 1) {
    const fieldName = `page_${page}`;
    if (!fields.has(fieldName)) {
      throw new MaterialIssuePagesError("pages_missing", "Thiếu ảnh trang của phiếu.");
    }
    const value = fields.get(fieldName);
    if (typeof Blob !== "undefined" && value instanceof Blob && value.type !== "image/jpeg") {
      throw new MaterialIssuePagesError("pages_mismatch", "Ảnh trang không phải JPEG.");
    }
    const bytes = await toBytes(value);
    if (!bytes || bytes.byteLength < 1) {
      throw new MaterialIssuePagesError("pages_missing", "Ảnh trang đang trống.");
    }
    if (bytes.byteLength > MAX_PAGE_BYTES) {
      throw new MaterialIssuePagesError("pages_mismatch", "Ảnh trang vượt quá giới hạn 3MB.");
    }
    if (!isJpeg(bytes)) {
      throw new MaterialIssuePagesError("pages_mismatch", "Ảnh trang không phải JPEG.");
    }
    pages.push({ page, bytes });
  }

  return pages;
}

export function buildManifest(pdfSha256: string, pages: readonly ManifestPageInput[]): PageManifest {
  return {
    pdf_sha256: pdfSha256,
    pages: pages.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes,
      page: entry.page,
    })),
  };
}

/**
 * Validate a parsed manifest against the recorded signed-PDF sha256. A missing
 * manifest is `pages_missing`; a wrong hash, page order or page record is
 * `pages_mismatch`.
 */
export function validateManifest(json: unknown, expectedPdfSha256: string): ValidateManifestResult {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, code: "pages_missing" };
  }

  const manifest = json as Partial<PageManifest>;
  if (typeof manifest.pdf_sha256 !== "string" || !Array.isArray(manifest.pages)) {
    return { ok: false, code: "pages_missing" };
  }
  if (manifest.pdf_sha256.toLowerCase() !== expectedPdfSha256.toLowerCase()) {
    return { ok: false, code: "pages_mismatch" };
  }
  if (manifest.pages.length < 1 || manifest.pages.length > MAX_PAGES) {
    return { ok: false, code: "pages_mismatch" };
  }

  const pages: PageManifestEntry[] = [];
  for (let index = 0; index < manifest.pages.length; index += 1) {
    const entry = manifest.pages[index] as Partial<PageManifestEntry> | null;
    if (!entry || typeof entry !== "object") return { ok: false, code: "pages_mismatch" };
    if (entry.page !== index + 1) return { ok: false, code: "pages_mismatch" };
    if (typeof entry.path !== "string" || entry.path.length < 1) return { ok: false, code: "pages_mismatch" };
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256.toLowerCase())) {
      return { ok: false, code: "pages_mismatch" };
    }
    if (!Number.isInteger(entry.bytes) || (entry.bytes as number) < 1 || (entry.bytes as number) > MAX_PAGE_BYTES) {
      return { ok: false, code: "pages_mismatch" };
    }
    pages.push({
      path: entry.path,
      sha256: entry.sha256.toLowerCase(),
      bytes: entry.bytes as number,
      page: entry.page,
    });
  }

  return { ok: true, pages };
}
