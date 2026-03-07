import { useQuery } from "@tanstack/react-query";
import { format, startOfMonth, endOfMonth, subDays } from "date-fns";
import { supabase } from "@/integrations/supabase/client";

// ---------------------------------------------------------------------------
// Shared stale-time constants
// ---------------------------------------------------------------------------
/** Daily declaration data doesn't change frequently – cache for 5 min.
 *  Previously 30 s, which caused visible loading spinner on every date
 *  navigation after 30 s of inactivity. */
const DAILY_STALE_MS = 5 * 60_000;
/** Monthly aggregates are even more stable – 5 min */
const MONTHLY_STALE_MS = 5 * 60_000;
/** Keep unused cache entries for 15 min before GC (user often navigates
 *  back to recent dates – longer GC avoids unnecessary re-fetches) */
const GC_TIME_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Columns we actually need from ceo_daily_closing_declarations for the
// *daily* view.  Importantly we EXCLUDE the heavy base64 image columns
// (qtm_slip_image_base64, unc_slip_image_base64) from the initial fetch.
// Images are loaded lazily via useDailyDeclarationImages().
// ---------------------------------------------------------------------------
const DECLARATION_LIGHT_COLS = [
  "closing_date",
  "unc_total_declared",
  "unc_extracted_amount",
  "cash_fund_topup_amount",
  "qtm_extracted_amount",
  "notes",
  "extraction_meta",
].join(",");

// ---------------------------------------------------------------------------
// 1. Daily CEO declaration – lightweight (no images)
// ---------------------------------------------------------------------------
export function useDailyDeclaration(closingDate: Date) {
  const date = format(closingDate, "yyyy-MM-dd");

  return useQuery({
    queryKey: ["daily-declaration", date],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select(DECLARATION_LIGHT_COLS)
        .eq("closing_date", date)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    },
    staleTime: DAILY_STALE_MS,
    gcTime: GC_TIME_MS,
    placeholderData: (previous) => previous,
  });
}

// ---------------------------------------------------------------------------
// 1b. Lazy image loader – only fetched when user wants to see slip previews
// ---------------------------------------------------------------------------
export function useDailyDeclarationImages(closingDate: Date, enabled: boolean) {
  const date = format(closingDate, "yyyy-MM-dd");

  return useQuery({
    queryKey: ["daily-declaration-images", date],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select("qtm_slip_image_base64,unc_slip_image_base64,extraction_meta")
        .eq("closing_date", date)
        .maybeSingle();

      if (error) throw error;
      if (!data) return { qtmImages: [] as string[], uncImages: [] as string[] };

      const qtmImages: string[] = Array.isArray(data.extraction_meta?.qtm_images)
        ? data.extraction_meta.qtm_images
        : data.qtm_slip_image_base64
          ? [data.qtm_slip_image_base64]
          : [];

      const uncImages: string[] = Array.isArray(data.extraction_meta?.unc_images)
        ? data.extraction_meta.unc_images
        : data.unc_slip_image_base64
          ? [data.unc_slip_image_base64]
          : [];

      return { qtmImages, uncImages };
    },
    enabled,
    staleTime: DAILY_STALE_MS,
    gcTime: GC_TIME_MS,
  });
}

// ---------------------------------------------------------------------------
// 2. UNC detail amount – OPTIMISED: single query with .or() filter
// ---------------------------------------------------------------------------
export function useUncDetailAmount(closingDate: Date) {
  const date = format(closingDate, "yyyy-MM-dd");

  return useQuery({
    queryKey: ["unc-detail-amount", date],
    queryFn: async () => {
      const startUtc = new Date(`${date}T00:00:00+07:00`).toISOString();
      const endUtc = new Date(`${date}T23:59:59.999+07:00`).toISOString();

      // Single query: fetch all bank_transfer payment_requests that fall
      // within the date range by created_at.  We also join invoices to get
      // any with matching invoice_date for the union logic.
      const { data: rows, error } = await (supabase as any)
        .from("payment_requests")
        .select("id,total_amount,title,description,notes,image_url,created_at,invoices!payment_requests_invoice_id_fkey(invoice_date)")
        .eq("payment_method", "bank_transfer")
        .or(`and(created_at.gte.${startUtc},created_at.lte.${endUtc}),invoices.invoice_date.eq.${date}`);

      if (error) {
        // Fallback: if the .or() with nested filter fails (some PostgREST
        // versions don't support cross-table .or), fall back to the original
        // two-query approach.
        return await uncDetailAmountFallback(date, startUtc, endUtc);
      }

      const isLikelyQtm = (row: any) => {
        const haystack = [row?.title, row?.description, row?.notes, row?.image_url]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return /(^|\W)qtm($|\W)|quỹ\s*tiền\s*mặt|quy\s*tien\s*mat|cash\s*fund/i.test(haystack);
      };

      const merged = new Map<string, number>();
      for (const row of (rows || []) as any[]) {
        if (isLikelyQtm(row)) continue;
        // Deduplicate by id
        if (!merged.has(row.id)) {
          merged.set(row.id, Number(row.total_amount || 0));
        }
      }

      return Array.from(merged.values()).reduce((sum, amount) => sum + amount, 0);
    },
    staleTime: DAILY_STALE_MS,
    gcTime: GC_TIME_MS,
    placeholderData: (previous) => previous,
  });
}

