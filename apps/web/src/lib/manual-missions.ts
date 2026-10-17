/**
 * Pure helpers for the manual mission cards / evidence / review data layer
 * (2026-11-02).
 *
 * The parsers validate the JSON returned by
 *   public.create_manual_mission(...),
 *   public.get_my_manual_missions(),
 *   public.get_manual_missions_overview(integer),
 *   public.get_manual_mission_staff(),
 *   public.get_mission_submissions(uuid),
 *   public.add_manual_mission_assignee(uuid, uuid),
 *   public.cancel_manual_mission(uuid) and
 *   public.review_manual_mission(uuid, boolean, smallint, text).
 *
 * The server stores the evidence spec once per batch; every assignee mission row
 * carries the same check_rule 'manual_review'. Garbled rows are dropped by the
 * list parsers and extra fields never fail a row.
 */

export type ManualPriority = "low" | "normal" | "high";
export type ManualLocation = "tan_tao" | "q7";
export type ManualReviewStatus = "pending" | "approved" | "returned";
export type ManualMissionStatus = "open" | "completed" | "cancelled";

export type ManualEvidenceLevel = "none" | "optional" | "required";

export interface ManualEvidenceNumber {
  label: string;
  unit: string;
}

/** The normalized evidence spec stored on public.manual_mission_batches. */
export interface ManualEvidenceSpec {
  photo: ManualEvidenceLevel;
  note: ManualEvidenceLevel;
  number: ManualEvidenceNumber | null;
  checklist: string[];
}

/** One evidence submission (public.mission_submissions). */
export interface ManualSubmission {
  id: string;
  missionId: string | null;
  submittedBy: string | null;
  note: string | null;
  numberValue: number | null;
  photoPaths: string[];
  checklist: boolean[];
  reviewStatus: ManualReviewStatus;
  reviewNote: string | null;
  rating: number | null;
  createdAt: string;
}

/** One of the caller's manual missions (public.get_my_manual_missions). */
export interface MyManualMission {
  missionId: string;
  batchId: string;
  title: string;
  dueAt: string | null;
  priority: ManualPriority;
  location: ManualLocation | null;
  evidence: ManualEvidenceSpec;
  createdByName: string | null;
  createdAt: string;
  reviewState: ManualReviewStatus | null;
  lastSubmission: ManualSubmission | null;
  submissionsCount: number;
}

/** One assignee row inside a batch (public.get_manual_missions_overview). */
export interface ManualBatchAssignee {
  missionId: string;
  userId: string;
  name: string;
  status: ManualMissionStatus;
  reviewState: ManualReviewStatus | null;
  completedAt: string | null;
  lastSubmission: ManualSubmission | null;
}

/** One owner-created batch with all of its assignee missions. */
export interface ManualBatch {
  batchId: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  priority: ManualPriority;
  location: ManualLocation | null;
  evidence: ManualEvidenceSpec;
  createdAt: string;
  assignees: ManualBatchAssignee[];
}

export interface ManualStaffLevel {
  level: number;
  title: string;
  min_badges: number;
}

/** One row of public.get_manual_mission_staff(). */
export interface ManualStaffMember {
  userId: string;
  name: string;
  email: string;
  level: ManualStaffLevel | null;
  openMissions: number;
}

export interface CreateManualMissionResult {
  batchId: string;
  missions: Array<{
    missionId: string;
    assigneeUserId: string;
    assigneeName: string;
  }>;
}

export interface ReviewManualMissionResult {
  submissionId: string;
  missionId: string;
  reviewStatus: ManualReviewStatus;
  rating: number | null;
  badgeAwarded: boolean;
  levelBefore: ManualStaffLevel | null;
  levelAfter: ManualStaffLevel | null;
}

