// Public reference FX only. No BMQ data, credentials or user-selected URLs leave this module.
export type FxRate = { vndPerUsd: number; updatedAt: string; source: string };
export const FX_URL = 'https://open.er-api.com/v6/latest/USD';
export const FX_SOURCE = 'https://www.exchangerate-api.com';
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
export function createFxLoader(fetcher: typeof fetch = fetch, now = () => Date.now()) {
  let cached: FxRate | undefined, refreshAt = 0, retryAt = 0;
  return async (signal: AbortSignal): Promise<FxRate | null> => {
    const time = now();
    const fresh = cached && time - Date.parse(cached.updatedAt) <= MAX_AGE_MS;
    if (fresh && time < refreshAt) return cached!;
    if (time < retryAt) return fresh ? cached! : null;
    try {
      const abort = AbortSignal.any([signal, AbortSignal.timeout(2500)]);
      const res = await fetcher(FX_URL, { signal: abort, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } });
      if (!res.ok || !res.body) throw Error('fx_unavailable');
      const reader = res.body.getReader();
      let text = '', size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 64000) { await reader.cancel(); throw Error('fx_oversized'); }
          text += decoder.decode(part.value, { stream: true });
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(text + decoder.decode());
      const timestamp = data.time_last_update_unix * 1000;
      const rate = data.rates?.VND;
      if (data.result !== 'success' || data.base_code !== 'USD' || data.provider !== FX_SOURCE
          || typeof rate !== 'number' || !Number.isFinite(rate) || rate < 1000 || rate > 1000000
          || !Number.isSafeInteger(data.time_last_update_unix) || time - timestamp > MAX_AGE_MS || timestamp > time + 300000) throw Error('fx_invalid');
      cached = { vndPerUsd: rate, updatedAt: new Date(timestamp).toISOString(), source: FX_SOURCE };
      // Reference feed updates daily; refresh at most hourly and never extend freshness on a failed refresh.
      refreshAt = time + 3600000;
      return cached;
    } catch {
      signal.throwIfAborted();
      retryAt = time + 60000;
      return fresh ? cached! : null;
    }
  };
}
export const loadFx = createFxLoader();
export function numeric(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value))
      || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER) throw Error('invalid_amount');
  return Number(value);
}
export function formatMoney(value: unknown, currency: string, language: string, fx: FxRate | null) {
  const amount = numeric(value);
  if (currency === 'VND') {
    if (language === 'en' && fx) return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / fx.vndPerUsd);
    return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(amount) + ' ₫';
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw Error('invalid_currency');
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'vi-VN', { style: 'currency', currency }).format(amount);
}
