import assert from "node:assert/strict";
import test from "node:test";

import {
  needsBankSlips,
  normalizePayMethod,
  salaryPayMethodLabel,
} from "./salary-pay-method.ts";

test("normalizePayMethod keeps the database value unc", () => {
  assert.equal(normalizePayMethod("unc"), "unc");
});

test("normalizePayMethod treats cash as cash", () => {
  assert.equal(normalizePayMethod("cash"), "cash");
});

test("normalizePayMethod treats a missing value as cash", () => {
  assert.equal(normalizePayMethod(undefined), "cash");
  assert.equal(normalizePayMethod(null), "cash");
});

test("normalizePayMethod is case-sensitive like the database value", () => {
  assert.equal(normalizePayMethod("UNC"), "cash");
  assert.equal(normalizePayMethod("Unc"), "cash");
});

test("normalizePayMethod treats garbage as cash", () => {
  assert.equal(normalizePayMethod("transfer"), "cash");
  assert.equal(normalizePayMethod(42), "cash");
  assert.equal(normalizePayMethod({}), "cash");
});

test("salaryPayMethodLabel labels both methods in Vietnamese", () => {
  assert.equal(salaryPayMethodLabel("cash"), "Tiền mặt");
  assert.equal(salaryPayMethodLabel("unc"), "UNC");
});

test("needsBankSlips is true only for cash", () => {
  assert.equal(needsBankSlips("cash"), true);
  assert.equal(needsBankSlips("unc"), false);
});
