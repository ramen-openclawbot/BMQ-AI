import assert from "node:assert/strict";
import test from "node:test";

import {
  DEALER_VERIFY_CHECK_LIMIT_PER_HOUR,
  DEALER_VERIFY_SEND_LIMIT_PER_HOUR,
  handleDealerSignupVerify,
  type DealerSignupVerificationRow,
  type DealerSignupVerifyDeps,
  type DealerSignupVerifyEmail,
  type DealerSignupVerifyStore,
} from "./handler.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PHONE = "0909 123 456";
const PHONE_84 = "84909123456";
const EMAIL = "Hong@Example.Test";
const EMAIL_NORMALIZED = "hong@example.test";

class MemoryStore implements DealerSignupVerifyStore {
  rows = new Map<string, DealerSignupVerificationRow>();
  tokens: Array<{
    sessionId: string;
    tokenHash: string;
    phoneNormalized: string;
    emailNormalized: string;
    expiresAt: string;
    consumedAt: string | null;
  }> = [];
  rateAllowed = true;
  rateRetryAfter = 120;
  rateActions: string[] = [];
  private nextId = 1;

  private key(sessionId: string, channel: string) {
    return `${sessionId}:${channel}`;
  }

  async findBySessionChannel(sessionId: string, channel: "phone" | "email") {
    return this.rows.get(this.key(sessionId, channel)) ?? null;
  }

  async upsertVerification(input: Parameters<DealerSignupVerifyStore["upsertVerification"]>[0]) {
    const key = this.key(input.sessionId, input.channel);
    const current = this.rows.get(key);
    const row: DealerSignupVerificationRow = {
      id: current?.id ?? `verification-${this.nextId++}`,
      session_id: input.sessionId,
      channel: input.channel,
      target_normalized: input.targetNormalized,
      code_hash: input.codeHash,
      expires_at: input.expiresAt,
      attempts: 0,
      verified_at: null,
      consumed_at: null,
      ip_hash: input.ipHash,
      created_at: input.createdAt,
    };
    this.rows.set(key, row);
    return row;
  }

  async deleteVerification(id: string) {
    for (const [key, row] of this.rows) {
      if (row.id === id) this.rows.delete(key);
    }
  }

  async markVerified(id: string, verifiedAt: string) {
    for (const row of this.rows.values()) {
      if (row.id !== id) continue;
      row.verified_at = verifiedAt;
      row.consumed_at = verifiedAt;
    }
  }

  async setVerificationAttempts(id: string, attempts: number) {
    for (const row of this.rows.values()) {
      if (row.id === id) row.attempts = attempts;
    }
  }

  async invalidateSessionTokens(sessionId: string) {
    const now = new Date().toISOString();
    for (const token of this.tokens) {
      if (token.sessionId === sessionId && !token.consumedAt) token.consumedAt = now;
    }
  }

  async createVerificationToken(input: Parameters<DealerSignupVerifyStore["createVerificationToken"]>[0]) {
    this.tokens.push({ ...input, consumedAt: null });
  }

  async checkRateLimit(_ipHash: string, action: "verify_send" | "verify_check") {
    this.rateActions.push(action);
    return this.rateAllowed
      ? { allowed: true, remaining: 9, retry_after_seconds: 0 }
      : { allowed: false, remaining: 0, retry_after_seconds: this.rateRetryAfter };
  }
}

type Harness = {
  store: MemoryStore;
  deps: DealerSignupVerifyDeps;
  codes: string[];
  mails: DealerSignupVerifyEmail[];
  logs: string[];
  setNow(value: Date): void;
};