/** Small shared result of add_manual_mission_assignee / cancel_manual_mission. */
export interface ManualMissionActionResult {
  missionId: string;
  status: ManualMissionStatus;
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

function asPriority(value: unknown, path: string): ManualPriority {
  const priority = asString(value, path);
  if (priority !== "low" && priority !== "normal" && priority !== "high") {
    throw new TypeError(`${path} is invalid`);
  }
  return priority;
}

function asLocation(value: unknown, path: string): ManualLocation | null {
  if (value === null || value === undefined) return null;
  const location = asString(value, path);
  if (location !== "tan_tao" && location !== "q7") {
    throw new TypeError(`${path} is invalid`);
  }
  return location;
}

function asReviewStatus(value: unknown, path: string): ManualReviewStatus {
  const status = asString(value, path);
  if (status !== "pending" && status !== "approved" && status !== "returned") {
    throw new TypeError(`${path} is invalid`);
  }
  return status;
}

function asMissionStatus(value: unknown, path: string): ManualMissionStatus {
  const status = asString(value, path);
  if (status !== "open" && status !== "completed" && status !== "cancelled") {
    throw new TypeError(`${path} is invalid`);
  }
  return status;
}

function parseEvidenceLevel(value: unknown, path: string): ManualEvidenceLevel {
  const level = asString(value ?? "optional", path);
  if (level !== "none" && level !== "optional" && level !== "required") {
    throw new TypeError(`${path} is invalid`);
  }
  return level;
}

function parseEvidenceNumber(raw: unknown, path: string): ManualEvidenceNumber | null {
  if (raw === null || raw === undefined) return null;
  const row = asRecord(raw, path);
  return {
    label: asString(row.label, `${path}.label`),
    unit: asNullableString(row.unit, `${path}.unit`) ?? "",
  };
}

function parseEvidenceSpec(raw: unknown, path = "evidence"): ManualEvidenceSpec {
  const row = asRecord(raw, path);
  return {
    photo: parseEvidenceLevel(row.photo, `${path}.photo`),
    note: parseEvidenceLevel(row.note, `${path}.note`),
    number: parseEvidenceNumber(row.number, `${path}.number`),
    checklist: asArray(row.checklist ?? [], `${path}.checklist`).map((item, index) =>
      asString(item, `${path}.checklist[${index}]`),
    ),
  };
}

function parseSubmissionChecklist(raw: unknown, path: string): boolean[] {
  if (raw === null || raw === undefined) return [];
  return asArray(raw, path).map((item, index) => asBoolean(item, `${path}[${index}]`));
}

function parseSubmission(raw: unknown, path: string): ManualSubmission {
  const row = asRecord(raw, path);
  return {
    id: asString(row.id, `${path}.id`),
    missionId: asNullableString(row.mission_id, `${path}.mission_id`),
    submittedBy: asNullableString(row.submitted_by, `${path}.submitted_by`),
    note: asNullableString(row.note, `${path}.note`),
    numberValue: asNullableNumber(row.number_value, `${path}.number_value`),
    photoPaths: asArray(row.photo_paths ?? [], `${path}.photo_paths`).map((item, index) =>
      asString(item, `${path}.photo_paths[${index}]`),
    ),
    checklist: parseSubmissionChecklist(row.checklist, `${path}.checklist`),
    reviewStatus: asReviewStatus(row.review_status, `${path}.review_status`),
    reviewNote: asNullableString(row.review_note, `${path}.review_note`),
    rating: asNullableNumber(row.rating, `${path}.rating`),
    createdAt: asString(row.created_at, `${path}.created_at`),
  };
}

function parseNullableSubmission(raw: unknown, path: string): ManualSubmission | null {
  if (raw === null || raw === undefined) return null;
  return parseSubmission(raw, path);
}

function parseStaffLevel(raw: unknown, path: string): ManualStaffLevel | null {
  if (raw === null || raw === undefined) return null;
  const row = asRecord(raw, path);
  return {
    level: asNumber(row.level, `${path}.level`),
    title: asString(row.title, `${path}.title`),
    min_badges: asNumber(row.min_badges ?? 0, `${path}.min_badges`),
  };
}

function parseMyManualMission(raw: unknown, path: string): MyManualMission {
  const row = asRecord(raw, path);
  return {
    missionId: asString(row.mission_id, `${path}.mission_id`),
    batchId: asString(row.batch_id, `${path}.batch_id`),
    title: asString(row.title, `${path}.title`),
    dueAt: asNullableString(row.due_at, `${path}.due_at`),
    priority: asPriority(row.priority, `${path}.priority`),
    location: asLocation(row.location, `${path}.location`),
    evidence: parseEvidenceSpec(row.evidence, `${path}.evidence`),
    createdByName: asNullableString(row.created_by_name, `${path}.created_by_name`),
    createdAt: asString(row.created_at, `${path}.created_at`),
    reviewState: row.review_state === null || row.review_state === undefined
      ? null
      : asReviewStatus(row.review_state, `${path}.review_state`),
    lastSubmission: parseNullableSubmission(row.last_submission, `${path}.last_submission`),
    submissionsCount: Math.max(
      0,
      Math.trunc(asNumber(row.submissions_count ?? 0, `${path}.submissions_count`)),
    ),
  };
}

/** Parse `get_my_manual_missions`; garbled rows are dropped. */
export function parseMyManualMissions(raw: unknown): MyManualMission[] {
  if (Array.isArray(raw)) return parseRows(raw, "myManualMissions", parseMyManualMission);
  if (typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>).missions)) {
    return parseRows(
      (raw as Record<string, unknown>).missions,
      "myManualMissions.missions",
      parseMyManualMission,
    );
  }
  return [];
}

