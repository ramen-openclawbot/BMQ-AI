// Node tests for the missions / badges / levels data layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  levelProgress,
  missionErrorMessage,
  parseCompleteMissionResult,
  parseMarkItemsDistinctResult,
  parseMissionDetailEntry,
  parseMissionLevel,
  parseMyMissions,
  parseResolveUnknownUnitResult,
  parseUpdateAliasFactorResult,
  type MissionLevel,
} from "./missions.ts";

const LEVELS: MissionLevel[] = [
  { level: 1, title: "Tập sự", min_badges: 0 },
  { level: 2, title: "Thợ kho", min_badges: 3 },
  { level: 3, title: "Thợ lành nghề", min_badges: 7 },
  { level: 4, title: "Thợ cả", min_badges: 12 },
  { level: 5, title: "Quản kho", min_badges: 20 },
];

test("levelProgress walks the real mission levels", () => {
  const start = levelProgress(0, LEVELS);
  assert.equal(start.current?.level, 1);
  assert.equal(start.next?.title, "Thợ kho");
  assert.equal(start.pct, 0);

  const half = levelProgress(2, LEVELS);
  assert.equal(half.current?.level, 1);
  assert.equal(half.next?.level, 2);
  assert.equal(half.pct, 67);

  const reached = levelProgress(3, LEVELS);
  assert.equal(reached.current?.level, 2);
  assert.equal(reached.next?.level, 3);
  assert.equal(reached.pct, 0);

  const top = levelProgress(25, LEVELS);
  assert.equal(top.current?.level, 5);
  assert.equal(top.next, null);
  assert.equal(top.pct, 100);

  // A badges summary works as well as a bare number.
  const summary = levelProgress({ total: 4, by_code: { cham_chi: 4 } }, LEVELS);
  assert.equal(summary.current?.level, 2);
  assert.equal(summary.next?.level, 3);
  assert.equal(summary.pct, 25);
});

test("levelProgress copes with an empty or missing level table", () => {
  assert.deepEqual(levelProgress(3, []), { current: null, next: null, pct: 100 });
  assert.deepEqual(levelProgress(null, null), { current: null, next: null, pct: 100 });
});

test("parseMissionDetailEntry tags each rule shape", () => {
  const alias = parseMissionDetailEntry({
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    name: "pho mai lat trang brinayr",
    unit: "g",
    factor: 1,
    item_name: "Phô mai 84 lát trắng Dairymont",
    item_unit: "g",
    fixed: false,
  });
  assert.equal(alias.kind, "alias_factor_fixed");
  assert.equal(alias.factor, 1);
  assert.equal(alias.fixed, false);

  const duplicate = parseMissionDetailEntry({
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    code: "CCDC-019",
    name: "Hộp Croissant thường",
    unit: "hộp",
    active: true,
    on_hand: 0,
    alias_count: 2,
  });
  assert.equal(duplicate.kind, "duplicate_resolved");
  assert.equal(duplicate.alias_count, 2);

  const unknown = parseMissionDetailEntry({
    unit: "PACK",
    line_count: 4,
    example_name: "Bột mì",
    source_table: "goods_receipt_items",
  });
  assert.equal(unknown.kind, "unknown_units_cleared");
  assert.equal(unknown.line_count, 4);

  assert.throws(() => parseMissionDetailEntry(null), TypeError);
});

test("parseMissionLevel requires level, title and min_badges", () => {
  assert.deepEqual(parseMissionLevel({ level: 2, title: "Thợ kho", min_badges: 3 }), {
    level: 2,
    title: "Thợ kho",
    min_badges: 3,
  });
  assert.throws(() => parseMissionLevel({ level: 2 }), TypeError);
});

function validMissions(): Record<string, unknown> {
  return {
    missions: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        code: "wh-fix-alias-factors",
        title: "Sửa 2 bí danh sai hệ số",
        description: "Mở Bảng bí danh và lưu hệ số đúng.",
        area: "warehouse",
        status: "open",
        sort_order: 1,
        badge: { code: "cham_chi", name: "Chăm chỉ", icon: "🐝" },
        completed_at: null,
        progress: {
          done: false,
          total: 2,
          left: 1,
          detail: [
            {
              id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              name: "pho mai lat trang brinayr",
              unit: "g",
              factor: 1,
              item_name: "Phô mai 84 lát trắng Dairymont",
              item_unit: "g",
              fixed: true,
            },
            {
              id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              name: "mekovita i-love-milk full cream 1l - combo 3 thung",
              unit: "ml",
              factor: 1000,
              item_name: "Sữa Mlekovita",
              item_unit: "ml",
              fixed: false,
            },
          ],
        },
      },
    ],
    badges: { total: 0, by_code: {} },
    level: { level: 1, title: "Tập sự", min_badges: 0 },
    next_level: { level: 2, title: "Thợ kho", min_badges: 3 },
    recent_awards: [],
  };
}

