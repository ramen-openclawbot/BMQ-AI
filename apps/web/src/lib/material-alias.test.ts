import assert from "node:assert/strict";
import test from "node:test";

import {
  aliasStatusAfterConfirm,
  autoNonStockReason,
  MATERIAL_ALIAS_ACTION_LABELS,
  MATERIAL_ALIAS_LINE_CLASS_LABELS,
  MATERIAL_ALIAS_SCORE_TEST_CASES,
  MATERIAL_ALIAS_STATUS_LABELS,
  materialAliasActionLabel,
  materialAliasLineClassLabel,
  materialAliasStatusLabel,
  parseCreateStockMaterialItem,
  parseMaterialAliasBacklogReview,
  parseMaterialAliasReview,
  parseStockAliasJevResponse,
  parseSuggestMaterialAliases,
  rankMaterialAliasCandidates,
  scoreCandidate,
  STOCK_LINE_AUTO_NON_STOCK_TEST_CASES,
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

test("autoNonStockReason mirrors the shared SQL case table", () => {
  for (const [name, expected] of STOCK_LINE_AUTO_NON_STOCK_TEST_CASES) {
    assert.equal(autoNonStockReason(name), expected, `autoNonStockReason(${name})`);
  }
  assert.equal(autoNonStockReason("Tỏi phi"), null, "the single token phi must never match");
  assert.equal(autoNonStockReason(null), null);
  assert.equal(autoNonStockReason(""), null);
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
  for (const lineClass of ["stock", "non_stock"] as const) {
    assert.ok(MATERIAL_ALIAS_LINE_CLASS_LABELS[lineClass].length > 0);
    assert.equal(materialAliasLineClassLabel(lineClass), MATERIAL_ALIAS_LINE_CLASS_LABELS[lineClass]);
  }
  assert.equal(materialAliasLineClassLabel(null), "");
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
    auto_non_stock: null,
  },
];

test("parseSuggestMaterialAliases accepts the RPC payload", () => {
  const parsed = parseSuggestMaterialAliases(VALID_SUGGESTIONS);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].line_key, "l1");
  assert.equal(parsed[0].needs_prompt, true);
  assert.equal(parsed[0].candidates[0].score, 0.9);
  assert.equal(parsed[0].pack_guess?.pack_size, 10);
  assert.equal(parsed[0].auto_non_stock, null);
});

test("parseSuggestMaterialAliases accepts both auto_non_stock shapes", () => {
  const rule = parseSuggestMaterialAliases([
    {
      ...VALID_SUGGESTIONS[0],
      needs_prompt: false,
      candidates: [],
      auto_non_stock: { reason: "fee", source: "rule" },
    },
  ]);
  assert.equal(rule[0].auto_non_stock?.reason, "fee");
  assert.equal(rule[0].auto_non_stock?.source, "rule");
  assert.equal(rule[0].auto_non_stock?.probability, undefined);

  const jev = parseSuggestMaterialAliases([
    {
      ...VALID_SUGGESTIONS[0],
      needs_prompt: false,
      auto_non_stock: { reason: "jev", source: "jev", probability: 0.93 },
    },
  ]);
  assert.equal(jev[0].auto_non_stock?.reason, "jev");
  assert.equal(jev[0].auto_non_stock?.probability, 0.93);

  // A missing key is the same as null (older cached payloads).
  const missing = parseSuggestMaterialAliases([{ ...VALID_SUGGESTIONS[0], auto_non_stock: undefined }]);
  assert.equal(missing[0].auto_non_stock, null);

  assert.throws(() =>
    parseSuggestMaterialAliases([
      { ...VALID_SUGGESTIONS[0], auto_non_stock: { reason: "maybe", source: "rule" } },
    ]),
  );
  assert.throws(() =>
    parseSuggestMaterialAliases([
      { ...VALID_SUGGESTIONS[0], auto_non_stock: { reason: "vat", source: "jev" } },
    ]),
  );
});

