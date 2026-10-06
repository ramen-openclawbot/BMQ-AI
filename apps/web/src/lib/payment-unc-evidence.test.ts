import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeUncStoragePath,
  summarizeUncPayments,
  type UncEvidencePaymentRow,
} from "./payment-unc-evidence.ts";

test("normalizeUncStoragePath strips the payment-unc bucket prefix", () => {
  assert.equal(normalizeUncStoragePath("payment-unc/2026/10/slip.jpg"), "2026/10/slip.jpg");
  assert.equal(normalizeUncStoragePath("2026/10/slip.jpg"), "2026/10/slip.jpg");
  assert.equal(normalizeUncStoragePath("payment-unc/slip.jpg"), "slip.jpg");
});

test("normalizeUncStoragePath rejects empty and traversal paths", () => {
  assert.equal(normalizeUncStoragePath(""), null);
  assert.equal(normalizeUncStoragePath("   "), null);
  assert.equal(normalizeUncStoragePath(null), null);
  assert.equal(normalizeUncStoragePath(undefined), null);
  assert.equal(normalizeUncStoragePath("payment-unc/"), null);
  assert.equal(normalizeUncStoragePath("payment-unc/../secret.jpg"), null);
  assert.equal(normalizeUncStoragePath("a/../../b.jpg"), null);
});

const paymentRow = (overrides: Partial<UncEvidencePaymentRow> = {}): UncEvidencePaymentRow => ({
  payment_id: overrides.payment_id ?? "pay-1",
  payment_number: overrides.payment_number ?? "PAY-000001",
  payment_date: overrides.payment_date ?? "2026-10-06",
  payment_total: overrides.payment_total ?? 1_500_000,
  allocated_to_request: overrides.allocated_to_request ?? 1_000_000,
  reference_number: overrides.reference_number ?? "FT26001001",
  evidence: overrides.evidence ?? null,
  siblings: overrides.siblings ?? null,
  ...overrides,
});

test("summarizeUncPayments turns RPC rows into display rows", () => {
  const rows = summarizeUncPayments([
    paymentRow({
      evidence: {
        storage_path: "payment-unc/2026/10/slip.jpg",
        transfer_date: "2026-10-06",
        ocr_amount: 1_500_000,
        manual_override: true,
        override_reason: "Ngân hàng trừ phí",
        category: "khac",
      },
    }),
  ]);

  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.paymentId, "pay-1");
  assert.equal(row.paymentTotal, 1_500_000);
  assert.equal(row.allocatedToRequest, 1_000_000);
  assert.equal(row.hasEvidence, true);
  assert.equal(row.storagePath, "payment-unc/2026/10/slip.jpg");
  assert.equal(row.evidenceTransferDate, "2026-10-06");
  assert.equal(row.evidenceAmount, 1_500_000);
  assert.equal(row.manualOverride, true);
  assert.equal(row.overrideReason, "Ngân hàng trừ phí");
  assert.equal(row.category, "khac");
});

test("summarizeUncPayments marks a payment without evidence", () => {
  const [row] = summarizeUncPayments([paymentRow({ evidence: null })]);
  assert.equal(row.hasEvidence, false);
  assert.equal(row.storagePath, null);
  assert.equal(row.evidenceAmount, null);
  assert.equal(row.manualOverride, false);
  assert.equal(row.overrideReason, null);
  assert.equal(row.siblings.length, 0);
});

test("summarizeUncPayments sorts siblings by request number", () => {
  const [row] = summarizeUncPayments([
    paymentRow({
      siblings: [
        { request_id: "r-3", request_number: "PC-0003", amount: 300_000 },
        { request_id: "r-1", request_number: "PC-0001", amount: 100_000 },
        { request_id: "r-2", request_number: "PC-0002", amount: 200_000 },
      ],
    }),
  ]);

  assert.deepEqual(
    row.siblings.map((sibling) => [sibling.requestId, sibling.requestNumber, sibling.amount]),
    [
      ["r-1", "PC-0001", 100_000],
      ["r-2", "PC-0002", 200_000],
      ["r-3", "PC-0003", 300_000],
    ],
  );
});

test("summarizeUncPayments tolerates a null/empty RPC result", () => {
  assert.deepEqual(summarizeUncPayments(null), []);
  assert.deepEqual(summarizeUncPayments(undefined), []);
  assert.deepEqual(summarizeUncPayments([]), []);
});
