// Shared types for the Bếp BN "nhiệm vụ thưởng bất ngờ" module (nền, không UI).
//
// The module is pure and deterministic: no React, no Supabase, no LLM. It works
// on the attendance rows the payroll parser already produced, extended with the
// machine columns the payroll engine deliberately ignores (Trễ / Sớm / Ca) so a
// mission can be judged without touching R1–R9.
//
// Nothing here hard-codes a threshold or a reward: templates receive their
// params and reward_vnd from the per-period configuration.

import type {
  EmploymentType,
  PayrollGroup,
  PayrollPeriod,
  PayrollPeriodStatus,
} from "../payroll-bn/types.ts";

/** The five mission templates the owner agreed on 2026-10-11. */
export type MissionTemplateCode =
  | "T-DUNGGIO"
  | "T-CHAMDU"
  | "T-CHUYENCAN"
  | "T-GIOPT"
  | "T-QL";

/** How the mission result is verified. */
export type MissionVerification = "auto" | "manager";

/** `pay` adds money to the payslip; `reconcile_only` never does. */
export type MissionMode = "pay" | "reconcile_only";

export type MissionStatus =
  | "suggested"
  | "published"
  | "accepted"
  | "achieved"
  | "not_achieved"
  | "needs_review"
  | "expired"
  | "cancelled"
  | "paid";

/** The machine shift; only HC (hành chính) counts for "đúng giờ". */
export type MissionShift = "HC" | "V" | null;

export type MissionAttendanceFlag =
  | "missing_check_in"
  | "missing_check_out"
  | "no_machine_data"
  | "duplicate_time";

/**
 * One attendance row used to judge a mission. It mirrors the payroll
 * AttendanceRow plus the machine columns Trễ / Sớm / Ca and the derived flags.
 * Times are normalised HH:MM:SS, exactly like the payroll parser.
 */
export interface MissionAttendanceRow {
  employeeCode: string;
  employeeName: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  shift: MissionShift;
  lateMinutes: number | null;
  earlyMinutes: number | null;
  flags: MissionAttendanceFlag[];
}

export interface MissionAppliesTo {
  groups?: PayrollGroup[];
  employmentTypes?: EmploymentType[];
}

/** Per-period template params (dung_sai_phut, nguong_de_xuat, gio_toi_da, …). */
export type MissionParams = Record<string, number | string | boolean>;

export interface MissionTemplateConfig {
  params?: MissionParams;
  /** null means "not configured yet" — rule 8 refuses to add money. */
  rewardVnd?: number | null;
  acceptDeadline?: string | null;
  enabled?: boolean;
  prorateAllowed?: boolean;
  appliesTo?: MissionAppliesTo;
}

export interface MissionTemplate {
  code: MissionTemplateCode;
  name: string;
  description: string;
  verification: MissionVerification;
  mode: MissionMode;
  appliesTo: MissionAppliesTo;
  params: MissionParams;
  rewardVnd: number | null;
  acceptDeadline: string | null;
  prorateAllowed: boolean;
  enabled: boolean;
}

export interface MissionPeriodSettings {
  periodId: string;
  maxEmployees: number;
  budgetVnd: number | null;
}

export interface MissionSuggestion {
  employeeCode: string;
  employeeName: string;
  templateCode: MissionTemplateCode;
  reasonText: string;
  sourceMetrics: Record<string, number | string>;
}

export type MissionEvaluationStatus = "achieved" | "not_achieved" | "needs_review";

export interface MissionEvaluation {
  status: MissionEvaluationStatus;
  reason: string;
  evidence: Record<string, unknown>;
}

/** A mission already persisted, reduced for selection / bonus checks. */
export interface MissionLedgerEntry {
  missionId?: string;
  employeeCode: string;
  missionCode: MissionTemplateCode;
  status: MissionStatus;
  mode: MissionMode;
  rewardVnd: number | null;
}

export interface MissionBonusLine {
  missionId?: string;
  employeeCode: string;
  missionCode: MissionTemplateCode;
  amountVnd: number;
}

export interface MissionBonusResult {
  totalVnd: number;
  lines: MissionBonusLine[];
}

export interface MissionPeriodContext {
  period: PayrollPeriod;
  status: PayrollPeriodStatus;
}

// ---------------------------------------------------------------------------
// Draw ("bốc thăm") — nền tảng của vòng 2 (bốc 2 người nhận nhiệm vụ).
// ---------------------------------------------------------------------------

/** One employee of the snapshot pool, with the suggested missions they own. */
export interface MissionDrawPoolEntry {
  employeeCode: string;
  missionIds: string[];
}

/** One drawn (employee, mission) pair. */
export interface MissionDrawPick {
  employeeCode: string;
  missionId: string;
}

export interface MissionDrawOutcome {
  pool: MissionDrawPoolEntry[];
  picked: MissionDrawPick[];
}

// ---------------------------------------------------------------------------
// Persisted mission rows as the payroll hook reads them (server snapshot).
// ---------------------------------------------------------------------------

export interface MissionTemplateRecord {
  id: string;
  periodId: string;
  code: string;
  name: string;
  description: string | null;
  mode: string;
  verification: string;
  appliesTo: Record<string, unknown>;
  params: Record<string, unknown>;
  rewardVnd: number | null;
  acceptDeadline: string | null;
  prorateAllowed: boolean;
  enabled: boolean;
}

export interface MissionRecord {
  id: string;
  periodId: string;
  employeeCode: string;
  templateId: string;
  templateCode: string;
  templateName: string;
  description: string | null;
  mode: string;
  verification: string;
  rewardVnd: number | null;
  acceptDeadline: string | null;
  status: MissionStatus;
  reasonText: string | null;
  sourceMetrics: Record<string, unknown>;
  acceptedAt: string | null;
}

export interface MissionBonusRecord {
  missionId: string;
  periodId: string;
  employeeCode: string;
  missionCode: string;
  amountVnd: number;
}

export interface MissionSettingsRecord {
  periodId: string;
  maxEmployees: number;
  budgetVnd: number | null;
}

export interface MissionDrawRecord {
  id: string;
  periodId: string;
  drawNo: number;
  pool: MissionDrawPoolEntry[];
  picked: MissionDrawPick[];
  reason: string | null;
  drawnBy: string | null;
  drawnAt: string;
}

/** Everything the mission surface needs from the server, without loading state. */
export interface MissionsSnapshot {
  templates: MissionTemplateRecord[];
  settings: MissionSettingsRecord | null;
  missions: MissionRecord[];
  bonuses: MissionBonusRecord[];
  latestDraw: MissionDrawRecord | null;
}

/** The snapshot plus the loading/error flags the hook exposes to the UI. */
export interface MissionsState extends MissionsSnapshot {
  loading: boolean;
  error: string | null;
}
