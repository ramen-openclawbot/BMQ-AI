import assert from "node:assert/strict";
import test from "node:test";

import {
  conversionSentence,
  factorFromSentence,
  parseKhoAddUnitResult,
  parseKhoConversionPreview,
  parseKhoItemConversions,
  parseKhoSetConversionResult,
  parseKhoUnits,
  type KhoItemConversions,
} from "./kho-units.ts";

const unitsPayload = [
  { code: "g", label: "g", kind: "weight", base_code: "g", to_base: 1 },
  { code: "ml", label: "ml", kind: "volume", base_code: "ml", to_base: 1 },
  { code: "cây", label: "cây", kind: "count", base_code: "cây", to_base: 1 },
];

function conversionsPayload(): KhoItemConversions {
  return {
    item: { id: "item-1", name: "Băng keo lớn", unit: "cuộn", in_q7: false },
    can_edit: true,
    cutover: { tan_tao: "2026-01-01", q7: null },
    conversions: [
      {
        unit: "cây",
        factors: [6, 12],
        disagree: true,
        auto: false,
        alias_count: 3,
        supplier_names: ["Nhà cung cấp A"],
        line_count: 4,
        posted_count: 2,
        last_receipt_date: "2026-10-01",
      },
    ],
    saved: [{ unit: "cây", factor: 6, updated_at: "2026-10-22T00:00:00+00:00" }],
  };
}

const previewPayload = {
  status: "preview",
  aliases: 3,
  lines: [
    {
      receipt_number: "PN-001",
      receipt_date: "2026-10-01",
      location: "tan_tao",
      posted_qty: 48,
      new_qty: 96,
      delta: 48,
    },
  ],
  total_delta: { tan_tao: 48, q7: 0 },
};

test("parseKhoUnits accepts the server array", () => {
  const units = parseKhoUnits(unitsPayload);
  assert.equal(units.length, 3);
  assert.deepEqual(units[0], {
    code: "g",
    label: "g",
    kind: "weight",
    base_code: "g",
    to_base: 1,
  });
});

test("parseKhoUnits rejects a bad shape", () => {
  assert.throws(() => parseKhoUnits(null), TypeError);
  assert.throws(() => parseKhoUnits({}), TypeError);
  assert.throws(
    () => parseKhoUnits([{ ...unitsPayload[0], kind: "pack" }]),
    TypeError,
  );
  assert.throws(
    () => parseKhoUnits([{ ...unitsPayload[0], to_base: Number.NaN }]),
    TypeError,
  );
  assert.throws(() => parseKhoUnits([{ ...unitsPayload[0], code: 1 }]), TypeError);
});

test("parseKhoItemConversions accepts the full payload", () => {
  const data = parseKhoItemConversions(conversionsPayload());
  assert.equal(data.item.name, "Băng keo lớn");
  assert.equal(data.cutover.tan_tao, "2026-01-01");
  assert.equal(data.cutover.q7, null);
  assert.deepEqual(data.conversions[0].factors, [6, 12]);
  assert.equal(data.conversions[0].posted_count, 2);
  assert.equal(data.saved[0].factor, 6);
});

test("parseKhoItemConversions rejects a bad shape", () => {
  assert.throws(() => parseKhoItemConversions(null), TypeError);
  assert.throws(() => parseKhoItemConversions({}), TypeError);

  const missingItem = conversionsPayload() as unknown as Record<string, unknown>;
  delete missingItem.item;
  assert.throws(() => parseKhoItemConversions(missingItem), TypeError);

  const badBoolean = conversionsPayload();
  (badBoolean as unknown as Record<string, unknown>).can_edit = "yes";
  assert.throws(() => parseKhoItemConversions(badBoolean), TypeError);

  const badFactors = conversionsPayload();
  (badFactors.conversions[0] as unknown as Record<string, unknown>).factors = 6;
  assert.throws(() => parseKhoItemConversions(badFactors), TypeError);

  const badLineCount = conversionsPayload();
  badLineCount.conversions[0].line_count = Number.NaN;
  assert.throws(() => parseKhoItemConversions(badLineCount), TypeError);
});

test("parseKhoConversionPreview accepts and rejects", () => {
  const preview = parseKhoConversionPreview(previewPayload);
  assert.equal(preview.status, "preview");
  assert.equal(preview.lines[0].location, "tan_tao");
  assert.equal(preview.total_delta.tan_tao, 48);

  assert.throws(() => parseKhoConversionPreview(null), TypeError);
  assert.throws(
    () => parseKhoConversionPreview({ ...previewPayload, status: "saved" }),
    TypeError,
  );
  assert.throws(
    () =>
      parseKhoConversionPreview({
        ...previewPayload,
        lines: [{ ...previewPayload.lines[0], location: "kho" }],
      }),
    TypeError,
  );
});

