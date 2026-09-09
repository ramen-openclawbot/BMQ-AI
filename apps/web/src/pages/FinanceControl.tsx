import { type FinanceMessage, financeMessage, readFinanceMessage, FinanceUiError, localizedFinanceError, financeErrorMessage, retainFinanceError, scanFailureDetail, ocrFileFailure, combinedOcrFailure } from "@/lib/finance-ui-error";
import { formatText } from "@/i18n/format";
import { financeControl } from "@/i18n/financeControl";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format, startOfMonth, endOfMonth, subDays } from "date-fns";
import { vi } from "date-fns/locale";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import {
  useCostClassificationDashboard,
  useCostClassificationLineDetails,
  type CostCategoryOption,
  type CostClassificationCategorySummary,
  type CostClassificationMonthlySummary,
  type CostClassificationReviewRow,
} from "@/hooks/useCostClassifications";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { Lock, Pencil, Trash2, Unlock, X } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { normalizeUploadImage, optimizeSlipImageForOcr } from "@/lib/slip-image";

const vnd = (value: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value || 0);
const COST_CLASSIFICATION_CARD_CODES = [
  "COGS_BMQ_BREAD",
  "COGS_SWEET_KITCHEN",
  "PACKAGING_SALES",
  "OPEX_GENERAL",
  "CAPEX_ASSET_PROJECT",
  "UNMAPPED_REVIEW",
];

const EMPTY_COST_CLASSIFICATION_CATEGORY_ROWS: CostClassificationCategorySummary[] = [];
const EMPTY_COST_CLASSIFICATION_MONTHLY_ROWS: CostClassificationMonthlySummary[] = [];
const EMPTY_COST_CLASSIFICATION_REVIEW_ROWS: CostClassificationReviewRow[] = [];
const EMPTY_COST_CATEGORY_OPTIONS: CostCategoryOption[] = [];

type JsonRecord = Record<string, unknown>;
type SupabaseErrorLike = { message?: string } | null;
type SupabaseResult<T = unknown> = { data: T | null; error: SupabaseErrorLike };
type LooseQueryBuilder<T = JsonRecord[]> = PromiseLike<SupabaseResult<T>> & {
  select: (columns?: string) => LooseQueryBuilder<T>;
  update: (values: JsonRecord) => LooseQueryBuilder<T>;
  upsert: (values: JsonRecord | JsonRecord[], options?: JsonRecord) => LooseQueryBuilder<T>;
  insert: (values: JsonRecord | JsonRecord[]) => LooseQueryBuilder<T>;
  delete: () => LooseQueryBuilder<T>;
  eq: (column: string, value: unknown) => LooseQueryBuilder<T>;
  in: (column: string, values: unknown[]) => LooseQueryBuilder<T>;
  gte: (column: string, value: unknown) => LooseQueryBuilder<T>;
  lt: (column: string, value: unknown) => LooseQueryBuilder<T>;
  order: (column: string, options?: JsonRecord) => LooseQueryBuilder<T>;
  range: (from: number, to: number) => LooseQueryBuilder<T>;
  limit: (count: number) => LooseQueryBuilder<T>;
  single: () => Promise<SupabaseResult<JsonRecord>>;
  maybeSingle: () => Promise<SupabaseResult<JsonRecord>>;
};
type LooseSupabase = {
  from: <T = JsonRecord[]>(table: string) => LooseQueryBuilder<T>;
  rpc: (fn: string, args?: JsonRecord) => Promise<SupabaseResult>;
};
const looseSupabase = supabase as unknown as LooseSupabase;

type MismatchResult = {
  uncVariance?: number;
  qtmClosingBalance?: number;
  qtmClosing?: number;
  qtmOpening?: number;
  qtmDeclared?: number;
  qtmSpent?: number;
  status?: "match" | "mismatch";
} | null;
type DriveFileRow = { id: string; name?: string; mimeType?: string; base64?: string; webViewLink?: string };
type ExtractedSlipItem = { amount?: number; confidence?: number; transfer_date?: string; reference?: string; provider?: string };
type ReconciliationSnapshot = {
  uncDrive?: number;
  uncCEO?: number;
  uncVariance?: number;
  qtmOpening?: number;
  qtmCEO?: number;
  qtmDrive?: number;
  qtmClosing?: number;
  qtmVariance?: number;
  status?: "match" | "mismatch";
};

const asRecord = (value: unknown): JsonRecord => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {});
const getErrorMessage = (error: unknown, fallback: string) => {
  const record = asRecord(error);
  return typeof record.message === "string" && record.message.trim() ? record.message : fallback;
};

type ClassificationEdits = Record<string, string>;
type StandardCostEdit = {
  standard_cost_code_type: string;
  standard_cost_code: string;
  canonical_cost_item_name: string;
  unit_conversion_note: string;
};
type StandardCostEdits = Record<string, Partial<StandardCostEdit>>;
type ClassificationMonthlyDisplayRow = CostClassificationMonthlySummary & {
  review_status_counts: Record<string, number>;
};

type ClassificationChartRow = ClassificationMonthlyDisplayRow & {
  amount: number;
  percentage: number;
  fill: string;
  note: string;
};

const COST_CLASSIFICATION_CHART_COLORS = [
  "#0f766e",
  "#2563eb",
  "#f97316",
  "#7c3aed",
  "#dc2626",
  "#64748b",
  "#16a34a",
  "#ca8a04",
];

const getReviewStatusLabel = (status: string, isVi: boolean) => {
  const labels: Record<string, { vi: string; en: string }> = {
    approved: { vi: "đã duyệt", en: "approved" },
    suggested: { vi: "gợi ý", en: "suggested" },
    needs_review: { vi: "cần kiểm tra", en: "needs review" },
  };
  const normalized = status || "needs_review";
  const label = labels[normalized];
  return label ? (isVi ? label.vi : label.en) : normalized;
};

const formatReviewStatusCounts = (counts: Record<string, number>, isVi: boolean) => {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (!entries.length) return financeControl[isVi ? "vi" : "en"].noNotes;
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${count} ${getReviewStatusLabel(status, isVi)}`)
    .join(" · ");
};

const buildClassificationNote = (
  row: ClassificationMonthlyDisplayRow,
  percentage: number,
  isTopGroup: boolean,
  isVi: boolean,
) => {
  const counts = row.review_status_counts || {};
  const suggested = Number(counts.suggested || counts.needs_review || 0);
  const statusText = suggested > 0
    ? (isVi ? `${suggested} dòng gợi ý cần rà soát` : `${suggested} suggested lines to review`)
    : (financeControl[isVi ? "vi" : "en"].readyForReview);
  const shareText = isVi
    ? `${percentage.toFixed(1)}% tổng chi phí tháng`
    : `${percentage.toFixed(1)}% of monthly cost`;
  return isTopGroup
    ? `${financeControl[isVi ? "vi" : "en"].largestCostGroup} · ${shareText} · ${statusText}`
    : `${shareText} · ${statusText}`;
};

const getClassificationShareLabel = (percentage: number, isVi: boolean) => {
  if (!Number.isFinite(percentage) || percentage <= 0) return financeControl[isVi ? "vi" : "en"].label0Share;
  return isVi ? `${percentage.toFixed(1)}% tỷ trọng` : `${percentage.toFixed(1)}% share`;
};

const escapeCostRulePattern = (value: string) => value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const costDetailSelectionKey = (row: CostClassificationMonthlySummary | null) => row
  ? `${row.month}-${row.category_code}`
  : "";

const getCostGroupAllocationRule = (costGroup: string) => {
  if (costGroup === "cogs") return "direct";
  if (costGroup === "packaging") return "manual";
  return "none";
};

const buildManualCostRuleName = (row: CostClassificationReviewRow) => {
  const supplierKey = row.supplier_id || row.supplier_name || "no-supplier";
  const itemKey = `${row.product_code || ""}-${row.product_name || "item"}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
  return `Manual cost category: ${supplierKey}:${itemKey}`.slice(0, 180);
};

const getLineDateLabel = (value: string | null | undefined) => {
  if (!value) return "-";
  const [y, m, d] = value.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : "-";
};

// Translate only the generated fallback at display boundaries; business category names stay verbatim.
const getCostCategoryDisplayLabel = (label: string | undefined, isVi: boolean) => label === "Chưa phân loại / cần review"
  ? financeControl[isVi ? "vi" : "en"].unclassifiedReview
  : label;

const getCostCategorySelectLabel = (code: string, label?: string) => label ? `${code} — ${label}` : code;
const normalizeCostAliasKey = (value: string) => value
  .trim()
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const getStandardCostDraft = (row: CostClassificationReviewRow, edits: StandardCostEdits): StandardCostEdit => {
  const edit = edits[row.classification_id] || {};
  const existingCode = row.confirmed_standard_cost_code || row.suggested_standard_cost_code || row.product_code || "";
  return {
    standard_cost_code_type: edit.standard_cost_code_type ?? row.standard_cost_code_type ?? "",
    standard_cost_code: edit.standard_cost_code ?? existingCode,
    canonical_cost_item_name: edit.canonical_cost_item_name ?? row.canonical_cost_item_name ?? row.product_name ?? "",
    unit_conversion_note: edit.unit_conversion_note ?? row.unit_conversion_note ?? "",
  };
};

const hasStandardCostDraftChanged = (row: CostClassificationReviewRow, draft: StandardCostEdit) => (
  draft.standard_cost_code_type !== (row.standard_cost_code_type || "")
  || draft.standard_cost_code !== (row.confirmed_standard_cost_code || row.suggested_standard_cost_code || row.product_code || "")
  || draft.canonical_cost_item_name !== (row.canonical_cost_item_name || row.product_name || "")
  || draft.unit_conversion_note !== (row.unit_conversion_note || "")
);

const getOcrErrorMessage = (errorLike: unknown, fallbackMessage: string) => {
  if (typeof errorLike?.error === "string" && errorLike.error.trim()) return errorLike.error;
  if (typeof errorLike?.detail === "string" && errorLike.detail.trim()) return errorLike.detail;
  if (typeof errorLike?.message === "string" && errorLike.message.trim()) return errorLike.message;
  return fallbackMessage;
};
const getOcrTimeoutMessage = (isVi: boolean) => (
  financeControl[isVi ? "vi" : "en"].slipScanningTimedOutPleaseTryAgain
);

const getQtmClosingFromMismatch = (result: MismatchResult) => {
  if (!result) return 0;
  if (Number.isFinite(Number(result.qtmClosingBalance))) return Number(result.qtmClosingBalance);
  if (Number.isFinite(Number(result.qtmClosing))) return Number(result.qtmClosing);
  return Number(result.qtmOpening || 0) + Number(result.qtmDeclared || 0) - Number(result.qtmSpent || 0);
};

const getMismatchCauseLabel = (result: MismatchResult, isVi: boolean) => {
  const uncVariance = Number(result?.uncVariance || 0);
  const qtmClosing = getQtmClosingFromMismatch(result);
  const uncMismatch = uncVariance !== 0;
  const qtmNegative = qtmClosing < 0;
  if (uncMismatch && qtmNegative) return financeControl[isVi ? "vi" : "en"].uncVarianceAndNegativeQTMBalance;
  if (uncMismatch) return financeControl[isVi ? "vi" : "en"].uncVariance;
  if (qtmNegative) return financeControl[isVi ? "vi" : "en"].uncMatchesQTMBalanceIsNegative;
  return financeControl[isVi ? "vi" : "en"].reconciliationNeedsReview;
};

const toDateInputValue = (d: Date) => format(d, "yyyy-MM-dd");
const parseDateInputValue = (value: string) => {
  const [y, m, day] = value.split("-").map(Number);
  return new Date(y, (m || 1) - 1, day || 1);
};
const parseMonthInputValue = (value: string) => {
  const [y, m] = value.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1);
};
const formatMonthValue = (value: string | null | undefined) => {
  if (!value) return "-";
  const [y, m] = value.slice(0, 10).split("-");
  return y && m ? `${m}/${y}` : "-";
};

const OCR_CACHE_MIN_PROCESSED_AT = "2026-06-03T14:45:00.000Z";

const isOcrCacheFresh = (processedAt: unknown) => {
  if (!processedAt) return false;
  const cacheProcessedAt = Date.parse(String(processedAt));
  return Number.isFinite(cacheProcessedAt)
    && cacheProcessedAt >= Date.parse(OCR_CACHE_MIN_PROCESSED_AT);
};

type FinanceControlMode = "ceo" | "classification";

