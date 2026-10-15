import { test } from "node:test";
import assert from "node:assert/strict";

import {
  autoNonStockReason,
  candidateIdFromChoice,
  candidatesHash,
  createJevCircuit,
  createJevEvaluator,
  isPackagingLabelName,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_PROMPT_VERSION,
  JevError,
  LINE_TYPE_GOODS,
  LINE_TYPE_NON_GOODS,
  lineTypeCriteria,
  lineTypeInstructions,
  lineTypeOptions,
  matchCriteria,
  matchInstructions,
  matchOptionKey,
  matchOptions,
  NONE_OPTION,
  normalizeItemName,
  PACK_PARSE_TEST_CASES,
  parsePackFromName,
  STOCK_LINE_AUTO_NON_STOCK_TEST_CASES,
  validateJevResponse,
  type MaterialAliasCandidate,
} from "./jev.ts";
import { createMaterialAliasHandler } from "./handler.ts";

const CANDIDATES: MaterialAliasCandidate[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Tỏi bóc vỏ", unit: "kg" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Tỏi phi", unit: "kg" },
];
const KEY_A = matchOptionKey(0);
const KEY_B = matchOptionKey(1);
const ALLOWED = matchOptions(CANDIDATES);

const GOODS_ANSWER = {
  type: "choice",
  choice: LINE_TYPE_GOODS,
  probabilities: { [LINE_TYPE_GOODS]: 0.85, [LINE_TYPE_NON_GOODS]: 0.15 },
  confidence: 0.8,
};

function answersWith(match: unknown, lineType: unknown = GOODS_ANSWER): Record<string, unknown> {
  return { match, line_type: lineType };
}

function validMatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: JEV_MODEL,
    answers: answersWith({
      type: "choice",
      choice: KEY_A,
      probabilities: { [KEY_A]: 0.86, [KEY_B]: 0.1, [NONE_OPTION]: 0.04 },
      confidence: 0.8,
    }),
    usage: { inputTokens: 100, outputTokens: 20 },
    providerMetadata: { gateway: { cost: "0.00012" } },
    ...overrides,
  };
}

