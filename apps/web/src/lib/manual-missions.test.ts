// Node tests for the manual mission card / evidence / review data layer.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dueLabel,
  evidencePhotoPath,
  manualMissionErrorText,
  parseCreateManualMissionResult,
  parseManualBatches,
  parseManualMissionActionResult,
  parseManualStaff,
  parseManualSubmissions,
  parseMyManualMissions,
  parseReviewManualMissionResult,
  validateEvidenceDraft,
  type ManualEvidenceSpec,
} from "./manual-missions.ts";

const EVIDENCE: ManualEvidenceSpec = {
  photo: "required",
  note: "optional",
  number: { label: "Số thùng", unit: "thùng" },
  checklist: ["Kiểm tra niêm phong", "Đếm đủ thùng"],
};

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    mission_id: "22222222-2222-2222-2222-222222222222",
    submitted_by: "33333333-3333-3333-3333-333333333333",
    note: "Hàng đủ",
    number_value: 10,
    photo_paths: ["22222222-2222-2222-2222-222222222222/a.jpg"],
    checklist: [true, true],
    review_status: "pending",
    review_note: null,
    rating: null,
    created_at: "2026-10-20T10:00:00+00:00",
    ...overrides,
  };
}

test("parseMyManualMissions reads the board and drops only garbled rows", () => {
  const parsed = parseMyManualMissions([
    {
      mission_id: "22222222-2222-2222-2222-222222222222",
      batch_id: "44444444-4444-4444-4444-444444444444",
      title: "Kiểm kho Tân Tạo",
      due_at: "2026-10-22T10:00:00+00:00",
      priority: "high",
      location: "tan_tao",
      evidence: EVIDENCE,
      created_by_name: "Chủ",
      created_at: "2026-10-20T09:00:00+00:00",
      review_state: "pending",
      last_submission: submission(),
      submissions_count: 2,
      extra: "ignored",
    },
    {
      mission_id: "55555555-5555-5555-5555-555555555555",
      batch_id: "44444444-4444-4444-4444-444444444444",
      title: "Chưa nộp",
      due_at: null,
      priority: "normal",
      location: null,
      evidence: { photo: "none", note: "none", number: null, checklist: [] },
      created_by_name: null,
      created_at: "2026-10-20T09:00:00+00:00",
      review_state: null,
      last_submission: null,
      submissions_count: 0,
    },
    { mission_id: "missing-batch" },
    {
      mission_id: "66666666-6666-6666-6666-666666666666",
      batch_id: "44444444-4444-4444-4444-444444444444",
      title: "Sai ưu tiên",
      priority: "urgent",
      evidence: EVIDENCE,
      created_at: "2026-10-20T09:00:00+00:00",
    },
    null,
  ]);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].missionId, "22222222-2222-2222-2222-222222222222");
  assert.equal(parsed[0].priority, "high");
  assert.equal(parsed[0].location, "tan_tao");
  assert.equal(parsed[0].evidence.photo, "required");
  assert.equal(parsed[0].evidence.number?.unit, "thùng");
  assert.deepEqual(parsed[0].evidence.checklist, ["Kiểm tra niêm phong", "Đếm đủ thùng"]);
  assert.equal(parsed[0].reviewState, "pending");
  assert.equal(parsed[0].lastSubmission?.numberValue, 10);
  assert.deepEqual(parsed[0].lastSubmission?.checklist, [true, true]);
  assert.equal(parsed[0].submissionsCount, 2);
  assert.equal(parsed[1].reviewState, null);
  assert.equal(parsed[1].lastSubmission, null);
});

test("parseMyManualMissions accepts a wrapped payload and empty input", () => {
  const wrapped = parseMyManualMissions({
    missions: [
      {
        mission_id: "22222222-2222-2222-2222-222222222222",
        batch_id: "44444444-4444-4444-4444-444444444444",
        title: "Kiểm kho",
        due_at: null,
        priority: "normal",
        location: null,
        evidence: { photo: "optional", note: "optional", number: null, checklist: [] },
        created_by_name: null,
        created_at: "2026-10-20T09:00:00+00:00",
        review_state: null,
        last_submission: null,
        submissions_count: 0,
      },
    ],
  });
  assert.equal(wrapped.length, 1);
  assert.deepEqual(parseMyManualMissions(null), []);
  assert.deepEqual(parseMyManualMissions({ rows: [] }), []);
});

