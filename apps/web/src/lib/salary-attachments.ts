/**
 * Pure helpers for salary payout supporting documents ("Chứng từ kèm theo").
 *
 * A manual ("Lương lẻ") or payroll Q7 payout can carry images, PDF or Excel
 * files. The same limits are enforced by the salary-payout edge function and the
 * private 'salary-documents' bucket:
 *   * allowed mime: image/jpeg, image/png, image/webp, image/heic,
 *     application/pdf, application/vnd.ms-excel,
 *     application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;
 *   * mime inferred from the extension when the declared type is empty or
 *     application/octet-stream;
 *   * 1..10 MB per file, at most 20 attachments per payout.
 *
 * No file content, employee name or amount is ever logged here.
 */

export type SalaryAttachmentKind = "image" | "pdf" | "excel";

export interface SalaryAttachmentTypeDefinition {
  mime: string;
  extensions: string[];
}

export const SALARY_ATTACHMENT_TYPES: SalaryAttachmentTypeDefinition[] = [
  { mime: "image/jpeg", extensions: ["jpg", "jpeg"] },
  { mime: "image/png", extensions: ["png"] },
  { mime: "image/webp", extensions: ["webp"] },
  { mime: "image/heic", extensions: ["heic"] },
  { mime: "application/pdf", extensions: ["pdf"] },
  { mime: "application/vnd.ms-excel", extensions: ["xls"] },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: ["xlsx"],
  },
];

export const SALARY_ATTACHMENT_MIME_TYPES: string[] = SALARY_ATTACHMENT_TYPES.map(
  (definition) => definition.mime,
);

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_COUNT = 20;

const OCTET_STREAM = "application/octet-stream";

const EXTENSION_MIME: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const definition of SALARY_ATTACHMENT_TYPES) {
    for (const extension of definition.extensions) map[extension] = definition.mime;
  }
  return map;
})();

const extensionOf = (name: unknown): string => {
  const text = String(name ?? "").trim().toLowerCase();
  const base = text.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : "";
};

/**
 * Declared mime when it is a real type; the extension fallback when the
 * declared type is empty or application/octet-stream. Null when nothing usable
 * is known (caller treats that as unsupported).
 */
export const resolveSalaryAttachmentMime = (name: unknown, type: unknown): string | null => {
  const declared = String(type ?? "").trim().toLowerCase();
  if (declared && declared !== OCTET_STREAM) return declared;
  return EXTENSION_MIME[extensionOf(name)] ?? null;
};

export const isSalaryAttachmentMime = (mime: unknown): boolean =>
  typeof mime === "string" && SALARY_ATTACHMENT_MIME_TYPES.includes(mime);

/** 'image' | 'pdf' | 'excel' for the allowed mimes, null otherwise. */
export const attachmentKind = (mime: unknown): SalaryAttachmentKind | null => {
  const value = String(mime ?? "").trim().toLowerCase();
  if (value.startsWith("image/")) return "image";
  if (value === "application/pdf") return "pdf";
  if (
    value === "application/vnd.ms-excel" ||
    value === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "excel";
  }
  return null;
};

// ---------------------------------------------------------------------------
// Stored row shape (mirrors public.salary_payout_attachments)
// ---------------------------------------------------------------------------