test("parseSuggestMaterialAliases accepts stock and non_stock line classes", () => {
  const stock = parseSuggestMaterialAliases([
    {
      ...VALID_SUGGESTIONS[0],
      alias: {
        alias_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "auto",
        line_class: "stock",
        item_id: CANDIDATE_ID,
        sku_id: null,
        item_name: "Tỏi bóc vỏ",
        unit: "kg",
        conversion_factor: 1,
        pack_label: null,
        confirm_count: 3,
        confirmers_count: 1,
        jev_disagreed: false,
      },
      needs_prompt: false,
    },
  ]);
  assert.equal(stock[0].alias?.line_class, "stock");

  const nonStock = parseSuggestMaterialAliases([
    {
      ...VALID_SUGGESTIONS[0],
      alias: {
        alias_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "auto",
        line_class: "non_stock",
        item_id: null,
        sku_id: null,
        item_name: null,
        unit: "-",
        conversion_factor: 1,
        pack_label: null,
        confirm_count: 3,
        confirmers_count: 1,
        jev_disagreed: false,
      },
      needs_prompt: false,
    },
  ]);
  assert.equal(nonStock[0].alias?.line_class, "non_stock");
  assert.equal(nonStock[0].needs_prompt, false);

  assert.throws(() =>
    parseSuggestMaterialAliases([
      {
        ...VALID_SUGGESTIONS[0],
        alias: {
          alias_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          status: "auto",
          line_class: "unknown",
          item_id: null,
          sku_id: null,
          item_name: null,
          unit: "-",
          conversion_factor: 1,
          pack_label: null,
          confirm_count: 3,
          confirmers_count: 1,
          jev_disagreed: false,
        },
      },
    ]),
  );
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
      answer: { choice: CANDIDATE_ID, item_id: CANDIDATE_ID, probability: 0.9, line_type: "goods", line_type_probability: 0.95, confidence: 0.8, pack: null },
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
    assert.equal(lines.results[0].answer.line_type, "goods");
    assert.equal(lines.results[0].answer.line_type_probability, 0.95);
    assert.equal(lines.stopped, null);
  }
  const backlog = parseStockAliasJevResponse(VALID_BACKLOG_RESPONSE);
  assert.equal(backlog.mode, "backlog");
  if (backlog.mode === "backlog") assert.equal(backlog.evaluated, 2);
});

test("parseStockAliasJevResponse defaults a missing line_type to null and rejects an invalid one", () => {
  const missing = parseStockAliasJevResponse({
    ...VALID_LINES_RESPONSE,
    results: [{ ...VALID_LINES_RESPONSE.results[0], answer: { ...VALID_LINES_RESPONSE.results[0].answer, line_type: undefined } }],
  });
  if (missing.mode === "lines") assert.equal(missing.results[0].answer.line_type, null);

  assert.throws(() =>
    parseStockAliasJevResponse({
      ...VALID_LINES_RESPONSE,
      results: [{ ...VALID_LINES_RESPONSE.results[0], answer: { ...VALID_LINES_RESPONSE.results[0].answer, line_type: "maybe" } }],
    }),
  );
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
      line_class: "non_stock",
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
  assert.equal(review.aliases[0].line_class, "non_stock");
  assert.equal(review.aliases[0].last_event?.action, "auto_promoted");
  assert.equal(review.summary.pending_lines, 4);
  assert.equal(review.summary.jev_usage.call_limit, 600);
});

