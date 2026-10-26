import assert from "node:assert/strict";
import test from "node:test";

import {
  dedupeBySha,
  summarizeCeoSlips,
  type SalaryCeoSlipLike,
} from "./salary-ceo-evidence.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

const slip = (file_sha256: string, ocr_amount: number | null): SalaryCeoSlipLike => ({
  file_sha256,
  ocr_amount,
});

test("two slips summing exactly to the total match", () => {
  const summary = summarizeCeoSlips(
    [slip(SHA_A, 7_166_000), slip(SHA_B, 7_250_000)],
    14_416_000,
  );

  assert.equal(summary.sum, 14_416_000);
  assert.equal(summary.unreadCount, 0);
  assert.deepEqual(summary.duplicateShas, []);
  assert.equal(summary.status, "match");
});

test("a smaller OCR total is short", () => {
  const summary = summarizeCeoSlips([slip(SHA_A, 7_166_000)], 14_416_000);

  assert.equal(summary.sum, 7_166_000);
  assert.equal(summary.status, "short");
});

test("a larger OCR total is over", () => {
  const summary = summarizeCeoSlips(
    [slip(SHA_A, 7_166_000), slip(SHA_B, 7_250_001)],
    14_416_000,
  );

  assert.equal(summary.sum, 14_416_001);
  assert.equal(summary.status, "over");
});

test("one unread slip makes the summary unread", () => {
  const summary = summarizeCeoSlips(
    [slip(SHA_A, 7_166_000), slip(SHA_B, null)],
    14_416_000,
  );

  assert.equal(summary.sum, 7_166_000);
  assert.equal(summary.unreadCount, 1);
  assert.equal(summary.status, "unread");
});

test("a repeated sha256 is reported as a duplicate", () => {
  const summary = summarizeCeoSlips(
    [slip(SHA_A, 7_166_000), slip(SHA_A.toUpperCase(), 7_250_000)],
    14_416_000,
  );

  assert.deepEqual(summary.duplicateShas, [SHA_A]);
  assert.equal(summary.status, "match");

  const deduped = dedupeBySha([
    slip(SHA_A, 7_166_000),
    slip(SHA_A, 7_250_000),
    slip(SHA_B, 7_250_000),
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].ocr_amount, 7_166_000);
});

test("an empty slip list is empty", () => {
  const summary = summarizeCeoSlips([], 14_416_000);

  assert.equal(summary.sum, 0);
  assert.equal(summary.unreadCount, 0);
  assert.deepEqual(summary.duplicateShas, []);
  assert.equal(summary.status, "empty");
});

test("rounding is whole đồng", () => {
  const summary = summarizeCeoSlips(
    [slip(SHA_A, 7_166_000.4), slip(SHA_B, 7_250_000.4)],
    14_416_001,
  );

  assert.equal(summary.sum, 14_416_001);
  assert.equal(summary.status, "match");
});

test("a third read slip is included in the sum", () => {
  const summary = summarizeCeoSlips(
    [slip(SHA_A, 7_166_000), slip(SHA_B, 7_250_000), slip(SHA_C, 1)],
    14_416_001,
  );

  assert.equal(summary.sum, 14_416_001);
  assert.deepEqual(summary.duplicateShas, []);
  assert.equal(summary.status, "match");
});
