import assert from "node:assert/strict";
import test from "node:test";

import {
  clearDealerLocation,
  DealerLocationError,
  type DealerLocationRpcClient,
  listDealerLocations,
  parseCoordinateInput,
  pinDealerLocation,
  setDealerLocation,
} from "./dealer-location.ts";

type RecordedCall = { fn: string; args?: Record<string, unknown> };

function createFakeClient(
  responder: (
    fn: string,
    args?: Record<string, unknown>,
  ) => { data: unknown; error: { message?: string } | null },
): { client: DealerLocationRpcClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: DealerLocationRpcClient = {
    async rpc<T>(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      return responder(fn, args) as {
        data: T | null;
        error: { message?: string } | null;
      };
    },
  };
  return { client, calls };
}

test("pastes a comma-separated coordinate pair", () => {
  assert.deepEqual(parseCoordinateInput("10.7769, 106.7009"), {
    lat: 10.7769,
    lng: 106.7009,
    source: "pasted_coordinates",
  });
});

test("pastes a space-separated coordinate pair", () => {
  assert.deepEqual(parseCoordinateInput("10.7769 106.7009"), {
    lat: 10.7769,
    lng: 106.7009,
    source: "pasted_coordinates",
  });
});

test("reads the @lat,lng of a Google Maps place link", () => {
  assert.deepEqual(
    parseCoordinateInput(
      "https://www.google.com/maps/place/BMQ/@10.7769,106.7009,17z/data=!4m2!3m1",
    ),
    { lat: 10.7769, lng: 106.7009, source: "maps_link" },
  );
});

test("reads ?q=lat,lng from a Google Maps link", () => {
  assert.deepEqual(
    parseCoordinateInput("https://maps.google.com/?q=10.7769,106.7009"),
    { lat: 10.7769, lng: 106.7009, source: "maps_link" },
  );
});

test("reads !3dlat!4dlng from a Google Maps link", () => {
  assert.deepEqual(
    parseCoordinateInput(
      "https://www.google.com/maps/place/BMQ/data=!4m5!3m4!1s0x0:0x0!8m2!3d10.776912!4d106.700912",
    ),
    { lat: 10.776912, lng: 106.700912, source: "maps_link" },
  );
});

test("swaps a reversed longitude,latitude pair inside Vietnam", () => {
  assert.deepEqual(parseCoordinateInput("106.7, 10.7"), {
    lat: 10.7,
    lng: 106.7,
    source: "pasted_coordinates",
  });
});

test("rounds coordinates to six decimal places", () => {
  assert.deepEqual(parseCoordinateInput("10.77691234, 106.70091234"), {
    lat: 10.776912,
    lng: 106.700912,
    source: "pasted_coordinates",
  });
});

test("rejects coordinates outside Vietnam", () => {
  assert.equal(parseCoordinateInput("48.8566, 2.3522"), null);
  assert.equal(parseCoordinateInput("https://maps.google.com/?q=48.8566,2.3522"), null);
  assert.equal(parseCoordinateInput("7.9, 106.7"), null);
});

test("rejects garbage and empty input", () => {
  assert.equal(parseCoordinateInput("không phải tọa độ"), null);
  assert.equal(parseCoordinateInput(""), null);
  assert.equal(parseCoordinateInput("   "), null);
  assert.equal(parseCoordinateInput(null), null);
  assert.equal(parseCoordinateInput(undefined), null);
});

test("lists dealer locations through crm_list_dealer_locations", async () => {
  const { client, calls } = createFakeClient(() => ({
    data: [{
      id: "dealer-1",
      customer_name: "Đại lý Một",
      customer_group: "banhmi_agency",
      address: "12 Lê Lợi",
      phone: "0900000000",
      location_lat: "10.776900",
      location_lng: "106.700900",
      location_source: "manual_pin",
      location_verified_at: "2026-11-03T10:00:00Z",
    }],
    error: null,
  }));

  const rows = await listDealerLocations(client);

  assert.deepEqual(calls, [{ fn: "crm_list_dealer_locations", args: undefined }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].location_lat, 10.7769);
  assert.equal(rows[0].location_lng, 106.7009);
});

test("pins a location and forwards the retry key", async () => {
  const { client, calls } = createFakeClient((fn) => {
    assert.equal(fn, "crm_set_dealer_location");
    return {
      data: {
        success: true,
        customer_id: "dealer-1",
        location_lat: 10.7769,
        location_lng: 106.7009,
        location_verified_at: "2026-11-03T10:00:00Z",
      },
      error: null,
    };
  });

  const result = await pinDealerLocation({
    customerId: "dealer-1",
    lat: 10.7769,
    lng: 106.7009,
    source: "manual_pin",
    note: "ghim lần đầu",
    requestId: "req-1",
  }, client);

  assert.equal(result.success, true);
  assert.equal(result.location_lat, 10.7769);
  assert.deepEqual(calls[0].args, {
    p_customer_id: "dealer-1",
    p_lat: 10.7769,
    p_lng: 106.7009,
    p_source: "manual_pin",
    p_note: "ghim lần đầu",
    p_request_id: "req-1",
    p_clear: false,
  });
});

test("clears a location with p_clear and null coordinates", async () => {
  const { client, calls } = createFakeClient(() => ({
    data: {
      success: true,
      customer_id: "dealer-1",
      location_lat: null,
      location_lng: null,
      location_verified_at: "2026-11-03T10:05:00Z",
    },
    error: null,
  }));

  const result = await clearDealerLocation({
    customerId: "dealer-1",
    note: "sai vị trí",
    requestId: "req-2",
  }, client);

  assert.equal(result.location_lat, null);
  assert.deepEqual(calls[0].args, {
    p_customer_id: "dealer-1",
    p_lat: null,
    p_lng: null,
    p_source: null,
    p_note: "sai vị trí",
    p_request_id: "req-2",
    p_clear: true,
  });
});

test("maps server errors to a stable error code", async () => {
  const { client } = createFakeClient(() => ({
    data: null,
    error: { message: "outside_vietnam" },
  }));

  await assert.rejects(
    () => setDealerLocation({
      customerId: "dealer-1",
      lat: 48.8566,
      lng: 2.3522,
      source: "pasted_coordinates",
    }, client),
    (error: unknown) =>
      error instanceof DealerLocationError && error.code === "outside_vietnam",
  );
});

test("rejects the list RPC error instead of returning rows", async () => {
  const { client } = createFakeClient(() => ({
    data: null,
    error: { message: "permission_denied" },
  }));

  await assert.rejects(
    () => listDealerLocations(client),
    (error: unknown) =>
      error instanceof DealerLocationError && error.code === "permission_denied",
  );
});
