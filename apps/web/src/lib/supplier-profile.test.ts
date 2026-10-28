import assert from "node:assert/strict";
import test from "node:test";

import {
  filterSupplierProfiles,
  normalizeSupplierProfileSearch,
  parseSupplierProfileOverview,
  supplierProfileFilterCounts,
  type SupplierProfileOverview,
} from "./supplier-profile.ts";

function profile(
  overrides: Partial<SupplierProfileOverview> = {},
): SupplierProfileOverview {
  return {
    id: "sup-1",
    name: "Phúc Thịnh",
    email: "phuc@example.test",
    phone: "0909000001",
    contactName: "Anh Phúc",
    address: "Quận 7",
    receivingLocation: "q7",
    paymentTermsDays: 30,
    paymentMethod: "bank_transfer",
    orderItemCount: 3,
    lastPurchaseAt: "2026-10-30",
    active60d: true,
    unpaidCount: 0,
    unpaidAmount: 0,
    missing: [],
    ...overrides,
  };
}

test("parses string numbers and missing fields defensively", () => {
  const [row] = parseSupplierProfileOverview([
    {
      id: "sup-1",
      name: "  Phúc Thịnh  ",
      email: "",
      phone: " 0909000001 ",
      contact_name: null,
      address: null,
      default_receiving_location: "  ",
      payment_terms_days: "30",
      default_payment_method: "bank_transfer",
      order_item_count: "4",
      last_purchase_at: "2026-10-30",
      active_60d: true,
      unpaid_count: "2",
      unpaid_amount: "1500000",
      missing: ["email", "phone", "contact_name", "receiving_location"],
    },
  ]);

  assert.equal(row.id, "sup-1");
  assert.equal(row.name, "Phúc Thịnh");
  assert.equal(row.email, null);
  assert.equal(row.phone, "0909000001");
  assert.equal(row.contactName, null);
  assert.equal(row.address, null);
  assert.equal(row.receivingLocation, null);
  assert.equal(row.paymentTermsDays, 30);
  assert.equal(row.paymentMethod, "bank_transfer");
  assert.equal(row.orderItemCount, 4);
  assert.equal(row.lastPurchaseAt, "2026-10-30");
  assert.equal(row.active60d, true);
  assert.equal(row.unpaidCount, 2);
  assert.equal(row.unpaidAmount, 1_500_000);
  assert.deepEqual(row.missing, [
    "email",
    "phone",
    "contact_name",
    "receiving_location",
  ]);
});

test("parses a row with no optional fields", () => {
  const [row] = parseSupplierProfileOverview([{ id: "sup-2", name: "TV Food" }]);

  assert.equal(row.email, null);
  assert.equal(row.phone, null);
  assert.equal(row.contactName, null);
  assert.equal(row.address, null);
  assert.equal(row.receivingLocation, null);
  assert.equal(row.paymentTermsDays, null);
  assert.equal(row.paymentMethod, null);
  assert.equal(row.orderItemCount, 0);
  assert.equal(row.lastPurchaseAt, null);
  assert.equal(row.active60d, false);
  assert.equal(row.unpaidCount, 0);
  assert.equal(row.unpaidAmount, 0);
  assert.deepEqual(row.missing, [
    "email",
    "phone",
    "contact_name",
    "receiving_location",
  ]);
});

test("parses the wrapper and bare-array shapes", () => {
  const wrapped = parseSupplierProfileOverview({
    suppliers: [profile({ id: "a" }), profile({ id: "b" })],
  });
  assert.equal(wrapped.length, 2);
  assert.deepEqual(wrapped.map((entry) => entry.id), ["a", "b"]);

  const bare = parseSupplierProfileOverview([profile({ id: "c" })]);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].id, "c");

  assert.deepEqual(parseSupplierProfileOverview(null), []);
  assert.deepEqual(parseSupplierProfileOverview({ suppliers: null }), []);
});

test("ignores unknown missing codes", () => {
  const [row] = parseSupplierProfileOverview([
    {
      id: "sup-3",
      name: "Đại Phát",
      missing: ["email", "not_a_field", "phone", 42, "email"],
    },
  ]);

  assert.deepEqual(row.missing, ["email", "phone"]);
});

