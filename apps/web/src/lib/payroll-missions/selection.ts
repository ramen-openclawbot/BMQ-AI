// Client-side mirror of the server publish rules:
//   * at most N = settings.max_employees distinct employees per period;
//   * at most one mission per employee per period.
// The server re-checks everything inside the publish transaction (source of
// truth); this function only stops an obviously invalid selection early.

import type { MissionPeriodSettings } from "./types.ts";

export interface MissionSelectionEntry {
  employeeCode: string;
}

export type MissionSelectionCheck =
  | { ok: true }
  | { ok: false; code: "max_employees" | "one_per_employee"; message: string };

export function validateMissionSelection(input: {
  published: readonly MissionSelectionEntry[];
  candidateEmployeeCode: string;
  settings: Pick<MissionPeriodSettings, "maxEmployees">;
}): MissionSelectionCheck {
  const candidate = String(input.candidateEmployeeCode ?? "").trim();
  if (candidate === "") {
    return { ok: false, code: "one_per_employee", message: "Thiếu mã nhân viên." };
  }

  if (input.published.some((entry) => entry.employeeCode === candidate)) {
    return {
      ok: false,
      code: "one_per_employee",
      message: `Nhân viên ${candidate} đã có nhiệm vụ trong kỳ này.`,
    };
  }

  const distinct = new Set(input.published.map((entry) => entry.employeeCode));
  if (distinct.size >= input.settings.maxEmployees) {
    return {
      ok: false,
      code: "max_employees",
      message: `Kỳ này chỉ được phát hành tối đa ${input.settings.maxEmployees} nhân viên.`,
    };
  }

  return { ok: true };
}
