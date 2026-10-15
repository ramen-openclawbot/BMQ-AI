// Offline tests for the robot auto-apply client rules (node:test, no vitest, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isUndoableRobotAutoAction,
  parseRobotAutoAction,
  parseRobotAutoActions,
  parseRobotSettings,
  robotActionsErrorText,
  robotAutoActionLabel,
  ROBOT_SETTINGS_DEFAULTS,
  type RobotAutoAction,
} from "./robot-actions.ts";

function action(overrides: Partial<RobotAutoAction> = {}): RobotAutoAction {
  return {
    id: "a1",
    kind: "alias",
    subject_key: "sup-1|bot mi",
    target: { item_id: "item-1", location: "q7" },
    payload: { raw_name: "Bột mì 888", robot_item_id: "item-1" },
    robot_probability: 0.97,
    status: "applied",
    applied_at: "2026-11-01T00:00:00Z",
    undone_by: null,
    undone_at: null,
    item_name: "Bột mì 999",
    raw_name: "Bột mì 888",
    class_label: null,
    ...overrides,
  };
}

test("parseRobotAutoAction maps the RPC row and nulls malformed optionals", () => {
  const parsed = parseRobotAutoAction({
    id: "a1",
    kind: "alias",
    subject_key: "sup-1|bot mi",
    target: { item_id: "item-1" },
    payload: { raw_name: "Bột mì 888" },
    robot_probability: "0.97",
    status: "applied",
    applied_at: "2026-11-01T00:00:00Z",
    undone_by: null,
    undone_at: null,
    item_name: "Bột mì 999",
    raw_name: "Bột mì 888",
    class_label: null,
  });
  assert.equal(parsed?.robot_probability, 0.97);
  assert.equal(parsed?.raw_name, "Bột mì 888");
  assert.deepEqual(parsed?.target, { item_id: "item-1" });

  assert.equal(parseRobotAutoAction(null), null);
  assert.equal(parseRobotAutoAction({}), null, "an id is required");
  const partial = parseRobotAutoAction({ id: "a2" });
  assert.deepEqual(partial?.target, {});
  assert.equal(partial?.kind, "unknown");
  assert.equal(partial?.robot_probability, null);
});

test("parseRobotAutoActions drops malformed entries and non-arrays", () => {
  assert.deepEqual(parseRobotAutoActions(null), []);
  assert.deepEqual(parseRobotAutoActions({ id: "x" }), []);
  const rows = parseRobotAutoActions([{ id: "a1" }, null, { no_id: true }, { id: "a2" }]);
  assert.deepEqual(rows.map((row) => row.id), ["a1", "a2"]);
});

test("parseRobotSettings applies the documented defaults and clamps", () => {
  assert.deepEqual(parseRobotSettings(null), { ...ROBOT_SETTINGS_DEFAULTS });
  const parsed = parseRobotSettings({
    id: true,
    auto_apply_enabled: false,
    alias_threshold: "0.9",
    class_threshold: 1.4,
    daily_cap: "12.9",
    updated_by: "owner-1",
    updated_at: "2026-11-01T00:00:00Z",
  });
  assert.equal(parsed.auto_apply_enabled, false);
  assert.equal(parsed.alias_threshold, 0.9);
  assert.equal(parsed.class_threshold, ROBOT_SETTINGS_DEFAULTS.class_threshold, "an out-of-range threshold falls back");
  assert.equal(parsed.daily_cap, 12);
  assert.equal(parsed.updated_by, "owner-1");
});

test("readable labels and the undoable flag", () => {
  assert.equal(robotAutoActionLabel(action()), "Bột mì 888 → Bột mì 999");
  assert.equal(
    robotAutoActionLabel(action({ kind: "catalog_class", item_name: "Bơ", class_label: "raw_material" })),
    "Bơ → raw_material",
  );
  assert.equal(isUndoableRobotAutoAction(action()), true);
  assert.equal(isUndoableRobotAutoAction(action({ status: "undone" })), false);
});

test("robotActionsErrorText maps the known permission and lookup errors", () => {
  assert.match(robotActionsErrorText({ message: "not_owner" }), /chủ doanh nghiệp/);
  assert.match(robotActionsErrorText("insufficient_privilege"), /chưa được cấp quyền/);
  assert.match(robotActionsErrorText({ code: "action_not_found" }), /Không tìm thấy/);
  assert.match(robotActionsErrorText(new Error("boom")), /thử lại/);
  assert.match(robotActionsErrorText(null), /thử lại/);
});
