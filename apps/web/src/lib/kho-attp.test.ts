import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTP_KIND_LABELS,
  ATTP_PROFILE_LABELS,
  ATTP_REQUIRED_KINDS,
  type AttpChecklist,
  type AttpChecklistItem,
  type AttpKind,
  type AttpRequirement,
  type AttpRequirementState,
  filterByState,
  flattenByItem,
  stateCounts,
} from "./kho-attp.ts";

function requirement(
  kind: AttpKind,
  state: AttpRequirementState,
  overrides: Partial<AttpRequirement> = {},
): AttpRequirement {
  return {
    kind,
    state,
    cert_id: null,
    cert_no: null,
    expires_on: null,
    days_left: null,
    shared_count: 0,
    extracted: null,
    expired_cert: null,
    ...overrides,
  };
}

const ITEM_MEAT: AttpChecklistItem = {
  item_id: "item-1",
  item_code: "K001",
  name: "Thịt heo",
  profile: "fresh_meat",
  profile_source: "default",
  manufacturer_id: "m1",
  manufacturer_name: "Công ty Thịt ABC",
  supplier_id: "sup-a",
  supplier_name: "NCC A",
  requirements: [
    requirement("attp_facility", "ok", {
      cert_id: "cert-shared",
      cert_no: "ATTP-1",
      expires_on: "2027-12-31",
      days_left: 400,
      shared_count: 2,
    }),
    requirement("quarantine", "miss", {
      expired_cert: { cert_id: "cert-old", cert_no: "KD-1", expires_on: "2026-01-01" },
    }),
    requirement("product_declaration", "na"),
    requirement("coa", "na"),
  ],
  totals: { ok: 1, warn: 0, wait: 0, miss: 1, total: 2, done: 1, pct: 50 },
};

const ITEM_PRODUCE: AttpChecklistItem = {
  item_id: "item-2",
  item_code: "K002",
  name: "Rau cải",
  profile: "fresh_produce",
  profile_source: "set",
  manufacturer_id: "m1",
  manufacturer_name: "Công ty Thịt ABC",
  supplier_id: "sup-a",
  supplier_name: "NCC A",
  requirements: [
    requirement("attp_facility", "ok", {
      cert_id: "cert-shared",
      cert_no: "ATTP-1",
      expires_on: "2027-12-31",
      days_left: 400,
      shared_count: 2,
    }),
    requirement("product_declaration", "na"),
    requirement("coa", "na"),
    requirement("quarantine", "na"),
  ],
  totals: { ok: 1, warn: 0, wait: 0, miss: 0, total: 1, done: 1, pct: 100 },
};

const ITEM_PACKAGED: AttpChecklistItem = {
  item_id: "item-3",
  item_code: "K003",
  name: "Bánh bao",
  profile: "packaged_food",
  profile_source: "default",
  manufacturer_id: "m2",
  manufacturer_name: "Công ty Bánh XYZ",
  supplier_id: "sup-b",
  supplier_name: "NCC B",
  requirements: [
    requirement("attp_facility", "wait", {
      cert_id: "cert-pending",
      cert_no: "ATTP-P",
      extracted: { holder_name: "Công ty Bánh XYZ", cert_no: "ATTP-P" },
    }),
    requirement("product_declaration", "miss"),
    requirement("coa", "warn", {
      cert_id: "cert-coa",
      cert_no: "COA-1",
      expires_on: "2026-11-10",
      days_left: 17,
    }),
    requirement("quarantine", "na"),
  ],
  totals: { ok: 0, warn: 1, wait: 1, miss: 1, total: 3, done: 1, pct: 33 },
};

function buildChecklist(): AttpChecklist {
  const suppliers = [
    {
      supplier_id: "sup-a",
      name: "NCC A",
      totals: stateCounts([...ITEM_MEAT.requirements, ...ITEM_PRODUCE.requirements]),
      items: [ITEM_MEAT, ITEM_PRODUCE],
    },
    {
      supplier_id: "sup-b",
      name: "NCC B",
      totals: stateCounts([...ITEM_MEAT.requirements, ...ITEM_PACKAGED.requirements]),
      items: [
        { ...ITEM_MEAT, supplier_id: "sup-b", supplier_name: "NCC B" },
        ITEM_PACKAGED,
      ],
    },
  ];

  return {
    generated_at: "2026-10-24T01:00:00.000Z",
    days: 180,
    totals: stateCounts(suppliers.flatMap((supplier) => supplier.items.flatMap((item) => item.requirements))),
    suppliers,
    items_by_item: [ITEM_MEAT, ITEM_PRODUCE, ITEM_PACKAGED],
  };
}

