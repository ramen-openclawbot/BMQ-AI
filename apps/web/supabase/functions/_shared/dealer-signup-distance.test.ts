import assert from "node:assert/strict";
import test from "node:test";

import {
  computeRouteDistances,
  decideEligibility,
  dealerLabel,
  evaluateDealerRouteEligibility,
  haversineMeters,
  OSRM_DEFAULT_BASE_URL,
  OSRM_USER_AGENT,
  selectDealerCandidates,
  type DealerRecord,
  type Fetcher,
} from "./dealer-signup-distance.ts";

const ORIGIN = { lat: 10.7769, lng: 106.7009 };

type FetchCall = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
};

function dealer(
  id: string,
  lat: number | null,
  lng: number | null,
  extra: Partial<DealerRecord> = {},
): DealerRecord {
  return {
    id,
    customer_name: `Đại lý ${id}`,
    address: "12 Lê Lợi, Phường Bến Thành, Quận 1, TP.HCM",
    customer_group: "banhmi_agency",
    is_active: true,
    location_lat: lat,
    location_lng: lng,
    ...extra,
  };
}

function coordinateCount(url: string): number {
  const path = new URL(url).pathname;
  const coordinatePart = path.split("/table/v1/driving/")[1] ?? "";
  return coordinatePart.split(";").filter(Boolean).length;
}

function osrmFetcher(
  batches: Array<Array<number | null>>,
  calls: FetchCall[] = [],
  code = "Ok",
): Fetcher {
  let callIndex = 0;
  return async (input, init) => {
    const url = String(input);
    const count = Math.max(0, coordinateCount(url) - 1);
    const batch = batches[callIndex] ?? Array.from({ length: count }, () => 3000);
    callIndex += 1;
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
    });

    if (code !== "Ok") {
      return new Response(JSON.stringify({ code }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const row = [0, ...batch.slice(0, count)];
    return new Response(JSON.stringify({ code: "Ok", distances: [row] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

test("haversine returns metres and dealer label exposes only area information", () => {
  const distance = haversineMeters(ORIGIN.lat, ORIGIN.lng, ORIGIN.lat + 0.01, ORIGIN.lng);
  assert.ok(distance > 1100 && distance < 1120, `unexpected distance ${distance}`);
  assert.equal(dealerLabel("12 Lê Lợi, Phường Bến Thành, Quận 1, TP.HCM"), "Phường Bến Thành, Quận 1");
  assert.equal(dealerLabel("45 Nguyễn Trãi, TP.HCM"), "Nguyễn Trãi");
  assert.equal(dealerLabel(null), "Khu vực lân cận");
});

test("1999 m on the OSRM bike route is rejected as too_close", async () => {
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", ORIGIN.lat + 0.01, ORIGIN.lng)],
    fetcher: osrmFetcher([[1999]]),
  });

  assert.equal(decision.result, "too_close");
  assert.equal(decision.reason_code, "dealer_within_2km");
  assert.equal(decision.nearest_distance_m, 1999);
  assert.equal(decision.nearest_dealer_customer_id, "d1");
  assert.equal(decision.distance_provider, "osm_osrm_bike");
});

test("2000 m is manual_review in the near-threshold band", async () => {
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", ORIGIN.lat + 0.01, ORIGIN.lng)],
    fetcher: osrmFetcher([[2000]]),
  });

  assert.equal(decision.result, "manual_review");
  assert.equal(decision.reason_code, "distance_near_threshold");
  assert.equal(decision.nearest_distance_m, 2000);
});

test("2499 m is manual_review in the near-threshold band", async () => {
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", ORIGIN.lat + 0.02, ORIGIN.lng)],
    fetcher: osrmFetcher([[2499]]),
  });

  assert.equal(decision.result, "manual_review");
  assert.equal(decision.reason_code, "distance_near_threshold");
  assert.equal(decision.nearest_distance_m, 2499);
});

test("2500 m is eligible with the default 500 m band", async () => {
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", ORIGIN.lat + 0.02, ORIGIN.lng)],
    fetcher: osrmFetcher([[2500]]),
  });

  assert.equal(decision.result, "eligible");
  assert.equal(decision.reason_code, null);
  assert.equal(decision.nearest_distance_m, 2500);
});

test("3500 m is eligible", async () => {
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", ORIGIN.lat + 0.03, ORIGIN.lng)],
    fetcher: osrmFetcher([[3500]]),
  });

  assert.equal(decision.result, "eligible");
  assert.equal(decision.nearest_distance_m, 3500);
});

test("band=0 from the environment makes 2000 m eligible", async () => {
  const previous = Deno.env.get("DEALER_SIGNUP_REVIEW_BAND_M");
  Deno.env.set("DEALER_SIGNUP_REVIEW_BAND_M", "0");
  try {
    const decision = await evaluateDealerRouteEligibility({
      origin: ORIGIN,
      dealers: [dealer("d1", ORIGIN.lat + 0.01, ORIGIN.lng)],
      fetcher: osrmFetcher([[2000]]),
    });

    assert.equal(decision.result, "eligible");
    assert.equal(decision.reason_code, null);
  } finally {
    if (previous === undefined) Deno.env.delete("DEALER_SIGNUP_REVIEW_BAND_M");
    else Deno.env.set("DEALER_SIGNUP_REVIEW_BAND_M", previous);
  }
});

