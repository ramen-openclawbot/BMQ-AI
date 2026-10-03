/**
 * Summarizes a `Promise.allSettled` bulk approval run into a per-request
 * result. Pure (no I/O) so the partial-success semantics are unit tested: a
 * rejected request is always reported as failed with its id and message and is
 * never counted as approved.
 */
export interface ApprovalFailure {
  id: string;
  message: string;
}

export interface ApprovalSummary {
  count: number;
  approved: number;
  failed: ApprovalFailure[];
}

function failureMessage(result: PromiseSettledResult<unknown> | undefined): string {
  if (!result) return "Không nhận được kết quả duyệt";
  if (result.status === "rejected") {
    const reason: unknown = result.reason;
    if (reason instanceof Error && reason.message) return reason.message;
    if (typeof reason === "string" && reason.trim()) return reason;
    if (reason && typeof reason === "object" && "message" in reason) {
      const message = (reason as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    return "Lỗi không xác định";
  }
  return "Không duyệt được phiếu";
}

export function summarizeApprovalResults(
  ids: string[],
  settled: Array<PromiseSettledResult<{ approved: boolean }>>,
): ApprovalSummary {
  const failed: ApprovalFailure[] = [];
  let approved = 0;

  ids.forEach((id, index) => {
    const result = settled[index];
    if (result?.status === "fulfilled" && result.value?.approved === true) {
      approved += 1;
      return;
    }
    failed.push({ id, message: failureMessage(result) });
  });

  return { count: ids.length, approved, failed };
}
