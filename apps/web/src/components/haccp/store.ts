import type { HaccpData, HaccpFile, HaccpRow, HaccpTableId } from "@/lib/haccp-schema";

/** What the HACCP screens need from their data source (demo memory now, RPC/Edge later). */
export interface HaccpStore {
  data: HaccpData;
  layoutFiles: HaccpFile[];
  link: { url: string; days: number; active: boolean; expiresOn: string };
  activity: { id: string; who: string; text: string; at: string }[];
  saveRow: (table: HaccpTableId, row: HaccpRow, who: string) => void | Promise<void>;
  removeRow: (table: HaccpTableId, rowId: string, who?: string, version?: number) => void | Promise<void>;
  addLayoutFiles: (files: HaccpFile[], who: string) => void | Promise<void>;
  removeLayoutFile: (fileId: string, who?: string) => void | Promise<void>;
  /** Returns how many rows were added from the app. */
  pullFromApp: (table: HaccpTableId) => number | Promise<number>;
  createLink: (days: number) => void | Promise<void>;
  revokeLink: () => void | Promise<void>;
}

export function toHaccpFiles(list: FileList | null): HaccpFile[] {
  return Array.from(list ?? []).map((file) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    size: file.size,
    type: file.type,
    url: URL.createObjectURL(file),
    file,
  }));
}

export const HACCP_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** A sentence a kitchen user can act on, from an RPC or Edge error. */
export function haccpErrorText(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const has = (key: string) => code === key || message.includes(key);
  if (has("stale_version")) return "Có người vừa sửa dòng này. Đóng lại, mở lại dòng rồi sửa tiếp.";
  if (has("insufficient_privilege")) return "Tài khoản này chưa có quyền sửa Kho.";
  if (has("link_expired") || has("link_revoked") || has("link_invalid")) return "Link đã hết hạn hoặc bị thu hồi. Xin quản lý link mới.";
  if (has("rate_limited")) return "Đang thao tác quá nhanh. Chờ vài phút rồi thử lại.";
  if (has("file_too_large")) return "File lớn hơn 10 MB.";
  if (has("unsupported_type")) return "Chỉ nhận ảnh JPG, PNG, WebP, PDF, Word hoặc Excel.";
  if (has("invalid_values")) return "Nội dung quá dài hoặc chưa hợp lệ (số điện thoại tối đa 40 ký tự).";
  if (has("attachment_failed") || has("attachment_missing")) return message;
  return "Chưa lưu được. Kiểm tra mạng rồi thử lại.";
}

export const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
