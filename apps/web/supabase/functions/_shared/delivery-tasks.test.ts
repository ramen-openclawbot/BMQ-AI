import assert from "node:assert/strict";
import test from "node:test";

import {
  decideDeliveryLocation,
  deliveryCompletionWindow,
  deliveryMapsLink,
  deliveryProofPath,
  deliveryUnitsForDay,
  distanceMeters,
  haversineMeters,
  isValidDeliveryUnits,
  validateDeliveryCompletion,
} from "./delivery-tasks.ts";

const PENDING_TODAY = {
  employeeCode: "DRV01",
  deliveryDate: "2026-11-25",
  status: "pending",
} as const;

const NOON = "2026-11-25T12:00:00+07:00";

test("haversine and distance return metres with two decimals", () => {
  assert.equal(haversineMeters(10, 106, 10, 106), 0);
  const oneDegreeLat = haversineMeters(0, 0, 1, 0);
  assert.ok(oneDegreeLat > 111_000 && oneDegreeLat < 111_300);
  assert.equal(distanceMeters(10, 106, 10.001, 106), 111.2);
  assert.equal(distanceMeters(null, 106, 10, 106), null);
  assert.equal(Number.isNaN(haversineMeters(Number.NaN, 0, 0, 0)), true);
});

test("a destination without coordinates gets them from the first completion", () => {
  assert.deepEqual(decideDeliveryLocation(null, null, 10.1, 106.2), {
    locationAttached: true,
    distanceM: null,
  });
  assert.deepEqual(decideDeliveryLocation(10, 106, 10.1, 106.2), {
    locationAttached: false,
    distanceM: 24559.23,
  });
});

test("the completion window is today, or yesterday before 06:00 Vietnam time", () => {
  assert.deepEqual(deliveryCompletionWindow(NOON).allowedDates, ["2026-11-25"]);
  assert.deepEqual(
    deliveryCompletionWindow("2026-11-26T02:00:00+07:00").allowedDates,
    ["2026-11-26", "2026-11-25"],
  );
  assert.deepEqual(
    deliveryCompletionWindow("2026-11-26T07:00:00+07:00").allowedDates,
    ["2026-11-26"],
  );
  assert.equal(deliveryCompletionWindow("2026-11-26T00:30:00+07:00").allowPrevious, true);
});

test("a valid completion returns the attach decision", () => {
  const result = validateDeliveryCompletion({
    task: PENDING_TODAY,
    employeeCode: "DRV01",
    photoMime: "image/jpeg",
    photoBytes: 2 * 1024 * 1024,
    latitude: 10.1,
    longitude: 106.2,
    accuracyM: 12,
    destinationLatitude: null,
    destinationLongitude: null,
    now: NOON,
  });
  assert.deepEqual(result, { ok: true, locationAttached: true, distanceM: null });

  const existing = validateDeliveryCompletion({
    task: PENDING_TODAY,
    employeeCode: "DRV01",
    photoMime: "image/png",
    photoBytes: 100,
    latitude: 10.1,
    longitude: 106.2,
    accuracyM: 0,
    destinationLatitude: 10,
    destinationLongitude: 106,
    now: NOON,
  });
  assert.equal(existing.ok, true);
  assert.equal(existing.ok && existing.locationAttached, false);
  assert.equal(existing.ok && existing.distanceM, 24559.23);
});

test("a completion is rejected for another driver, a closed date or a finished task", () => {
  const notMine = validateDeliveryCompletion({
    task: PENDING_TODAY,
    employeeCode: "DRV02",
    photoMime: "image/jpeg",
    photoBytes: 100,
    latitude: 10,
    longitude: 106,
    accuracyM: 5,
    now: NOON,
  });
  assert.equal(notMine.ok, false);
  assert.equal(notMine.ok ? "" : notMine.code, "delivery_not_assigned");

  const closed = validateDeliveryCompletion({
    task: { ...PENDING_TODAY, deliveryDate: "2026-11-24" },
    employeeCode: "DRV01",
    photoMime: "image/jpeg",
    photoBytes: 100,
    latitude: 10,
    longitude: 106,
    accuracyM: 5,
    now: NOON,
  });
  assert.equal(closed.ok ? "" : closed.code, "delivery_date_closed");

  const yesterdayBeforeSix = validateDeliveryCompletion({
    task: { ...PENDING_TODAY, deliveryDate: "2026-11-24" },
    employeeCode: "DRV01",
    photoMime: "image/jpeg",
    photoBytes: 100,
    latitude: 10,
    longitude: 106,
    accuracyM: 5,
    now: "2026-11-25T05:59:00+07:00",
  });
  assert.equal(yesterdayBeforeSix.ok, true);

  const completed = validateDeliveryCompletion({
    task: { ...PENDING_TODAY, status: "completed" },
    employeeCode: "DRV01",
    photoMime: "image/jpeg",
    photoBytes: 100,
    latitude: 10,
    longitude: 106,
    accuracyM: 5,
    now: NOON,
  });
  assert.equal(completed.ok ? "" : completed.httpStatus, 409);
  assert.equal(completed.ok ? "" : completed.code, "delivery_not_pending");

  // An owner reopen explicitly lifts the today/yesterday window.
  const reopened = validateDeliveryCompletion({
    task: {
      ...PENDING_TODAY,
      deliveryDate: "2026-08-15",
      reopenedAt: "2026-11-20T10:00:00+07:00",
    },
    employeeCode: "DRV01",
    photoMime: "image/jpeg",
    photoBytes: 100,
    latitude: 10,
    longitude: 106,
    accuracyM: 5,
    now: NOON,
  });
  assert.equal(reopened.ok, true);
});

