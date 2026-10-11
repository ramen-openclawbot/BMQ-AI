import assert from "node:assert/strict";
import test from "node:test";

import {
  aliasStatusAfterConfirm,
  MATERIAL_ALIAS_ACTION_LABELS,
  MATERIAL_ALIAS_SCORE_TEST_CASES,
  MATERIAL_ALIAS_STATUS_LABELS,
  materialAliasActionLabel,
  materialAliasStatusLabel,
  parseMaterialAliasReview,
  parseStockAliasJevResponse,
  parseSuggestMaterialAliases,
  rankMaterialAliasCandidates,
  scoreCandidate,
} from "./material-alias.ts";

test("an alias is auto only after three confirms", () => {
  assert.equal(aliasStatusAfterConfirm(1, 1), "learning");
  assert.equal(aliasStatusAfterConfirm(2, 1), "learning");
  assert.equal(aliasStatusAfterConfirm(3, 1), "auto");
  assert.equal(aliasStatusAfterConfirm(4, 1), "auto");
});

test("two distinct confirmers auto-promote even below three confirms", () => {
  assert.equal(aliasStatusAfterConfirm(2, 2), "auto");
  assert.equal(aliasStatusAfterConfirm(1, 2), "auto");
  assert.equal(aliasStatusAfterConfirm(2, 1), "learning");
});

test("scoreCandidate mirrors the shared SQL test-case table", () => {
  for (const [raw, candidate, expected] of MATERIAL_ALIAS_SCORE_TEST_CASES) {
    assert.equal(scoreCandidate(raw, candidate), expected, `scoreCandidate(${raw}, ${candidate})`);
  }
  assert.equal(scoreCandidate("Tỏi ngày 10", "Tỏi bóc vỏ"), scoreCandidate("Tỏi ngày 10", "Tỏi phi"));
});

test("'tỏi ngày 10' ranks 'Tỏi bóc vỏ' above 'Tỏi phi'", () => {
  const ranked = rankMaterialAliasCandidates("tỏi ngày 10", [
    { id: "phi", name: "Tỏi phi" },
    { id: "boc", name: "Tỏi bóc vỏ" },
  ]);
  assert.equal(ranked[0].candidate.id, "boc");
  assert.equal(ranked[0].score, 0.9);
  assert.equal(ranked[1].score, 0.9);
});

test("Vietnamese labels cover every status and action", () => {
  for (const status of ["learning", "auto", "disabled"] as const) {
    assert.ok(MATERIAL_ALIAS_STATUS_LABELS[status].length > 0);
    assert.equal(materialAliasStatusLabel(status), MATERIAL_ALIAS_STATUS_LABELS[status]);
  }
  assert.equal(materialAliasStatusLabel(null), "");
  for (const action of ["confirm", "correct", "undo", "auto_promoted", "disabled"] as const) {
    assert.ok(MATERIAL_ALIAS_ACTION_LABELS[action].length > 0);
    assert.equal(materialAliasActionLabel(action), MATERIAL_ALIAS_ACTION_LABELS[action]);
  }
});

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";

const VALID_SUGGESTIONS = [
  {
    line_key: "l1",
    normalized_name: "toi",
    alias: null,
    needs_prompt: true,
    candidates: [
      { id: CANDIDATE_ID, item_id: CANDIDATE_ID, sku_id: null, name: "Tỏi bóc vỏ", unit: "kg", score: 0.9, reason: "name_contains" },
    ],
    candidates_hash: CANDIDATE_ID,
    jev: null,
    pack_guess: { pack_size: 10, pack_label: "10", base_qty: 10, base_unit: null, multiplier: 1 },
  },
];

test("parseSuggestMaterialAliases accepts the RPC payload", () => {
  const parsed = parseSuggestMaterialAliases(VALID_SUGGESTIONS);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].line_key, "l1");
  assert.equal(parsed[0].needs_prompt, true);
  assert.equal(parsed[0].candidates[0].score, 0.9);
  assert.equal(parsed[0].pack_guess?.pack_size, 10);
});

test("parseSuggestMaterialAliases rejects malformed payloads", () => {
  assert.throws(() => parseSuggestMaterialAliases(null));
  assert.throws(() => parseSuggestMaterialAliases({}));
  assert.throws(() => parseSuggestMaterialAliases([{ ...VALID_SUGGESTIONS[0], needs_prompt: "yes" }]));
  assert.throws(() => parseSuggestMaterialAliases([{ ...VALID_SUGGESTIONS[0], candidates: "nope" }]));
  assert.throws(() =>
    parseSuggestMaterialAliases([{ ...VALID_SUGGESTIONS[0], candidates: [{ ...VALID_SUGGESTIONS[0].candidates[0], score: 2 }] }]),
  );
});

