// Maps a cancel_supplier_order RPC error to the HTTP response the edge returns.
// Pure function so it can be tested without a database or network.

export type CancelErrorMapping = {
  status: number;
  code: string;
  message?: string;
};

function errorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code ?? "");
  }
  return "";
}

/** Vietnamese text after the "code: " prefix raised by the PO cancel guards. */
function guardMessage(error: unknown): string | undefined {
  const message = errorMessage(error);
  const separator = message.indexOf(":");
  if (separator < 0) return undefined;
  const text = message.slice(separator + 1).trim();
  return text || undefined;
}

export function mapCancelError(error: unknown): CancelErrorMapping {
  const message = errorMessage(error);
  const code = errorCode(error);

  if (code === "42501" || message.includes("insufficient_privilege")) {
    return { status: 403, code: "forbidden" };
  }
  if (message.includes("cancel_reason_required")) {
    return { status: 400, code: "cancel_reason_required" };
  }
  if (message.includes("order_not_found") || code === "P0002") {
    return { status: 404, code: "order_not_found" };
  }
  if (message.includes("order_not_cancellable")) {
    return { status: 409, code: "order_not_cancellable" };
  }
  if (message.includes("po_cancel_has_receipt")) {
    return {
      status: 409,
      code: "cancel_has_receipt",
      message: guardMessage(error),
    };
  }
  if (message.includes("po_cancel_has_payments")) {
    return {
      status: 409,
      code: "cancel_has_payments",
      message: guardMessage(error),
    };
  }
  return { status: 500, code: "cancel_failed" };
}
