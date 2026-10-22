import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceClient, timingSafeEqual } from "../_shared/dealer.ts";
import {
  VIETCOMBANK_RATES_URL,
  parseUsdTransferRate,
  resolveSyncWindow,
} from "./rates.ts";

type FxRateRow = {
  rate_date: string;
  currency: "USD";
  vnd_per_usd: number;
  source: "vietcombank_transfer";
  fetched_at: string;
};

type SyncError = {
  date: string | null;
  error: string;
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FETCH_DELAY_MS = 150;
const FETCH_TIMEOUT_MS = 15_000;

const authorized = async (
  req: Request,
  serviceRoleKey: string,
  supabase: ReturnType<typeof createServiceClient>,
) => {
  const authorization = req.headers.get("authorization") || "";
  const suppliedBearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (suppliedBearer && timingSafeEqual(suppliedBearer, serviceRoleKey)) return true;

  const cronSecret = Deno.env.get("CRON_SECRET") || "";
  const suppliedCronSecret = req.headers.get("x-cron-secret") || "";
  if (cronSecret && suppliedCronSecret && timingSafeEqual(suppliedCronSecret, cronSecret)) return true;

  const suppliedWorkerSecret = req.headers.get("x-worker-secret") || "";
  if (!suppliedWorkerSecret) return false;

  const { data, error } = await supabase
    .from("finance_zalo_notification_config")
    .select("worker_secret")
    .eq("id", "finance-zalo")
    .maybeSingle();
  const storedWorkerSecret = String(data?.worker_secret || "");
  return !error && Boolean(storedWorkerSecret) &&
    timingSafeEqual(suppliedWorkerSecret, storedWorkerSecret);
};

const fetchVietcombankRate = async (date: string): Promise<number | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${VIETCOMBANK_RATES_URL}?date=${encodeURIComponent(date)}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`vietcombank_http_${response.status}`);

    const payload = await response.json();
    return parseUsdTransferRate(payload);
  } finally {
    clearTimeout(timeout);
  }
};

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ ok: false, error: "service_role_not_configured" }, 503);

  const supabase = createServiceClient();
  if (!await authorized(req, serviceRoleKey, supabase)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // Empty body means the default "today + previous 7 days" window.
  }

  const window = resolveSyncWindow(body);
  if (!window.ok) {
    return json({ ok: false, error: window.error, upserted: 0, skipped: 0, errors: [] }, 400);
  }

  const rows: FxRateRow[] = [];
  const errors: SyncError[] = [];
  let skipped = 0;

  for (let index = 0; index < window.dates.length; index += 1) {
    const date = window.dates[index];
    try {
      const rate = await fetchVietcombankRate(date);
      if (rate === null) {
        // Weekend/holiday payloads without a USD row are expected; the worker
        // stores only what Vietcombank actually returns for the requested date.
        skipped += 1;
      } else {
        rows.push({
          rate_date: date,
          currency: "USD",
          vnd_per_usd: rate,
          source: "vietcombank_transfer",
          fetched_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      errors.push({
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (index < window.dates.length - 1) await sleep(FETCH_DELAY_MS);
  }

  let upserted = 0;
  if (rows.length > 0) {
    const { error } = await supabase
      .from("finance_fx_rates")
      .upsert(rows, { onConflict: "rate_date" });

    if (error) {
      errors.push({ date: null, error: error.message });
    } else {
      upserted = rows.length;
    }
  }

  return json({ ok: errors.length === 0, upserted, skipped, errors });
});
