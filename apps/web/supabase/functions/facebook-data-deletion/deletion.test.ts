import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import {
  FACEBOOK_DELETION_MAX_BODY_BYTES,
  handleDataDeletionCallback,
  handleDataDeletionHttpRequest,
  handleStatusRequest,
  hashConfirmationCode,
  verifyMetaSignedRequest,
} from "./index.ts";

const ROOT = new URL("../../../..", import.meta.url);
const INDEX = new URL("./index.ts", import.meta.url);
const SQL = new URL("../../migrations/20260903063000_facebook_messenger_privacy_deletion.sql", import.meta.url);
const CONFIG = new URL("../../config.toml", import.meta.url);
const PRIVACY = new URL("../../../public/privacy.html", import.meta.url);
const DELETION_PAGE = new URL("../../../public/facebook-data-deletion.html", import.meta.url);

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signedRequest(payload: Record<string, unknown>, secret = "meta-secret"): string {
  const encodedPayload = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${signature}.${encodedPayload}`;
}

function formRequest(signed_request: string, url = "https://ai.banhmique.vn/functions/v1/facebook-data-deletion"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ signed_request }),
  });
}

function text(url: URL): string {
  return readFileSync(url, "utf8");
}

test("HTTP router rejects invalid public requests before creating database dependencies", async () => {
  let dependencyAttempts = 0;
  const depsFactory = async () => {
    dependencyAttempts += 1;
    throw new Error("database dependencies must stay lazy");
  };

  const callback = await handleDataDeletionHttpRequest(formRequest(""), {}, depsFactory);
  assert.equal(callback.status, 400);
  assert.deepEqual(await callback.json(), { error: "invalid_signed_request" });

  const status = await handleDataDeletionHttpRequest(
    new Request("https://project-ref.supabase.co/functions/v1/facebook-data-deletion/status", { method: "GET" }),
    {},
    depsFactory,
  );
  assert.equal(status.status, 400);
  assert.deepEqual(await status.json(), { error: "invalid_code" });
  assert.equal(dependencyAttempts, 0);
});

test("HTTP router uses a statically bundleable Supabase client import", () => {
  const source = text(INDEX);
  assert.match(source, /^import \{ createClient \} from "npm:@supabase\/supabase-js@2\.90\.1";/m);
  assert.doesNotMatch(source, /await import\(supabaseModule\)/);
});

test("valid Meta signed_request is verified before exposing an app-scoped user id", async () => {
  const payload = { algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "1234567890", issued_at: 1790000000 };
  const verified = await verifyMetaSignedRequest(signedRequest(payload), "meta-secret", "meta-app-123");

  assert.deepEqual(verified, { ok: true, appScopedUserId: "1234567890" });
});

test("signed_request fails closed when app_id is missing, malformed, or mismatched", async () => {
  assert.equal((await verifyMetaSignedRequest(signedRequest({ algorithm: "HMAC-SHA256", user_id: "1234567890" }), "meta-secret", "meta-app-123")).ok, false);
  assert.equal((await verifyMetaSignedRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "other-app", user_id: "1234567890" }), "meta-secret", "meta-app-123")).ok, false);
  assert.equal((await verifyMetaSignedRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "", user_id: "1234567890" }), "meta-secret", "meta-app-123")).ok, false);
  assert.equal((await verifyMetaSignedRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "a".repeat(129), user_id: "1234567890" }), "meta-secret", "meta-app-123")).ok, false);
  assert.equal((await verifyMetaSignedRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "1234567890" }), "meta-secret", "")).ok, false);
});

test("callback rejects missing or mismatched Meta app id before registration", async () => {
  for (const signed_request of [
    signedRequest({ algorithm: "HMAC-SHA256", user_id: "app-user-1" }),
    signedRequest({ algorithm: "HMAC-SHA256", app_id: "wrong-app", user_id: "app-user-1" }),
  ]) {
    const response = await handleDataDeletionCallback(
      formRequest(signed_request),
      { META_APP_SECRET: "meta-secret", META_APP_ID: "meta-app-123", META_DELETION_CONFIRMATION_SECRET: "confirmation-secret" },
      {
        registerDeletionRequest: async () => assert.fail("app_id failures must not reach registration"),
      },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_signed_request" });
  }
});

test("tampered, malformed, wrong algorithm, and oversized callbacks are rejected", async () => {
  const valid = signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "1234567890" });
  assert.equal((await verifyMetaSignedRequest(`${valid}x`, "meta-secret", "meta-app-123")).ok, false);
  assert.equal((await verifyMetaSignedRequest("not-a-signed-request", "meta-secret", "meta-app-123")).ok, false);
  assert.equal((await verifyMetaSignedRequest(signedRequest({ algorithm: "PLAINTEXT", app_id: "meta-app-123", user_id: "123" }), "meta-secret", "meta-app-123")).ok, false);
  assert.equal((await verifyMetaSignedRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "" }), "meta-secret", "meta-app-123")).ok, false);

  const tooLarge = new Request("https://ai.banhmique.vn/functions/v1/facebook-data-deletion", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `signed_request=${"a".repeat(FACEBOOK_DELETION_MAX_BODY_BYTES + 1)}`,
  });
  const response = await handleDataDeletionCallback(tooLarge, { META_APP_SECRET: "meta-secret", META_APP_ID: "meta-app-123" }, {
    registerDeletionRequest: async () => assert.fail("oversized payload must not reach registration"),
  });
  assert.equal(response.status, 413);
});

test("callback requires a separate confirmation secret before registration", async () => {
  const response = await handleDataDeletionCallback(
    formRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "app-user-1" })),
    { META_APP_SECRET: "meta-secret", META_APP_ID: "meta-app-123" },
    {
      registerDeletionRequest: async () => assert.fail("missing confirmation secret must not reach registration"),
    },
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "missing_confirmation_secret" });
});

test("callback builds status URL only from trusted SUPABASE_URL and ignores spoofed request origins", async () => {
  const response = await handleDataDeletionCallback(
    formRequest(
      signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "app-user-1" }),
      "https://evil.example/anything/facebook-data-deletion",
    ),
    {
      META_APP_SECRET: "meta-secret",
      META_APP_ID: "meta-app-123",
      META_DELETION_CONFIRMATION_SECRET: "confirmation-secret",
      SUPABASE_URL: "https://project-ref.supabase.co",
    },
    {
      registerDeletionRequest: async (input) => ({ status: "requested", confirmationCodeHash: input.confirmationCodeHash }),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.url, `https://project-ref.supabase.co/functions/v1/facebook-data-deletion/status?code=${body.confirmation_code}`);
  assert.equal(String(body.url).includes("evil.example"), false);
});