test("parseMyMissions reads the full payload", () => {
  const parsed = parseMyMissions(validMissions());
  assert.equal(parsed.missions.length, 1);
  assert.equal(parsed.missions[0].code, "wh-fix-alias-factors");
  assert.equal(parsed.missions[0].badge?.icon, "🐝");
  assert.equal(parsed.missions[0].progress.left, 1);
  assert.equal(parsed.missions[0].progress.detail[0].kind, "alias_factor_fixed");
  assert.equal(parsed.badges.total, 0);
  assert.deepEqual(parsed.badges.by_code, {});
  assert.equal(parsed.level?.level, 1);
  assert.equal(parsed.next_level?.title, "Thợ kho");
  assert.deepEqual(parsed.recent_awards, []);
});

test("parseMyMissions rejects malformed payloads", () => {
  assert.throws(() => parseMyMissions(null), TypeError);
  const badStatus = validMissions();
  (badStatus.missions as Record<string, unknown>[])[0].status = "paused";
  assert.throws(() => parseMyMissions(badStatus), TypeError);
  const badTotal = validMissions();
  (badTotal.badges as Record<string, unknown>).total = "none";
  assert.throws(() => parseMyMissions(badTotal), TypeError);
  const badDetail = validMissions();
  (badDetail.missions as Record<string, unknown>[])[0].progress = {
    done: false,
    total: 1,
    left: 1,
    detail: [{ fixed: "yes" }],
  };
  assert.throws(() => parseMyMissions(badDetail), TypeError);
});

test("parseCompleteMissionResult keeps nullable levels", () => {
  const result = parseCompleteMissionResult({
    mission_id: "11111111-1111-1111-1111-111111111111",
    badge: { code: "cham_chi", name: "Chăm chỉ", icon: "🐝" },
    badges_total: 3,
    level_before: { level: 1, title: "Tập sự", min_badges: 0 },
    level_after: { level: 2, title: "Thợ kho", min_badges: 3 },
    leveled_up: true,
  });
  assert.equal(result.badges_total, 3);
  assert.equal(result.level_after?.title, "Thợ kho");
  assert.equal(result.leveled_up, true);
  assert.throws(() => parseCompleteMissionResult({ mission_id: "x" }), TypeError);
});

test("parsers handle the small admin RPC results", () => {
  assert.deepEqual(
    parseUpdateAliasFactorResult({ alias_id: "a", old_factor: 1000, new_factor: 2 }),
    { alias_id: "a", old_factor: 1000, new_factor: 2 },
  );
  assert.deepEqual(parseMarkItemsDistinctResult({ item_a: "a", item_b: "b" }), {
    item_a: "a",
    item_b: "b",
  });
  assert.deepEqual(
    parseResolveUnknownUnitResult({ variant: "pack", action: "map", code: "thùng" }),
    { variant: "pack", action: "map", code: "thùng" },
  );
  assert.throws(
    () => parseResolveUnknownUnitResult({ variant: "pack", action: "whatever", code: null }),
    TypeError,
  );
});

test("missionErrorMessage maps the server errors to Vietnamese", () => {
  assert.equal(
    missionErrorMessage({ message: "mission_not_done", code: "P0001", details: "2" }),
    "Nhiệm vụ chưa xong — còn 2 việc",
  );
  assert.equal(
    missionErrorMessage({ message: "mission_not_done", code: "P0001" }),
    "Nhiệm vụ chưa xong",
  );
  assert.equal(missionErrorMessage({ message: "forbidden", code: "42501" }), "Bạn không có quyền thực hiện thao tác này");
  assert.equal(
    missionErrorMessage({ message: "unknown_unit_code", code: "22023" }),
    "Đơn vị không hợp lệ hoặc không xác định",
  );
  assert.equal(missionErrorMessage({ message: "invalid_factor", code: "22023" }), "Hệ số quy đổi không hợp lệ");
  assert.equal(missionErrorMessage({ message: "items_must_differ", code: "22023" }), "Hai mặt hàng phải khác nhau");
  assert.equal(missionErrorMessage("mất kết nối"), "mất kết nối");
  assert.equal(missionErrorMessage(null), "Có lỗi xảy ra");
});

test("the Maestro QA fixture matches the parsers", () => {
  const raw = readFileSync(
    new URL("../../scripts/qa_missions.fixture.json", import.meta.url),
    "utf8",
  );
  const fixture = JSON.parse(raw) as Record<string, unknown>;

  const threeOpen = parseMyMissions(fixture.three_open_partial);
  assert.equal(threeOpen.missions.length, 3);
  assert.equal(threeOpen.missions.filter((mission) => mission.status === "open").length, 3);
  assert.equal(threeOpen.badges.total, 0);

  const twoDone = parseMyMissions(fixture.two_done_two_badges);
  assert.equal(twoDone.missions.length, 3);
  assert.equal(twoDone.missions.filter((mission) => mission.status === "completed").length, 2);
  assert.equal(twoDone.missions.filter((mission) => mission.status === "open").length, 1);
  assert.equal(twoDone.badges.total, 2);
  assert.equal(levelProgress(twoDone.badges, LEVELS).current?.level, 1);
});
