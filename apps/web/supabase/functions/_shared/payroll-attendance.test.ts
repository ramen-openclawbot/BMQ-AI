import assert from "node:assert/strict";
import test from "node:test";

import {
  attendanceConsentState,
  attendanceMessage,
  dayStatus,
  dayStatusMessage,
  evaluateCheckin,
  haversineMeters,
  INCOMPLETE_DAY_MESSAGE,
  PAYROLL_ATTENDANCE_CONSENT_VERSION,
  PAYROLL_ATTENDANCE_MAX_ACCURACY_M,
  PAYROLL_ATTENDANCE_SELFIE_MAX_BYTES,
  PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN,
  selectExpiredSelfiePaths,
  selfieRetentionCutoff,
  validateSelfieUpload,
  vietnamWorkDate,
  type EvaluateCheckinInput,
} from "./payroll-attendance.ts";

const SITE = { siteLatitude: 10.75, siteLongitude: 106.65, radiusM: 50 };

function baseInput(overrides: Partial<EvaluateCheckinInput> = {}): EvaluateCheckinInput {
  return {
    eventKind: "in",
    gateEnabled: true,
    siteConfigured: true,
    ...SITE,
    latitude: 10.7501,
    longitude: 106.6501,
    accuracyM: 8,
    deviceApproved: true,
    deviceUsedByOtherEmployeeToday: false,
    hasAcceptedIn: false,
    hasAcceptedOut: false,
    ...overrides,
  };
}

/** Latitude offset that is exactly `metres` from SITE (same longitude). */
function latitudeAt(metres: number): number {
  return SITE.siteLatitude! + (metres / 6371008.8) * (180 / Math.PI);
}

test("haversineMeters computes zero and a known one-degree latitude distance", () => {
  assert.equal(haversineMeters(10.75, 106.65, 10.75, 106.65), 0);
  const oneDegree = haversineMeters(0, 0, 1, 0);
  assert.ok(Math.abs(oneDegree - 111194.93) < 1, `unexpected degree distance: ${oneDegree}`);
});

test("inside the radius is accepted and outside is rejected", () => {
  const inside = evaluateCheckin(baseInput({ latitude: latitudeAt(49.9), longitude: SITE.siteLongitude }));
  assert.equal(inside.decision, "accepted");
  assert.equal(inside.reasonCode, null);
  assert.ok(inside.distanceM !== null && inside.distanceM <= 50);

  const outside = evaluateCheckin(baseInput({ latitude: latitudeAt(50.1), longitude: SITE.siteLongitude }));
  assert.equal(outside.decision, "rejected");
  assert.equal(outside.reasonCode, "outside_geofence");
  assert.ok(outside.distanceM !== null && outside.distanceM > 50);
});

test("the radius boundary itself is inclusive", () => {
  const latitude = latitudeAt(42.123);
  const distance = haversineMeters(latitude, 106.65, SITE.siteLatitude!, SITE.siteLongitude!);
  const atBoundary = evaluateCheckin({
    ...baseInput(),
    latitude,
    longitude: SITE.siteLongitude,
    // Exact computed distance as the radius: `>` must not reject equality.
    radiusM: distance,
  });
  assert.equal(atBoundary.decision, "accepted");
  assert.equal(atBoundary.distanceM, distance);
});

test("missing gate, site, coordinates and accuracy each return the right code", () => {
  assert.equal(evaluateCheckin(baseInput({ gateEnabled: false })).reasonCode, "gate_disabled");
  assert.equal(evaluateCheckin(baseInput({ siteConfigured: false })).reasonCode, "site_not_configured");
  assert.equal(
    evaluateCheckin(baseInput({ siteLatitude: null, siteLongitude: null })).reasonCode,
    "site_not_configured",
  );
  assert.equal(evaluateCheckin(baseInput({ latitude: null })).reasonCode, "no_location");
  assert.equal(evaluateCheckin(baseInput({ longitude: Number.NaN })).reasonCode, "no_location");
  assert.equal(evaluateCheckin(baseInput({ latitude: 91 })).reasonCode, "no_location");
  assert.equal(
    evaluateCheckin(baseInput({ accuracyM: PAYROLL_ATTENDANCE_MAX_ACCURACY_M + 0.1 })).reasonCode,
    "low_accuracy",
  );
  assert.equal(evaluateCheckin(baseInput({ accuracyM: null })).reasonCode, "low_accuracy");
  // Exactly 100m is still trusted.
  assert.equal(
    evaluateCheckin(baseInput({ accuracyM: PAYROLL_ATTENDANCE_MAX_ACCURACY_M })).reasonCode,
    null,
  );
});

