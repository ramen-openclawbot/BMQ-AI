import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptMission,
  assertEmployeeActionAllowed,
  assertMissionReadable,
  buildMissionAuditEntry,
  toPublicMissions,
  type DbMissionRow,
} from "./payroll-missions.ts";

const TEMPLATE = {
  code: "T-DUNGGIO",
  name: "Đúng giờ",
  description: "Đi làm đúng giờ theo chấm công ca hành chính, sai số trong ngưỡng cho phép.",
  mode: "pay",
  verification: "auto",
  accept_deadline: "2026-10-05T17:00:00+07:00",
  reward_vnd: 100000,
};

function mission(overrides: Partial<DbMissionRow>): DbMissionRow {
  return {
    id: "mission-a",
    period_id: "period-m",
    employee_code: "A",
    status: "published",
    reason_text: "7 ngày trễ",
    source_metrics: { so_ngay_tre: 7 },
    reward_vnd: null,
    accepted_at: null,
    result_evidence: null,
    payroll_bn_mission_templates: TEMPLATE,
    ...overrides,
  };
}

const ROWS: DbMissionRow[] = [
  mission({ id: "mission-a", employee_code: "A" }),
  mission({ id: "mission-b", employee_code: "B" }),
  mission({ id: "mission-c", employee_code: "C", status: "suggested" }),
];

test("A chỉ đọc được nhiệm vụ của A, không đọc/nhận được nhiệm vụ của B", () => {
  const payload = toPublicMissions(ROWS, { employeeCode: "A" });
  assert.deepEqual(payload.missions.map((item) => item.id), ["mission-a"]);
  assert.equal(payload.missions[0].rewardVnd, 100000);
  assert.equal(payload.missions[0].description, TEMPLATE.description);

  assert.throws(() => assertMissionReadable(ROWS[1], "A"), /quyền đọc/);
  assert.doesNotThrow(() => assertMissionReadable(ROWS[0], "A"));
});

test("người không được chọn nhận danh sách rỗng", () => {
  const payload = toPublicMissions(ROWS, { employeeCode: "Z" });
  assert.deepEqual(payload, { employeeCode: "Z", missions: [] });
});

test("suggested không lộ cho nhân viên, kể cả khi là nhiệm vụ của chính họ", () => {
  const payload = toPublicMissions(ROWS, { employeeCode: "C" });
  assert.deepEqual(payload.missions, []);
});

test("nhân viên tự publish, sửa thưởng hoặc đánh dấu đạt đều bị từ chối", () => {
  assert.throws(() => assertEmployeeActionAllowed("publish"), /không được phép/);
  assert.throws(() => assertEmployeeActionAllowed("update_reward"), /không được phép/);
  assert.throws(() => assertEmployeeActionAllowed("mark_achieved"), /không được phép/);
  assert.doesNotThrow(() => assertEmployeeActionAllowed("read"));
  assert.doesNotThrow(() => assertEmployeeActionAllowed("accept"));
});

test("log kiểm tra không chứa số tiền", () => {
  const entry = buildMissionAuditEntry(
    {
      action: "accept",
      missionId: "mission-a",
      employeeCode: "A",
      rewardVnd: 100000,
      amount_vnd: 999999,
    },
    new Date("2026-10-11T03:04:05.000Z"),
  );
  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes("100000"), false);
  assert.equal(serialized.includes("999999"), false);
  assert.equal(serialized.includes("reward"), false);
  assert.deepEqual(Object.keys(entry).sort(), ["action", "at", "employeeCode", "missionId"]);
});

test("accept idempotent: published → accepted; đã accepted giữ nguyên; quá hạn → expired", () => {
  const now = new Date("2026-10-04T10:00:00+07:00");
  const accepted = acceptMission({ status: "published", acceptDeadline: "2026-10-05T17:00:00+07:00" }, now);
  assert.deepEqual(accepted, { status: "accepted", acceptedAt: now.toISOString() });

  const again = acceptMission({ status: "accepted", acceptedAt: accepted.acceptedAt }, now);
  assert.deepEqual(again, { status: "accepted", acceptedAt: accepted.acceptedAt });

  const late = acceptMission(
    { status: "published", acceptDeadline: "2026-10-03T17:00:00+07:00" },
    now,
  );
  assert.deepEqual(late, { status: "expired", acceptedAt: null });
});
