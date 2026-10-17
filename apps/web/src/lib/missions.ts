/**
 * Pure helpers for the warehouse missions / badges / levels data layer
 * (2026-10-24).
 *
 * The parsers validate the JSON returned by
 *   public.get_my_missions(uuid),
 *   public.complete_mission(uuid, uuid),
 *   public.update_stock_material_alias_factor(uuid, numeric, uuid),
 *   public.mark_stock_items_distinct(uuid, uuid, uuid),
 *   public.resolve_unknown_purchase_unit(text, text, text, uuid),
 *   public.get_mission_staff(),
 *   public.get_mission_assignments() and
 *   public.assign_mission(uuid, uuid).
 *
 * The mission detail shape depends on the mission check rule, so every entry is
 * tagged with a `kind` while parsing. levelProgress mirrors public.mission_levels:
 * the current level is the highest min_badges <= badges, the next is the smallest
 * min_badges > badges.
 */

export type MissionStatus = "open" | "completed" | "cancelled";

export interface MissionBadge {
  code: string;
  name: string;
  icon: string;
}

export interface MissionLevel {
  level: number;
  title: string;
  min_badges: number;
}

/** stock_alias_factor_fixed detail row. */
export interface MissionAliasDetail {
  kind: "alias_factor_fixed";
  id: string;
  name: string | null;
  unit: string | null;
  factor: number | null;
  item_name: string | null;
  item_unit: string | null;
  fixed: boolean;
}

/** stock_duplicate_resolved detail row. */
export interface MissionDuplicateDetail {
  kind: "duplicate_resolved";
  id: string;
  code: string | null;
  name: string | null;
  unit: string | null;
  active: boolean;
  on_hand: number;
  alias_count: number;
}

/** stock_unknown_units_cleared detail row. */
export interface MissionUnknownUnitDetail {
  kind: "unknown_units_cleared";
  unit: string;
  line_count: number;
  example_name: string;
  source_table: string;
}

/** material_links_done detail row (one per location). */
export interface MissionMaterialLinksDetail {
  kind: "material_links";
  location: string;
  remaining: number;
  linked: number;
  exact: number;
  skipped: number;
}

/** stock_count_questions_done detail row. */
export interface MissionCountQuestionsDetail {
  kind: "count_questions";
  batch: string;
  total: number;
  open: number;
  answered: number;
  skipped: number;
}

/** q7_bom_mismatch_resolved detail row. */
export interface MissionBomMismatchDetail {
  kind: "bom_mismatch";
  open: number;
  resolved: number;
  excluded: number;
  total: number;
}

export type MissionDetail =
  | MissionAliasDetail
  | MissionDuplicateDetail
  | MissionUnknownUnitDetail
  | MissionMaterialLinksDetail
  | MissionCountQuestionsDetail
  | MissionBomMismatchDetail;

export interface MissionEvaluation {
  done: boolean;
  total: number;
  left: number;
  detail: MissionDetail[];
}

export interface Mission {
  id: string;
  code: string;
  title: string;
  description: string | null;
  area: string;
  status: MissionStatus;
  sort_order: number | null;
  badge: MissionBadge | null;
  completed_at: string | null;
  progress: MissionEvaluation;
}

export interface MissionBadgeSummary {
  total: number;
  by_code: Record<string, number>;
}

export interface MissionAward {
  badge_code: string;
  mission_title: string | null;
  awarded_at: string;
}

export interface MyMissions {
  missions: Mission[];
  badges: MissionBadgeSummary;
  level: MissionLevel | null;
  next_level: MissionLevel | null;
  recent_awards: MissionAward[];
}

export interface CompleteMissionResult {
  mission_id: string;
  badge: MissionBadge | null;
  badges_total: number;
  level_before: MissionLevel | null;
  level_after: MissionLevel | null;
  leveled_up: boolean;
}

export interface UpdateAliasFactorResult {
  alias_id: string;
  old_factor: number;
  new_factor: number;
}

export interface MarkItemsDistinctResult {
  item_a: string;
  item_b: string;
}

export type ResolveUnknownUnitAction = "map" | "not_stock";

export interface ResolveUnknownUnitResult {
  variant: string;
  action: ResolveUnknownUnitAction;
  code: string | null;
}

/** One row of public.get_mission_staff(). */
export interface MissionStaffMember {
  userId: string;
  name: string;
  email: string;
  badges: number;
  level: { level: number; title: string } | null;
  openMissions: number;
}

