/**
 * Vietnamese copy for a failed PO create. The document-line unit trigger can
 * rewrite a line's unit to its standard label, and the server then reports
 * 'procurement source unit drift'. In that case the dialog has already
 * cancelled the just-created header, so the operator only needs to retry.
 * Every other failure keeps the existing generic sentence plus the server
 * message so the real reason is not hidden.
 */
export function poCreateErrorText(error: unknown): string {
  const message = poCreateErrorMessage(error);
  if (message.toLowerCase().includes("procurement source unit drift")) {
    return "Đơn vị trên dòng sản phẩm không hợp lệ, đã hủy PO nháp. Thử lại.";
  }
  const base = "Lỗi khi tạo đơn đặt hàng";
  return message ? `${base}: ${message}` : base;
}

function poCreateErrorMessage(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) return (error.message || "").trim();
  if (typeof error === "object" && "message" in error) {
    const value = (error as { message?: unknown }).message;
    return value == null ? "" : String(value).trim();
  }
  return String(error).trim();
}