function parseBatchAssignee(raw: unknown, path: string): ManualBatchAssignee {
  const row = asRecord(raw, path);
  return {
    missionId: asString(row.mission_id, `${path}.mission_id`),
    userId: asString(row.user_id, `${path}.user_id`),
    name: asNullableString(row.name, `${path}.name`) ?? "",
    status: asMissionStatus(row.status, `${path}.status`),
    reviewState: row.review_state === null || row.review_state === undefined
      ? null
      : asReviewStatus(row.review_state, `${path}.review_state`),
    completedAt: asNullableString(row.completed_at, `${path}.completed_at`),
    lastSubmission: parseNullableSubmission(row.last_submission, `${path}.last_submission`),
  };
}

function parseManualBatch(raw: unknown, path: string): ManualBatch {
  const row = asRecord(raw, path);
  return {
    batchId: asString(row.batch_id, `${path}.batch_id`),
    title: asString(row.title, `${path}.title`),
    description: asNullableString(row.description, `${path}.description`),
    dueAt: asNullableString(row.due_at, `${path}.due_at`),
    priority: asPriority(row.priority, `${path}.priority`),
    location: asLocation(row.location, `${path}.location`),
    evidence: parseEvidenceSpec(row.evidence, `${path}.evidence`),
    createdAt: asString(row.created_at, `${path}.created_at`),
    assignees: parseRows(row.assignees ?? [], `${path}.assignees`, parseBatchAssignee),
  };
}

/** Parse `get_manual_missions_overview`; garbled batches / assignees are dropped. */
export function parseManualBatches(raw: unknown): ManualBatch[] {
  return parseRows(raw, "manualBatches", parseManualBatch);
}

function parseStaffMember(raw: unknown, path: string): ManualStaffMember {
  const row = asRecord(raw, path);
  const email = asNullableString(row.email, `${path}.email`) ?? "";
  const name = asNullableString(row.name, `${path}.name`)?.trim() || email;
  return {
    userId: asString(row.user_id, `${path}.user_id`),
    name,
    email,
    level: parseStaffLevel(row.level, `${path}.level`),
    openMissions: Math.max(
      0,
      Math.trunc(asNumber(row.open_missions ?? 0, `${path}.open_missions`)),
    ),
  };
}

/** Parse `get_manual_mission_staff`; garbled rows are dropped. */
export function parseManualStaff(raw: unknown): ManualStaffMember[] {
  return parseRows(raw, "manualStaff", parseStaffMember);
}

/** Parse `get_mission_submissions`; garbled rows are dropped. */
export function parseManualSubmissions(raw: unknown): ManualSubmission[] {
  return parseRows(raw, "manualSubmissions", parseSubmission);
}

