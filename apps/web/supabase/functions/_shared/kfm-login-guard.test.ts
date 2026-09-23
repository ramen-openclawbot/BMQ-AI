import assert from "node:assert/strict";

import { createKfmPasswordLoginGuard, createKfmSharedSessionStore } from "./kfm-login-guard.ts";

Deno.test("KFM password guard adapter sends exact acquire and release RPC payloads", async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const guard = createKfmPasswordLoginGuard({
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "kfm_login_guard_acquire") {
        return Promise.resolve({
          data: {
            acquired: true,
            lease_token: args.p_lease_token,
            retry_after_seconds: 0,
            reason: "acquired",
          },
          error: null,
        });
      }
      if (fn === "kfm_login_guard_release") {
        return Promise.resolve({ data: true, error: null });
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  }, { guardKey: "kfm_portal_test", cooldownMs: 125_000, leaseMs: 16_000 });

  const lease = await guard.acquirePasswordLoginLease();
  assert.equal(lease.acquired, true);
  if (!lease.acquired) throw new Error("expected acquired lease");
  assert.match(lease.leaseToken, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(calls[0], {
    fn: "kfm_login_guard_acquire",
    args: {
      p_guard_key: "kfm_portal_test",
      p_lease_token: lease.leaseToken,
      p_cooldown_seconds: 125,
      p_lease_seconds: 16,
    },
  });

  await guard.releasePasswordLoginLease(lease.leaseToken, "exchange");
  assert.deepEqual(calls[1], {
    fn: "kfm_login_guard_release",
    args: {
      p_guard_key: "kfm_portal_test",
      p_lease_token: lease.leaseToken,
      p_outcome: "exchange",
    },
  });
});

Deno.test("KFM password guard adapter fails closed on acquire RPC errors and malformed rows", async () => {
  const privateError = "DB_PRIVATE_GUARD";
  for (const result of [
    { data: null, error: { message: privateError } },
    { data: { acquired: "yes", lease_token: crypto.randomUUID() }, error: null },
    { data: [{ acquired: true, lease_token: crypto.randomUUID() }], error: null },
  ]) {
    const guard = createKfmPasswordLoginGuard({
      rpc: () => Promise.resolve(result),
    });
    await assert.rejects(
      () => guard.acquirePasswordLoginLease(),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "kfm_login_guard_unavailable");
        assert.ok(!error.message.includes(privateError));
        return true;
      },
    );
  }
});

Deno.test("KFM password guard adapter requires the RPC to echo the generated lease token", async () => {
  const guard = createKfmPasswordLoginGuard({
    rpc: () => Promise.resolve({
      data: {
        acquired: true,
        lease_token: crypto.randomUUID(),
        retry_after_seconds: 0,
        reason: "acquired",
      },
      error: null,
    }),
  });

  await assert.rejects(
    () => guard.acquirePasswordLoginLease(),
    (error) => error instanceof Error && error.message === "kfm_login_guard_unavailable",
  );
});

Deno.test("KFM password guard adapter fails closed when CAS release is false or errors", async () => {
  const leaseToken = crypto.randomUUID();
  for (const result of [
    { data: false, error: null },
    { data: null, error: { message: "RELEASE_PRIVATE_GUARD" } },
  ]) {
    let releasePayload: Record<string, unknown> | null = null;
    const guard = createKfmPasswordLoginGuard({
      rpc: (fn: string, args: Record<string, unknown>) => {
        if (fn === "kfm_login_guard_acquire") {
          return Promise.resolve({
            data: { acquired: true, lease_token: args.p_lease_token, retry_after_seconds: 0, reason: "acquired" },
            error: null,
          });
        }
        releasePayload = args;
        return Promise.resolve(result);
      },
    }, { guardKey: "kfm_portal_release" });
    const lease = await guard.acquirePasswordLoginLease();
    assert.equal(lease.acquired, true);
    if (!lease.acquired) throw new Error("expected acquired lease");

    await assert.rejects(
      () => guard.releasePasswordLoginLease(leaseToken, "provider-private"),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "kfm_login_guard_release_failed");
        assert.ok(!error.message.includes("RELEASE_PRIVATE_GUARD"));
        return true;
      },
    );
    assert.deepEqual(releasePayload, {
      p_guard_key: "kfm_portal_release",
      p_lease_token: leaseToken,
      p_outcome: "error",
    });
  }
});

