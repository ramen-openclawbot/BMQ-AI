/**
 * Session recovery utilities for Safari deadlock prevention
 * 
 * CRITICAL: This file must NOT import Supabase client or any module that does.
 * It's used in recovery scenarios where Supabase may be deadlocked.
 */

const SESSION_PREFIXES = ['sb-', 'supabase'];
const APP_PREFIXES = ['bmq_'];

/**
 * Get all localStorage keys that should be cleared for session recovery
 */
export function getSessionKeys(): string[] {
  const keysToRemove: string[] = [];
  
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      const shouldRemove = 
        SESSION_PREFIXES.some(prefix => key.startsWith(prefix)) ||
        SESSION_PREFIXES.some(prefix => key.includes(prefix)) ||
        APP_PREFIXES.some(prefix => key.startsWith(prefix));
      
      if (shouldRemove) {
        keysToRemove.push(key);
      }
    }
  }
  
  return keysToRemove;
}

/**
 * Clear all session-related localStorage keys
 */
export function clearSessionStorage(): string[] {
  const keysToRemove = getSessionKeys();
  keysToRemove.forEach(key => localStorage.removeItem(key));
  console.info('[session-utils] Cleared session keys:', keysToRemove);
  return keysToRemove;
}

/**
 * Clear session storage and redirect to auth page
 * This is the canonical recovery action used by:
 * - RecoveryScreen (/recover route)
 * - SessionRecoveryOverlay (automatic detection)
 * - AuthBootstrapFailed (initial load timeout)
 */
export function clearSessionAndRedirect(): void {
  clearSessionStorage();
  window.location.href = '/auth';
}

/**
 * Clear session storage and reload current page
 * Use this when you want to stay on the same page after recovery
 */
export function clearSessionAndReload(): void {
  clearSessionStorage();
  window.location.reload();
}

/**
 * Check if there's a potential stuck session
 * (localStorage has session keys but we can't retrieve them)
 */
export function hasStoredSession(): boolean {
  const keys = getSessionKeys();
  return keys.some(key => 
    key.startsWith('sb-') && key.includes('-auth-token')
  );
}
