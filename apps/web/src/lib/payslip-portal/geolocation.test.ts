import assert from "node:assert/strict";
import test from "node:test";

import {
  GEOLOCATION_TIMEOUT_MS,
  getCurrentLocation,
  getGeolocationGuidance,
  isSecureGeolocationContext,
  mapGeolocationErrorCode,
  type GeolocationDeps,
} from "./geolocation.ts";

test("secure context detection requires HTTPS or localhost", () => {
  assert.equal(isSecureGeolocationContext({ isSecureContext: true, protocol: "https:" }), true);
  assert.equal(isSecureGeolocationContext({ isSecureContext: true, protocol: "http:", hostname: "localhost" }), true);
  assert.equal(isSecureGeolocationContext({ isSecureContext: true, protocol: "http:", hostname: "127.0.0.1" }), true);
  assert.equal(isSecureGeolocationContext({ isSecureContext: false, protocol: "http:", hostname: "luong.banhmique.vn" }), false);
  assert.equal(isSecureGeolocationContext({ isSecureContext: false, protocol: "https:" }), false);
});

test("insecure context fails closed before calling the browser API", async () => {
  let called = false;
  const result = await getCurrentLocation({
    isSecureContext: false,
    protocol: "http:",
    hostname: "luong.banhmique.vn",
    geolocation: {
      getCurrentPosition: () => {
        called = true;
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.reasonCode, "insecure_context");
  assert.equal(called, false);
});

test("missing geolocation support maps to geolocation_unsupported", async () => {
  const result = await getCurrentLocation({ isSecureContext: true, protocol: "https:", geolocation: null });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.reasonCode, "geolocation_unsupported");
});

test("success uses high accuracy, 15s timeout and maximumAge 0", async () => {
  let options: PositionOptions | undefined;
  const deps: GeolocationDeps = {
    isSecureContext: true,
    protocol: "https:",
    geolocation: {
      getCurrentPosition: (success, _error, given) => {
        options = given;
        success({ coords: { latitude: 10.75, longitude: 106.65, accuracy: 8 } });
      },
    },
  };
  const result = await getCurrentLocation(deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.point : null, { latitude: 10.75, longitude: 106.65, accuracyM: 8 });
  assert.deepEqual(options, {
    enableHighAccuracy: true,
    timeout: GEOLOCATION_TIMEOUT_MS,
    maximumAge: 0,
  });
});

test("browser error codes map to permission_denied, position_unavailable and timeout", async () => {
  assert.equal(mapGeolocationErrorCode(1), "permission_denied");
  assert.equal(mapGeolocationErrorCode(2), "position_unavailable");
  assert.equal(mapGeolocationErrorCode(3), "timeout");

  for (const [code, expected] of [
    [1, "permission_denied"],
    [2, "position_unavailable"],
    [3, "timeout"],
  ] as const) {
    const result = await getCurrentLocation({
      isSecureContext: true,
      protocol: "https:",
      geolocation: {
        getCurrentPosition: (_success, error) => error({ code }),
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.reasonCode, expected);
    assert.ok((result.ok ? "" : result.guidance).length > 0);
  }
});

test("Chrome desktop and Chrome Android get distinct guidance", () => {
  const desktop = getGeolocationGuidance(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  );
  const android = getGeolocationGuidance(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
  );
  assert.match(desktop, /Chrome máy tính/);
  assert.match(desktop, /ổ khóa/);
  assert.match(android, /Chrome Android/);
  assert.match(android, /Cài đặt trang/);
  assert.notEqual(desktop, android);
});
