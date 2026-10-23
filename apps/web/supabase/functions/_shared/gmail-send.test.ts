import assert from "node:assert/strict";
import test from "node:test";

import { GmailSendError, sendGmail } from "./gmail-send.ts";

function decodeRaw(raw: string): string {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

function decodeEncodedWord(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

const baseInput = {
  accessToken: "super-secret-access-token",
  from: "BMQ Đặt hàng <order@bmq.vn>",
  to: "supplier@example.test",
  replyTo: "order@bmq.vn",
  subject: "BMQ đặt hàng PO-123 – Bơ Peerless",
  html: "<p>Xin chào</p>",
  text: "Xin chào",
};

test("encodes a Vietnamese subject as an RFC 2047 UTF-8 encoded-word", async () => {
  let raw = "";
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    raw = String(body.raw ?? "");
    return new Response(JSON.stringify({ id: "msg-1", threadId: "thread-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await sendGmail({ ...baseInput, fetcher });
  assert.deepEqual(result, { id: "msg-1", threadId: "thread-1" });

  const message = decodeRaw(raw);
  const subjectLine = message.split("\r\n").find((line) => line.startsWith("Subject: "));
  assert.ok(subjectLine, "subject header must exist");
  assert.match(subjectLine, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const encoded = subjectLine.slice("Subject: =?UTF-8?B?".length, -"?=".length);
  assert.equal(decodeEncodedWord(encoded), baseInput.subject);

  assert.match(message, /Content-Type: multipart\/alternative; boundary="/);
  assert.match(message, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(message, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(message, /Reply-To: order@bmq\.vn/);
  assert.match(message, /From: =\?UTF-8\?B\?/);
});

test("raw payload is base64url without padding or unsafe characters", async () => {
  let raw = "";
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    raw = String(JSON.parse(String(init?.body ?? "{}")).raw ?? "");
    return new Response(JSON.stringify({ id: "m", threadId: "t" }), { status: 200 });
  };

  await sendGmail({ ...baseInput, fetcher });
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  assert.ok(!raw.includes("+"));
  assert.ok(!raw.includes("/"));
  assert.ok(!raw.includes("="));
});

test("maps Gmail HTTP failures to stable error codes", async () => {
  const cases: Array<[number, string]> = [
    [401, "gmail_unauthorized"],
    [403, "gmail_forbidden"],
    [429, "gmail_rate_limited"],
    [500, "gmail_send_failed"],
  ];

  for (const [status, code] of cases) {
    const fetcher = async () =>
      new Response(JSON.stringify({ error: { message: "denied" } }), { status });
    await assert.rejects(
      () => sendGmail({ ...baseInput, fetcher }),
      (error: unknown) => {
        assert.ok(error instanceof GmailSendError);
        assert.equal((error as GmailSendError).code, code);
        return true;
      },
    );
  }
});

test("does not leak the access token or raw request in errors", async () => {
  const token = baseInput.accessToken;

  const networkFetcher = async () => {
    throw new Error(`network exploded while using ${token}`);
  };
  await assert.rejects(
    () => sendGmail({ ...baseInput, fetcher: networkFetcher }),
    (error: unknown) => {
      assert.ok(error instanceof GmailSendError);
      assert.equal((error as GmailSendError).code, "gmail_network_error");
      assert.ok(!error.message.includes(token));
      return true;
    },
  );

  const apiFetcher = async () =>
    new Response(JSON.stringify({ error: `bad token ${token}` }), { status: 400 });
  await assert.rejects(
    () => sendGmail({ ...baseInput, fetcher: apiFetcher }),
    (error: unknown) => {
      assert.ok(error instanceof GmailSendError);
      assert.equal((error as GmailSendError).code, "gmail_send_failed");
      assert.ok(!error.message.includes(token));
      assert.ok(!JSON.stringify(error).includes(token));
      return true;
    },
  );
});
