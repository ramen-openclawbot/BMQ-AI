import assert from "node:assert/strict";
import test from "node:test";

import { GmailSendError } from "../_shared/gmail-send.ts";
import { GMAIL_RECONNECT_CODES, sendFailureCode } from "./failure.ts";

test("token_refresh_failed maps to gmail_reconnect_needed", () => {
  assert.equal(
    sendFailureCode(new GmailSendError("gmail_token_refresh_failed")),
    "gmail_reconnect_needed",
  );
});

test("refresh_token_missing maps to gmail_reconnect_needed", () => {
  assert.equal(
    sendFailureCode(new GmailSendError("gmail_refresh_token_missing")),
    "gmail_reconnect_needed",
  );
});

test("network_error maps to email_failed", () => {
  assert.equal(
    sendFailureCode(new GmailSendError("gmail_network_error")),
    "email_failed",
  );
});

test("an unknown error maps to email_failed", () => {
  assert.equal(sendFailureCode(new Error("boom")), "email_failed");
  assert.equal(sendFailureCode(null), "email_failed");
});

test("the reconnect code set matches the Gmail token failures", () => {
  assert.ok(GMAIL_RECONNECT_CODES.has("gmail_token_refresh_failed"));
  assert.ok(GMAIL_RECONNECT_CODES.has("gmail_refresh_token_missing"));
});