/** Original two-query approach used as fallback */
async function uncDetailAmountFallback(date: string, startUtc: string, endUtc: string): Promise<number> {
  const [byCreatedAtRes, byInvoiceDateRes] = await Promise.all([
    supabase
      .from("payment_requests")
      .select("id,total_amount,title,description,notes,image_url")
      .eq("payment_method", "bank_transfer")
      .gte("created_at", startUtc)
      .lte("created_at", endUtc),
    (supabase as any)
      .from("payment_requests")
      .select("id,total_amount,title,description,notes,image_url,invoices!payment_requests_invoice_id_fkey(invoice_date)")
      .eq("payment_method", "bank_transfer")
      .eq("invoices.invoice_date", date),
  ]);

  if (byCreatedAtRes.error) throw byCreatedAtRes.error;
  if (byInvoiceDateRes.error) throw byInvoiceDateRes.error;

  const isLikelyQtm = (row: any) => {
    const haystack = [row?.title, row?.description, row?.notes, row?.image_url]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /(^|\W)qtm($|\W)|quỹ\s*tiền\s*mặt|quy\s*tien\s*mat|cash\s*fund/i.test(haystack);
  };

  const merged = new Map<string, number>();
  for (const row of (byCreatedAtRes.data || []) as any[]) {
    if (isLikelyQtm(row)) continue;
    merged.set(row.id, Number(row.total_amount || 0));
  }
  for (const row of (byInvoiceDateRes.data || []) as any[]) {
    if (isLikelyQtm(row)) continue;
    if (!merged.has(row.id)) merged.set(row.id, Number(row.total_amount || 0));
  }

  return Array.from(merged.values()).reduce((sum, amount) => sum + amount, 0);
}

// ---------------------------------------------------------------------------
// 3. Daily reconciliation row
// ---------------------------------------------------------------------------
export function useDailyReconciliation(closingDate: Date) {
  const date = format(closingDate, "yyyy-MM-dd");

  return useQuery({
    queryKey: ["daily-reconciliation", date],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("daily_reconciliations")
        .select("*")
        .eq("closing_date", date)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    },
    staleTime: DAILY_STALE_MS,
    gcTime: GC_TIME_MS,
    placeholderData: (previous) => previous,
  });
}

// ---------------------------------------------------------------------------
// 4. Monthly reconciliation – now accepts `enabled` flag for lazy loading
// ---------------------------------------------------------------------------
export function useMonthlyReconciliation(month: Date, enabled = true) {
  const start = format(startOfMonth(month), "yyyy-MM-dd");
  const end = format(endOfMonth(month), "yyyy-MM-dd");

  return useQuery({
    queryKey: ["monthly-reconciliation", format(month, "yyyy-MM")],
    enabled,
    queryFn: async () => {
      // For monthly declarations we only need lightweight columns (no images)
      const MONTHLY_DECL_COLS = "closing_date,unc_total_declared,unc_extracted_amount,extraction_meta";

      const [reconRes, declarationRes] = await Promise.all([
        (supabase as any)
          .from("daily_reconciliations")
          .select("*")
          .gte("closing_date", start)
          .lte("closing_date", end)
          .order("closing_date", { ascending: true }),
        (supabase as any)
          .from("ceo_daily_closing_declarations")
          .select(MONTHLY_DECL_COLS)
          .gte("closing_date", start)
          .lte("closing_date", end),
      ]);

      if (reconRes.error) throw reconRes.error;
      if (declarationRes.error) throw declarationRes.error;

      const declarationMap = new Map<string, any>();
      for (const d of (declarationRes.data || []) as any[]) {
        declarationMap.set(String(d.closing_date), d);
      }

      const reconMap = new Map<string, any>();
      for (const r of (reconRes.data || []) as any[]) {
        reconMap.set(String(r.closing_date), r);
      }

      const allDates = new Set<string>([
        ...Array.from(reconMap.keys()),
        ...Array.from(declarationMap.keys()),
      ]);

      const rows = Array.from(allDates)
        .sort((a, b) => a.localeCompare(b))
        .map((closingDate) => {
          const r = reconMap.get(closingDate) || null;
          const decl = declarationMap.get(closingDate) || null;
          const folderTotal = Number(decl?.extraction_meta?.unc_folder_total || 0);
          const declared = Number(decl?.unc_extracted_amount || decl?.unc_total_declared || r?.unc_declared_amount || 0);

          const resolvedUncDetail = folderTotal > 0 ? folderTotal : Number(r?.unc_detail_amount || 0);
          const resolvedVariance = resolvedUncDetail - declared;
          const resolvedStatus = r?.status
            || (decl ? (Math.abs(resolvedVariance) === 0 ? "match" : "pending") : "pending");

          return {
            ...(r || { closing_date: closingDate }),
            closing_date: closingDate,
            unc_detail_amount: resolvedUncDetail,
            unc_declared_amount: declared,
            variance_amount: resolvedVariance,
            status: resolvedStatus,
          };
        });

      const totalUncDetail = rows.reduce((s: number, r: any) => s + Number(r.unc_detail_amount || 0), 0);
      const totalUncDeclared = rows.reduce((s: number, r: any) => s + Number(r.unc_declared_amount || 0), 0);
      const netVariance = rows.reduce((s: number, r: any) => s + Number(r.variance_amount || 0), 0);
      const matchDays = rows.filter((r: any) => r.status === "match").length;

      return {
        rows,
        totalUncDetail,
        totalUncDeclared,
        netVariance,
        matchDays,
        totalDays: rows.length,
      };
    },
    staleTime: MONTHLY_STALE_MS,
    gcTime: GC_TIME_MS,
  });
}

