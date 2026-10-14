import assert from "node:assert/strict";
import test from "node:test";

import {
  imageRotationErrorCode,
  imageRotationErrorText,
  isSideways,
  nextRotation,
  normalizeRotation,
  type ImageRotation,
} from "./image-rotation";

test("normalizeRotation keeps the four valid clockwise rotations", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    assert.equal(normalizeRotation(rotation), rotation);
  }
});

test("normalizeRotation wraps negatives and values at or above 360", () => {
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(-180), 180);
  assert.equal(normalizeRotation(-270), 90);
  assert.equal(normalizeRotation(360), 0);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(720), 0);
});

test("normalizeRotation rejects non-multiples of 90 and junk", () => {
  for (const value of [45, 1, 90.5, 359, Number.NaN, Number.POSITIVE_INFINITY, "90", {}, null, undefined]) {
    assert.equal(normalizeRotation(value), 0, `normalizeRotation(${JSON.stringify(value)})`);
  }
});

test("nextRotation steps clockwise and wraps", () => {
  assert.equal(nextRotation(0), 90);
  assert.equal(nextRotation(90), 180);
  assert.equal(nextRotation(180), 270);
  assert.equal(nextRotation(270), 0);
});

test("isSideways is true only for 90 and 270", () => {
  const sideways: Record<ImageRotation, boolean> = { 0: false, 90: true, 180: false, 270: true };
  for (const [rotation, expected] of Object.entries(sideways)) {
    assert.equal(isSideways(Number(rotation) as ImageRotation), expected);
  }
});

test("imageRotationErrorCode extracts the known codes from error messages", () => {
  assert.equal(imageRotationErrorCode(new Error("forbidden")), "forbidden");
  assert.equal(imageRotationErrorCode({ message: "invalid_rotation" }), "invalid_rotation");
  assert.equal(imageRotationErrorCode("not_authenticated"), "not_authenticated");
  assert.equal(imageRotationErrorCode("invalid_path"), "invalid_path");
  assert.equal(
    imageRotationErrorCode({ message: 'new row violates check constraint "document_image_rotations_rotation_check"' }),
    null,
  );
  assert.equal(imageRotationErrorCode(null), null);
});

test("imageRotationErrorText gives the operator-facing Vietnamese message", () => {
  assert.equal(imageRotationErrorText("forbidden"), "Bạn không có quyền xoay ảnh phiếu");
  assert.equal(imageRotationErrorText("invalid_rotation"), "Chưa lưu được hướng xoay ảnh");
  assert.equal(imageRotationErrorText(null), "Chưa lưu được hướng xoay ảnh");
});
