import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDeliveryChoice,
  resolveDeliveries,
  resolveDeliveriesForChoice,
  type DeliveryContact,
  type DeliveryProfiles,
} from "./delivery.ts";

const q7: DeliveryContact = {
  address: "123 Nguyễn Văn A, Quận 1",
  contactName: "Anh Minh",
  contactPhone: "0909 123 456",
};

const tanTao: DeliveryContact = {
  address: "Kho Tân Tạo, Bình Tân",
  contactName: "Tú Trinh",
  contactPhone: "0911 222 333",
};

const profiles: DeliveryProfiles = { q7, tanTao };

test("all Q7 lines stay in one Q7 block with the catalog fallback", () => {
  const deliveries = resolveDeliveries(
    [
      { name: "Bột mì 999", location: "q7" },
      { name: "Bơ Peerless", location: null },
    ],
    profiles,
    q7,
  );

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].label, "Kho Q7");
  assert.equal(deliveries[0].address, "123 Nguyễn Văn A, Quận 1");
  assert.equal(deliveries[0].contactName, "Anh Minh");
  assert.equal(deliveries[0].contactPhone, "0909 123 456");
  assert.deepEqual(deliveries[0].items, ["Bột mì 999", "Bơ Peerless"]);
});

test("all Tân Tạo lines use the Tân Tạo profile and Tú Trinh", () => {
  const deliveries = resolveDeliveries(
    [
      { name: "Bột mì 888", location: "tan_tao" },
      { name: "Sữa bột", location: "tan_tao" },
    ],
    profiles,
    q7,
  );

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].label, "Kho Tân Tạo");
  assert.equal(deliveries[0].address, "Kho Tân Tạo, Bình Tân");
  assert.equal(deliveries[0].contactName, "Tú Trinh");
  assert.equal(deliveries[0].contactPhone, "0911 222 333");
  assert.deepEqual(deliveries[0].items, ["Bột mì 888", "Sữa bột"]);
});

test("mixed lines produce two blocks with the right items", () => {
  const deliveries = resolveDeliveries(
    [
      { name: "Bột mì 999", location: "q7" },
      { name: "Bột mì 888", location: "tan_tao" },
      { name: "Bơ Peerless", location: "q7" },
      { name: "Sữa bột", location: "tan_tao" },
    ],
    profiles,
    q7,
  );

  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].label, "Kho Q7");
  assert.deepEqual(deliveries[0].items, ["Bột mì 999", "Bơ Peerless"]);
  assert.equal(deliveries[1].label, "Kho Tân Tạo");
  assert.equal(deliveries[1].contactName, "Tú Trinh");
  assert.deepEqual(deliveries[1].items, ["Bột mì 888", "Sữa bột"]);
});

test("a missing Tân Tạo address sends every line to Q7", () => {
  const deliveries = resolveDeliveries(
    [
      { name: "Bột mì 999", location: "q7" },
      { name: "Bột mì 888", location: "tan_tao" },
    ],
    { ...profiles, tanTao: null },
    q7,
  );

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].label, "Kho Q7");
  assert.deepEqual(deliveries[0].items, ["Bột mì 999", "Bột mì 888"]);
});

test("parseDeliveryChoice defaults to auto when delivery is missing", () => {
  assert.deepEqual(parseDeliveryChoice(undefined), { target: "auto" });
  assert.deepEqual(parseDeliveryChoice(null), { target: "auto" });
  assert.deepEqual(parseDeliveryChoice({ target: "auto" }), { target: "auto" });
});

test("parseDeliveryChoice rejects an unknown target or a non-object", () => {
  assert.equal(parseDeliveryChoice({ target: "warehouse_9" }), null);
  assert.equal(parseDeliveryChoice({}), null);
  assert.equal(parseDeliveryChoice("q7"), null);
  assert.equal(parseDeliveryChoice(["q7"]), null);
});

test("parseDeliveryChoice cleans a valid custom address and contact", () => {
  assert.deepEqual(
    parseDeliveryChoice({
      target: "custom",
      address: "  12\n Nguyễn\u0000  Văn A  ",
      contact_name: " Anh\nMinh ",
      contact_phone: " 0909 123 456 ",
    }),
    {
      target: "custom",
      address: "12, Nguyễn Văn A",
      contactName: "Anh, Minh",
      contactPhone: "0909 123 456",
    },
  );
  assert.deepEqual(
    parseDeliveryChoice({
      target: "custom",
      address: "123 Lê Lợi, Quận 1",
      contact_name: "Chị Lan",
      contact_phone: "+84 (909) 123-456",
    }),
    {
      target: "custom",
      address: "123 Lê Lợi, Quận 1",
      contactName: "Chị Lan",
      contactPhone: "+84 (909) 123-456",
    },
  );
});

