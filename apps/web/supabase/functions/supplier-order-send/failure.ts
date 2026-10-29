import { GmailSendError } from "../_shared/gmail-send.ts";

// A revoked/expired order@bmq.vn connection needs an admin to reconnect; a
// retry by the orderer cannot fix it, so it gets its own code.
export const GMAIL_RECONNECT_CODES = new Set([
  "gmail_token_refresh_failed",
  "gmail_refresh_token_missing",
  "gmail_access_token_missing",
  "gmail_unauthorized",
]);

export function sendFailureCode(error: unknown): string {
  return error instanceof GmailSendError && GMAIL_RECONNECT_CODES.has(error.code)
    ? "gmail_reconnect_needed"
    : "email_failed";
}