test("check-out requires an accepted check-in and duplicates are already_recorded", () => {
  assert.equal(
    evaluateCheckin(baseInput({ eventKind: "out", hasAcceptedIn: false })).reasonCode,
    "checkout_before_checkin",
  );
  assert.equal(
    evaluateCheckin(baseInput({ eventKind: "out", hasAcceptedIn: true })).decision,
    "accepted",
  );
  assert.equal(
    evaluateCheckin(baseInput({ eventKind: "in", hasAcceptedIn: true })).reasonCode,
    "already_recorded",
  );
  assert.equal(
    evaluateCheckin(baseInput({ eventKind: "out", hasAcceptedIn: true, hasAcceptedOut: true })).reasonCode,
    "already_recorded",
  );
});

test("an unapproved device waits for a manager", () => {
  assert.equal(
    evaluateCheckin(baseInput({ deviceApproved: false })).reasonCode,
    "device_not_approved",
  );
});

test("the employee's first device is registered automatically, later devices wait", () => {
  assert.equal(
    evaluateCheckin(baseInput({ deviceApproved: false, isFirstDeviceForEmployee: true })).decision,
    "accepted",
  );
  assert.equal(
    evaluateCheckin(baseInput({ deviceApproved: false, isFirstDeviceForEmployee: false })).reasonCode,
    "device_not_approved",
  );
  // A colleague's active phone can never become someone else's first device.
  assert.equal(
    evaluateCheckin(
      baseInput({ deviceApproved: false, isFirstDeviceForEmployee: true, deviceActiveForOtherEmployee: true }),
    ).reasonCode,
    "device_not_approved",
  );
  // Sharing on the same day is still caught first.
  assert.equal(
    evaluateCheckin(
      baseInput({ deviceApproved: false, isFirstDeviceForEmployee: true, deviceUsedByOtherEmployeeToday: true }),
    ).reasonCode,
    "device_used_by_other",
  );
});

test("a device already used by another employee is flagged as suspected proxy", () => {
  const result = evaluateCheckin(baseInput({ deviceUsedByOtherEmployeeToday: true }));
  assert.equal(result.decision, "rejected");
  assert.equal(result.reasonCode, "device_used_by_other");
  assert.equal(result.suspectedProxy, true);
});

test("vietnamWorkDate uses UTC+7 across the midnight boundary", () => {
  assert.equal(vietnamWorkDate(new Date("2026-11-09T16:59:00.000Z")), "2026-11-09");
  assert.equal(vietnamWorkDate(new Date("2026-11-09T17:00:00.000Z")), "2026-11-10");
  assert.equal(vietnamWorkDate(new Date("2026-11-09T17:01:00.000Z")), "2026-11-10");
});

test("dayStatus reports complete, missing_in, missing_out and approved_override", () => {
  assert.equal(dayStatus([], null), "missing_in");
  assert.equal(dayStatus([{ eventKind: "in", decision: "accepted" }], null), "missing_out");
  const complete = dayStatus(
    [
      { eventKind: "in", decision: "accepted" },
      { eventKind: "out", decision: "accepted" },
    ],
    null,
  );
  assert.equal(complete, "complete");
  assert.equal(
    dayStatus([{ eventKind: "in", decision: "accepted" }], true),
    "approved_override",
  );
});

test("the incomplete-day message is exact and hidden once complete/approved", () => {
  assert.equal(INCOMPLETE_DAY_MESSAGE, "Ngày công không được tính, vui lòng liên hệ quản lý duyệt");
  assert.equal(dayStatusMessage("missing_in"), INCOMPLETE_DAY_MESSAGE);
  assert.equal(dayStatusMessage("missing_out"), INCOMPLETE_DAY_MESSAGE);
  assert.equal(dayStatusMessage("complete"), "");
  assert.equal(dayStatusMessage("approved_override"), "");
});

test("attendanceMessage covers every reason code with Vietnamese guidance", () => {
  for (const reason of [
    "consent_required",
    "gate_disabled",
    "site_not_configured",
    "no_location",
    "low_accuracy",
    "outside_geofence",
    "device_not_approved",
    "device_used_by_other",
    "already_recorded",
    "checkout_before_checkin",
    "session_invalid",
  ] as const) {
    const message = attendanceMessage(reason);
    assert.ok(message.length > 0);
    assert.notEqual(message, "Không thực hiện được chấm công. Vui lòng thử lại.");
  }
  assert.equal(attendanceMessage(null), "Đã chấm công.");
});