const VALID_LINES_RESPONSE = {
  mode: "lines",
  results: [
    {
      line_key: "l1",
      normalized_name: "toi",
      candidates_hash: CANDIDATE_ID,
      cached: false,
      answer: { choice: CANDIDATE_ID, item_id: CANDIDATE_ID, probability: 0.9, confidence: 0.8, pack: null },
    },
  ],
  calls: 1,
  cost: 0.001,
  cached: 0,
  failed: 0,
  usage: { date: "2026-10-16", calls: 1, limit: 600 },
  stopped: null,
};

const VALID_BACKLOG_RESPONSE = {
  mode: "backlog",
  candidates: 3,
  evaluated: 2,
  skipped_existing: 1,
  failed: 0,
  calls: 2,
  cost: 0.002,
  usage: { date: "2026-10-16", calls: 2, limit: 600 },
  stopped: null,
};

test("parseStockAliasJevResponse accepts lines and backlog payloads", () => {
  const lines = parseStockAliasJevResponse(VALID_LINES_RESPONSE);
  assert.equal(lines.mode, "lines");
  if (lines.mode === "lines") {
    assert.equal(lines.results[0].answer.choice, CANDIDATE_ID);
    assert.equal(lines.stopped, null);
  }
  const backlog = parseStockAliasJevResponse(VALID_BACKLOG_RESPONSE);
  assert.equal(backlog.mode, "backlog");
  if (backlog.mode === "backlog") assert.equal(backlog.evaluated, 2);
});

test("parseStockAliasJevResponse rejects malformed payloads", () => {
  assert.throws(() => parseStockAliasJevResponse(null));
  assert.throws(() => parseStockAliasJevResponse({ mode: "delete" }));
  assert.throws(() => parseStockAliasJevResponse({ ...VALID_LINES_RESPONSE, results: "nope" }));
  assert.throws(() =>
    parseStockAliasJevResponse({
      ...VALID_LINES_RESPONSE,
      results: [{ ...VALID_LINES_RESPONSE.results[0], cached: "yes" }],
    }),
  );
  assert.throws(() => parseStockAliasJevResponse({ ...VALID_BACKLOG_RESPONSE, stopped: "later" }));
});

const VALID_REVIEW = {
  days: 7,
  aliases: [
    {
      alias_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      normalized_name: "toi",
      supplier_id: null,
      supplier_name: "NCC A",
      location: "q7",
      item_id: CANDIDATE_ID,
      sku_id: null,
      item_name: "Tỏi bóc vỏ",
      unit: "kg",
      conversion_factor: 1,
      pack_label: "10kg",
      status: "auto",
      confirm_count: 3,
      confirmers_count: 1,
      jev_disagreed: false,
      last_confirmed_at: "2026-10-16T00:00:00.000Z",
      last_event: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", action: "auto_promoted", actor_id: null, created_at: "2026-10-16T00:00:00.000Z" },
      applied_lines: 2,
    },
  ],
  summary: {
    auto_count: 1,
    learning_count: 0,
    disabled_count: 0,
    pending_lines: 4,
    jev_usage: { usage_date: "2026-10-16", calls: 6, cost: 0.006, call_limit: 600 },
  },
};

test("parseMaterialAliasReview accepts the RPC payload", () => {
  const review = parseMaterialAliasReview(VALID_REVIEW);
  assert.equal(review.aliases.length, 1);
  assert.equal(review.aliases[0].status, "auto");
  assert.equal(review.aliases[0].last_event?.action, "auto_promoted");
  assert.equal(review.summary.pending_lines, 4);
  assert.equal(review.summary.jev_usage.call_limit, 600);
});

test("parseMaterialAliasReview rejects malformed payloads", () => {
  assert.throws(() => parseMaterialAliasReview(null));
  assert.throws(() => parseMaterialAliasReview({}));
  assert.throws(() => parseMaterialAliasReview({ ...VALID_REVIEW, aliases: "nope" }));
  assert.throws(() =>
    parseMaterialAliasReview({
      ...VALID_REVIEW,
      aliases: [{ ...VALID_REVIEW.aliases[0], status: "unknown" }],
    }),
  );
  assert.throws(() =>
    parseMaterialAliasReview({
      ...VALID_REVIEW,
      aliases: [{ ...VALID_REVIEW.aliases[0], last_event: { action: "nope", actor_id: null, created_at: "x" } }],
    }),
  );
  assert.throws(() =>
    parseMaterialAliasReview({
      ...VALID_REVIEW,
      summary: { ...VALID_REVIEW.summary, jev_usage: { usage_date: "2026-10-16" } },
    }),
  );
});