function fetchFake(handler: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

test("validates the match choice and maps none to null", () => {
  const evaluation = validateJevResponse(ALLOWED, validMatch());
  assert.equal(evaluation.choice, KEY_A);
  assert.equal(evaluation.probability, 0.86);
  assert.equal(evaluation.lineType, LINE_TYPE_GOODS);
  assert.equal(evaluation.lineTypeProbability, 0.85);
  assert.equal(evaluation.confidence, 0.8);
  assert.equal(evaluation.cost, 0.00012);

  const none = validMatch({
    answers: answersWith({
      type: "choice",
      choice: NONE_OPTION,
      probabilities: { [KEY_A]: 0.05, [KEY_B]: 0.05, [NONE_OPTION]: 0.9 },
    }),
  });
  assert.equal(validateJevResponse(ALLOWED, none).choice, null);
});

test("the choice keys are c1..cN and map back to the candidate ids", () => {
  assert.deepEqual(matchOptions(CANDIDATES), ["c1", "c2", NONE_OPTION]);
  assert.deepEqual(Object.keys(matchCriteria(CANDIDATES)).sort(), ["c1", "c2", NONE_OPTION].sort());
  assert.equal(candidateIdFromChoice(CANDIDATES, "c1"), CANDIDATES[0].id);
  assert.equal(candidateIdFromChoice(CANDIDATES, "c2"), CANDIDATES[1].id);
  assert.equal(candidateIdFromChoice(CANDIDATES, NONE_OPTION), null);
  assert.equal(candidateIdFromChoice(CANDIDATES, null), null);
  assert.equal(candidateIdFromChoice(CANDIDATES, "c99"), null);
});

test("validates the line_type choice and requires both answers", () => {
  const nonGoods = validMatch({
    answers: answersWith(
      {
        type: "choice",
        choice: KEY_A,
        probabilities: { [KEY_A]: 0.7, [KEY_B]: 0.2, [NONE_OPTION]: 0.1 },
      },
      {
        type: "choice",
        choice: LINE_TYPE_NON_GOODS,
        probabilities: { [LINE_TYPE_GOODS]: 0.1, [LINE_TYPE_NON_GOODS]: 0.9 },
      },
    ),
  });
  const evaluation = validateJevResponse(ALLOWED, nonGoods);
  assert.equal(evaluation.lineType, LINE_TYPE_NON_GOODS);
  assert.equal(evaluation.lineTypeProbability, 0.9);

  // Missing line_type answer.
  assert.throws(
    () => validateJevResponse(ALLOWED, validMatch({ answers: { match: (validMatch().answers as Record<string, unknown>).match } })),
    JevError,
  );
  // Unknown line_type option.
  assert.throws(
    () => validateJevResponse(ALLOWED, validMatch({
      answers: answersWith((validMatch().answers as Record<string, unknown>).match, {
        type: "choice",
        choice: "maybe",
        probabilities: { [LINE_TYPE_GOODS]: 0.5, [LINE_TYPE_NON_GOODS]: 0.5 },
      }),
    })),
    JevError,
  );
  // Tied line_type distribution.
  assert.throws(
    () => validateJevResponse(ALLOWED, validMatch({
      answers: answersWith((validMatch().answers as Record<string, unknown>).match, {
        type: "choice",
        choice: LINE_TYPE_GOODS,
        probabilities: { [LINE_TYPE_GOODS]: 0.5, [LINE_TYPE_NON_GOODS]: 0.5 },
      }),
    })),
    JevError,
  );
  // Extra answer key.
  assert.throws(
    () => validateJevResponse(ALLOWED, validMatch({
      answers: {
        ...answersWith((validMatch().answers as Record<string, unknown>).match),
        extra: GOODS_ANSWER,
      },
    })),
    JevError,
  );
});

test("the match prompt is Vietnamese, describes every candidate and always offers none", () => {
  assert.ok(matchInstructions().includes("candidates"));
  const criteria = matchCriteria(CANDIDATES);
  assert.deepEqual(Object.keys(criteria).sort(), [...ALLOWED].sort());
  assert.ok(criteria[NONE_OPTION].length > 5);
  CANDIDATES.forEach((candidate, index) => {
    assert.ok(criteria[matchOptionKey(index)].includes(candidate.name));
    assert.ok(criteria[matchOptionKey(index)].includes(candidate.unit));
  });
});

test("the prompt version is bumped for the whole-catalog backlog", () => {
  assert.equal(JEV_PROMPT_VERSION, "jev-material-alias-2026-11-01.2");
});

test("the match prompt asks to choose by meaning and reserves none for no fit", () => {
  const text = matchInstructions();
  assert.ok(text.includes("ý nghĩa"), "must ask Jev to choose by meaning");
  assert.ok(text.includes("dịch"), "must mention translation");
  assert.ok(text.includes("viết tắt"), "must mention abbreviations");
  assert.ok(text.includes("OCR"), "must mention OCR damage");
  assert.ok(text.includes("`none`"), "must keep the none option explicit");
});

test("a choice list well above five options still validates strictly", () => {
  const many: MaterialAliasCandidate[] = Array.from({ length: 120 }, (_, index) => ({
    id: `item-${index}`,
    name: `Mặt hàng ${index}`,
    unit: "kg",
  }));
  const allowed = matchOptions(many);
  assert.equal(allowed.length, 121);
  assert.equal(matchCriteria(many)[matchOptionKey(119)], "[NVL] Mặt hàng 119 (kg)");
  const chosen = matchOptionKey(60);
  const probabilities: Record<string, number> = {};
  for (const option of allowed) probabilities[option] = option === chosen ? 0.5 : 0.5 / 120;
  const body = {
    model: JEV_MODEL,
    answers: answersWith({
      type: "choice",
      choice: chosen,
      probabilities,
      confidence: 0.7,
    }),
    usage: { inputTokens: 1000, outputTokens: 50 },
    providerMetadata: { gateway: { cost: "0.0002" } },
  };
  const evaluation = validateJevResponse(allowed, body);
  assert.equal(evaluation.choice, chosen);
  assert.equal(candidateIdFromChoice(many, chosen), many[60].id);

  // One missing probability is still refused.
  const missing: Record<string, number> = { ...probabilities };
  delete missing[allowed[10]];
  assert.throws(
    () => validateJevResponse(allowed, {
      ...body,
      answers: answersWith({ type: "choice", choice: chosen, probabilities: missing }),
    }),
    JevError,
  );
});

test("the line_type prompt is Vietnamese and offers exactly goods and non_goods", () => {
  const criteria = lineTypeCriteria();
  assert.deepEqual(lineTypeOptions().sort(), [LINE_TYPE_GOODS, LINE_TYPE_NON_GOODS].sort());
  assert.deepEqual(Object.keys(criteria).sort(), [LINE_TYPE_GOODS, LINE_TYPE_NON_GOODS].sort());
  assert.ok(lineTypeInstructions().includes("nhập kho"));
  assert.ok(lineTypeInstructions().includes("không nhập kho"));
  assert.ok(criteria[LINE_TYPE_GOODS].includes("phải nhập kho"));
  assert.ok(criteria[LINE_TYPE_NON_GOODS].includes("VAT"));
  assert.ok(criteria[LINE_TYPE_NON_GOODS].includes("không nhập kho"));
});

test("refuses an unknown or tied option, a bad distribution and a missing none option", () => {
  const unknown = validMatch({
    answers: answersWith({
      type: "choice",
      choice: "33333333-3333-4333-8333-333333333333",
      probabilities: { [KEY_A]: 0.5, [KEY_B]: 0.3, [NONE_OPTION]: 0.2 },
    }),
  });
  assert.throws(() => validateJevResponse(ALLOWED, unknown), JevError);

  const tied = validMatch({
    answers: answersWith({
      type: "choice",
      choice: KEY_A,
      probabilities: { [KEY_A]: 0.5, [KEY_B]: 0.5, [NONE_OPTION]: 0.0 },
    }),
  });
  assert.throws(() => validateJevResponse(ALLOWED, tied), JevError);

  const badSum = validMatch({
    answers: answersWith({
      type: "choice",
      choice: KEY_A,
      probabilities: { [KEY_A]: 0.8, [KEY_B]: 0.7, [NONE_OPTION]: 0.1 },
    }),
  });
  assert.throws(() => validateJevResponse(ALLOWED, badSum), JevError);

  assert.throws(() => validateJevResponse([CANDIDATES[0].id, CANDIDATES[1].id], validMatch()), JevError);
});

test("autoNonStockReason mirrors the shared SQL case table", () => {
  for (const [name, expected] of STOCK_LINE_AUTO_NON_STOCK_TEST_CASES) {
    assert.equal(autoNonStockReason(name), expected, `autoNonStockReason(${name})`);
  }
  assert.equal(autoNonStockReason("Tỏi phi"), null, "the single token phi must never match");
  assert.equal(autoNonStockReason(null), null);
  assert.equal(autoNonStockReason(""), null);
});

test("pack reading mirrors q7_pack_from_name cases", () => {
  for (const [name, baseQty, baseUnit, multiplier] of PACK_PARSE_TEST_CASES) {
    const parsed = parsePackFromName(name);
    assert.ok(parsed, `parse ${name}`);
    assert.equal(parsed?.baseQty, baseQty);
    assert.equal(parsed?.baseUnit, baseUnit);
    assert.equal(parsed?.multiplier, multiplier);
  }
  assert.equal(parsePackFromName(""), null);
});

test("normalizes names and hashes candidate sets like the SQL", () => {
  assert.equal(normalizeItemName("Tỏi ngày 10"), "toi");
  assert.equal(normalizeItemName("Chả lụa lá TVP XL (kg)"), "cha lua la tvp xl");
  assert.equal(candidatesHash(["b", "a", "a"]), "a|b");
  assert.equal(candidatesHash([]), "");
});

test("isPackagingLabelName matches only a leading Nhãn / Tem / Decal / Nắp / Giấy decal", () => {
  for (const name of ["Nhãn Patê Heo 200gr", "Tem 17k", "Tem pháp", "Decal PVC 90x60", "Nắp cua croissant"]) {
    assert.equal(isPackagingLabelName(name), true, name);
  }
  for (const name of ["Pate 200g", "Bánh mì que Pate", "Bột nhãn"]) {
    assert.equal(isPackagingLabelName(name), false, name);
  }
  assert.equal(isPackagingLabelName(""), false, "the empty name is never a label");
  assert.equal(isPackagingLabelName(null), false, "null is never a label");
  assert.equal(isPackagingLabelName(undefined), false, "undefined is never a label");
  // Machine-misread "Nhân" (filling) and corrected "Nhãn" (label) both normalize
  // to "nhan pate heo 200gr"; only the label reading counts, so the uncorrected
  // name stays a filling until stock_name_corrections fixes it (handler.test.ts).
  assert.equal(normalizeItemName("Nhân Patê Heo 200gr"), "nhan pate heo 200gr");
  assert.equal(isPackagingLabelName("Nhân Patê Heo 200gr"), false);
  assert.equal(isPackagingLabelName("Nhãn Patê Heo 200gr"), true);
  assert.equal(isPackagingLabelName("Nhan pate heo 200gr"), true, "a plain unaccented nhan is a label");
});

test("an empty api key fails closed and the request shape is pinned", async () => {
  assert.throws(() => createJevEvaluator({ apiKey: "" }), JevError);

  let seenBody: Record<string, unknown> = {};
  const evaluator = createJevEvaluator({
    apiKey: "server-key",
    fetcher: fetchFake(async (init) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(validMatch()), { status: 200 });
    }),
  });
  const evaluation = await evaluator({
    state: { line: { name: "Tỏi ngày 10", unit: "kg", supplier: "NCC A" }, candidates: CANDIDATES },
    signal: new AbortController().signal,
  });
  assert.equal(evaluation.choice, CANDIDATES[0].id);
  assert.equal(seenBody.model, JEV_MODEL);
  const questions = seenBody.questions as Record<string, unknown>;
  assert.deepEqual(Object.keys(questions).sort(), ["line_type", "match"]);
  assert.equal((questions.line_type as Record<string, unknown>).type, "choice");
  assert.deepEqual(
    Object.keys((questions.match as Record<string, unknown>).criteria as Record<string, unknown>).sort(),
    ["c1", "c2", NONE_OPTION].sort(),
  );
  const gateway = (seenBody.providerOptions as Record<string, Record<string, unknown>>).gateway;
  assert.equal(gateway.zeroDataRetention, true);
  assert.deepEqual(gateway.only, ["typesafe-ai"]);
  assert.equal(JEV_ENDPOINT, "https://ai-gateway.vercel.sh/v1/evaluate");
});

