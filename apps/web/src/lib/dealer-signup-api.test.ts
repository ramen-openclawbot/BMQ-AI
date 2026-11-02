import assert from "node:assert/strict";
import test from "node:test";

import {
  DEALER_SIGNUP_REVIEW_BAND_M,
  geocodeAddressPhoton,
  type PhotonFetcher,
} from "./dealer-signup-api.ts";

test("review band default matches the server default", () => {
  assert.equal(DEALER_SIGNUP_REVIEW_BAND_M, 500);
});

test("Photon geocoder sends q, limit and Vietnam bbox without lang", async () => {
  let requestedUrl = "";
  let requestedHeaders: Record<string, string> = {};
  const fetcher: PhotonFetcher = async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({
      features: [{
        properties: {
          name: "BMQ",
          housenumber: "12",
          street: "Lê Lợi",
          district: "Quận 1",
          city: "Hồ Chí Minh",
          osm_value: "amenity",
          type: "restaurant",
        },
        geometry: { coordinates: [106.7009, 10.7769] },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const results = await geocodeAddressPhoton("12 Lê Lợi, Quận 1", fetcher);
  const url = new URL(requestedUrl);

  assert.equal(url.origin + url.pathname, "https://photon.komoot.io/api/");
  assert.equal(url.searchParams.get("q"), "12 Lê Lợi, Quận 1");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(url.searchParams.has("lang"), false);
  assert.equal(url.searchParams.get("bbox"), "102,8,110,24");
  assert.equal(requestedHeaders.Accept, "application/json");
  assert.deepEqual(results, [{
    label: "BMQ, 12 Lê Lợi, Quận 1, Hồ Chí Minh",
    lat: 10.7769,
    lng: 106.7009,
  }]);
});

test("Photon label omits a redundant name and keeps every useful field", async () => {
  const fetcher: PhotonFetcher = async () => new Response(JSON.stringify({
    features: [{
      properties: {
        name: "Lê Lợi",
        housenumber: "12",
        street: "Lê Lợi",
        district: "Quận 1",
        city: "Hồ Chí Minh",
      },
      geometry: { coordinates: [106.7009, 10.7769] },
    }],
  }), { status: 200 });

  const [result] = await geocodeAddressPhoton("12 Lê Lợi", fetcher);
  assert.equal(result.label, "12 Lê Lợi, Quận 1, Hồ Chí Minh");
});

test("empty query and provider failures return no suggestions", async () => {
  let calls = 0;
  const fetcher: PhotonFetcher = async () => {
    calls += 1;
    return new Response("down", { status: 503 });
  };

  assert.deepEqual(await geocodeAddressPhoton("   ", fetcher), []);
  assert.equal(calls, 0);
  assert.deepEqual(await geocodeAddressPhoton("Quận 1", fetcher), []);
  assert.equal(calls, 1);
});