function harness(overrides: Partial<DealerSignupVerifyDeps> = {}): Harness {
  const store = new MemoryStore();
  const codes: string[] = [];
  const mails: DealerSignupVerifyEmail[] = [];
  const logs: string[] = [];
  let current = new Date("2026-11-03T03:00:00.000Z");

  const deps: DealerSignupVerifyDeps = {
    store,
    sendPhoneOtp: async (input) => {
      codes.push(input.otp);
      return { provider: "test" };
    },
    sendEmail: async (email) => {
      mails.push(email);
      return { id: `mail-${mails.length}` };
    },
    env: (key) => key === "DEALER_SIGNUP_IP_SALT" ? "test-salt" : key === "DEALER_SIGNUP_VERIFY_SECRET" ? "test-secret" : undefined,
    now: () => current,
    logger: (code) => logs.push(code),
    ...overrides,
  };

  return {
    store,
    deps,
    codes,
    mails,
    logs,
    setNow(value: Date) {
      current = value;
    },
  };
}

function post(body: Record<string, unknown>, ip = "203.0.113.10"): Request {
  return new Request("https://example.test/dealer-signup-verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

async function sendPhone(h: Harness, sessionId = SESSION_ID): Promise<Response> {
  return await handleDealerSignupVerify(
    post({
      action: "send",
      session_id: sessionId,
      channel: "phone",
      phone: PHONE,
    }),
    h.deps,
  );
}

async function sendEmail(h: Harness, sessionId = SESSION_ID): Promise<Response> {
  return await handleDealerSignupVerify(
    post({
      action: "send",
      session_id: sessionId,
      channel: "email",
      email: EMAIL,
    }),
    h.deps,
  );
}

function emailCode(mail: DealerSignupVerifyEmail): string {
  const match = mail.text.match(/Mã xác minh của bạn là: (\d{6})/);
  assert.ok(match, "email must contain the six-digit code");
  return String(match?.[1]);
}

test("phone send stores only a hash and never returns or logs the code", async () => {
  const h = harness();
  const response = await sendPhone(h);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.sent, true);
  assert.equal(body.channel, "phone");
  assert.equal(h.codes.length, 1);
  assert.match(h.codes[0], /^\d{6}$/);
  assert.equal(body.otp, undefined);
  assert.equal(body.code, undefined);
  assert.ok(!JSON.stringify(body).includes(h.codes[0]));

  const row = h.store.rows.get(`${SESSION_ID}:phone`);
  assert.ok(row);
  assert.equal(row?.target_normalized, PHONE_84);
  assert.match(String(row?.code_hash), /^[0-9a-f]{64}$/);
  assert.notEqual(row?.code_hash, h.codes[0]);
  assert.equal(row?.expires_at, "2026-11-03T03:10:00.000Z");
  assert.ok(h.logs.every((line) => !line.includes(h.codes[0])));
  assert.equal(DEALER_VERIFY_SEND_LIMIT_PER_HOUR, 10);
});

test("email send normalizes the address and hides the code from logs", async () => {
  const h = harness();
  const response = await sendEmail(h);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.channel, "email");
  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0].to, EMAIL_NORMALIZED);
  const code = emailCode(h.mails[0]);
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify(body).includes(code));
  assert.ok(h.logs.every((line) => !line.includes(code)));
  assert.equal(h.store.rows.get(`${SESSION_ID}:email`)?.target_normalized, EMAIL_NORMALIZED);
});

test("resending the same channel within 60 seconds is rejected", async () => {
  const h = harness();
  assert.equal((await sendPhone(h)).status, 200);

  const tooSoon = await sendPhone(h);
  assert.equal(tooSoon.status, 429);
  const body = await tooSoon.json();
  assert.equal(body.code, "resend_too_soon");
  assert.ok(Number(tooSoon.headers.get("Retry-After")) > 0);
  assert.equal(h.codes.length, 1);

  h.setNow(new Date("2026-11-03T03:01:01.000Z"));
  const resent = await sendPhone(h);
  assert.equal(resent.status, 200);
  assert.equal(h.codes.length, 2);
});