Deno.test("KFM shared session adapter sends exact service-role RPC payloads", async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const generation = crypto.randomUUID();
  const store = createKfmSharedSessionStore({
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "kfm_shared_session_get") {
        return Promise.resolve({
          data: {
            token: "ACCESS_PRIVATE_SHARED_ADAPTER",
            generation,
            expires_at: "2026-09-24T01:02:03.000Z",
            obtained_at: "2026-09-24T01:01:03.000Z",
            mode: "shared",
          },
          error: null,
        });
      }
      if (fn === "kfm_shared_session_publish") {
        return Promise.resolve({
          data: [{
            token: args.p_access_token,
            generation,
            expires_at: "2026-09-24T01:03:03.000Z",
            obtained_at: args.p_obtained_at,
            mode: "shared",
          }],
          error: null,
        });
      }
      if (fn === "kfm_shared_session_invalidate") {
        return Promise.resolve({ data: true, error: null });
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  }, { guardKey: "kfm_portal_test", maxTtlMs: 45_000 });

  assert.deepEqual(await store.readSharedSession(), {
    token: "ACCESS_PRIVATE_SHARED_ADAPTER",
    generation,
    expiresAt: "2026-09-24T01:02:03.000Z",
    obtainedAt: "2026-09-24T01:01:03.000Z",
    mode: "shared",
  });
  assert.deepEqual(calls[0], {
    fn: "kfm_shared_session_get",
    args: { p_guard_key: "kfm_portal_test" },
  });

  const leaseToken = crypto.randomUUID();
  const published = await store.publishSharedSession({
    token: "ACCESS_PRIVATE_PUBLISH_ADAPTER",
    refreshToken: "REFRESH_PRIVATE_MUST_NOT_BE_SENT",
    mode: "login",
    obtainedAt: "2026-09-24T01:01:30.000Z",
  }, leaseToken);
  assert.equal(typeof published, "object");
  assert.deepEqual(calls[1], {
    fn: "kfm_shared_session_publish",
    args: {
      p_guard_key: "kfm_portal_test",
      p_lease_token: leaseToken,
      p_access_token: "ACCESS_PRIVATE_PUBLISH_ADAPTER",
      p_obtained_at: "2026-09-24T01:01:30.000Z",
      p_max_ttl_seconds: 45,
    },
  });
  assert.ok(!JSON.stringify(calls[1]).includes("REFRESH_PRIVATE_MUST_NOT_BE_SENT"));

  assert.equal(await store.invalidateSharedSession(generation), true);
  assert.deepEqual(calls[2], {
    fn: "kfm_shared_session_invalidate",
    args: {
      p_guard_key: "kfm_portal_test",
      p_generation: generation,
    },
  });
});

Deno.test("KFM shared session adapter defaults cache policy to the full login cooldown window", async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const store = createKfmSharedSessionStore({
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve({
        data: {
          token: args.p_access_token,
          generation: crypto.randomUUID(),
          expires_at: "2026-09-24T01:16:30.000Z",
          obtained_at: args.p_obtained_at,
          mode: "shared",
        },
        error: null,
      });
    },
  });

  await store.publishSharedSession({
    token: "ACCESS_PRIVATE_DEFAULT_TTL",
    refreshToken: "",
    mode: "login",
    obtainedAt: "2026-09-24T01:01:30.000Z",
  }, crypto.randomUUID());
  assert.equal(calls[0].args.p_max_ttl_seconds, 900);
});

Deno.test("KFM shared session adapter treats empty rows as no shared session", async () => {
  for (const data of [null]) {
    const store = createKfmSharedSessionStore({
      rpc: () => Promise.resolve({ data, error: null }),
    });
    assert.equal(await store.readSharedSession(), null);
  }

  const store = createKfmSharedSessionStore({
    rpc: () => Promise.resolve({ data: null, error: null }),
  });
  assert.equal(await store.publishSharedSession({
    token: "ACCESS_PRIVATE",
    refreshToken: "",
    mode: "login",
    obtainedAt: "2026-09-24T01:01:30.000Z",
  }, crypto.randomUUID()), false);
});

Deno.test("KFM shared session adapter fails closed on malformed nonempty rows", async () => {
  for (const data of [
    { token: "", generation: crypto.randomUUID(), expires_at: "2026-09-24T01:02:03.000Z" },
    { token: "ACCESS_PRIVATE", generation: "", expires_at: "2026-09-24T01:02:03.000Z" },
    { token: "ACCESS_PRIVATE", generation: crypto.randomUUID(), expires_at: "" },
    { token: "ACCESS_PRIVATE", generation: crypto.randomUUID(), expires_at: "not-a-date" },
    { token: "ACCESS_PRIVATE", generation: crypto.randomUUID(), expires_at: "2026-09-24T01:02:03.000Z", obtained_at: "not-a-date" },
  ]) {
    const store = createKfmSharedSessionStore({
      rpc: () => Promise.resolve({ data, error: null }),
    });
    await assert.rejects(
      () => store.readSharedSession(),
      (error) => error instanceof Error && error.message === "kfm_shared_session_unavailable",
    );
  }
});

Deno.test("KFM shared session adapter fails closed on RPC errors without leaking provider secrets", async () => {
  const privateError = "DB_PRIVATE_SHARED_ADAPTER";
  const store = createKfmSharedSessionStore({
    rpc: () => Promise.resolve({ data: null, error: { message: privateError } }),
  });

  await assert.rejects(
    () => store.readSharedSession(),
    (error) => error instanceof Error &&
      error.message === "kfm_shared_session_unavailable" &&
      !error.message.includes(privateError),
  );
  await assert.rejects(
    () => store.publishSharedSession({
      token: "ACCESS_PRIVATE_RPC_ERROR",
      refreshToken: "",
      mode: "login",
      obtainedAt: "2026-09-24T01:01:30.000Z",
    }, crypto.randomUUID()),
    (error) => error instanceof Error &&
      error.message === "kfm_shared_session_unavailable" &&
      !error.message.includes("ACCESS_PRIVATE_RPC_ERROR"),
  );
  await assert.rejects(
    () => store.invalidateSharedSession(crypto.randomUUID()),
    (error) => error instanceof Error &&
      error.message === "kfm_shared_session_unavailable" &&
      !error.message.includes(privateError),
  );
});
