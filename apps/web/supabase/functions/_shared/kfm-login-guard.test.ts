import assert from "node:assert/strict";

import { createKfmPasswordLoginGuard } from "./kfm-login-guard.ts";

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