test("last_submission may omit mission_id and submitted_by", () => {
  const parsed = parseMyManualMissions([
    {
      mission_id: "22222222-2222-2222-2222-222222222222",
      batch_id: "44444444-4444-4444-4444-444444444444",
      title: "Kiểm kho",
      due_at: null,
      priority: "normal",
      location: null,
      evidence: { photo: "optional", note: "optional", number: null, checklist: [] },
      created_by_name: null,
      created_at: "2026-10-20T09:00:00+00:00",
      review_state: "returned",
      last_submission: {
        id: "77777777-7777-7777-7777-777777777777",
        note: "Thiếu ảnh",
        number_value: null,
        photo_paths: [],
        checklist: [],
        review_status: "returned",
        review_note: "Chụp lại",
        rating: null,
        created_at: "2026-10-20T10:00:00+00:00",
      },
      submissions_count: 1,
    },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].lastSubmission?.missionId, null);
  assert.equal(parsed[0].lastSubmission?.submittedBy, null);
  assert.equal(parsed[0].lastSubmission?.reviewNote, "Chụp lại");
});

test("parseManualBatches reads nested assignees and drops garbage", () => {
  const parsed = parseManualBatches([
    {
      batch_id: "44444444-4444-4444-4444-444444444444",
      title: "Kiểm kho Tân Tạo",
      description: "Đếm đủ thùng",
      due_at: "2026-10-22T10:00:00+00:00",
      priority: "high",
      location: "tan_tao",
      evidence: EVIDENCE,
      created_at: "2026-10-20T09:00:00+00:00",
      assignees: [
        {
          mission_id: "22222222-2222-2222-2222-222222222222",
          user_id: "33333333-3333-3333-3333-333333333333",
          name: "Nguyễn An",
          status: "open",
          review_state: "pending",
          completed_at: null,
          last_submission: submission(),
          extra: true,
        },
        { mission_id: "missing-user" },
      ],
    },
    { batch_id: "missing-title" },
    "not a batch",
  ]);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].batchId, "44444444-4444-4444-4444-444444444444");
  assert.equal(parsed[0].priority, "high");
  assert.equal(parsed[0].assignees.length, 1);
  assert.equal(parsed[0].assignees[0].name, "Nguyễn An");
  assert.equal(parsed[0].assignees[0].status, "open");
  assert.equal(parsed[0].assignees[0].lastSubmission?.reviewStatus, "pending");
  assert.deepEqual(parseManualBatches(undefined), []);
});

test("parseManualStaff keeps valid rows, falls back to email and drops garbage", () => {
  const parsed = parseManualStaff([
    {
      user_id: "33333333-3333-3333-3333-333333333333",
      name: "  Nguyễn An  ",
      email: "an@example.com",
      level: { level: 2, title: "Thợ kho", min_badges: 3 },
      open_missions: "4",
      badges: 9,
      extra: true,
    },
    {
      user_id: "88888888-8888-8888-8888-888888888888",
      name: "",
      email: "binh@example.com",
      level: null,
      open_missions: 0,
    },
    { user_id: "99999999-9999-9999-9999-999999999999", open_missions: "many" },
    null,
  ]);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Nguyễn An");
  assert.equal(parsed[0].openMissions, 4);
  assert.equal(parsed[0].level?.title, "Thợ kho");
  assert.equal(parsed[1].name, "binh@example.com");
  assert.equal(parsed[1].level, null);
});