export interface SalaryPayoutAttachment {
  id: string;
  payout_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  file_sha256: string;
  uploaded_by: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type SalaryAttachmentErrorCode =
  | "insufficient_privilege"
  | "payout_not_found"
  | "attachment_not_found"
  | "payout_completed"
  | "unsupported_type"
  | "file_too_large"
  | "too_many_attachments"
  | "upload_failed"
  | "attachment_delete_failed"
  | "attachment_lookup_failed"
  | "payout_lookup_failed"
  | "signed_url_failed";

/** Only for local pre-flight validation (the edge has no empty-file code). */
export type SalaryAttachmentValidationCode = SalaryAttachmentErrorCode | "empty_file";

export interface SalaryAttachmentFileCandidate {
  name?: unknown;
  type?: unknown;
  size?: unknown;
}

export interface SalaryAttachmentAccepted {
  /** Index of the accepted item in the validated input list. */
  index: number;
  name: string;
  mime: string;
  size: number;
}

export interface SalaryAttachmentValidationError {
  fileName: string;
  code: SalaryAttachmentValidationCode;
  message: string;
}

export interface SalaryAttachmentValidationResult {
  valid: boolean;
  accepted: SalaryAttachmentAccepted[];
  errors: SalaryAttachmentValidationError[];
}

const UNSUPPORTED_MESSAGE = "Chỉ nhận ảnh, PDF hoặc Excel";
const TOO_LARGE_MESSAGE = "File lớn hơn 10 MB";
const TOO_MANY_MESSAGE = "Tối đa 20 chứng từ mỗi phiếu";

const sizeOf = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Validate a batch of candidate files against the edge/bucket limits.
 * `existingCount` is the number of documents already stored for the payout; the
 * remaining slot count applies to the accepted items only.
 */
export const validateSalaryAttachmentFiles = (
  files: SalaryAttachmentFileCandidate[] | unknown,
  existingCount = 0,
): SalaryAttachmentValidationResult => {
  const list = Array.isArray(files) ? files : [];
  const start = Math.max(0, Math.trunc(Number(existingCount) || 0));
  const accepted: SalaryAttachmentAccepted[] = [];
  const errors: SalaryAttachmentValidationError[] = [];

  list.forEach((raw, index) => {
    const record = raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
    const name = String(record.name ?? "").trim();
    const fileName = name || `chứng từ ${index + 1}`;
    const mime = resolveSalaryAttachmentMime(name, record.type);
    const size = sizeOf(record.size);

    if (!mime || !isSalaryAttachmentMime(mime)) {
      errors.push({ fileName, code: "unsupported_type", message: UNSUPPORTED_MESSAGE });
      return;
    }
    if (size > MAX_BYTES) {
      errors.push({ fileName, code: "file_too_large", message: TOO_LARGE_MESSAGE });
      return;
    }
    if (size < 1) {
      errors.push({ fileName, code: "empty_file", message: "File rỗng" });
      return;
    }
    if (start + accepted.length >= MAX_COUNT) {
      errors.push({ fileName, code: "too_many_attachments", message: TOO_MANY_MESSAGE });
      return;
    }
    accepted.push({ index, name, mime, size });
  });

  return { valid: errors.length === 0, accepted, errors };
};

// ---------------------------------------------------------------------------
// Error text (covers every edge code)
// ---------------------------------------------------------------------------

const ATTACHMENT_ERROR_TEXT: Record<SalaryAttachmentErrorCode, string> = {
  insufficient_privilege: "Không có quyền thực hiện thao tác này.",
  payout_not_found: "Không tìm thấy phiếu lương.",
  attachment_not_found: "Không tìm thấy chứng từ.",
  payout_completed: "Phiếu lương đã hoàn tất, không thể thay đổi chứng từ.",
  unsupported_type: UNSUPPORTED_MESSAGE,
  file_too_large: TOO_LARGE_MESSAGE,
  too_many_attachments: TOO_MANY_MESSAGE,
  upload_failed: "Không tải được chứng từ. Vui lòng thử lại.",
  attachment_delete_failed: "Không xoá được chứng từ. Vui lòng thử lại.",
  attachment_lookup_failed: "Không đọc được chứng từ. Vui lòng thử lại.",
  payout_lookup_failed: "Không đọc được phiếu lương. Vui lòng thử lại.",
  signed_url_failed: "Không tạo được liên kết tải chứng từ.",
};

const FALLBACK_ERROR_TEXT = "Không xử lý được chứng từ. Vui lòng thử lại.";

/** Vietnamese message for an edge code; unknown codes get a generic message. */
export const salaryAttachmentErrorText = (code: unknown): string => {
  const key = String(code ?? "").trim() as SalaryAttachmentErrorCode;
  return ATTACHMENT_ERROR_TEXT[key] ?? FALLBACK_ERROR_TEXT;
};
