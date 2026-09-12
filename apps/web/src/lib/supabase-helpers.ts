import { supabase } from "@/integrations/supabase/client";
import { SessionExpiredError } from "@/lib/session-errors";
export { SessionExpiredError } from "@/lib/session-errors";

// Helper to bypass type checking for tables not yet in generated types
 
export const db = supabase as any;

/**
 * Ensure a fresh access token before calling edge functions.
 *
 * `supabase.auth.getSession()` returns the cached token from memory and does
 * NOT refresh it if expired → edge functions with `verify_jwt = true` reject
 * with "Invalid JWT" (401).
 *
 * This helper calls `refreshSession()` which contacts the auth server to
 * refresh the token if needed, then returns the valid access token string.
 *
 * @throws SessionExpiredError if the session cannot be refreshed.
 */
export async function getFreshAccessToken(): Promise<string> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session?.access_token) {
    throw new SessionExpiredError();
  }
  return data.session.access_token;
}
