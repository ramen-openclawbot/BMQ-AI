import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format, startOfMonth, endOfMonth, subDays } from "date-fns";
import { vi } from "date-fns/locale";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
// Dialog removed — 1-click close flow uses inline progress instead
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  useFinanceDailySnapshot,
  useDailyDeclaration,
  useUncDetailAmount,
  useDailyReconciliation,
  useQtmOpeningBalance,
  useDailyDeclarationImages,
  useMonthlyReconciliation,
} from "@/hooks/useFinanceReconciliation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLanguage } from "@/contexts/LanguageContext";
import { Lock, Unlock } from "lucide-react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

const vnd = (value: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value || 0);

const toDateInputValue = (d: Date) => format(d, "yyyy-MM-dd");
const parseDateInputValue = (value: string) => {
  const [y, m, day] = value.split("-").map(Number);
  return new Date(y, (m || 1) - 1, day || 1);
};

async function fileToBase64(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function FinanceControl() {
  const { toast } = useToast();
  const { language } = useLanguage();
  const queryClient = useQueryClient();
  const isVi = language === "vi";
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [debouncedSelectedDate, setDebouncedSelectedDate] = useState<Date>(new Date());
  const [selectedMonth, setSelectedMonth] = useState<Date>(new Date());
  const [activeTab, setActiveTab] = useState<string>("daily");
  const [imagesRequested, setImagesRequested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const [uncSkipProcessed, setUncSkipProcessed] = useState(false);
  const [uncScanImagesOnly, setUncScanImagesOnly] = useState(true);
  const [uncLowConfidenceThreshold, setUncLowConfidenceThreshold] = useState(0.75);
  const [reconcilingFolderScan, setReconcilingFolderScan] = useState(false);
  const [reconcileProgress, setReconcileProgress] = useState({ done: 0, total: 0, currentFile: "" });
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [qtmOpeningBalance, setQtmOpeningBalance] = useState<number>(0);
  const [qtmSpentFromFolder, setQtmSpentFromFolder] = useState<number>(0);
  const [qtmReconciling, setQtmReconciling] = useState(false);
  const [qtmLowConfidenceCount, setQtmLowConfidenceCount] = useState(0);
  const [uncReconSummary, setUncReconSummary] = useState<{
    folderDate: string;
    folderTotal: number;
    ceoTotal: number;
    delta: number;
    status: "match" | "mismatch";
    lowConfidenceCount: number;
    qtmExcludedCount: number;
    totalScannedCount: number;
    processedSkippedCount: number;
    items: Array<{ fileId: string; fileName: string; amount: number; confidence: number; status: "matched" | "mismatch" | "needs_review" }>;
  } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSelectedDate(selectedDate), 200);
    return () => clearTimeout(t);
  }, [selectedDate]);

  const {
    data: dailySnapshot,
    isLoading: snapshotLoading,
    isFetching: snapshotFetching,
    error: dailySnapshotError,
    refetch: refetchDailySnapshot,
  } = useFinanceDailySnapshot(debouncedSelectedDate);

  const snapshotFailed = Boolean(dailySnapshotError);

  const {
    data: fallbackDailyDeclaration,
    isLoading: fallbackDeclLoading,
    isFetching: fallbackDeclFetching,
    error: fallbackDeclarationError,
    refetch: refetchFallbackDeclaration,
  } = useDailyDeclaration(debouncedSelectedDate, snapshotFailed);

  const { data: fallbackUncDetailAmount, error: fallbackUncDetailError, refetch: refetchFallbackUncDetail } = useUncDetailAmount(debouncedSelectedDate, snapshotFailed);
  const { data: fallbackDailyReconciliation, error: fallbackDailyReconError, refetch: refetchFallbackDailyReconciliation } = useDailyReconciliation(debouncedSelectedDate, snapshotFailed);
  const { data: fallbackQtmOpeningBalance, error: fallbackQtmBalanceError } = useQtmOpeningBalance(debouncedSelectedDate, fallbackDailyDeclaration?.extraction_meta, snapshotFailed);

  const dailyDeclaration = snapshotFailed
    ? (fallbackDailyDeclaration || null)
    : (dailySnapshot?.declaration || null);

  const uncDetailAmount = snapshotFailed
    ? Number(fallbackUncDetailAmount || 0)
    : Number(dailySnapshot?.uncDetailAmount || 0);

  const dailyReconciliation = snapshotFailed
    ? (fallbackDailyReconciliation || null)
    : (dailySnapshot?.dailyReconciliation || null);

  const qtmOpeningBalanceFromHook = snapshotFailed
    ? Number(fallbackQtmOpeningBalance || 0)
    : Number(dailySnapshot?.qtmOpeningBalance || 0);

  const declarationLoading = snapshotFailed ? fallbackDeclLoading : snapshotLoading;
  const declarationFetching = snapshotFailed ? fallbackDeclFetching : snapshotFetching;

  const refetchDeclaration = snapshotFailed ? refetchFallbackDeclaration : refetchDailySnapshot;
  const refetchUncDetail = snapshotFailed ? refetchFallbackUncDetail : refetchDailySnapshot;
  const refetchDailyReconciliation = snapshotFailed ? refetchFallbackDailyReconciliation : refetchDailySnapshot;

  const declarationError = snapshotFailed ? fallbackDeclarationError : dailySnapshotError;
  const uncDetailError = snapshotFailed ? fallbackUncDetailError : dailySnapshotError;
  const dailyReconError = snapshotFailed ? fallbackDailyReconError : dailySnapshotError;
  const qtmBalanceError = snapshotFailed ? fallbackQtmBalanceError : dailySnapshotError;

  const { data: monthlySummary, error: monthlyError, refetch: refetchMonthly } = useMonthlyReconciliation(selectedMonth, activeTab === "monthly");
  const { data: declarationImages } = useDailyDeclarationImages(debouncedSelectedDate, imagesRequested);

  // Surface query errors to user via toast (fire once per error)
  useEffect(() => {
    const errors = [
      declarationError && `Khai báo CEO: ${(declarationError as Error).message}`,
      uncDetailError && `UNC chi tiết: ${(uncDetailError as Error).message}`,
      dailyReconError && `Đối soát ngày: ${(dailyReconError as Error).message}`,
      monthlyError && `Chốt tháng: ${(monthlyError as Error).message}`,
      qtmBalanceError && `Số dư QTM: ${(qtmBalanceError as Error).message}`,
    ].filter(Boolean) as string[];

    if (errors.length > 0) {
      toast({
        title: isVi ? "Lỗi tải dữ liệu" : "Data loading error",
        description: errors.join(" • "),
        variant: "destructive",
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [declarationError, uncDetailError, dailyReconError, monthlyError, qtmBalanceError]);

  const [uncTotalDeclared, setUncTotalDeclared] = useState<number>(0);
  const [cashFundTopupAmount, setCashFundTopupAmount] = useState<number>(0);
  const [notes, setNotes] = useState("");
  const [ceoDeclarationLocked, setCeoDeclarationLocked] = useState(false);

  const [qtmSlipPreviews, setQtmSlipPreviews] = useState<string[]>([]);
  const [uncSlipPreviews, setUncSlipPreviews] = useState<string[]>([]);
  const [pendingQtmImagesBase64, setPendingQtmImagesBase64] = useState<string[]>([]);
  const [pendingUncImagesBase64, setPendingUncImagesBase64] = useState<string[]>([]);
  const [pendingQtmExtractedList, setPendingQtmExtractedList] = useState<any[]>([]);
  const [pendingUncExtractedList, setPendingUncExtractedList] = useState<any[]>([]);

  const [closeDecision, setCloseDecision] = useState<"reject" | "conditional" | "approve">("reject");
  const [closeApprovalLocked, setCloseApprovalLocked] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [closeActing, setCloseActing] = useState(false);
  const [reconciliationAuditLogs, setReconciliationAuditLogs] = useState<Array<{ at: string; actor: string; action: string; detail?: string }>>([]);

  useEffect(() => {
    // Guard against transient empty state while query is still loading/refetching,
    // otherwise local form can be reset to zeros and accidentally overwrite DB on save.
    if (dailyDeclaration === undefined || declarationLoading || declarationFetching) return;

    setUncTotalDeclared(Number(dailyDeclaration?.unc_extracted_amount || dailyDeclaration?.unc_total_declared || 0));
    setCashFundTopupAmount(Number(dailyDeclaration?.qtm_extracted_amount || dailyDeclaration?.cash_fund_topup_amount || 0));
    setNotes(String(dailyDeclaration?.notes || ""));
    setCeoDeclarationLocked(Boolean(dailyDeclaration?.extraction_meta?.ceo_declaration_locked));
    setCloseDecision((dailyDeclaration?.extraction_meta?.close_decision as any) || "reject");
    setCloseApprovalLocked(Boolean(dailyDeclaration?.extraction_meta?.close_approval_locked));
    setCloseReason(String(dailyDeclaration?.extraction_meta?.close_reason || ""));
    setReconciliationAuditLogs(Array.isArray(dailyDeclaration?.extraction_meta?.reconciliation_audit_logs)
      ? dailyDeclaration.extraction_meta.reconciliation_audit_logs
      : []);
    setQtmSpentFromFolder(Number(dailyDeclaration?.extraction_meta?.qtm_spent_from_folder || 0));
    setQtmLowConfidenceCount(Number(dailyDeclaration?.extraction_meta?.qtm_low_confidence_count || 0));

    // Images are now loaded lazily via useDailyDeclarationImages – don't extract here.
    // Only clear unsaved local state when data source changes (e.g. switch date)
    setPendingQtmImagesBase64([]);
    setPendingUncImagesBase64([]);
    setPendingQtmExtractedList([]);
    setPendingUncExtractedList([]);
  }, [dailyDeclaration, declarationLoading, declarationFetching]);

  // Populate slip previews from the lazy image hook when it arrives
  useEffect(() => {
    if (!declarationImages) return;
    setQtmSlipPreviews(declarationImages.qtmImages.map((b64: string) => `data:image/jpeg;base64,${b64}`));
    setUncSlipPreviews(declarationImages.uncImages.map((b64: string) => `data:image/jpeg;base64,${b64}`));
  }, [declarationImages]);

  const dateKey = format(selectedDate, "yyyy-MM-dd");

  useEffect(() => {
    const candidates = [subDays(debouncedSelectedDate, 1), subDays(debouncedSelectedDate, -1)];

    for (const d of candidates) {
      const date = format(d, "yyyy-MM-dd");

      queryClient.prefetchQuery({
        queryKey: ["finance-daily-snapshot", date],
        queryFn: async () => {
          const { data, error } = await (supabase as any).rpc("finance_daily_snapshot", {
            p_date: date,
          });

          if (error) throw error;
          return {
            declaration: data?.declaration || null,
            dailyReconciliation: data?.dailyReconciliation || null,
            uncDetailAmount: Number(data?.uncDetailAmount || 0),
            qtmOpeningBalance: Number(data?.qtmOpeningBalance || 0),
          };
        },
        staleTime: 5 * 60_000,
      });
    }
  }, [debouncedSelectedDate, queryClient]);

  const persistedFolderTotal = Number(dailyDeclaration?.extraction_meta?.unc_folder_total || 0);
  const persistedFolderStatus = dailyDeclaration?.extraction_meta?.unc_folder_status as ("match" | "mismatch" | undefined);
  const resolvedUncDetail = Number((uncReconSummary?.folderTotal ?? persistedFolderTotal ?? dailyReconciliation?.unc_detail_amount ?? uncDetailAmount) || 0);
  const resolvedUncDeclared = Number((uncReconSummary?.ceoTotal ?? dailyReconciliation?.unc_declared_amount ?? uncTotalDeclared) || 0);
  const resolvedVariance = resolvedUncDetail - resolvedUncDeclared;
  const resolvedStatus = (uncReconSummary?.status || persistedFolderStatus || dailyReconciliation?.status) as ("match" | "mismatch" | undefined);
  const qtmClosingBalance = Number(qtmOpeningBalance || 0) + Number(cashFundTopupAmount || 0) - Number(qtmSpentFromFolder || 0);
  const qtmNegative = qtmClosingBalance < 0;

  useEffect(() => {
    // Prevent stale slip previews when switching date while query is refetching
    setQtmSlipPreviews([]);
    setUncSlipPreviews([]);
    setPendingQtmImagesBase64([]);
    setPendingUncImagesBase64([]);
    setPendingQtmExtractedList([]);
    setPendingUncExtractedList([]);
    // Reset lazy image loading for new date – will re-trigger on hover
    setImagesRequested(false);
  }, [dateKey]);

  // QTM opening balance is now powered by a dedicated React Query hook
  // (useQtmOpeningBalance) which provides caching + automatic dedup.
  useEffect(() => {
    if (qtmOpeningBalanceFromHook !== undefined) {
      setQtmOpeningBalance(Number(qtmOpeningBalanceFromHook || 0));
    }
  }, [qtmOpeningBalanceFromHook]);

  const expectedFolderFromDate = format(selectedDate, "ddMMyyyy");
  const autoDayFolderPath = format(selectedDate, "yyyy/MM/dd");

  const optimizeSlipImageForOcr = async (imageBase64: string, mimeType: string, aggressive = false) => {
    try {
      if (typeof window === "undefined") return { imageBase64, mimeType };
      const src = `data:${mimeType || "image/jpeg"};base64,${imageBase64}`;
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Load image failed"));
        el.src = src;
      });

      const maxW = aggressive ? 1200 : 1600;
      const quality = aggressive ? 0.62 : 0.78;
      const scale = Math.min(1, maxW / Math.max(1, img.width));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { imageBase64, mimeType };
      ctx.drawImage(img, 0, 0, w, h);

      const outMime = "image/jpeg";
      const outDataUrl = canvas.toDataURL(outMime, quality);
      const outBase64 = outDataUrl.split(",")[1] || imageBase64;

      // Only use compressed version if it is materially smaller.
      if (outBase64.length < imageBase64.length * (aggressive ? 0.85 : 0.95)) {
        return { imageBase64: outBase64, mimeType: outMime };
      }
      return { imageBase64, mimeType };
    } catch {
      return { imageBase64, mimeType };
    }
  };

  const extractSlipAmountFromBase64 = async (imageBase64: string, mimeType: string, slipType: "qtm" | "unc") => {
    const { data: { session } } = await supabase.auth.getSession();

    const callExtract = async (aggressive: boolean) => {
      const optimized = await optimizeSlipImageForOcr(imageBase64, mimeType, aggressive);
      const response = await fetchWithTimeout(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/finance-extract-slip-amount`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ imageBase64: optimized.imageBase64, mimeType: optimized.mimeType, slipType }),
      }, 45000);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error || "Failed extracting amount from slip image");
      }

      const result = await response.json();
      return result.data as { amount: number; confidence?: number; transfer_date?: string; reference?: string };
    };

    try {
      return await callExtract(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error || "");
      const isTimeout = msg.includes("AbortError") || msg.toLowerCase().includes("aborted") || msg.toLowerCase().includes("timeout");
      if (!isTimeout) throw error;

      // Retry once with stronger compression to reduce payload/latency.
      try {
        return await callExtract(true);
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError || "");
        const stillTimeout = retryMsg.includes("AbortError") || retryMsg.toLowerCase().includes("aborted") || retryMsg.toLowerCase().includes("timeout");
        if (stillTimeout) {
          throw new Error(`OCR slip ${slipType.toUpperCase()} quá thời gian chờ`);
        }
        throw retryError;
      }
    }
  };

  const getUncRootFolderUrl = async () => {
    const envFolderUrl = import.meta.env.VITE_GOOGLE_DRIVE_RECEIPTS_FOLDER as string | undefined;
    if (envFolderUrl) return envFolderUrl;

    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "google_drive_receipts_folder")
      .single();

    if (error || !data?.value) {
      throw new Error("Chưa cấu hình thư mục UNC gốc trong app_settings");
    }

    return String(data.value);
  };



  const runFolderReconciliation = async () => {
    setReconcilingFolderScan(true);
    setQtmReconciling(true);
    setReconcileError(null);
    setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Đang quét danh sách file UNC/QTM..." : "Scanning UNC/QTM file lists..." });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const folderUrl = await getUncRootFolderUrl();

      const scanOnce = async (subfolderDate: string) => {
        try {
          console.log(`[scan] Requesting: ${subfolderDate}, folderUrl: ${folderUrl?.slice(0, 60)}...`);
          const resp = await fetchWithTimeout(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
            },
            body: JSON.stringify({
              folderUrl,
              subfolderDate,
              folderType: "bank_slip",
              skipProcessed: uncSkipProcessed,
              includeBase64: false,
            }),
          }, 45000);
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const detail = err?.details || err?.error || `HTTP ${resp.status}`;
            throw new Error(`Scan "${subfolderDate}" thất bại: ${detail}`);
          }
          const data = await resp.json();
          console.log(`[scan] ${subfolderDate}: ${data?.files?.length ?? 0} files, total: ${data?.totalFilesFound ?? '?'}, skipped: ${data?.skippedProcessedCount ?? 0}`);
          return data;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error || "");
          if (msg.includes("AbortError") || msg.toLowerCase().includes("aborted") || msg.toLowerCase().includes("timeout")) {
            throw new Error(`Scan "${subfolderDate}" quá thời gian chờ (45s)`);
          }
          throw error;
        }
      };

      const scanWithRetry = async (subfolderDate: string) => {
        try {
          return await scanOnce(subfolderDate);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e || "");
          const isTimeout = msg.toLowerCase().includes("quá thời gian chờ") || msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("abort");
          if (!isTimeout) throw e;
          // Retry once for transient gateway/network hiccups.
          return await scanOnce(subfolderDate);
        }
      };

      const downloadBase64File = async (f: any) => {
        const resp = await fetchWithTimeout(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({
            mode: "download_file",
            folderUrl,
            fileId: f.id,
            fileName: f.name,
            mimeType: f.mimeType || "image/jpeg",
          }),
        }, 45000);

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error || `Không thể tải file ${String(f?.name || f?.id || "")}`);
        }

        const data = await resp.json();
        return data?.file || null;
      };

      const uncPath = `${autoDayFolderPath}/UNC`;
      const qtmPath = `${autoDayFolderPath}/QTM`;

      // Scan sequentially to avoid double pressure on Drive + Edge runtime.
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Đang quét UNC..." : "Scanning UNC..." });
      const uncScanData = await scanWithRetry(uncPath);
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Đang quét QTM..." : "Scanning QTM..." });
      const qtmScanData = await scanWithRetry(qtmPath);

      const uncRawFiles = Array.isArray(uncScanData?.files) ? uncScanData.files : [];
      const qtmRawFiles = Array.isArray(qtmScanData?.files) ? qtmScanData.files : [];
      const preSkippedByServer = Number(uncScanData?.skippedProcessedCount || 0) + Number(qtmScanData?.skippedProcessedCount || 0);

      const normalizeImageFiles = (rows: any[]) =>
        (rows || []).filter((f: any) => !uncScanImagesOnly || String(f?.mimeType || "").startsWith("image/"));

      let uncFiles = normalizeImageFiles(uncRawFiles);
      let qtmFiles = normalizeImageFiles(qtmRawFiles);

      // fallback legacy: some old days store UNC files directly under YYYY/MM/DD
      if (!uncFiles.length) {
        const dayScanData = await scanWithRetry(autoDayFolderPath);
        const dayFiles = normalizeImageFiles(Array.isArray(dayScanData?.files) ? dayScanData.files : []);
        const isQtmPath = (f: any) => {
          const haystack = `${String(f?.name || "")} ${String(f?.path || "")} ${String(f?.folderPath || "")} ${String(f?.parentPath || "")}`.toLowerCase();
          return /(^|\W)qtm($|\W)/i.test(haystack);
        };
        uncFiles = dayFiles.filter((f: any) => !isQtmPath(f));
        if (!qtmFiles.length) qtmFiles = dayFiles.filter((f: any) => isQtmPath(f));
      }

      const uncTotalScannedCount = Number(uncScanData?.totalFilesFound ?? uncFiles.length);
      const qtmTotalScannedCount = Number(qtmScanData?.totalFilesFound ?? qtmFiles.length);

      // Server-side skipProcessed already filtered returned files, so no extra client filtering needed.
      const processedSkippedCount = uncSkipProcessed ? preSkippedByServer : 0;
      const targetUncFiles = uncFiles;
      const targetQtmFiles = qtmFiles;

      if (!targetUncFiles.length && !targetQtmFiles.length) {
        const uncMsg = uncScanData?.message || "";
        const qtmMsg = qtmScanData?.message || "";
        const pathInfo = `UNC: ${uncPath}, QTM: ${qtmPath}`;
        const folderNotFound = uncMsg.includes("No subfolder") || qtmMsg.includes("No subfolder");
        throw new Error(
          isVi
            ? folderNotFound
              ? `Không tìm thấy thư mục trên Drive. Kiểm tra cấu trúc: ${pathInfo}. ${uncMsg}`
              : `Không có file ảnh trong thư mục (UNC: ${uncTotalScannedCount} found, QTM: ${qtmTotalScannedCount} found, skipped: ${processedSkippedCount}). Path: ${pathInfo}`
            : folderNotFound
              ? `Folder not found on Drive. Check structure: ${pathInfo}. ${uncMsg}`
              : `No image files in folders (UNC: ${uncTotalScannedCount}, QTM: ${qtmTotalScannedCount}, skipped: ${processedSkippedCount}). Path: ${pathInfo}`
        );
      }

      const totalTargets = targetUncFiles.length + targetQtmFiles.length;
      setReconcileProgress({ done: 0, total: totalTargets, currentFile: "" });

      const uncItems: Array<{ fileId: string; fileName: string; amount: number; confidence: number; status: "matched" | "mismatch" | "needs_review" }> = [];
      let progressDone = 0;

      // ── Parallel batch processing (5 files at a time) ──────────
      const BATCH_SIZE = 5;

      const processFileBatch = async (
        files: any[],
        slipType: "unc" | "qtm",
      ): Promise<Array<{ amount: number; confidence: number; fileId: string; fileName: string } | null>> => {
        const results: Array<{ amount: number; confidence: number; fileId: string; fileName: string } | null> = [];
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          setReconcileProgress({ done: progressDone, total: totalTargets, currentFile: `[${slipType.toUpperCase()}] Batch ${Math.ceil((i + 1) / BATCH_SIZE)}/${Math.ceil(files.length / BATCH_SIZE)}` });
          const batchResults = await Promise.allSettled(
            batch.map(async (file) => {
              const downloaded = await downloadBase64File(file);
              if (!downloaded?.base64) return null;
              const extracted = await extractSlipAmountFromBase64(downloaded.base64, downloaded.mimeType || file.mimeType || "image/jpeg", slipType);
              return {
                fileId: file.id,
                fileName: file.name,
                amount: Number(extracted?.amount || 0),
                confidence: Number(extracted?.confidence || 0),
              };
            })
          );
          for (const r of batchResults) {
            results.push(r.status === "fulfilled" ? r.value : null);
            progressDone += 1;
          }
        }
        return results;
      };

      // Process UNC files in parallel batches
      const uncResults = await processFileBatch(targetUncFiles, "unc");
      for (const r of uncResults) {
        if (!r) continue;
        uncItems.push({
          ...r,
          status: r.confidence < uncLowConfidenceThreshold ? "needs_review" : "matched",
        });
      }

      // Process QTM files in parallel batches
      const qtmResults = await processFileBatch(targetQtmFiles, "qtm");
      let qtmTotal = 0;
      let qtmLowConfidence = 0;
      for (const r of qtmResults) {
        if (!r) continue;
        qtmTotal += r.amount;
        if (r.confidence < uncLowConfidenceThreshold) qtmLowConfidence += 1;
      }

      const folderTotal = uncItems.reduce((sum, x) => sum + x.amount, 0);
      const ceoTotal = Number(uncTotalDeclared || 0);
      const delta = folderTotal - ceoTotal;
      const status: "match" | "mismatch" = delta === 0 ? "match" : "mismatch";
      const lowConfidenceCount = uncItems.filter((x) => x.status === "needs_review").length;

      const finalItems = uncItems.map((x) => {
        if (x.status === "needs_review") return x;
        return { ...x, status: "matched" as const };
      });

      setReconcileProgress({ done: totalTargets, total: totalTargets, currentFile: "" });
      setQtmSpentFromFolder(Number(qtmTotal || 0));
      setQtmLowConfidenceCount(Number(qtmLowConfidence || 0));

      // Persist processed markers right after reconciliation so next runs can skip quickly
      // even when Drive index sync is delayed/unavailable.
      const processedAt = new Date().toISOString();
      const processedRows = [...targetUncFiles, ...targetQtmFiles].map((f: any) => ({
        file_id: String(f.id),
        file_name: String(f.name || f.id),
        folder_date: autoDayFolderPath,
        folder_type: "bank_slip",
        mime_type: f?.mimeType || null,
        parent_folder_id: null,
        processed: true,
        processed_at: processedAt,
        last_seen_at: processedAt,
      }));

      if (processedRows.length > 0) {
        const { error: processedUpsertError } = await (supabase as any)
          .from("drive_file_index")
          .upsert(processedRows, { onConflict: "file_id", ignoreDuplicates: false });

        if (processedUpsertError) {
          console.error("[FinanceControl] Failed to persist processed markers:", processedUpsertError);
        }
      }

      setUncReconSummary({
        folderDate: uncPath,
        folderTotal,
        ceoTotal,
        delta,
        status,
        lowConfidenceCount,
        qtmExcludedCount: 0,
        totalScannedCount: uncTotalScannedCount,
        processedSkippedCount,
        items: finalItems,
      });

      await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .upsert({
          closing_date: dateKey,
          extraction_meta: {
            ...(dailyDeclaration?.extraction_meta || {}),
            unc_folder_path: uncPath,
            unc_folder_total: Number(folderTotal || 0),
            unc_folder_delta: Number(delta || 0),
            unc_folder_status: status,
            unc_folder_low_confidence_count: Number(lowConfidenceCount || 0),
            unc_folder_reconciled_at: new Date().toISOString(),
            qtm_folder_path: qtmPath,
            qtm_spent_from_folder: Number(qtmTotal || 0),
            qtm_low_confidence_count: Number(qtmLowConfidence || 0),
            qtm_folder_reconciled_at: new Date().toISOString(),
            qtm_folder_scanned_count: Number(qtmTotalScannedCount || 0),
          },
        }, { onConflict: "closing_date" });
      await refetchDeclaration();

      if (ceoTotal === 0) {
        setUncTotalDeclared(folderTotal);
        toast({
          title: isVi ? "Đã tự điền UNC khai báo" : "UNC declared total auto-filled",
          description: isVi
            ? `Đã cập nhật UNC khai báo = ${vnd(folderTotal)} từ folder ${uncPath}`
            : `CEO UNC declared total updated to ${vnd(folderTotal)} from folder ${uncPath}`,
        });
      }

      toast({
        title: isVi ? "Đã đối soát trong ngày" : "Daily reconciliation completed",
        description: isVi
          ? `Đã quét UNC (${uncTotalScannedCount} file) + QTM (${qtmTotalScannedCount} file) theo ngày ${format(selectedDate, "dd/MM/yyyy")}`
          : `Scanned UNC (${uncTotalScannedCount} files) + QTM (${qtmTotalScannedCount} files) for ${format(selectedDate, "dd/MM/yyyy")}`,
      });

    } catch (e: any) {
      const msg = e?.message || (isVi ? "Không thể đối soát UNC/QTM theo ngày" : "Failed reconciling UNC/QTM by date");
      setReconcileError(msg);
      setReconcileProgress((prev) => ({ ...prev, currentFile: "" }));
      toast({ title: isVi ? "Lỗi đối soát trong ngày" : "Daily reconciliation error", description: msg, variant: "destructive" });
      throw e; // Re-throw so handleOneClickClose stops
    } finally {
      setReconcilingFolderScan(false);
      setQtmReconciling(false);
    }
  };

  const runQtmReconciliation = async () => {
    setQtmReconciling(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const folderUrl = await getUncRootFolderUrl();
      const qtmPath = `${autoDayFolderPath}/QTM`;

      const scanResponse = await fetchWithTimeout(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ folderUrl, subfolderDate: qtmPath }),
      }, 45000);

      if (!scanResponse.ok) {
        const err = await scanResponse.json().catch(() => ({}));
        throw new Error(err?.error || "Không thể scan thư mục QTM");
      }

      const scanData = await scanResponse.json();
      const files = (Array.isArray(scanData?.files) ? scanData.files : [])
        .filter((f: any) => String(f?.mimeType || "").startsWith("image/"));

      if (!files.length) {
        setQtmSpentFromFolder(0);
        setQtmLowConfidenceCount(0);
        toast({ title: isVi ? "Không có chứng từ QTM" : "No QTM receipts", description: qtmPath });
        return;
      }

      let total = 0;
      let lowConfidence = 0;
      for (const f of files) {
        const extracted = await extractSlipAmountFromBase64(f.base64, f.mimeType || "image/jpeg", "qtm");
        const amount = Number(extracted?.amount || 0);
        const confidence = Number(extracted?.confidence || 0);
        total += amount;
        if (confidence < uncLowConfidenceThreshold) lowConfidence += 1;
      }

      setQtmSpentFromFolder(total);
      setQtmLowConfidenceCount(lowConfidence);
      toast({
        title: isVi ? "Đã quét chi QTM" : "QTM scanned",
        description: `${isVi ? "Tổng chi" : "Spent"}: ${vnd(total)} • ${isVi ? "thiếu chứng từ/độ tin cậy thấp" : "low confidence"}: ${lowConfidence}`,
      });
    } catch (e: any) {
      toast({ title: isVi ? "Lỗi quét QTM" : "QTM scan error", description: e?.message || "Failed scanning QTM", variant: "destructive" });
    } finally {
      setQtmReconciling(false);
    }
  };

  const extractSlipAmount = async (file: File, slipType: "qtm" | "unc") => {
    const imageBase64 = await fileToBase64(file);
    const { data: { session } } = await supabase.auth.getSession();

    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/finance-extract-slip-amount`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ imageBase64, mimeType: file.type, slipType }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error || `Failed extracting ${slipType} amount`);
    }

    const result = await response.json();
    return { imageBase64, extracted: result.data as { amount: number; confidence?: number; transfer_date?: string; reference?: string } };
  };

  const processSlipUpload = async (slipType: "qtm" | "unc", files: File[]) => {
    if (!files.length) return;
    setExtracting(true);
    try {
      const batchResults: Array<{ imageBase64: string; extracted: any; file: File }> = [];
      for (const file of files) {
        const result = await extractSlipAmount(file, slipType);
        batchResults.push({ ...result, file });
      }

      const batchSum = batchResults.reduce((sum, r) => sum + Number(r.extracted?.amount || 0), 0);
      const previews = batchResults.map((r) => `data:${r.file.type || "image/jpeg"};base64,${r.imageBase64}`);

      if (slipType === "qtm") {
        setCashFundTopupAmount((prev) => Number(prev || 0) + batchSum);
        setQtmSlipPreviews((prev) => [...prev, ...previews]);
        setPendingQtmImagesBase64((prev) => [...prev, ...batchResults.map((r) => r.imageBase64)]);
        setPendingQtmExtractedList((prev) => [...prev, ...batchResults.map((r) => r.extracted)]);
      } else {
        setUncTotalDeclared((prev) => Number(prev || 0) + batchSum);
        setUncSlipPreviews((prev) => [...prev, ...previews]);
        setPendingUncImagesBase64((prev) => [...prev, ...batchResults.map((r) => r.imageBase64)]);
        setPendingUncExtractedList((prev) => [...prev, ...batchResults.map((r) => r.extracted)]);
      }

      toast({
        title: isVi ? "Đã scan slip — tự động lưu" : "Slip scanned — auto-saving",
        description: `${slipType === "qtm" ? "QTM" : "UNC"}: +${vnd(batchSum)} (${batchResults.length} ảnh)`,
      });

      // Auto-save declaration after OCR (no separate "Save" button needed)
      // Use setTimeout to let state updates settle before saving
      setTimeout(() => { saveDeclaration(true); }, 100);
    } catch (e: any) {
      toast({ title: "Lỗi OCR slip", description: e?.message || "Không thể trích xuất số tiền", variant: "destructive" });
    } finally {
      setExtracting(false);
    }
  };

  const saveReconciliationWorkflowMeta = async (
    decisionOverride?: "reject" | "conditional" | "approve",
    lockOverride?: boolean,
    actionOverride?: string,
  ) => {
    const decision = decisionOverride || closeDecision;
    const nextLog = {
      at: new Date().toISOString(),
      actor: "CEO",
      action: actionOverride || (decision === "reject" ? "reject_close" : decision === "conditional" ? "conditional_close" : "approve_close"),
      detail: closeReason || null,
    };

    const mergedLogs = [...reconciliationAuditLogs, nextLog];

    const { error } = await (supabase as any)
      .from("ceo_daily_closing_declarations")
      .upsert({
        closing_date: dateKey,
        extraction_meta: {
          ...(dailyDeclaration?.extraction_meta || {}),
          close_decision: decision,
          close_approval_locked: lockOverride ?? (decision === "approve" ? true : closeApprovalLocked),
          close_reason: closeReason || null,
          reconciliation_audit_logs: mergedLogs,
          ceo_declaration_locked: ceoDeclarationLocked,
          qtm_opening_balance: Number(qtmOpeningBalance || 0),
          qtm_spent_from_folder: Number(qtmSpentFromFolder || 0),
          qtm_closing_balance: Number(qtmClosingBalance || 0),
          qtm_low_confidence_count: Number(qtmLowConfidenceCount || 0),
        },
      }, { onConflict: "closing_date" });

    if (error) throw error;
    setReconciliationAuditLogs(mergedLogs);
    setCloseApprovalLocked(lockOverride ?? (decision === "approve" ? true : closeApprovalLocked));
  };

  const saveDeclaration = async (silent = false): Promise<boolean> => {
    setSaving(true);
    try {
      const { data: latestDecl } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select("*")
        .eq("closing_date", dateKey)
        .maybeSingle();

      const sourceDecl = latestDecl || dailyDeclaration;
      const existingQtmImages = Array.isArray(sourceDecl?.extraction_meta?.qtm_images)
        ? sourceDecl.extraction_meta.qtm_images
        : (sourceDecl?.qtm_slip_image_base64 ? [sourceDecl.qtm_slip_image_base64] : []);
      const existingUncImages = Array.isArray(sourceDecl?.extraction_meta?.unc_images)
        ? sourceDecl.extraction_meta.unc_images
        : (sourceDecl?.unc_slip_image_base64 ? [sourceDecl.unc_slip_image_base64] : []);
      const finalQtmImages = [...existingQtmImages, ...pendingQtmImagesBase64];
      const finalUncImages = [...existingUncImages, ...pendingUncImagesBase64];

      const payload = {
        closing_date: dateKey,
        unc_total_declared: Number(uncTotalDeclared || 0),
        cash_fund_topup_amount: Number(cashFundTopupAmount || 0),
        qtm_extracted_amount: Number(cashFundTopupAmount || 0),
        unc_extracted_amount: Number(uncTotalDeclared || 0),
        // giữ cột cũ để backward-compatible (preview nhanh ảnh đầu)
        qtm_slip_image_base64: finalQtmImages[0] || null,
        unc_slip_image_base64: finalUncImages[0] || null,
        extraction_meta: {
          ...(sourceDecl?.extraction_meta || {}),
          qtm_images: finalQtmImages,
          unc_images: finalUncImages,
          qtm_items: [
            ...((sourceDecl?.extraction_meta?.qtm_items as any[]) || []),
            ...pendingQtmExtractedList,
          ],
          unc_items: [
            ...((sourceDecl?.extraction_meta?.unc_items as any[]) || []),
            ...pendingUncExtractedList,
          ],
          ceo_declaration_locked: ceoDeclarationLocked,
          close_decision: closeDecision,
          close_approval_locked: closeApprovalLocked,
          close_reason: closeReason || null,
          reconciliation_audit_logs: reconciliationAuditLogs,
          qtm_opening_balance: Number(qtmOpeningBalance || 0),
          qtm_spent_from_folder: Number(qtmSpentFromFolder || 0),
          qtm_closing_balance: Number(qtmClosingBalance || 0),
          qtm_low_confidence_count: Number(qtmLowConfidenceCount || 0),
        },
        notes: notes || null,
      };

      const { error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .upsert(payload, { onConflict: "closing_date" });

      if (error) throw error;
      if (!silent) {
        toast({ title: "Saved", description: "CEO daily declaration has been updated." });
      }
      setPendingQtmImagesBase64([]);
      setPendingUncImagesBase64([]);
      setPendingQtmExtractedList([]);
      setPendingUncExtractedList([]);
      await refetchDeclaration();
      return true;
    } catch (e: any) {
      if (!silent) {
        toast({ title: "Error", description: e?.message || "Failed to save declaration", variant: "destructive" });
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runReconcile = async () => {
    setReconciling(true);
    try {
      // --- UNC reconciliation: exact match required (bank-automated, no tolerance) ---
      const uncDetail = Number((uncReconSummary?.folderTotal ?? persistedFolderTotal ?? dailyReconciliation?.unc_detail_amount ?? uncDetailAmount) || 0);
      const uncDeclared = Number((uncReconSummary?.ceoTotal ?? dailyReconciliation?.unc_declared_amount ?? uncTotalDeclared) || 0);
      const uncVariance = uncDetail - uncDeclared;
      const uncStatus: "match" | "mismatch" = uncVariance === 0 ? "match" : "mismatch";

      // --- QTM reconciliation: underspend OK, overspend = mismatch ---
      const qtmDeclared = Number(cashFundTopupAmount || 0);
      const qtmSpent = Number(qtmSpentFromFolder || 0);
      const qtmVariance = qtmSpent - qtmDeclared; // positive = overspend
      // QTM: CEO total >= sum of slips → match (underspend OK); CEO total < sum of slips → mismatch (overspend)
      const qtmStatus: "match" | "mismatch" = qtmVariance <= 0 ? "match" : "mismatch";

      // Overall status: both must match
      const status: "match" | "mismatch" = (uncStatus === "match" && qtmStatus === "match") ? "match" : "mismatch";

      const { error } = await (supabase as any)
        .from("daily_reconciliations")
        .upsert({
          closing_date: dateKey,
          unc_detail_amount: uncDetail,
          unc_declared_amount: uncDeclared,
          cash_fund_topup_amount: qtmDeclared,
          qtm_spent_from_folder: qtmSpent,
          variance_amount: uncVariance,
          qtm_variance_amount: qtmVariance,
          unc_status: uncStatus,
          qtm_status: qtmStatus,
          status,
          tolerance_amount: 0,
          matched_at: new Date().toISOString(),
          notes: notes || null,
        }, { onConflict: "closing_date" });

      if (error) throw error;

      const summaryParts: string[] = [];
      if (uncStatus === "mismatch") summaryParts.push(`UNC ${isVi ? "chênh lệch" : "variance"}: ${vnd(uncVariance)}`);
      if (qtmStatus === "mismatch") summaryParts.push(`QTM ${isVi ? "vượt chi" : "overspend"}: ${vnd(qtmVariance)}`);

      toast({
        title: status === "match"
          ? (isVi ? "Đối soát: KHỚP" : "Reconciled: MATCH")
          : (isVi ? "Đối soát: LỆCH" : "Reconciled: MISMATCH"),
        description: summaryParts.length > 0
          ? summaryParts.join(" | ")
          : (isVi ? "UNC và QTM đều khớp" : "UNC and QTM both match"),
        variant: status === "match" ? "default" : "destructive",
      });

      await Promise.all([refetchDailyReconciliation(), refetchMonthly()]);
      return { status, uncVariance, qtmVariance };
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Reconciliation failed", variant: "destructive" });
      return null;
    } finally {
      setReconciling(false);
    }
  };

  const handleOneClickClose = async () => {
    if (closeApprovalLocked) {
      toast({
        title: isVi ? "Đã khoá" : "Already locked",
        description: isVi ? "Ngày này đã chốt. Mở khoá trước để chỉnh sửa." : "This day is already closed. Unlock first to edit.",
      });
      return;
    }

    setCloseActing(true);
    setReconcileError(null);
    try {
      // Step 1: Save CEO declaration
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Bước 1/4: Lưu khai báo CEO..." : "Step 1/4: Saving CEO declaration..." });
      const declarationSaved = await saveDeclaration(true);
      if (!declarationSaved) {
        throw new Error(isVi ? "Không thể lưu khai báo CEO" : "Failed to save CEO declaration");
      }

      // Step 2: Scan Drive folders (UNC + QTM)
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Bước 2/4: Quét thư mục UNC & QTM trên Drive..." : "Step 2/4: Scanning UNC & QTM folders on Drive..." });
      await runFolderReconciliation();

      // Step 3: Run reconciliation
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Bước 3/4: Đối soát UNC & QTM..." : "Step 3/4: Reconciling UNC & QTM..." });
      await refetchUncDetail();
      const result = await runReconcile();

      // Step 4: Lock & close
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Bước 4/4: Khoá & chốt ngày..." : "Step 4/4: Locking & closing..." });
      setCloseDecision("approve");
      await saveReconciliationWorkflowMeta("approve", true);

      setReconcileProgress({ done: 0, total: 0, currentFile: "" });
      toast({
        title: isVi ? "Đã duyệt & chốt ngày thành công" : "Day approved & closed successfully",
        description: result?.status === "match"
          ? (isVi ? "UNC và QTM đều khớp" : "UNC and QTM both match")
          : (isVi ? "Có chênh lệch — vui lòng kiểm tra" : "Variance detected — please review"),
        variant: result?.status === "match" ? "default" : "destructive",
      });
      await refetchDeclaration();
    } catch (e: any) {
      setReconcileError(e?.message || (isVi ? "Lỗi khi chốt ngày" : "Failed closing day"));
      toast({ title: isVi ? "Lỗi" : "Error", description: e?.message || (isVi ? "Không thể chốt ngày" : "Failed closing day"), variant: "destructive" });
    } finally {
      setCloseActing(false);
    }
  };

  const handleUnlockApproval = async () => {
    setCloseActing(true);
    try {
      const declarationSaved = await saveDeclaration(true);
      if (!declarationSaved) throw new Error(isVi ? "Không thể lưu dữ liệu trước khi mở khoá" : "Failed to save before unlock");
      await saveReconciliationWorkflowMeta("approve", false, "unlock_approval");
      toast({
        title: isVi ? "Đã mở khoá phê duyệt" : "Approval unlocked",
        description: isVi ? "Anh có thể chỉnh và phê duyệt lại." : "You can edit and approve again.",
      });
      await refetchDeclaration();
    } catch (e: any) {
      toast({ title: isVi ? "Lỗi" : "Error", description: e?.message || (isVi ? "Không thể mở khoá" : "Failed to unlock"), variant: "destructive" });
    } finally {
      setCloseActing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header + Date picker */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">{isVi ? "Quản lý chi phí" : "Cost management"}</h1>
          <p className="text-muted-foreground text-sm">{isVi ? "Khai báo, đối soát và chốt ngày" : "Declare, reconcile and close daily"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon" onClick={() => setSelectedDate((d) => subDays(d, 1))}>←</Button>
          <Input type="date" className="w-40" value={toDateInputValue(selectedDate)} onChange={(e) => setSelectedDate(parseDateInputValue(e.target.value))} />
          <Button type="button" variant="outline" size="icon" onClick={() => setSelectedDate((d) => subDays(d, -1))}>→</Button>
        </div>
      </div>

      {/* Dashboard */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">{isVi ? "UNC khai báo" : "UNC declared"}</div>
          <div className="text-xl font-semibold">{vnd(Number(uncTotalDeclared || 0))}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">{isVi ? "QTM khai báo" : "QTM declared"}</div>
          <div className="text-xl font-semibold">{vnd(Number(cashFundTopupAmount || 0))}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">{isVi ? "Số dư QTM" : "QTM balance"}</div>
          <div className={`text-xl font-semibold ${qtmNegative ? "text-red-600" : ""}`}>{vnd(qtmClosingBalance)}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">{isVi ? "Trạng thái" : "Status"}</div>
          <div className="text-xl font-semibold">
            {closeApprovalLocked
              ? <Badge className="bg-green-600">{isVi ? "Đã chốt" : "Closed"}</Badge>
              : resolvedStatus === "match" ? <Badge className="bg-green-600">{isVi ? "Khớp" : "Match"}</Badge>
              : resolvedStatus === "mismatch" ? <Badge variant="destructive">{isVi ? "Lệch" : "Mismatch"}</Badge>
              : <Badge variant="secondary">{isVi ? "Chờ" : "Pending"}</Badge>}
          </div>
        </CardContent></Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="daily">{isVi ? "Chốt ngày" : "Daily Close"}</TabsTrigger>
          <TabsTrigger value="monthly">{isVi ? "Chốt tháng" : "Monthly Close"}</TabsTrigger>
        </TabsList>

        <TabsContent value="daily" className="space-y-4">
          {/* CEO Declaration */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">{isVi ? "CEO Khai báo" : "CEO Declaration"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4" onMouseEnter={() => { if (!imagesRequested) setImagesRequested(true); }}>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">{isVi ? "Slip ngân hàng (UNC)" : "Bank slips (UNC)"}</Label>
                  <Input type="file" accept="image/*" multiple disabled={ceoDeclarationLocked || closeApprovalLocked} onChange={async (e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length) await processSlipUpload("unc", files);
                    e.currentTarget.value = "";
                  }} />
                  {!!uncSlipPreviews.length && (
                    <div className="flex flex-wrap gap-2">
                      {uncSlipPreviews.map((src, idx) => (
                        <img key={`unc-${idx}`} src={src} alt={`UNC slip ${idx + 1}`} className="h-20 rounded border object-contain" />
                      ))}
                    </div>
                  )}
                  <div className="text-lg font-semibold">{vnd(Number(uncTotalDeclared || 0))}</div>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium">{isVi ? "Slip tiền mặt (QTM)" : "Cash slips (QTM)"}</Label>
                  <Input type="file" accept="image/*" multiple disabled={ceoDeclarationLocked || closeApprovalLocked} onChange={async (e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length) await processSlipUpload("qtm", files);
                    e.currentTarget.value = "";
                  }} />
                  {!!qtmSlipPreviews.length && (
                    <div className="flex flex-wrap gap-2">
                      {qtmSlipPreviews.map((src, idx) => (
                        <img key={`qtm-${idx}`} src={src} alt={`QTM slip ${idx + 1}`} className="h-20 rounded border object-contain" />
                      ))}
                    </div>
                  )}
                  <div className="text-lg font-semibold">{vnd(Number(cashFundTopupAmount || 0))}</div>
                </div>
              </div>

              {extracting && <div className="text-sm text-muted-foreground animate-pulse">{isVi ? "Đang scan slip..." : "Scanning slips..."}</div>}
            </CardContent>
          </Card>

          {/* 1-click: Duyệt & Chốt ngày */}
          <Card>
            <CardContent className="p-6 space-y-4">
              {/* Action button */}
              <div className="flex items-center gap-3">
                {closeApprovalLocked ? (
                  <>
                    <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                      <Lock className="h-5 w-5" />
                      <span className="text-lg font-semibold">{isVi ? "Đã duyệt & chốt ngày" : "Approved & closed"}</span>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={handleUnlockApproval} disabled={closeActing}>
                      <Unlock className="h-4 w-4 mr-2" />
                      {isVi ? "Mở khoá" : "Unlock"}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="lg"
                    className="bg-green-600 hover:bg-green-700 text-white text-base px-8"
                    disabled={closeActing || reconcilingFolderScan || reconciling || saving || extracting}
                    onClick={handleOneClickClose}
                  >
                    <Lock className="h-5 w-5 mr-2" />
                    {isVi ? "Duyệt & Chốt ngày" : "Approve & Close Day"}
                  </Button>
                )}
              </div>

              {/* Inline progress */}
              {(closeActing || reconcilingFolderScan) && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="animate-spin">⏳</span>
                    {reconcileProgress.currentFile || (isVi ? "Đang xử lý..." : "Processing...")}
                  </div>
                  {reconcileProgress.total > 0 && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{isVi ? "OCR bank slip" : "OCR bank slips"}: {reconcileProgress.done}/{reconcileProgress.total}</span>
                        <span>{Math.round((reconcileProgress.done / reconcileProgress.total) * 100)}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-green-600 rounded-full transition-all duration-300" style={{ width: `${(reconcileProgress.done / reconcileProgress.total) * 100}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Error display */}
              {reconcileError && !closeActing && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {reconcileError}
                </div>
              )}

              {/* Reconciliation result summary (after scan) */}
              {uncReconSummary && !closeActing && (
                <div className="space-y-3">
                  <div className="text-sm font-medium">{isVi ? "Kết quả đối soát" : "Reconciliation result"}</div>
                  <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
                    <div className="rounded-lg border p-3">
                      <div className="text-xs text-muted-foreground">UNC Drive</div>
                      <div className="font-semibold">{vnd(resolvedUncDetail)}</div>
                    </div>
                    <div className="rounded-lg border p-3">
                      <div className="text-xs text-muted-foreground">{isVi ? "UNC khai báo" : "UNC declared"}</div>
                      <div className="font-semibold">{vnd(resolvedUncDeclared)}</div>
                    </div>
                    <div className="rounded-lg border p-3">
                      <div className="text-xs text-muted-foreground">QTM Drive</div>
                      <div className="font-semibold">{vnd(qtmSpentFromFolder)}</div>
                    </div>
                    <div className="rounded-lg border p-3">
                      <div className="text-xs text-muted-foreground">{isVi ? "QTM khai báo" : "QTM declared"}</div>
                      <div className="font-semibold">{vnd(Number(cashFundTopupAmount || 0))}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">{isVi ? "Files:" : "Files:"}</span>
                    <span>{isVi ? `UNC ${uncReconSummary.totalScannedCount} file` : `UNC ${uncReconSummary.totalScannedCount} files`}</span>
                    {uncReconSummary.lowConfidenceCount > 0 && (
                      <Badge variant="secondary" className="text-xs">{uncReconSummary.lowConfidenceCount} {isVi ? "cần xem lại" : "need review"}</Badge>
                    )}
                  </div>
                </div>
              )}

              {/* Ghi chú */}
              <div className="space-y-1">
                <Label className="text-xs">{isVi ? "Ghi chú" : "Notes"}</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={isVi ? "Tuỳ chọn" : "Optional"} disabled={closeApprovalLocked} className="text-sm" />
              </div>

              {/* Audit log (collapsed by default) */}
              {reconciliationAuditLogs.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{isVi ? `Nhật ký (${reconciliationAuditLogs.length})` : `Audit log (${reconciliationAuditLogs.length})`}</summary>
                  <div className="mt-2 space-y-1">
                    {reconciliationAuditLogs.slice().reverse().slice(0, 5).map((log, idx) => (
                      <div key={`${log.at}-${idx}`} className="rounded border px-3 py-1.5 text-xs">
                        <span className="font-medium">{new Date(log.at).toLocaleString("vi-VN")}</span>
                        <span className="text-muted-foreground"> {log.action}{log.detail ? ` — ${log.detail}` : ""}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="monthly" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{isVi ? "Chốt tháng" : "Monthly Closing"}</CardTitle>
                <Input type="month" className="w-40" value={format(selectedMonth, "yyyy-MM")} onChange={(e) => setSelectedMonth(new Date(`${e.target.value}-01`))} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tổng UNC thực" : "Total UNC actual"}</div><div className="text-xl font-semibold">{vnd(Number(monthlySummary?.totalUncDetail || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tổng UNC khai báo" : "Total UNC declared"}</div><div className="text-xl font-semibold">{vnd(Number(monthlySummary?.totalUncDeclared || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Chênh lệch" : "Variance"}</div><div className="text-xl font-semibold">{vnd(Number(monthlySummary?.netVariance || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tỷ lệ khớp" : "Match rate"}</div><div className="text-xl font-semibold">{monthlySummary?.totalDays ? `${monthlySummary.matchDays}/${monthlySummary.totalDays}` : "—"}</div></CardContent></Card>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isVi ? "Ngày" : "Date"}</TableHead>
                    <TableHead className="text-right">{isVi ? "UNC thực" : "UNC actual"}</TableHead>
                    <TableHead className="text-right">{isVi ? "UNC khai báo" : "UNC declared"}</TableHead>
                    <TableHead className="text-right">{isVi ? "Chênh lệch" : "Variance"}</TableHead>
                    <TableHead>{isVi ? "Trạng thái" : "Status"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthlySummary?.rows?.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell>{format(new Date(r.closing_date), "dd/MM/yyyy", { locale: vi })}</TableCell>
                      <TableCell className="text-right">{vnd(Number(r.unc_detail_amount || 0))}</TableCell>
                      <TableCell className="text-right">{vnd(Number(r.unc_declared_amount || 0))}</TableCell>
                      <TableCell className="text-right">{vnd(Number(r.variance_amount || 0))}</TableCell>
                      <TableCell>{r.status === "match" ? <Badge className="bg-green-600">MATCH</Badge> : r.status === "mismatch" ? <Badge variant="destructive">MISMATCH</Badge> : <Badge variant="secondary">—</Badge>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {!monthlySummary?.rows?.length && (
                <div className="text-sm text-muted-foreground text-center py-4">{isVi ? "Chưa có dữ liệu" : "No data yet"}</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
