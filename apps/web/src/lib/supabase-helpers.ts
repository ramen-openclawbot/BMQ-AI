import { supabase } from "@/integrations/supabase/client";

// Helper to bypass type checking for tables not yet in generated types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 * @throws Error if the session cannot be refreshed (user must log in again).
 */
export async function getFreshAccessToken(): Promise<string> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session?.access_token) {
    throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
  }
  return data.session.access_token;
}
