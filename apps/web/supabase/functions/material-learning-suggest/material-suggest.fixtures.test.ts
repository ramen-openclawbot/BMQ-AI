// Synthetic labelled tune/holdout matcher checks. No real benchmark, no provider
// call, no fine-tuning and no real business data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchMaterial } from "./material-suggest.ts";
import {
  MATERIAL_SUGGEST_FIXTURE_CLAIM,
  MATERIAL_SUGGEST_FIXTURE_SPLITS,
  MATERIAL_SUGGEST_HOLDOUT_FIXTURES,
  MATERIAL_SUGGEST_TUNE_FIXTURES,
} from "./material-suggest.fixtures.ts";

test("synthetic tune/holdout fixtures keep the deterministic matching contract", () => {
  assert.match(MATERIAL_SUGGEST_FIXTURE_CLAIM, /no real benchmark/);
  assert.match(MATERIAL_SUGGEST_FIXTURE_CLAIM, /no fine-tuning/);
  assert.ok(MATERIAL_SUGGEST_TUNE_FIXTURES.length > 0);
  assert.ok(MATERIAL_SUGGEST_HOLDOUT_FIXTURES.length > 0);

  const ids = [...MATERIAL_SUGGEST_TUNE_FIXTURES, ...MATERIAL_SUGGEST_HOLDOUT_FIXTURES].map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, ids.length, "fixture ids must be unique");

  for (const [split, fixtures] of Object.entries(MATERIAL_SUGGEST_FIXTURE_SPLITS)) {
    for (const fixture of fixtures) {
      assert.equal(fixture.split, split, fixture.id);
      const match = matchMaterial(fixture.input);
      assert.equal(match.kind, fixture.expected.kind, fixture.id);
      assert.equal(match.matched_by, fixture.expected.matched_by, fixture.id);
      assert.equal(match.material_id, fixture.expected.material_id, fixture.id);
    }
  }
});
