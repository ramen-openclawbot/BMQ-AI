import assert from "node:assert/strict";
import test from "node:test";

import {
  KHO_AUDIT_KINDS,
  khoAuditKindLabel,
  parseKhoAuditPage,
  type KhoAuditPage,
} from "./kho-audit.ts";

function fullPayload(): KhoAuditPage {
  return {
    items: [
      {
        key: "audit:1",
        occurred_at: "2026-10-27T08:15:00.123456+00:00",
        actor_id: "00000000-0000-0000-0000-000000000001",
        actor_name: "Nguyễn Văn A",
        kind: "renamed",
        location: null,
        item_id: "00000000-0000-0000-0000-000000000010",
        item_name: "Bột mì 888",
        summary: "Đổi tên: Bột mì 88 → Bột mì 888",
        details: {
          name: { old: "Bột mì 88", new: "Bột mì 888" },
          action: "renamed",
          source: "app",
        },
      },
      {
        key: "tan_tao:2",
        occurred_at: "2026-10-27T07:00:00+00:00",
        actor_id: null,
        actor_name: null,
        kind: "receipt",
        location: "tan_tao",
        item_id: "00000000-0000-0000-0000-000000000010",
        item_name: "Bột mì 888",
        summary: "Nhập kho Tân Tạo 25 g",
        details: { quantity: 25, unit: "g", source: "goods_receipt" },
      },
    ],
    has_more: false,
  };
}

test("parseKhoAuditPage accepts the full payload", () => {
  assert.deepEqual(parseKhoAuditPage(fullPayload()), fullPayload());
});

test("parseKhoAuditPage keeps details as an object and drops unknown fields", () => {
  const payload = fullPayload();
  const withExtra = {
    ...payload,
    extra: "ignored",
    items: payload.items.map((row) => ({ ...row, unexpected: 1 })),
  };
  const parsed = parseKhoAuditPage(withExtra);
  assert.deepEqual(parsed, payload);
  assert.equal(typeof parsed.items[0].details, "object");
  assert.ok(!Array.isArray(parsed.items[0].details));
  assert.equal("unexpected" in parsed.items[0], false);
});

test("parseKhoAuditPage rejects a bad root shape", () => {
  assert.throws(() => parseKhoAuditPage(null), TypeError);
  assert.throws(() => parseKhoAuditPage([]), TypeError);
  assert.throws(() => parseKhoAuditPage({}), TypeError);
  assert.throws(
    () => parseKhoAuditPage({ ...fullPayload(), items: "nope" }),
    TypeError,
  );
  assert.throws(
    () => parseKhoAuditPage({ ...fullPayload(), has_more: "false" }),
    TypeError,
  );
});

test("parseKhoAuditPage rejects a missing field or a wrong type", () => {
  const base = fullPayload();
  const row = base.items[0];

  const missingKey = { ...row } as Record<string, unknown>;
  delete missingKey.key;
  assert.throws(
    () => parseKhoAuditPage({ ...base, items: [missingKey] }),
    TypeError,
  );

  const missingSummary = { ...row } as Record<string, unknown>;
  delete missingSummary.summary;
  assert.throws(
    () => parseKhoAuditPage({ ...base, items: [missingSummary] }),
    TypeError,
  );

  assert.throws(
    () =>
      parseKhoAuditPage({
        ...base,
        items: [{ ...row, occurred_at: 123 }],
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseKhoAuditPage({
        ...base,
        items: [{ ...row, occurred_at: "not-a-date" }],
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseKhoAuditPage({
        ...base,
        items: [{ ...row, details: null }],
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseKhoAuditPage({
        ...base,
        items: [{ ...row, details: [] }],
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseKhoAuditPage({
        ...base,
        items: [{ ...row, location: "kho-khac" }],
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseKhoAuditPage({
        ...base,
        items: [{ ...row, kind: "khong-biet" }],
      }),
    TypeError,
  );
});

test("parseKhoAuditPage accepts null actor/item and every known kind", () => {
  const base = fullPayload();
  const rows = KHO_AUDIT_KINDS.map((kind, index) => ({
    ...base.items[0],
    kind,
    actor_id: null,
    actor_name: null,
    item_id: null,
    item_name: null,
    location: index % 3 === 0 ? "tan_tao" : index % 3 === 1 ? "q7" : null,
  }));
  const parsed = parseKhoAuditPage({ items: rows, has_more: true });
  assert.equal(parsed.items.length, KHO_AUDIT_KINDS.length);
  assert.equal(parsed.has_more, true);
  assert.equal(parsed.items[0].actor_id, null);
  assert.equal(parsed.items[0].item_id, null);
});

test("khoAuditKindLabel returns a Vietnamese label for every kind", () => {
  for (const kind of KHO_AUDIT_KINDS) {
    const label = khoAuditKindLabel(kind);
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0, `empty label for ${kind}`);
  }
  assert.equal(khoAuditKindLabel("renamed"), "Đổi tên");
  assert.equal(khoAuditKindLabel("stock_count"), "Kiểm kê");
  assert.equal(khoAuditKindLabel("production_use"), "Dùng sản xuất");
});