export default function FinanceControl({ mode = "ceo" }: { mode?: FinanceControlMode }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { language } = useLanguage();
  const { isOwner, user, canEditModule } = useAuth();
  const canEditCostClassification = isOwner || canEditModule("finance_cost");
  const isVi = language === "vi";
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [debouncedSelectedDate, setDebouncedSelectedDate] = useState<Date>(new Date());
  const [selectedMonth, setSelectedMonth] = useState<Date>(new Date());
  const [activeTab, setActiveTab] = useState<string>(mode === "classification" ? "classification" : "daily");
  const [imagesRequested, setImagesRequested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [activeSlipScan, setActiveSlipScan] = useState<{ type: "unc" | "qtm"; fileCount: number } | null>(null);
  const [declarationMessage, setDeclarationSaveMessage] = useState<FinanceMessage | null>(null);
  const declarationSaveMessage = readFinanceMessage(declarationMessage, isVi);
  const [ocrDebugText, setOcrDebugMessage] = useState<FinanceMessage | null>(null);
  const ocrDebugMessage = readFinanceMessage(ocrDebugText, isVi);
  const [slipUploadMessages, setSlipUploadStatus] = useState<{ unc: FinanceMessage | null; qtm: FinanceMessage | null }>({ unc: null, qtm: null });
  const slipUploadStatus = { unc: readFinanceMessage(slipUploadMessages.unc, isVi), qtm: readFinanceMessage(slipUploadMessages.qtm, isVi) };
  const [slipPreviewOpen, setSlipPreviewOpen] = useState(false);
  const [slipPreviewSrc, setSlipPreviewSrc] = useState<string | null>(null);
  const [slipPreviewMessage, setSlipPreviewTitle] = useState<FinanceMessage | null>(null);
  const slipPreviewTitle = readFinanceMessage(slipPreviewMessage, isVi) || "";
  const [selectedCostSummaryRow, setSelectedCostSummaryRow] = useState<CostClassificationMonthlySummary | null>(null);
  const [classificationEdits, setClassificationEdits] = useState<ClassificationEdits>({});
  const [standardCostEdits, setStandardCostEdits] = useState<StandardCostEdits>({});
  const [editingClassificationLineId, setEditingClassificationLineId] = useState<string | null>(null);
  const [savingClassificationEdits, setSavingClassificationEdits] = useState(false);

  const [uncSkipProcessed, setUncSkipProcessed] = useState(true);
  const [uncScanImagesOnly, setUncScanImagesOnly] = useState(true);
  const [uncLowConfidenceThreshold, setUncLowConfidenceThreshold] = useState(0.75);
  const [reconcilingFolderScan, setReconcilingFolderScan] = useState(false);
  const [reconcileProgressMessage, setReconcileProgress] = useState<{ done: number; total: number; currentFile: FinanceMessage | string }>({ done: 0, total: 0, currentFile: "" });
  const reconcileProgress = { ...reconcileProgressMessage, currentFile: readFinanceMessage(reconcileProgressMessage.currentFile, isVi) };
  const [reconcileErrorMessage, setReconcileError] = useState<FinanceMessage | null>(null);
  const reconcileError = readFinanceMessage(reconcileErrorMessage, isVi);
  const [qtmOpeningBalance, setQtmOpeningBalance] = useState<number>(0);
  const [qtmSpentFromFolder, setQtmSpentFromFolder] = useState<number>(0);
  const [qtmReconciling, setQtmReconciling] = useState(false);
  const [qtmLowConfidenceCount, setQtmLowConfidenceCount] = useState(0);
  // Close dialog state
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closeDialogStep, setCloseDialogStep] = useState<"preview" | "running" | "mismatch" | "done">("preview");
  const [mismatchResult, setMismatchResult] = useState<MismatchResult>(null);
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
    if (mode === "classification") {
      setActiveTab("classification");
      return;
    }
    if (activeTab === "classification") {
      setActiveTab("daily");
    }
  }, [mode, activeTab]);

  useEffect(() => {
    if (mode === "ceo" && activeTab !== "monthly") {
      setSelectedMonth(startOfMonth(selectedDate));
    }
  }, [selectedDate, activeTab, mode]);

  // Root folder is configured in Google Drive Integration and resolved on demand.

  useEffect(() => {
    const loadReceiptPathTemplates = async () => {
      try {
        const { data } = await supabase
          .from("app_settings")
          .select("key, value")
          .in("key", ["google_drive_receipts_unc_pattern", "google_drive_receipts_qtm_pattern"]);
        const rows = (data || []) as Array<{ key: string; value?: string }>;
        const unc = rows.find((d) => d.key === "google_drive_receipts_unc_pattern")?.value;
        const qtm = rows.find((d) => d.key === "google_drive_receipts_qtm_pattern")?.value;
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

  const { data: monthlySummary, error: monthlyError, refetch: refetchMonthly } = useMonthlyReconciliation(selectedMonth, mode === "ceo" && activeTab === "monthly");
  const costClassification = useCostClassificationDashboard(selectedMonth, mode === "classification");
  const classificationCategoryRows = costClassification.categorySummary.data || EMPTY_COST_CLASSIFICATION_CATEGORY_ROWS;
  const classificationMonthlyRows = costClassification.monthlySummary.data || EMPTY_COST_CLASSIFICATION_MONTHLY_ROWS;
  const costCategoryOptions = costClassification.categories.data || EMPTY_COST_CATEGORY_OPTIONS;
  const selectedCostDetailFilter = selectedCostSummaryRow ? {
    month: selectedCostSummaryRow.month,
    category_code: selectedCostSummaryRow.category_code,
  } : null;
  const selectedCostDetail = useCostClassificationLineDetails(selectedCostDetailFilter, mode === "classification");
  const selectedCostDetailRows = selectedCostDetail.data || EMPTY_COST_CLASSIFICATION_REVIEW_ROWS;
  const costCategoryByCode = useMemo(() => new Map(costCategoryOptions.map((row) => [row.code, row])), [costCategoryOptions]);
  const changedClassificationRows = useMemo(() => selectedCostDetailRows.filter((row) => {
    const nextCode = classificationEdits[row.classification_id];
    const draft = getStandardCostDraft(row, standardCostEdits);
    const standardChanged = Boolean(standardCostEdits[row.classification_id]) && hasStandardCostDraftChanged(row, draft);
    return Boolean((nextCode && nextCode !== row.category_code) || standardChanged);
  }), [selectedCostDetailRows, classificationEdits, standardCostEdits]);
  const hasClassificationEdits = changedClassificationRows.length > 0;
  const selectedCostSummaryKey = costDetailSelectionKey(selectedCostSummaryRow);
  const classificationCategoryByCode = useMemo(() => {
    const fallbackLabels = new Map(classificationCategoryRows.map((row) => [row.category_code, row.category_label]));
    const totals = new Map<string, { label: string; amount: number; count: number }>();
    for (const row of classificationMonthlyRows) {
      const existing = totals.get(row.category_code) || {
        label: row.category_label || fallbackLabels.get(row.category_code) || row.category_code,
        amount: 0,
        count: 0,
      };
      existing.amount += Number(row.total_amount || 0);
      existing.count += Number(row.line_count || 0);
      totals.set(row.category_code, existing);
    }
    return totals;
  }, [classificationMonthlyRows, classificationCategoryRows]);

  const classificationMonthlyDisplayRows = useMemo<ClassificationMonthlyDisplayRow[]>(() => {
    const canonicalCategoryCodes = new Set(costCategoryOptions.map((category) => category.code));
    const grouped = new Map<string, ClassificationMonthlyDisplayRow>();

    for (const row of classificationMonthlyRows) {
      if (canonicalCategoryCodes.size > 0 && !canonicalCategoryCodes.has(row.category_code)) continue;
      const key = `${row.month}-${row.category_code}`;
      const category = costCategoryByCode.get(row.category_code);
      const existing = grouped.get(key);
      const lineCount = Number(row.line_count || 0);
      const reviewStatus = row.review_status || "needs_review";

      if (existing) {
        existing.line_count += lineCount;
        existing.total_amount += Number(row.total_amount || 0);
        existing.review_status_counts[reviewStatus] = (existing.review_status_counts[reviewStatus] || 0) + lineCount;
      } else {
        grouped.set(key, {
          ...row,
          category_label: category?.label || row.category_label || row.category_code,
          cost_group: category?.cost_group || row.cost_group,
          product_line: category?.product_line || row.product_line,
          allocation_rule: "category_code",
          review_status: "note_only",
          line_count: lineCount,
          total_amount: Number(row.total_amount || 0),
          review_status_counts: { [reviewStatus]: lineCount },
        });
      }
    }

    return Array.from(grouped.values()).sort((a, b) => {
      const monthCompare = a.month.localeCompare(b.month);
      if (monthCompare !== 0) return monthCompare;
      const aOrder = costCategoryByCode.get(a.category_code)?.sort_order ?? 9999;
      const bOrder = costCategoryByCode.get(b.category_code)?.sort_order ?? 9999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (a.category_label || a.category_code).localeCompare(b.category_label || b.category_code);
    });
  }, [classificationMonthlyRows, costCategoryOptions, costCategoryByCode]);

  const classificationTotalAmount = useMemo(
    () => classificationMonthlyDisplayRows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0),
    [classificationMonthlyDisplayRows],
  );
  const classificationPendingReviewStats = useMemo(() => (
    classificationMonthlyDisplayRows.reduce((totals, row) => {
      const pendingCount = Number(row.review_status_counts?.needs_review || 0);
      if (pendingCount <= 0) return totals;
      const lineCount = Math.max(1, Number(row.line_count || 0));
      const pendingAmount = row.review_status === "needs_review" || row.category_code === "UNMAPPED_REVIEW"
        ? Number(row.total_amount || 0)
        : Number(row.total_amount || 0) * (pendingCount / lineCount);
      return {
        count: totals.count + pendingCount,
        amount: totals.amount + pendingAmount,
      };
    }, { count: 0, amount: 0 })
  ), [classificationMonthlyDisplayRows]);

  const classificationChartRows = useMemo<ClassificationChartRow[]>(() => {
    const sorted = [...classificationMonthlyDisplayRows].sort((a, b) => Number(b.total_amount || 0) - Number(a.total_amount || 0));
    return sorted.map((row, index) => {
      const amount = Number(row.total_amount || 0);
      const percentage = classificationTotalAmount > 0 ? (amount / classificationTotalAmount) * 100 : 0;
      return {
        ...row,
        amount,
        percentage,
        fill: COST_CLASSIFICATION_CHART_COLORS[index % COST_CLASSIFICATION_CHART_COLORS.length],
        note: buildClassificationNote(row, percentage, index === 0, isVi),
      };
    });
  }, [classificationMonthlyDisplayRows, classificationTotalAmount, isVi]);

  const selectedCostChartRow = useMemo(
    () => classificationChartRows.find((row) => costDetailSelectionKey(row) === selectedCostSummaryKey) || null,
    [classificationChartRows, selectedCostSummaryKey],
  );

  useEffect(() => {
    setClassificationEdits({});
    setStandardCostEdits({});
    setEditingClassificationLineId(null);
  }, [selectedCostSummaryKey]);

  useEffect(() => {
    setSelectedCostSummaryRow(null);
    setClassificationEdits({});
    setStandardCostEdits({});
    setEditingClassificationLineId(null);
  }, [selectedMonth]);

  const updateClassificationEdit = (classificationId: string, currentCode: string, nextCode: string) => {
    setClassificationEdits((prev) => {
      const next = { ...prev };
      if (nextCode === currentCode) delete next[classificationId];
      else next[classificationId] = nextCode;
      return next;
    });
  };

  const updateStandardCostEdit = (
    row: CostClassificationReviewRow,
    field: keyof StandardCostEdit,
    value: string,
  ) => {
    setStandardCostEdits((prev) => {
      const draft = { ...getStandardCostDraft(row, prev), [field]: value };
      const next = { ...prev };
      if (hasStandardCostDraftChanged(row, draft)) next[row.classification_id] = draft;
      else delete next[row.classification_id];
      return next;
    });
  };

  const cancelClassificationEdits = () => {
    setClassificationEdits({});
    setStandardCostEdits({});
    setEditingClassificationLineId(null);
  };

  const saveClassificationEdits = async () => {
    if (!changedClassificationRows.length) return;
    setSavingClassificationEdits(true);
    try {
      for (const row of changedClassificationRows) {
        const nextCode = classificationEdits[row.classification_id] || row.category_code;
        const nextCategory = costCategoryByCode.get(nextCode);
        if (!nextCode || !nextCategory) continue;
        const nextAllocationRule = getCostGroupAllocationRule(nextCategory.cost_group);
        const standardDraft = getStandardCostDraft(row, standardCostEdits);
        const standardCostCode = standardDraft.standard_cost_code.trim();
        const standardCostType = standardDraft.standard_cost_code_type.trim();
        const canonicalCostName = standardDraft.canonical_cost_item_name.trim();
        const unitConversionNote = standardDraft.unit_conversion_note.trim();
        const before = {
          category_code: row.category_code,
          category_label: row.category_label,
          product_line: row.product_line,
          allocation_rule: row.allocation_rule,
          review_status: row.review_status,
          confidence: row.confidence,
          classification_source: row.classification_source,
          standard_cost_code_type: row.standard_cost_code_type || null,
          confirmed_standard_cost_code: row.confirmed_standard_cost_code || null,
          canonical_cost_item_name: row.canonical_cost_item_name || null,
        };
        const after = {
          category_code: nextCode,
          category_label: nextCategory.label,
          product_line: nextCategory.product_line,
          allocation_rule: nextAllocationRule,
          review_status: "approved",
          confidence: 1,
          classification_source: "manual_override",
          standard_cost_code_type: standardCostType || null,
          confirmed_standard_cost_code: standardCostCode || null,
          canonical_cost_item_name: canonicalCostName || null,
        };

        if (row.source_type === "payment_request_item" || row.source_type === "invoice_item") {
          const tableName = row.source_type === "payment_request_item" ? "payment_request_items" : "invoice_items";
          const { error: lineUpdateError } = await looseSupabase
            .from(tableName)
            .update({
              cost_category_code: nextCode,
              cost_product_line: nextCategory.product_line,
              cost_allocation_rule: nextAllocationRule,
              cost_review_routing: "none",
              standard_cost_code_type: standardCostType || null,
              suggested_standard_cost_code: standardCostCode || row.suggested_standard_cost_code || null,
              confirmed_standard_cost_code: standardCostCode || null,
              canonical_cost_item_name: canonicalCostName || row.product_name || null,
              canonical_cost_item_source: "manual_override",
              unit_conversion_note: unitConversionNote || null,
            })
            .eq("id", row.source_line_id);
          if (lineUpdateError) throw lineUpdateError;

          const sourceName = row.raw_product_name || row.product_name || "";
          const sourceNameKey = normalizeCostAliasKey(sourceName);
          if (sourceNameKey && standardCostType && standardCostCode && canonicalCostName) {
            const { data: existingAlias, error: aliasLookupError } = await looseSupabase
              .from("cost_item_alias_mappings")
              .select("id")
              .eq("source_name_key", sourceNameKey)
              .eq("standard_cost_code_type", standardCostType)
              .eq("standard_cost_code", standardCostCode)
              .eq("active", true)
              .limit(1);
            if (aliasLookupError) throw aliasLookupError;

            const aliasPayload = {
              source_name: sourceName,
              source_name_key: sourceNameKey,
              supplier_id: row.supplier_id || null,
              standard_cost_code_type: standardCostType,
              standard_cost_code: standardCostCode,
              canonical_cost_item_name: canonicalCostName,
              category_code: nextCode,
              product_line: nextCategory.product_line,
              allocation_rule: nextAllocationRule,
              unit_conversion_note: unitConversionNote || null,
              mapping_status: "approved",
              active: true,
              review_note: "Approved from Chi phí Cần Review",
              reviewed_by: user?.id || null,
              reviewed_at: new Date().toISOString(),
              created_by: user?.id || null,
            };
            const existingAliasId = Array.isArray(existingAlias) ? existingAlias[0]?.id : null;
            const aliasResult = existingAliasId
              ? await looseSupabase.from("cost_item_alias_mappings").update(aliasPayload).eq("id", existingAliasId)
              : await looseSupabase.from("cost_item_alias_mappings").insert(aliasPayload);
            if (aliasResult.error) throw aliasResult.error;
          }
        } else {
          const { error: updateError } = await looseSupabase
            .from("cost_line_classifications")
            .update({
            category_code: nextCode,
            product_line: nextCategory.product_line,
            allocation_rule: nextAllocationRule,
            confidence: 1,
            classification_source: "manual_override",
            review_status: "approved",
            reviewed_by: user?.id || null,
            reviewed_at: new Date().toISOString(),
            note: `Manual category override from ${row.category_code} to ${nextCode}`,
          })
          .eq("id", row.classification_id);
          if (updateError) throw updateError;
        }

        const { error: auditError } = await looseSupabase
          .from("cost_classification_audit_logs")
          .insert({
            classification_id: row.classification_id.startsWith("ocr-") ? null : row.classification_id,
            source_type: row.source_type,
            source_line_id: row.source_line_id,
            action: "manual_override",
            before,
            after,
            reason: "finance_cost_manual_category_review",
            actor_id: user?.id || null,
          });
        if (auditError) throw auditError;

        const productPattern = escapeCostRulePattern(row.product_name || row.product_code || "");
        if (productPattern) {
          const { error: ruleError } = await looseSupabase
            .from("cost_classification_rules")
            .upsert({
              priority: 20,
              rule_name: buildManualCostRuleName(row),
              supplier_id: row.supplier_id || null,
              keyword_pattern: productPattern,
              match_scope: row.supplier_id ? "supplier_and_item" : "item_text",
              category_code: nextCode,
              product_line: nextCategory.product_line,
              allocation_rule: nextAllocationRule,
              confidence: 0.99,
              active: true,
              updated_at: new Date().toISOString(),
            }, { onConflict: "rule_name" });
          if (ruleError) throw ruleError;
        }
      }

      setClassificationEdits({});
      setStandardCostEdits({});
      setEditingClassificationLineId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["cost-classification-monthly-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["cost-classification-category-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["cost-classification-review-queue"] }),
        queryClient.invalidateQueries({ queryKey: ["cost-classification-line-details"] }),
        queryClient.invalidateQueries({ queryKey: ["cost-categories"] }),
      ]);
      toast({
        title: financeControl[isVi ? "vi" : "en"].classificationSaved,
        description: financeControl[isVi ? "vi" : "en"].theStandardCodeAndAliasWereSaved,
      });
    } catch (error: unknown) {
      toast({
        title: financeControl[isVi ? "vi" : "en"].couldNotSaveClassification,
        description: error?.message || String(error),
        variant: "destructive",
      });
    } finally {
      setSavingClassificationEdits(false);
    }
  };

  const persistedQtmImages = dailyDeclaration?.extraction_meta?.qtm_images;
  const persistedUncImages = dailyDeclaration?.extraction_meta?.unc_images;
  const hasPersistedSlipImages = Boolean(
    (Array.isArray(persistedQtmImages) && persistedQtmImages.length > 0)
    || (Array.isArray(persistedUncImages) && persistedUncImages.length > 0),
  );
  const enableDeclarationImages = imagesRequested
    || Number(dailyDeclaration?.qtm_extracted_amount || dailyDeclaration?.cash_fund_topup_amount || 0) > 0
    || Number(dailyDeclaration?.unc_extracted_amount || dailyDeclaration?.unc_total_declared || 0) > 0
    || hasPersistedSlipImages;
  const { data: declarationImages, refetch: refetchDeclarationImages } = useDailyDeclarationImages(debouncedSelectedDate, enableDeclarationImages);

  // Surface query errors to user via toast (fire once per error)
  useEffect(() => {
    const errors = [
      declarationError && formatText(financeControl[isVi ? "vi" : "en"].declarationError, { message: (declarationError as Error).message }),
      uncDetailError && formatText(financeControl[isVi ? "vi" : "en"].uncDetailError, { message: (uncDetailError as Error).message }),
      dailyReconError && formatText(financeControl[isVi ? "vi" : "en"].dailyError, { message: (dailyReconError as Error).message }),
      monthlyError && formatText(financeControl[isVi ? "vi" : "en"].monthlyError, { message: (monthlyError as Error).message }),
      qtmBalanceError && formatText(financeControl[isVi ? "vi" : "en"].balanceError, { message: (qtmBalanceError as Error).message }),
    ].filter(Boolean) as string[];

    if (errors.length > 0) {
      toast({
        title: financeControl[isVi ? "vi" : "en"].dataLoadingError,
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
  const [pendingQtmExtractedList, setPendingQtmExtractedList] = useState<ExtractedSlipItem[]>([]);
  const [pendingUncExtractedList, setPendingUncExtractedList] = useState<ExtractedSlipItem[]>([]);

  const [closeDecision, setCloseDecision] = useState<"reject" | "conditional" | "approve">("reject");
  const [closeApprovalLocked, setCloseApprovalLocked] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [closeActing, setCloseActing] = useState(false);
  const [reconciliationAuditLogs, setReconciliationAuditLogs] = useState<Array<{ at: string; actor: string; action: string; detail?: string; snapshot?: ReconciliationSnapshot }>>([]);

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
    setCloseDecision((dailyDeclaration?.extraction_meta?.close_decision as "reject" | "conditional" | "approve" | undefined) || "reject");
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

    const hasPendingLocalDeclarationChanges = saving
      || extracting
      || pendingQtmImagesBase64.length > 0
      || pendingUncImagesBase64.length > 0
      || pendingQtmExtractedList.length > 0
      || pendingUncExtractedList.length > 0;

    if (hasPendingLocalDeclarationChanges) return;

    setQtmSlipPreviews(declarationImages.qtmImages.map((b64: string) => `data:image/jpeg;base64,${b64}`));
    setUncSlipPreviews(declarationImages.uncImages.map((b64: string) => `data:image/jpeg;base64,${b64}`));
  }, [
    declarationImages,
    saving,
    extracting,
    pendingQtmImagesBase64.length,
    pendingUncImagesBase64.length,
    pendingQtmExtractedList.length,
    pendingUncExtractedList.length,
  ]);

  const dateKey = format(selectedDate, "yyyy-MM-dd");
  const activeSlipScanLabel = activeSlipScan
    ? (isVi
      ? `Đang upload & scan ${activeSlipScan.type.toUpperCase()}... ${activeSlipScan.fileCount} ảnh. Vui lòng chờ; hệ thống sẽ hiện thông báo xác nhận sau khi tự lưu xong.`
      : `Uploading & scanning ${activeSlipScan.type.toUpperCase()}... ${activeSlipScan.fileCount} image(s). Please wait; the system will show a confirmation after auto-save finishes.`)
    : null;
  const isSuccessMessage = (message: string | null) => Boolean(
    message && (
      message.includes("Đã lưu khai báo CEO")
      || message.includes("Đã scan và tự lưu khai báo CEO")
      || message.toLowerCase().includes("saved")
      || message.toLowerCase().includes("auto-saved")
      || message.toLowerCase().includes("auto saved")
    ),
  );
  const slipStatusClass = (message: string | null) => isSuccessMessage(message)
    ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-300"
    : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300";

  const persistedFolderTotal = Number(dailyDeclaration?.extraction_meta?.unc_folder_total || 0);
  const persistedFolderStatus = dailyDeclaration?.extraction_meta?.unc_folder_status as ("match" | "mismatch" | undefined);
  const resolvedUncDetail = Number((uncReconSummary?.folderTotal ?? persistedFolderTotal ?? dailyReconciliation?.unc_detail_amount ?? uncDetailAmount) || 0);
  const resolvedUncDeclared = Number((uncReconSummary?.ceoTotal ?? dailyReconciliation?.unc_declared_amount ?? uncTotalDeclared) || 0);
  const resolvedVariance = resolvedUncDetail - resolvedUncDeclared;
  const resolvedStatus = (uncReconSummary?.status || persistedFolderStatus || dailyReconciliation?.status) as ("match" | "mismatch" | undefined);
  const hasDeclaredUnc = Number(uncTotalDeclared || 0) > 0;
  const hasDeclaredQtm = Number(cashFundTopupAmount || 0) > 0;
  const canCloseWithoutBankSlips = !hasDeclaredUnc && !hasDeclaredQtm;
  const missingRequiredPreview = hasDeclaredUnc && previewUncFiles === 0;
  const qtmCarryForwardPreview = hasDeclaredQtm && previewQtmFiles === 0;
  const shouldRunFolderReconciliation = hasDeclaredUnc || hasDeclaredQtm || previewUncFiles > 0 || previewQtmFiles > 0;

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
    setSlipUploadStatus({ unc: null, qtm: null });
    setActiveSlipScan(null);
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

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new FinanceUiError(financeMessage((isVi) => getOcrErrorMessage(payload, financeControl[isVi ? "vi" : "en"].failedToScanSlip)), isVi);
        Object.assign(error, { code: payload?.code, detail: payload?.detail, rawMessage: payload?.error });
        throw error;
      }

      return {
        extracted: payload.data as { amount: number; confidence?: number; transfer_date?: string; reference?: string },
      };
    };

    try {
      return await callExtract(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error || "");
      const isTimeout = msg.includes("AbortError") || msg.toLowerCase().includes("aborted") || msg.toLowerCase().includes("timeout");
      if (!isTimeout) throw error;

      try {
        return await callExtract(true);
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError || "");
        const stillTimeout = retryMsg.includes("AbortError") || retryMsg.toLowerCase().includes("aborted") || retryMsg.toLowerCase().includes("timeout");
        if (stillTimeout) {
          if (retryError instanceof FinanceUiError) throw retryError;
          throw new FinanceUiError(financeMessage((isVi) => getOcrTimeoutMessage(isVi)), isVi);
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
      throw new FinanceUiError(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].missingRoot), isVi);
    }

    return String(data.value);
  };

  // Returns a valid session without forcing an auth refresh on every action.
  // Forcing refreshSession() fires an auth-state event, temporarily resets authzLoaded,
  // and ModuleRoute unmounts this page, making the close dialog flash then disappear.
  const getFreshSession = async () => {
    const { data } = await supabase.auth.getSession();
    const currentSession = data.session;
    const expiresAtMs = Number(currentSession?.expires_at || 0) * 1000;
    const shouldRefresh = !currentSession?.access_token || !expiresAtMs || expiresAtMs - Date.now() < 60_000;

    if (!shouldRefresh) return currentSession;

    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (!refreshError && refreshed.session) return refreshed.session;
    return currentSession;
  };



  const runFolderReconciliation = async () => {
    setReconcilingFolderScan(true);
    setQtmReconciling(true);
    setReconcileError(null);
    setReconcileProgress({ done: 0, total: 0, currentFile: financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].scanningUNCQTMFileLists) });

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
            const detail = scanFailureDetail(resp.status, err);
            throw new FinanceUiError(financeMessage((isVi) => formatText(financeControl[isVi ? "vi" : "en"].scanFailed, { folder: subfolderDate, message: readFinanceMessage(detail, isVi) ?? "" })), isVi);
          }
          const data = await resp.json();
          console.log(`[scan] ${subfolderDate}: ${data?.files?.length ?? 0} files, total: ${data?.totalFilesFound ?? '?'}, skipped: ${data?.skippedProcessedCount ?? 0}`);
          return data;
        } catch (error) {
          if (error instanceof FinanceUiError) throw error;
          const msg = error instanceof Error ? error.message : String(error || "");
          if (msg.includes("AbortError") || msg.toLowerCase().includes("aborted") || msg.toLowerCase().includes("timeout")) {
            throw new FinanceUiError(financeMessage((isVi) => formatText(financeControl[isVi ? "vi" : "en"].scanTimeout, { folder: subfolderDate })), isVi);
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

      const downloadBase64File = async (f: DriveFileRow) => {
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
          throw new FinanceUiError(financeMessage((isVi) => err?.error || formatText(financeControl[isVi ? "vi" : "en"].downloadFailed, { file: String(f?.name || f?.id || "") })), isVi);
        }

        const data = await resp.json();
        return data?.file || null;
      };

      const uncPath = uncPathForDate;
      const qtmPath = qtmPathForDate;

      // Scan sequentially to avoid double pressure on Drive + Edge runtime.
      setReconcileProgress({ done: 0, total: 0, currentFile: financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].scanningUNC) });
      const uncScanData = await scanWithRetry(uncPath);
      setReconcileProgress({ done: 0, total: 0, currentFile: financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].scanningQTM) });
      const qtmScanData = await scanWithRetry(qtmPath);

      const uncRawFiles = Array.isArray(uncScanData?.files) ? uncScanData.files : [];
      const qtmRawFiles = Array.isArray(qtmScanData?.files) ? qtmScanData.files : [];
      const preSkippedByServer = Number(uncScanData?.skippedProcessedCount || 0) + Number(qtmScanData?.skippedProcessedCount || 0);

      const normalizeImageFiles = (rows: DriveFileRow[]) =>
        (rows || []).filter((f: DriveFileRow) => !uncScanImagesOnly || String(f?.mimeType || "").startsWith("image/"));

      const uncFiles = normalizeImageFiles(uncRawFiles);
      const qtmFiles = normalizeImageFiles(qtmRawFiles);

      const uncTotalScannedCount = Number(uncScanData?.totalFilesFound ?? uncFiles.length);
      const qtmTotalScannedCount = Number(qtmScanData?.totalFilesFound ?? qtmFiles.length);

      const targetUncFiles = uncFiles;
      const targetQtmFiles = qtmFiles;

      if (!targetUncFiles.length && !targetQtmFiles.length && (hasDeclaredUnc || !hasDeclaredQtm)) {
        const uncMsg = uncScanData?.message || "";
        const qtmMsg = qtmScanData?.message || "";
        const pathInfo = `UNC: ${uncPath}, QTM: ${qtmPath}`;
        const folderNotFound = uncMsg.includes("No subfolder") || qtmMsg.includes("No subfolder");
        throw new FinanceUiError(financeMessage((isVi) => isVi
            ? folderNotFound
              ? `Không tìm thấy thư mục trên Drive. Kiểm tra cấu trúc: ${pathInfo}. ${uncMsg}`
              : `Không có file ảnh trong thư mục (UNC: ${uncTotalScannedCount} found, QTM: ${qtmTotalScannedCount} found). Path: ${pathInfo}`
            : folderNotFound
              ? `Folder not found on Drive. Check structure: ${pathInfo}. ${uncMsg}`
              : `No image files in folders (UNC: ${uncTotalScannedCount}, QTM: ${qtmTotalScannedCount}). Path: ${pathInfo}`), isVi);
      }

      // ── OCR cache lookup: reuse previously extracted amounts from drive_file_index ──
      const ocrCache = new Map<string, { amount: number; confidence: number }>();
      {
        const allFileIds = [...targetUncFiles, ...targetQtmFiles].map((f: DriveFileRow) => f.id);
        const CHUNK = 500;
        for (let i = 0; i < allFileIds.length; i += CHUNK) {
          const chunk = allFileIds.slice(i, i + CHUNK);
          const { data: cachedRows } = await looseSupabase
            .from("drive_file_index")
            .select("file_id, extracted_amount, extraction_confidence, processed_at")
            .in("file_id", chunk)
            .not("extracted_amount", "is", null);
          for (const row of (cachedRows || [])) {
            if (row?.file_id && Number(row.extracted_amount) > 0) {
              const cacheProcessedAt = row.processed_at;
              if (!isOcrCacheFresh(cacheProcessedAt)) continue;
              ocrCache.set(row.file_id, {
                amount: Number(row.extracted_amount),
                confidence: Number(row.extraction_confidence || 0),
              });
            }
          }
        }
      }
      const cachedCount = ocrCache.size;
      const uncachedUncFiles = targetUncFiles.filter((f: DriveFileRow) => !ocrCache.has(f.id));
      const uncachedQtmFiles = targetQtmFiles.filter((f: DriveFileRow) => !ocrCache.has(f.id));
      const processedSkippedCount = cachedCount;
      console.log(`[reconcile] OCR cache hit: ${cachedCount} files, need OCR: UNC ${uncachedUncFiles.length}, QTM ${uncachedQtmFiles.length}`);

      const totalTargets = uncachedUncFiles.length + uncachedQtmFiles.length;
      setReconcileProgress({ done: 0, total: totalTargets, currentFile: financeMessage((isVi) => totalTargets === 0 ? (financeControl[isVi ? "vi" : "en"].allFilesHaveCachedOCR) : "") });

      const uncItems: Array<{ fileId: string; fileName: string; amount: number; confidence: number; status: "matched" | "mismatch" | "needs_review" }> = [];
      const ocrErrors: FinanceMessage[] = [];
      let progressDone = 0;

      // ── Parallel batch processing (3 files at a time to reduce concurrent load) ──
      const BATCH_SIZE = 3;

      const processFileBatch = async (
        files: DriveFileRow[],
        slipType: "unc" | "qtm",
      ): Promise<Array<{ amount: number; confidence: number; fileId: string; fileName: string } | null>> => {
        const results: Array<{ amount: number; confidence: number; fileId: string; fileName: string } | null> = [];
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          setReconcileProgress({ done: progressDone, total: totalTargets, currentFile: financeMessage((isVi) => formatText(financeControl[isVi ? "vi" : "en"].ocrBatch, { type: slipType.toUpperCase(), batch: Math.ceil((i + 1) / BATCH_SIZE), total: Math.ceil(files.length / BATCH_SIZE) })) });
          const batchResults = await Promise.allSettled(
            batch.map(async (file) => {
              const downloaded = await downloadBase64File(file);
              if (!downloaded?.base64) throw new FinanceUiError(financeMessage((isVi) => formatText(financeControl[isVi ? "vi" : "en"].loadFailed, { file: String(file?.name || file?.id || "") })), isVi);
              const result = await extractSlipAmountFromBase64(downloaded.base64, downloaded.mimeType || file.mimeType || "image/jpeg", slipType);
              const amount = Number(result?.extracted?.amount || 0);
              const confidence = Number(result?.extracted?.confidence || 0);
              if (!(amount > 0)) {
                throw new FinanceUiError(financeMessage((isVi) => formatText(financeControl[isVi ? "vi" : "en"].zeroOcr, { file: String(file?.name || file?.id || "") })), isVi);
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
              ocrErrors.push(ocrFileFailure(slipType, String(file?.name || file?.id || ""), r.reason));
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
      let qtmSuccessfulCount = 0;
      for (const f of targetQtmFiles) {
        const cached = ocrCache.get(f.id);
        if (cached) {
          qtmTotal += cached.amount;
          qtmSuccessfulCount += 1;
          if (cached.confidence < uncLowConfidenceThreshold) qtmLowConfidence += 1;
        }
      }

      // Process only UNCACHED QTM files via download + OCR
      const qtmResults = await processFileBatch(uncachedQtmFiles, "qtm");
      for (const r of qtmResults) {
        if (!r) continue;
        qtmTotal += r.amount;
        qtmSuccessfulCount += 1;
        if (r.confidence < uncLowConfidenceThreshold) qtmLowConfidence += 1;
      }

      const folderTotal = uncItems.reduce((sum, x) => sum + x.amount, 0);
      const uncOcrFailedHard = targetUncFiles.length > 0 && uncItems.length === 0;
      const qtmOcrFailedHard = targetQtmFiles.length > 0 && qtmSuccessfulCount === 0;
      const uncOcrPartialFailedHard = targetUncFiles.length > 0 && uncItems.length > 0 && uncItems.length < targetUncFiles.length;
      const qtmOcrPartialFailedHard = targetQtmFiles.length > 0 && qtmSuccessfulCount > 0 && qtmSuccessfulCount < targetQtmFiles.length;
      let ocrFailureMessage: FinanceMessage | null = null;
      if (uncOcrFailedHard || qtmOcrFailedHard || uncOcrPartialFailedHard || qtmOcrPartialFailedHard) {
        const scopes: Array<{ type: "UNC" | "QTM"; successful: number; total: number }> = [];
        if (uncOcrFailedHard || uncOcrPartialFailedHard) {
          scopes.push({ type: "UNC", successful: uncItems.length, total: targetUncFiles.length });
        }
        if (qtmOcrFailedHard || qtmOcrPartialFailedHard) {
          scopes.push({ type: "QTM", successful: qtmSuccessfulCount, total: targetQtmFiles.length });
        }
        ocrFailureMessage = combinedOcrFailure(scopes, ocrErrors);
      }
      const ceoTotal = Number(uncTotalDeclared || 0);
      const delta = folderTotal - ceoTotal;
      const status: "match" | "mismatch" = delta === 0 ? "match" : "mismatch";
      const lowConfidenceCount = uncItems.filter((x) => x.status === "needs_review").length;

      const finalItems = uncItems.map((x) => {
        if (x.status === "needs_review") return x;
        return { ...x, status: "matched" as const };
      });

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
      const successfulOcrFileIds = new Set(Array.from(ocrAmountMap.keys()).map(String));
      const processedRows = [...targetUncFiles, ...targetQtmFiles].map((f: DriveFileRow) => {
        const fileId = String(f.id);
        const ocr = ocrAmountMap.get(f.id) || ocrAmountMap.get(fileId);
        const ocrSucceeded = successfulOcrFileIds.has(fileId);
        return {
          file_id: fileId,
          file_name: String(f.name || f.id),
          folder_date: autoDayFolderPath,
          folder_type: "bank_slip",
          mime_type: f?.mimeType || null,
          parent_folder_id: null,
          processed: successfulOcrFileIds.has(fileId),
          processed_at: ocrSucceeded ? processedAt : null,
          last_seen_at: processedAt,
          extracted_amount: ocrSucceeded ? (ocr?.amount ?? null) : null,
          extraction_confidence: ocrSucceeded ? (ocr?.confidence ?? null) : null,
        };
      });

      if (processedRows.length > 0) {
        const { error: processedUpsertError } = await looseSupabase
          .from("drive_file_index")
          .upsert(processedRows, { onConflict: "file_id", ignoreDuplicates: false });

        if (processedUpsertError) {
          console.error("[FinanceControl] Failed to persist processed markers:", processedUpsertError);
          if (ocrFailureMessage) {
            throw new FinanceUiError(financeMessage((isVi) => isVi
              ? `Không thể lưu trạng thái OCR lỗi để retry: ${processedUpsertError.message || financeControl[isVi ? "vi" : "en"].ocrRetryStateSaveFailed}`
              : `Could not save failed OCR retry state: ${processedUpsertError.message || financeControl[isVi ? "vi" : "en"].ocrRetryStateSaveFailed}`), isVi);
          }
        }
      }

      if (ocrFailureMessage) {
        throw new FinanceUiError(ocrFailureMessage, isVi);
      }

      setReconcileProgress({ done: totalTargets, total: totalTargets, currentFile: "" });
      setQtmSpentFromFolder(Number(qtmTotal || 0));
      setQtmLowConfidenceCount(Number(qtmLowConfidence || 0));

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

      await looseSupabase
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
          title: financeControl[isVi ? "vi" : "en"].uncDeclaredTotalAutoFilled,
          description: isVi
            ? `Đã cập nhật UNC khai báo = ${vnd(folderTotal)} từ folder ${uncPath}`
            : `CEO UNC declared total updated to ${vnd(folderTotal)} from folder ${uncPath}`,
        });
      }

      toast({
        title: financeControl[isVi ? "vi" : "en"].dailyReconciliationCompleted,
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

    } catch (e: unknown) {
      const error = retainFinanceError(e, financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].failedReconcilingUNCQTMByDate), isVi);
      setReconcileError(error.uiMessage);
      setReconcileProgress((prev) => ({ ...prev, currentFile: "" }));
      toast({ title: financeControl[isVi ? "vi" : "en"].dailyReconciliationError, description: readFinanceMessage(error.uiMessage, isVi) ?? "", variant: "destructive" });
      throw error; // Re-throw the structured error so executeClose stops
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
        throw new FinanceUiError(financeMessage((isVi) => err?.error || financeControl[isVi ? "vi" : "en"].qtmScanFailed), isVi);
      }

      const scanData = await scanResponse.json();
      const files = (Array.isArray(scanData?.files) ? scanData.files : [])
        .filter((f: DriveFileRow) => String(f?.mimeType || "").startsWith("image/"));

      if (!files.length) {
        setQtmSpentFromFolder(0);
        setQtmLowConfidenceCount(0);
        toast({ title: financeControl[isVi ? "vi" : "en"].noQTMReceipts, description: qtmPath });
        return;
      }

      let total = 0;
      let lowConfidence = 0;
      for (const f of files) {
        const result = await extractSlipAmountFromBase64(f.base64, f.mimeType || "image/jpeg", "qtm");
        const amount = Number(result?.extracted?.amount || 0);
        const confidence = Number(result?.extracted?.confidence || 0);
        total += amount;
        if (confidence < uncLowConfidenceThreshold) lowConfidence += 1;
      }

      setQtmSpentFromFolder(total);
      setQtmLowConfidenceCount(lowConfidence);
      toast({
        title: financeControl[isVi ? "vi" : "en"].qtmScanned,
        description: `${financeControl[isVi ? "vi" : "en"].spent}: ${vnd(total)} • ${financeControl[isVi ? "vi" : "en"].lowConfidence}: ${lowConfidence}`,
      });
    } catch (e: unknown) {
      toast({ title: financeControl[isVi ? "vi" : "en"].qtmScanError, description: e?.message || financeControl[isVi ? "vi" : "en"].qtmScanFailed, variant: "destructive" });
    } finally {
      setQtmReconciling(false);
    }
  };

  const extractSlipAmount = async (file: File, slipType: "qtm" | "unc") => {
    const normalized = await normalizeUploadImage(file);
    const session = await getFreshSession();

    const response = await fetchWithTimeout(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/finance-extract-slip-amount`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ imageBase64: normalized.imageBase64, mimeType: normalized.mimeType, slipType }),
    }, 45000);

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new FinanceUiError(financeMessage((isVi) => getOcrErrorMessage(result, financeControl[isVi ? "vi" : "en"].failedToScanSlip)), isVi);
      Object.assign(error, { code: result?.code, detail: result?.detail, rawMessage: result?.error });
      throw error;
    }

    return {
      imageBase64: normalized.imageBase64,
      extracted: result.data as { amount: number; confidence?: number; transfer_date?: string; reference?: string; provider?: string },
    };
  };

  const processSlipUpload = async (slipType: "qtm" | "unc", files: File[]) => {
    if (!files.length) return;
    setDeclarationSaveMessage(null);
    setOcrDebugMessage(null);
    setSlipUploadStatus((prev) => ({ ...prev, [slipType]: null }));
    setActiveSlipScan({ type: slipType, fileCount: files.length });
    setExtracting(true);
    try {
      const batchResults: Array<{ imageBase64: string; extracted: ExtractedSlipItem; file: File }> = [];
      for (const file of files) {
        const result = await extractSlipAmount(file, slipType);
        const amount = Number(result?.extracted?.amount || 0);
        const confidence = Number(result?.extracted?.confidence || 0);
        console.log(`[finance][slip-vision] ${slipType}`, {
          provider: result?.extracted?.provider || "openai",
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
        const debugText = financeMessage((isVi) => formatText(financeControl[isVi ? "vi" : "en"].zeroAmountDebug, { type: slipType.toUpperCase(), files: zeroAmountFiles.map((r) => formatText(financeControl[isVi ? "vi" : "en"].fileConfidence, { name: r.file.name, confidence: Number(r.extracted?.confidence || 0).toFixed(2) })).join(", ") }));
        setOcrDebugMessage(debugText);
        const statusText = financeMessage((isVi) => isVi
          ? `Ảnh mới chưa được áp dụng cho ${slipType.toUpperCase()}. OpenAI Vision không đọc ra số tiền từ file vừa chọn, nên số/preview đang hiển thị bên dưới vẫn là dữ liệu đã lưu trước đó.`
          : `The new ${slipType.toUpperCase()} image was not applied. OpenAI Vision could not read an amount from the selected file, so the amount/preview shown below still reflects previously saved data.`);
        setSlipUploadStatus((prev) => ({ ...prev, [slipType]: statusText }));
        setDeclarationSaveMessage(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].openaiVisionCouldNotExtractAnAmount));
        toast({
          title: financeControl[isVi ? "vi" : "en"].openaiVisionDidNotExtractAmount,
          description: debugText[isVi ? "vi" : "en"],
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

      setSlipUploadStatus((prev) => ({
        ...prev,
        [slipType]: financeMessage((isVi) => isVi
          ? `Scan xong ${slipType.toUpperCase()}: +${vnd(batchSum)} (${batchResults.length} ảnh). Đang tự lưu khai báo CEO...`
          : `${slipType.toUpperCase()} scanned: +${vnd(batchSum)} (${batchResults.length} image(s)). Auto-saving CEO declaration...`),
      }));

      // Auto-save declaration after OCR using the freshly computed values,
      // avoiding stale React state during rapid UNC/QTM consecutive uploads.
      const autoSaved = await saveDeclaration(true, {
        uncTotalDeclared: nextUncTotalDeclared,
        cashFundTopupAmount: nextCashFundTopupAmount,
        pendingQtmImagesBase64: nextPendingQtmImagesBase64,
        pendingUncImagesBase64: nextPendingUncImagesBase64,
        pendingQtmExtractedList: nextPendingQtmExtractedList,
        pendingUncExtractedList: nextPendingUncExtractedList,
      });

      if (autoSaved) {
        const savedMessage = financeMessage((isVi) => isVi
          ? `Đã scan và tự lưu khai báo CEO: ${slipType.toUpperCase()} +${vnd(batchSum)} (${batchResults.length} ảnh). Không cần bấm Lưu khai báo.`
          : `Scanned and auto-saved CEO declaration: ${slipType.toUpperCase()} +${vnd(batchSum)} (${batchResults.length} image(s)). No need to press Save declaration.`);
        // Keep auto-save confirmation in the slip section only.
        // Do not also set declarationSaveMessage here: mobile users see both areas at once,
        // which duplicates the same success notification.
        setSlipUploadStatus((prev) => ({ ...prev, [slipType]: savedMessage }));
        toast({
          title: financeControl[isVi ? "vi" : "en"].ceoDeclarationAutoSaved,
          description: formatText(financeControl[isVi ? "vi" : "en"].imagesAdded, { type: slipType === "qtm" ? "QTM" : "UNC", amount: vnd(batchSum), count: batchResults.length }),
        });
      } else {
        setSlipUploadStatus((prev) => ({
          ...prev,
          [slipType]: financeMessage((isVi) => isVi
            ? `Scan xong ${slipType.toUpperCase()} nhưng tự lưu thất bại. Vui lòng kiểm tra thông báo lỗi bên dưới rồi bấm Lưu khai báo.`
            : `${slipType.toUpperCase()} scanned, but auto-save failed. Check the error below, then press Save declaration.`),
        }));
      }
    } catch (e: unknown) {
      const statusText = financeMessage((isVi) => localizedFinanceError(e, isVi, e?.message
        ? `${financeControl[isVi ? "vi" : "en"].newImageNotApplied} ${e.message}`
        : (isVi
          ? `Ảnh mới chưa được áp dụng cho ${slipType.toUpperCase()}. Hệ thống vẫn đang giữ số/preview đã lưu trước đó.`
          : `The new ${slipType.toUpperCase()} image was not applied. The UI is still showing previously saved amount/preview.`)));
      setSlipUploadStatus((prev) => ({ ...prev, [slipType]: statusText }));
      setDeclarationSaveMessage(financeMessage((isVi) => localizedFinanceError(e, isVi, e?.message || (financeControl[isVi ? "vi" : "en"].imageUploadedButOpenAIVisionCouldNot))));
      toast({ title: financeControl[isVi ? "vi" : "en"].visionError, description: e?.message || financeControl[isVi ? "vi" : "en"].visionHelp, variant: "destructive" });
    } finally {
      setExtracting(false);
      setActiveSlipScan(null);
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
      qtmVariance: Number(snapshotOverride?.qtmVariance ?? (resolvedQtmDrive - Number(cashFundTopupAmount || 0))),
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

    const { error } = await looseSupabase
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

  const openSlipPreview = (src: string, title: FinanceMessage) => {
    setSlipPreviewSrc(src);
    setSlipPreviewTitle(title);
    setSlipPreviewOpen(true);
  };

  const deleteDeclaredSlip = async (slipType: "qtm" | "unc", index: number) => {
    if (!isOwner) {
      toast({
        title: financeControl[isVi ? "vi" : "en"].noPermissionToDeleteSlip,
        description: financeControl[isVi ? "vi" : "en"].onlyOwnersCanDeleteDeclaredSlips,
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    setDeclarationSaveMessage(null);
    try {
      const { data: latestDecl, error: latestError } = await looseSupabase
        .from("ceo_daily_closing_declarations")
        .select("closing_date,unc_total_declared,unc_extracted_amount,cash_fund_topup_amount,qtm_extracted_amount,notes,extraction_meta")
        .eq("closing_date", dateKey)
        .maybeSingle();
      if (latestError) throw latestError;
      if (!latestDecl) throw new FinanceUiError(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].ceoDeclarationNotFound), isVi);

      const meta = latestDecl.extraction_meta || {};
      const currentQtmImages = Array.isArray(meta.qtm_images)
        ? meta.qtm_images
        : (latestDecl.qtm_slip_image_base64 ? [latestDecl.qtm_slip_image_base64] : []);
      const currentUncImages = Array.isArray(meta.unc_images)
        ? meta.unc_images
        : (latestDecl.unc_slip_image_base64 ? [latestDecl.unc_slip_image_base64] : []);
      const currentQtmItems = Array.isArray(meta.qtm_items) ? meta.qtm_items : [];
      const currentUncItems = Array.isArray(meta.unc_items) ? meta.unc_items : [];

      const nextQtmImages = slipType === "qtm" ? currentQtmImages.filter((_: unknown, i: number) => i !== index) : currentQtmImages;
      const nextUncImages = slipType === "unc" ? currentUncImages.filter((_: unknown, i: number) => i !== index) : currentUncImages;
      const nextQtmItems = slipType === "qtm" ? currentQtmItems.filter((_: unknown, i: number) => i !== index) : currentQtmItems;
      const nextUncItems = slipType === "unc" ? currentUncItems.filter((_: unknown, i: number) => i !== index) : currentUncItems;

      const nextQtmAmount = nextQtmItems.reduce((sum: number, item: ExtractedSlipItem) => sum + Number(item?.amount || 0), 0);
      const nextUncAmount = nextUncItems.reduce((sum: number, item: ExtractedSlipItem) => sum + Number(item?.amount || 0), 0);

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

      const { error } = await looseSupabase
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
      setDeclarationSaveMessage(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].slipDeletedAndCEODeclarationUpdated));
      await refetchDeclaration();
      await refetchDeclarationImages();
      toast({
        title: financeControl[isVi ? "vi" : "en"].slipDeleted,
        description: financeControl[isVi ? "vi" : "en"].ceoDeclarationHasBeenRecalculatedFromThe,
      });
    } catch (e: unknown) {
      toast({
        title: financeControl[isVi ? "vi" : "en"].failedToDeleteSlip,
        description: e?.message || (financeControl[isVi ? "vi" : "en"].unableToDeleteSlip),
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
      pendingQtmExtractedList?: ExtractedSlipItem[];
      pendingUncExtractedList?: ExtractedSlipItem[];
    },
  ): Promise<boolean> => {
    setSaving(true);
    setDeclarationSaveMessage(null);
    try {
      const { data: latestDecl } = await looseSupabase
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
            ...((sourceDecl?.extraction_meta?.qtm_items as ExtractedSlipItem[]) || []),
            ...nextPendingQtmExtractedList,
          ],
          unc_items: [
            ...((sourceDecl?.extraction_meta?.unc_items as ExtractedSlipItem[]) || []),
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

      const { error } = await looseSupabase
        .from("ceo_daily_closing_declarations")
        .upsert(payload, { onConflict: "closing_date" });

      if (error) throw error;
      if (!silent) {
        setDeclarationSaveMessage(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].ceoDeclarationSaved));
        toast({ title: financeControl[isVi ? "vi" : "en"].saved, description: financeControl[isVi ? "vi" : "en"].declarationUpdated });
      }
      setPendingQtmImagesBase64([]);
      setPendingUncImagesBase64([]);
      setPendingQtmExtractedList([]);
      setPendingUncExtractedList([]);
      await refetchDeclaration();
      return true;
    } catch (e: unknown) {
      setDeclarationSaveMessage(financeMessage((isVi) => localizedFinanceError(e, isVi, e?.message || (financeControl[isVi ? "vi" : "en"].failedToSaveDeclaration))));
      if (!silent) {
        toast({ title: financeControl[isVi ? "vi" : "en"].error, description: e?.message || financeControl[isVi ? "vi" : "en"].failedToSaveDeclaration, variant: "destructive" });
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

      const { error } = await looseSupabase
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
      if (uncStatus === "mismatch") summaryParts.push(`UNC ${financeControl[isVi ? "vi" : "en"].variance}: ${vnd(uncVariance)}`);
      if (qtmStatus === "mismatch") summaryParts.push(`QTM ${financeControl[isVi ? "vi" : "en"].negativeClosingBalance}: ${vnd(Math.abs(qtmClosingBalanceFresh))}`);

      toast({
        title: status === "match"
          ? (financeControl[isVi ? "vi" : "en"].reconciledMATCH)
          : (financeControl[isVi ? "vi" : "en"].reconciledMISMATCH),
        description: summaryParts.length > 0
          ? summaryParts.join(" | ")
          : (financeControl[isVi ? "vi" : "en"].uncAndQTMBothMatch),
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
    } catch (e: unknown) {
      toast({ title: financeControl[isVi ? "vi" : "en"].error, description: e?.message || financeControl[isVi ? "vi" : "en"].reconciliationFailed, variant: "destructive" });
      return null;
    } finally {
      setReconciling(false);
    }
  };

  // Open close dialog → preview step (scan file list only, no OCR yet)
  const openCloseDialog = async () => {
    if (closeApprovalLocked) {
      toast({
        title: financeControl[isVi ? "vi" : "en"].alreadyLocked,
        description: financeControl[isVi ? "vi" : "en"].thisDayIsAlreadyClosedUnlockFirst,
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
          const detail = scanFailureDetail(resp.status, err);
          return { files: [], error: new FinanceUiError(detail, isVi) };
        }
        return await resp.json();
      };

      const [uncData, qtmData] = await Promise.all([scanPreview(uncPath), scanPreview(qtmPath)]);
      setPreviewUncFiles(uncData?.totalFilesFound ?? uncData?.files?.length ?? 0);
      setPreviewQtmFiles(qtmData?.totalFilesFound ?? qtmData?.files?.length ?? 0);

      if (uncData?.error || qtmData?.error) {
        const errors = financeMessage((isVi) => [
          uncData?.error && `UNC: ${readFinanceMessage(financeErrorMessage(uncData.error, financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].cannotConnectToDrive)), isVi)}`,
          qtmData?.error && `QTM: ${readFinanceMessage(financeErrorMessage(qtmData.error, financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].cannotConnectToDrive)), isVi)}`,
        ].filter(Boolean).join(" | "));
        if (canCloseWithoutBankSlips) {
          setReconcileError(null);
        } else {
          setReconcileError(errors);
        }
      }
    } catch (e: unknown) {
      setReconcileError(financeErrorMessage(e, financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].cannotConnectToDrive)));
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
      setReconcileProgress({ done: 0, total: 0, currentFile: financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].step14SavingCEODeclaration) });
      const declarationSaved = await saveDeclaration(true);
      if (!declarationSaved) {
        throw new FinanceUiError(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].failedToSaveCEODeclaration), isVi);
      }

      // Step 2: Scan Drive folders (UNC + QTM)
      setReconcileProgress({ done: 0, total: 0, currentFile: financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].step24ScanningOCRBankSlips) });
      const folderScanResult = shouldRunFolderReconciliation
        ? await runFolderReconciliation()
        : {
            uncPath: uncPathForDate,
            qtmPath: qtmPathForDate,
            uncTotalScannedCount: 0,
            qtmTotalScannedCount: 0,
            uncFolderTotal: 0,
            qtmFolderTotal: 0,
          };
      if (!folderScanResult) {
        throw new FinanceUiError(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].missingDriveScanResult), isVi);
      }

      if (hasDeclaredUnc && folderScanResult.uncTotalScannedCount === 0) {
        throw new FinanceUiError(financeMessage((isVi) => isVi
          ? `Không thể chốt ngày: UNC đã khai báo ${vnd(Number(uncTotalDeclared || 0))} nhưng thư mục Drive UNC không quét được file nào (${folderScanResult.uncPath}).`
          : `Cannot close day: UNC was declared but Drive UNC scan returned 0 files (${folderScanResult.uncPath}).`), isVi);
      }
      // QTM declared by CEO is cash added to the QTM fund. It may be spent from the
      // Drive QTM folder on a later day, so zero QTM files/spend today must carry
      // forward into qtmClosingBalance instead of blocking close-day approval.
      if (hasDeclaredUnc && Number(folderScanResult.uncFolderTotal || 0) === 0) {
        throw new FinanceUiError(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].cannotCloseDayUNCWasDeclaredBut), isVi);
      }

      // Step 3: Run reconciliation
      setReconcileProgress({ done: 0, total: 0, currentFile: financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].step34ReconcilingUNCQTM) });
      await refetchUncDetail();
      // Pass fresh totals directly to avoid stale React state (folderScanResult state updates are async)
      const result = await runReconcile({
        uncFolderTotal: folderScanResult.uncFolderTotal,
        qtmFolderTotal: folderScanResult.qtmFolderTotal,
        uncDeclared: Number(uncTotalDeclared || 0),
        qtmDeclared: Number(cashFundTopupAmount || 0),
      });
      if (!result) {
        throw new FinanceUiError(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].failedToCompleteReconciliation), isVi);
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
      setReconcileProgress({ done: 0, total: 0, currentFile: financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].step44LockingClosing) });
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
        title: financeControl[isVi ? "vi" : "en"].dayApprovedClosedSuccessfully,
        description: result?.status === "match"
          ? (financeControl[isVi ? "vi" : "en"].uncAndQTMBothMatch)
          : (financeControl[isVi ? "vi" : "en"].varianceDetectedPleaseReview),
        variant: result?.status === "match" ? "default" : "destructive",
      });
      await refetchDeclaration();
    } catch (e: unknown) {
      setReconcileError(financeErrorMessage(e, financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].failedClosingDay)));
      setCloseDialogStep("preview"); // Go back to preview so user can retry or change settings
    } finally {
      setCloseActing(false);
    }
  };

  const handleConfirmMismatchClose = async () => {
    setCloseActing(true);
    setCloseDialogStep("running");
    try {
      setReconcileProgress({ done: 0, total: 0, currentFile: financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].step44LockingClosing) });
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
        title: financeControl[isVi ? "vi" : "en"].dayClosedWithVariance,
        description: financeControl[isVi ? "vi" : "en"].ceoConfirmedCloseDespiteUNCQTMVariance,
        variant: "destructive",
      });
      await refetchDeclaration();
    } catch (e: unknown) {
      setReconcileError(financeErrorMessage(e, financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].failedClosingDay)));
      setCloseDialogStep("mismatch");
    } finally {
      setCloseActing(false);
    }
  };

  const handleUnlockApproval = async () => {
    setCloseActing(true);
    try {
      const declarationSaved = await saveDeclaration(true);
      if (!declarationSaved) throw new FinanceUiError(financeMessage((isVi) => financeControl[isVi ? "vi" : "en"].failedToSaveBeforeUnlock), isVi);
      await saveReconciliationWorkflowMeta("approve", false, "unlock_approval");
      toast({
        title: financeControl[isVi ? "vi" : "en"].approvalUnlocked,
        description: financeControl[isVi ? "vi" : "en"].youCanEditAndApproveAgain,
      });
      await refetchDeclaration();
    } catch (e: unknown) {
      toast({ title: financeControl[isVi ? "vi" : "en"].error, description: e?.message || (financeControl[isVi ? "vi" : "en"].failedToUnlock), variant: "destructive" });
    } finally {
      setCloseActing(false);
    }
  };

  return (
    <div data-staff-i18n="finance-control-v1" className="space-y-6">
      {/* Header + Date picker */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">{mode === "classification" ? (financeControl[isVi ? "vi" : "en"].costClassification) : (financeControl[isVi ? "vi" : "en"].ceoDeclaration)}</h1>
          <p className="text-muted-foreground text-sm">{mode === "classification" ? (financeControl[isVi ? "vi" : "en"].reviewAndAdjustInternalCostCategories) : (financeControl[isVi ? "vi" : "en"].declareReconcileCloseDailyAndMonthly)}</p>
        </div>
        {mode === "ceo" && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="icon" onClick={() => setSelectedDate((d) => subDays(d, 1))}>←</Button>
            <Input type="date" className="w-40" value={toDateInputValue(selectedDate)} onChange={(e) => setSelectedDate(parseDateInputValue(e.target.value))} />
            <Button type="button" variant="outline" size="icon" onClick={() => setSelectedDate((d) => subDays(d, -1))}>→</Button>
          </div>
        )}
      </div>

      {/* Dashboard */}
      {mode === "ceo" && (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].uncDeclared}</div>
            <div className="text-xl font-semibold">{vnd(Number(uncTotalDeclared || 0))}</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].qtmDeclared}</div>
            <div className="text-xl font-semibold">{vnd(Number(resolvedQtmDeclared || 0))}</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].openingCashBalance}</div>
            <div className="text-xl font-semibold">{vnd(Number(resolvedQtmOpening || 0))}</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].status}</div>
            <div className="text-xl font-semibold">
              {closeApprovalLocked
                ? <Badge className="bg-green-600">{financeControl[isVi ? "vi" : "en"].closed}</Badge>
                : resolvedStatus === "match" ? <Badge className="bg-green-600">{financeControl[isVi ? "vi" : "en"].match}</Badge>
                : resolvedStatus === "mismatch" ? <Badge variant="destructive">{financeControl[isVi ? "vi" : "en"].mismatch}</Badge>
                : <Badge variant="secondary">{financeControl[isVi ? "vi" : "en"].pending}</Badge>}
            </div>
          </CardContent></Card>
        </div>
      )}

      <Tabs value={mode === "classification" ? "classification" : activeTab} onValueChange={(value) => {
        if (mode === "classification") return;
        setActiveTab(value);
        if (value === "monthly") {
          setSelectedMonth(startOfMonth(selectedDate));
        }
      }} className="space-y-4">
        {mode === "ceo" && (
          <TabsList>
            <TabsTrigger value="daily">{financeControl[isVi ? "vi" : "en"].dailyClose}</TabsTrigger>
            <TabsTrigger value="monthly">{financeControl[isVi ? "vi" : "en"].monthlyClose}</TabsTrigger>
          </TabsList>
        )}

        {mode === "ceo" && <TabsContent value="daily" className="space-y-4">
          {/* CEO Declaration */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">{financeControl[isVi ? "vi" : "en"].ceoDeclaration2}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4" onMouseEnter={() => { if (!imagesRequested) setImagesRequested(true); }}>
              {activeSlipScanLabel && (
                <div className="sticky top-2 z-10 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800 shadow-sm dark:text-amber-200">
                  <span className="relative flex h-3 w-3 flex-shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
                  </span>
                  <span>{activeSlipScanLabel}</span>
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">{financeControl[isVi ? "vi" : "en"].bankSlipsUNC}</Label>
                  <Input type="file" accept="image/*" multiple disabled={extracting || ceoDeclarationLocked || closeApprovalLocked} onChange={async (e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length) await processSlipUpload("unc", files);
                    e.currentTarget.value = "";
                  }} />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setImagesRequested(true);
                      void refetchDeclarationImages();
                    }}
                  >
                    {financeControl[isVi ? "vi" : "en"].showReloadSavedSlips}
                  </Button>
                  {slipUploadStatus.unc && (
                    <div className={`text-xs rounded border px-2 py-1 ${slipStatusClass(slipUploadStatus.unc)}`}>
                      {slipUploadStatus.unc}
                    </div>
                  )}
                  {!!uncSlipPreviews.length && (
                    <div className="flex flex-wrap gap-2">
                      {uncSlipPreviews.map((src, idx) => (
                        <div key={`unc-${idx}`} className="group relative flex flex-col gap-1 rounded-md border bg-background p-1 md:block md:border-0 md:bg-transparent md:p-0">
                          <button
                            type="button"
                            className="overflow-hidden rounded border bg-background"
                            onClick={() => openSlipPreview(src, financeMessage((isVi) => formatText(financeControl[isVi ? "vi" : "en"].slipImage, { type: "UNC", index: idx + 1 })))}
                          >
                            <img src={src} alt={formatText(financeControl[isVi ? "vi" : "en"].slipImage, { type: "UNC", index: idx + 1 })} className="h-20 rounded object-contain transition-transform group-hover:scale-[1.02]" />
                          </button>
                          {isOwner && (
                            <button
                              type="button"
                              className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm ring-2 ring-background transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50 md:h-7 md:w-7"
                              disabled={saving || closeApprovalLocked}
                              data-bmq-mobile-ceo-slip-delete="unc"
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
                  <Label className="text-sm font-medium">{financeControl[isVi ? "vi" : "en"].cashSlipsQTM}</Label>
                  <Input type="file" accept="image/*" multiple disabled={extracting || ceoDeclarationLocked || closeApprovalLocked} onChange={async (e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length) await processSlipUpload("qtm", files);
                    e.currentTarget.value = "";
                  }} />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setImagesRequested(true);
                      void refetchDeclarationImages();
                    }}
                  >
                    {financeControl[isVi ? "vi" : "en"].showReloadSavedSlips}
                  </Button>
                  {slipUploadStatus.qtm && (
                    <div className={`text-xs rounded border px-2 py-1 ${slipStatusClass(slipUploadStatus.qtm)}`}>
                      {slipUploadStatus.qtm}
                    </div>
                  )}
                  {ocrDebugMessage && (
                    <div className="text-xs rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-destructive">
                      {ocrDebugMessage}
                    </div>
                  )}
                  {!!qtmSlipPreviews.length && (
                    <div className="flex flex-wrap gap-2">
                      {qtmSlipPreviews.map((src, idx) => (
                        <div key={`qtm-${idx}`} className="group relative flex flex-col gap-1 rounded-md border bg-background p-1 md:block md:border-0 md:bg-transparent md:p-0">
                          <button
                            type="button"
                            className="overflow-hidden rounded border bg-background"
                            onClick={() => openSlipPreview(src, financeMessage((isVi) => formatText(financeControl[isVi ? "vi" : "en"].slipImage, { type: "QTM", index: idx + 1 })))}
                          >
                            <img src={src} alt={formatText(financeControl[isVi ? "vi" : "en"].slipImage, { type: "QTM", index: idx + 1 })} className="h-20 rounded object-contain transition-transform group-hover:scale-[1.02]" />
                          </button>
                          {isOwner && (
                            <button
                              type="button"
                              className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm ring-2 ring-background transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50 md:h-7 md:w-7"
                              disabled={saving || closeApprovalLocked}
                              data-bmq-mobile-ceo-slip-delete="qtm"
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

              {extracting && <div className="text-sm text-muted-foreground animate-pulse">{financeControl[isVi ? "vi" : "en"].scanningSlips}</div>}
              {declarationSaveMessage && (
                <div className={`rounded-lg border px-3 py-2 text-sm font-medium ${isSuccessMessage(declarationSaveMessage) ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-300" : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"}`}>
                  {declarationSaveMessage}
                </div>
              )}
              <div className="flex justify-end">
                <Button type="button" variant="outline" disabled={extracting || saving || ceoDeclarationLocked || closeApprovalLocked} onClick={() => saveDeclaration(false)}>
                  {saving ? (financeControl[isVi ? "vi" : "en"].saving) : (financeControl[isVi ? "vi" : "en"].saveDeclaration)}
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
                      <span className="text-lg font-semibold">{financeControl[isVi ? "vi" : "en"].approvedClosed}</span>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={handleUnlockApproval} disabled={closeActing}>
                      <Unlock className="h-4 w-4 mr-2" />
                      {financeControl[isVi ? "vi" : "en"].unlock}
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
                    {financeControl[isVi ? "vi" : "en"].approveCloseDay}
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
                  <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].notes}</Label>
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={financeControl[isVi ? "vi" : "en"].optional} disabled={closeApprovalLocked} className="text-sm" />
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
        </TabsContent>}

        {mode === "ceo" && <TabsContent value="monthly" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="text-xl sm:text-2xl">{financeControl[isVi ? "vi" : "en"].monthlyClosing}</CardTitle>
                <Input
                  type="month"
                  className="w-full sm:w-40"
                  value={format(selectedMonth, "yyyy-MM")}
                  onChange={(e) => setSelectedMonth(parseMonthInputValue(e.target.value))}
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-4 overflow-hidden">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].totalUNCActual}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.totalUncDetail || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].totalUNCDeclared}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.totalUncDeclared || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].uncVariance2}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.netVariance || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].matchRate}</div><div className="break-words text-lg font-semibold sm:text-xl">{monthlySummary?.totalDays ? `${monthlySummary.matchDays}/${monthlySummary.totalDays}` : "—"}</div></CardContent></Card>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].openingQTMBalance}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.monthOpeningQtm || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].totalQTMDeclared}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.totalQtmDeclared || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].totalQTMSpent}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.totalQtmSpent || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].closingQTMBalance}</div><div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(monthlySummary?.monthClosingQtm || 0))}</div></CardContent></Card>
              </div>

              <div className="overflow-x-auto rounded-md border">
                <Table className="min-w-[1180px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">{financeControl[isVi ? "vi" : "en"].date}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{financeControl[isVi ? "vi" : "en"].uncActual}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{financeControl[isVi ? "vi" : "en"].uncDeclared}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{financeControl[isVi ? "vi" : "en"].variance2}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{financeControl[isVi ? "vi" : "en"].qtmOpening}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{financeControl[isVi ? "vi" : "en"].qtmDeclared2}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{financeControl[isVi ? "vi" : "en"].qtmSpent}</TableHead>
                      <TableHead className="whitespace-nowrap text-right">{financeControl[isVi ? "vi" : "en"].qtmClosing}</TableHead>
                      <TableHead className="whitespace-nowrap">{financeControl[isVi ? "vi" : "en"].unc}</TableHead>
                      <TableHead className="whitespace-nowrap">{financeControl[isVi ? "vi" : "en"].qtm}</TableHead>
                      <TableHead className="whitespace-nowrap">{financeControl[isVi ? "vi" : "en"].overall}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monthlySummary?.rows?.map((r: CostClassificationMonthlySummary) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{format(new Date(r.closing_date), "dd/MM/yyyy", { locale: vi })}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.unc_detail_amount || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.unc_declared_amount || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.variance_amount || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.qtm_opening_balance || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.qtm_declared_amount || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.qtm_spent_from_folder || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap text-right">{vnd(Number(r.qtm_closing_balance || 0))}</TableCell>
                        <TableCell className="whitespace-nowrap">{r.unc_status === "match" ? <Badge className="bg-green-600">{financeControl[isVi ? "vi" : "en"].matchBadge}</Badge> : r.unc_status === "mismatch" ? <Badge variant="destructive">{financeControl[isVi ? "vi" : "en"].mismatchBadge}</Badge> : <Badge variant="secondary">—</Badge>}</TableCell>
                        <TableCell className="whitespace-nowrap">{r.qtm_status === "match" ? <Badge className="bg-green-600">{financeControl[isVi ? "vi" : "en"].matchBadge}</Badge> : r.qtm_status === "mismatch" ? <Badge variant="destructive">{financeControl[isVi ? "vi" : "en"].mismatchBadge}</Badge> : <Badge variant="secondary">—</Badge>}</TableCell>
                        <TableCell className="whitespace-nowrap">{r.status === "match" ? <Badge className="bg-green-600">{financeControl[isVi ? "vi" : "en"].matchBadge}</Badge> : r.status === "mismatch" ? <Badge variant="destructive">{financeControl[isVi ? "vi" : "en"].mismatchBadge}</Badge> : <Badge variant="secondary">—</Badge>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {!monthlySummary?.rows?.length && (
                <div className="text-sm text-muted-foreground text-center py-4">{financeControl[isVi ? "vi" : "en"].noDataYet}</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>}

        {mode === "classification" && <TabsContent value="classification" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-xl sm:text-2xl">{financeControl[isVi ? "vi" : "en"].internalCostClassification}</CardTitle>
                  <CardDescription>
                    {financeControl[isVi ? "vi" : "en"].lineItemClassificationTapACategoryTo}
                  </CardDescription>
                </div>
                <Input
                  type="month"
                  className="w-full sm:w-40"
                  value={format(selectedMonth, "yyyy-MM")}
                  onChange={(e) => setSelectedMonth(parseMonthInputValue(e.target.value))}
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-5 overflow-hidden">
              {costClassification.error && (
                <div className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                  {financeControl[isVi ? "vi" : "en"].classificationDataIsNotAvailableYetCheck}
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Card className={classificationPendingReviewStats.count > 0 ? "border-amber-300 bg-amber-500/5" : ""}>
                  <CardContent className="p-4">
                    <div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].pendingReview}</div>
                    <div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(classificationPendingReviewStats.amount || 0))}</div>
                    <div className="text-xs text-muted-foreground">
                      {classificationPendingReviewStats.count} {financeControl[isVi ? "vi" : "en"].linesKeptSeparateFromApprovedCost}
                    </div>
                  </CardContent>
                </Card>
                {COST_CLASSIFICATION_CARD_CODES.map((code) => {
                  const row = classificationCategoryByCode.get(code);
                  return (
                    <Card key={code}>
                      <CardContent className="p-4">
                        <div className="text-xs text-muted-foreground">{getCostCategoryDisplayLabel(row?.label || code, isVi)}</div>
                        <div className="break-words text-lg font-semibold sm:text-xl">{vnd(Number(row?.amount || 0))}</div>
                        <div className="text-xs text-muted-foreground">{Number(row?.count || 0)} {financeControl[isVi ? "vi" : "en"].lines}</div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <CardTitle className="text-lg">{financeControl[isVi ? "vi" : "en"].totalsByCategory}</CardTitle>
                      <CardDescription>
                        {format(selectedMonth, "MM/yyyy")} · {classificationMonthlyDisplayRows.length} {financeControl[isVi ? "vi" : "en"].categories} · {vnd(classificationTotalAmount)}
                        {classificationPendingReviewStats.count > 0
                          ? ` · ${financeControl[isVi ? "vi" : "en"].pendingReview2} ${vnd(classificationPendingReviewStats.amount)}`
                          : ""}
                      </CardDescription>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {financeControl[isVi ? "vi" : "en"].tapACategoryToViewDetails}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {classificationMonthlyDisplayRows.length > 0 ? (
                    <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
                      <div className="rounded-2xl border bg-muted/20 p-3 sm:p-4">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium">{financeControl[isVi ? "vi" : "en"].costShare}</div>
                            <div className="text-xs text-muted-foreground">{format(selectedMonth, "MM/yyyy")}</div>
                          </div>
                          <Badge variant="secondary">{vnd(classificationTotalAmount)}</Badge>
                        </div>
                        <div className="h-[240px] sm:h-[280px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie
                                data={classificationChartRows}
                                dataKey="amount"
                                nameKey="category_label"
                                innerRadius="58%"
                                outerRadius="82%"
                                paddingAngle={2}
                                stroke="hsl(var(--background))"
                                strokeWidth={3}
                              >
                                {classificationChartRows.map((row) => (
                                  <Cell key={costDetailSelectionKey(row)} fill={row.fill} />
                                ))}
                              </Pie>
                              <Tooltip
                                formatter={(value: number, _name, item: { payload?: ClassificationChartRow }) => [
                                  `${vnd(Number(value || 0))} · ${Number(item?.payload?.percentage || 0).toFixed(1)}%`,
                                  getCostCategoryDisplayLabel(item?.payload?.category_label || item?.payload?.category_code, isVi),
                                ]}
                              />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-1">
                          {classificationChartRows.slice(0, 6).map((row) => (
                            <button
                              type="button"
                              key={`legend-${costDetailSelectionKey(row)}`}
                              className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-background ${costDetailSelectionKey(row) === selectedCostSummaryKey ? "bg-background shadow-sm" : ""}`}
                              onClick={() => setSelectedCostSummaryRow(costDetailSelectionKey(row) === selectedCostSummaryKey ? null : row)}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.fill }} />
                                <span className="truncate">{getCostCategoryDisplayLabel(row.category_label || row.category_code, isVi)}</span>
                              </span>
                              <span className="shrink-0 text-muted-foreground">{row.percentage.toFixed(1)}%</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div className="grid gap-3 md:hidden">
                          {classificationChartRows.map((row) => {
                            const rowKey = costDetailSelectionKey(row);
                            const isSelected = rowKey === selectedCostSummaryKey;
                            return (
                              <button
                                type="button"
                                key={`mobile-${rowKey}`}
                                className={`rounded-2xl border p-3 text-left shadow-sm transition-all ${isSelected ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/40"}`}
                                onClick={() => setSelectedCostSummaryRow(isSelected ? null : row)}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.fill }} />
                                      <div className="line-clamp-2 text-sm font-semibold leading-snug">{getCostCategoryDisplayLabel(row.category_label || row.category_code, isVi)}</div>
                                    </div>
                                    <div className="mt-1 truncate text-[11px] text-muted-foreground">{row.category_code}</div>
                                  </div>
                                  <Badge variant={isSelected ? "default" : "secondary"} className="shrink-0">
                                    {getClassificationShareLabel(row.percentage, isVi)}
                                  </Badge>
                                </div>
                                <div className="mt-3 flex items-end justify-between gap-3">
                                  <div>
                                    <div className="text-base font-bold leading-tight">{vnd(row.amount)}</div>
                                    <div className="text-xs text-muted-foreground">{Number(row.line_count || 0)} {financeControl[isVi ? "vi" : "en"].lines}</div>
                                  </div>
                                  <div className="text-xs font-medium text-primary">{financeControl[isVi ? "vi" : "en"].view}</div>
                                </div>
                                <div className="mt-2 rounded-lg bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                                  {row.note}
                                </div>
                              </button>
                            );
                          })}
                        </div>

                        <div className="hidden overflow-hidden rounded-xl border md:block">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>{financeControl[isVi ? "vi" : "en"].mainCategory}</TableHead>
                                <TableHead>{financeControl[isVi ? "vi" : "en"].note}</TableHead>
                                <TableHead className="text-right">{financeControl[isVi ? "vi" : "en"].lines2}</TableHead>
                                <TableHead className="text-right">{financeControl[isVi ? "vi" : "en"].share}</TableHead>
                                <TableHead className="text-right">{financeControl[isVi ? "vi" : "en"].amount}</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {classificationChartRows.map((row) => {
                                const rowKey = costDetailSelectionKey(row);
                                const isSelected = rowKey === selectedCostSummaryKey;
                                return (
                                  <TableRow
                                    key={rowKey}
                                    className={`cursor-pointer transition-colors hover:bg-muted/60 ${isSelected ? "bg-muted" : ""}`}
                                    onClick={() => setSelectedCostSummaryRow(isSelected ? null : row)}
                                  >
                                    <TableCell>
                                      <div className="flex items-center gap-2">
                                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.fill }} />
                                        <div className="min-w-0">
                                          <div className="font-medium">{getCostCategoryDisplayLabel(row.category_label || row.category_code, isVi)}</div>
                                          <div className="text-xs text-muted-foreground">{row.category_code}</div>
                                        </div>
                                      </div>
                                    </TableCell>
                                    <TableCell className="max-w-[360px] text-xs text-muted-foreground">{row.note}</TableCell>
                                    <TableCell className="text-right">{Number(row.line_count || 0)}</TableCell>
                                    <TableCell className="text-right">{row.percentage.toFixed(1)}%</TableCell>
                                    <TableCell className="text-right font-medium">{vnd(row.amount)}</TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="py-4 text-center text-sm text-muted-foreground">
                      {costClassification.isLoading || costClassification.isFetching ? (financeControl[isVi ? "vi" : "en"].loading) : (financeControl[isVi ? "vi" : "en"].noBackfilledDataForThisMonthYet)}
                    </div>
                  )}
                </CardContent>
              </Card>

              {selectedCostSummaryRow && (
                <Card className="overflow-hidden">
                  <CardHeader className="pb-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="text-lg">
                          {financeControl[isVi ? "vi" : "en"].categoryDetails}: {getCostCategoryDisplayLabel(selectedCostSummaryRow.category_label || selectedCostSummaryRow.category_code, isVi)}
                        </CardTitle>
                        <CardDescription>
                          {formatMonthValue(selectedCostSummaryRow.month)} • {formatReviewStatusCounts((selectedCostSummaryRow as ClassificationMonthlyDisplayRow).review_status_counts || {}, isVi)} • {Number(selectedCostSummaryRow.line_count || 0)} {financeControl[isVi ? "vi" : "en"].lines}
                          {selectedCostChartRow ? ` • ${selectedCostChartRow.percentage.toFixed(1)}%` : ""}
                        </CardDescription>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => setSelectedCostSummaryRow(null)}>
                        {financeControl[isVi ? "vi" : "en"].closeDetails}
                      </Button>
                    </div>
                    {selectedCostChartRow?.note && (
                      <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                        {selectedCostChartRow.note}
                      </div>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-3 md:hidden">
                      {selectedCostDetailRows.map((row) => {
                        const selectedCode = classificationEdits[row.classification_id] || row.category_code;
                        const selectedCategory = costCategoryByCode.get(selectedCode);
                        const standardDraft = getStandardCostDraft(row, standardCostEdits);
                        const isChanged = selectedCode !== row.category_code;
                        const standardChanged = Boolean(standardCostEdits[row.classification_id]) && hasStandardCostDraftChanged(row, standardDraft);
                        const isEditingClassificationLine = editingClassificationLineId === row.classification_id;
                        return (
                          <div key={`mobile-detail-${row.classification_id}`} className={`rounded-2xl border p-3 ${isChanged || standardChanged ? "border-amber-400 bg-amber-500/5" : "bg-card"}`}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-xs text-muted-foreground">{getLineDateLabel(row.source_date)} · {row.source_type}</div>
                                <div className="mt-1 line-clamp-2 text-sm font-semibold leading-snug">{row.product_name}</div>
                                <div className="mt-1 truncate text-xs text-muted-foreground">{row.supplier_name || "-"}</div>
                                {(row.confirmed_standard_cost_code || row.suggested_standard_cost_code || row.standard_cost_code_type) && (
                                  <div className="mt-1 text-xs text-emerald-700">
                                    {financeControl[isVi ? "vi" : "en"].standardCodeLabel} {row.confirmed_standard_cost_code || row.suggested_standard_cost_code || "-"}{row.standard_cost_code_type ? ` · ${row.standard_cost_code_type}` : ""}
                                  </div>
                                )}
                              </div>
                              <div className="shrink-0 text-right">
                                <div className="text-sm font-bold">{vnd(Number(row.line_amount || 0))}</div>
                                <div className="text-[11px] text-muted-foreground">{Math.round(Number(row.confidence || 0) * 100)}%</div>
                              </div>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span className="truncate">{row.source_number || row.product_code || row.unit || "-"}</span>
                              {canEditCostClassification ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 px-2"
                                  aria-label={financeControl[isVi ? "vi" : "en"].editCategory}
                                  onClick={() => setEditingClassificationLineId(isEditingClassificationLine ? null : row.classification_id)}
                                >
                                  {isEditingClassificationLine ? <X className="mr-1 h-3.5 w-3.5" /> : <Pencil className="mr-1 h-3.5 w-3.5" />}
                                  {financeControl[isVi ? "vi" : "en"].edit}
                                </Button>
                              ) : (
                                <Badge variant={row.category_code === "UNMAPPED_REVIEW" ? "destructive" : "secondary"}>{row.category_code}</Badge>
                              )}
                            </div>
                            {isEditingClassificationLine && (
                              <div className="mt-3 space-y-2 rounded-xl bg-muted/40 p-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                  {financeControl[isVi ? "vi" : "en"].selectANewCategoryForThisLine}
                                </div>
                                <Select
                                  value={selectedCode}
                                  onValueChange={(value) => updateClassificationEdit(row.classification_id, row.category_code, value)}
                                >
                                  <SelectTrigger className={`${isChanged ? "border-amber-500" : ""}`}>
                                    <SelectValue placeholder={financeControl[isVi ? "vi" : "en"].selectCategory} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {costCategoryOptions.map((category) => (
                                      <SelectItem key={category.code} value={category.code}>
                                        {getCostCategorySelectLabel(category.code, getCostCategoryDisplayLabel(category.label, isVi))}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <div className="text-xs text-muted-foreground">
                                  {selectedCategory?.cost_group || row.cost_group} • {selectedCategory?.product_line || row.product_line}
                                </div>
                                <div className="grid gap-2">
                                  <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].standardCodeType}</Label>
                                  <Select
                                    value={standardDraft.standard_cost_code_type || "NVL"}
                                    onValueChange={(value) => updateStandardCostEdit(row, "standard_cost_code_type", value)}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder="NVL / OPEX / OTHER" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="NVL">NVL</SelectItem>
                                      <SelectItem value="OPEX">OPEX</SelectItem>
                                      <SelectItem value="OTHER">{financeControl[isVi ? "vi" : "en"].otherCode}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="grid gap-2">
                                  <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].standardCode}</Label>
                                  <Input
                                    value={standardDraft.standard_cost_code}
                                    onChange={(event) => updateStandardCostEdit(row, "standard_cost_code", event.target.value)}
                                    placeholder={financeControl[isVi ? "vi" : "en"].exampleBOTMI13}
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].canonicalName}</Label>
                                  <Input
                                    value={standardDraft.canonical_cost_item_name}
                                    onChange={(event) => updateStandardCostEdit(row, "canonical_cost_item_name", event.target.value)}
                                    placeholder={row.product_name}
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].conversionNote}</Label>
                                  <Input
                                    value={standardDraft.unit_conversion_note}
                                    onChange={(event) => updateStandardCostEdit(row, "unit_conversion_note", event.target.value)}
                                    placeholder={financeControl[isVi ? "vi" : "en"].optional}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="hidden overflow-x-auto rounded-md border md:block">
                      <Table className="min-w-[980px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>{financeControl[isVi ? "vi" : "en"].date}</TableHead>
                            <TableHead>{financeControl[isVi ? "vi" : "en"].supplier}</TableHead>
                            <TableHead>{financeControl[isVi ? "vi" : "en"].item}</TableHead>
                            <TableHead>{financeControl[isVi ? "vi" : "en"].source}</TableHead>
                            <TableHead>{financeControl[isVi ? "vi" : "en"].confidence}</TableHead>
                            <TableHead className="text-right">{financeControl[isVi ? "vi" : "en"].amount2}</TableHead>
                            <TableHead className="text-right">{financeControl[isVi ? "vi" : "en"].edit}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedCostDetailRows.map((row) => {
                            const selectedCode = classificationEdits[row.classification_id] || row.category_code;
                            const selectedCategory = costCategoryByCode.get(selectedCode);
                            const standardDraft = getStandardCostDraft(row, standardCostEdits);
                            const isChanged = selectedCode !== row.category_code;
                            const standardChanged = Boolean(standardCostEdits[row.classification_id]) && hasStandardCostDraftChanged(row, standardDraft);
                            const isEditingClassificationLine = editingClassificationLineId === row.classification_id;
                            return (
                              <Fragment key={row.classification_id}>
                                <TableRow key={row.classification_id} className={isChanged || standardChanged ? "bg-amber-500/5" : ""}>
                                  <TableCell className="whitespace-nowrap">{getLineDateLabel(row.source_date)}</TableCell>
                                  <TableCell>{row.supplier_name || "-"}</TableCell>
                                  <TableCell>
                                    <div className="font-medium">{row.product_name}</div>
                                    <div className="text-xs text-muted-foreground">{row.product_code || row.unit || ""}</div>
                                    {(row.confirmed_standard_cost_code || row.suggested_standard_cost_code || row.standard_cost_code_type) && (
                                      <div className="text-xs text-emerald-700">
                                        {financeControl[isVi ? "vi" : "en"].standardCodeLabel} {row.confirmed_standard_cost_code || row.suggested_standard_cost_code || "-"}{row.standard_cost_code_type ? ` · ${row.standard_cost_code_type}` : ""}
                                      </div>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    <div>{row.source_number || "-"}</div>
                                    <div className="text-xs text-muted-foreground">{row.source_type}</div>
                                  </TableCell>
                                  <TableCell>{Math.round(Number(row.confidence || 0) * 100)}%</TableCell>
                                  <TableCell className="text-right">{vnd(Number(row.line_amount || 0))}</TableCell>
                                  <TableCell className="text-right">
                                    {canEditCostClassification ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        aria-label={financeControl[isVi ? "vi" : "en"].editCategory}
                                        onClick={() => setEditingClassificationLineId(isEditingClassificationLine ? null : row.classification_id)}
                                      >
                                        {isEditingClassificationLine ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                                      </Button>
                                    ) : (
                                      <Badge variant={row.category_code === "UNMAPPED_REVIEW" ? "destructive" : "secondary"}>{row.category_code}</Badge>
                                    )}
                                  </TableCell>
                                </TableRow>
                                {isEditingClassificationLine && (
                                  <TableRow key={`${row.classification_id}-category-editor`} className={isChanged || standardChanged ? "bg-amber-500/5" : "bg-muted/30"}>
                                    <TableCell colSpan={7}>
                                      <div className="space-y-2 py-2">
                                        <div className="text-xs font-medium text-muted-foreground">
                                          {financeControl[isVi ? "vi" : "en"].selectACategoryAndStandardCodeFor}
                                        </div>
                                        <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.2fr)_140px_minmax(160px,0.8fr)_minmax(200px,1fr)]">
                                          <div className="space-y-1">
                                            <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].costCategory}</Label>
                                            <Select
                                              value={selectedCode}
                                              onValueChange={(value) => updateClassificationEdit(row.classification_id, row.category_code, value)}
                                            >
                                              <SelectTrigger className={isChanged ? "border-amber-500" : ""}>
                                                <SelectValue placeholder={financeControl[isVi ? "vi" : "en"].selectCategory} />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {costCategoryOptions.map((category) => (
                                                  <SelectItem key={category.code} value={category.code}>
                                                    {getCostCategorySelectLabel(category.code, getCostCategoryDisplayLabel(category.label, isVi))}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>
                                          <div className="space-y-1">
                                            <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].codeType}</Label>
                                            <Select
                                              value={standardDraft.standard_cost_code_type || "NVL"}
                                              onValueChange={(value) => updateStandardCostEdit(row, "standard_cost_code_type", value)}
                                            >
                                              <SelectTrigger>
                                                <SelectValue placeholder="NVL" />
                                              </SelectTrigger>
                                              <SelectContent>
                                                <SelectItem value="NVL">NVL</SelectItem>
                                                <SelectItem value="OPEX">OPEX</SelectItem>
                                                <SelectItem value="OTHER">{financeControl[isVi ? "vi" : "en"].otherCode}</SelectItem>
                                              </SelectContent>
                                            </Select>
                                          </div>
                                          <div className="space-y-1">
                                            <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].standardCode}</Label>
                                            <Input
                                              value={standardDraft.standard_cost_code}
                                              onChange={(event) => updateStandardCostEdit(row, "standard_cost_code", event.target.value)}
                                              placeholder={financeControl[isVi ? "vi" : "en"].exampleBOTMI13}
                                            />
                                          </div>
                                          <div className="space-y-1">
                                            <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].canonicalName}</Label>
                                            <Input
                                              value={standardDraft.canonical_cost_item_name}
                                              onChange={(event) => updateStandardCostEdit(row, "canonical_cost_item_name", event.target.value)}
                                              placeholder={row.product_name}
                                            />
                                          </div>
                                        </div>
                                        <div className="max-w-xl space-y-1">
                                          <Label className="text-xs">{financeControl[isVi ? "vi" : "en"].conversionNote}</Label>
                                          <Input
                                            value={standardDraft.unit_conversion_note}
                                            onChange={(event) => updateStandardCostEdit(row, "unit_conversion_note", event.target.value)}
                                            placeholder={financeControl[isVi ? "vi" : "en"].optional}
                                          />
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                          {selectedCategory?.cost_group || row.cost_group} • {selectedCategory?.product_line || row.product_line}
                                        </div>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                )}
                              </Fragment>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                    {!selectedCostDetailRows.length && (
                      <div className="py-4 text-center text-sm text-muted-foreground">
                        {selectedCostDetail.isLoading || selectedCostDetail.isFetching ? (financeControl[isVi ? "vi" : "en"].loadingDetails) : (financeControl[isVi ? "vi" : "en"].noDetailLinesForThisGroup)}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        </TabsContent>}
      </Tabs>

      {hasClassificationEdits && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 px-4 py-3 shadow-lg backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <div className="font-medium">
                {isVi ? `Đã thay đổi ${changedClassificationRows.length} dòng phân loại` : `${changedClassificationRows.length} classification changes`}
              </div>
              <div className="text-xs text-muted-foreground">
                {financeControl[isVi ? "vi" : "en"].saveToPersistTheCategoryStandardCode}
              </div>
            </div>
            <div className="flex gap-2 sm:justify-end">
              <Button variant="outline" onClick={cancelClassificationEdits} disabled={savingClassificationEdits}>
                {financeControl[isVi ? "vi" : "en"].cancel}
              </Button>
              <Button onClick={saveClassificationEdits} disabled={savingClassificationEdits || !canEditCostClassification}>
                {savingClassificationEdits ? (financeControl[isVi ? "vi" : "en"].saving) : (financeControl[isVi ? "vi" : "en"].save)}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={slipPreviewOpen} onOpenChange={setSlipPreviewOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{slipPreviewTitle || (financeControl[isVi ? "vi" : "en"].slipPreview)}</DialogTitle>
            <DialogDescription>
              {financeControl[isVi ? "vi" : "en"].zoomedPreviewOfTheDeclaredSlip}
            </DialogDescription>
          </DialogHeader>
          {slipPreviewSrc && (
            <div className="max-h-[75vh] overflow-auto rounded-lg border bg-muted/20 p-2">
              <img src={slipPreviewSrc} alt={slipPreviewTitle || financeControl[isVi ? "vi" : "en"].slipPreview} className="mx-auto h-auto max-w-full rounded" />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Close Dialog: preview → folder picker → execute */}
      <Dialog open={closeDialogOpen} onOpenChange={(open) => { if (!closeActing) setCloseDialogOpen(open); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{financeControl[isVi ? "vi" : "en"].approveCloseDay}</DialogTitle>
            <DialogDescription>
              {format(selectedDate, "dd/MM/yyyy")} — {financeControl[isVi ? "vi" : "en"].reviewBeforeExecuting}
            </DialogDescription>
          </DialogHeader>

          {closeDialogStep === "preview" && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
              {/* Planned scan paths */}
              <div className="rounded border p-3 space-y-2">
                <div className="text-sm font-medium">{financeControl[isVi ? "vi" : "en"].plannedScanPaths}</div>
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
                <div className="text-sm font-medium">{financeControl[isVi ? "vi" : "en"].quickScanResult}</div>
                {previewLoading ? (
                  <div className="text-sm text-muted-foreground animate-pulse">{financeControl[isVi ? "vi" : "en"].scanningFileList}</div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded bg-muted/50 p-2 text-center">
                      <div className="text-2xl font-bold">{previewUncFiles}</div>
                      <div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].uncFiles}</div>
                    </div>
                    <div className="rounded bg-muted/50 p-2 text-center">
                      <div className="text-2xl font-bold">{previewQtmFiles}</div>
                      <div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].qtmFiles}</div>
                    </div>
                  </div>
                )}
              </div>

              {missingRequiredPreview && !previewLoading && !reconcileError && (
                <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                  {financeControl[isVi ? "vi" : "en"].uncWasDeclaredButQuickScanDid}
                </div>
              )}

              {qtmCarryForwardPreview && !previewLoading && !reconcileError && (
                <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                  {financeControl[isVi ? "vi" : "en"].qtmWasDeclaredButNoSameDay}
                </div>
              )}

              {/* CEO declared summary */}
              <div className="rounded border p-3 space-y-1 text-sm">
                <div className="font-medium">{financeControl[isVi ? "vi" : "en"].ceoDeclared}</div>
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
                {reconcileProgress.currentFile || (financeControl[isVi ? "vi" : "en"].processing)}
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
                <span className="text-lg font-semibold">{financeControl[isVi ? "vi" : "en"].dayClosedSuccessfully}</span>
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
              <div className="flex items-start gap-2 text-amber-600">
                <span className="text-xl">⚠️</span>
                <div>
                  <div className="text-base font-semibold">{getMismatchCauseLabel(mismatchResult, isVi)}</div>
                  <div className="text-xs text-muted-foreground">
                    {financeControl[isVi ? "vi" : "en"].overallStatusIsMismatchBecauseOneReconciliation}
                  </div>
                </div>
              </div>
              <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-3 text-sm">
                <div className="rounded bg-background/70 p-2 space-y-1">
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">UNC</span>
                    <span className={Number(mismatchResult?.uncVariance || 0) === 0 ? "font-semibold text-green-700" : "font-semibold text-amber-700"}>
                      {Number(mismatchResult?.uncVariance || 0) === 0 ? (financeControl[isVi ? "vi" : "en"].match) : (financeControl[isVi ? "vi" : "en"].variance2)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                    <span>{financeControl[isVi ? "vi" : "en"].driveOCR}: {vnd(Number(mismatchResult?.uncDetail || 0))}</span>
                    <span>{financeControl[isVi ? "vi" : "en"].ceoDeclared2}: {vnd(Number(mismatchResult?.uncDeclared || 0))}</span>
                  </div>
                  {Number(mismatchResult?.uncVariance || 0) !== 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{financeControl[isVi ? "vi" : "en"].uncVariance3}</span>
                      <span className="font-semibold text-amber-700">{vnd(Math.abs(Number(mismatchResult?.uncVariance || 0)))}</span>
                    </div>
                  )}
                </div>
                <div className="rounded bg-background/70 p-2 space-y-1">
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">QTM</span>
                    <span className={getQtmClosingFromMismatch(mismatchResult) >= 0 ? "font-semibold text-green-700" : "font-semibold text-amber-700"}>
                      {getQtmClosingFromMismatch(mismatchResult) >= 0 ? (financeControl[isVi ? "vi" : "en"].match) : (financeControl[isVi ? "vi" : "en"].negativeBalance)}
                    </span>
                  </div>
                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <span>{financeControl[isVi ? "vi" : "en"].opening}: {vnd(Number(mismatchResult?.qtmOpening || 0))}</span>
                    <span>{financeControl[isVi ? "vi" : "en"].ceoQTMTopUp}: {vnd(Number(mismatchResult?.qtmDeclared || 0))}</span>
                    <span>{financeControl[isVi ? "vi" : "en"].folderSpend}: {vnd(Number(mismatchResult?.qtmSpent || 0))}</span>
                    <span>{financeControl[isVi ? "vi" : "en"].closing}: {vnd(getQtmClosingFromMismatch(mismatchResult))}</span>
                  </div>
                  {getQtmClosingFromMismatch(mismatchResult) < 0 && (
                    <div className="rounded border border-amber-200 bg-amber-100/70 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      {isVi
                        ? `UNC đang khớp; mismatch phát sinh do QTM âm quỹ ${vnd(Math.abs(getQtmClosingFromMismatch(mismatchResult)))}.`
                        : `UNC matches; mismatch is caused by negative QTM balance of ${vnd(Math.abs(getQtmClosingFromMismatch(mismatchResult)))}.`}
                    </div>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {financeControl[isVi ? "vi" : "en"].youCanCloseTheDayDespiteThe}
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
                <Button variant="outline" onClick={() => setCloseDialogOpen(false)}>{financeControl[isVi ? "vi" : "en"].cancel2}</Button>
                <Button variant="outline" size="sm" onClick={openCloseDialog} disabled={previewLoading}>
                  {financeControl[isVi ? "vi" : "en"].reScan}
                </Button>
                <Button
                  className="bg-green-600 hover:bg-green-700 text-white"
                  disabled={previewLoading || closeActing || (!!reconcileError && !canCloseWithoutBankSlips)}
                  onClick={executeClose}
                >
                  <Lock className="h-4 w-4 mr-2" />
                  {financeControl[isVi ? "vi" : "en"].execute}
                </Button>
              </div>
            )}
            {closeDialogStep === "running" && (
              <div className="text-xs text-muted-foreground">{financeControl[isVi ? "vi" : "en"].pleaseDonTCloseThisWindow}</div>
            )}
            {closeDialogStep === "mismatch" && (
              <div className="flex gap-2 w-full justify-end">
                <Button variant="outline" onClick={() => { setCloseDialogStep("preview"); setMismatchResult(null); setReconcileError(null); }}>
                  {financeControl[isVi ? "vi" : "en"].back}
                </Button>
                <Button
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                  disabled={closeActing}
                  onClick={handleConfirmMismatchClose}
                >
                  <Lock className="h-4 w-4 mr-2" />
                  {financeControl[isVi ? "vi" : "en"].closeDayWithVariance}
                </Button>
              </div>
            )}
            {closeDialogStep === "done" && (
              <Button onClick={() => setCloseDialogOpen(false)}>{financeControl[isVi ? "vi" : "en"].close}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
