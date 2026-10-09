// Pure logic for the employee mission portal Edge Functions.
//
// Dependency-free (no remote URL imports, no Deno globals) so `node --test` can
// exercise it directly. The session's employee_code is the only authority: an
// employee can read and accept exactly their own published missions, never
// somebody else's, and never publish / edit a reward / mark a result.

export const MISSION_VISIBLE_STATUSES = [
  "published",
  "accepted",
  "achieved",
  "not_achieved",
  "needs_review",
  "expired",
  "paid",
] as const;

export type PublicMissionStatus = (typeof MISSION_VISIBLE_STATUSES)[number];

/** Embedded payroll_bn_mission_templates row PostgREST returns with the mission. */
export interface DbMissionTemplateEmbed {
  code?: string | null;
  name?: string | null;
  description?: string | null;
  mode?: string | null;
  verification?: string | null;
  accept_deadline?: string | null;
  reward_vnd?: number | string | null;
}

export interface DbMissionRow {
  id?: string | null;
  period_id: string;
  employee_code: string;
  status: string;
  reason_text?: string | null;
  source_metrics?: unknown;
  reward_vnd?: number | string | null;
  accepted_at?: string | null;
  result_evidence?: unknown;
  payroll_bn_mission_templates?: DbMissionTemplateEmbed | DbMissionTemplateEmbed[] | null;
}

export interface PublicMission {
  id: string;
  periodId: string;
  code: string;
  name: string;
  description: string | null;
  mode: string;
  status: PublicMissionStatus;
  reason: string | null;
  rewardVnd: number | null;
  acceptDeadline: string | null;
  acceptedAt: string | null;
  sourceMetrics: Record<string, unknown>;
  resultEvidence: Record<string, unknown> | null;
}

export interface PublicMissionPayload {
  employeeCode: string;
  missions: PublicMission[];
}

export function isMissionVisibleToEmployee(status: unknown): status is PublicMissionStatus {
  return typeof status === "string" && (MISSION_VISIBLE_STATUSES as readonly string[]).includes(status);
}

export function missionBelongsToEmployee(row: DbMissionRow, employeeCode: string): boolean {
  return typeof employeeCode === "string" && employeeCode !== "" && row.employee_code === employeeCode;
}

/** Throw when an employee tries to read a mission that is not theirs. */
export function assertMissionReadable(row: DbMissionRow, employeeCode: string): void {
  if (!missionBelongsToEmployee(row, employeeCode)) {
    throw new Error("Không có quyền đọc nhiệm vụ của nhân viên khác.");
  }
}

function templateOf(row: DbMissionRow): DbMissionTemplateEmbed {
  const embed = row.payroll_bn_mission_templates;
  if (Array.isArray(embed)) return embed[0] ?? {};
  return embed ?? {};
}

function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toReward(row: DbMissionRow): number | null {
  const embedded = templateOf(row).reward_vnd;
  const source = row.reward_vnd ?? embedded;
  if (source === null || source === undefined || source === "") return null;
  const parsed = Number(source);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Public payload for one signed-in employee. Rows for any other employee are
 * dropped, and only statuses the employee is allowed to see survive.
 */
export function toPublicMissions(
  rows: readonly DbMissionRow[],
  session: { employeeCode: string },
): PublicMissionPayload {
  const missions = rows
    .filter((row) => missionBelongsToEmployee(row, session.employeeCode))
    .filter((row) => isMissionVisibleToEmployee(row.status))
    .map((row): PublicMission => {
      const template = templateOf(row);
      return {
        id: String(row.id ?? ""),
        periodId: row.period_id,
        code: String(template.code ?? ""),
        name: String(template.name ?? ""),
        description: template.description ?? null,
        mode: String(template.mode ?? ""),
        status: row.status as PublicMissionStatus,
        reason: row.reason_text ?? null,
        rewardVnd: toReward(row),
        acceptDeadline: template.accept_deadline ?? null,
        acceptedAt: row.accepted_at ?? null,
        sourceMetrics: toObject(row.source_metrics),
        resultEvidence: row.result_evidence ? toObject(row.result_evidence) : null,
      };
    })
    .sort(
      (a, b) =>
        String(a.acceptDeadline ?? "").localeCompare(String(b.acceptDeadline ?? "")) ||
        a.code.localeCompare(b.code),
    );

  return { employeeCode: session.employeeCode, missions };
}

// ---------------------------------------------------------------------------
// Employee permissions — an employee session may only read and accept.
// ---------------------------------------------------------------------------

export const EMPLOYEE_ALLOWED_MISSION_ACTIONS = ["read", "accept"] as const;

const EMPLOYEE_FORBIDDEN_MISSION_ACTIONS = [
  "publish",
  "discard",
  "update_suggestion",
  "update_reward",
  "evaluate",
  "mark_achieved",
  "mark_not_achieved",
  "create_bonus",
] as const;

export function assertEmployeeActionAllowed(action: string): void {
  if ((EMPLOYEE_FORBIDDEN_MISSION_ACTIONS as readonly string[]).includes(action)) {
    throw new Error("Nhân viên không được phép thực hiện thao tác này.");
  }
  if (!(EMPLOYEE_ALLOWED_MISSION_ACTIONS as readonly string[]).includes(action)) {
    throw new Error("Thao tác không hợp lệ cho nhân viên.");
  }
}

// ---------------------------------------------------------------------------
// Audit entry — whitelisted fields only, never a money amount.
// ---------------------------------------------------------------------------

export interface MissionAuditEntry {
  action: string;
  missionId: string | null;
  employeeCode: string | null;
  at: string;
}

/**
 * Build the audit entry written by the portal. Only action / mission id /
 * employee code are kept: any extra field (including a reward) is dropped so no
 * amount can ever reach a log.
 */
export function buildMissionAuditEntry(
  input: { action: string; missionId?: string | null; employeeCode?: string | null } & Record<string, unknown>,
  now: Date = new Date(),
): MissionAuditEntry {
  return {
    action: String(input.action ?? ""),
    missionId: typeof input.missionId === "string" ? input.missionId : null,
    employeeCode: typeof input.employeeCode === "string" ? input.employeeCode : null,
    at: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Accept — idempotent state machine.
// ---------------------------------------------------------------------------

export interface MissionAcceptResult {
  status: PublicMissionStatus;
  acceptedAt: string | null;
}

/**
 * Accept a published mission. Already accepted (or later) stays unchanged, so a
 * repeated click is harmless; a deadline in the past turns the mission expired.
 */
export function acceptMission(
  mission: { status: string; acceptedAt?: string | null; acceptDeadline?: string | null },
  now: Date = new Date(),
): MissionAcceptResult {
  const status = mission.status;
  if (status === "accepted" || status === "achieved" || status === "not_achieved" || status === "needs_review" || status === "paid") {
    return { status: status as PublicMissionStatus, acceptedAt: mission.acceptedAt ?? null };
  }
  if (status !== "published") {
    return { status: isMissionVisibleToEmployee(status) ? status : "expired", acceptedAt: mission.acceptedAt ?? null };
  }

  const deadline = mission.acceptDeadline ? new Date(mission.acceptDeadline).getTime() : NaN;
  if (Number.isFinite(deadline) && deadline < now.getTime()) {
    return { status: "expired", acceptedAt: null };
  }
  return { status: "accepted", acceptedAt: now.toISOString() };
}
