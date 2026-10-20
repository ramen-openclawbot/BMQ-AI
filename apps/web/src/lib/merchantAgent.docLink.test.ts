import assert from "node:assert/strict";
import test from "node:test";
import { parseDocLink } from "./merchantAgent.ts";

const PR_ID = "11111111-1111-4111-8111-111111111111";
const PO_ID = "22222222-2222-4222-8222-222222222222";
const GR_ID = "33333333-3333-4333-8333-333333333333";

test("parseDocLink accepts valid PR, PO and GR payloads", () => {
  const cases = [
    { kind: "pr", prefix: "/payment-requests", id: PR_ID },
    { kind: "po", prefix: "/purchase-orders", id: PO_ID },
    { kind: "gr", prefix: "/goods-receipts", id: GR_ID },
  ] as const;

  for (const { kind, prefix, id } of cases) {
    const payload = {
      kind,
      code: "DOC-001",
      id,
      title: "Phiếu thử",
      path: `${prefix}?id=${id}`,
    };
    assert.deepEqual(parseDocLink(payload), payload);
  }
});

test("parseDocLink rejects a path whose prefix does not match the kind", () => {
  assert.equal(
    parseDocLink({
      kind: "po",
      code: "PO-001",
      id: PO_ID,
      title: "PO thử",
      path: `/payment-requests?id=${PO_ID}`,
    }),
    null,
  );
  assert.equal(
    parseDocLink({
      kind: "po",
      code: "PO-001",
      id: PO_ID,
      title: "PO thử",
      path: `/orders?id=${PO_ID}`,
    }),
    null,
  );
});

test("parseDocLink rejects a non-uuid id", () => {
  assert.equal(
    parseDocLink({
      kind: "gr",
      code: "GR-001",
      id: "not-a-uuid",
      title: "Phiếu nhập thử",
      path: "/goods-receipts?id=not-a-uuid",
    }),
    null,
  );
});

test("parseDocLink rejects javascript: paths and malformed payloads", () => {
  assert.equal(
    parseDocLink({
      kind: "po",
      code: "PO-001",
      id: PO_ID,
      title: "PO thử",
      path: `javascript:alert(1)//?id=${PO_ID}`,
    }),
    null,
  );
  assert.equal(parseDocLink(null), null);
  assert.equal(parseDocLink("doc_link"), null);
  assert.equal(parseDocLink({ kind: "invoice" }), null);
  assert.equal(
    parseDocLink({ kind: "po", code: "PO-001", id: PO_ID, title: "PO thử" }),
    null,
  );
});
