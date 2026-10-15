/**
 * Robot Bé Mì — auto-apply client rules (no React, no Supabase).
 *
 * The types mirror the two RPC outputs: get_robot_auto_actions (today's applied /
 * undone automatic actions, with readable labels) and get_robot_settings (the
 * off switch, thresholds and daily cap). The parsers are zod-free and return
 * null / an empty list for anything malformed, so a stale server response can
 * never break the screen.
 */

export type RobotAutoActionKind = "alias" | "catalog_class";
export type RobotAutoActionStatus = "applied" | "undone";

export interface RobotAutoAction {
  id: string;
  kind: RobotAutoActionKind | string;
  subject_key: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  robot_probability: number | null;
  status: RobotAutoActionStatus | string;
  applied_at: string | null;
  undone_by: string | null;
  undone_at: string | null;
  /** Readable labels resolved by the RPC. */
  item_name: string | null;
  raw_name: string | null;
  class_label: string | null;
}

export interface RobotSettings {
  id: boolean;
  auto_apply_enabled: boolean;
  alias_threshold: number;
  class_threshold: number;
  daily_cap: number;
  updated_by: string | null;
  updated_at: string | null;
}

export interface SetRobotSettingsInput {
  autoApplyEnabled?: boolean | null;
  aliasThreshold?: number | null;
  classThreshold?: number | null;
  dailyCap?: number | null;
}

export const ROBOT_SETTINGS_DEFAULTS: RobotSettings = {
  id: true,
  auto_apply_enabled: true,
  alias_threshold: 0.95,
  class_threshold: 0.9,
  daily_cap: 50,
  updated_by: null,
  updated_at: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function unitNumber(value: unknown, fallback: number): number {
  const numeric = nullableNumber(value);
  return numeric !== null && numeric >= 0 && numeric <= 1 ? numeric : fallback;
}

/** One get_robot_auto_actions row, or null when a required field is missing. */
export function parseRobotAutoAction(raw: unknown): RobotAutoAction | null {
  if (!isRecord(raw)) return null;
  const id = nullableString(raw.id);
  if (id === null) return null;
  return {
    id,
    kind: typeof raw.kind === "string" ? raw.kind : "unknown",
    subject_key: typeof raw.subject_key === "string" ? raw.subject_key : "",
    target: isRecord(raw.target) ? raw.target : {},
    payload: isRecord(raw.payload) ? raw.payload : {},
    robot_probability: nullableNumber(raw.robot_probability),
    status: typeof raw.status === "string" ? raw.status : "unknown",
    applied_at: nullableString(raw.applied_at),
    undone_by: nullableString(raw.undone_by),
    undone_at: nullableString(raw.undone_at),
    item_name: nullableString(raw.item_name),
    raw_name: nullableString(raw.raw_name),
    class_label: nullableString(raw.class_label),
  };
}

/** Parse an RPC list payload, dropping malformed rows. */
export function parseRobotAutoActions(data: unknown): RobotAutoAction[] {
  if (!Array.isArray(data)) return [];
  return data
    .map(parseRobotAutoAction)
    .filter((row): row is RobotAutoAction => row !== null);
}

/** One get_robot_settings payload, falling back to the documented defaults. */
export function parseRobotSettings(raw: unknown): RobotSettings {
  if (!isRecord(raw)) return { ...ROBOT_SETTINGS_DEFAULTS };
  return {
    id: raw.id === true,
    auto_apply_enabled: raw.auto_apply_enabled === true,
    alias_threshold: unitNumber(raw.alias_threshold, ROBOT_SETTINGS_DEFAULTS.alias_threshold),
    class_threshold: unitNumber(raw.class_threshold, ROBOT_SETTINGS_DEFAULTS.class_threshold),
    daily_cap: Math.max(0, Math.trunc(nullableNumber(raw.daily_cap) ?? ROBOT_SETTINGS_DEFAULTS.daily_cap)),
    updated_by: nullableString(raw.updated_by),
    updated_at: nullableString(raw.updated_at),
  };
}

/** The one-line readable label for a row, for an operator list. */
export function robotAutoActionLabel(action: RobotAutoAction): string {
  const name = action.item_name ?? action.raw_name ?? action.subject_key;
  if (action.kind === "catalog_class") {
    return `${name} → ${action.class_label ?? action.subject_key}`;
  }
  return `${action.raw_name ?? action.subject_key} → ${name}`;
}

/** True when the row is still applied (has an undo path). */
export function isUndoableRobotAutoAction(action: RobotAutoAction): boolean {
  return action.status === "applied";
}

/** Map a failed RPC error to a short Vietnamese message for the operator. */
export function robotActionsErrorText(error: unknown): string {
  const text = (() => {
    if (error == null) return "";
    if (typeof error === "string") return error;
    if (typeof error === "object") {
      const candidate = error as { message?: unknown; code?: unknown; details?: unknown };
      return [candidate.message, candidate.code, candidate.details]
        .filter((part): part is string => typeof part === "string")
        .join(" ");
    }
    return String(error);
  })().toLowerCase();
  if (text.includes("not_owner")) return "Chỉ chủ doanh nghiệp đổi được cài đặt robot.";
  if (text.includes("insufficient_privilege")) return "Tài khoản chưa được cấp quyền hoàn tác hành động này.";
  if (text.includes("action_not_found")) return "Không tìm thấy hành động để hoàn tác.";
  return "Thao tác robot chưa thực hiện được. Anh thử lại nhé.";
}