/** One assigned copy of a mission (public.get_mission_assignments). */
export interface MissionAssignment {
  missionId: string;
  parentMissionId: string;
  assigneeUserId: string;
  assigneeName: string;
  status: "open" | "completed";
  completedAt: string | null;
  progress: MissionEvaluation;
}

/** JSON returned by public.assign_mission(uuid, uuid). */
export interface AssignMissionResult {
  missionId: string;
  parentMissionId: string;
  assigneeUserId: string;
  assigneeName: string;
  status: MissionStatus;
  created: boolean;
  reopened: boolean;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

/** Parse each row independently; one garbled row never hides the others. */
function parseRows<T>(
  raw: unknown,
  path: string,
  parseRow: (row: unknown, rowPath: string) => T,
): T[] {
  if (!Array.isArray(raw)) return [];
  const rows: T[] = [];
  raw.forEach((entry, index) => {
    try {
      rows.push(parseRow(entry, `${path}[${index}]`));
    } catch {
      // Drop only the garbled row.
    }
  });
  return rows;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${path} must be a string or null`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${path} must be a finite number`);
  return numeric;
}

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function asMissionStatus(value: unknown, path: string): MissionStatus {
  const status = asString(value, path);
  if (status !== "open" && status !== "completed" && status !== "cancelled") {
    throw new TypeError(`${path} is invalid`);
  }
  return status;
}

function parseBadge(raw: unknown, path: string): MissionBadge {
  const row = asRecord(raw, path);
  return {
    code: asString(row.code, `${path}.code`),
    name: asString(row.name, `${path}.name`),
    icon: asString(row.icon, `${path}.icon`),
  };
}

function parseNullableBadge(raw: unknown, path: string): MissionBadge | null {
  if (raw === null || raw === undefined) return null;
  return parseBadge(raw, path);
}

export function parseMissionLevel(raw: unknown, path = "missionLevel"): MissionLevel {
  const row = asRecord(raw, path);
  return {
    level: asNumber(row.level, `${path}.level`),
    title: asString(row.title, `${path}.title`),
    min_badges: asNumber(row.min_badges, `${path}.min_badges`),
  };
}

function parseNullableLevel(raw: unknown, path: string): MissionLevel | null {
  if (raw === null || raw === undefined) return null;
  return parseMissionLevel(raw, path);
}

/** One mission detail row; `kind` is assigned from the fields the row carries. */
export function parseMissionDetailEntry(raw: unknown, path = "detail"): MissionDetail {
  const row = asRecord(raw, path);
  if (row.kind === "bom_mismatch") {
    return {
      kind: "bom_mismatch",
      open: asNumber(row.open ?? 0, `${path}.open`),
      resolved: asNumber(row.resolved ?? 0, `${path}.resolved`),
      excluded: asNumber(row.excluded ?? 0, `${path}.excluded`),
      total: asNumber(row.total ?? 0, `${path}.total`),
    };
  }
  if ("batch" in row) {
    return {
      kind: "count_questions",
      batch: asString(row.batch, `${path}.batch`),
      total: asNumber(row.total ?? 0, `${path}.total`),
      open: asNumber(row.open ?? 0, `${path}.open`),
      answered: asNumber(row.answered ?? 0, `${path}.answered`),
      skipped: asNumber(row.skipped ?? 0, `${path}.skipped`),
    };
  }
  if ("source_table" in row) {
    return {
      kind: "unknown_units_cleared",
      unit: asString(row.unit, `${path}.unit`),
      line_count: asNumber(row.line_count, `${path}.line_count`),
      example_name: asString(row.example_name, `${path}.example_name`),
      source_table: asString(row.source_table, `${path}.source_table`),
    };
  }
  if ("alias_count" in row) {
    return {
      kind: "duplicate_resolved",
      id: asString(row.id, `${path}.id`),
      code: asNullableString(row.code, `${path}.code`),
      name: asNullableString(row.name, `${path}.name`),
      unit: asNullableString(row.unit, `${path}.unit`),
      active: asBoolean(row.active, `${path}.active`),
      on_hand: asNumber(row.on_hand, `${path}.on_hand`),
      alias_count: asNumber(row.alias_count, `${path}.alias_count`),
    };
  }
  if ("remaining" in row && "location" in row) {
    return {
      kind: "material_links",
      location: asString(row.location, `${path}.location`),
      remaining: asNumber(row.remaining ?? 0, `${path}.remaining`),
      linked: asNumber(row.linked ?? 0, `${path}.linked`),
      exact: asNumber(row.exact ?? 0, `${path}.exact`),
      skipped: asNumber(row.skipped ?? 0, `${path}.skipped`),
    };
  }
  return {
    kind: "alias_factor_fixed",
    id: asString(row.id, `${path}.id`),
    name: asNullableString(row.name, `${path}.name`),
    unit: asNullableString(row.unit, `${path}.unit`),
    factor: asNullableNumber(row.factor, `${path}.factor`),
    item_name: asNullableString(row.item_name, `${path}.item_name`),
    item_unit: asNullableString(row.item_unit, `${path}.item_unit`),
    fixed: asBoolean(row.fixed, `${path}.fixed`),
  };
}

