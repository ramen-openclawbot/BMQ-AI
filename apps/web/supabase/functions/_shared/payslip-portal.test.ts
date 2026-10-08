import assert from "node:assert/strict";
import test from "node:test";

import {
  getPayslipSessionExpiresAt,
  isPayslipSessionActive,
  normalizePayslipPhone,
  PAYSLIP_OTP_MAX_ATTEMPTS,
  PAYSLIP_SESSION_TTL_HOURS,
  toPublicPayslips,
  validatePayslipOtpChallenge,
  type DbPayslipRow,
} from "./payslip-portal.ts";

test("normalizePayslipPhone accepts mobiles and rejects everything else", () => {
  assert.equal(normalizePayslipPhone("0901234567"), "84901234567");
  assert.equal(normalizePayslipPhone("+84 90 123 4567"), "84901234567");
  assert.equal(normalizePayslipPhone("84987654321"), "84987654321");
  assert.equal(normalizePayslipPhone("0084987654321"), "84987654321");
  assert.equal(normalizePayslipPhone("0281234567"), null);
  assert.equal(normalizePayslipPhone("12345"), null);
  assert.equal(normalizePayslipPhone(null), null);
});

test("validatePayslipOtpChallenge rejects consumed, exhausted and expired", () => {
  const now = new Date("2026-10-09T10:00:00.000Z");
  const future = "2026-10-09T10:05:00.000Z";
  const past = "2026-10-09T09:55:00.000Z";

  assert.deepEqual(validatePayslipOtpChallenge({ expires_at: future }, now), { ok: true });
  assert.deepEqual(
    validatePayslipOtpChallenge({ expires_at: future, consumed_at: past }, now),
    { ok: false, code: "otp_consumed" },
  );
  assert.deepEqual(
    validatePayslipOtpChallenge({ expires_at: future, attempt_count: PAYSLIP_OTP_MAX_ATTEMPTS }, now),
    { ok: false, code: "otp_max_attempts" },
  );
  assert.deepEqual(
    validatePayslipOtpChallenge({ expires_at: past }, now),
    { ok: false, code: "otp_expired" },
  );
  assert.deepEqual(
    validatePayslipOtpChallenge({ expires_at: future, attempt_count: PAYSLIP_OTP_MAX_ATTEMPTS - 1 }, now),
    { ok: true },
  );
});

test("portal sessions last 12 hours and expire or revoke", () => {
  const now = new Date("2026-10-09T10:00:00.000Z");
  const expiresAt = getPayslipSessionExpiresAt(now);
  assert.equal(
    new Date(expiresAt).getTime() - now.getTime(),
    PAYSLIP_SESSION_TTL_HOURS * 60 * 60 * 1000,
  );

  assert.equal(isPayslipSessionActive({ expires_at: expiresAt }, now), true);
  assert.equal(isPayslipSessionActive({ expires_at: expiresAt, revoked_at: now.toISOString() }, now), false);
  assert.equal(isPayslipSessionActive({ expires_at: new Date(now.getTime() - 1).toISOString() }, now), false);
});

const ROWS: DbPayslipRow[] = [
  {
    id: "payslip-aug",
    period_id: "period-aug",
    employee_code: "E01",
    employee_name: "Nguyễn Văn A",
    group_name: "Bếp bánh",
    period_name: "Kỳ lương tháng 08/2026 — Bếp BN",
    date_from: "2026-08-01",
    date_to: "2026-08-31",
    net_pay: "7096000",
    lines: [
      { key: "gross_pay", label: "Tổng thu nhập", value: 7096000, unit: "vnd" },
      { key: "work_days", label: "Ngày công tính lương", value: 27, unit: "day" },
    ],
    note: null,
    published_at: "2026-09-01T00:00:00.000Z",
    published_by: "owner-uuid",
  },
  {
    id: "payslip-sep",
    period_id: "period-sep",
    employee_code: "E01",
    employee_name: "Nguyễn Văn A",
    group_name: "Bếp bánh",
    period_name: "Kỳ lương tháng 09/2026 — Bếp BN",
    date_from: "2026-09-01",
    date_to: "2026-09-30",
    net_pay: 7192000,
    lines: [{ key: "gross_pay", label: "Tổng thu nhập", value: 7192307.69, unit: "vnd" }],
    note: "Chốt lương",
    published_at: "2026-10-01T00:00:00.000Z",
    published_by: "owner-uuid",
  },
  {
    id: "payslip-other",
    period_id: "period-sep-other",
    employee_code: "E02",
    employee_name: "Trần Thị B",
    group_name: "Kho BN",
    period_name: "Kỳ lương tháng 09/2026 — Bếp BN",
    date_from: "2026-09-01",
    date_to: "2026-09-30",
    net_pay: 5000000,
    lines: [],
    note: null,
    published_at: "2026-10-01T00:00:00.000Z",
    published_by: "owner-uuid",
  },
];

test("toPublicPayslips drops other employees and orders newest period first", () => {
  const payload = toPublicPayslips(ROWS, { employeeCode: "E01" });

  assert.deepEqual(payload.employee, { code: "E01", name: "Nguyễn Văn A", groupName: "Bếp bánh" });
  assert.equal(payload.payslips.length, 2);
  assert.deepEqual(payload.payslips.map((item) => item.periodId), ["period-sep", "period-aug"]);
  assert.deepEqual(payload.payslips[0], {
    periodId: "period-sep",
    periodName: "Kỳ lương tháng 09/2026 — Bếp BN",
    dateFrom: "2026-09-01",
    dateTo: "2026-09-30",
    publishedAt: "2026-10-01T00:00:00.000Z",
    employeeCode: "E01",
    employeeName: "Nguyễn Văn A",
    netPay: 7192000,
    lines: [{ key: "gross_pay", label: "Tổng thu nhập", value: 7192307.69, unit: "vnd" }],
    note: "Chốt lương",
  });
});

test("toPublicPayslips never leaks ids or published_by", () => {
  const payload = toPublicPayslips(ROWS, { employeeCode: "E01" });
  for (const payslip of payload.payslips) {
    assert.equal("id" in payslip, false);
    assert.equal("publishedBy" in payslip, false);
    assert.equal("published_by" in payslip, false);
  }
});

test("toPublicPayslips returns an empty list when the employee has no payslips", () => {
  const payload = toPublicPayslips(ROWS, { employeeCode: "E99", employeeName: "Chưa có" });
  assert.equal(payload.employee.code, "E99");
  assert.deepEqual(payload.payslips, []);
});

test("toPublicPayslips tolerates a numeric-string net_pay and unknown lines", () => {
  const payload = toPublicPayslips(
    [{ ...ROWS[0], lines: "not-an-array" as unknown }],
    { employeeCode: "E01" },
  );
  assert.equal(payload.payslips[0].netPay, 7096000);
  assert.deepEqual(payload.payslips[0].lines, []);
});
