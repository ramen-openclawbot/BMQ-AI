// Mission lifecycle: allowed status transitions, deadline expiry and the
// "nghỉ việc → cancelled" rule. Pure and deterministic; the database RPCs use
// the same guards.

import type { PayrollEmployee, PayrollPeriod, PayrollPeriodStatus } from "../payroll-bn/types.ts";
import type { MissionStatus } from "./types.ts";

export const MISSION_STATUSES: readonly MissionStatus[] = [
  "suggested",
  "published",
  "accepted",
  "achieved",
  "not_achieved",
  "needs_review",
  "expired",
  "cancelled",
  "paid",
];

const ALLOWED_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  suggested: ["published", "cancelled", "expired"],
  published: ["accepted", "cancelled", "expired", "needs_review"],
  accepted: ["achieved", "not_achieved", "needs_review", "cancelled", "expired"],
  achieved: ["paid", "cancelled"],
  not_achieved: [],
  needs_review: ["achieved", "not_achieved", "cancelled"],
  expired: [],
  cancelled: [],
  paid: [],
};

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

function isTerminal(status: MissionStatus): boolean {
  return status === "expired" || status === "cancelled" || status === "paid";
}

/**
 * Quá hạn thì expired. Only a mission still waiting for the employee
 * (suggested / published) can expire; anything already accepted keeps its state.
 */
export function expireMission(
  mission: { status: MissionStatus; acceptDeadline: string | null },
  now: Date = new Date(),
): MissionStatus {
  if (mission.status !== "suggested" && mission.status !== "published") return mission.status;
  if (!mission.acceptDeadline) return mission.status;
  const deadline = new Date(mission.acceptDeadline).getTime();
  if (!Number.isFinite(deadline)) return mission.status;
  return deadline < now.getTime() ? "expired" : mission.status;
}

/** An employee who terminated, or left before the period started, is gone. */
export function isEmployeeGone(employee: PayrollEmployee, period: Pick<PayrollPeriod, "dateFrom">): boolean {
  if (employee.terminated) return true;
  const end = employee.endDate ?? null;
  return Boolean(end && end < period.dateFrom);
}

/** Nghỉ việc → cancelled, unless the mission already reached a terminal state. */
export function missionStatusAfterEmployeeChange(
  status: MissionStatus,
  employee: PayrollEmployee,
  period: Pick<PayrollPeriod, "dateFrom">,
): MissionStatus {
  if (isTerminal(status)) return status;
  return isEmployeeGone(employee, period) ? "cancelled" : status;
}

/** A locked period rejects every mission write. */
export function assertMissionPeriodOpen(status: PayrollPeriodStatus): void {
  if (status === "locked") {
    throw new Error("Kỳ lương đã chốt, không thể thay đổi nhiệm vụ.");
  }
}
