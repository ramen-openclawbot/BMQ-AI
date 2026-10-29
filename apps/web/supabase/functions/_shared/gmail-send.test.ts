import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGmailRawMessage,
  encodeHeaderValue,
  GmailSendError,
  sendGmail,
} from "./gmail-send.ts";

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

test("no-attachment output is byte-identical to the legacy message", () => {
  const originalRandomUUID = crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => "legacy-uuid",
    configurable: true,
  });
  try {
    const raw = buildGmailRawMessage({
      from: baseInput.from,
      to: baseInput.to,
      replyTo: baseInput.replyTo,
      subject: baseInput.subject,
      html: baseInput.html,
      text: baseInput.text,
    });

    assert.equal(
      raw,
      "From: =?UTF-8?B?Qk1RIMSQ4bq3dCBow6BuZw==?= <order@bmq.vn>\r\n" +
        "To: supplier@example.test\r\n" +
        "Reply-To: order@bmq.vn\r\n" +
        "Subject: =?UTF-8?B?Qk1RIMSR4bq3dCBow6BuZyBQTy0xMjMg4oCTIELGoSBQZWVybGVzcw==?=\r\n" +
        "MIME-Version: 1.0\r\n" +
        'Content-Type: multipart/alternative; boundary="bmq_order_legacy-uuid"\r\n' +
        "\r\n" +
        "--bmq_order_legacy-uuid\r\n" +
        "Content-Type: text/plain; charset=UTF-8\r\n" +
        "Content-Transfer-Encoding: base64\r\n" +
        "\r\n" +
        "WGluIGNow6Bv\r\n" +
        "--bmq_order_legacy-uuid\r\n" +
        "Content-Type: text/html; charset=UTF-8\r\n" +
        "Content-Transfer-Encoding: base64\r\n" +
        "\r\n" +
        "PHA+WGluIGNow6BvPC9wPg==\r\n" +
        "--bmq_order_legacy-uuid--\r\n",
    );
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: originalRandomUUID,
      configurable: true,
    });
  }
});

test("attachments produce multipart/mixed with base64 attachment parts", async () => {
  const originalRandomUUID = crypto.randomUUID;
  const boundaries = ["mixed-uuid", "alt-uuid"];
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => boundaries.shift() ?? "unexpected",
    configurable: true,
  });

  let raw = "";
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    raw = String(JSON.parse(String(init?.body ?? "{}")).raw ?? "");
    return new Response(JSON.stringify({ id: "msg-2", threadId: "thread-2" }), {
      status: 200,
    });
  };
  const attachment = {
    filename: "Ủy nhiệm chi.png",
    mimeType: "image/png",
    data: new Uint8Array([0, 1, 2, 250, 255]),
  };

  try {
    const result = await sendGmail({ ...baseInput, attachments: [attachment], fetcher });
    assert.deepEqual(result, { id: "msg-2", threadId: "thread-2" });
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: originalRandomUUID,
      configurable: true,
    });
  }

  const message = decodeRaw(raw);
  assert.match(message, /Content-Type: multipart\/mixed; boundary="bmq_mixed_mixed-uuid"/);
  assert.match(
    message,
    /Content-Type: multipart\/alternative; boundary="bmq_order_alt-uuid"/,
  );
  assert.ok(
    message.indexOf('Content-Type: multipart/alternative; boundary="bmq_order_alt-uuid"')
      < message.indexOf("Content-Disposition: attachment"),
    "the alternative body must come before the attachment part",
  );
  assert.match(message, /Content-Type: image\/png/);
  assert.ok(
    message.includes(
      `Content-Disposition: attachment; filename="${
        encodeHeaderValue(attachment.filename)
      }"`,
    ),
  );
  const base64 = message
    .split("Content-Disposition: attachment; filename=")[1]
    .split("\r\n\r\n")[1]
    .split("--bmq_mixed_mixed-uuid--")[0]
    .trim();
  assert.deepEqual(Buffer.from(base64, "base64"), Buffer.from(attachment.data));
});