test("parseDeliveryChoice rejects an invalid custom delivery", () => {
  for (const [name, phone] of [["", "0909 123 456"], ["Anh Minh", ""], ["Anh Minh", "...."], ["Anh Minh", "0909"]]) {
    assert.equal(
      parseDeliveryChoice({ target: "custom", address: "123 Lê Lợi, Quận 1", contact_name: name, contact_phone: phone }),
      null,
      `${name}/${phone}`,
    );
  }
  assert.equal(
    parseDeliveryChoice({
      target: "custom",
      contact_name: "Anh Minh",
      contact_phone: "0909 123 456",
    }),
    null,
  );
  assert.equal(
    parseDeliveryChoice({
      target: "custom",
      address: "1234",
      contact_name: "Anh Minh",
      contact_phone: "0909 123 456",
    }),
    null,
  );
  assert.equal(
    parseDeliveryChoice({
      target: "custom",
      address: `123 ${"Lê Lợi ".repeat(50)}`,
      contact_name: "Anh Minh",
      contact_phone: "0909 123 456",
    }),
    null,
  );
  assert.equal(
    parseDeliveryChoice({
      target: "custom",
      address: "123 Lê Lợi, Quận 1",
      contact_name: "Anh Minh",
      contact_phone: "0909 abc",
    }),
    null,
  );
  assert.equal(
    parseDeliveryChoice({
      target: "custom",
      address: "123 Lê Lợi, Quận 1",
      contact_name: "Anh Minh",
      contact_phone: "0".repeat(41),
    }),
    null,
  );
});

test("resolveDeliveriesForChoice keeps auto identical to resolveDeliveries", () => {
  const lines = [
    { name: "Bột mì 999", location: "q7" },
    { name: "Bột mì 888", location: "tan_tao" },
  ];
  assert.deepEqual(
    resolveDeliveriesForChoice(lines, profiles, q7, { target: "auto" }),
    resolveDeliveries(lines, profiles, q7),
  );
});

test("resolveDeliveriesForChoice q7 gathers every line into one Q7 block", () => {
  const deliveries = resolveDeliveriesForChoice(
    [
      { name: "Bột mì 999", location: "q7" },
      { name: "Bột mì 888", location: "tan_tao" },
      { name: "Bơ Peerless", location: null },
    ],
    profiles,
    q7,
    { target: "q7" },
  );

  assert.ok(Array.isArray(deliveries));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].label, "Kho Q7");
  assert.equal(deliveries[0].address, q7.address);
  assert.deepEqual(deliveries[0].items, ["Bột mì 999", "Bột mì 888", "Bơ Peerless"]);
});

test("resolveDeliveriesForChoice tan_tao gathers every line into the Tân Tạo profile", () => {
  const deliveries = resolveDeliveriesForChoice(
    [
      { name: "Bột mì 999", location: "q7" },
      { name: "Bột mì 888", location: "tan_tao" },
    ],
    profiles,
    q7,
    { target: "tan_tao" },
  );

  assert.ok(Array.isArray(deliveries));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].label, "Kho Tân Tạo");
  assert.equal(deliveries[0].address, tanTao.address);
  assert.equal(deliveries[0].contactName, tanTao.contactName);
  assert.equal(deliveries[0].contactPhone, tanTao.contactPhone);
  assert.deepEqual(deliveries[0].items, ["Bột mì 999", "Bột mì 888"]);
});

test("resolveDeliveriesForChoice tan_tao is unavailable without a profile", () => {
  assert.equal(
    resolveDeliveriesForChoice(
      [{ name: "Bột mì 999", location: "q7" }],
      { ...profiles, tanTao: null },
      q7,
      { target: "tan_tao" },
    ),
    "unavailable",
  );
});

test("resolveDeliveriesForChoice custom uses the entered contact", () => {
  const deliveries = resolveDeliveriesForChoice(
    [
      { name: "Bột mì 999", location: "q7" },
      { name: "Bột mì 888", location: "tan_tao" },
    ],
    profiles,
    q7,
    {
      target: "custom",
      address: "45 Nguyễn Huệ, Quận 1",
      contactName: "Chị Lan",
      contactPhone: "0987 654 321",
    },
  );

  assert.ok(Array.isArray(deliveries));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].label, "Địa chỉ giao");
  assert.equal(deliveries[0].address, "45 Nguyễn Huệ, Quận 1");
  assert.equal(deliveries[0].contactName, "Chị Lan");
  assert.equal(deliveries[0].contactPhone, "0987 654 321");
  assert.deepEqual(deliveries[0].items, ["Bột mì 999", "Bột mì 888"]);
});

test("resolveDeliveriesForChoice returns no blocks for empty lines", () => {
  assert.deepEqual(resolveDeliveriesForChoice([], profiles, q7, { target: "auto" }), []);
  assert.deepEqual(resolveDeliveriesForChoice([], profiles, q7, { target: "q7" }), []);
  assert.deepEqual(
    resolveDeliveriesForChoice([], { ...profiles, tanTao: null }, q7, { target: "tan_tao" }),
    [],
  );
  assert.deepEqual(
    resolveDeliveriesForChoice([], profiles, q7, {
      target: "custom",
      address: "45 Nguyễn Huệ, Quận 1",
      contactName: "Chị Lan",
      contactPhone: "0987 654 321",
    }),
    [],
  );
});