test("maps a 429 and a malformed body without retrying", async () => {
  let calls = 0;
  const rateLimited = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => {
      calls += 1;
      return new Response("slow down", { status: 429 });
    }),
  });
  await assert.rejects(
    () => rateLimited({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_rate_limited" && error.status === 429,
  );
  assert.equal(calls, 1, "a 429 must not be retried");

  const malformed = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => new Response("not json", { status: 200 })),
  });
  await assert.rejects(
    () => malformed({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_invalid_response",
  );
});

test("a stalled provider is a timeout and an expired deadline never calls it", async () => {
  const hanging = createJevEvaluator({
    apiKey: "k",
    timeoutMs: 20,
    fetcher: fetchFake((init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })),
  });
  await assert.rejects(
    () => hanging({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_timeout",
  );

  let calls = 0;
  const evaluator = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => { calls += 1; return new Response(JSON.stringify(validMatch()), { status: 200 }); }),
  });
  await assert.rejects(
    () => evaluator({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal, deadlineAt: Date.now() - 1 }),
    (error: unknown) => error instanceof JevError && error.code === "jev_deadline_exceeded",
  );
  assert.equal(calls, 0);
});

test("the circuit opens after three consecutive provider failures", async () => {
  const circuit = createJevCircuit();
  let calls = 0;
  const evaluator = createJevEvaluator({
    apiKey: "k",
    circuit,
    fetcher: fetchFake(async () => { calls += 1; return new Response("boom", { status: 500 }); }),
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      () => evaluator({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
      (error: unknown) => error instanceof JevError && error.code === "jev_http_error",
    );
  }
  assert.equal(circuit.isOpen(), true);
  await assert.rejects(
    () => evaluator({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_circuit_open",
  );
  assert.equal(calls, 3, "the open circuit must not call the provider again");
});

test("the kill switch refuses the ranking before any provider call", async () => {
  let calls = 0;
  const handler = createMaterialAliasHandler({
    killSwitch: () => true,
    evaluator: () => async () => { calls += 1; return { choice: null, probability: 0, lineType: LINE_TYPE_GOODS, lineTypeProbability: 1, confidence: null, usage: { input: 0, output: 0 }, cost: null }; },
    authenticate: async () => ({ userId: "owner-1", q7Editor: true }),
    getCache: async () => null,
    putCache: async () => {},
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 0, cost: 0, call_limit: 600 }),
    recordUsage: async () => {},
    listBacklog: async () => [],
    candidatesFor: async () => [],
    audit: () => {},
  });
  const response = await handler(new Request("https://edge.test/stock-alias-jev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "lines", supplier_id: null, location: "q7", lines: [{ line_key: "l1", raw_name: "Tỏi ngày 10", candidates: CANDIDATES }] }),
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "disabled");
  assert.equal(calls, 0);
});

test("past human corrections are appended to the match question text", () => {
  const line = "Người duyệt đã sửa trước đây: Bột mì 888 → Bột mì 999 (Bé Mì đã chọn Bột mì 888)";
  const text = matchInstructions({ corrections: [line] });
  assert.ok(text.includes("candidates"), "the base question is preserved");
  assert.ok(text.includes(line), "the correction line is included");
  assert.equal(matchInstructions({ corrections: [] }), matchInstructions());
});
