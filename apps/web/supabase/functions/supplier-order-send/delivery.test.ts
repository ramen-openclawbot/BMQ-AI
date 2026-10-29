import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDeliveries,
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