// ---------------------------------------------------------------------------
// 5. QTM Opening Balance – dedicated cached hook (replaces raw useEffect)
// ---------------------------------------------------------------------------
export function useQtmOpeningBalance(closingDate: Date, currentDeclExtractionMeta: any) {
  const date = format(closingDate, "yyyy-MM-dd");
  const prevDate = format(subDays(closingDate, 1), "yyyy-MM-dd");

  return useQuery({
    queryKey: ["qtm-opening-balance", date],
    queryFn: async () => {
      const toNumberOrNull = (v: any): number | null => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      const deriveClosingFromRow = (row: any): number | null => {
        if (!row) return null;
        const explicitClosing = toNumberOrNull(row?.extraction_meta?.qtm_closing_balance);
        if (explicitClosing !== null) return explicitClosing;

        const opening = toNumberOrNull(row?.extraction_meta?.qtm_opening_balance);
        const spent = toNumberOrNull(row?.extraction_meta?.qtm_spent_from_folder);
        const topup = toNumberOrNull(row?.qtm_extracted_amount) ?? toNumberOrNull(row?.cash_fund_topup_amount);
        if (opening !== null || spent !== null || topup !== null) {
          return Number(opening || 0) + Number(topup || 0) - Number(spent || 0);
        }
        return null;
      };

      // Run both lookups in parallel – avoids waterfall when prevDay has no data.
      // 1) Exact previous day  2) Nearest previous day before selected date
      const [prevResult, nearestPrevResult] = await Promise.all([
        (supabase as any)
          .from("ceo_daily_closing_declarations")
          .select("closing_date,cash_fund_topup_amount,qtm_extracted_amount,extraction_meta")
          .eq("closing_date", prevDate)
          .maybeSingle(),
        (supabase as any)
          .from("ceo_daily_closing_declarations")
          .select("closing_date,cash_fund_topup_amount,qtm_extracted_amount,extraction_meta")
          .lt("closing_date", date)
          .order("closing_date", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (prevResult.error) {
        console.error("[useQtmOpeningBalance] Error fetching previous day:", prevResult.error);
        throw prevResult.error;
      }
      if (nearestPrevResult.error) {
        console.error("[useQtmOpeningBalance] Error fetching nearest previous:", nearestPrevResult.error);
        throw nearestPrevResult.error;
      }

      // Apply same precedence: exact prev day first, then nearest
      const prevClosing = deriveClosingFromRow(prevResult.data);
      if (prevClosing !== null) return prevClosing;

      const nearestPrevClosing = deriveClosingFromRow(nearestPrevResult.data);
      if (nearestPrevClosing !== null) return nearestPrevClosing;

      // Fallback: use stored opening from current declaration
      const currentStoredOpening = toNumberOrNull(currentDeclExtractionMeta?.qtm_opening_balance);
      return Number(currentStoredOpening || 0);
    },
    staleTime: DAILY_STALE_MS,
    gcTime: GC_TIME_MS,
    placeholderData: (previous) => previous,
  });
}
