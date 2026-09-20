// Behavioral tests for the UI request/auth fence and durable-outcome recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRecovery,
  createGenerationFence,
  createSubmitGate,
  outcomeMatchesIntent,
} from "./material-learning-fence.ts";

test("A→B→A stale suggestion response is rejected by the generation fence", () => {
  const fence = createGenerationFence();
  const firstA = fence.next(); // user selects A and requests a suggestion
  fence.next(); // user switches to B
  const secondA = fence.next(); // user switches back to A
  assert.equal(fence.isCurrent(firstA), false, "the stale first-A response must not land");
  assert.equal(fence.isCurrent(secondA), true, "the current A response may land");
});

test("the synchronous submit gate rejects a rapid second click", () => {
  const gate = createSubmitGate();
  assert.equal(gate.tryEnter(), true);
  assert.equal(gate.tryEnter(), false, "a double click must not start a second write");
  gate.exit();
  assert.equal(gate.tryEnter(), true, "after settling the gate is usable again");
});

test("durable outcomes are compared to the exact intended action and material", () => {
  assert.equal(outcomeMatchesIntent({ status: "resolved_existing", resolved_material_id: "m1" }, { action: "resolve_existing", materialId: "m1" }), true);
  assert.equal(outcomeMatchesIntent({ status: "resolved_existing", resolved_material_id: "m2" }, { action: "resolve_existing", materialId: "m1" }), false, "a different material is a conflict, not success");
  assert.equal(outcomeMatchesIntent({ status: "rejected", resolved_material_id: null }, { action: "reject", materialId: "" }), true);
  assert.equal(outcomeMatchesIntent({ status: "resolved_existing", resolved_material_id: "m1" }, { action: "reject", materialId: "" }), false, "a rejected intent must not accept a resolution");
  assert.equal(outcomeMatchesIntent({ status: "created_new", resolved_material_id: "m9" }, { action: "create_new", materialId: "" }), false, "a terminal id without canonical field proof must not be reported as same intent");
  assert.equal(outcomeMatchesIntent(
    { status: "created_new", resolved_material_id: "m9", canonical_name: "NVL mới", default_unit: "kg" },
    { action: "create_new", materialId: "", createFields: { canonical_name: "NVL mới", default_unit: "kg" } },
  ), true, "matching canonical fields confirm the same created intent");
  assert.equal(outcomeMatchesIntent({ status: "created_new", resolved_material_id: null }, { action: "create_new", materialId: "" }), false);
});

test("terminal created_new from a different create payload needs review, never success", () => {
  const intended = { action: "create_new" as const, materialId: "", createFields: { canonical_name: "NVL dự kiến", default_unit: "kg" } };
  const differentName = { status: "created_new", resolved_material_id: "m9", canonical_name: "NVL khác", default_unit: "kg" };
  assert.equal(outcomeMatchesIntent(differentName, intended), false, "a different canonical name is not the same intent");
  assert.equal(classifyRecovery(differentName, intended), "needs-review");
  const differentUnit = { status: "created_new", resolved_material_id: "m9", canonical_name: "NVL dự kiến", default_unit: "thùng" };
  assert.equal(classifyRecovery(differentUnit, intended), "needs-review");
  assert.equal(classifyRecovery({ status: "created_new", resolved_material_id: "m9" }, intended), "needs-review", "missing canonical fields is not provable success");
  assert.equal(classifyRecovery({ status: "created_new", resolved_material_id: "m9", canonical_name: "NVL dự kiến", default_unit: "kg" }, intended), "already-done");
});

test("recovery read failure blocks a blind repeat; terminal mismatches are conflicts", () => {
  const intended = { action: "resolve_existing" as const, materialId: "m1" };
  assert.equal(classifyRecovery(null, intended, true), "blocked");
  assert.equal(classifyRecovery({ status: "pending", resolved_material_id: null }, intended), "retry");
  assert.equal(classifyRecovery({ status: "resolved_existing", resolved_material_id: "m1" }, intended), "already-done");
  assert.equal(classifyRecovery({ status: "resolved_existing", resolved_material_id: "m2" }, intended), "conflict");
  assert.equal(classifyRecovery({ status: "rejected", resolved_material_id: null }, intended), "conflict");
});