test("the photo must be JPEG/PNG/WebP and at most 3 MB", () => {
  const base = {
    task: PENDING_TODAY,
    employeeCode: "DRV01",
    latitude: 10,
    longitude: 106,
    accuracyM: 5,
    now: NOON,
  };
  assert.equal(
    validateDeliveryCompletion({ ...base, photoMime: "image/gif", photoBytes: 10 }).ok,
    false,
  );
  assert.equal(
    validateDeliveryCompletion({ ...base, photoMime: "image/jpeg", photoBytes: 0 }).ok,
    false,
  );
  const tooLarge = validateDeliveryCompletion({
    ...base,
    photoMime: "image/webp",
    photoBytes: 3 * 1024 * 1024 + 1,
  });
  assert.equal(tooLarge.ok ? "" : tooLarge.code, "delivery_photo_too_large");
  assert.equal(
    validateDeliveryCompletion({ ...base, photoMime: "image/jpeg", photoBytes: 3 * 1024 * 1024 }).ok,
    true,
  );
});

test("coordinates and accuracy are required, accuracy only has a lower bound", () => {
  const base = {
    task: PENDING_TODAY,
    employeeCode: "DRV01",
    photoMime: "image/jpeg",
    photoBytes: 100,
    accuracyM: 5,
    now: NOON,
  };
  assert.equal(
    validateDeliveryCompletion({ ...base, latitude: null, longitude: 106 }).ok,
    false,
  );
  assert.equal(
    validateDeliveryCompletion({ ...base, latitude: 10, longitude: 181 }).ok,
    false,
  );
  assert.equal(
    validateDeliveryCompletion({ ...base, latitude: 10, longitude: 106, accuracyM: -1 }).ok,
    false,
  );
  assert.equal(
    validateDeliveryCompletion({ ...base, latitude: 10, longitude: 106, accuracyM: 100000 }).ok,
    true,
  );
});

test("proof path and maps link keep the agreed shape", () => {
  assert.equal(
    deliveryProofPath("DRV01", "2026-11-25", "task-1", "image/jpeg"),
    "DRV01/2026-11-25/task-1.jpg",
  );
  assert.equal(
    deliveryProofPath("a/b", "2026-11-25", "t 1", "image/webp"),
    "a_b/2026-11-25/t_1.webp",
  );
  assert.equal(
    deliveryProofPath("DRV01", "2026-11-25", "task-1", "image/png", "attempt-1"),
    "DRV01/2026-11-25/task-1-attempt-1.png",
  );
  assert.equal(
    deliveryMapsLink("Điểm A", "1 Lê Lợi", 10.1, 106.2),
    "https://www.google.com/maps?q=10.1,106.2",
  );
  assert.equal(
    deliveryMapsLink("Điểm A", "1 Lê Lợi", null, null),
    "https://www.google.com/maps/search/?api=1&query=%C4%90i%E1%BB%83m%20A%201%20L%C3%AA%20L%E1%BB%A3i",
  );
});

test("delivery units per day: base only when something was completed", () => {
  assert.equal(deliveryUnitsForDay(0.5, []), 0);
  assert.equal(deliveryUnitsForDay(0.5, [1.25]), 1.75);
  assert.equal(deliveryUnitsForDay(0.5, [1.25, 2, 0.5]), 4.25);
  assert.equal(deliveryUnitsForDay(0, [2]), 2);
  assert.equal(deliveryUnitsForDay(0.75, [0]), 0.75);
  assert.equal(isValidDeliveryUnits(0.25), true);
  assert.equal(isValidDeliveryUnits(0.3), false);
  assert.equal(isValidDeliveryUnits(-0.25), false);
});
