import { handleAgentReply } from "./index.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) throw new Error(message ?? `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
}
const encoder = new TextEncoder();
const SECRET = "reply-secret-current-32-bytes-long";
const PREVIOUS = "reply-secret-previous-32-bytes";
const THREAD = "11111111-1111-4111-8111-111111111111";
const KEY = "bridge-key-123456789012345678901234567890";

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function signed(body: unknown, opts: { secret?: string; ts?: number; nonce?: string; mutateSig?: boolean; extra?: Record<string, string> } = {}): Promise<Request> {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? 1_800_000_000);
  const nonce = opts.nonce ?? "nonce_1234567890abcdef";
  let sig = await hmac(opts.secret ?? SECRET, `${ts}.${nonce}.${raw}`);
  if (opts.mutateSig) sig = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
  return new Request("https://example.test/functions/v1/facebook-messenger-agent-reply", {
    method: "POST",
    headers: { "content-type": "application/json", "x-instinct-timestamp": ts, "x-instinct-nonce": nonce, "x-instinct-signature": sig, ...(opts.extra || {}) },
    body: raw,
  });
}
function env(overrides: Record<string, string | undefined> = {}) {
  return { META_INSTINCT_REPLY_SECRET: SECRET, META_INSTINCT_REPLY_SECRET_PREVIOUS: PREVIOUS, SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service", ...overrides };
}
function deps(overrides: Partial<any> = {}) {
  const calls: any[] = [];
  return {
    calls,
    deps: {
      nowSeconds: () => 1_800_000_000,
      recordNonce: async (nonce: string, ts: number) => { calls.push(["nonce", nonce, ts]); return overrides.nonceOk ?? true; },
      checkRateLimit: async (threadId: string) => { calls.push(["rate", threadId]); return overrides.rateOk ?? true; },
      enqueueReply: async (input: any) => { calls.push(["enqueue", input]); return overrides.enqueueResult ?? { ok: true, row: { id: "outbox-1", status: "pending", idempotency_key: input.idempotencyKey } }; },
      requestId: () => "req_test",
    },
  };
}
async function json(r: Response) { return await r.json(); }

Deno.test("bad_hmac_rejected and creates no outbox", async () => {
  const d = deps();
  const res = await handleAgentReply(await signed({ thread_id: THREAD, text: "hello", idempotency_key: KEY }, { mutateSig: true }), env(), d.deps);
  assertEqual(res.status, 401);
  assertEqual(d.calls.length, 0);
});
Deno.test("stale_timestamp_rejected before nonce and outbox", async () => {
  const d = deps();
  const res = await handleAgentReply(await signed({ thread_id: THREAD, text: "hello", idempotency_key: KEY }, { ts: 1_799_999_000 }), env(), d.deps);
  assertEqual(res.status, 401);
  assertEqual(d.calls.length, 0);
});
Deno.test("nonce_replay_rejected creates no outbox", async () => {
  const d = deps({ nonceOk: false });
  const res = await handleAgentReply(await signed({ thread_id: THREAD, text: "hello", idempotency_key: KEY }), env(), d.deps);
  assertEqual(res.status, 409);
  assertEqual(d.calls.some((c) => c[0] === "enqueue"), false);
});
Deno.test("unknown_thread_rejected and disabled flags create no outbox", async () => {
  for (const reason of ["thread_not_found", "disabled"]) {
    const d = deps({ enqueueResult: { ok: false, reason } });
    const res = await handleAgentReply(await signed({ thread_id: THREAD, text: "hello", idempotency_key: KEY }, { nonce: `nonce_${reason}_abcd1234` }), env(), d.deps);
    assertEqual(res.status, reason === "thread_not_found" ? 404 : 503);
  }
});
Deno.test("outside_window_rejected and ai_cannot_use_human_agent", async () => {
  const d = deps({ enqueueResult: { ok: false, reason: "outside_window" } });
  const res = await handleAgentReply(await signed({ thread_id: THREAD, text: "hello", idempotency_key: KEY }), env(), d.deps);
  assertEqual(res.status, 409);
  assert(!JSON.stringify(d.calls).includes("HUMAN_AGENT"), "instinct bridge must not request HUMAN_AGENT");
});
Deno.test("same_idempotency_one_outbox returns minimized same outbox", async () => {
  const d = deps();
  const res = await handleAgentReply(await signed({ thread_id: THREAD, text: "hello", idempotency_key: KEY }), env(), d.deps);
  assertEqual(res.status, 200);
  const body = await json(res);
  assertEqual(body.outbox.id, "outbox-1");
  const enqueue = d.calls.find((c) => c[0] === "enqueue")[1];
  assertEqual(enqueue.threadId, THREAD);
  assertEqual(enqueue.idempotencyKey, KEY);
  assertEqual(enqueue.source, "instinct_bridge");
  assert(!JSON.stringify(enqueue).includes("HUMAN_AGENT"));
});
Deno.test("schema accepts exactly thread_id text idempotency_key and supports previous secret", async () => {
  const d = deps();
  const res = await handleAgentReply(await signed({ thread_id: THREAD, text: "hello", idempotency_key: KEY }, { secret: PREVIOUS }), env(), d.deps);
  assertEqual(res.status, 200);
  const bad = await handleAgentReply(await signed({ thread_id: THREAD, text: "hello", idempotency_key: KEY, tag: "HUMAN_AGENT" }, { nonce: "nonce_extra_bad_12345" }), env(), deps().deps);
  assertEqual(bad.status, 422);
});
Deno.test("rate limit fails closed", async () => {
  const d = deps({ rateOk: false });
  const res = await handleAgentReply(await signed({ thread_id: THREAD, text: "hello", idempotency_key: KEY }), env(), d.deps);
  assertEqual(res.status, 429);
  assertEqual(d.calls.some((c) => c[0] === "enqueue"), false);
});