test("parseMaterialAliasReview defaults a missing line_class to stock", () => {
  const withoutLineClass = {
    ...VALID_REVIEW,
    aliases: [{ ...VALID_REVIEW.aliases[0], line_class: undefined }],
  };
  assert.equal(parseMaterialAliasReview(withoutLineClass).aliases[0].line_class, "stock");
  assert.throws(() =>
    parseMaterialAliasReview({
      ...VALID_REVIEW,
      aliases: [{ ...VALID_REVIEW.aliases[0], line_class: "maybe" }],
    }),
  );
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

test("parseStockAliasJevResponse reads the per-call source and backlog batch fields", () => {
  const lines = parseStockAliasJevResponse({
    ...VALID_LINES_RESPONSE,
    results: [{
      ...VALID_LINES_RESPONSE.results[0],
      answer: { ...VALID_LINES_RESPONSE.results[0].answer, source: "exact" },
    }],
  });
  assert.equal(lines.mode, "lines");
  if (lines.mode === "lines") assert.equal(lines.results[0].answer.source, "exact");

  const backlog = parseStockAliasJevResponse({
    ...VALID_BACKLOG_RESPONSE,
    processed: 5,
    remaining: 3,
    batch_size: 10,
  });
  assert.equal(backlog.mode, "backlog");
  if (backlog.mode === "backlog") {
    assert.equal(backlog.processed, 5);
    assert.equal(backlog.remaining, 3);
    assert.equal(backlog.batch_size, 10);
  }

  // An older payload without the batch fields still parses.
  const legacy = parseStockAliasJevResponse(VALID_BACKLOG_RESPONSE);
  if (legacy.mode === "backlog") {
    assert.equal(legacy.processed, 2);
    assert.equal(legacy.remaining, 0);
  }
});

test("parseMaterialAliasBacklogReview accepts the RPC payload", () => {
  const rows = parseMaterialAliasBacklogReview([{
    normalized_name: "toi",
    raw_name: "Tỏi ngày 10",
    line_count: 4,
    supplier_id: "44444444-4444-4444-8444-444444444444",
    supplier_name: "NCC A",
    last_receipt_date: "2026-10-15",
    top_candidate: {
      item_id: CANDIDATE_ID,
      sku_id: null,
      name: "Tỏi bóc vỏ",
      unit: "kg",
      score: 0.9,
      reason: "name_contains",
    },
    jev_item_id: CANDIDATE_ID,
    jev_item_name: "Tỏi bóc vỏ",
    jev_unit: "kg",
    jev_probability: 0.93,
    jev_line_type: "goods",
    jev_source: "jev",
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line_count, 4);
  assert.equal(rows[0].top_candidate?.name, "Tỏi bóc vỏ");
  assert.equal(rows[0].jev_probability, 0.93);
  assert.equal(rows[0].jev_line_type, "goods");
  assert.equal(rows[0].jev_source, "jev");

  assert.deepEqual(parseMaterialAliasBacklogReview([]), []);
  const empty = parseMaterialAliasBacklogReview([{
    normalized_name: "gao",
    raw_name: "Gạo",
    line_count: 1,
    supplier_id: null,
    supplier_name: null,
    last_receipt_date: null,
    top_candidate: null,
    jev_item_id: null,
    jev_item_name: null,
    jev_unit: null,
    jev_probability: null,
    jev_line_type: null,
    jev_source: null,
  }]);
  assert.equal(empty[0].top_candidate, null);
  assert.equal(empty[0].jev_line_type, null);

  assert.throws(() => parseMaterialAliasBacklogReview(null));
  assert.throws(() => parseMaterialAliasBacklogReview([{ normalized_name: "x" }]));
});

test("parseCreateStockMaterialItem accepts created and reused items", () => {
  assert.deepEqual(parseCreateStockMaterialItem({ item_id: CANDIDATE_ID, created: true }), {
    item_id: CANDIDATE_ID,
    created: true,
  });
  assert.deepEqual(parseCreateStockMaterialItem({ item_id: CANDIDATE_ID, created: false }), {
    item_id: CANDIDATE_ID,
    created: false,
  });
  assert.throws(() => parseCreateStockMaterialItem(null));
  assert.throws(() => parseCreateStockMaterialItem({ item_id: CANDIDATE_ID, created: "yes" }));
});
