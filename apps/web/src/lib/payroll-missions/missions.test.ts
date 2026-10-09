// Nhiệm vụ thưởng bất ngờ Payroll Bếp BN — domain tests (node:test).
//
// THUONG_FIXTURE is a TEST value (100.000 đồng), never a real reward level.
// The attendance data comes from missions-t09.fixture.ts, extracted from the
// original machine workbook; it is never hand-edited.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MISSIONS_T09_EMPLOYEES,
  MISSIONS_T09_PERIOD,
  MISSIONS_T09_ROWS,
} from "./missions-t09.fixture.ts";
import { computeMissionBonus } from "./bonus.ts";
import { evaluateMission } from "./evaluator.ts";
import { generateMissionSuggestions } from "./generator.ts";
import {
  assertMissionPeriodOpen,
  expireMission,
  missionStatusAfterEmployeeChange,
} from "./lifecycle.ts";
import { validateMissionSelection } from "./selection.ts";
import { buildMissionTemplate } from "./templates.ts";
import type { PayrollEmployee } from "../payroll-bn/types.ts";
import type { MissionAttendanceRow, MissionTemplate } from "./types.ts";

/** Fixture only — not a real reward level. */
export const THUONG_FIXTURE = 100_000;

function rowsFor(employeeCode: string): MissionAttendanceRow[] {
  return MISSIONS_T09_ROWS.filter((row) => row.employeeCode === employeeCode);
}

function employeeFor(employeeCode: string): PayrollEmployee {
  const employee = MISSIONS_T09_EMPLOYEES.find((item) => item.code === employeeCode);
  assert.ok(employee, `missing fixture employee ${employeeCode}`);
  return employee!;
}

function evaluateFor(employeeCode: string, template: MissionTemplate) {
  return evaluateMission({ template, attendance: rowsFor(employeeCode) });
}

const DUNGGIO_0 = buildMissionTemplate("T-DUNGGIO", {
  params: { dung_sai_phut: 0 },
  rewardVnd: THUONG_FIXTURE,
  acceptDeadline: "2026-10-05T17:00:00+07:00",
});
const DUNGGIO_1 = buildMissionTemplate("T-DUNGGIO", {
  params: { dung_sai_phut: 1 },
  rewardVnd: THUONG_FIXTURE,
  acceptDeadline: "2026-10-05T17:00:00+07:00",
});
const CHAMDU = buildMissionTemplate("T-CHAMDU", {
  rewardVnd: THUONG_FIXTURE,
  acceptDeadline: "2026-10-05T17:00:00+07:00",
});

// ---------------------------------------------------------------------------
// T-DUNGGIO
// ---------------------------------------------------------------------------

test("T-DUNGGIO dung sai 0 và 1: Long, Thao đạt; Thư không đạt rồi đạt", () => {
  assert.equal(evaluateFor("00030", DUNGGIO_0).status, "achieved"); // Long
  assert.equal(evaluateFor("00030", DUNGGIO_1).status, "achieved");
  assert.equal(evaluateFor("00033", DUNGGIO_0).status, "achieved"); // Thao
  assert.equal(evaluateFor("00033", DUNGGIO_1).status, "achieved");

  // Thư has exactly one HC day with Trễ = 1: fails at tolerance 0, passes at 1.
  const thu0 = evaluateFor("00005", DUNGGIO_0);
  assert.equal(thu0.status, "not_achieved");
  assert.equal((thu0.evidence as { late_days: number }).late_days, 1);
  assert.equal(evaluateFor("00005", DUNGGIO_1).status, "achieved");
});

test("T-DUNGGIO: Ngoc không đạt vì 7 ngày trễ", () => {
  const result = evaluateFor("00002", DUNGGIO_0);
  assert.equal(result.status, "not_achieved");
  assert.equal(result.reason, "7 ngày trễ");
  assert.equal((result.evidence as { late_days: number }).late_days, 7);
});

test("T-DUNGGIO: Duyên chỉ xét ngày ca HC, bỏ qua ca V", () => {
  const rows = rowsFor("00001");
  const hcAttended = rows.filter((row) => row.shift === "HC" && (row.checkIn !== null || row.checkOut !== null));
  const vAttended = rows.filter((row) => row.shift === "V" && (row.checkIn !== null || row.checkOut !== null));
  assert.ok(hcAttended.length > 0);
  assert.ok(vAttended.length > 0);

  const evidence = evaluateFor("00001", DUNGGIO_0).evidence as {
    considered_days: number;
    ignored_v_days: number;
    late_dates: string[];
  };
  assert.equal(evidence.considered_days, hcAttended.length);
  assert.equal(evidence.ignored_v_days, vAttended.length);
  const hcDates = new Set(hcAttended.map((row) => row.date));
  for (const date of evidence.late_dates) assert.ok(hcDates.has(date), `V day leaked: ${date}`);
});

// ---------------------------------------------------------------------------
// T-CHAMDU
// ---------------------------------------------------------------------------

