// Testable mission actions for the Bếp BN surprise-reward programme.
//
// The hook is a thin react-query wrapper: every mutation goes through one of
// these functions so the orchestration (load period data, detect anomalies,
// adapt rows, call the RPC, reload the server state) is unit-tested with a fake
// client and no React runtime.
//
// Every action re-reads the mission snapshot from the server after it finishes
// and after it fails, so the caller never renders stale state. No money is
// logged.

import { detectAnomalies } from "../payroll-bn/anomalies.ts";
import {
  createMissionBonuses,
  discardMission,
  drawPeriodMissions,
  evaluateMissionResult,
  findPreviousPeriodId,
  loadPeriodData,
  loadPeriodMissions,
  managerConfirmMission,
  publishMission,
  saveMissionSettings,
  saveMissionTemplate,
  suggestMissions,
} from "../payroll-bn/db-client.ts";
import type { BepBnClient, BepBnMissionTemplateInput } from "../payroll-bn/db-client.ts";
import { toMissionAttendanceRows } from "./attendance-adapter.ts";
import { evaluateMission } from "./evaluator.ts";
import { generateMissionSuggestions } from "./generator.ts";
import { buildMissionTemplate, isMissionTemplateAutoSuggest, isMissionTemplateCode } from "./templates.ts";
import type {
  MissionAppliesTo,
  MissionParams,
  MissionSuggestion,
  MissionTemplate,
  MissionsSnapshot,
  MissionTemplateCode,
  MissionTemplateRecord,
} from "./types.ts";

export interface MissionActionResult<T = void> {
  value: T;
  snapshot: MissionsSnapshot;
}

/** Run a write, then always re-read the server snapshot (success and failure). */
async function readBack<T>(
  client: BepBnClient,
  periodId: string,
  run: () => Promise<T>,
): Promise<MissionActionResult<T>> {
  try {
    const value = await run();
    return { value, snapshot: await loadPeriodMissions(client, periodId) };
  } catch (error) {
    try {
      await loadPeriodMissions(client, periodId);
    } catch {
      // The write error is the one worth surfacing.
    }
    throw error;
  }
}

/** The persisted templates that can be auto-suggested (never a manager template). */
export function toDomainMissionTemplates(
  records: readonly MissionTemplateRecord[],
): MissionTemplate[] {
  const templates: MissionTemplate[] = [];
  for (const record of records) {
    if (!record.enabled) continue;
    if (!isMissionTemplateCode(record.code)) continue;
    if (!isMissionTemplateAutoSuggest(record.code)) continue;
    try {
      templates.push(
        buildMissionTemplate(record.code, {
          params: record.params as MissionParams,
          rewardVnd: record.rewardVnd,
          acceptDeadline: record.acceptDeadline,
          enabled: record.enabled,
          prorateAllowed: record.prorateAllowed,
          appliesTo: record.appliesTo as MissionAppliesTo,
        }),
      );
    } catch {
      // A template missing a required param is skipped, never invented.
    }
  }
  return templates;
}

function groupRowsByEmployee<T extends { employeeCode: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.employeeCode) ?? [];
    list.push(row);
    map.set(row.employeeCode, list);
  }
  return map;
}

export interface SuggestFromPreviousResult extends MissionActionResult<number> {
  suggestions: MissionSuggestion[];
}

/**
 * Suggest missions for `periodId` from the attendance of the previous period.
 * Manager-verified templates are skipped; already-persisted suggestions are
 * never duplicated. The server snapshot is re-read on success and on error.
 */
export async function suggestFromPrevious(
  client: BepBnClient,
  periodId: string,
): Promise<SuggestFromPreviousResult> {
  const [currentData, snapshot, previousId] = await Promise.all([
    loadPeriodData(client, periodId),
    loadPeriodMissions(client, periodId),
    findPreviousPeriodId(client, periodId),
  ]);
  if (!currentData) throw new Error("Không tìm thấy kỳ lương.");

  const previousData = previousId ? await loadPeriodData(client, previousId) : null;
  const previousRows = previousData
    ? toMissionAttendanceRows(
        previousData.rows,
        detectAnomalies({
          period: previousData.period,
          employees: previousData.employees,
          rows: previousData.rows,
        }),
      )
    : [];

  const templates = toDomainMissionTemplates(snapshot.templates);
  const suggestions = generateMissionSuggestions({
    period: currentData.period,
    employees: currentData.employees,
    previousRows,
    templates,
    existing: snapshot.missions.map((mission) => ({
      employeeCode: mission.employeeCode,
      templateCode: mission.templateCode as MissionTemplateCode,
    })),
  });

  let reloaded: MissionsSnapshot | null = null;
  let count = 0;
  try {
    if (suggestions.length > 0) {
      count = await suggestMissions(
        client,
        periodId,
        suggestions.map((suggestion) => ({
          employeeCode: suggestion.employeeCode,
          templateCode: suggestion.templateCode,
          reasonText: suggestion.reasonText,
          sourceMetrics: suggestion.sourceMetrics,
        })),
      );
    }
  } finally {
    reloaded = await loadPeriodMissions(client, periodId);
  }

  return { value: count, suggestions, snapshot: reloaded! };
}

