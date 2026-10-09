// Pure draw ("bốc thăm") tests — node:test, injected rng.
//
// THUONG_FIXTURE-style constants are not needed here: the draw only chooses
// people and missions, it never touches an amount.

import assert from "node:assert/strict";
import test from "node:test";

import { drawMissions } from "./draw.ts";
import type { MissionDrawPoolEntry } from "./types.ts";

const POOL: MissionDrawPoolEntry[] = [
  { employeeCode: "E1", missionIds: ["m1a", "m1b"] },
  { employeeCode: "E2", missionIds: ["m2a"] },
  { employeeCode: "E3", missionIds: ["m3a", "m3b"] },
  { employeeCode: "E4", missionIds: ["m4a"] },
  { employeeCode: "E5", missionIds: ["m5a"] },
];

/** Deterministic rng cycling a fixed list (independent of call count). */
function sequenceRng(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

test("rng cố định → kết quả ổn định", () => {
  const seed = () => sequenceRng([0.1, 0.7, 0.9, 0.4, 0.2, 0.6, 0.3, 0.8, 0.5, 0.15]);
  const first = drawMissions(POOL, 2, seed());
  const second = drawMissions(POOL, 2, seed());
  assert.deepEqual(first, second);
  assert.equal(first.picked.length, 2);
});

test("tối đa 2 người, đều trong pool, mỗi người 1 nhiệm vụ của họ", () => {
  const outcome = drawMissions(POOL, 2, sequenceRng([0.2, 0.8, 0.5, 0.3, 0.9, 0.6]));
  assert.equal(outcome.picked.length, 2);
  assert.equal(new Set(outcome.picked.map((pick) => pick.employeeCode)).size, 2);

  const missionIdsByEmployee = new Map(POOL.map((entry) => [entry.employeeCode, entry.missionIds]));
  for (const pick of outcome.picked) {
    const ids = missionIdsByEmployee.get(pick.employeeCode);
    assert.ok(ids, `người không thuộc pool: ${pick.employeeCode}`);
    assert.ok(ids!.includes(pick.missionId), `nhiệm vụ không thuộc người: ${pick.missionId}`);
  }
});

test("max = 0 → không bốc ai (không lỗi)", () => {
  assert.deepEqual(drawMissions(POOL, 0, () => 0.5).picked, []);
});

test("max lớn hơn pool → bốc hết pool, mỗi người một nhiệm vụ", () => {
  const outcome = drawMissions(POOL, 99, sequenceRng([0.4, 0.6, 0.3, 0.7, 0.1, 0.9, 0.2, 0.5]));
  assert.equal(outcome.picked.length, POOL.length);
  assert.equal(new Set(outcome.picked.map((pick) => pick.employeeCode)).size, POOL.length);
});

test("pool 1 người → 1 người", () => {
  const outcome = drawMissions([{ employeeCode: "E1", missionIds: ["m1"] }], 2, () => 0.5);
  assert.deepEqual(outcome.picked, [{ employeeCode: "E1", missionId: "m1" }]);
});

test("pool rỗng → lỗi", () => {
  assert.throws(() => drawMissions([], 2, () => 0.5), /Không có nhân viên/);
});