test("T-CHAMDU: T.Huy không đạt (thiếu giờ ra) và Hồng 30/09 cần xem lại", () => {
  const huy = evaluateFor("00034", CHAMDU);
  assert.equal(huy.status, "not_achieved");
  assert.deepEqual((huy.evidence as { missing_punch_dates: string[] }).missing_punch_dates, ["2026-09-03"]);

  const hong = evaluateFor("00006", CHAMDU);
  assert.equal(hong.status, "needs_review");
  assert.deepEqual((hong.evidence as { abnormal_dates: string[] }).abnormal_dates, ["2026-09-30"]);
});

test("T-CHAMDU: Long đạt vì chấm đủ giờ vào/ra, không cờ bất thường", () => {
  assert.equal(evaluateFor("00030", CHAMDU).status, "achieved");
});

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

test("gợi ý: nguong_de_xuat = 1 thấy Ngoc '7 ngày trễ', nguong_de_xuat = 8 thì không", () => {
  const low = buildMissionTemplate("T-DUNGGIO", {
    params: { dung_sai_phut: 0, nguong_de_xuat: 1 },
  });
  const suggestions = generateMissionSuggestions({
    period: MISSIONS_T09_PERIOD,
    employees: MISSIONS_T09_EMPLOYEES,
    previousRows: MISSIONS_T09_ROWS,
    templates: [low],
  });
  const ngoc = suggestions.find((item) => item.employeeCode === "00002");
  assert.ok(ngoc);
  assert.equal(ngoc!.reasonText, "7 ngày trễ");
  assert.equal(ngoc!.sourceMetrics.so_ngay_tre, 7);

  const high = buildMissionTemplate("T-DUNGGIO", {
    params: { dung_sai_phut: 0, nguong_de_xuat: 8 },
  });
  const strict = generateMissionSuggestions({
    period: MISSIONS_T09_PERIOD,
    employees: MISSIONS_T09_EMPLOYEES,
    previousRows: MISSIONS_T09_ROWS,
    templates: [high],
  });
  assert.equal(strict.some((item) => item.employeeCode === "00002"), false);
});

test("gợi ý chạy lại không trùng và ổn định", () => {
  const template = buildMissionTemplate("T-DUNGGIO", {
    params: { dung_sai_phut: 0, nguong_de_xuat: 1 },
  });
  const input = {
    period: MISSIONS_T09_PERIOD,
    employees: MISSIONS_T09_EMPLOYEES,
    previousRows: MISSIONS_T09_ROWS,
    templates: [template],
  };
  const first = generateMissionSuggestions(input);
  const again = generateMissionSuggestions(input);
  assert.deepEqual(again, first);
  assert.ok(first.length > 0);

  const existing = first.map((item) => ({
    employeeCode: item.employeeCode,
    templateCode: item.templateCode,
  }));
  assert.deepEqual(generateMissionSuggestions({ ...input, existing }), []);
});

test("gợi ý bỏ qua người vào giữa kỳ trừ khi template cho tính theo tỷ lệ", () => {
  const template = buildMissionTemplate("T-DUNGGIO", {
    params: { dung_sai_phut: 0, nguong_de_xuat: 1 },
  });
  const prorated = buildMissionTemplate("T-DUNGGIO", {
    params: { dung_sai_phut: 0, nguong_de_xuat: 1 },
    prorateAllowed: true,
  });
  // Positive control: Ngoc (7 ngày trễ) joined mid-period.
  const midJoiner = MISSIONS_T09_EMPLOYEES.map((employee) =>
    employee.code === "00002" ? { ...employee, startDate: "2026-09-15" } : employee,
  );

  const withoutProrate = generateMissionSuggestions({
    period: MISSIONS_T09_PERIOD,
    employees: midJoiner,
    previousRows: MISSIONS_T09_ROWS,
    templates: [template],
  });
  assert.equal(withoutProrate.some((item) => item.employeeCode === "00002"), false);
  // Hồng (start 2026-09-30) is skipped for a whole-month mission too.
  assert.equal(withoutProrate.some((item) => item.employeeCode === "00006"), false);

  const withProrate = generateMissionSuggestions({
    period: MISSIONS_T09_PERIOD,
    employees: midJoiner,
    previousRows: MISSIONS_T09_ROWS,
    templates: [prorated],
  });
  const ngoc = withProrate.find((item) => item.employeeCode === "00002");
  assert.ok(ngoc);
  assert.equal(ngoc!.reasonText, "7 ngày trễ");
});

// ---------------------------------------------------------------------------
// Selection — client mirror of the server publish rules
// ---------------------------------------------------------------------------

test("chọn người: phát hành người thứ 3 bị từ chối, một người hai nhiệm vụ bị từ chối", () => {
  const settings = { maxEmployees: 2 };
  const published = [{ employeeCode: "00030" }, { employeeCode: "00033" }];

  const third = validateMissionSelection({ published, candidateEmployeeCode: "00005", settings });
  assert.equal(third.ok, false);
  assert.equal(third.ok ? null : third.code, "max_employees");

  const secondMission = validateMissionSelection({
    published: [{ employeeCode: "00030" }],
    candidateEmployeeCode: "00030",
    settings,
  });
  assert.equal(secondMission.ok, false);
  assert.equal(secondMission.ok ? null : secondMission.code, "one_per_employee");

  assert.deepEqual(validateMissionSelection({ published: [{ employeeCode: "00030" }], candidateEmployeeCode: "00033", settings }), { ok: true });
});