test("required-kind table and labels are the approved ones", () => {
  assert.deepEqual(ATTP_REQUIRED_KINDS, {
    packaged_food: ["attp_facility", "product_declaration", "coa"],
    fresh_meat: ["attp_facility", "quarantine"],
    fresh_produce: ["attp_facility"],
    food_contact_packaging: ["product_declaration", "coa"],
    none: [],
  });
  assert.deepEqual(ATTP_KIND_LABELS, {
    attp_facility: "Giấy chứng nhận cơ sở ATTP",
    product_declaration: "Bản công bố sản phẩm",
    coa: "Phiếu kiểm nghiệm",
    quarantine: "Giấy kiểm dịch",
  });
  assert.deepEqual(ATTP_PROFILE_LABELS, {
    packaged_food: "Thực phẩm đóng gói",
    fresh_meat: "Thịt tươi",
    fresh_produce: "Rau củ tươi",
    food_contact_packaging: "Bao bì tiếp xúc thực phẩm",
    none: "Không cần hồ sơ",
  });
});

test("stateCounts ignores 'na' and computes done/pct", () => {
  assert.deepEqual(stateCounts(ITEM_MEAT.requirements), {
    ok: 1,
    warn: 0,
    wait: 0,
    miss: 1,
    total: 2,
    done: 1,
    pct: 50,
  });
  assert.deepEqual(stateCounts(ITEM_PACKAGED.requirements), {
    ok: 0,
    warn: 1,
    wait: 1,
    miss: 1,
    total: 3,
    done: 1,
    pct: 33,
  });
  assert.deepEqual(stateCounts([requirement("attp_facility", "na")]), {
    ok: 0,
    warn: 0,
    wait: 0,
    miss: 0,
    total: 0,
    done: 0,
    pct: 100,
  });
});

test("the fixture has two suppliers, a shared certificate and a pending certificate", () => {
  const checklist = buildChecklist();
  assert.equal(checklist.suppliers.length, 2);
  assert.equal(checklist.items_by_item.length, 3);
  assert.equal(checklist.suppliers[0].items[0].requirements[0].shared_count, 2);
  assert.equal(checklist.suppliers[1].items[1].requirements[0].state, "wait");
  assert.equal(
    checklist.suppliers[0].items[0].requirements.some((row) => row.state === "na"),
    true,
  );
});

test("filterByState('miss') keeps suppliers that still have miss rows", () => {
  const filtered = filterByState(buildChecklist(), "miss");

  assert.deepEqual(filtered.suppliers.map((supplier) => supplier.supplier_id), ["sup-a", "sup-b"]);
  assert.deepEqual(filtered.suppliers[0].items.map((item) => item.item_id), ["item-1"]);
  assert.deepEqual(
    filtered.suppliers[1].items.map((item) => item.item_id),
    ["item-1", "item-3"],
  );
  assert.equal(
    filtered.suppliers.every((supplier) =>
      supplier.items.every((item) => item.requirements.every((row) => row.state === "miss"))
    ),
    true,
  );
  assert.deepEqual(filtered.totals, {
    ok: 0,
    warn: 0,
    wait: 0,
    miss: 3,
    total: 3,
    done: 0,
    pct: 0,
  });
  assert.deepEqual(filtered.items_by_item.map((item) => item.item_id), ["item-1", "item-3"]);
});

test("filterByState('wait') keeps only the pending rows", () => {
  const filtered = filterByState(buildChecklist(), "wait");

  assert.deepEqual(filtered.suppliers.map((supplier) => supplier.supplier_id), ["sup-b"]);
  assert.deepEqual(filtered.suppliers[0].items.map((item) => item.item_id), ["item-3"]);
  assert.equal(filtered.suppliers[0].items[0].requirements[0].state, "wait");
  assert.equal(filtered.suppliers[0].items[0].requirements[0].extracted?.cert_no, "ATTP-P");
  assert.deepEqual(filtered.totals, {
    ok: 0,
    warn: 0,
    wait: 1,
    miss: 0,
    total: 1,
    done: 0,
    pct: 0,
  });
});

test("filterByState('warn') recomputes pct from the retained warn row", () => {
  const filtered = filterByState(buildChecklist(), "warn");

  assert.deepEqual(filtered.suppliers.map((supplier) => supplier.supplier_id), ["sup-b"]);
  assert.deepEqual(filtered.suppliers[0].items.map((item) => item.item_id), ["item-3"]);
  assert.deepEqual(filtered.totals, {
    ok: 0,
    warn: 1,
    wait: 0,
    miss: 0,
    total: 1,
    done: 1,
    pct: 100,
  });
});

test("filterByState('all') is a no-op", () => {
  const checklist = buildChecklist();
  assert.equal(filterByState(checklist, "all"), checklist);
});

test("flattenByItem de-duplicates an item sold by two suppliers", () => {
  const checklist = buildChecklist();
  assert.deepEqual(
    flattenByItem(checklist).map((item) => item.item_id),
    ["item-1", "item-2", "item-3"],
  );

  const withoutIndex = { ...checklist, items_by_item: [] };
  assert.deepEqual(
    flattenByItem(withoutIndex).map((item) => item.item_id),
    ["item-1", "item-2", "item-3"],
  );
});
