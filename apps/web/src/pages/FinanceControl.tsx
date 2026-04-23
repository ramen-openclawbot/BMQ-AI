import { useEffect, useMemo, useState } from "react";
import { format, startOfMonth, endOfMonth, subDays } from "date-fns";
import { vi } from "date-fns/locale";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useAuth } from "@/contexts/AuthContext";
import { Lock, Trash2, Unlock } from "lucide-react";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { normalizeUploadImage, optimizeSlipImageForOcr } from "@/lib/slip-image";

const vnd = (value: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value || 0);

const toDateInputValue = (d: Date) => format(d, "yyyy-MM-dd");
const parseDateInputValue = (value: string) => {
  const [y, m, day] = value.split("-").map(Number);
  return new Date(y, (m || 1) - 1, day || 1);
};

export default function FinanceControl() {
  const { toast } = useToast();
  const { language } = useLanguage();
  const { isOwner } = useAuth();
  const isVi = language === "vi";
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [debouncedSelectedDate, setDebouncedSelectedDate] = useState<Date>(new Date());
  const [selectedMonth, setSelectedMonth] = useState<Date>(new Date());
  const [activeTab, setActiveTab] = useState<string>("daily");
  const [imagesRequested, setImagesRequested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [declarationSaveMessage, setDeclarationSaveMessage] = useState<string | null>(null);
  const [ocrDebugMessage, setOcrDebugMessage] = useState<string | null>(null);
  const [slipPreviewOpen, setSlipPreviewOpen] = useState(false);
  const [slipPreviewSrc, setSlipPreviewSrc] = useState<string | null>(null);
  const [slipPreviewTitle, setSlipPreviewTitle] = useState<string>("");

  const [uncSkipProcessed, setUncSkipProcessed] = useState(true);
  const [uncScanImagesOnly, setUncScanImagesOnly] = useState(true);
  const [uncLowConfidenceThreshold, setUncLowConfidenceThreshold] = useState(0.75);
  const [reconcilingFolderScan, setReconcilingFolderScan] = useState(false);
  const [reconcileProgress, setReconcileProgress] = useState({ done: 0, total: 0, currentFile: "" });
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [qtmOpeningBalance, setQtmOpeningBalance] = useState<number>(0);
  const [qtmSpentFromFolder, setQtmSpentFromFolder] = useState<number>(0);
  const [qtmReconciling, setQtmReconciling] = useState(false);
  const [qtmLowConfidenceCount, setQtmLowConfidenceCount] = useState(0);
  // Close dialog state
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closeDialogStep, setCloseDialogStep] = useState<"preview" | "running" | "mismatch" | "done">("preview");
  const [mismatchResult, setMismatchResult] = useState<any>(null);
  const [closeResultSnapshot, setCloseResultSnapshot] = useState<{ uncDrive: number; uncCEO: number; qtmDrive: number; qtmCEO: number; status: "match" | "mismatch" } | null>(null);
  const [previewUncFiles, setPreviewUncFiles] = useState<number>(0);
  const [previewQtmFiles, setPreviewQtmFiles] = useState<number>(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uncPathTemplate, setUncPathTemplate] = useState("yyyy/MM/dd/UNC");
  const [qtmPathTemplate, setQtmPathTemplate] = useState("yyyy/MM/dd/QTM");
  // Folder browser state

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

  useEffect(() => {
    if (activeTab !== "monthly") {
      setSelectedMonth(startOfMonth(selectedDate));
    }
  }, [selectedDate, activeTab]);

  // Root folder is configured in Google Drive Integration and resolved on demand.

  useEffect(() => {
    const loadReceiptPathTemplates = async () => {
      try {
        const { data } = await supabase
          .from("app_settings")
          .select("key, value")
          .in("key", ["google_drive_receipts_unc_pattern", "google_drive_receipts_qtm_pattern"]);
        const unc = data?.find((d: any) => d.key === "google_drive_receipts_unc_pattern")?.value;
        const qtm = data?.find((d: any) => d.key === "google_drive_receipts_qtm_pattern")?.value;
        if (unc) setUncPathTemplate(String(unc));
        if (qtm) setQtmPathTemplate(String(qtm));
      } catch (error) {
        console.error("Failed to load receipts path templates:", error);
      }
    };
    loadReceiptPathTemplates();
  }, []);

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
  const [reconciliationAuditLogs, setReconciliationAuditLogs] = useState<Array<{ at: string; actor: string; action: string; detail?: string; snapshot?: any }>>([]);

  useEffect(() => {
    // Guard against transient empty state while query is still loading/refetching,
    // otherwise local form can be reset to zeros and accidentally overwrite DB on save.
    if (dailyDeclaration === undefined || declarationLoading || declarationFetching) return;

    const hasPendingLocalDeclarationChanges = saving
      || extracting
      || pendingQtmImagesBase64.length > 0
      || pendingUncImagesBase64.length > 0
      || pendingQtmExtractedList.length > 0
      || pendingUncExtractedList.length > 0;

    // While OCR/save is in-flight, preserve the local optimistic values instead of
    // hydrating stale DB data back into the form.
    if (hasPendingLocalDeclarationChanges) return;

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
  }, [
    dailyDeclaration,
    declarationLoading,
    declarationFetching,
    saving,
    extracting,
    pendingQtmImagesBase64.length,
    pendingUncImagesBase64.length,
    pendingQtmExtractedList.length,
    pendingUncExtractedList.length,
  ]);

  // Populate slip previews from the lazy image hook when it arrives
  useEffect(() => {
    if (!declarationImages) return;
    setQtmSlipPreviews(declarationImages.qtmImages.map((b64: string) => `data:image/jpeg;base64,${b64}`));
    setUncSlipPreviews(declarationImages.uncImages.map((b64: string) => `data:image/jpeg;base64,${b64}`));
  }, [declarationImages]);

  const dateKey = format(selectedDate, "yyyy-MM-dd");

  const persistedFolderTotal = Number(dailyDeclaration?.extraction_meta?.unc_folder_total || 0);
  const persistedFolderStatus = dailyDeclaration?.extraction_meta?.unc_folder_status as ("match" | "mismatch" | undefined);
  const resolvedUncDetail = Number((uncReconSummary?.folderTotal ?? persistedFolderTotal ?? dailyReconciliation?.unc_detail_amount ?? uncDetailAmount) || 0);
  const resolvedUncDeclared = Number((uncReconSummary?.ceoTotal ?? dailyReconciliation?.unc_declared_amount ?? uncTotalDeclared) || 0);
  const resolvedVariance = resolvedUncDetail - resolvedUncDeclared;
  const resolvedStatus = (uncReconSummary?.status || persistedFolderStatus || dailyReconciliation?.status) as ("match" | "mismatch" | undefined);
  const hasDeclaredUnc = Number(uncTotalDeclared || 0) > 0;
  const hasDeclaredQtm = Number(cashFundTopupAmount || 0) > 0;
  const canCloseWithoutBankSlips = !hasDeclaredUnc && !hasDeclaredQtm;
  const missingRequiredPreview = (hasDeclaredUnc && previewUncFiles === 0) || (hasDeclaredQtm && previewQtmFiles === 0);

  const qtmResolved = useMemo(() => {
    const persistedOpening = Number(dailyDeclaration?.extraction_meta?.qtm_opening_balance || 0);
    const persistedDeclared = Number((dailyDeclaration?.qtm_extracted_amount ?? dailyDeclaration?.cash_fund_topup_amount) || 0);
    const persistedDrive = Number(dailyDeclaration?.extraction_meta?.qtm_spent_from_folder || 0);
    const persistedClosing = Number(dailyDeclaration?.extraction_meta?.qtm_closing_balance || 0);
    const closed = Boolean(dailyDeclaration?.extraction_meta?.close_approval_locked);

    // Opening balance must always come from previous-day closing logic.
    // Refreshing the browser should never fall back to today's persisted opening
    // unless the hook itself already derived it that way.
    const liveOpening = Number(qtmOpeningBalance || 0);

    // CEO declaration is step 2: once declared/saved today, show persisted declared amount.
    const declared = Number(
      cashFundTopupAmount ||
      dailyDeclaration?.qtm_extracted_amount ||
      dailyDeclaration?.cash_fund_topup_amount ||
      0,
    );

    // Folder-spent amount is step 3: only reflect spent-from-folder after reconciliation/chốt.
    // Before that, keep it at 0 on refresh even if stale extraction_meta exists.
    const drive = closed
      ? persistedDrive
      : Number((closeResultSnapshot?.qtmDrive ?? qtmSpentFromFolder ?? 0) || 0);

    const closing = closed
      ? persistedClosing
      : (liveOpening + declared - drive);

    return {
      isClosedDay: closed,
      opening: liveOpening,
      declared,
      drive,
      closing,
    };
  }, [
    dailyDeclaration?.extraction_meta,
    dailyDeclaration?.qtm_extracted_amount,
    dailyDeclaration?.cash_fund_topup_amount,
    qtmOpeningBalance,
    cashFundTopupAmount,
    closeResultSnapshot?.qtmDrive,
    qtmSpentFromFolder,
  ]);

  const isClosedDay = qtmResolved.isClosedDay;
  const resolvedQtmOpening = qtmResolved.opening;
  const resolvedQtmDeclared = qtmResolved.declared;
  const resolvedQtmDrive = qtmResolved.drive;
  const qtmClosingBalance = qtmResolved.closing;
  const qtmNegative = qtmClosingBalance < 0;

  useEffect(() => {
    // Prevent stale per-day state from bleeding into the next selected day.
    setQtmSlipPreviews([]);
    setUncSlipPreviews([]);
    setPendingQtmImagesBase64([]);
    setPendingUncImagesBase64([]);
    setPendingQtmExtractedList([]);
    setPendingUncExtractedList([]);
    setCloseResultSnapshot(null);
    setDeclarationSaveMessage(null);
    setOcrDebugMessage(null);
    setQtmSpentFromFolder(0);
    setQtmOpeningBalance(0);
    setImagesRequested(false);
  }, [dateKey]);

  // QTM opening balance is now powered by a dedicated React Query hook
  // (useQtmOpeningBalance) which provides caching + automatic dedup.
  useEffect(() => {
    if (qtmOpeningBalanceFromHook !== undefined) {
      setQtmOpeningBalance(Number(qtmOpeningBalanceFromHook || 0));
    }
  }, [qtmOpeningBalanceFromHook]);

  useEffect(() => {
    const refetchFinanceData = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      await Promise.allSettled([
        refetchDeclaration(),
        refetchDailyReconciliation(),
        refetchUncDetail(),
      ]);
    };

    const onVisibilityChange = () => { void refetchFinanceData(); };
    const onWindowFocus = () => { void refetchFinanceData(); };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [refetchDeclaration, refetchDailyReconciliation, refetchUncDetail]);

  const expectedFolderFromDate = format(selectedDate, "ddMMyyyy");
  const applyDatePathTemplate = (template: string) => {
    const normalized = String(template || "").trim() || "yyyy/MM/dd";
    return normalized
      .replace(/yyyy/g, format(selectedDate, "yyyy"))
      .replace(/MM/g, format(selectedDate, "MM"))
      .replace(/dd/g, format(selectedDate, "dd"));
  };
  const uncPathForDate = applyDatePathTemplate(uncPathTemplate);
  const qtmPathForDate = applyDatePathTemplate(qtmPathTemplate);
  const autoDayFolderPath = format(selectedDate, "yyyy/MM/dd");

  const extractSlipAmountFromBase64 = async (imageBase64: string, mimeType: string, slipType: "qtm" | "unc") => {
    const session = await getFreshSession();

    const callExtract = async (aggressive: boolean) => {
      const optimized = await optimizeSlipImageForOcr(imageBase64, mimeType, aggressive);
      const response = await fetchWithTimeout(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/finance-extract-slip-amount`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ imageBase64: optimized.imageBase64, mimeType: optimized.mimeType, slipType }),
      }, 45000);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = err?.detail || err?.error || `HTTP ${response.status}`;
        throw new Error(`OCR lỗi (${response.status}): ${msg}`);
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

  // Returns a valid session — always attempts refreshSession() first (most reliable),
  // falls back to current session if refresh fails.
  const getFreshSession = async () => {
    // Always try refresh first: ensures token is valid even after long idle
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (!refreshError && refreshed.session) return refreshed.session;
    // Fallback: return whatever session is cached
    const { data } = await supabase.auth.getSession();
    return data.session;
  };



  const runFolderReconciliation = async () => {
    setReconcilingFolderScan(true);
    setQtmReconciling(true);
    setReconcileError(null);
    setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Đang quét danh sách file UNC/QTM..." : "Scanning UNC/QTM file lists..." });

    try {
      const session = await getFreshSession();
      const folderUrl = await getUncRootFolderUrl();

      const scanOnce = async (subfolderDate: string) => {
        try {
          console.log(`[scan] Requesting: ${subfolderDate}, folderUrl: ${folderUrl?.slice(0, 60)}...`);
          const resp = await fetchWithTimeout(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
              ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
            },
            body: JSON.stringify({
              folderUrl,
              subfolderDate,
              folderType: "bank_slip",
              skipProcessed: false,
              includeBase64: false,
            }),
          }, 45000);
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const detail = resp.status === 401
              ? "Phiên đăng nhập hết hạn — vui lòng đăng nhập lại"
              : err?.details || err?.error || `HTTP ${resp.status}`;
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
            "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
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

      const uncPath = uncPathForDate;
      const qtmPath = qtmPathForDate;

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

      const uncTotalScannedCount = Number(uncScanData?.totalFilesFound ?? uncFiles.length);
      const qtmTotalScannedCount = Number(qtmScanData?.totalFilesFound ?? qtmFiles.length);

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
              : `Không có file ảnh trong thư mục (UNC: ${uncTotalScannedCount} found, QTM: ${qtmTotalScannedCount} found). Path: ${pathInfo}`
            : folderNotFound
              ? `Folder not found on Drive. Check structure: ${pathInfo}. ${uncMsg}`
              : `No image files in folders (UNC: ${uncTotalScannedCount}, QTM: ${qtmTotalScannedCount}). Path: ${pathInfo}`
        );
      }

      // ── OCR cache lookup: reuse previously extracted amounts from drive_file_index ──
      const ocrCache = new Map<string, { amount: number; confidence: number }>();
      {
        const allFileIds = [...targetUncFiles, ...targetQtmFiles].map((f: any) => f.id);
        const CHUNK = 500;
        for (let i = 0; i < allFileIds.length; i += CHUNK) {
          const chunk = allFileIds.slice(i, i + CHUNK);
          const { data: cachedRows } = await (supabase as any)
            .from("drive_file_index")
            .select("file_id, extracted_amount, extraction_confidence")
            .in("file_id", chunk)
            .not("extracted_amount", "is", null);
          for (const row of (cachedRows || [])) {
            if (row?.file_id && Number(row.extracted_amount) > 0) {
              ocrCache.set(row.file_id, {
                amount: Number(row.extracted_amount),
                confidence: Number(row.extraction_confidence || 0),
              });
            }
          }
        }
      }
      const cachedCount = ocrCache.size;
      const uncachedUncFiles = targetUncFiles.filter((f: any) => !ocrCache.has(f.id));
      const uncachedQtmFiles = targetQtmFiles.filter((f: any) => !ocrCache.has(f.id));
      const processedSkippedCount = cachedCount;
      console.log(`[reconcile] OCR cache hit: ${cachedCount} files, need OCR: UNC ${uncachedUncFiles.length}, QTM ${uncachedQtmFiles.length}`);

      const totalTargets = uncachedUncFiles.length + uncachedQtmFiles.length;
      setReconcileProgress({ done: 0, total: totalTargets, currentFile: totalTargets === 0 ? (isVi ? "Tất cả file đã có cache OCR" : "All files have cached OCR") : "" });

      const uncItems: Array<{ fileId: string; fileName: string; amount: number; confidence: number; status: "matched" | "mismatch" | "needs_review" }> = [];
      const ocrErrors: string[] = [];
      let progressDone = 0;

      // ── Parallel batch processing (3 files at a time to reduce concurrent load) ──
      const BATCH_SIZE = 3;

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
              if (!downloaded?.base64) throw new Error(`Không tải được file ${String(file?.name || file?.id || "")}`);
              const extracted = await extractSlipAmountFromBase64(downloaded.base64, downloaded.mimeType || file.mimeType || "image/jpeg", slipType);
              const amount = Number(extracted?.amount || 0);
              const confidence = Number(extracted?.confidence || 0);
              if (!(amount > 0)) {
                throw new Error(`OCR trả về số tiền = 0 cho file ${String(file?.name || file?.id || "")}`);
              }
              return {
                fileId: file.id,
                fileName: file.name,
                amount,
                confidence,
              };
            })
          );
          batchResults.forEach((r, idx) => {
            if (r.status === "fulfilled") {
              results.push(r.value);
            } else {
              const file = batch[idx];
              const reason = r.reason instanceof Error ? r.reason.message : String(r.reason || "OCR failed");
              ocrErrors.push(`${slipType.toUpperCase()}: ${String(file?.name || file?.id || "unknown")}: ${reason}`);
              results.push(null);
            }
            progressDone += 1;
          });
        }
        return results;
      };

      // ── Inject cached UNC results (no download/OCR needed) ──
      for (const f of targetUncFiles) {
        const cached = ocrCache.get(f.id);
        if (cached) {
          uncItems.push({
            fileId: f.id,
            fileName: f.name,
            amount: cached.amount,
            confidence: cached.confidence,
            status: cached.confidence < uncLowConfidenceThreshold ? "needs_review" : "matched",
          });
        }
      }

      // Process only UNCACHED UNC files via download + OCR
      const uncResults = await processFileBatch(uncachedUncFiles, "unc");
      for (const r of uncResults) {
        if (!r) continue;
        uncItems.push({
          ...r,
          status: r.confidence < uncLowConfidenceThreshold ? "needs_review" : "matched",
        });
      }

      // ── Inject cached QTM results ──
      let qtmTotal = 0;
      let qtmLowConfidence = 0;
      for (const f of targetQtmFiles) {
        const cached = ocrCache.get(f.id);
        if (cached) {
          qtmTotal += cached.amount;
          if (cached.confidence < uncLowConfidenceThreshold) qtmLowConfidence += 1;
        }
      }

      // Process only UNCACHED QTM files via download + OCR
      const qtmResults = await processFileBatch(uncachedQtmFiles, "qtm");
      for (const r of qtmResults) {
        if (!r) continue;
        qtmTotal += r.amount;
        if (r.confidence < uncLowConfidenceThreshold) qtmLowConfidence += 1;
      }

      const folderTotal = uncItems.reduce((sum, x) => sum + x.amount, 0);
      const uncOcrFailedHard = targetUncFiles.length > 0 && uncItems.length === 0;
      const qtmOcrFailedHard = targetQtmFiles.length > 0 && qtmTotal === 0;
      if (uncOcrFailedHard || qtmOcrFailedHard) {
        const preview = ocrErrors.slice(0, 8).join(" | ");
        const scope = uncOcrFailedHard && qtmOcrFailedHard
          ? (isVi ? "UNC và QTM" : "UNC and QTM")
          : uncOcrFailedHard
            ? "UNC"
            : "QTM";
        throw new Error(isVi
          ? `${scope}: Drive đã thấy file nhưng OCR không đọc được số tiền. ${preview || "Vui lòng kiểm tra format bank slip hoặc edge function finance-extract-slip-amount."}`
          : `${scope}: Drive found files but OCR could not extract amounts. ${preview || "Please verify bank slip format or finance-extract-slip-amount."}`);
      }
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

      // Persist processed markers + OCR amounts so next runs can reuse cached results
      // instead of re-downloading + re-OCR-ing every file.
      const processedAt = new Date().toISOString();
      const ocrAmountMap = new Map<string, { amount: number; confidence: number }>();
      // Include fresh OCR results from this run
      for (const r of uncResults) {
        if (r) ocrAmountMap.set(r.fileId, { amount: r.amount, confidence: r.confidence });
      }
      for (const r of qtmResults) {
        if (r) ocrAmountMap.set(r.fileId, { amount: r.amount, confidence: r.confidence });
      }
      // Also include previously cached results so upsert doesn't overwrite them with null
      for (const [fileId, cached] of ocrCache.entries()) {
        if (!ocrAmountMap.has(fileId)) ocrAmountMap.set(fileId, cached);
      }
      const processedRows = [...targetUncFiles, ...targetQtmFiles].map((f: any) => {
        const ocr = ocrAmountMap.get(f.id);
        return {
          file_id: String(f.id),
          file_name: String(f.name || f.id),
          folder_date: autoDayFolderPath,
          folder_type: "bank_slip",
          mime_type: f?.mimeType || null,
          parent_folder_id: null,
          processed: true,
          processed_at: processedAt,
          last_seen_at: processedAt,
          extracted_amount: ocr?.amount ?? null,
          extraction_confidence: ocr?.confidence ?? null,
        };
      });

      if (processedRows.length > 0) {
        const { error: processedUpsertError } = await (supabase as any)
          .from("drive_file_index")
          .upsert(processedRows, { onConflict: "file_id", ignoreDuplicates: false });

        if (processedUpsertError) {
          console.error("[FinanceControl] Failed to persist processed markers:", processedUpsertError);
        }
      }

      const uncSummary = {
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
      };
      setUncReconSummary(uncSummary);

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
          ? `Đã quét UNC (${uncTotalScannedCount} file) + QTM (${qtmTotalScannedCount} file) theo ngày ${format(selectedDate, "dd/MM/yyyy")}${ocrErrors.length ? `. OCR lỗi: ${ocrErrors.length} file` : ""}`
          : `Scanned UNC (${uncTotalScannedCount} files) + QTM (${qtmTotalScannedCount} files) for ${format(selectedDate, "dd/MM/yyyy")}${ocrErrors.length ? `. OCR failed on ${ocrErrors.length} file(s)` : ""}`,
      });

      return {
        uncPath,
        qtmPath,
        uncTotalScannedCount,
        qtmTotalScannedCount,
        uncFolderTotal: Number(folderTotal || 0),
        qtmFolderTotal: Number(qtmTotal || 0),
        uncSummary,
      };

    } catch (e: any) {
      const msg = e?.message || (isVi ? "Không thể đối soát UNC/QTM theo ngày" : "Failed reconciling UNC/QTM by date");
      setReconcileError(msg);
      setReconcileProgress((prev) => ({ ...prev, currentFile: "" }));
      toast({ title: isVi ? "Lỗi đối soát trong ngày" : "Daily reconciliation error", description: msg, variant: "destructive" });
      throw e; // Re-throw so executeClose stops
    } finally {
      setReconcilingFolderScan(false);
      setQtmReconciling(false);
    }
  };

  const runQtmReconciliation = async () => {
    setQtmReconciling(true);
    try {
      const session = await getFreshSession();
      const folderUrl = await getUncRootFolderUrl();
      const qtmPath = qtmPathForDate;

      const scanResponse = await fetchWithTimeout(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
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
    const normalized = await normalizeUploadImage(file);
    const session = await getFreshSession();

    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/finance-extract-slip-amount`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ imageBase64: normalized.imageBase64, mimeType: normalized.mimeType, slipType }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.detail || err?.error || `Failed extracting ${slipType} amount`);
    }

    const result = await response.json();
    return { imageBase64: normalized.imageBase64, extracted: result.data as { amount: number; confidence?: number; transfer_date?: string; reference?: string } };
  };

  const processSlipUpload = async (slipType: "qtm" | "unc", files: File[]) => {
    if (!files.length) return;
    setDeclarationSaveMessage(null);
    setOcrDebugMessage(null);
    setExtracting(true);
    try {
      const batchResults: Array<{ imageBase64: string; extracted: any; file: File }> = [];
      for (const file of files) {
        const result = await extractSlipAmount(file, slipType);
        const amount = Number(result?.extracted?.amount || 0);
        const confidence = Number(result?.extracted?.confidence || 0);
        console.log(`[finance][slip-ocr] ${slipType}`, {
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          amount,
          confidence,
          extracted: result?.extracted,
        });
        batchResults.push({ ...result, file });
      }

      const zeroAmountFiles = batchResults.filter((r) => Number(r.extracted?.amount || 0) <= 0);
      if (zeroAmountFiles.length > 0) {
        const debugText = `${slipType.toUpperCase()} OCR zero amount: ${zeroAmountFiles.map((r) => `${r.file.name} (confidence ${Number(r.extracted?.confidence || 0).toFixed(2)})`).join(", ")}`;
        setOcrDebugMessage(debugText);
        setDeclarationSaveMessage(isVi
          ? "OCR chưa đọc ra số tiền từ ảnh vừa tải lên. Hệ thống không lưu ảnh và không cập nhật giao diện."
          : "OCR could not extract an amount from the uploaded image. The system did not keep the image or update the UI.");
        toast({
          title: isVi ? "OCR chưa đọc ra số tiền" : "OCR did not extract amount",
          description: debugText,
          variant: "destructive",
        });
        return;
      }

      const batchSum = batchResults.reduce((sum, r) => sum + Number(r.extracted?.amount || 0), 0);
      const previews = batchResults.map((r) => `data:${r.file.type || "image/jpeg"};base64,${r.imageBase64}`);
      const batchImageBase64 = batchResults.map((r) => r.imageBase64);
      const batchExtractedList = batchResults.map((r) => r.extracted);

      let nextUncTotalDeclared = Number(uncTotalDeclared || 0);
      let nextCashFundTopupAmount = Number(cashFundTopupAmount || 0);
      let nextPendingQtmImagesBase64 = pendingQtmImagesBase64;
      let nextPendingUncImagesBase64 = pendingUncImagesBase64;
      let nextPendingQtmExtractedList = pendingQtmExtractedList;
      let nextPendingUncExtractedList = pendingUncExtractedList;

      if (slipType === "qtm") {
        nextCashFundTopupAmount = Number(cashFundTopupAmount || 0) + batchSum;
        nextPendingQtmImagesBase64 = [...pendingQtmImagesBase64, ...batchImageBase64];
        nextPendingQtmExtractedList = [...pendingQtmExtractedList, ...batchExtractedList];
        setCashFundTopupAmount(nextCashFundTopupAmount);
        setQtmSlipPreviews((prev) => [...prev, ...previews]);
        setPendingQtmImagesBase64(nextPendingQtmImagesBase64);
        setPendingQtmExtractedList(nextPendingQtmExtractedList);
      } else {
        nextUncTotalDeclared = Number(uncTotalDeclared || 0) + batchSum;
        nextPendingUncImagesBase64 = [...pendingUncImagesBase64, ...batchImageBase64];
        nextPendingUncExtractedList = [...pendingUncExtractedList, ...batchExtractedList];
        setUncTotalDeclared(nextUncTotalDeclared);
        setUncSlipPreviews((prev) => [...prev, ...previews]);
        setPendingUncImagesBase64(nextPendingUncImagesBase64);
        setPendingUncExtractedList(nextPendingUncExtractedList);
      }

      toast({
        title: isVi ? "Đã scan slip — tự động lưu" : "Slip scanned — auto-saving",
        description: `${slipType === "qtm" ? "QTM" : "UNC"}: +${vnd(batchSum)} (${batchResults.length} ảnh)`,
      });

      // Auto-save declaration after OCR using the freshly computed values,
      // avoiding stale React state during rapid UNC/QTM consecutive uploads.
      await saveDeclaration(true, {
        uncTotalDeclared: nextUncTotalDeclared,
        cashFundTopupAmount: nextCashFundTopupAmount,
        pendingQtmImagesBase64: nextPendingQtmImagesBase64,
        pendingUncImagesBase64: nextPendingUncImagesBase64,
        pendingQtmExtractedList: nextPendingQtmExtractedList,
        pendingUncExtractedList: nextPendingUncExtractedList,
      });
    } catch (e: any) {
      setDeclarationSaveMessage(e?.message || (isVi ? "Ảnh đã tải lên nhưng OCR chưa đọc được số tiền. Anh có thể chỉnh tay số tiền rồi bấm Lưu khai báo." : "Image uploaded but OCR could not extract amount. You can adjust the number manually and press Save declaration."));
      toast({ title: "Lỗi OCR slip", description: e?.message || "Không thể trích xuất số tiền từ ảnh upload. Nếu ảnh chụp từ iPhone, vui lòng thử lại sau khi chụp rõ hơn hoặc dùng ảnh/JPEG ít nén hơn.", variant: "destructive" });
    } finally {
      setExtracting(false);
    }
  };

  const saveReconciliationWorkflowMeta = async (
    decisionOverride?: "reject" | "conditional" | "approve",
    lockOverride?: boolean,
    actionOverride?: string,
    snapshotOverride?: {
      uncDrive?: number;
      uncCEO?: number;
      uncVariance?: number;
      qtmOpening?: number;
      qtmCEO?: number;
      qtmDrive?: number;
      qtmClosing?: number;
      qtmVariance?: number;
      status?: "match" | "mismatch";
    },
  ) => {
    const decision = decisionOverride || closeDecision;
    const snapshot = {
      uncDrive: Number(snapshotOverride?.uncDrive ?? resolvedUncDetail ?? 0),
      uncCEO: Number(snapshotOverride?.uncCEO ?? resolvedUncDeclared ?? 0),
      uncVariance: Number(snapshotOverride?.uncVariance ?? resolvedVariance ?? 0),
      qtmOpening: Number(snapshotOverride?.qtmOpening ?? qtmOpeningBalance ?? 0),
      qtmCEO: Number(snapshotOverride?.qtmCEO ?? cashFundTopupAmount ?? 0),
      qtmDrive: Number(snapshotOverride?.qtmDrive ?? resolvedQtmDrive ?? 0),
      qtmClosing: Number(snapshotOverride?.qtmClosing ?? qtmClosingBalance ?? 0),
      qtmVariance: Number(snapshotOverride?.qtmVariance ?? (resolvedQtmDrive - Number(cashFundTopupAmount || 0)) ?? 0),
      status: (snapshotOverride?.status ?? resolvedStatus ?? "mismatch") as "match" | "mismatch",
    };
    const nextLog = {
      at: new Date().toISOString(),
      actor: "CEO",
      action: actionOverride || (decision === "reject" ? "reject_close" : decision === "conditional" ? "conditional_close" : "approve_close"),
      detail: closeReason || null,
      snapshot,
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
          qtm_opening_balance: snapshot.qtmOpening,
          qtm_spent_from_folder: snapshot.qtmDrive,
          qtm_closing_balance: snapshot.qtmClosing,
          qtm_low_confidence_count: Number(qtmLowConfidenceCount || 0),
        },
      }, { onConflict: "closing_date" });

    if (error) throw error;
    setReconciliationAuditLogs(mergedLogs);
    setCloseApprovalLocked(lockOverride ?? (decision === "approve" ? true : closeApprovalLocked));
    setQtmSpentFromFolder(snapshot.qtmDrive);
  };

  const openSlipPreview = (src: string, title: string) => {
    setSlipPreviewSrc(src);
    setSlipPreviewTitle(title);
    setSlipPreviewOpen(true);
  };

  const deleteDeclaredSlip = async (slipType: "qtm" | "unc", index: number) => {
    if (!isOwner) {
      toast({
        title: isVi ? "Không có quyền xoá slip" : "No permission to delete slip",
        description: isVi ? "Chỉ owner mới được xoá slip đã khai báo." : "Only owners can delete declared slips.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    setDeclarationSaveMessage(null);
    try {
      const { data: latestDecl, error: latestError } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select("closing_date,unc_total_declared,unc_extracted_amount,cash_fund_topup_amount,qtm_extracted_amount,notes,extraction_meta")
        .eq("closing_date", dateKey)
        .maybeSingle();
      if (latestError) throw latestError;
      if (!latestDecl) throw new Error(isVi ? "Không tìm thấy khai báo CEO để xoá slip." : "CEO declaration not found.");

      const meta = latestDecl.extraction_meta || {};
      const currentQtmImages = Array.isArray(meta.qtm_images)
        ? meta.qtm_images
        : (latestDecl.qtm_slip_image_base64 ? [latestDecl.qtm_slip_image_base64] : []);
      const currentUncImages = Array.isArray(meta.unc_images)
        ? meta.unc_images
        : (latestDecl.unc_slip_image_base64 ? [latestDecl.unc_slip_image_base64] : []);
      const currentQtmItems = Array.isArray(meta.qtm_items) ? meta.qtm_items : [];
      const currentUncItems = Array.isArray(meta.unc_items) ? meta.unc_items : [];

      const nextQtmImages = slipType === "qtm" ? currentQtmImages.filter((_: any, i: number) => i !== index) : currentQtmImages;
      const nextUncImages = slipType === "unc" ? currentUncImages.filter((_: any, i: number) => i !== index) : currentUncImages;
      const nextQtmItems = slipType === "qtm" ? currentQtmItems.filter((_: any, i: number) => i !== index) : currentQtmItems;
      const nextUncItems = slipType === "unc" ? currentUncItems.filter((_: any, i: number) => i !== index) : currentUncItems;

      const nextQtmAmount = nextQtmItems.reduce((sum: number, item: any) => sum + Number(item?.amount || 0), 0);
      const nextUncAmount = nextUncItems.reduce((sum: number, item: any) => sum + Number(item?.amount || 0), 0);

      const nextMeta = {
        ...meta,
        qtm_images: nextQtmImages,
        unc_images: nextUncImages,
        qtm_items: nextQtmItems,
        unc_items: nextUncItems,
      };

      const payload = {
        closing_date: dateKey,
        unc_total_declared: nextUncAmount,
        unc_extracted_amount: nextUncAmount,
        cash_fund_topup_amount: nextQtmAmount,
        qtm_extracted_amount: nextQtmAmount,
        qtm_slip_image_base64: nextQtmImages[0] || null,
        unc_slip_image_base64: nextUncImages[0] || null,
        extraction_meta: nextMeta,
        notes: latestDecl.notes || null,
      };

      const { error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .upsert(payload, { onConflict: "closing_date" });
      if (error) throw error;

      setQtmSlipPreviews(nextQtmImages.map((b64: string) => `data:image/jpeg;base64,${b64}`));
      setUncSlipPreviews(nextUncImages.map((b64: string) => `data:image/jpeg;base64,${b64}`));
      setPendingQtmImagesBase64([]);
      setPendingUncImagesBase64([]);
      setPendingQtmExtractedList([]);
      setPendingUncExtractedList([]);
      setCashFundTopupAmount(nextQtmAmount);
      setUncTotalDeclared(nextUncAmount);
      setDeclarationSaveMessage(isVi ? "Đã xoá slip và lưu lại khai báo CEO" : "Slip deleted and CEO declaration updated");
      await refetchDeclaration();
      toast({
        title: isVi ? "Đã xoá slip" : "Slip deleted",
        description: isVi ? "Khai báo CEO đã được cập nhật theo danh sách slip còn lại." : "CEO declaration has been recalculated from the remaining slips.",
      });
    } catch (e: any) {
      toast({
        title: isVi ? "Xoá slip thất bại" : "Failed to delete slip",
        description: e?.message || (isVi ? "Không thể xoá slip" : "Unable to delete slip"),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const saveDeclaration = async (
    silent = false,
    overrides?: {
      uncTotalDeclared?: number;
      cashFundTopupAmount?: number;
      pendingQtmImagesBase64?: string[];
      pendingUncImagesBase64?: string[];
      pendingQtmExtractedList?: any[];
      pendingUncExtractedList?: any[];
    },
  ): Promise<boolean> => {
    setSaving(true);
    setDeclarationSaveMessage(null);
    try {
      const { data: latestDecl } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select("closing_date,unc_total_declared,unc_extracted_amount,cash_fund_topup_amount,qtm_extracted_amount,notes,extraction_meta")
        .eq("closing_date", dateKey)
        .maybeSingle();

      const sourceDecl = latestDecl || dailyDeclaration;
      const existingQtmImages = Array.isArray(sourceDecl?.extraction_meta?.qtm_images)
        ? sourceDecl.extraction_meta.qtm_images
        : (sourceDecl?.qtm_slip_image_base64 ? [sourceDecl.qtm_slip_image_base64] : []);
      const existingUncImages = Array.isArray(sourceDecl?.extraction_meta?.unc_images)
        ? sourceDecl.extraction_meta.unc_images
        : (sourceDecl?.unc_slip_image_base64 ? [sourceDecl.unc_slip_image_base64] : []);

      const nextUncTotalDeclared = Number((overrides?.uncTotalDeclared ?? uncTotalDeclared) || 0);
      const nextCashFundTopupAmount = Number((overrides?.cashFundTopupAmount ?? cashFundTopupAmount) || 0);
      const nextPendingQtmImagesBase64 = overrides?.pendingQtmImagesBase64 ?? pendingQtmImagesBase64;
      const nextPendingUncImagesBase64 = overrides?.pendingUncImagesBase64 ?? pendingUncImagesBase64;
      const nextPendingQtmExtractedList = overrides?.pendingQtmExtractedList ?? pendingQtmExtractedList;
      const nextPendingUncExtractedList = overrides?.pendingUncExtractedList ?? pendingUncExtractedList;

      const finalQtmImages = [...existingQtmImages, ...nextPendingQtmImagesBase64];
      const finalUncImages = [...existingUncImages, ...nextPendingUncImagesBase64];

      const payload = {
        closing_date: dateKey,
        unc_total_declared: nextUncTotalDeclared,
        cash_fund_topup_amount: nextCashFundTopupAmount,
        qtm_extracted_amount: nextCashFundTopupAmount,
        unc_extracted_amount: nextUncTotalDeclared,
        // giữ cột cũ để backward-compatible (preview nhanh ảnh đầu)
        qtm_slip_image_base64: finalQtmImages[0] || null,
        unc_slip_image_base64: finalUncImages[0] || null,
        extraction_meta: {
          ...(sourceDecl?.extraction_meta || {}),
          qtm_images: finalQtmImages,
          unc_images: finalUncImages,
          qtm_items: [
            ...((sourceDecl?.extraction_meta?.qtm_items as any[]) || []),
            ...nextPendingQtmExtractedList,
          ],
          unc_items: [
            ...((sourceDecl?.extraction_meta?.unc_items as any[]) || []),
            ...nextPendingUncExtractedList,
          ],
          ceo_declaration_locked: ceoDeclarationLocked,
          close_decision: closeDecision,
          close_approval_locked: closeApprovalLocked,
          close_reason: closeReason || null,
          reconciliation_audit_logs: reconciliationAuditLogs,
          qtm_opening_balance: Number(qtmOpeningBalance || 0),
          qtm_spent_from_folder: Number(qtmSpentFromFolder || 0),
          qtm_closing_balance: Number(qtmOpeningBalance || 0) + nextCashFundTopupAmount - Number(qtmSpentFromFolder || 0),
          qtm_low_confidence_count: Number(qtmLowConfidenceCount || 0),
        },
        notes: notes || null,
      };

      const { error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .upsert(payload, { onConflict: "closing_date" });

      if (error) throw error;
      if (!silent) {
        setDeclarationSaveMessage(isVi ? "Đã lưu khai báo CEO" : "CEO declaration saved");
        toast({ title: "Saved", description: "CEO daily declaration has been updated." });
      }
      setPendingQtmImagesBase64([]);
      setPendingUncImagesBase64([]);
      setPendingQtmExtractedList([]);
      setPendingUncExtractedList([]);
      await refetchDeclaration();
      return true;
    } catch (e: any) {
      setDeclarationSaveMessage(e?.message || (isVi ? "Không thể lưu khai báo" : "Failed to save declaration"));
      if (!silent) {
        toast({ title: "Error", description: e?.message || "Failed to save declaration", variant: "destructive" });
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runReconcile = async (freshData?: { uncFolderTotal?: number; qtmFolderTotal?: number; uncDeclared?: number; qtmDeclared?: number }) => {
    setReconciling(true);
    try {
      // --- UNC reconciliation: exact match required (bank-automated, no tolerance) ---
      // freshData bypasses stale React state when called right after runFolderReconciliation
      const uncDetail = Number((freshData?.uncFolderTotal ?? uncReconSummary?.folderTotal ?? persistedFolderTotal ?? dailyReconciliation?.unc_detail_amount ?? uncDetailAmount) || 0);
      const uncDeclared = Number((freshData?.uncDeclared ?? uncReconSummary?.ceoTotal ?? dailyReconciliation?.unc_declared_amount ?? uncTotalDeclared) || 0);
      const uncVariance = uncDetail - uncDeclared;
      const uncStatus: "match" | "mismatch" = uncVariance === 0 ? "match" : "mismatch";

      // --- QTM reconciliation: overspend is allowed as long as closing cash stays non-negative ---
      const qtmDeclared = Number((freshData?.qtmDeclared ?? cashFundTopupAmount) || 0);
      const qtmSpent = Number((freshData?.qtmFolderTotal ?? qtmSpentFromFolder) || 0);
      const qtmVariance = qtmSpent - qtmDeclared; // positive = spent more than CEO declared
      const effectiveOpeningBalance = Number(qtmOpeningBalance || 0);
      const qtmClosingBalanceFresh = effectiveOpeningBalance + qtmDeclared - qtmSpent;
      const qtmStatus: "match" | "mismatch" = qtmClosingBalanceFresh >= 0 ? "match" : "mismatch";

      // Overall status: UNC must match exactly; QTM only fails if closing balance goes negative
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
      if (qtmStatus === "mismatch") summaryParts.push(`QTM ${isVi ? "âm quỹ" : "negative closing balance"}: ${vnd(Math.abs(qtmClosingBalanceFresh))}`);

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
      return {
        status,
        uncVariance,
        qtmVariance,
        uncDetail,
        uncDeclared,
        qtmDeclared,
        qtmSpent,
        qtmOpening: effectiveOpeningBalance,
        qtmClosingBalance: qtmClosingBalanceFresh,
      };
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Reconciliation failed", variant: "destructive" });
      return null;
    } finally {
      setReconciling(false);
    }
  };

  // Open close dialog → preview step (scan file list only, no OCR yet)
  const openCloseDialog = async () => {
    if (closeApprovalLocked) {
      toast({
        title: isVi ? "Đã khoá" : "Already locked",
        description: isVi ? "Ngày này đã chốt. Mở khoá trước để chỉnh sửa." : "This day is already closed. Unlock first to edit.",
      });
      return;
    }
    setCloseDialogOpen(true);
    setCloseDialogStep("preview");
    setMismatchResult(null);
    setReconcileError(null);
    setPreviewUncFiles(0);
    setPreviewQtmFiles(0);
    setPreviewLoading(true);
    setCloseResultSnapshot(null);
    try {
      const session = await getFreshSession();
      const folderUrl = await getUncRootFolderUrl();
      const uncPath = uncPathForDate;
      const qtmPath = qtmPathForDate;

      const scanPreview = async (path: string) => {
        const resp = await fetchWithTimeout(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({ folderUrl, subfolderDate: path, includeBase64: false, skipProcessed: false }),
        }, 20000);
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          const detail = resp.status === 401
            ? "Phiên đăng nhập hết hạn — vui lòng đăng nhập lại"
            : err?.details || err?.error || `HTTP ${resp.status}`;
          return { files: [], error: detail };
        }
        return await resp.json();
      };

      const [uncData, qtmData] = await Promise.all([scanPreview(uncPath), scanPreview(qtmPath)]);
      setPreviewUncFiles(uncData?.totalFilesFound ?? uncData?.files?.length ?? 0);
      setPreviewQtmFiles(qtmData?.totalFilesFound ?? qtmData?.files?.length ?? 0);

      if (uncData?.error || qtmData?.error) {
        const errors = [uncData?.error && `UNC: ${uncData.error}`, qtmData?.error && `QTM: ${qtmData.error}`].filter(Boolean).join(" | ");
        if (canCloseWithoutBankSlips) {
          setReconcileError(null);
        } else {
          setReconcileError(errors);
        }
      }
    } catch (e: any) {
      setReconcileError(e?.message || (isVi ? "Không thể kết nối Drive" : "Cannot connect to Drive"));
    } finally {
      setPreviewLoading(false);
    }
  };

  // Execute: save → scan → reconcile → lock → close
  const executeClose = async () => {
    setCloseDialogStep("running");
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
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Bước 2/4: Quét & OCR bank slip..." : "Step 2/4: Scanning & OCR bank slips..." });
      const folderScanResult = canCloseWithoutBankSlips
        ? {
            uncPath: uncPathForDate,
            qtmPath: qtmPathForDate,
            uncTotalScannedCount: 0,
            qtmTotalScannedCount: 0,
            uncFolderTotal: 0,
            qtmFolderTotal: 0,
          }
        : await runFolderReconciliation();
      if (!folderScanResult) {
        throw new Error(isVi ? "Không nhận được kết quả quét thư mục Drive" : "Missing Drive scan result");
      }

      if (hasDeclaredUnc && folderScanResult.uncTotalScannedCount === 0) {
        throw new Error(isVi
          ? `Không thể chốt ngày: UNC đã khai báo ${vnd(Number(uncTotalDeclared || 0))} nhưng thư mục Drive UNC không quét được file nào (${folderScanResult.uncPath}).`
          : `Cannot close day: UNC was declared but Drive UNC scan returned 0 files (${folderScanResult.uncPath}).`);
      }
      if (hasDeclaredQtm && folderScanResult.qtmTotalScannedCount === 0) {
        throw new Error(isVi
          ? `Không thể chốt ngày: QTM đã khai báo ${vnd(Number(cashFundTopupAmount || 0))} nhưng thư mục Drive QTM không quét được file nào (${folderScanResult.qtmPath}).`
          : `Cannot close day: QTM was declared but Drive QTM scan returned 0 files (${folderScanResult.qtmPath}).`);
      }
      if ((hasDeclaredUnc && Number(folderScanResult.uncFolderTotal || 0) === 0) || (hasDeclaredQtm && Number(folderScanResult.qtmFolderTotal || 0) === 0)) {
        throw new Error(isVi
          ? "Không thể chốt ngày: có bank slip đã khai báo nhưng tổng tiền quét từ Drive vẫn bằng 0. Vui lòng kiểm tra lại thư mục đang lưu hoặc kết quả OCR."
          : "Cannot close day: declared bank slips exist but Drive scanned total is still 0. Please verify the saved folder or OCR results.");
      }

      // Step 3: Run reconciliation
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Bước 3/4: Đối soát UNC & QTM..." : "Step 3/4: Reconciling UNC & QTM..." });
      await refetchUncDetail();
      // Pass fresh totals directly to avoid stale React state (folderScanResult state updates are async)
      const result = await runReconcile({
        uncFolderTotal: folderScanResult.uncFolderTotal,
        qtmFolderTotal: folderScanResult.qtmFolderTotal,
        uncDeclared: Number(uncTotalDeclared || 0),
        qtmDeclared: Number(cashFundTopupAmount || 0),
      });
      if (!result) {
        throw new Error(isVi ? "Không thể hoàn tất đối soát UNC/QTM" : "Failed to complete reconciliation");
      }
      if (result.status !== "match" || Number(result.uncVariance || 0) !== 0) {
        // Show mismatch warning — let CEO decide whether to override
        setMismatchResult(result);
        setCloseResultSnapshot({
          uncDrive: Number(folderScanResult.uncFolderTotal || 0),
          uncCEO: Number(uncTotalDeclared || 0),
          qtmDrive: Number(folderScanResult.qtmFolderTotal || 0),
          qtmCEO: Number(cashFundTopupAmount || 0),
          status: result.status,
        });
        setCloseDialogStep("mismatch");
        return; // finally block will call setCloseActing(false)
      }

      // Step 4: Lock & close
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Bước 4/4: Khoá & chốt ngày..." : "Step 4/4: Locking & closing..." });
      setCloseDecision("approve");
      await saveReconciliationWorkflowMeta("approve", true, undefined, {
        uncDrive: Number(folderScanResult.uncFolderTotal || 0),
        uncCEO: Number(uncTotalDeclared || 0),
        uncVariance: Number(result.uncVariance || 0),
        qtmOpening: Number(result.qtmOpening || qtmOpeningBalance || 0),
        qtmCEO: Number(cashFundTopupAmount || 0),
        qtmDrive: Number(folderScanResult.qtmFolderTotal || 0),
        qtmClosing: Number(result.qtmClosingBalance || 0),
        qtmVariance: Number(result.qtmVariance || 0),
        status: result.status,
      });

      setReconcileProgress({ done: 0, total: 0, currentFile: "" });
      setCloseResultSnapshot({
        uncDrive: Number(folderScanResult.uncFolderTotal || 0),
        uncCEO: Number(uncTotalDeclared || 0),
        qtmDrive: Number(folderScanResult.qtmFolderTotal || 0),
        qtmCEO: Number(cashFundTopupAmount || 0),
        status: result.status,
      });
      setCloseDialogStep("done");
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
      setCloseDialogStep("preview"); // Go back to preview so user can retry or change settings
    } finally {
      setCloseActing(false);
    }
  };

  const handleConfirmMismatchClose = async () => {
    setCloseActing(true);
    setCloseDialogStep("running");
    try {
      setReconcileProgress({ done: 0, total: 0, currentFile: isVi ? "Bước 4/4: Khoá & chốt ngày..." : "Step 4/4: Locking & closing..." });
      setCloseDecision("approve");
      await saveReconciliationWorkflowMeta("approve", true, undefined, {
        uncDrive: Number((closeResultSnapshot?.uncDrive ?? resolvedUncDetail) || 0),
        uncCEO: Number((closeResultSnapshot?.uncCEO ?? resolvedUncDeclared) || 0),
        uncVariance: Number(Number((closeResultSnapshot?.uncDrive ?? resolvedUncDetail) || 0) - Number((closeResultSnapshot?.uncCEO ?? resolvedUncDeclared) || 0)),
        qtmOpening: Number(qtmOpeningBalance || 0),
        qtmCEO: Number((closeResultSnapshot?.qtmCEO ?? cashFundTopupAmount) || 0),
        qtmDrive: Number((closeResultSnapshot?.qtmDrive ?? resolvedQtmDrive) || 0),
        qtmClosing: Number(qtmOpeningBalance || 0) + Number((closeResultSnapshot?.qtmCEO ?? cashFundTopupAmount) || 0) - Number((closeResultSnapshot?.qtmDrive ?? resolvedQtmDrive) || 0),
        qtmVariance: Number((closeResultSnapshot?.qtmDrive ?? resolvedQtmDrive) || 0) - Number((closeResultSnapshot?.qtmCEO ?? cashFundTopupAmount) || 0),
        status: "mismatch",
      });
      setReconcileProgress({ done: 0, total: 0, currentFile: "" });
      setCloseResultSnapshot((prev) => prev || {
        uncDrive: Number(resolvedUncDetail || 0),
        uncCEO: Number(resolvedUncDeclared || 0),
        qtmDrive: Number(resolvedQtmDrive || 0),
        qtmCEO: Number(cashFundTopupAmount || 0),
        status: "mismatch",
      });
      setCloseDialogStep("done");
      toast({
        title: isVi ? "Đã chốt ngày (có chênh lệch)" : "Day closed (with variance)",
        description: isVi ? "CEO đã xác nhận chốt dù có chênh lệch UNC/QTM. Vui lòng kiểm tra lại sau." : "CEO confirmed close despite UNC/QTM variance. Please review later.",
        variant: "destructive",
      });
      await refetchDeclaration();
    } catch (e: any) {
      setReconcileError(e?.message || (isVi ? "Lỗi khi chốt ngày" : "Failed closing day"));
      setCloseDialogStep("mismatch");
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
          <div className="text-xl font-semibold">{vnd(Number(resolvedQtmDeclared || 0))}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">{isVi ? "Tồn quỹ đầu ngày" : "Opening cash balance"}</div>
          <div className="text-xl font-semibold">{vnd(Number(resolvedQtmOpening || 0))}</div>
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

      <Tabs value={activeTab} onValueChange={(value) => {
        setActiveTab(value);
        if (value === "monthly") {
          setSelectedMonth(startOfMonth(selectedDate));
        }
      }} className="space-y-4">
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
                        <div key={`unc-${idx}`} className="group relative">
                          <button
                            type="button"
                            className="overflow-hidden rounded border bg-background"
                            onClick={() => openSlipPreview(src, `UNC slip ${idx + 1}`)}
                          >
                            <img src={src} alt={`UNC slip ${idx + 1}`} className="h-20 rounded object-contain transition-transform group-hover:scale-[1.02]" />
                          </button>
                          {isOwner && (
                            <button
                              type="button"
                              className="absolute right-1 top-1 rounded bg-destructive p-1 text-destructive-foreground shadow-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteDeclaredSlip("unc", idx);
                              }}
                              aria-label={`Delete UNC slip ${idx + 1}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
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
                  {ocrDebugMessage && (
                    <div className="text-xs rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-destructive">
                      {ocrDebugMessage}
                    </div>
                  )}
                  {!!qtmSlipPreviews.length && (
                    <div className="flex flex-wrap gap-2">
                      {qtmSlipPreviews.map((src, idx) => (
                        <div key={`qtm-${idx}`} className="group relative">
                          <button
                            type="button"
                            className="overflow-hidden rounded border bg-background"
                            onClick={() => openSlipPreview(src, `QTM slip ${idx + 1}`)}
                          >
                            <img src={src} alt={`QTM slip ${idx + 1}`} className="h-20 rounded object-contain transition-transform group-hover:scale-[1.02]" />
                          </button>
                          {isOwner && (
                            <button
                              type="button"
                              className="absolute right-1 top-1 rounded bg-destructive p-1 text-destructive-foreground shadow-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteDeclaredSlip("qtm", idx);
                              }}
                              aria-label={`Delete QTM slip ${idx + 1}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-lg font-semibold">{vnd(Number(cashFundTopupAmount || 0))}</div>
                </div>
              </div>

              {extracting && <div className="text-sm text-muted-foreground animate-pulse">{isVi ? "Đang scan slip..." : "Scanning slips..."}</div>}
              {declarationSaveMessage && (
                <div className={`text-sm ${declarationSaveMessage.includes("Đã lưu") || declarationSaveMessage.includes("saved") ? "text-green-600" : "text-amber-600"}`}>
                  {declarationSaveMessage}
                </div>
              )}
              <div className="flex justify-end">
                <Button type="button" variant="outline" disabled={extracting || saving || ceoDeclarationLocked || closeApprovalLocked} onClick={() => saveDeclaration(false)}>
                  {saving ? (isVi ? "Đang lưu..." : "Saving...") : (isVi ? "Lưu khai báo" : "Save declaration")}
                </Button>
              </div>
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
                    onClick={openCloseDialog}
                  >
                    <Lock className="h-5 w-5 mr-2" />
                    {isVi ? "Duyệt & Chốt ngày" : "Approve & Close Day"}
                  </Button>
                )}
              </div>

              {/* Last reconciliation result (compact) */}
              {uncReconSummary && (
                <div className="grid gap-2 grid-cols-2 md:grid-cols-4 text-sm">
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">UNC Drive</span><div className="font-semibold">{vnd(resolvedUncDetail)}</div></div>
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">UNC CEO</span><div className="font-semibold">{vnd(resolvedUncDeclared)}</div></div>
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">QTM Drive</span><div className="font-semibold">{vnd(resolvedQtmDrive)}</div></div>
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">QTM CEO</span><div className="font-semibold">{vnd(Number(resolvedQtmDeclared || 0))}</div></div>
                </div>
              )}

              {/* Ghi chú + Audit log */}
              <div className="flex gap-3 items-end">
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">{isVi ? "Ghi chú" : "Notes"}</Label>
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={isVi ? "Tuỳ chọn" : "Optional"} disabled={closeApprovalLocked} className="text-sm" />
                </div>
                {reconciliationAuditLogs.length > 0 && (
                  <details className="text-xs shrink-0">
                    <summary className="cursor-pointer text-muted-foreground">{isVi ? `Nhật ký (${reconciliationAuditLogs.length})` : `Log (${reconciliationAuditLogs.length})`}</summary>
                    <div className="mt-1 space-y-1 max-h-32 overflow-auto">
                      {reconciliationAuditLogs.slice().reverse().slice(0, 5).map((log, idx) => (
                        <div key={`${log.at}-${idx}`} className="rounded border px-2 py-1">
                          {new Date(log.at).toLocaleString("vi-VN")} — {log.action}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="monthly" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="text-xl sm:text-2xl">{isVi ? "Chốt tháng" : "Monthly Closing"}</CardTitle>
                <Input
                  type="month"
                  className="w-full sm:w-40"
                  value={format(selectedMonth, "yyyy-MM")}
                  onChange={(e) => setSelectedMonth(new Date(`${e.target.value}-01`))}
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-4 overflow-hidden">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tổng UNC thực" : "Total UNC actual"}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.totalUncDetail || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tổng UNC khai báo" : "Total UNC declared"}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.totalUncDeclared || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Chênh lệch UNC" : "UNC variance"}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.netVariance || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tỷ lệ khớp" : "Match rate"}</div><div className="break-words text-lg font-semibold sm:text-xl">{monthlySummary?.totalDays ? `${monthlySummary.matchDays}/${monthlySummary.totalDays}` : "—"}</div></CardContent></Card>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Số dư đầu tháng" : "Opening QTM balance"}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.monthOpeningQtm || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tổng nộp QTM" : "Total QTM declared"}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.totalQtmDeclared || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tổng chi QTM" : "Total QTM spent"}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.totalQtmSpent || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Số dư cuối tháng" : "Closing QTM balance"}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.monthClosingQtm || 0))}</div></CardContent></Card>
              </div>

              <div className="overflow-x-auto rounded-md border">
                <Table className="min-w-[1180px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">{isVi ? "Ngày" : "Date"}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{isVi ? "UNC thực" : "UNC actual"}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{isVi ? "UNC khai báo" : "UNC declared"}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{isVi ? "Chênh lệch" : "Variance"}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{isVi ? "QTM đầu ngày" : "QTM opening"}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{isVi ? "QTM nộp" : "QTM declared"}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{isVi ? "QTM chi" : "QTM spent"}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{isVi ? "QTM cuối ngày" : "QTM closing"}</TableHead>
                      <TableHead className="whitespace-nowrap">{isVi ? "UNC" : "UNC"}</TableHead>
                      <TableHead className="whitespace-nowrap">{isVi ? "QTM" : "QTM"}</TableHead>
                      <TableHead className="whitespace-nowrap">{isVi ? "Tổng" : "Overall"}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monthlySummary?.rows?.map((r: any) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{format(new Date(r.closing_date), "dd/MM/yyyy", { locale: vi })}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.unc_detail_amount || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.unc_declared_amount || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.variance_amount || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.qtm_opening_balance || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.qtm_declared_amount || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.qtm_spent_from_folder || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.qtm_closing_balance || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap">{r.unc_status === "match" ? <Badge className="bg-green-600">MATCH</Badge> : r.unc_status === "mismatch" ? <Badge variant="destructive">MISMATCH</Badge> : <Badge variant="secondary">—</Badge>}</TableCell>
                        <TableCell className="whitespace-nowrap">{r.qtm_status === "match" ? <Badge className="bg-green-600">MATCH</Badge> : r.qtm_status === "mismatch" ? <Badge variant="destructive">MISMATCH</Badge> : <Badge variant="secondary">—</Badge>}</TableCell>
                        <TableCell className="whitespace-nowrap">{r.status === "match" ? <Badge className="bg-green-600">MATCH</Badge> : r.status === "mismatch" ? <Badge variant="destructive">MISMATCH</Badge> : <Badge variant="secondary">—</Badge>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {!monthlySummary?.rows?.length && (
                <div className="text-sm text-muted-foreground text-center py-4">{isVi ? "Chưa có dữ liệu" : "No data yet"}</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={slipPreviewOpen} onOpenChange={setSlipPreviewOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{slipPreviewTitle || (isVi ? "Xem slip" : "Slip preview")}</DialogTitle>
            <DialogDescription>
              {isVi ? "Xem phóng to slip đã khai báo." : "Zoomed preview of the declared slip."}
            </DialogDescription>
          </DialogHeader>
          {slipPreviewSrc && (
            <div className="max-h-[75vh] overflow-auto rounded-lg border bg-muted/20 p-2">
              <img src={slipPreviewSrc} alt={slipPreviewTitle || "Slip preview"} className="mx-auto h-auto max-w-full rounded" />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Close Dialog: preview → folder picker → execute */}
      <Dialog open={closeDialogOpen} onOpenChange={(open) => { if (!closeActing) setCloseDialogOpen(open); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{isVi ? "Duyệt & Chốt ngày" : "Approve & Close Day"}</DialogTitle>
            <DialogDescription>
              {format(selectedDate, "dd/MM/yyyy")} — {isVi ? "Kiểm tra thông tin trước khi thực hiện" : "Review before executing"}
            </DialogDescription>
          </DialogHeader>

          {closeDialogStep === "preview" && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
              {/* Planned scan paths */}
              <div className="rounded border p-3 space-y-2">
                <div className="text-sm font-medium">{isVi ? "Đường dẫn sẽ quét" : "Planned scan paths"}</div>
                <div className="grid gap-2 text-sm">
                  <div className="rounded bg-muted/50 p-2">
                    <div className="text-xs text-muted-foreground">UNC</div>
                    <code className="text-xs break-all">{uncPathForDate}</code>
                  </div>
                  <div className="rounded bg-muted/50 p-2">
                    <div className="text-xs text-muted-foreground">QTM</div>
                    <code className="text-xs break-all">{qtmPathForDate}</code>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {isVi
                    ? `Thư mục gốc lấy từ Settings > Google Drive Integration. Pattern hiện tại: UNC = ${uncPathTemplate}, QTM = ${qtmPathTemplate}.`
                    : `Root folder comes from Settings > Google Drive Integration. Current templates: UNC = ${uncPathTemplate}, QTM = ${qtmPathTemplate}.`}
                </div>
              </div>

              {/* Preview results */}
              <div className="rounded border p-3 space-y-2">
                <div className="text-sm font-medium">{isVi ? "Kết quả quét nhanh" : "Quick scan result"}</div>
                {previewLoading ? (
                  <div className="text-sm text-muted-foreground animate-pulse">{isVi ? "Đang quét danh sách file..." : "Scanning file list..."}</div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded bg-muted/50 p-2 text-center">
                      <div className="text-2xl font-bold">{previewUncFiles}</div>
                      <div className="text-xs text-muted-foreground">{isVi ? "file UNC" : "UNC files"}</div>
                    </div>
                    <div className="rounded bg-muted/50 p-2 text-center">
                      <div className="text-2xl font-bold">{previewQtmFiles}</div>
                      <div className="text-xs text-muted-foreground">{isVi ? "file QTM" : "QTM files"}</div>
                    </div>
                  </div>
                )}
              </div>

              {/* CEO declared summary */}
              <div className="rounded border p-3 space-y-1 text-sm">
                <div className="font-medium">{isVi ? "CEO đã khai báo" : "CEO declared"}</div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">UNC:</span>
                  <span className="font-semibold">{vnd(Number(uncTotalDeclared || 0))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">QTM:</span>
                  <span className="font-semibold">{vnd(Number(resolvedQtmDeclared || 0))}</span>
                </div>
              </div>

              {/* Error */}
              {reconcileError && (
                <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {reconcileError}
                </div>
              )}
            </div>
          )}

          {closeDialogStep === "running" && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="animate-spin text-lg">⏳</span>
                {reconcileProgress.currentFile || (isVi ? "Đang xử lý..." : "Processing...")}
              </div>
              {reconcileProgress.total > 0 && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>OCR: {reconcileProgress.done}/{reconcileProgress.total}</span>
                    <span>{Math.round((reconcileProgress.done / reconcileProgress.total) * 100)}%</span>
                  </div>
                  <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-green-600 rounded-full transition-all duration-300" style={{ width: `${(reconcileProgress.done / reconcileProgress.total) * 100}%` }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {closeDialogStep === "done" && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2 text-green-700">
                <Lock className="h-5 w-5" />
                <span className="text-lg font-semibold">{isVi ? "Đã chốt ngày thành công" : "Day closed successfully"}</span>
              </div>
              {closeResultSnapshot && (
                <div className="grid gap-2 grid-cols-2 text-sm">
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">UNC Drive</span><div className="font-semibold">{vnd(closeResultSnapshot.uncDrive)}</div></div>
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">UNC CEO</span><div className="font-semibold">{vnd(closeResultSnapshot.uncCEO)}</div></div>
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">QTM Drive</span><div className="font-semibold">{vnd(closeResultSnapshot.qtmDrive)}</div></div>
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">QTM CEO</span><div className="font-semibold">{vnd(closeResultSnapshot.qtmCEO)}</div></div>
                </div>
              )}
            </div>
          )}

          {closeDialogStep === "mismatch" && (
            <div className="space-y-4 py-2">
              <div className="flex items-center gap-2 text-amber-600">
                <span className="text-xl">⚠️</span>
                <span className="text-base font-semibold">{isVi ? "Phát hiện chênh lệch UNC/QTM" : "UNC/QTM Variance Detected"}</span>
              </div>
              <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2 text-sm">
                {Number(mismatchResult?.uncVariance || 0) !== 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{isVi ? "UNC chênh lệch:" : "UNC variance:"}</span>
                    <span className="font-semibold text-amber-700">{vnd(Math.abs(Number(mismatchResult?.uncVariance || 0)))}</span>
                  </div>
                )}
                {Number(mismatchResult?.qtmVariance || 0) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{isVi ? "QTM chênh lệch:" : "QTM variance:"}</span>
                    <span className="font-semibold text-amber-700">{vnd(Number(mismatchResult?.qtmVariance || 0))}</span>
                  </div>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {isVi
                  ? "Anh có thể chốt ngày dù có chênh lệch. Trạng thái sẽ được ghi là 'mismatch' để xem lại sau."
                  : "You can close the day despite the variance. Status will be recorded as 'mismatch' for later review."}
              </p>
              {reconcileError && (
                <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {reconcileError}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {closeDialogStep === "preview" && (
              <div className="flex gap-2 w-full justify-end">
                <Button variant="outline" onClick={() => setCloseDialogOpen(false)}>{isVi ? "Huỷ" : "Cancel"}</Button>
                <Button variant="outline" size="sm" onClick={openCloseDialog} disabled={previewLoading}>
                  {isVi ? "Quét lại" : "Re-scan"}
                </Button>
                <Button
                  className="bg-green-600 hover:bg-green-700 text-white"
                  disabled={previewLoading || closeActing || missingRequiredPreview || (!!reconcileError && !canCloseWithoutBankSlips)}
                  onClick={executeClose}
                >
                  <Lock className="h-4 w-4 mr-2" />
                  {isVi ? "Thực hiện" : "Execute"}
                </Button>
              </div>
            )}
            {closeDialogStep === "running" && (
              <div className="text-xs text-muted-foreground">{isVi ? "Vui lòng không đóng cửa sổ..." : "Please don't close this window..."}</div>
            )}
            {closeDialogStep === "mismatch" && (
              <div className="flex gap-2 w-full justify-end">
                <Button variant="outline" onClick={() => { setCloseDialogStep("preview"); setMismatchResult(null); setReconcileError(null); }}>
                  {isVi ? "Quay lại" : "Back"}
                </Button>
                <Button
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                  disabled={closeActing}
                  onClick={handleConfirmMismatchClose}
                >
                  <Lock className="h-4 w-4 mr-2" />
                  {isVi ? "Chốt ngày dù có chênh lệch" : "Close day with variance"}
                </Button>
              </div>
            )}
            {closeDialogStep === "done" && (
              <Button onClick={() => setCloseDialogOpen(false)}>{isVi ? "Đóng" : "Close"}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