test("the IP send rate limit is enforced", async () => {
  const h = harness();
  h.store.rateAllowed = false;
  const response = await sendPhone(h);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, "rate_limited");
  assert.equal(response.headers.get("Retry-After"), "120");
  assert.deepEqual(h.store.rateActions, ["verify_send"]);
});

test("a wrong code is rejected and five wrong attempts lock the challenge", async () => {
  const h = harness();
  assert.equal((await sendPhone(h)).status, 200);
  const correct = h.codes[0];
  const wrong = correct === "000000" ? "111111" : "000000";

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await handleDealerSignupVerify(
      post({
        action: "check",
        session_id: SESSION_ID,
        channel: "phone",
        phone: PHONE,
        code: wrong,
      }),
      h.deps,
    );
    if (attempt < 5) {
      assert.equal(response.status, 400, `attempt ${attempt}`);
      assert.equal((await response.json()).code, "invalid_code");
    } else {
      assert.equal(response.status, 429);
      assert.equal((await response.json()).code, "too_many_attempts");
    }
  }

  const locked = await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      channel: "phone",
      phone: PHONE,
      code: correct,
    }),
    h.deps,
  );
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).code, "too_many_attempts");
});

test("an expired code is rejected", async () => {
  const h = harness();
  assert.equal((await sendPhone(h)).status, 200);
  h.setNow(new Date("2026-11-03T03:10:01.000Z"));

  const response = await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      channel: "phone",
      phone: PHONE,
      code: h.codes[0],
    }),
    h.deps,
  );
  assert.equal(response.status, 410);
  assert.equal((await response.json()).code, "code_expired");
});

test("verifying both channels returns a one-time token bound to the normalized targets", async () => {
  const h = harness();
  assert.equal((await sendPhone(h)).status, 200);
  assert.equal((await sendEmail(h)).status, 200);
  const phoneCode = h.codes[0];
  const mailCode = emailCode(h.mails[0]);

  const phoneCheck = await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      channel: "phone",
      phone: PHONE,
      code: phoneCode,
    }),
    h.deps,
  );
  const phoneBody = await phoneCheck.json();
  assert.equal(phoneCheck.status, 200);
  assert.deepEqual(phoneBody.verified, { phone: true, email: false });
  assert.equal(phoneBody.verification_token, undefined);

  const emailCheck = await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      email: EMAIL,
      phone: PHONE,
      email_code: mailCode,
    }),
    h.deps,
  );
  const body = await emailCheck.json();

  assert.equal(emailCheck.status, 200);
  assert.deepEqual(body.verified, { phone: true, email: true });
  assert.match(body.verification_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.verification_expires_at, "2026-11-03T03:30:00.000Z");
  assert.equal(h.store.tokens.length, 1);
  assert.equal(h.store.tokens[0].phoneNormalized, PHONE_84);
  assert.equal(h.store.tokens[0].emailNormalized, EMAIL_NORMALIZED);
  assert.match(h.store.tokens[0].tokenHash, /^[0-9a-f]{64}$/);
  assert.notEqual(h.store.tokens[0].tokenHash, body.verification_token);
  assert.ok(!JSON.stringify(body).includes(phoneCode));
  assert.ok(!JSON.stringify(body).includes(mailCode));
  assert.ok(h.logs.every((line) => !line.includes(phoneCode) && !line.includes(mailCode)));
  assert.ok(h.logs.every((line) => !line.includes(body.verification_token)));
  assert.equal(DEALER_VERIFY_CHECK_LIMIT_PER_HOUR, 30);
});

