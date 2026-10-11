// Offline tests for the new-item review logic: deterministic grouping, the
// bounded parallel Jev run with per-call usage, and the suggested name / unit.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clusterKey,
  makeUnionFind,
  newItemPairScore,
  normalizeSuggestedUnit,
  planSameItemPairs,
  runQuestionsWithQuota,
  sameItemPairKey,
  sharesMeaningfulToken,
  suggestedNameFromMembers,
  suggestedNameFromRaw,
  suggestedUnitFromMembers,
  summarizeMembers,
  tokensMatch,
  validateNewItemJevResponse,
  NEW_ITEM_PROMPT_VERSION,
  type NewItemMember,
} from "./new-items.ts";

test("'tỏi ngày 1' and 'tỏi ngày 15' merge in code without asking Jev", () => {
  const plan = planSameItemPairs(["tỏi ngày 1", "tỏi ngày 15"]);
  assert.equal(plan.autoPairs.length, 1);
  assert.equal(plan.questionPairs.length, 0);
  assert.equal(newItemPairScore("tỏi ngày 1", "tỏi ngày 15"), 1);
});

test("two different names that share a meaningful token need the Jev question", () => {
  const plan = planSameItemPairs(["tỏi bóc vỏ", "tỏi phi"]);
  assert.equal(plan.autoPairs.length, 0);
  assert.equal(plan.questionPairs.length, 1);
  assert.equal(plan.questionPairs[0][0], "tỏi bóc vỏ");
});

test("names with no shared meaningful token are never paired", () => {
  const plan = planSameItemPairs(["gạo tám", "dầu ăn"]);
  assert.deepEqual(plan.autoPairs, []);
  assert.deepEqual(plan.questionPairs, []);
});

test("union-find merges a chain driven by the Jev same_item answers", () => {
  const unionFind = makeUnionFind(["a", "b", "c", "d"]);
  // a~b and b~c are the same item; d stays alone.
  unionFind.union("a", "b");
  unionFind.union("b", "c");
  const groups = unionFind.groups().map((group) => group.join(",")).sort();
  assert.deepEqual(groups, ["a,b,c", "d"]);
});

test("the same-item cache key is order independent", () => {
  assert.equal(sameItemPairKey("b", "a"), sameItemPairKey("a", "b"));
});

test("a cluster key is a stable md5 of the sorted member names", () => {
  const first = clusterKey(["toi", "hanh tim", "toi"]);
  const second = clusterKey(["hanh tim", "toi"]);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{32}$/);
});

test("tokensMatch mirrors the SQL four-character rule", () => {
  assert.equal(tokensMatch("mekovita", "mlekovita"), true);
  assert.equal(tokensMatch("toi", "toi"), true);
  assert.equal(tokensMatch("abc", "abd"), false);
  // sharesMeaningfulToken normalizes the diacritics first.
  assert.equal(sharesMeaningfulToken("sấy", "say"), true);
});

test("no more than four Jev questions are in flight at once", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 12 }, (_value, index) => index);
  const run = await runQuestionsWithQuota<number, number>({
    items,
    remaining: 12,
    ask: async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return item;
    },
  });
  assert.equal(run.asked, 12);
  assert.equal(maxActive, 4);
  assert.equal(run.stopped, false);
});

test("usage is recorded immediately after every Jev answer", async () => {
  const answered: number[] = [];
  const run = await runQuestionsWithQuota<number, number>({
    items: [1, 2, 3],
    remaining: 10,
    ask: async (item) => item * 2,
    onAnswered: (item, result) => {
      answered.push(item);
      assert.equal(result, item * 2);
    },
  });
  assert.deepEqual(answered.sort((left, right) => left - right), [1, 2, 3]);
  assert.equal(run.asked, 3);
});

test("an exhausted daily quota stops before any further question", async () => {
  let asked = 0;
  const run = await runQuestionsWithQuota<number, number>({
    items: [1, 2, 3, 4, 5],
    remaining: 2,
    ask: async (item) => {
      asked += 1;
      return item;
    },
  });
  assert.equal(run.asked, 2);
  assert.equal(asked, 2);
  assert.equal(run.stopped, true);
});

test("suggestedNameFromRaw cleans prefixes, bilingual names and day suffixes", () => {
  assert.equal(suggestedNameFromRaw("Tỏi ngày 15"), "Tỏi");
  assert.equal(
    suggestedNameFromRaw("[Thùng] Sữa Tiệt Trùng Mekovita 3.5% Bélo 1L x 12 Hộp"),
    "Sữa Tiệt Trùng Mekovita 3.5% Bélo 1L x 12 Hộp",
  );
  assert.equal(suggestedNameFromRaw("Chicken egg 60gr/Trứng gà 60g"), "Trứng gà 60g");
  assert.equal(suggestedNameFromRaw("[Carton] Bột mì 888"), "Bột mì 888");
});