test("filters by each profile filter", () => {
  const active = profile({
    id: "active",
    name: "Active",
    missing: [],
    unpaidCount: 0,
    unpaidAmount: 0,
  });
  const missingEmail = profile({
    id: "missing-email",
    name: "Missing Email",
    active60d: false,
    missing: ["email"],
    unpaidCount: 1,
    unpaidAmount: 100,
  });
  const missingPhone = profile({
    id: "missing-phone",
    name: "Missing Phone",
    active60d: false,
    missing: ["phone"],
    unpaidCount: 0,
    unpaidAmount: 500,
  });
  const complete = profile({
    id: "complete",
    name: "Complete",
    active60d: false,
    missing: [],
    unpaidCount: 0,
    unpaidAmount: 0,
  });
  const list = [active, missingEmail, missingPhone, complete];

  assert.deepEqual(
    filterSupplierProfiles(list, { filter: "all" }).map((entry) => entry.id),
    ["active", "missing-email", "missing-phone", "complete"],
  );
  assert.deepEqual(
    filterSupplierProfiles(list, { filter: "active_60d" }).map((entry) => entry.id),
    ["active"],
  );
  assert.deepEqual(
    filterSupplierProfiles(list, { filter: "missing_email" }).map((entry) => entry.id),
    ["missing-email"],
  );
  assert.deepEqual(
    filterSupplierProfiles(list, { filter: "incomplete" }).map((entry) => entry.id),
    ["missing-email", "missing-phone"],
  );
  assert.deepEqual(
    filterSupplierProfiles(list, { filter: "unpaid" }).map((entry) => entry.id),
    ["missing-email", "missing-phone"],
  );
});

test("search is diacritic-insensitive, including đ", () => {
  const list = [
    profile({ id: "phuc", name: "Phúc Thịnh" }),
    profile({ id: "dai", name: "Đại Phát", email: "daily@example.test" }),
    profile({ id: "tv", name: "TV Food", contactName: "Chị Hoa" }),
  ];

  assert.deepEqual(
    filterSupplierProfiles(list, { query: "phuc thinh" }).map((entry) => entry.id),
    ["phuc"],
  );
  assert.deepEqual(
    filterSupplierProfiles(list, { query: "Phúc Thịnh" }).map((entry) => entry.id),
    ["phuc"],
  );
  assert.deepEqual(
    filterSupplierProfiles(list, { query: "dai phat" }).map((entry) => entry.id),
    ["dai"],
  );
  assert.deepEqual(
    filterSupplierProfiles(list, { query: "Đại Phát" }).map((entry) => entry.id),
    ["dai"],
  );
  assert.deepEqual(
    filterSupplierProfiles(list, { query: "daily" }).map((entry) => entry.id),
    ["dai"],
  );
  assert.deepEqual(
    filterSupplierProfiles(list, { query: "chi hoa" }).map((entry) => entry.id),
    ["tv"],
  );
  assert.equal(normalizeSupplierProfileSearch("Đại Phát"), "dai phat");
});

test("counts suppliers per filter", () => {
  const list = [
    profile({ id: "a", missing: [], active60d: true }),
    profile({ id: "b", missing: ["email"], active60d: true, unpaidCount: 1 }),
    profile({ id: "c", missing: ["phone"], active60d: false, unpaidAmount: 200 }),
    profile({ id: "d", missing: [], active60d: false }),
  ];

  assert.deepEqual(supplierProfileFilterCounts(list), {
    all: 4,
    active_60d: 2,
    missing_email: 1,
    incomplete: 2,
    unpaid: 2,
  });
  assert.deepEqual(supplierProfileFilterCounts([]), {
    all: 0,
    active_60d: 0,
    missing_email: 0,
    incomplete: 0,
    unpaid: 0,
  });
});

test("unpaidAmount defaults to 0", () => {
  const [row] = parseSupplierProfileOverview([{ id: "sup-4", name: "No Debt" }]);
  assert.equal(row.unpaidAmount, 0);

  const [negative] = parseSupplierProfileOverview([
    { id: "sup-5", name: "Negative", unpaid_amount: "-10" },
  ]);
  assert.equal(negative.unpaidAmount, 0);
});