test("callback rejects missing or unsafe SUPABASE_URL before registration", async () => {
  const safeSignedRequest = signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "app-user-1" });
  for (const SUPABASE_URL of [undefined, "", "http://project-ref.supabase.co", "javascript:alert(1)", "https://user:pass@project-ref.supabase.co", "https://project-ref.supabase.co/#fragment"]) {
    const response = await handleDataDeletionCallback(
      formRequest(safeSignedRequest),
      {
        META_APP_SECRET: "meta-secret",
        META_APP_ID: "meta-app-123",
        META_DELETION_CONFIRMATION_SECRET: "confirmation-secret",
        SUPABASE_URL,
      },
      {
        registerDeletionRequest: async () => assert.fail(`unsafe SUPABASE_URL must not register: ${SUPABASE_URL}`),
      },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "invalid_status_url_configuration" });
  }
});

test("callback permits explicit localhost HTTP SUPABASE_URL for local tests and still uses the fixed status path", async () => {
  for (const SUPABASE_URL of ["http://localhost:54321", "http://127.0.0.1:54321/rest/v1"]) {
    const response = await handleDataDeletionCallback(
      formRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "local-user" })),
      {
        META_APP_SECRET: "meta-secret",
        META_APP_ID: "meta-app-123",
        META_DELETION_CONFIRMATION_SECRET: "confirmation-secret",
        SUPABASE_URL,
      },
      {
        registerDeletionRequest: async (input) => ({ status: "requested", confirmationCodeHash: input.confirmationCodeHash }),
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const expectedOrigin = new URL(SUPABASE_URL).origin;
    assert.equal(body.url, `${expectedOrigin}/functions/v1/facebook-data-deletion/status?code=${body.confirmation_code}`);
  }
});