test("parseKhoSetConversionResult accepts saved and saved_only", () => {
  const result = parseKhoSetConversionResult({
    status: "saved",
    aliases_updated: 2,
    lines: 3,
    total_delta: { tan_tao: 0, q7: 6 },
  });
  assert.equal(result.aliases_updated, 2);
  assert.equal(result.total_delta.q7, 6);

  assert.equal(
    parseKhoSetConversionResult({
      status: "saved_only",
      aliases_updated: 0,
      lines: 0,
      total_delta: { tan_tao: 0, q7: 0 },
    }).status,
    "saved_only",
  );

  assert.throws(
    () =>
      parseKhoSetConversionResult({
        status: "preview",
        aliases_updated: 0,
        lines: 0,
        total_delta: { tan_tao: 0, q7: 0 },
      }),
    TypeError,
  );
});

test("parseKhoAddUnitResult accepts created and exists", () => {
  assert.deepEqual(parseKhoAddUnitResult({ status: "created", unit: "băng keo" }), {
    status: "created",
    unit: "băng keo",
  });
  assert.deepEqual(parseKhoAddUnitResult({ status: "exists", unit: "cuộn" }), {
    status: "exists",
    unit: "cuộn",
  });
  assert.throws(() => parseKhoAddUnitResult({ status: "created" }), TypeError);
  assert.throws(() => parseKhoAddUnitResult({ status: "other", unit: "x" }), TypeError);
});

test("conversionSentence shows the bigger unit first", () => {
  // Băng keo lớn: item counted in cuộn, receipts written in cây.
  assert.equal(conversionSentence("cuộn", 0.083333, "cây"), "1 cây = 12 cuộn");
  assert.equal(conversionSentence("cây", 6, "cuộn"), "1 cây = 6 cuộn");
  assert.equal(conversionSentence("cuộn", 1 / 6, "cây"), "1 cây = 6 cuộn");
});

test("conversionSentence rounds to 3 decimals and snaps near-integers", () => {
  assert.equal(conversionSentence("cuộn", 0.142857, "cây"), "1 cây = 7 cuộn");
  assert.equal(conversionSentence("cuộn", 1 / 11.9999, "cây"), "1 cây = 12 cuộn");
  assert.equal(conversionSentence("cuộn", 1 / 3, "cây"), "1 cây = 3 cuộn");
  assert.equal(conversionSentence("cuộn", 0.35, "cây"), "1 cây = 2.857 cuộn");
});

test("factorFromSentence converts an edited sentence back", () => {
  assert.equal(factorFromSentence("cây", 1, "cuộn", 6, "cây"), 1 / 6);
  assert.equal(factorFromSentence("cây", 1, "cuộn", 12, "cây"), 1 / 12);
  assert.equal(factorFromSentence("cây", 6, "cuộn", 1, "cây"), 6);
  assert.equal(factorFromSentence("CÂY", 1, "Cuộn", 8, " cây "), 1 / 8);
});

test("factorFromSentence round-trips conversionSentence", () => {
  for (const factor of [1 / 12, 1 / 6, 1, 6, 12]) {
    const sentence = conversionSentence("cuộn", factor, "cây");
    const [, leftQty, leftUnit, rightQty, rightUnit] =
      /^([\d.]+) (\S+) = ([\d.]+) (\S+)$/.exec(sentence) ?? [];
    assert.equal(
      factorFromSentence(leftUnit, Number(leftQty), rightUnit, Number(rightQty), "cây"),
      factor,
    );
  }
});

test("conversionSentence rejects zero, negative, NaN and empty units", () => {
  for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => conversionSentence("cuộn", factor, "cây"), RangeError);
  }
  assert.throws(() => conversionSentence("", 6, "cây"), TypeError);
  assert.throws(() => conversionSentence("cuộn", 6, ""), TypeError);
});

test("factorFromSentence rejects zero, negative, NaN and a missing stock side", () => {
  for (const [leftQty, rightQty] of [
    [0, 6],
    [-1, 6],
    [1, 0],
    [1, -6],
    [Number.NaN, 6],
    [1, Number.POSITIVE_INFINITY],
  ]) {
    assert.throws(
      () => factorFromSentence("cây", leftQty, "cuộn", rightQty, "cây"),
      RangeError,
    );
  }
  assert.throws(() => factorFromSentence("cuộn", 1, "cây", 6, "thùng"), TypeError);
});
