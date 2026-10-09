// Pure draw ("bốc thăm") logic for the Bếp BN surprise missions.
//
// The database RPC payroll_bn_mission_draw is the source of truth (it locks the
// settings row and writes the audit trail). This module is the node:test mirror:
// same rules, but an injected rng so the result is deterministic under test.
//
// Rules:
//   * at most `max` distinct employees (settings.max_employees);
//   * exactly one suggested mission per drawn employee, always one of theirs;
//   * an empty pool is an explicit error, never a silent no-op.

import type {
  MissionDrawOutcome,
  MissionDrawPick,
  MissionDrawPoolEntry,
} from "./types.ts";

export type MissionRng = () => number;

/** Fisher–Yates using the injected rng (deterministic when rng is). */
function orderByRandom<T>(items: readonly T[], rng: MissionRng): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const bounded = Math.min(Math.max(j, 0), i);
    const swap = copy[i];
    copy[i] = copy[bounded];
    copy[bounded] = swap;
  }
  return copy;
}

function pickOne<T>(items: readonly T[], rng: MissionRng): T {
  const index = Math.min(Math.max(Math.floor(rng() * items.length), 0), items.length - 1);
  return items[index];
}

/**
 * Draw up to `max` employees from `pool`, then one of their suggested missions.
 * Throws on an empty pool (the operator must suggest first).
 */
export function drawMissions(
  pool: readonly MissionDrawPoolEntry[],
  max: number,
  rng: MissionRng,
): MissionDrawOutcome {
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new Error("Không có nhân viên nào có nhiệm vụ gợi ý để bốc thăm.");
  }

  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  // Only an employee with at least one suggested mission can be drawn.
  const drawable = pool.filter((entry) => entry.missionIds.length > 0);
  const chosen = orderByRandom(drawable, rng).slice(0, limit);

  const picked: MissionDrawPick[] = chosen.map((entry) => ({
    employeeCode: entry.employeeCode,
    missionId: pickOne(entry.missionIds, rng),
  }));

  return {
    pool: pool.map((entry) => ({ employeeCode: entry.employeeCode, missionIds: [...entry.missionIds] })),
    picked,
  };
}