export interface EvaluateAcceptedResult extends MissionActionResult<number> {}

/**
 * Run the deterministic evaluator for the accepted auto missions of `periodId`
 * on the period's own attendance (through the anomaly adapter). Manager-verified
 * missions are left for managerConfirm.
 */
export async function evaluateAccepted(
  client: BepBnClient,
  periodId: string,
): Promise<EvaluateAcceptedResult> {
  const [currentData, snapshot] = await Promise.all([
    loadPeriodData(client, periodId),
    loadPeriodMissions(client, periodId),
  ]);
  if (!currentData) throw new Error("Không tìm thấy kỳ lương.");

  const attendance = toMissionAttendanceRows(
    currentData.rows,
    detectAnomalies({
      period: currentData.period,
      employees: currentData.employees,
      rows: currentData.rows,
    }),
  );
  const rowsByEmployee = groupRowsByEmployee(attendance);
  const templateByCode = new Map(
    toDomainMissionTemplates(snapshot.templates).map((template) => [template.code, template]),
  );

  let reloaded: MissionsSnapshot | null = null;
  let evaluated = 0;
  try {
    for (const mission of snapshot.missions) {
      if (mission.verification !== "auto") continue;
      if (mission.status !== "accepted" && mission.status !== "needs_review") continue;
      const template = templateByCode.get(mission.templateCode as MissionTemplateCode);
      if (!template) continue;
      const evaluation = evaluateMission({
        template,
        attendance: rowsByEmployee.get(mission.employeeCode) ?? [],
      });
      if (evaluation.status === mission.status) continue;
      await evaluateMissionResult(client, mission.id, {
        status: evaluation.status,
        evidence: evaluation.evidence,
      });
      evaluated += 1;
    }
  } finally {
    reloaded = await loadPeriodMissions(client, periodId);
  }

  return { value: evaluated, snapshot: reloaded! };
}

// ---------------------------------------------------------------------------
// Thin wrappers around the db-client writes (all re-read the snapshot).
// ---------------------------------------------------------------------------

export function saveTemplateAction(
  client: BepBnClient,
  periodId: string,
  input: BepBnMissionTemplateInput,
): Promise<MissionActionResult<void>> {
  return readBack(client, periodId, () => saveMissionTemplate(client, periodId, input));
}

export function saveSettingsAction(
  client: BepBnClient,
  periodId: string,
  settings: { maxEmployees: number; budgetVnd: number | null },
): Promise<MissionActionResult<void>> {
  return readBack(client, periodId, () => saveMissionSettings(client, periodId, settings));
}

export function drawAction(
  client: BepBnClient,
  periodId: string,
  reason?: string,
): Promise<MissionActionResult<void>> {
  return readBack(client, periodId, () => drawPeriodMissions(client, periodId, reason));
}

export function publishAction(
  client: BepBnClient,
  periodId: string,
  missionId: string,
): Promise<MissionActionResult<string>> {
  return readBack(client, periodId, () => publishMission(client, missionId));
}

export function discardAction(
  client: BepBnClient,
  periodId: string,
  missionId: string,
  reason: string,
): Promise<MissionActionResult<void>> {
  return readBack(client, periodId, () => discardMission(client, missionId, reason));
}

export function managerConfirmAction(
  client: BepBnClient,
  periodId: string,
  missionId: string,
  result: { status: string; evidence: Record<string, unknown> },
  reason: string,
): Promise<MissionActionResult<void>> {
  return readBack(client, periodId, () =>
    managerConfirmMission(client, missionId, result, reason),
  );
}

export function createBonusesAction(
  client: BepBnClient,
  periodId: string,
): Promise<MissionActionResult<number>> {
  return readBack(client, periodId, () => createMissionBonuses(client, periodId));
}
