import {
  handleMessengerHealth,
  type MessengerHealthDeps,
  type MessengerHealthEnv,
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

function env(overrides: Partial<MessengerHealthEnv> = {}): MessengerHealthEnv {
  return { META_PAGE_ACCESS_TOKEN: "token-secret", FACEBOOK_MESSENGER_WORKER_SECRET: "worker-secret", SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service", ...overrides };
}
function deps(overrides: Partial<MessengerHealthDeps> = {}) {
  return {
    getStatus: async () => ({ feature_enabled: false, settings_present: true, page_configured: true, page_auth_present: true, can_enqueue: false, pending_count_safe: 99 }),
    ...overrides,
  };
}

Deno.test("health returns only booleans and safe statuses, never token or secret values, default off", async () => {
  const response = await handleMessengerHealth(new Request("https://example.test/functions/v1/facebook-messenger-health"), env(), deps());
  assertEqual(response.status, 200);
  const body = await json(response);
  assertEqual(body.feature_enabled, false);
  assertEqual(body.token_present, true);
  assertEqual(body.can_enqueue, false);
  assertEqual(body.worker_secret_present, true);
  assert(Object.values(body).every((value) => typeof value === "boolean"), "health payload must be booleans only");
  assert(!("pending_count_safe" in body));
  assert(!JSON.stringify(body).includes("token-secret"));
  assert(!JSON.stringify(body).includes("worker-secret"));
});