export function parseMissionEvaluation(raw: unknown, path = "progress"): MissionEvaluation {
  const row = asRecord(raw, path);
  return {
    done: asBoolean(row.done, `${path}.done`),
    total: asNumber(row.total, `${path}.total`),
    left: asNumber(row.left, `${path}.left`),
    detail: asArray(row.detail, `${path}.detail`).map((entry, index) =>
      parseMissionDetailEntry(entry, `${path}.detail[${index}]`),
    ),
  };
}

function parseMission(raw: unknown, path: string): Mission {
  const row = asRecord(raw, path);
  return {
    id: asString(row.id, `${path}.id`),
    code: asString(row.code, `${path}.code`),
    title: asString(row.title, `${path}.title`),
    description: asNullableString(row.description, `${path}.description`),
    area: asString(row.area, `${path}.area`),
    status: asMissionStatus(row.status, `${path}.status`),
    sort_order: asNullableNumber(row.sort_order, `${path}.sort_order`),
    badge: parseNullableBadge(row.badge, `${path}.badge`),
    completed_at: asNullableString(row.completed_at, `${path}.completed_at`),
    progress: parseMissionEvaluation(row.progress, `${path}.progress`),
  };
}

/** Parse the JSON returned by `get_my_missions`. */
export function parseMyMissions(raw: unknown): MyMissions {
  const root = asRecord(raw, "myMissions");

  const missions = asArray(root.missions, "missions").map((mission, index) =>
    parseMission(mission, `missions[${index}]`),
  );

  const badgesRow = asRecord(root.badges, "badges");
  const rawByCode = asRecord(badgesRow.by_code, "badges.by_code");
  const byCode: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawByCode)) {
    byCode[key] = asNumber(value, `badges.by_code.${key}`);
  }

  const awards = asArray(root.recent_awards, "recent_awards").map((award, index) => {
    const row = asRecord(award, `recent_awards[${index}]`);
    return {
      badge_code: asString(row.badge_code, `recent_awards[${index}].badge_code`),
      mission_title: asNullableString(row.mission_title, `recent_awards[${index}].mission_title`),
      awarded_at: asString(row.awarded_at, `recent_awards[${index}].awarded_at`),
    };
  });

  return {
    missions,
    badges: {
      total: asNumber(badgesRow.total, "badges.total"),
      by_code: byCode,
    },
    level: parseNullableLevel(root.level, "level"),
    next_level: parseNullableLevel(root.next_level, "next_level"),
    recent_awards: awards,
  };
}

/** Parse the JSON returned by `complete_mission`. */
export function parseCompleteMissionResult(raw: unknown): CompleteMissionResult {
  const root = asRecord(raw, "completeMissionResult");
  return {
    mission_id: asString(root.mission_id, "completeMissionResult.mission_id"),
    badge: parseNullableBadge(root.badge, "completeMissionResult.badge"),
    badges_total: asNumber(root.badges_total, "completeMissionResult.badges_total"),
    level_before: parseNullableLevel(root.level_before, "completeMissionResult.level_before"),
    level_after: parseNullableLevel(root.level_after, "completeMissionResult.level_after"),
    leveled_up: asBoolean(root.leveled_up, "completeMissionResult.leveled_up"),
  };
}

/** Parse the JSON returned by `update_stock_material_alias_factor`. */
export function parseUpdateAliasFactorResult(raw: unknown): UpdateAliasFactorResult {
  const root = asRecord(raw, "updateAliasFactorResult");
  return {
    alias_id: asString(root.alias_id, "updateAliasFactorResult.alias_id"),
    old_factor: asNullableNumber(root.old_factor, "updateAliasFactorResult.old_factor") ?? 0,
    new_factor: asNumber(root.new_factor, "updateAliasFactorResult.new_factor"),
  };
}

