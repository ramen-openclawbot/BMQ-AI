import { financeControl } from "../i18n/financeControl";
import { formatText } from "../i18n/format";

export type FinanceMessage = { vi: string; en: string };
// Only explicit UI messages use this descriptor; backend text is carried verbatim.
export const financeMessage = (render: (isVi: boolean) => string): FinanceMessage => ({ vi: render(true), en: render(false) });
export const readFinanceMessage = (message: FinanceMessage | string | null, isVi: boolean) => typeof message === "string" ? message : message?.[isVi ? "vi" : "en"] ?? null;

export class FinanceUiError extends Error {
  constructor(readonly uiMessage: FinanceMessage, isVi: boolean) { super(uiMessage[isVi ? "vi" : "en"]); }
}
export const localizedFinanceError = (error: unknown, isVi: boolean, fallback: string) => error instanceof FinanceUiError ? error.uiMessage[isVi ? "vi" : "en"] : fallback;

// Extracted presentation boundaries; callers keep all financial guards and persistence.
export const financeErrorMessage = (error: unknown, fallback: FinanceMessage): FinanceMessage => {
  if (error instanceof FinanceUiError) return error.uiMessage;
  const detail = typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
  return detail ? { vi: detail, en: detail } : fallback;
};
export const retainFinanceError = (error: unknown, fallback: FinanceMessage, isVi: boolean): FinanceUiError =>
  error instanceof FinanceUiError ? error : new FinanceUiError(financeErrorMessage(error, fallback), isVi);
export const scanFailureDetail = (status: number, body: { details?: string; error?: string }): FinanceMessage => {
  return financeMessage((isVi) => status === 401
    ? financeControl[isVi ? "vi" : "en"].sessionExpired
    : body.details || body.error || `HTTP ${status}`);
};
export const ocrFileFailure = (type: "unc" | "qtm", file: string, error: unknown): FinanceMessage => {
  const reason = financeErrorMessage(error, financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].ocrFailed));
  return financeMessage((isVi) => `${type.toUpperCase()}: ${file || financeControl[isVi ? "vi" : "en"].unknownFile}: ${readFinanceMessage(reason, isVi)}`);
};
export const combinedOcrFailure = (scopes: Array<{ type: "UNC" | "QTM"; successful: number; total: number }>, errors: FinanceMessage[]): FinanceMessage =>
  financeMessage((isVi) => {
    const copy = financeControl[isVi ? "vi" : "en"];
    const summary = scopes.map(({ type, successful, total }) => formatText(copy.ocrFailureScope, {
      type, successful, total, failed: Math.max(total - successful, 0),
    })).join("; ");
    const preview = errors.slice(0, 8).map(error => readFinanceMessage(error, isVi)).join(" | ");
    return `${summary}. ${preview || copy.ocrFailureHelp}`;
  });