test("the suggested name comes from the member with the most receipts", () => {
  const members: NewItemMember[] = [
    { supplier_id: null, normalized_name: "a", raw_name: "Tỏi ngày 1", raw_unit: "kg", receipt_count: 1, last_date: "2026-10-01" },
    { supplier_id: null, normalized_name: "b", raw_name: "Tỏi bóc vỏ", raw_unit: "kg", receipt_count: 5, last_date: "2026-10-02" },
  ];
  assert.equal(suggestedNameFromMembers(members), "Tỏi bóc vỏ");
});

test("units are mapped to the base unit and the common one wins", () => {
  assert.equal(normalizeSuggestedUnit("kg"), "g");
  assert.equal(normalizeSuggestedUnit("gr"), "g");
  assert.equal(normalizeSuggestedUnit("l"), "ml");
  assert.equal(normalizeSuggestedUnit("Hộp"), "Hộp");
  const members: NewItemMember[] = [
    { supplier_id: null, normalized_name: "a", raw_name: "A", raw_unit: "kg", receipt_count: 1, last_date: null },
    { supplier_id: null, normalized_name: "b", raw_name: "B", raw_unit: "kg", receipt_count: 1, last_date: null },
    { supplier_id: null, normalized_name: "c", raw_name: "C", raw_unit: "l", receipt_count: 1, last_date: null },
  ];
  assert.equal(suggestedUnitFromMembers(members), "g");
  assert.equal(suggestedUnitFromMembers([]), null);
});

test("summarizeMembers sums receipts and marks recurring at two or more", () => {
  const once = summarizeMembers([
    { supplier_id: null, normalized_name: "a", raw_name: "Tỏi", raw_unit: "kg", receipt_count: 1, last_date: "2026-10-01", receipt_days: 1, first_date: "2026-10-01" },
  ]);
  assert.equal(once.is_recurring, false);
  assert.equal(once.receipt_count, 1);
  assert.equal(once.suggested_name, "Tỏi");
  const recurring = summarizeMembers([
    { supplier_id: null, normalized_name: "a", raw_name: "Tỏi 1", raw_unit: "kg", receipt_count: 2, last_date: "2026-10-05", receipt_days: 2, first_date: "2026-10-01" },
    { supplier_id: null, normalized_name: "b", raw_name: "Tỏi 2", raw_unit: "g", receipt_count: 1, last_date: "2026-10-07", receipt_days: 1, first_date: "2026-10-07" },
  ]);
  assert.equal(recurring.is_recurring, true);
  assert.equal(recurring.receipt_count, 3);
  assert.equal(recurring.first_date, "2026-10-01");
  assert.equal(recurring.last_date, "2026-10-07");
});

test("the new-item prompt version is pinned", () => {
  assert.equal(NEW_ITEM_PROMPT_VERSION, "jev-new-item-2026-10-21.1");
});

test("validateNewItemJevResponse accepts the 3-class choice and refuses a 4th class", () => {
  const body = {
    model: "typesafe-ai/jev",
    usage: { inputTokens: 10, outputTokens: 5 },
    answers: {
      item_class: {
        type: "choice",
        choice: "packaging_supply",
        probabilities: { raw_material: 0.1, packaging_supply: 0.8, non_stock: 0.1 },
      },
    },
  };
  const parsed = validateNewItemJevResponse("item_class", body);
  assert.equal(parsed.item_class, "packaging_supply");
  assert.equal(parsed.class_probability, 0.8);

  assert.throws(() =>
    validateNewItemJevResponse("item_class", {
      ...body,
      answers: {
        item_class: {
          type: "choice",
          choice: "finished_goods",
          probabilities: { raw_material: 0.1, packaging_supply: 0.1, non_stock: 0.1, finished_goods: 0.7 },
        },
      },
    }),
  );
});

test("code merges only same words without the pack; real 60-day pairs that differ ask Jev", () => {
  const plan = planSameItemPairs([
    "bo peerless", "bo peerless 2.5kg khoi",
    "dairymont white slices cheese", "dairymont white slices cheese 1kg",
    "nhan pate heo 200gr", "nhan pate heo 500gr",
    "ot", "tuong ot 10g", "t. ot goi 10g",
    "bang ke 100 yard", "bang ke 24mm x 120 yard",
  ]);
  const auto = plan.autoPairs.map((pair) => [...pair].sort().join(" = "));
  assert.deepEqual(auto.sort(), [
    "bo peerless = bo peerless 2.5kg khoi",
    "dairymont white slices cheese = dairymont white slices cheese 1kg",
  ]);
  const asked = plan.questionPairs.map((pair) => [...pair].sort().join(" ? "));
  assert.ok(asked.includes("nhan pate heo 200gr ? nhan pate heo 500gr"));
  assert.ok(asked.includes("ot ? tuong ot 10g"));
});
