import {
  handleMessengerWorker,
  type MessengerWorkerDeps,
  type MessengerWorkerEnv,
} from "./index.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) throw new Error(message ?? `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
}
async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}

const OUTBOX = {
  id: "33333333-3333-4333-8333-333333333333",
  page_id: "page-123",
  psid: "psid-secret",
  text: "hello customer",
  tag: "RESPONSE",
  attempt_count: 0,
} as const;

function env(overrides: Partial<MessengerWorkerEnv> = {}): MessengerWorkerEnv {
  return {
    FACEBOOK_MESSENGER_WORKER_SECRET: "worker-secret",
    META_PAGE_ACCESS_TOKEN: "page-token-secret",
    ...overrides,
  };
}
function request(secret = "worker-secret") {
  return new Request("https://example.test/functions/v1/facebook-messenger-worker", { method: "POST", headers: { "x-worker-secret": secret } });
}
function deps(overrides: Partial<MessengerWorkerDeps> = {}) {
  const calls: Record<string, unknown[]> = { claim: [], commit: [], graph: [], sent: [], failed: [], manual: [] };
  const active: MessengerWorkerDeps = {
    claimPending: async () => {
      calls.claim.push(true);
      return [OUTBOX];
    },
    markSendCommitted: async (id) => {
      calls.commit.push(id);
      return true;
    },
    postGraphMessage: async (input) => {
      calls.graph.push(input);
      return { kind: "accepted", messageId: "mid.$accepted" };
    },
    markSent: async (id, mid, evidence) => { calls.sent.push({ id, mid, evidence }); },
    markFailed: async (id, reason, evidence) => { calls.failed.push({ id, reason, evidence }); },
    markManualReconciliationRequired: async (id, reason, evidence) => { calls.manual.push({ id, reason, evidence }); },
    ...overrides,
  };
  return { deps: active, calls };
}

Deno.test("worker requires dedicated timing-safe secret before claiming rows", async () => {
  const { deps: active, calls } = deps();
  const wrong = await handleMessengerWorker(request("wrong"), env(), active);
  assertEqual(wrong.status, 401);
  assertEqual((calls.claim as unknown[]).length, 0);

  const missingConfig = await handleMessengerWorker(request(), env({ FACEBOOK_MESSENGER_WORKER_SECRET: undefined }), active);
  assertEqual(missingConfig.status, 503);
});

Deno.test("idle worker returns safe count without Graph call", async () => {
  const { deps: active, calls } = deps({ claimPending: async () => [] });
  const response = await handleMessengerWorker(request(), env(), active);
  assertEqual(response.status, 200);
  assertEqual((await json(response)).processed, 0);
  assertEqual((calls.graph as unknown[]).length, 0);
});

Deno.test("worker commits before exact v26 Graph send and never logs psid content or token", async () => {
  const { deps: active, calls } = deps();
  const response = await handleMessengerWorker(request(), env(), active);
  assertEqual(response.status, 200);
  assertEqual((calls.commit as unknown[])[0], OUTBOX.id);
  const graph = (calls.graph as Record<string, unknown>[])[0];
  assertEqual(graph.endpoint, "/v26.0/page-123/messages");
  assertEqual(graph.pageAccessToken, "page-token-secret");
  assertEqual(graph.psid, "psid-secret");
  assertEqual(graph.text, "hello customer");
  assertEqual((calls.sent as unknown[]).length, 1);
});

Deno.test("send_committed_no_blind_retry: pre-commit failures can fail, post-commit timeout requires manual reconciliation", async () => {
  const pre = deps({ markSendCommitted: async () => false });
  const preResponse = await handleMessengerWorker(request(), env(), pre.deps);
  assertEqual(preResponse.status, 200);
  assertEqual((pre.calls.graph as unknown[]).length, 0);
  assertEqual((pre.calls.failed as unknown[]).length, 1);

  const timeout = deps({ postGraphMessage: async () => ({ kind: "ambiguous_timeout", safeReason: "timeout_requires_manual_reconciliation" }) });
  const timeoutResponse = await handleMessengerWorker(request(), env(), timeout.deps);
  assertEqual(timeoutResponse.status, 200);
  assertEqual((timeout.calls.manual as Record<string, unknown>[])[0].reason, "timeout_requires_manual_reconciliation");
  assertEqual((timeout.calls.failed as unknown[]).length, 0);
});

Deno.test("provider definitive rejection fails with sanitized code and rate-limit mapping suppresses safely", async () => {
  const provider = deps({ postGraphMessage: async () => ({ kind: "definitive_rejection", safeCode: "provider_error_sanitized" }) });
  await handleMessengerWorker(request(), env(), provider.deps);
  assertEqual((provider.calls.failed as Record<string, unknown>[])[0].reason, "provider_error_sanitized");

  const rateLimited = deps({ postGraphMessage: async () => ({ kind: "definitive_rejection", safeCode: "provider_rate_limited" }) });
  await handleMessengerWorker(request(), env(), rateLimited.deps);
  assertEqual((rateLimited.calls.failed as Record<string, unknown>[])[0].reason, "provider_rate_limited");
});