test("callback returns deterministic high-entropy confirmation derived from a separate secret while storage receives only hashes", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const response = await handleDataDeletionCallback(
    formRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "app-user-1" })),
    { META_APP_SECRET: "meta-secret", META_APP_ID: "meta-app-123", META_DELETION_CONFIRMATION_SECRET: "confirmation-secret", SUPABASE_URL: "https://ai.banhmique.vn" },
    {
      registerDeletionRequest: async (input) => {
        seen.push(input);
        return { status: "pending_manual_mapping", confirmationCodeHash: input.confirmationCodeHash };
      },
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.confirmation_code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.url, `https://ai.banhmique.vn/functions/v1/facebook-data-deletion/status?code=${body.confirmation_code}`);
  assert.deepEqual(Object.keys(body).sort(), ["confirmation_code", "url"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].appScopedUserId, "app-user-1");
  assert.equal(seen[0].confirmationCode, undefined);
  assert.equal(seen[0].rawPayload, undefined);
  assert.match(String(seen[0].confirmationCodeHash), /^[0-9a-f]{64}$/);
  assert.equal(seen[0].confirmationCodeHash, await hashConfirmationCode(body.confirmation_code));
});

test("repeat callback returns the same code and same function-origin status URL without plaintext storage", async () => {
  const requestFingerprint = new Set<string>();
  const confirmationHashes = new Set<string>();
  const first = await handleDataDeletionCallback(
    formRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "repeat-user" })),
    { META_APP_SECRET: "meta-secret", META_APP_ID: "meta-app-123", META_DELETION_CONFIRMATION_SECRET: "confirmation-secret", SUPABASE_URL: "https://ai.banhmique.vn" },
    {
      registerDeletionRequest: async (input) => {
        requestFingerprint.add(input.requestFingerprint);
        confirmationHashes.add(input.confirmationCodeHash);
        return { status: "completed", confirmationCodeHash: input.confirmationCodeHash };
      },
    },
  );
  const second = await handleDataDeletionCallback(
    formRequest(signedRequest({ algorithm: "HMAC-SHA256", app_id: "meta-app-123", user_id: "repeat-user" })),
    { META_APP_SECRET: "meta-secret", META_APP_ID: "meta-app-123", META_DELETION_CONFIRMATION_SECRET: "confirmation-secret", SUPABASE_URL: "https://ai.banhmique.vn" },
    {
      registerDeletionRequest: async (input) => {
        requestFingerprint.add(input.requestFingerprint);
        confirmationHashes.add(input.confirmationCodeHash);
        return { status: "completed", confirmationCodeHash: input.confirmationCodeHash, repeated: true };
      },
    },
  );

  assert.equal(requestFingerprint.size, 1);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.match(firstBody.confirmation_code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(secondBody.confirmation_code, firstBody.confirmation_code);
  assert.equal(secondBody.url, firstBody.url);
  assert.equal(confirmationHashes.size, 1);
  assert.equal(firstBody.url, `https://ai.banhmique.vn/functions/v1/facebook-data-deletion/status?code=${firstBody.confirmation_code}`);
});

