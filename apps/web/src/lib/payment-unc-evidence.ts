// Pure helpers for the read-only "Chứng từ UNC" evidence panel. No Supabase /
// React imports so path normalization and row summarisation stay unit-testable
// and mirror public.get_payment_request_unc_evidence.

export interface UncEvidenceRecord {
  storage_path: string | null;
  transfer_date: string | null;
  ocr_amount: number | null;
  manual_override: boolean;
  override_reason: string | null;
  category: string | null;
}

export interface UncEvidenceSibling {
  request_id: string;
  request_number: string;
  amount: number;
}

export interface UncEvidencePaymentRow {
  payment_id: string;
  payment_number: string;
  payment_date: string | null;
  payment_total: number;
  allocated_to_request: number;
  reference_number: string | null;
  evidence: UncEvidenceRecord | null;
  siblings: UncEvidenceSibling[] | null;
}

export interface UncEvidenceDisplaySibling {
  requestId: string;
  requestNumber: string;
  amount: number;
}

export interface UncEvidenceDisplayRow {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string | null;
  paymentTotal: number;
  allocatedToRequest: number;
  referenceNumber: string | null;
  hasEvidence: boolean;
  storagePath: string | null;
  evidenceTransferDate: string | null;
  evidenceAmount: number | null;
  manualOverride: boolean;
  overrideReason: string | null;
  category: string | null;
  siblings: UncEvidenceDisplaySibling[];
}

const BUCKET_PREFIX = "payment-unc/";

/**
 * Strip the leading bucket name from a stored UNC evidence path so it can be
 * passed to supabase.storage.from('payment-unc').createSignedUrl. Empty paths
 * and traversal segments are rejected (return null).
 */
export function normalizeUncStoragePath(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  let path = raw.startsWith(BUCKET_PREFIX) ? raw.slice(BUCKET_PREFIX.length) : raw;
  path = path.replace(/^\/+/, "");
  if (!path) return null;
  if (path.split("/").some((segment) => segment === "..")) return null;
  return path;
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toOptionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Display rows for one payment request, with siblings sorted by request number. */
export function summarizeUncPayments(
  rows: UncEvidencePaymentRow[] | null | undefined,
): UncEvidenceDisplayRow[] {
  return (rows ?? []).map((row) => {
    const evidence = row.evidence ?? null;
    const siblings = [...(row.siblings ?? [])]
      .map((sibling) => ({
        requestId: String(sibling?.request_id ?? ""),
        requestNumber: String(sibling?.request_number ?? ""),
        amount: toNumber(sibling?.amount),
      }))
      .sort((a, b) => a.requestNumber.localeCompare(b.requestNumber));

    return {
      paymentId: String(row.payment_id ?? ""),
      paymentNumber: String(row.payment_number ?? ""),
      paymentDate: row.payment_date ?? null,
      paymentTotal: toNumber(row.payment_total),
      allocatedToRequest: toNumber(row.allocated_to_request),
      referenceNumber: row.reference_number ?? null,
      hasEvidence: evidence !== null,
      storagePath: evidence?.storage_path ?? null,
      evidenceTransferDate: evidence?.transfer_date ?? null,
      evidenceAmount: evidence ? toOptionalNumber(evidence.ocr_amount) : null,
      manualOverride: evidence?.manual_override === true,
      overrideReason: evidence?.override_reason ?? null,
      category: evidence?.category ?? null,
      siblings,
    };
  });
}
