/**
 * @typedef {'ok' | 'timeout' | 'unreachable' | 'bad_response' | 'not_configured'} FinanceOcrBackendStatus
 * @typedef {'OCR_BACKEND_TIMEOUT' | 'OCR_BACKEND_UNREACHABLE' | 'OCR_BACKEND_BAD_RESPONSE'} FinanceOcrWarningCode
 *
 * @typedef {Object} FinanceOcrMeta
 * @property {string | undefined} [provider]
 * @property {FinanceOcrBackendStatus | undefined} [backendStatus]
 * @property {boolean | undefined} [fallbackUsed]
 * @property {FinanceOcrWarningCode | undefined} [warningCode]
 * @property {string | null | undefined} [warningMessage]
 *
 * @typedef {Object} FinanceOcrBackendFailure
 * @property {FinanceOcrBackendStatus} backendStatus
 * @property {FinanceOcrWarningCode} warningCode
 * @property {string} warningMessage
 * @property {string} detail
 */

const getErrorText = (errorLike) => {
  if (!errorLike) return "Unknown OCR backend error";
  if (typeof errorLike === "string") return errorLike;
  if (errorLike instanceof Error) return errorLike.message || errorLike.name || "Unknown OCR backend error";
  if (typeof errorLike === "object") {
    const candidate = errorLike.detail || errorLike.error || errorLike.message || errorLike.code;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return String(errorLike);
};

const includesAny = (text, parts) => parts.some((part) => text.includes(part));

const VI_WARNING_MESSAGES = {
  OCR_BACKEND_TIMEOUT:
    "Backend PaddleOCR CPU đang phản hồi chậm hoặc bị timeout. Hệ thống đang dùng OCR dự phòng tạm thời. Vui lòng kiểm tra server OCR.",
  OCR_BACKEND_UNREACHABLE:
    "Backend PaddleOCR CPU đang không kết nối được. Hệ thống đang dùng OCR dự phòng tạm thời. Vui lòng kiểm tra server OCR.",
  OCR_BACKEND_BAD_RESPONSE:
    "Backend PaddleOCR CPU có phản hồi bất thường. Hệ thống đang dùng OCR dự phòng tạm thời. Vui lòng kiểm tra server OCR.",
};

const EN_WARNING_MESSAGES = {
  OCR_BACKEND_TIMEOUT:
    "The PaddleOCR CPU backend is timing out. The system is temporarily using fallback OCR. Please check the OCR server.",
  OCR_BACKEND_UNREACHABLE:
    "The PaddleOCR CPU backend is unreachable. The system is temporarily using fallback OCR. Please check the OCR server.",
  OCR_BACKEND_BAD_RESPONSE:
    "The PaddleOCR CPU backend returned an unexpected response. The system is temporarily using fallback OCR. Please check the OCR server.",
};

const VI_ERROR_MESSAGES = {
  OCR_BACKEND_TIMEOUT:
    "Không thể scan vì backend PaddleOCR CPU đang timeout. Vui lòng kiểm tra server OCR hoặc kết nối mạng.",
  OCR_BACKEND_UNREACHABLE:
    "Không thể scan vì backend PaddleOCR CPU không phản hồi. Vui lòng kiểm tra server OCR hoặc kết nối mạng.",
  OCR_BACKEND_BAD_RESPONSE:
    "Không thể scan vì backend PaddleOCR CPU trả về phản hồi bất thường. Vui lòng kiểm tra server OCR.",
};

const EN_ERROR_MESSAGES = {
  OCR_BACKEND_TIMEOUT:
    "Scan failed because the PaddleOCR CPU backend timed out. Please check the OCR server or network.",
  OCR_BACKEND_UNREACHABLE:
    "Scan failed because the PaddleOCR CPU backend is unreachable. Please check the OCR server or network.",
  OCR_BACKEND_BAD_RESPONSE:
    "Scan failed because the PaddleOCR CPU backend returned an invalid response. Please check the OCR server.",
};

/**
 * @param {unknown} errorLike
 * @returns {FinanceOcrBackendFailure}
 */
export const classifyFinanceOcrBackendFailure = (errorLike) => {
  const detail = getErrorText(errorLike);
  const text = detail.toLowerCase();

  if (includesAny(text, ["aborterror", "timed out", "timeout", "signal timed out", "quá thời gian chờ"])) {
    return {
      backendStatus: "timeout",
      warningCode: "OCR_BACKEND_TIMEOUT",
      warningMessage: VI_WARNING_MESSAGES.OCR_BACKEND_TIMEOUT,
      detail,
    };
  }

  if (
    includesAny(text, [
      "fetch failed",
      "failed to fetch",
      "connection refused",
      "networkerror",
      "econnrefused",
      "econnreset",
      "enotfound",
      "offline",
      "unreachable",
      "dns",
      "socket",
      "ssl eof",
      "ssleoferror",
      "no peer certificate",
      "peer certificate available",
      "eof while reading",
      "tls handshake timeout",
      "mac mini",
    ])
  ) {
    return {
      backendStatus: "unreachable",
      warningCode: "OCR_BACKEND_UNREACHABLE",
      warningMessage: VI_WARNING_MESSAGES.OCR_BACKEND_UNREACHABLE,
      detail,
    };
  }

  return {
    backendStatus: "bad_response",
    warningCode: "OCR_BACKEND_BAD_RESPONSE",
    warningMessage: VI_WARNING_MESSAGES.OCR_BACKEND_BAD_RESPONSE,
    detail,
  };
};

/**
 * @param {FinanceOcrMeta | { code?: string | null, warningCode?: string | null, backendStatus?: string | null } | null | undefined} value
 */
export const isFinanceOcrBackendIssue = (value) => {
  if (!value || typeof value !== "object") return false;
  const code = value.warningCode || value.code;
  if (code === "OCR_BACKEND_TIMEOUT" || code === "OCR_BACKEND_UNREACHABLE" || code === "OCR_BACKEND_BAD_RESPONSE") {
    return true;
  }
  return value.backendStatus === "timeout" || value.backendStatus === "unreachable" || value.backendStatus === "bad_response";
};

/**
 * @param {FinanceOcrMeta | null | undefined} meta
 * @param {boolean} [isVi=false]
 */
export const getFinanceOcrBackendWarningMessage = (meta, isVi = false) => {
  if (!meta || !isFinanceOcrBackendIssue(meta)) return null;
  const code = meta.warningCode || "OCR_BACKEND_BAD_RESPONSE";
  const messages = isVi ? VI_WARNING_MESSAGES : EN_WARNING_MESSAGES;
  if (!meta.warningCode && typeof meta.warningMessage === "string" && meta.warningMessage.trim()) {
    return meta.warningMessage;
  }
  return messages[code] || messages.OCR_BACKEND_BAD_RESPONSE;
};

/**
 * @param {{ code?: string | null, warningCode?: string | null, error?: string | null, detail?: string | null, message?: string | null } | Error | string | null | undefined} errorLike
 * @param {boolean} [isVi=false]
 */
export const getFinanceOcrBackendErrorMessage = (errorLike, isVi = false) => {
  const code = typeof errorLike === "object" && errorLike
    ? errorLike.code || errorLike.warningCode || null
    : null;

  if (code === "OCR_BACKEND_TIMEOUT" || code === "OCR_BACKEND_UNREACHABLE" || code === "OCR_BACKEND_BAD_RESPONSE") {
    const messages = isVi ? VI_ERROR_MESSAGES : EN_ERROR_MESSAGES;
    return messages[code] || messages.OCR_BACKEND_BAD_RESPONSE;
  }

  return getErrorText(errorLike);
};