// ---------------------------------------------------------------------------
// Money guards, deadline and resignation
// ---------------------------------------------------------------------------

test("thiếu tham số: template bắt buộc thiếu → lỗi; thưởng null → không cộng tiền", () => {
  assert.throws(() => buildMissionTemplate("T-GIOPT", { params: {} }), /gio_toi_thieu/);
  assert.throws(() => buildMissionTemplate("T-GIOPT", { params: { gio_toi_thieu: 80 } }), /gio_toi_da/);
  assert.throws(() => buildMissionTemplate("T-DUNGGIO", { params: {} }), /dung_sai_phut/);

  const nullReward = computeMissionBonus({
    entries: [
      { employeeCode: "00030", missionCode: "T-DUNGGIO", status: "achieved", mode: "pay", rewardVnd: null },
    ],
    budgetVnd: 1_000_000,
  });
  assert.deepEqual(nullReward, { totalVnd: 0, lines: [] });
});

test("vượt trần thì chặn và báo số vượt", () => {
  assert.throws(
    () =>
      computeMissionBonus({
        entries: [
          { employeeCode: "00030", missionCode: "T-DUNGGIO", status: "achieved", mode: "pay", rewardVnd: 100_000 },
        ],
        budgetVnd: 40_000,
      }),
    /60000 đồng/,
  );
});

test("quá hạn → expired; nghỉ việc → cancelled; kỳ đã chốt → lỗi", () => {
  const now = new Date("2026-10-06T00:00:00+07:00");
  assert.equal(
    expireMission({ status: "published", acceptDeadline: "2026-10-05T17:00:00+07:00" }, now),
    "expired",
  );
  assert.equal(
    expireMission({ status: "published", acceptDeadline: "2026-10-07T17:00:00+07:00" }, now),
    "published",
  );
  assert.equal(
    expireMission({ status: "accepted", acceptDeadline: "2026-10-05T17:00:00+07:00" }, now),
    "accepted",
  );

  const gone: PayrollEmployee = { ...employeeFor("00030"), terminated: true };
  assert.equal(missionStatusAfterEmployeeChange("published", gone, MISSIONS_T09_PERIOD), "cancelled");
  assert.equal(missionStatusAfterEmployeeChange("paid", gone, MISSIONS_T09_PERIOD), "paid");

  assertMissionPeriodOpen("draft");
  assert.throws(() => assertMissionPeriodOpen("locked"), /đã chốt/);
});

test("T-DUNGGIO: so_ngay_tre_toi_da cho phép đúng số ngày trễ cấu hình", () => {
  const ngoc = rowsFor("00002");
  const allow7 = buildMissionTemplate("T-DUNGGIO", { params: { dung_sai_phut: 0, so_ngay_tre_toi_da: 7 } });
  const allow6 = buildMissionTemplate("T-DUNGGIO", { params: { dung_sai_phut: 0, so_ngay_tre_toi_da: 6 } });
  assert.equal(evaluateMission({ template: allow7, attendance: ngoc }).status, "achieved");
  assert.equal(evaluateMission({ template: allow6, attendance: ngoc }).status, "not_achieved");
});

test("T-GIOPT: đạt chỉ khi tổng giờ nằm trong mốc tối thiểu–tối đa; chỉ gợi ý part-time", () => {
  const long = rowsFor("00030");
  const hours = long.filter((row) => row.checkIn && row.checkOut).length > 0;
  assert.ok(hours, "fixture Long phải có chấm công");
  const wide = buildMissionTemplate("T-GIOPT", { params: { gio_toi_thieu: 1, gio_toi_da: 10_000 } });
  const tooLow = buildMissionTemplate("T-GIOPT", { params: { gio_toi_thieu: 9_000, gio_toi_da: 10_000 } });
  const capped = buildMissionTemplate("T-GIOPT", { params: { gio_toi_thieu: 0, gio_toi_da: 1 } });
  assert.equal(evaluateMission({ template: wide, attendance: long }).status, "achieved");
  assert.equal(evaluateMission({ template: tooLow, attendance: long }).status, "not_achieved");
  assert.equal(evaluateMission({ template: capped, attendance: long }).status, "not_achieved");

  const suggestions = generateMissionSuggestions({
    period: MISSIONS_T09_PERIOD,
    employees: [employeeFor("00030"), employeeFor("00005")],
    previousRows: MISSIONS_T09_ROWS,
    templates: [wide],
  });
  assert.deepEqual(suggestions.map((item) => item.employeeCode), ["00030"]);
  assert.match(suggestions[0].reasonText, /mốc 1–10000 giờ/);
});
