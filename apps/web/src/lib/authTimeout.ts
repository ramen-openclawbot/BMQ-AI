/**
 * Bound an auth promise that may never settle.
 *
 * The login callback awaits Supabase auth calls directly (the client sets
 * `detectSessionInUrl: false`, so the app owns the callback exchange). Supabase
 * serialises auth work behind one in-process lock, so a single call that never
 * settles — stuck network request or a Safari `navigator.locks` deadlock —
 * hangs every later SDK call and leaves the login spinner up forever. Bounding
 * the first awaited call makes that failure recoverable.
 *
 * This module is intentionally dependency-free (no React, no Supabase).
 */

/** Default bound for a single awaited auth call. */
export const AUTH_CALL_TIMEOUT_MS = 8000;

export function withAuthTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = AUTH_CALL_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("auth-timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
