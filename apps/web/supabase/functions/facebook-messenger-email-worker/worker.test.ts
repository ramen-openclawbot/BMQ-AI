import { handleMessengerEmailWorker } from "./index.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition { if (!condition) throw new Error(message); }
function assertEqual<T>(actual: T, expected: T, message?: string): void { if (!Object.is(actual, expected)) throw new Error(message ?? `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`); }
const SECRET = "worker-secret-32-bytes";
const AGENT = "inboxoggxdk@agent.instinct.co";
function env(overrides: Record<string, string | undefined> = {}) { return { INSTINCT_EMAIL_WORKER_SECRET: SECRET, INSTINCT_EMAIL_RESEND_API_KEY: "resend", SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service", ...overrides }; }
function req(secret = SECRET) { return new Request("https://example.test/functions/v1/facebook-messenger-email-worker", { method: "POST", headers: { "x-worker-secret": secret } }); }
function deps(rows: any[], opts: Partial<any> = {}) {
  const calls: any[] = [];
  return { calls, deps: {
    claimPending: async () => { calls.push(["claim"]); return rows; },
    sendEmail: async (input: any) => { calls.push(["send", input]); return opts.sendResult ?? { kind: "accepted", providerId: "email-provider-1" }; },
    markSent: async (id: string, providerId: string, evidence: any) => { calls.push(["sent", id, providerId, evidence]); },
    markFailed: async (id: string, reason: string, evidence: any) => { calls.push(["failed", id, reason, evidence]); },
    markManualReconciliationRequired: async (id: string, reason: string, evidence: any) => { calls.push(["manual", id, reason, evidence]); },
  } };
}
async function json(r: Response) { return await r.json(); }
const row = { id: "email-1", recipient_email: AGENT, subject: "New Facebook Messenger message", payload: { thread_id: "11111111-1111-4111-8111-111111111111", sender_display: "Facebook sender", message_preview: "hello", notification_id: "notif_abc" }, email_fingerprint: "fingerprint_abc" };

Deno.test("worker secret required and disabled/missing config sends nothing", async () => {
  const d = deps([row]);
  assertEqual((await handleMessengerEmailWorker(req("wrong"), env(), d.deps)).status, 401);
  assertEqual(d.calls.length, 0);
  assertEqual((await handleMessengerEmailWorker(req(), env({ INSTINCT_EMAIL_RESEND_API_KEY: undefined }), d.deps)).status, 503);
  assertEqual(d.calls.length, 0);
});
Deno.test("destination_allowlisted raw_psid_not_emailed and stable idempotency key", async () => {
  const d = deps([row]);
  const res = await handleMessengerEmailWorker(req(), env(), d.deps);
  assertEqual(res.status, 200);
  const send = d.calls.find((c) => c[0] === "send")[1];
  assertEqual(send.to, AGENT);
  assertEqual(send.idempotencyKey, row.email_fingerprint);
  const serialized = JSON.stringify(send);
  assert(serialized.includes("thread_id"));
  assert(!serialized.includes("psid") && !serialized.includes("page_id") && !serialized.includes("mid.$"));
});
Deno.test("non allowlisted destination is suppressed without network", async () => {
  const d = deps([{ ...row, recipient_email: "other@example.com" }]);
  await handleMessengerEmailWorker(req(), env(), d.deps);
  assertEqual(d.calls.some((c) => c[0] === "send"), false);
  assertEqual(d.calls.some((c) => c[0] === "failed"), true);
});
Deno.test("accepted failed and ambiguous provider states are modeled honestly", async () => {
  let d = deps([row], { sendResult: { kind: "accepted", providerId: "provider-1" } });
  let res = await handleMessengerEmailWorker(req(), env(), d.deps);
  assertEqual((await json(res)).sent, 1);
  d = deps([row], { sendResult: { kind: "definitive_rejection", safeCode: "provider_rejected" } });
  await handleMessengerEmailWorker(req(), env(), d.deps);
  assertEqual(d.calls.some((c) => c[0] === "failed" && c[2] === "provider_rejected"), true);
  d = deps([row], { sendResult: { kind: "ambiguous_timeout", safeReason: "timeout_requires_manual_reconciliation" } });
  await handleMessengerEmailWorker(req(), env(), d.deps);
  assertEqual(d.calls.some((c) => c[0] === "manual"), true);
});