/** Parse the JSON returned by `mark_stock_items_distinct`. */
export function parseMarkItemsDistinctResult(raw: unknown): MarkItemsDistinctResult {
  const root = asRecord(raw, "markItemsDistinctResult");
  return {
    item_a: asString(root.item_a, "markItemsDistinctResult.item_a"),
    item_b: asString(root.item_b, "markItemsDistinctResult.item_b"),
  };
}

/** Parse the JSON returned by `resolve_unknown_purchase_unit`. */
export function parseResolveUnknownUnitResult(raw: unknown): ResolveUnknownUnitResult {
  const root = asRecord(raw, "resolveUnknownUnitResult");
  const action = asString(root.action, "resolveUnknownUnitResult.action");
  if (action !== "map" && action !== "not_stock") {
    throw new TypeError("resolveUnknownUnitResult.action is invalid");
  }
  return {
    variant: asString(root.variant, "resolveUnknownUnitResult.variant"),
    action,
    code: asNullableString(root.code, "resolveUnknownUnitResult.code"),
  };
}

function parseStaffLevel(raw: unknown, path: string): { level: number; title: string } | null {
  if (raw === null || raw === undefined) return null;
  try {
    const row = asRecord(raw, path);
    return {
      level: asNumber(row.level, `${path}.level`),
      title: asString(row.title, `${path}.title`),
    };
  } catch {
    return null;
  }
}

function parseStaffMember(raw: unknown, path: string): MissionStaffMember {
  const row = asRecord(raw, path);
  const userId = asString(row.user_id, `${path}.user_id`);
  const email = asNullableString(row.email, `${path}.email`) ?? "";
  const name = asNullableString(row.name, `${path}.name`)?.trim() || email;

  return {
    userId,
    name,
    email,
    badges: Math.max(0, Math.trunc(asNumber(row.badges ?? 0, `${path}.badges`))),
    level: parseStaffLevel(row.level, `${path}.level`),
    openMissions: Math.max(
      0,
      Math.trunc(asNumber(row.open_missions ?? 0, `${path}.open_missions`)),
    ),
  };
}

/** Parse the JSON returned by `get_mission_staff`; garbled rows are dropped. */
export function parseMissionStaff(raw: unknown): MissionStaffMember[] {
  return parseRows(raw, "missionStaff", parseStaffMember);
}

function parseAssignment(raw: unknown, path: string): MissionAssignment {
  const row = asRecord(raw, path);
  const status = asString(row.status, `${path}.status`);
  if (status !== "open" && status !== "completed") {
    throw new TypeError(`${path}.status is invalid`);
  }

  return {
    missionId: asString(row.mission_id, `${path}.mission_id`),
    parentMissionId: asString(row.parent_mission_id, `${path}.parent_mission_id`),
    assigneeUserId: asString(row.assignee_user_id, `${path}.assignee_user_id`),
    assigneeName: asNullableString(row.assignee_name, `${path}.assignee_name`) ?? "",
    status,
    completedAt: asNullableString(row.completed_at, `${path}.completed_at`),
    progress: parseMissionEvaluation(row.progress, `${path}.progress`),
  };
}

/** Parse the JSON returned by `get_mission_assignments`; garbled rows are dropped. */
export function parseMissionAssignments(raw: unknown): MissionAssignment[] {
  return parseRows(raw, "missionAssignments", parseAssignment);
}

/** Parse the JSON returned by `assign_mission`. */
export function parseAssignMissionResult(raw: unknown): AssignMissionResult {
  const root = asRecord(raw, "assignMissionResult");
  return {
    missionId: asString(root.mission_id, "assignMissionResult.mission_id"),
    parentMissionId: asString(root.parent_mission_id, "assignMissionResult.parent_mission_id"),
    assigneeUserId: asString(root.assignee_user_id, "assignMissionResult.assignee_user_id"),
    assigneeName:
      asNullableString(root.assignee_name, "assignMissionResult.assignee_name") ?? "",
    status: asMissionStatus(root.status, "assignMissionResult.status"),
    created: asBoolean(root.created, "assignMissionResult.created"),
    reopened: asBoolean(root.reopened, "assignMissionResult.reopened"),
  };
}

