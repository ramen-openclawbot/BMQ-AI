import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aliasSubjectKey,
  aliasSubjectName,
  aliasSubjectSupplier,
  catalogClassSubjectKey,
  catalogMergeSubjectKey,
  debtMarkSubjectKey,
  financeSubjectKey,
  formatAliasCorrection,
  formatClassCorrection,
  formatFinanceCorrection,
  loadRobotFeedback,
  pairSubjectKey,
  pickAliasCorrections,
  rejectedRobotChoices,
  routingSubjectKey,
  type RobotFeedbackRow,
  withCorrections,
} from "./robot-feedback.ts";

function row(partial: Partial<RobotFeedbackRow>): RobotFeedbackRow {
  return {
    id: "f1",
    kind: "alias",
    subject_key: "s1|bot mi",
    robot_choice: "item-a",
    human_choice: "item-b",
    robot_probability: 0.97,
    note: "Bột mì 888",
    created_at: "2026-11-01T00:00:00Z",
    robot_label: "Bột mì 888",
    human_label: "Bột mì 999",
    ...partial,
  };
}

test("subject keys mirror the SQL triggers", () => {
  assert.equal(aliasSubjectKey("s1", "bot mi"), "s1|bot mi");
  assert.equal(aliasSubjectKey(null, "bot mi"), "|bot mi");
  assert.equal(pairSubjectKey("b", "a"), "a:b");
  assert.equal(catalogMergeSubjectKey("b", "a"), "a:b");
  assert.equal(catalogClassSubjectKey("item-1"), "item-1");
  assert.equal(financeSubjectKey("x", "y"), "x:y");
  assert.equal(routingSubjectKey("sup-1"), "sup-1");
  assert.equal(debtMarkSubjectKey("pr-1", null), "pr-1");
  assert.equal(debtMarkSubjectKey(null, "po-1"), "po-1");
  assert.equal(aliasSubjectSupplier("s1|bot mi"), "s1");
  assert.equal(aliasSubjectName("s1|bot mi"), "bot mi");
});

test("rejectedRobotChoices collects only real choices", () => {
  const rejected = rejectedRobotChoices([
    row({ robot_choice: "item-a" }),
    row({ robot_choice: null }),
    row({ robot_choice: "item-c" }),
    row({ robot_choice: "" }),
  ]);
  assert.deepEqual([...rejected].sort(), ["item-a", "item-c"]);
});

test("pickAliasCorrections prefers the same supplier then shared name tokens", () => {
  const rows = [
    row({ id: "other-supplier-shared", subject_key: "s2|bot mi 888", created_at: "2026-11-03T00:00:00Z" }),
    row({ id: "same-supplier-no-shared", subject_key: "s1|duong cat", created_at: "2026-11-02T00:00:00Z" }),
    row({ id: "same-supplier-shared", subject_key: "s1|bot mi 999", created_at: "2026-11-01T00:00:00Z" }),
    row({ id: "other-supplier-no-shared", subject_key: "s3|muoi", created_at: "2026-11-04T00:00:00Z" }),
  ];
  const picked = pickAliasCorrections(rows, { supplierId: "s1", normalizedName: "bot mi 888" }, 3);
  assert.deepEqual(picked.map((entry) => entry.id), [
    "same-supplier-shared",
    "same-supplier-no-shared",
    "other-supplier-shared",
  ]);
});

test("formatAliasCorrection renders the approved wording and falls back to ids", () => {
  assert.equal(
    formatAliasCorrection(row({})),
    "Người duyệt đã sửa trước đây: Bột mì 888 → Bột mì 999 (Bé Mì đã chọn Bột mì 888)",
  );
  assert.equal(
    formatAliasCorrection(row({ note: null, robot_label: null, human_label: null, robot_choice: "r", human_choice: "h" })),
    "Người duyệt đã sửa trước đây: bot mi → h (Bé Mì đã chọn r)",
  );
});

test("withCorrections appends only real lines", () => {
  assert.equal(withCorrections("base", []), "base");
  assert.equal(withCorrections("base", ["", "  "]), "base");
  assert.equal(withCorrections("base", ["line-1", "line-2"]), "base\nline-1\nline-2");
});

test("loadRobotFeedback maps rows and tolerates a failed read", async () => {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const reader = {
    async rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      return {
        data: [{
          id: "f1", kind: "alias", subject_key: "s1|bot mi", robot_choice: "a",
          human_choice: "b", robot_probability: "0.97", note: null, created_at: null,
          robot_label: "A", human_label: "B",
        }],
        error: null,
      };
    },
  };
  const rows = await loadRobotFeedback(reader, "alias", ["s1|bot mi", "s1|bot mi", ""]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { p_kind: "alias", p_keys: ["s1|bot mi"], p_limit: 5 });
  assert.equal(rows[0].robot_probability, 0.97);
  assert.equal(rows[0].subject_key, "s1|bot mi");

  const empty = await loadRobotFeedback(reader, "alias", []);
  assert.deepEqual(empty, []);
  assert.equal(calls.length, 1, "no keys means no RPC call");

  const failing = await loadRobotFeedback(
    { async rpc() { return { data: null, error: { message: "boom" } }; } },
    "alias",
    ["s1|bot mi"],
  );
  assert.deepEqual(failing, []);

  const throwing = await loadRobotFeedback(
    { async rpc() { throw new Error("network"); } },
    "alias",
    ["s1|bot mi"],
  );
  assert.deepEqual(throwing, []);
});

test("class and finance corrections render the human decision explicitly", () => {
  const classRow = row({ kind: "catalog_class", robot_choice: "raw_material", human_choice: "rejected", robot_label: null, human_label: null });
  assert.equal(
    formatClassCorrection(classRow, "Bột mì"),
    "Người duyệt đã sửa trước đây: Bột mì → rejected (Bé Mì đã chọn raw_material)",
  );
  const financeRow = row({ kind: "finance_duplicate", robot_choice: "needs_review", human_choice: "different_purchase" });
  assert.equal(
    formatFinanceCorrection(financeRow, "PC-1", "PC-2"),
    "Người duyệt đã sửa trước đây: PC-1 ↔ PC-2 → hai lần khác nhau (Bé Mì đã chọn needs_review)",
  );
  assert.equal(
    formatFinanceCorrection(row({ human_choice: "same_purchase" }), "PC-1", "PC-2"),
    "Người duyệt đã sửa trước đây: PC-1 ↔ PC-2 → cùng một lần mua (Bé Mì đã chọn item-a)",
  );
});