/** Parse `create_manual_mission`. */
export function parseCreateManualMissionResult(raw: unknown): CreateManualMissionResult {
  const root = asRecord(raw, "createManualMissionResult");
  const missions = asArray(root.missions, "createManualMissionResult.missions").map(
    (entry, index) => {
      const path = `createManualMissionResult.missions[${index}]`;
      const row = asRecord(entry, path);
      return {
        missionId: asString(row.mission_id, `${path}.mission_id`),
        assigneeUserId: asString(row.assignee_user_id, `${path}.assignee_user_id`),
        assigneeName: asNullableString(row.assignee_name, `${path}.assignee_name`) ?? "",
      };
    },
  );
  return {
    batchId: asString(root.batch_id, "createManualMissionResult.batch_id"),
    missions,
  };
}

/** Parse `review_manual_mission`. */
export function parseReviewManualMissionResult(raw: unknown): ReviewManualMissionResult {
  const root = asRecord(raw, "reviewManualMissionResult");
  return {
    submissionId: asString(root.submission_id, "reviewManualMissionResult.submission_id"),
    missionId: asString(root.mission_id, "reviewManualMissionResult.mission_id"),
    reviewStatus: asReviewStatus(
      root.review_status,
      "reviewManualMissionResult.review_status",
    ),
    rating: asNullableNumber(root.rating, "reviewManualMissionResult.rating"),
    badgeAwarded: asBoolean(
      root.badge_awarded,
      "reviewManualMissionResult.badge_awarded",
    ),
    levelBefore: parseStaffLevel(root.level_before, "reviewManualMissionResult.level_before"),
    levelAfter: parseStaffLevel(root.level_after, "reviewManualMissionResult.level_after"),
  };
}

/** Parse the tiny `{mission_id, status}` result of add assignee / cancel. */
export function parseManualMissionActionResult(raw: unknown): ManualMissionActionResult {
  const root = asRecord(raw, "manualMissionActionResult");
  return {
    missionId: asString(root.mission_id, "manualMissionActionResult.mission_id"),
    status: asMissionStatus(root.status, "manualMissionActionResult.status"),
  };
}

export interface ManualEvidenceDraft {
  photoPaths?: string[] | null;
  note?: string | null;
  number?: number | null;
  checklist?: boolean[] | null;
}

/**
 * Mirror the server's submit validation so the form can show problems before the
 * RPC call. Returns short Vietnamese messages; an empty list means valid.
 */