test("consent is required before location checks and defaults to accepted", () => {
  assert.equal(PAYROLL_ATTENDANCE_CONSENT_VERSION, "2026-11-09");
  assert.equal(evaluateCheckin(baseInput()).decision, "accepted");
  assert.equal(
    evaluateCheckin(baseInput({ consentAccepted: false })).reasonCode,
    "consent_required",
  );
  // The consent gate runs before site/GPS/device checks.
  assert.equal(
    evaluateCheckin(
      baseInput({ consentAccepted: false, siteConfigured: false, latitude: null }),
    ).reasonCode,
    "consent_required",
  );
  // A disabled rollout gate is still reported first.
  assert.equal(
    evaluateCheckin(baseInput({ consentAccepted: false, gateEnabled: false })).reasonCode,
    "gate_disabled",
  );
  assert.equal(
    attendanceMessage("consent_required"),
    "Bạn cần đọc và đồng ý thoả thuận sử dụng hình ảnh và vị trí trước khi chấm công.",
  );
});

test("consent state only accepts the current version and never a withdrawn row", () => {
  assert.deepEqual(attendanceConsentState("2026-11-09", null), {
    requiredVersion: "2026-11-09",
    accepted: false,
    acceptedAt: null,
    withdrawnAt: null,
  });
  assert.deepEqual(
    attendanceConsentState("2026-11-09", {
      consentVersion: "2026-11-09",
      acceptedAt: "2026-11-09T01:00:00.000Z",
      withdrawnAt: null,
    }),
    {
      requiredVersion: "2026-11-09",
      accepted: true,
      acceptedAt: "2026-11-09T01:00:00.000Z",
      withdrawnAt: null,
    },
  );
  assert.deepEqual(
    attendanceConsentState("2026-11-10", {
      consentVersion: "2026-11-09",
      acceptedAt: "2026-11-09T01:00:00.000Z",
      withdrawnAt: null,
    }),
    {
      requiredVersion: "2026-11-10",
      accepted: false,
      acceptedAt: null,
      withdrawnAt: null,
    },
  );
  assert.deepEqual(
    attendanceConsentState("2026-11-09", {
      consentVersion: "2026-11-09",
      acceptedAt: "2026-11-09T01:00:00.000Z",
      withdrawnAt: "2026-11-09T02:00:00.000Z",
    }),
    {
      requiredVersion: "2026-11-09",
      accepted: false,
      acceptedAt: "2026-11-09T01:00:00.000Z",
      withdrawnAt: "2026-11-09T02:00:00.000Z",
    },
  );
});

test("selfie retention cutoff keeps objects newer than 90 days and caps each run", () => {
  const now = new Date("2026-11-09T20:30:00.000Z");
  const cutoff = selfieRetentionCutoff(now, 90);
  assert.equal(cutoff, "2026-08-11T20:30:00.000Z");

  const expired = selectExpiredSelfiePaths(
    [
      { path: "old.jpg", createdAt: "2026-08-11T20:29:59.999Z" },
      { path: "boundary.jpg", createdAt: cutoff },
      { path: "new.jpg", createdAt: "2026-11-01T00:00:00.000Z" },
      { path: "unknown.jpg", createdAt: null },
      { path: "invalid.jpg", createdAt: "not-a-date" },
    ],
    cutoff,
  );
  assert.deepEqual(expired, ["old.jpg"]);

  const many = Array.from({ length: 1005 }, (_, index) => ({
    path: `old-${index}.jpg`,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  assert.equal(selectExpiredSelfiePaths(many, cutoff).length, PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN);
  assert.equal(selectExpiredSelfiePaths(many, cutoff, 3).length, 3);
  assert.equal(selectExpiredSelfiePaths(many, "not-a-date").length, 0);
});

test("validateSelfieUpload accepts JPEG/WebP up to 600 KB only", () => {
  assert.deepEqual(validateSelfieUpload("image/jpeg", 1024), { ok: true });
  assert.deepEqual(validateSelfieUpload("image/webp", new Uint8Array(2048)), { ok: true });
  assert.deepEqual(validateSelfieUpload("image/jpeg", PAYROLL_ATTENDANCE_SELFIE_MAX_BYTES), { ok: true });

  assert.equal(validateSelfieUpload("image/png", 100).ok, false);
  assert.equal(validateSelfieUpload("image/gif", 100).ok, false);
  assert.equal(validateSelfieUpload("image/jpeg", 0).ok, false);
  assert.equal(validateSelfieUpload("image/jpeg", null).ok, false);
  assert.equal(
    validateSelfieUpload("image/jpeg", PAYROLL_ATTENDANCE_SELFIE_MAX_BYTES + 1).ok,
    false,
  );

  const invalidType = validateSelfieUpload("image/png", 100);
  assert.equal(invalidType.ok ? null : invalidType.reasonCode, "selfie_type_invalid");
  const tooLarge = validateSelfieUpload("image/jpeg", PAYROLL_ATTENDANCE_SELFIE_MAX_BYTES + 1);
  assert.equal(tooLarge.ok ? null : tooLarge.reasonCode, "selfie_too_large");
  const empty = validateSelfieUpload("image/jpeg", 0);
  assert.equal(empty.ok ? null : empty.reasonCode, "selfie_required");
});