test("parseManualSubmissions keeps newest rows and drops garbage", () => {
  const parsed = parseManualSubmissions([
    submission({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
    submission({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", review_status: "returned" }),
    { id: "missing-status" },
    null,
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].reviewStatus, "pending");
  assert.equal(parsed[1].reviewStatus, "returned");
  assert.deepEqual(parseManualSubmissions({ rows: [] }), []);
});

test("parseCreateManualMissionResult validates the batch result", () => {
  const parsed = parseCreateManualMissionResult({
    batch_id: "44444444-4444-4444-4444-444444444444",
    missions: [
      {
        mission_id: "22222222-2222-2222-2222-222222222222",
        assignee_user_id: "33333333-3333-3333-3333-333333333333",
        assignee_name: "Nguyễn An",
        extra: "ignored",
      },
      {
        mission_id: "55555555-5555-5555-5555-555555555555",
        assignee_user_id: "66666666-6666-6666-6666-666666666666",
        assignee_name: null,
      },
    ],
  });
  assert.equal(parsed.batchId, "44444444-4444-4444-4444-444444444444");
  assert.equal(parsed.missions.length, 2);
  assert.equal(parsed.missions[0].assigneeName, "Nguyễn An");
  assert.equal(parsed.missions[1].assigneeName, "");
  assert.throws(() => parseCreateManualMissionResult(null), TypeError);
  assert.throws(() => parseCreateManualMissionResult({ batch_id: "x" }), TypeError);
});

test("parseReviewManualMissionResult keeps the badge / level outcome", () => {
  const approved = parseReviewManualMissionResult({
    submission_id: "11111111-1111-1111-1111-111111111111",
    mission_id: "22222222-2222-2222-2222-222222222222",
    review_status: "approved",
    rating: 5,
    badge_awarded: true,
    level_before: { level: 1, title: "Tập sự", min_badges: 0 },
    level_after: { level: 2, title: "Thợ kho", min_badges: 3 },
    extra: "ignored",
  });
  assert.equal(approved.reviewStatus, "approved");
  assert.equal(approved.rating, 5);
  assert.equal(approved.badgeAwarded, true);
  assert.equal(approved.levelAfter?.title, "Thợ kho");

  const returned = parseReviewManualMissionResult({
    submission_id: "11111111-1111-1111-1111-111111111111",
    mission_id: "22222222-2222-2222-2222-222222222222",
    review_status: "returned",
    rating: null,
    badge_awarded: false,
    level_before: null,
    level_after: null,
  });
  assert.equal(returned.reviewStatus, "returned");
  assert.equal(returned.badgeAwarded, false);
  assert.equal(returned.levelBefore, null);

  assert.throws(() => parseReviewManualMissionResult(null), TypeError);
  assert.throws(
    () => parseReviewManualMissionResult({ submission_id: "x", mission_id: "y" }),
    TypeError,
  );
});

test("parseManualMissionActionResult reads add / cancel results", () => {
  assert.deepEqual(
    parseManualMissionActionResult({ mission_id: "m", status: "open" }),
    { missionId: "m", status: "open" },
  );
  assert.deepEqual(
    parseManualMissionActionResult({ mission_id: "m", status: "cancelled" }),
    { missionId: "m", status: "cancelled" },
  );
  assert.throws(() => parseManualMissionActionResult({ mission_id: "m", status: "paused" }), TypeError);
});

test("validateEvidenceDraft mirrors the server evidence rules", () => {
  const valid = validateEvidenceDraft(EVIDENCE, {
    photoPaths: ["mission/a.jpg"],
    note: "",
    number: 10,
    checklist: [true, true],
  });
  assert.deepEqual(valid, []);

  const missingPhoto = validateEvidenceDraft(EVIDENCE, {
    photoPaths: [],
    note: "",
    number: 10,
    checklist: [true, true],
  });
  assert.deepEqual(missingPhoto, ["Cần ít nhất 1 ảnh minh chứng"]);

  const missingNumber = validateEvidenceDraft(EVIDENCE, {
    photoPaths: ["mission/a.jpg"],
    note: "",
    number: null,
    checklist: [true, true],
  });
  assert.deepEqual(missingNumber, ["Cần nhập số liệu"]);

  const incomplete = validateEvidenceDraft(EVIDENCE, {
    photoPaths: ["mission/a.jpg"],
    note: "",
    number: 10,
    checklist: [true, false],
  });
  assert.deepEqual(incomplete, ["Cần tích đủ 2 mục trong danh sách"]);

  const noPhotoSpec: ManualEvidenceSpec = {
    photo: "none",
    note: "none",
    number: null,
    checklist: [],
  };
  assert.deepEqual(
    validateEvidenceDraft(noPhotoSpec, {
      photoPaths: ["mission/a.jpg"],
      note: "Ghi chú",
      number: 3,
      checklist: [],
    }),
    ["Nhiệm vụ này không cần ảnh", "Nhiệm vụ này không cần ghi chú", "Nhiệm vụ này không cần số liệu"],
  );

  const requiredNote: ManualEvidenceSpec = {
    photo: "optional",
    note: "required",
    number: null,
    checklist: [],
  };
  assert.deepEqual(
    validateEvidenceDraft(requiredNote, { photoPaths: ["x/..jpg"], note: "  " }),
    ["Đường dẫn ảnh không hợp lệ", "Cần ghi chú"],
  );

  const tooMany = validateEvidenceDraft(
    { ...EVIDENCE, photo: "optional" },
    { photoPaths: Array.from({ length: 9 }, (_, i) => `mission/${i}.jpg`), number: 1, checklist: [true, true] },
  );
  assert.deepEqual(tooMany, ["Tối đa 8 ảnh minh chứng"]);

  assert.deepEqual(
    validateEvidenceDraft(
      { photo: "optional", note: "optional", number: null, checklist: [] },
      { checklist: [true] },
    ),
    ["Nhiệm vụ này không có danh sách kiểm tra"],
  );
});

test("dueLabel formats future hours, overdue days and a Vietnam date", () => {
  const now = new Date("2026-10-20T10:00:00Z");
  assert.equal(dueLabel("2026-10-20T13:00:00Z", now), "Còn 3 giờ");
  assert.equal(dueLabel("2026-10-20T12:30:00Z", now), "Còn 3 giờ");
  assert.equal(dueLabel("2026-10-18T10:00:00Z", now), "Quá hạn 2 ngày");
  assert.equal(dueLabel("2026-10-20T08:00:00Z", now), "Quá hạn 2 giờ");
  assert.equal(dueLabel("2026-10-22T10:00:00Z", now), "Hạn 22/10 17:00");
  assert.equal(dueLabel(new Date("2026-10-22T10:00:00Z"), now), "Hạn 22/10 17:00");
  assert.equal(dueLabel(null, now), "");
  assert.equal(dueLabel("not a date", now), "");
});

test("evidencePhotoPath always lives under the mission folder", () => {
  const missionId = "22222222-2222-2222-2222-222222222222";
  const path = evidencePhotoPath(missionId, "../../Ảnh kho (1).JPG");
  assert.ok(path.startsWith(`${missionId}/`));
  assert.ok(!path.includes(".."));
  assert.match(path, /\/\d{13}-nh-kho-1-\.JPG$/);
  assert.ok(evidencePhotoPath(missionId, "").endsWith("-photo"));
});

test("manualMissionErrorText maps every server error code", () => {
  const cases: Array<[string, string]> = [
    ["forbidden", "Bạn không có quyền thực hiện thao tác này"],
    ["mission_not_found", "Không tìm thấy nhiệm vụ"],
    ["submission_not_found", "Không tìm thấy bài nộp"],
    ["batch_not_found", "Không tìm thấy đợt giao nhiệm vụ"],
    ["not_manual", "Đây không phải nhiệm vụ thủ công"],
    ["mission_not_open", "Nhiệm vụ này không còn mở"],
    ["mission_completed", "Nhiệm vụ đã hoàn thành"],
    ["already_submitted", "Nhiệm vụ đã được nộp và đang chờ duyệt"],
    ["already_reviewed", "Bài nộp đã được duyệt hoặc trả lại"],
    ["photo_required", "Cần ít nhất 1 ảnh minh chứng"],
    ["photo_not_allowed", "Nhiệm vụ này không cần ảnh"],
    ["invalid_photo_path", "Ảnh minh chứng không hợp lệ"],
    ["note_required", "Cần ghi chú"],
    ["note_not_allowed", "Nhiệm vụ này không cần ghi chú"],
    ["note_too_long", "Ghi chú quá dài"],
    ["number_required", "Cần nhập số liệu"],
    ["number_not_allowed", "Nhiệm vụ này không cần số liệu"],
    ["checklist_incomplete", "Cần tích đủ các mục trong danh sách"],
    ["assignee_not_allowed", "Người này không thể nhận nhiệm vụ"],
    ["invalid_assignee_count", "Chọn từ 1 đến 20 người nhận"],
    ["invalid_title", "Tiêu đề phải từ 3 đến 120 ký tự"],
    ["description_too_long", "Mô tả tối đa 2000 ký tự"],
    ["invalid_priority", "Mức ưu tiên không hợp lệ"],
    ["invalid_location", "Địa điểm không hợp lệ"],
    ["due_in_past", "Hạn chót đã qua"],
    ["invalid_evidence", "Yêu cầu minh chứng không hợp lệ"],
    ["rating_invalid", "Đánh giá phải từ 1 đến 5 sao"],
  ];
  for (const [code, expected] of cases) {
    assert.equal(manualMissionErrorText({ message: code, code: "22023" }), expected, code);
  }
  assert.equal(manualMissionErrorText("mất kết nối"), "mất kết nối");
  assert.equal(manualMissionErrorText(null), "Có lỗi xảy ra");
});
