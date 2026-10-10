import assert from "node:assert/strict";
import test from "node:test";

import {
  matchSalaryPayout,
  normalizeSalaryPayoutName,
  salaryPayoutNameSimilarity,
  type SalaryPayoutLine,
  type SalaryPayoutReceipt,
} from "./salary-payout-match.ts";

const line = (
  id: string,
  employee_name: string,
  net_pay: number,
  matched = false,
): SalaryPayoutLine => ({ id, employee_name, net_pay, matched });

const receipt = (
  id: string,
  amount: number | null,
  beneficiary: string | null = null,
): SalaryPayoutReceipt => ({ id, amount, beneficiary });

test("normalises accents and case for the beneficiary name", () => {
  assert.equal(normalizeSalaryPayoutName("Nguyễn Thị Xuân Mai"), "nguyen thi xuan mai");
  assert.equal(normalizeSalaryPayoutName("  NGUYEN   THI  XUAN MAI "), "nguyen thi xuan mai");
  assert.equal(salaryPayoutNameSimilarity("NGUYEN THI XUAN MAI", "Nguyễn Thị Xuân Mai"), 1);
  assert.ok(salaryPayoutNameSimilarity("Nguyễn Văn A", "Khách lẻ") < 0.5);
});

test("16 employees: two equal salaries are resolved by beneficiary name", () => {
  const lines: SalaryPayoutLine[] = [];
  const receipts: SalaryPayoutReceipt[] = [];
  for (let index = 1; index <= 14; index += 1) {
    const id = `line-${index}`;
    const amount = 4_000_000 + index * 111_000;
    lines.push(line(id, `Nhân Viên ${index}`, amount));
    receipts.push(receipt(`receipt-${index}`, amount, `Nhan Vien ${index}`));
  }
  lines.push(line("line-15", "Nguyễn Thị Xuân Mai", 8_000_000));
  lines.push(line("line-16", "Trần Văn Bình", 8_000_000));
  receipts.push(receipt("receipt-15", 8_000_000, "NGUYEN THI XUAN MAI"));
  receipts.push(receipt("receipt-16", 8_000_000, "TRAN VAN BINH"));

  const result = matchSalaryPayout(lines, receipts);

  assert.equal(result.proposals.length, 16);
  assert.deepEqual(result.missing_lines, []);
  assert.deepEqual(result.unmatched_receipts, []);

  const equal = result.proposals.filter(
    (proposal) => proposal.line_id === "line-15" || proposal.line_id === "line-16",
  );
  assert.equal(equal.length, 2);
  for (const proposal of equal) assert.equal(proposal.reason, "name");
  const byLine = new Map(result.proposals.map((proposal) => [proposal.line_id, proposal]));
  assert.equal(byLine.get("line-15")?.receipt_id, "receipt-15");
  assert.equal(byLine.get("line-16")?.receipt_id, "receipt-16");
});

test("unresolvable tie leaves both lines missing and both receipts unmatched", () => {
  const lines = [
    line("line-a", "Nguyễn Văn A", 7_000_000),
    line("line-b", "Nguyễn Văn B", 7_000_000),
  ];
  const receipts = [
    receipt("receipt-x", 7_000_000, "Công ty TNHH XYZ"),
    receipt("receipt-y", 7_000_000, "Khách lẻ"),
  ];

  const result = matchSalaryPayout(lines, receipts);

  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.missing_lines.sort(), ["line-a", "line-b"]);
  assert.deepEqual(result.unmatched_receipts.sort(), ["receipt-x", "receipt-y"]);
});

test("a wrong amount never matches", () => {
  const result = matchSalaryPayout(
    [line("line-1", "Nguyễn Văn A", 5_000_000)],
    [receipt("receipt-1", 4_500_000, "Nguyễn Văn A")],
  );

  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.missing_lines, ["line-1"]);
  assert.deepEqual(result.unmatched_receipts, ["receipt-1"]);
});

test("a missing receipt leaves only that line unmatched", () => {
  const result = matchSalaryPayout(
    [
      line("line-1", "Nguyễn Văn A", 5_000_000),
      line("line-2", "Trần Thị B", 6_000_000),
    ],
    [receipt("receipt-1", 5_000_000, "Nguyễn Văn A")],
  );

  assert.deepEqual(result.proposals, [
    { receipt_id: "receipt-1", line_id: "line-1", reason: "amount" },
  ]);
  assert.deepEqual(result.missing_lines, ["line-2"]);
  assert.deepEqual(result.unmatched_receipts, []);
});

test("a duplicate receipt matches once and the extra is unmatched", () => {
  const result = matchSalaryPayout(
    [line("line-1", "Nguyễn Văn A", 6_000_000)],
    [
      receipt("receipt-1", 6_000_000, "Nguyễn Văn A"),
      receipt("receipt-2", 6_000_000, "Nguyễn Văn A"),
    ],
  );

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].line_id, "line-1");
  assert.equal(result.proposals[0].reason, "amount");
  assert.deepEqual(result.missing_lines, []);
  assert.equal(result.unmatched_receipts.length, 1);
  assert.ok(result.unmatched_receipts.includes("receipt-1") || result.unmatched_receipts.includes("receipt-2"));
});

test("already matched lines are skipped and do not consume receipts", () => {
  const result = matchSalaryPayout(
    [
      line("line-1", "Nguyễn Văn A", 5_000_000, true),
      line("line-2", "Trần Thị B", 6_000_000),
    ],
    [receipt("receipt-2", 6_000_000, "Trần Thị B"), receipt("receipt-1", 5_000_000, "Nguyễn Văn A")],
  );

  assert.deepEqual(result.proposals, [
    { receipt_id: "receipt-2", line_id: "line-2", reason: "amount" },
  ]);
  assert.deepEqual(result.missing_lines, []);
  assert.deepEqual(result.unmatched_receipts, ["receipt-1"]);
});