test("a dealer missing coordinates forces manual_review", async () => {
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [
      dealer("d1", ORIGIN.lat + 0.01, ORIGIN.lng),
      dealer("d2", null, null),
    ],
    fetcher: osrmFetcher([[3000]]),
  });

  assert.equal(decision.result, "manual_review");
  assert.equal(decision.reason_code, "dealer_location_missing");
  assert.equal(decision.unlocated_dealer_count, 1);
});

test("an OSRM HTTP 500 forces manual_review with osrm_unavailable", async () => {
  const fetcher: Fetcher = async () => new Response("provider down", { status: 500 });
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", ORIGIN.lat + 0.01, ORIGIN.lng)],
    fetcher,
  });

  assert.equal(decision.result, "manual_review");
  assert.equal(decision.reason_code, "osrm_unavailable");
});

test("a null OSRM distance forces manual_review", async () => {
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", ORIGIN.lat + 0.01, ORIGIN.lng)],
    fetcher: osrmFetcher([[null]]),
  });

  assert.equal(decision.result, "manual_review");
  assert.equal(decision.reason_code, "dealer_route_missing");
});

test("an OSRM code other than Ok forces manual_review", async () => {
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", ORIGIN.lat + 0.01, ORIGIN.lng)],
    fetcher: osrmFetcher([[3000]], [], "NoRoute"),
  });

  assert.equal(decision.result, "manual_review");
  assert.equal(decision.reason_code, "dealer_route_missing");
});

test("a sub-2 km dealer with no route is manual_review, never eligible", async () => {
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", ORIGIN.lat + 0.001, ORIGIN.lng)],
    fetcher: osrmFetcher([[null]]),
  });

  assert.equal(decision.result, "manual_review");
  assert.equal(decision.reason_code, "dealer_route_missing");
});

test("60 dealers are split into 50 + 10 OSRM calls", async () => {
  const dealers = Array.from({ length: 60 }, (_, index) =>
    dealer(`d${index + 1}`, ORIGIN.lat + 0.005, ORIGIN.lng + index * 0.000001));
  const calls: FetchCall[] = [];
  const decision = await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers,
    fetcher: osrmFetcher([
      Array(50).fill(3000),
      Array(10).fill(3000),
    ], calls),
  });

  assert.equal(decision.result, "eligible");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => coordinateCount(call.url)), [51, 11]);
});

test("the OSRM request uses the bike base, origin first in lng,lat order, sources and User-Agent", async () => {
  const calls: FetchCall[] = [];
  await evaluateDealerRouteEligibility({
    origin: ORIGIN,
    dealers: [dealer("d1", 10.7869, 106.7009)],
    fetcher: osrmFetcher([[2500]], calls),
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.ok(calls[0].url.startsWith(`${OSRM_DEFAULT_BASE_URL}/table/v1/driving/`));
  assert.ok(url.pathname.endsWith("/table/v1/driving/106.7009,10.7769;106.7009,10.7869"));
  assert.equal(url.searchParams.get("sources"), "0");
  assert.equal(url.searchParams.get("annotations"), "distance");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers["User-Agent"], OSRM_USER_AGENT);
  assert.equal(calls[0].headers["X-Goog-Api-Key"], undefined);
});

test("timeout and network failures use stable osrm_* codes", async () => {
  const abortingFetcher: Fetcher = async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  const networkFetcher: Fetcher = async () => {
    throw new Error("network exploded");
  };

  const destinations = selectDealerCandidates(
    [dealer("d1", ORIGIN.lat + 0.01, ORIGIN.lng)],
    ORIGIN,
  ).candidates;

  const timeout = await computeRouteDistances({
    origin: ORIGIN,
    destinations,
    fetcher: abortingFetcher,
  });
  const network = await computeRouteDistances({
    origin: ORIGIN,
    destinations,
    fetcher: networkFetcher,
  });

  assert.equal(timeout.error_code, "osrm_timeout");
  assert.equal(network.error_code, "osrm_network_error");
  assert.equal(timeout.distance_provider, "osm_osrm_bike");
});

test("only active agency/point dealers inside the 8 km pre-filter are sent", () => {
  const selection = selectDealerCandidates([
    dealer("near", ORIGIN.lat + 0.005, ORIGIN.lng),
    dealer("far", ORIGIN.lat + 0.1, ORIGIN.lng),
    dealer("point", ORIGIN.lat + 0.006, ORIGIN.lng, { customer_group: "banhmi_point" }),
    dealer("inactive", ORIGIN.lat + 0.007, ORIGIN.lng, { is_active: false }),
    dealer("other-group", ORIGIN.lat + 0.008, ORIGIN.lng, { customer_group: "npp" }),
    dealer("missing", null, null),
  ], ORIGIN);

  assert.deepEqual(selection.candidates.map((candidate) => candidate.id).sort(), ["near", "point"]);
  assert.equal(selection.unlocated_dealer_count, 1);
});

test("decideEligibility never turns an incomplete measurement into eligible", () => {
  const candidates = selectDealerCandidates(
    [dealer("d1", ORIGIN.lat + 0.001, ORIGIN.lng)],
    ORIGIN,
  ).candidates;

  const decision = decideEligibility({
    candidates,
    distances: [{ dealer: candidates[0], distance_m: null }],
    unlocatedDealerCount: 0,
    errorCode: "osrm_network_error",
  });

  assert.equal(decision.result, "manual_review");
  assert.equal(decision.reason_code, "osrm_network_error");
});