test("status endpoint defaults to browser-usable Vietnamese HTML and returns JSON only when explicitly requested", async () => {
  const response = await handleStatusRequest(new Request("https://ai.banhmique.vn/functions/v1/facebook-data-deletion/status?code=opaque-confirmation-code"), {
    lookupDeletionStatus: async (confirmationCodeHash) => {
      assert.match(confirmationCodeHash, /^[0-9a-f]{64}$/);
      return { status: "pending_manual_mapping", requested_at: "2026-09-03T00:00:00.000Z", completed_at: null };
    },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  const html = await response.text();
  assert.match(html, /lang="vi"/i);
  assert.match(html, /pending_manual_mapping|đối chiếu thủ công/i);
  assert.match(html, /2026-09-03T00:00:00.000Z/);
  assert.equal(/psid|app_scoped_user_id|message_text|payload|opaque-confirmation-code/i.test(html), false);

  const jsonResponse = await handleStatusRequest(new Request("https://ai.banhmique.vn/functions/v1/facebook-data-deletion/status?code=opaque-confirmation-code&format=json"), {
    lookupDeletionStatus: async () => ({ status: "completed", requested_at: "2026-09-03T00:00:00.000Z", completed_at: "2026-09-03T00:05:00.000Z" }),
  });
  assert.match(jsonResponse.headers.get("content-type") || "", /application\/json/);
  const body = await jsonResponse.json();
  assert.deepEqual(Object.keys(body).sort(), ["completed_at", "requested_at", "status"]);
});

test("SQL registers mapped deletions transactionally, deletes exact mapped Messenger data, preserves codes, and never completes unmapped requests", () => {
  const sql = text(SQL);

  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.facebook_register_data_deletion_request/i);
  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.facebook_lookup_data_deletion_status/i);
  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.facebook_apply_messenger_retention/i);
  assert.match(sql, /security\s+definer/i);
  assert.match(sql, /set\s+search_path\s*=\s*public,\s*extensions/i);
  assert.match(sql, /from\s+public\.facebook_platform_identities[\s\S]*app_scoped_user_id[\s\S]*verified_at\s+is\s+not\s+null/i);
  assert.match(sql, /create\s+temporary\s+table[\s\S]*facebook_data_deletion_mapped_conversation_ids[\s\S]*conversation_id\s+uuid\s+not\s+null/i);
  assert.match(sql, /create\s+temporary\s+table[\s\S]*facebook_data_deletion_mapped_message_ids[\s\S]*message_id\s+uuid\s+not\s+null/i);
  assert.match(sql, /insert\s+into\s+pg_temp\.facebook_data_deletion_mapped_conversation_ids[\s\S]*from\s+public\.facebook_messenger_conversations/i);
  assert.match(sql, /insert\s+into\s+pg_temp\.facebook_data_deletion_mapped_message_ids[\s\S]*from\s+public\.facebook_messenger_messages/i);
  assert.match(sql, /delete\s+from\s+public\.facebook_messenger_email_outbox\s+eo[\s\S]*eo\.conversation_id\s+in\s*\([\s\S]*facebook_data_deletion_mapped_conversation_ids[\s\S]*or\s+eo\.message_id\s+in\s*\([\s\S]*facebook_data_deletion_mapped_message_ids/i);
  assert.match(sql, /status\s*=\s*'pending_manual_mapping'/i);
  assert.doesNotMatch(sql, /set\s+confirmation_code_hash\s*=\s*(excluded\.|p_confirmation_code_hash)/i);
  assert.match(sql, /on\s+conflict\s*\(request_fingerprint\)[\s\S]{0,220}do\s+nothing/i);
  assert.match(sql, /if\s+v_request\.status\s*=\s*'completed'[\s\S]*return\s+query/i);
  for (const table of [
    'facebook_messenger_email_outbox',
    'facebook_messenger_outbox',
    'facebook_messenger_messages',
    'facebook_messenger_webhook_events',
    'facebook_platform_identities',
    'facebook_messenger_conversations',
  ]) {
    assert.match(sql, new RegExp(`delete\\s+from\\s+public\\.${table}`, 'i'));
  }
  assert.match(sql, /set[\s\S]*app_scoped_user_id\s*=\s*null[\s\S]*page_id\s*=\s*null[\s\S]*psid\s*=\s*null[\s\S]*status\s*=\s*'completed'/i);
  assert.match(sql, /set[\s\S]*status\s*=\s*'pending_manual_mapping'[\s\S]*app_scoped_user_id\s*=\s*p_app_scoped_user_id/i);
  assert.match(sql, /request_fingerprint\s*=\s*p_request_fingerprint/i);
  assert.match(sql, /for\s+update/i);
});

test("SQL exposes only service-role registration/retention RPCs and an anon-safe status RPC", () => {
  const sql = text(SQL);

  assert.doesNotMatch(sql, /confirmation_code\s+text/i);
  assert.match(sql, /confirmation_code_hash\s+text/i);
  assert.match(sql, /revoke\s+all\s+on\s+function\s+public\.facebook_register_data_deletion_request[\s\S]*from\s+public,\s*anon,\s*authenticated/i);
  assert.match(sql, /grant\s+execute\s+on\s+function\s+public\.facebook_register_data_deletion_request[\s\S]*to\s+service_role/i);
  assert.match(sql, /grant\s+execute\s+on\s+function\s+public\.facebook_lookup_data_deletion_status[\s\S]*to\s+anon/i);
  const statusFunction = sql.slice(sql.indexOf("create or replace function public.facebook_lookup_data_deletion_status"));
  const statusReturns = statusFunction.slice(0, statusFunction.indexOf("language sql"));
  assert.match(statusReturns, /returns\s+table\s*\(\s*status\s+text,\s*requested_at\s+timestamptz,\s*completed_at\s+timestamptz\s*\)/i);
  assert.doesNotMatch(statusReturns, /psid|app_scoped_user_id|message_text|payload/i);
  assert.match(sql, /p_dry_run\s+boolean\s+default\s+true/i);
  assert.match(sql, /p_enabled\s+boolean\s+default\s+false/i);
  assert.doesNotMatch(sql, /cron\.schedule|pg_cron/i);
});

test("Supabase config publicly exposes Meta data deletion callback with in-code signed_request verification", () => {
  const config = text(CONFIG);
  const section = config.match(/#.*signed_request.*\n\[functions\.facebook-data-deletion\]\s*\nverify_jwt\s*=\s*false/i)?.[0] || "";

  assert.match(config, /\[functions\.facebook-data-deletion\]/i);
  assert.match(section, /Meta/i);
  assert.match(section, /signed_request/i);
  assert.match(section, /verif/i);
  assert.match(section, /verify_jwt\s*=\s*false/i);
});

test("retention email-outbox dry-run candidates match deletion predicates for aged, message, and conversation references", () => {
  const sql = text(SQL);
  const retention = sql.slice(sql.indexOf("create or replace function public.facebook_apply_messenger_retention"));
  const dryRunEmailCount = retention.match(/select\s+count\(\*\)\s+into\s+v_email_outbox[\s\S]*?from\s+public\.facebook_messenger_email_outbox\s+eo[\s\S]*?where\s+([\s\S]*?);/i)?.[1] || "";
  const deleteEmail = retention.match(/delete\s+from\s+public\.facebook_messenger_email_outbox\s+eo[\s\S]*?where\s+([\s\S]*?);\s*get\s+diagnostics\s+v_email_outbox/i)?.[1] || "";

  for (const predicate of [dryRunEmailCount, deleteEmail]) {
    assert.match(predicate, /eo\.created_at\s*<\s*v_cutoff/i);
    assert.match(predicate, /eo\.message_id\s+in\s*\(\s*select\s+message_id\s+from\s+pg_temp\.facebook_retention_candidate_message_ids/i);
    assert.match(predicate, /eo\.conversation_id\s+in\s*\(\s*select\s+conversation_id\s+from\s+pg_temp\.facebook_retention_candidate_conversation_ids/i);
  }
  assert.match(retention, /create\s+temporary\s+table[\s\S]*facebook_retention_candidate_conversation_ids/i);
  assert.match(retention, /create\s+temporary\s+table[\s\S]*facebook_retention_candidate_message_ids/i);
  assert.match(retention, /delete\s+from\s+public\.facebook_messenger_email_outbox[\s\S]*delete\s+from\s+public\.facebook_messenger_messages[\s\S]*delete\s+from\s+public\.facebook_messenger_conversations/i);
});

test("privacy and deletion pages are public, BMQ-branded, Vietnamese-first, and avoid unapproved fixed retention promises", () => {
  const privacy = text(PRIVACY);
  const deletion = text(DELETION_PAGE);
  const combined = `${privacy}\n${deletion}`;

  assert.match(privacy, /lang="vi"/i);
  assert.match(privacy, /Bánh Mì Que|BMQ/i);
  for (const required of ["PSID", "nhãn hiển thị", "nội dung tin nhắn", "metadata", "thời điểm", "phản hồi của nhân viên"]) {
    assert.match(privacy, new RegExp(required, "i"));
  }
  assert.match(privacy, /email bridge|cầu nối email|hộp thư/i);
  assert.match(privacy, /chưa được chủ sở hữu phê duyệt thời hạn lưu trữ|retention duration has not been approved/i);
  assert.doesNotMatch(privacy, /\b(30|60|90|180|365)\s*(ngày|days)\b/i);
  assert.match(privacy, /xóa dữ liệu|deletion/i);
  assert.match(privacy, /bảo mật|security/i);
  assert.match(privacy, /liên hệ|contact/i);

  assert.match(deletion, /lang="vi"/i);
  assert.match(deletion, /confirmation code|mã xác nhận/i);
  assert.match(deletion, /URLSearchParams\(window\.location\.search\)/);
  assert.match(deletion, /functions\/v1\/facebook-data-deletion\/status/i);
  assert.doesNotMatch(deletion, /fetch\(\s*[`'"]\/functions\/v1/i);
  assert.match(deletion, /đường dẫn trạng thái chính xác/i);
  assert.doesNotMatch(deletion, /psid|app_scoped_user_id|message_text/i);
  assert.match(combined, /không cần đăng nhập|no login/i);
});

test("source contract does not log raw payload, identifiers, or secrets", () => {
  const source = text(INDEX);
  assert.doesNotMatch(source, /console\.(log|info|warn|error)/);
  assert.doesNotMatch(source, /callback_payload\s*:/);
  assert.doesNotMatch(source, /rawPayload/);
});