/** Group assignments by their root mission id, preserving list order. */
export function assignmentsByParent(
  list: MissionAssignment[],
): Map<string, MissionAssignment[]> {
  const grouped = new Map<string, MissionAssignment[]>();
  for (const assignment of list) {
    const rows = grouped.get(assignment.parentMissionId);
    if (rows) rows.push(assignment);
    else grouped.set(assignment.parentMissionId, [assignment]);
  }
  return grouped;
}

export interface LevelProgress {
  current: MissionLevel | null;
  next: MissionLevel | null;
  /** 0..100 progress from the current level to the next one. */
  pct: number;
}

/**
 * Level of a badge count plus the progress toward the next level.
 * `badges` accepts either the total or the whole `badges` summary.
 */
export function levelProgress(
  badges: number | MissionBadgeSummary | null | undefined,
  levels: MissionLevel[] | null | undefined,
): LevelProgress {
  const total =
    typeof badges === "number" ? badges : Number.isFinite(badges?.total) ? Number(badges?.total) : 0;
  const sorted = [...(levels ?? [])].sort((a, b) => a.min_badges - b.min_badges);

  let current: MissionLevel | null = null;
  let next: MissionLevel | null = null;
  for (const level of sorted) {
    if (level.min_badges <= total) current = level;
    else if (next === null) next = level;
  }

  if (next === null) return { current, next: null, pct: 100 };

  const base = current?.min_badges ?? 0;
  const span = next.min_badges - base;
  if (span <= 0) return { current, next, pct: 100 };
  const ratio = ((total - base) / span) * 100;
  return { current, next, pct: Math.max(0, Math.min(100, Math.round(ratio))) };
}

function readError(error: unknown): { message: string; code: string; details: string } {
  if (typeof error === "string") return { message: error, code: "", details: "" };
  if (typeof error === "object" && error !== null) {
    const row = error as Record<string, unknown>;
    return {
      message: typeof row.message === "string" ? row.message : "",
      code: typeof row.code === "string" ? row.code : "",
      details: typeof row.details === "string" ? row.details : "",
    };
  }
  return { message: "", code: "", details: "" };
}

/** Map a Postgres / PostgREST error to a short Vietnamese message. */
export function missionErrorMessage(error: unknown): string {
  const { message, code, details } = readError(error);
  const haystack = `${message} ${details}`.toLowerCase();

  if (haystack.includes("mission_not_done")) {
    const match = details.match(/\d+/) ?? message.match(/\d+/);
    const left = match ? Number(match[0]) : Number.NaN;
    return Number.isFinite(left) ? `Nhiệm vụ chưa xong — còn ${left} việc` : "Nhiệm vụ chưa xong";
  }
  if (haystack.includes("forbidden") || code === "42501") {
    return "Bạn không có quyền thực hiện thao tác này";
  }
  if (
    haystack.includes("unknown_unit") ||
    haystack.includes("unit_not_allowed") ||
    haystack.includes("unit_unchanged")
  ) {
    return "Đơn vị không hợp lệ hoặc không xác định";
  }
  if (haystack.includes("invalid_factor")) return "Hệ số quy đổi không hợp lệ";
  if (haystack.includes("items_must_differ")) return "Hai mặt hàng phải khác nhau";
  if (haystack.includes("invalid_action") || haystack.includes("variant_required")) {
    return "Thao tác xử lý đơn vị không hợp lệ";
  }
  if (haystack.includes("item_not_found") || haystack.includes("alias_not_found")) {
    return "Không tìm thấy dữ liệu cần xử lý";
  }
  return message || "Có lỗi xảy ra";
}

/** Map a mission assignment RPC error to a short Vietnamese message. */
export function missionAssignErrorText(error: unknown): string {
  const { message, code, details } = readError(error);
  const haystack = `${message} ${details}`.toLowerCase();

  if (haystack.includes("forbidden") || code === "42501") {
    return "Bạn không có quyền giao nhiệm vụ kho";
  }
  if (haystack.includes("mission_not_open")) {
    return "Nhiệm vụ này không còn mở";
  }
  if (haystack.includes("assignee_not_allowed")) {
    return "Người này không thể nhận nhiệm vụ kho";
  }
  if (haystack.includes("already_assignee")) {
    return "Người này đã nhận nhiệm vụ";
  }
  if (haystack.includes("not_an_assignment")) {
    return "Đây không phải nhiệm vụ đã giao";
  }
  if (haystack.includes("mission_completed")) {
    return "Nhiệm vụ đã hoàn thành, không thể thu hồi";
  }
  return message || "Có lỗi xảy ra";
}
