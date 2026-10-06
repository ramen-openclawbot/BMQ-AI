import assert from "node:assert/strict";
import test from "node:test";

import { dosageInputText, parseDosageGramInput } from "./dosage-input.ts";

test("comma is the decimal mark", () => {
  assert.equal(parseDosageGramInput("0,033"), 0.033);
  assert.equal(parseDosageGramInput("2,234"), 2.234);
  assert.equal(parseDosageGramInput("1.234,5"), 1234.5);
});

test("whole grams and dot thousands stay as before", () => {
  assert.equal(parseDosageGramInput("2234"), 2234);
  assert.equal(parseDosageGramInput("2.234"), 2234);
  assert.equal(parseDosageGramInput("1.234.567"), 1234567);
  assert.equal(parseDosageGramInput("500"), 500);
});

test("a dot that cannot be thousands grouping is a decimal (phone keypad)", () => {
  assert.equal(parseDosageGramInput("0.033"), 0.033);
  assert.equal(parseDosageGramInput("0.5"), 0.5);
  assert.equal(parseDosageGramInput("2.5"), 2.5);
  assert.equal(parseDosageGramInput("12.34"), 12.34);
});

test("empty and invalid input use the fallback", () => {
  assert.equal(parseDosageGramInput("", 7), 7);
  assert.equal(parseDosageGramInput("   ", 7), 7);
  assert.equal(parseDosageGramInput("abc", 7), 7);
  assert.equal(parseDosageGramInput(null, 7), 7);
  assert.equal(parseDosageGramInput(12.5), 12.5);
});

test("typing 0,033 key by key keeps every keystroke", () => {
  let quantity = 0;
  let shown = "";
  for (const typed of ["0", "0,", "0,0", "0,03", "0,033"]) {
    quantity = typed === "" ? 0 : parseDosageGramInput(typed, 0);
    shown = dosageInputText(typed, quantity);
    assert.equal(shown, typed, `keystroke ${typed}`);
  }
  assert.equal(quantity, 0.033);
});

test("typing 0.033 with a dot keeps the text and stores 0.033 g", () => {
  const quantity = parseDosageGramInput("0.033", 0);
  assert.equal(quantity, 0.033);
  assert.equal(dosageInputText("0.033", quantity), "0.033");
});

test("falls back to the stored quantity when the typed text is stale", () => {
  assert.equal(dosageInputText("5", 0.033), "0,033");
  assert.equal(dosageInputText(undefined, 0.033), "0,033");
  assert.equal(dosageInputText(undefined, 0), "");
  assert.equal(dosageInputText("", 0), "");
  assert.equal(dosageInputText(undefined, 250), "250");
});