test("changing phone or email after verification invalidates the token", async () => {
  const h = harness();
  assert.equal((await sendPhone(h)).status, 200);
  assert.equal((await sendEmail(h)).status, 200);
  const phoneCode = h.codes[0];
  const mailCode = emailCode(h.mails[0]);

  await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      channel: "phone",
      phone: PHONE,
      code: phoneCode,
    }),
    h.deps,
  );
  await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      email: EMAIL,
      phone: PHONE,
      email_code: mailCode,
    }),
    h.deps,
  );

  const changedPhone = await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      phone: "0908 765 432",
      email: EMAIL,
    }),
    h.deps,
  );
  const changedBody = await changedPhone.json();
  assert.equal(changedPhone.status, 200);
  assert.deepEqual(changedBody.verified, { phone: false, email: true });
  assert.equal(changedBody.verification_token, undefined);

  const changedEmail = await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      phone: PHONE,
      email: "other@example.test",
    }),
    h.deps,
  );
  const changedEmailBody = await changedEmail.json();
  assert.deepEqual(changedEmailBody.verified, { phone: true, email: false });
  assert.equal(changedEmailBody.verification_token, undefined);

  const codeForChangedTarget = await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      channel: "phone",
      phone: "0908 765 432",
      code: phoneCode,
    }),
    h.deps,
  );
  assert.equal(codeForChangedTarget.status, 400);
  assert.equal((await codeForChangedTarget.json()).code, "verification_target_mismatch");
});

test("invalid session/target and missing codes are rejected", async () => {
  const h = harness();
  const badSession = await handleDealerSignupVerify(
    post({ action: "send", session_id: "not-a-uuid", channel: "phone", phone: PHONE }),
    h.deps,
  );
  assert.equal(badSession.status, 400);
  assert.equal((await badSession.json()).code, "invalid_session_id");

  const badChannel = await handleDealerSignupVerify(
    post({ action: "send", session_id: SESSION_ID, channel: "fax" }),
    h.deps,
  );
  assert.equal(badChannel.status, 400);
  assert.equal((await badChannel.json()).code, "invalid_channel");

  const badPhone = await handleDealerSignupVerify(
    post({ action: "send", session_id: SESSION_ID, channel: "phone", phone: "123" }),
    h.deps,
  );
  assert.equal(badPhone.status, 400);
  assert.equal((await badPhone.json()).code, "invalid_phone");

  const badEmail = await handleDealerSignupVerify(
    post({ action: "send", session_id: SESSION_ID, channel: "email", email: "nope" }),
    h.deps,
  );
  assert.equal(badEmail.status, 400);
  assert.equal((await badEmail.json()).code, "invalid_email");

  const statusOnly = await handleDealerSignupVerify(
    post({ action: "check", session_id: SESSION_ID, phone: PHONE, email: EMAIL }),
    h.deps,
  );
  assert.equal(statusOnly.status, 200);
  assert.deepEqual((await statusOnly.json()).verified, { phone: false, email: false });

  const missingCode = await handleDealerSignupVerify(
    post({ action: "check", session_id: SESSION_ID }),
    h.deps,
  );
  assert.equal(missingCode.status, 400);
  assert.equal((await missingCode.json()).code, "code_required");

  const noSend = await handleDealerSignupVerify(
    post({
      action: "check",
      session_id: SESSION_ID,
      channel: "phone",
      phone: PHONE,
      code: "123456",
    }),
    h.deps,
  );
  assert.equal(noSend.status, 400);
  assert.equal((await noSend.json()).code, "verification_not_sent");

  const invalidAction = await handleDealerSignupVerify(post({ action: "drop" }), h.deps);
  assert.equal(invalidAction.status, 400);
  assert.equal((await invalidAction.json()).code, "invalid_action");
});

test("a failed delivery removes the challenge so the user can retry immediately", async () => {
  const store = new MemoryStore();
  const h = harness({
    store,
    sendPhoneOtp: async () => {
      throw Object.assign(new Error("provider secret"), { code: "zns_failed" });
    },
  });

  const response = await sendPhone(h);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.ok(!text.includes("provider secret"));
  assert.ok(text.includes("verification_send_failed"));
  assert.equal(store.rows.size, 0);

  const retry = await sendPhone(h);
  assert.equal(retry.status, 502);
});
