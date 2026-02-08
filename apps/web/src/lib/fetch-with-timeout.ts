/**
 * Wraps a fetch call with a timeout to prevent infinite loading states.
 * Used because Supabase functions.invoke can hang indefinitely on Safari.
 */

const DEFAULT_TIMEOUT = 60000; // 60 seconds default

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Response type for edge function calls with session status
 */
export interface EdgeFunctionResponse<T> {
  data: T | null;
  error: string | null;
  isSessionExpired?: boolean;
}

/**
 * Helper to wrap any promise with a timeout.
 * Returns null if the promise times out or rejects.
 */
export async function withAuthTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = 8000
): Promise<T | null> {
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Auth timeout")), timeoutMs)
      ),
    ]);
  } catch (err) {
    console.error("withAuthTimeout failed:", err);
    return null;
  }
}

/**
 * Helper to call Supabase Edge Functions with timeout.
 * Returns parsed JSON response or throws error.
 * Also detects session expiration (401 responses).
 */
export async function callEdgeFunction<T>(
  functionName: string,
  body: Record<string, unknown>,
  token: string,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<EdgeFunctionResponse<T>> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  
  if (!supabaseUrl) {
    return { data: null, error: 'SUPABASE_URL not configured' };
  }

  try {
    const response = await fetchWithTimeout(
      `${supabaseUrl}/functions/v1/${functionName}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
      timeoutMs
    );

    // Detect session expiration
    if (response.status === 401) {
      return { 
        data: null, 
        error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
        isSessionExpired: true
      };
    }

    const data = await response.json();

    if (!response.ok) {
      return { 
        data: null, 
        error: data.error || data.message || `HTTP ${response.status}` 
      };
    }

    return { data, error: null };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { data: null, error: 'Đã quá thời gian chờ. Vui lòng thử lại.' };
      }
      return { data: null, error: error.message };
    }
    return { data: null, error: 'Unknown error' };
  }
}