export function validateEvidenceDraft(
  spec: ManualEvidenceSpec,
  draft: ManualEvidenceDraft,
): string[] {
  const problems: string[] = [];
  const paths = draft.photoPaths ?? [];
  const note = (draft.note ?? "").trim();
  const number = draft.number ?? null;
  const checklist = draft.checklist ?? [];

  if (spec.photo === "required" && paths.length === 0) {
    problems.push("Cần ít nhất 1 ảnh minh chứng");
  }
  if (spec.photo === "none" && paths.length > 0) {
    problems.push("Nhiệm vụ này không cần ảnh");
  }
  if (paths.length > 8) {
    problems.push("Tối đa 8 ảnh minh chứng");
  }
  if (paths.some((path) => path.includes(".."))) {
    problems.push("Đường dẫn ảnh không hợp lệ");
  }

  if (spec.note === "required" && note === "") {
    problems.push("Cần ghi chú");
  }
  if (spec.note === "none" && note !== "") {
    problems.push("Nhiệm vụ này không cần ghi chú");
  }

  if (spec.number !== null) {
    if (number === null || !Number.isFinite(number)) {
      problems.push("Cần nhập số liệu");
    }
  } else if (number !== null) {
    problems.push("Nhiệm vụ này không cần số liệu");
  }

  if (spec.checklist.length > 0) {
    const complete =
      checklist.length === spec.checklist.length && checklist.every((checked) => checked === true);
    if (!complete) {
      problems.push(`Cần tích đủ ${spec.checklist.length} mục trong danh sách`);
    }
  } else if (checklist.length > 0) {
    problems.push("Nhiệm vụ này không có danh sách kiểm tra");
  }

  return problems;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function formatVietnamDue(date: Date): string {
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

/**
 * Short Vietnamese due label:
 *   'Còn 3 giờ' (future, within 24h), 'Quá hạn 2 ngày', 'Hạn 20/10 17:00'.
 */
export function dueLabel(
  dueAt: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  if (dueAt === null || dueAt === undefined || dueAt === "") return "";
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  const dueMs = due.getTime();
  if (!Number.isFinite(dueMs)) return "";

  const diff = dueMs - now.getTime();
  if (diff <= 0) {
    const overdueMs = -diff;
    const days = Math.floor(overdueMs / DAY_MS);
    if (days >= 1) return `Quá hạn ${days} ngày`;
    const hours = Math.max(1, Math.ceil(overdueMs / HOUR_MS));
    return `Quá hạn ${hours} giờ`;
  }

  if (diff <= DAY_MS) {
    const hours = Math.max(1, Math.ceil(diff / HOUR_MS));
    return `Còn ${hours} giờ`;
  }

  return `Hạn ${formatVietnamDue(due)}`;
}

/**
 * Storage object path for one evidence photo:
 * `<missionId>/<timestamp>-<safe name>`, safe for the bucket policy and for the
 * `<mission_id>/` prefix the submit RPC requires.
 */
export function evidencePhotoPath(missionId: string, fileName: string): string {
  const base = (fileName.split(/[\\/]/).pop() ?? "").normalize("NFC");
  const safe = base
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^-+|-+$/g, "") || "photo";
  return `${missionId}/${Date.now()}-${safe}`;
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

/** Map a manual-mission RPC error to a short Vietnamese message. */
export function manualMissionErrorText(error: unknown): string {
  const { message, code, details } = readError(error);
  const haystack = `${message} ${details}`.toLowerCase();

  if (haystack.includes("forbidden") || code === "42501") {
    return "Bạn không có quyền thực hiện thao tác này";
  }
  if (haystack.includes("submission_not_found")) return "Không tìm thấy bài nộp";
  if (haystack.includes("mission_not_found")) return "Không tìm thấy nhiệm vụ";
  if (haystack.includes("batch_not_found")) return "Không tìm thấy đợt giao nhiệm vụ";
  if (haystack.includes("not_manual")) return "Đây không phải nhiệm vụ thủ công";
  if (haystack.includes("mission_not_open")) return "Nhiệm vụ này không còn mở";
  if (haystack.includes("mission_completed")) return "Nhiệm vụ đã hoàn thành";
  if (haystack.includes("already_submitted")) return "Nhiệm vụ đã được nộp và đang chờ duyệt";
  if (haystack.includes("already_reviewed")) return "Bài nộp đã được duyệt hoặc trả lại";
  if (haystack.includes("photo_required")) return "Cần ít nhất 1 ảnh minh chứng";
  if (haystack.includes("photo_not_allowed")) return "Nhiệm vụ này không cần ảnh";
  if (haystack.includes("invalid_photo_path")) return "Ảnh minh chứng không hợp lệ";
  if (haystack.includes("note_required")) return "Cần ghi chú";
  if (haystack.includes("note_not_allowed")) return "Nhiệm vụ này không cần ghi chú";
  if (haystack.includes("note_too_long")) return "Ghi chú quá dài";
  if (haystack.includes("number_required")) return "Cần nhập số liệu";
  if (haystack.includes("number_not_allowed")) return "Nhiệm vụ này không cần số liệu";
  if (haystack.includes("checklist_incomplete")) return "Cần tích đủ các mục trong danh sách";
  if (haystack.includes("assignee_not_allowed")) return "Người này không thể nhận nhiệm vụ";
  if (haystack.includes("invalid_assignee_count")) return "Chọn từ 1 đến 20 người nhận";
  if (haystack.includes("invalid_title")) return "Tiêu đề phải từ 3 đến 120 ký tự";
  if (haystack.includes("description_too_long")) return "Mô tả tối đa 2000 ký tự";
  if (haystack.includes("invalid_priority")) return "Mức ưu tiên không hợp lệ";
  if (haystack.includes("invalid_location")) return "Địa điểm không hợp lệ";
  if (haystack.includes("due_in_past")) return "Hạn chót đã qua";
  if (haystack.includes("invalid_evidence")) return "Yêu cầu minh chứng không hợp lệ";
  if (haystack.includes("rating_invalid")) return "Đánh giá phải từ 1 đến 5 sao";

  return message || "Có lỗi xảy ra";
}
