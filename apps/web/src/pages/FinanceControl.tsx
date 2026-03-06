import { useEffect, useState } from "react";
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
  useDailyDeclaration,
  useDailyReconciliation,
  useMonthlyReconciliation,
  useUncDetailAmount,
} from "@/hooks/useFinanceReconciliation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLanguage } from "@/contexts/LanguageContext";
import { Lock, Unlock } from "lucide-react";

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
  const isVi = language === "vi";
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedMonth, setSelectedMonth] = useState<Date>(new Date());
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const [uncDialogOpen, setUncDialogOpen] = useState(false);
  const [uncStep, setUncStep] = useState<1 | 2 | 3>(1);
  const [uncSkipProcessed, setUncSkipProcessed] = useState(true);
  const [uncScanImagesOnly, setUncScanImagesOnly] = useState(true);
  const [uncLowConfidenceThreshold, setUncLowConfidenceThreshold] = useState(0.75);
  const [reconcilingFolderScan, setReconcilingFolderScan] = useState(false);
  const [reconcileProgress, setReconcileProgress] = useState({ done: 0, total: 0, currentFile: "" });
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

  const { data: dailyDeclaration, refetch: refetchDeclaration } = useDailyDeclaration(selectedDate);
  const { data: uncDetailAmount, refetch: refetchUncDetail } = useUncDetailAmount(selectedDate);
  const { data: dailyReconciliation, refetch: refetchDailyReconciliation } = useDailyReconciliation(selectedDate);
  const { data: monthlySummary, refetch: refetchMonthly } = useMonthlyReconciliation(selectedMonth);

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

    const qtmSaved = Array.isArray(dailyDeclaration?.extraction_meta?.qtm_images)
      ? dailyDeclaration.extraction_meta.qtm_images
      : (dailyDeclaration?.qtm_slip_image_base64 ? [dailyDeclaration.qtm_slip_image_base64] : []);
    const uncSaved = Array.isArray(dailyDeclaration?.extraction_meta?.unc_images)
      ? dailyDeclaration.extraction_meta.unc_images
      : (dailyDeclaration?.unc_slip_image_base64 ? [dailyDeclaration.unc_slip_image_base64] : []);

    setQtmSlipPreviews(qtmSaved.map((b64: string) => `data:image/jpeg;base64,${b64}`));
    setUncSlipPreviews(uncSaved.map((b64: string) => `data:image/jpeg;base64,${b64}`));

    // clear unsaved local state when data source changes (e.g. switch date)
    setPendingQtmImagesBase64([]);
    setPendingUncImagesBase64([]);
    setPendingQtmExtractedList([]);
    setPendingUncExtractedList([]);
  }, [dailyDeclaration]);

  const dateKey = format(selectedDate, "yyyy-MM-dd");

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
  }, [dateKey]);

  useEffect(() => {
    let active = true;

    const toNumberOrNull = (v: any) => {
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

    const loadPrevQtmBalance = async () => {
      const selectedDateKey = format(selectedDate, "yyyy-MM-dd");
      const prevDate = format(subDays(selectedDate, 1), "yyyy-MM-dd");

      // 1) Ưu tiên đúng ngày hôm trước.
      const { data: prevData } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select("closing_date,cash_fund_topup_amount,qtm_extracted_amount,extraction_meta")
        .eq("closing_date", prevDate)
        .maybeSingle();

      if (!active) return;

      const prevClosing = deriveClosingFromRow(prevData);
      if (prevClosing !== null) {
        setQtmOpeningBalance(prevClosing);
        return;
      }

      // 2) Nếu thiếu dữ liệu hôm trước, lấy ngày gần nhất trước ngày đang chọn.
      const { data: nearestPrevData } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select("closing_date,cash_fund_topup_amount,qtm_extracted_amount,extraction_meta")
        .lt("closing_date", selectedDateKey)
        .order("closing_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!active) return;

      const nearestPrevClosing = deriveClosingFromRow(nearestPrevData);
      if (nearestPrevClosing !== null) {
        setQtmOpeningBalance(nearestPrevClosing);
        return;
      }

      // 3) Fallback cuối: dùng opening đã lưu của ngày hiện tại (nếu có), không thì 0.
      const currentStoredOpening = toNumberOrNull(dailyDeclaration?.extraction_meta?.qtm_opening_balance);
      setQtmOpeningBalance(Number(currentStoredOpening || 0));
    };

    loadPrevQtmBalance();

    return () => {
      active = false;
    };
  }, [selectedDate, dailyDeclaration]);

  const expectedFolderFromDate = format(selectedDate, "ddMMyyyy");
  const autoDayFolderPath = format(selectedDate, "yyyy/MM/dd");

  const extractSlipAmountFromBase64 = async (imageBase64: string, mimeType: string, slipType: "qtm" | "unc") => {
    const { data: { session } } = await supabase.auth.getSession();

    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/finance-extract-slip-amount`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ imageBase64, mimeType, slipType }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error || "Failed extracting amount from slip image");
    }

    const result = await response.json();
    return result.data as { amount: number; confidence?: number; transfer_date?: string; reference?: string };
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
    setReconcileProgress({ done: 0, total: 0, currentFile: "" });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const folderUrl = await getUncRootFolderUrl();

      const scanOnce = async (subfolderDate: string) => {
        const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({ folderUrl, subfolderDate }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error || "Không thể scan folder UNC/QTM");
        }
        return await resp.json();
      };

      const uncPath = `${autoDayFolderPath}/UNC`;
      const qtmPath = `${autoDayFolderPath}/QTM`;

      const [uncScanData, qtmScanData] = await Promise.all([
        scanOnce(uncPath),
        scanOnce(qtmPath),
      ]);

      const uncRawFiles = Array.isArray(uncScanData?.files) ? uncScanData.files : [];
      const qtmRawFiles = Array.isArray(qtmScanData?.files) ? qtmScanData.files : [];

      const normalizeImageFiles = (rows: any[]) =>
        (rows || []).filter((f: any) => !uncScanImagesOnly || String(f?.mimeType || "").startsWith("image/"));

      let uncFiles = normalizeImageFiles(uncRawFiles);
      let qtmFiles = normalizeImageFiles(qtmRawFiles);

      // fallback legacy: some old days store UNC files directly under YYYY/MM/DD
      if (!uncFiles.length) {
        const dayScanData = await scanOnce(autoDayFolderPath);
        const dayFiles = normalizeImageFiles(Array.isArray(dayScanData?.files) ? dayScanData.files : []);
        const isQtmPath = (f: any) => {
          const haystack = `${String(f?.name || "")} ${String(f?.path || "")} ${String(f?.folderPath || "")} ${String(f?.parentPath || "")}`.toLowerCase();
          return /(^|\W)qtm($|\W)/i.test(haystack);
        };
        uncFiles = dayFiles.filter((f: any) => !isQtmPath(f));
        if (!qtmFiles.length) qtmFiles = dayFiles.filter((f: any) => isQtmPath(f));
      }

      const uncTotalScannedCount = uncFiles.length;
      const qtmTotalScannedCount = qtmFiles.length;

      let processedSet = new Set<string>();
      if (uncSkipProcessed) {
        const fileIds = [...uncFiles, ...qtmFiles].map((f: any) => f.id);
        if (fileIds.length) {
          const { data: processedRows } = await supabase
            .from("drive_file_index")
            .select("file_id")
            .eq("folder_type", "bank_slip")
            .eq("processed", true)
            .in("file_id", fileIds);
          processedSet = new Set((processedRows || []).map((r: any) => r.file_id));
        }
      }

      const processedSkippedCount = processedSet.size;
      const targetUncFiles = uncFiles.filter((f: any) => !processedSet.has(f.id));
      const targetQtmFiles = qtmFiles.filter((f: any) => !processedSet.has(f.id));

      if (!targetUncFiles.length && !targetQtmFiles.length) {
        throw new Error("Không còn file mới để đối soát trong UNC/QTM (đã xử lý hết)");
      }

      const totalTargets = targetUncFiles.length + targetQtmFiles.length;
      setReconcileProgress({ done: 0, total: totalTargets, currentFile: "" });

      const uncItems: Array<{ fileId: string; fileName: string; amount: number; confidence: number; status: "matched" | "mismatch" | "needs_review" }> = [];
      let progressDone = 0;

      for (let i = 0; i < targetUncFiles.length; i += 1) {
        const file = targetUncFiles[i];
        setReconcileProgress({ done: progressDone, total: totalTargets, currentFile: `[UNC] ${file.name || ""}` });
        const extracted = await extractSlipAmountFromBase64(file.base64, file.mimeType || "image/jpeg", "unc");
        const amount = Number(extracted?.amount || 0);
        const confidence = Number(extracted?.confidence || 0);
        uncItems.push({
          fileId: file.id,
          fileName: file.name,
          amount,
          confidence,
          status: confidence < uncLowConfidenceThreshold ? "needs_review" : "matched",
        });
        progressDone += 1;
      }

      let qtmTotal = 0;
      let qtmLowConfidence = 0;
      for (let i = 0; i < targetQtmFiles.length; i += 1) {
        const file = targetQtmFiles[i];
        setReconcileProgress({ done: progressDone, total: totalTargets, currentFile: `[QTM] ${file.name || ""}` });
        const extracted = await extractSlipAmountFromBase64(file.base64, file.mimeType || "image/jpeg", "qtm");
        const amount = Number(extracted?.amount || 0);
        const confidence = Number(extracted?.confidence || 0);
        qtmTotal += amount;
        if (confidence < uncLowConfidenceThreshold) qtmLowConfidence += 1;
        progressDone += 1;
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

      setUncStep(3);
    } catch (e: any) {
      toast({ title: isVi ? "Lỗi đối soát trong ngày" : "Daily reconciliation error", description: e?.message || "Không thể đối soát UNC/QTM theo ngày", variant: "destructive" });
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

      const scanResponse = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ folderUrl, subfolderDate: qtmPath }),
      });

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
        title: "Đã scan slip (chưa lưu)",
        description: `${slipType === "qtm" ? "QTM" : "UNC"}: +${vnd(batchSum)} (${batchResults.length} ảnh)`,
      });
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
      const existingQtmImages = Array.isArray(dailyDeclaration?.extraction_meta?.qtm_images)
        ? dailyDeclaration.extraction_meta.qtm_images
        : (dailyDeclaration?.qtm_slip_image_base64 ? [dailyDeclaration.qtm_slip_image_base64] : []);
      const existingUncImages = Array.isArray(dailyDeclaration?.extraction_meta?.unc_images)
        ? dailyDeclaration.extraction_meta.unc_images
        : (dailyDeclaration?.unc_slip_image_base64 ? [dailyDeclaration.unc_slip_image_base64] : []);
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
          ...(dailyDeclaration?.extraction_meta || {}),
          qtm_images: finalQtmImages,
          unc_images: finalUncImages,
          qtm_items: [
            ...((dailyDeclaration?.extraction_meta?.qtm_items as any[]) || []),
            ...pendingQtmExtractedList,
          ],
          unc_items: [
            ...((dailyDeclaration?.extraction_meta?.unc_items as any[]) || []),
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
      const uncDetail = Number((uncReconSummary?.folderTotal ?? persistedFolderTotal ?? dailyReconciliation?.unc_detail_amount ?? uncDetailAmount) || 0);
      const uncDeclared = Number((uncReconSummary?.ceoTotal ?? dailyReconciliation?.unc_declared_amount ?? uncTotalDeclared) || 0);
      const topup = Number(cashFundTopupAmount || 0);
      const tolerance = 0;
      const variance = uncDetail - uncDeclared;
      const status = Math.abs(variance) <= tolerance ? "match" : "mismatch";

      const { error } = await (supabase as any)
        .from("daily_reconciliations")
        .upsert({
          closing_date: dateKey,
          unc_detail_amount: uncDetail,
          unc_declared_amount: uncDeclared,
          cash_fund_topup_amount: topup,
          variance_amount: variance,
          status,
          tolerance_amount: tolerance,
          matched_at: new Date().toISOString(),
          notes: notes || null,
        }, { onConflict: "closing_date" });

      if (error) throw error;

      toast({
        title: status === "match" ? "Reconciled: MATCH" : "Reconciled: MISMATCH",
        description: `${isVi ? "Chênh lệch" : "Variance"}: ${vnd(variance)}`,
        variant: status === "match" ? "default" : "destructive",
      });

      await Promise.all([refetchDailyReconciliation(), refetchMonthly()]);
      return { status, variance };
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Reconciliation failed", variant: "destructive" });
      return null;
    } finally {
      setReconciling(false);
    }
  };

  const handleCloseAction = async (decision: "reject" | "conditional" | "approve") => {
    if (closeApprovalLocked && decision !== "approve") {
      toast({
        title: isVi ? "Đang khoá phê duyệt" : "Approval is locked",
        description: isVi ? "Vui lòng mở khoá trước khi đổi trạng thái chốt ngày." : "Please unlock before changing close status.",
      });
      return;
    }

    setCloseActing(true);
    try {
      setCloseDecision(decision);

      // Khi chốt ngày: luôn persist đầy đủ declaration trước, để tránh thiếu dữ liệu top-level.
      const declarationSaved = await saveDeclaration(true);
      if (!declarationSaved) {
        throw new Error(isVi ? "Không thể lưu khai báo CEO trước khi chốt" : "Failed to save CEO declaration before close");
      }

      await refetchUncDetail();
      await runReconcile();
      await saveReconciliationWorkflowMeta(decision, decision === "approve" ? true : closeApprovalLocked);
      toast({
        title: isVi ? "Đã cập nhật trạng thái chốt ngày" : "Daily close decision updated",
        description: decision === "reject"
          ? (isVi ? "Đã chuyển trạng thái: Không chốt" : "Status set to Reject close")
          : decision === "conditional"
            ? (isVi ? "Đã chuyển trạng thái: Chốt có điều kiện" : "Status set to Conditional close")
            : (isVi ? "Đã chuyển trạng thái: Phê duyệt chốt ngày" : "Status set to Approve close"),
      });
      await refetchDeclaration();
    } catch (e: any) {
      toast({ title: isVi ? "Lỗi" : "Error", description: e?.message || (isVi ? "Không thể cập nhật chốt ngày" : "Failed updating close decision"), variant: "destructive" });
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
      <div>
        <h1 className="text-3xl font-display font-bold">{isVi ? "Quản lý chi phí" : "Cost management"}</h1>
        <p className="text-muted-foreground">{isVi ? "Đối soát hằng ngày và hằng tháng cho UNC và quỹ tiền mặt." : "Daily & monthly reconciliation for UNC and cash fund top-up."}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{isVi ? "Chọn ngày/tháng" : "Choose date/month"}</CardTitle>
          <CardDescription>{isVi ? "Chọn ngày để làm việc theo ngày (có thể dùng mũi tên để qua lại) và chọn tháng để xem chốt tháng." : "Choose date for daily workflow (use arrows to move between days) and month for monthly closing."}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{isVi ? "Ngày" : "Date"}</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setSelectedDate((d) => subDays(d, 1))}
                aria-label={isVi ? "Ngày trước" : "Previous day"}
              >
                ←
              </Button>
              <Input
                type="date"
                value={toDateInputValue(selectedDate)}
                onChange={(e) => setSelectedDate(parseDateInputValue(e.target.value))}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setSelectedDate((d) => subDays(d, -1))}
                aria-label={isVi ? "Ngày sau" : "Next day"}
              >
                →
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{isVi ? "Tháng" : "Month"}</Label>
            <Input type="month" value={format(selectedMonth, "yyyy-MM")} onChange={(e) => setSelectedMonth(new Date(`${e.target.value}-01`))} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{isVi ? "CEO khai báo UNC" : "CEO UNC declared"}</div>
            <div className="text-xl font-semibold">{vnd(Number(uncTotalDeclared || 0))}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{isVi ? "CEO khai báo QTM" : "CEO QTM declared"}</div>
            <div className="text-xl font-semibold">{vnd(Number(cashFundTopupAmount || 0))}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{isVi ? "Tình trạng đối soát" : "Reconciliation status"}</div>
            <div className="text-xl font-semibold">
              {resolvedStatus === "match" && <Badge className="bg-green-600">MATCH</Badge>}
              {resolvedStatus === "mismatch" && <Badge variant="destructive">MISMATCH</Badge>}
              {!resolvedStatus && <Badge variant="secondary">{isVi ? "Chờ" : "Pending"}</Badge>}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{isVi ? "Tổng số tiền quỹ" : "Total cash fund"}</div>
            <div className="text-xl font-semibold">{vnd(Number(qtmClosingBalance || 0))}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="daily" className="space-y-4">
        <TabsList>
          <TabsTrigger value="daily">{isVi ? "Đối soát ngày" : "Daily Reconciliation"}</TabsTrigger>
          <TabsTrigger value="monthly">{isVi ? "Chốt tháng" : "Monthly Closing"}</TabsTrigger>
        </TabsList>

        <TabsContent value="daily" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Đối soát trong ngày" : "Daily reconciliation"}</CardTitle>
              <CardDescription>{isVi ? "Hệ thống tự quét theo ngày đã chọn cho cả 2 thư mục UNC và QTM (YYYY/MM/DD), ví dụ 06/03/2026 → 2026/03/06." : "System auto-scans both UNC and QTM by selected day path (YYYY/MM/DD), e.g. 06/03/2026 → 2026/03/06."}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={async () => {
                  setUncDialogOpen(true);
                  setUncStep(1);
                  setUncReconSummary(null);
                }}>
                  {isVi ? "Đối soát trong ngày" : "Run daily reconciliation"}
                </Button>
                <Badge variant="secondary">{isVi ? `Ngày đang chọn: ${expectedFolderFromDate} (scan: ${autoDayFolderPath}/UNC + ${autoDayFolderPath}/QTM)` : `Selected: ${expectedFolderFromDate} (scan: ${autoDayFolderPath}/UNC + ${autoDayFolderPath}/QTM)`}</Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Khai báo CEO (upload slip)" : "CEO Declaration (upload slips)"}</CardTitle>
              <CardDescription>{isVi ? "CEO upload slip theo 2 nguồn quỹ: NGÂN HÀNG và QTM. Hệ thống OCR tự cộng tổng khai báo theo ngày." : "CEO uploads slips by fund source: BANK and QTM. OCR auto-accumulates declared totals by day."}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{isVi ? "Slip QTM" : "QTM slips"}</Label>
                  <Input type="file" accept="image/*" multiple disabled={ceoDeclarationLocked} onChange={async (e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length) await processSlipUpload("qtm", files);
                    e.currentTarget.value = "";
                  }} />
                  {!!qtmSlipPreviews.length && (
                    <div className="grid grid-cols-2 gap-2">
                      {qtmSlipPreviews.map((src, idx) => (
                        <img key={`qtm-${idx}`} src={src} alt={`QTM slip ${idx + 1}`} className="max-h-40 rounded border object-contain" />
                      ))}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{isVi ? "Slip NGÂN HÀNG" : "BANK slips"}</Label>
                  <Input type="file" accept="image/*" multiple disabled={ceoDeclarationLocked} onChange={async (e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length) await processSlipUpload("unc", files);
                    e.currentTarget.value = "";
                  }} />
                  {!!uncSlipPreviews.length && (
                    <div className="grid grid-cols-2 gap-2">
                      {uncSlipPreviews.map((src, idx) => (
                        <img key={`unc-${idx}`} src={src} alt={`UNC slip ${idx + 1}`} className="max-h-40 rounded border object-contain" />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {extracting && <div className="text-sm text-muted-foreground">{isVi ? "Đang scan slip và cập nhật số tiền..." : "Scanning slips and updating amount..."}</div>}
              {(pendingQtmImagesBase64.length > 0 || pendingUncImagesBase64.length > 0) && (
                <div className="text-sm text-amber-600">
                  {isVi
                    ? `Có dữ liệu slip mới chưa lưu (QTM +${pendingQtmImagesBase64.length}, BANK +${pendingUncImagesBase64.length}). Vui lòng bấm Lưu khai báo để lưu vào DB.`
                    : `There are unsaved slip data (QTM +${pendingQtmImagesBase64.length}, BANK +${pendingUncImagesBase64.length}). Please click Save Declaration to persist to DB.`}
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "CEO khai báo NGÂN HÀNG" : "CEO BANK declared"}</div><div className="text-xl font-semibold">{vnd(Number(uncTotalDeclared || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "CEO khai báo QTM" : "CEO QTM declared"}</div><div className="text-xl font-semibold">{vnd(Number(cashFundTopupAmount || 0))}</div></CardContent></Card>
              </div>

              {ceoDeclarationLocked && (
                <div className="text-sm text-green-700">{isVi ? "Khai báo CEO đã khoá cho ngày này. Mở khoá để chỉnh sửa thêm." : "CEO declaration is locked for this day. Unlock to edit."}</div>
              )}

              <div className="flex gap-2">
                <Button onClick={saveDeclaration} disabled={saving || ceoDeclarationLocked}>{saving ? (isVi ? "Đang lưu..." : "Saving...") : (isVi ? "Lưu khai báo CEO" : "Save CEO Declaration")}</Button>
                <Button variant="outline" onClick={() => setCeoDeclarationLocked((v) => !v)}>
                  {ceoDeclarationLocked ? (isVi ? "Mở khoá khai báo" : "Unlock declaration") : (isVi ? "Khoá khai báo ngày" : "Lock declaration")}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Kiểm soát quỹ tiền mặt (QTM)" : "Cash fund control (QTM)"}</CardTitle>
              <CardDescription>{isVi ? "QTM cuối ngày = (CEO gửi quỹ + tồn đầu ngày) - tổng chi từ thư mục QTM" : "End-of-day QTM = (CEO top-up + opening balance) - spent from QTM folder"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{isVi ? "Tồn quỹ đầu ngày" : "Opening balance"}</Label>
                  <Input type="number" value={qtmOpeningBalance} onChange={(e) => setQtmOpeningBalance(Number(e.target.value || 0))} />
                </div>
                <div className="space-y-2">
                  <Label>{isVi ? "Chi tiền mặt từ folder QTM" : "Spent from QTM folder"}</Label>
                  <Input value={vnd(qtmSpentFromFolder)} readOnly />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tồn đầu ngày" : "Opening"}</div><div className="text-lg font-semibold">{vnd(qtmOpeningBalance)}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "CEO gửi quỹ" : "CEO top-up"}</div><div className="text-lg font-semibold">{vnd(Number(cashFundTopupAmount || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tổng chi QTM" : "QTM spent"}</div><div className="text-lg font-semibold">{vnd(qtmSpentFromFolder)}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Số dư QTM" : "QTM balance"}</div><div className="text-lg font-semibold">{vnd(qtmClosingBalance)}</div></CardContent></Card>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                {qtmNegative ? <Badge variant="destructive">{isVi ? "Cảnh báo âm quỹ" : "Negative balance"}</Badge> : <Badge className="bg-green-600">{isVi ? "Quỹ dương" : "Positive balance"}</Badge>}
                {qtmLowConfidenceCount > 0 && <Badge variant="secondary">{isVi ? `Thiếu chứng từ/độ tin cậy thấp: ${qtmLowConfidenceCount}` : `Low-confidence receipts: ${qtmLowConfidenceCount}`}</Badge>}
                <Badge variant="outline">{isVi ? `Path quét: ${autoDayFolderPath}/QTM` : `Scan path: ${autoDayFolderPath}/QTM`}</Badge>
              </div>

              <div className="text-xs text-muted-foreground">
                {isVi ? "QTM được quét tự động khi bấm nút ‘Đối soát trong ngày’ ở phía trên." : "QTM is scanned automatically when running 'Daily reconciliation' above."}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Chốt ngày (theo đối soát folder UNC)" : "Daily Closing (from UNC folder reconciliation)"}</CardTitle>
              <CardDescription>{isVi ? "Dùng kết quả từ nút ‘Đối soát UNC theo folder’ để chốt số UNC trong ngày với khai báo CEO." : "Use the result from 'UNC folder reconciliation' to close daily UNC against CEO declared total."}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{isVi ? "UNC từ folder đã đối soát" : "UNC from reconciled folder"}</Label>
                  <Input value={vnd(resolvedUncDetail)} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <div className="h-10 px-3 rounded-md border flex items-center">
                    {resolvedStatus === "match" && <Badge className="bg-green-600">MATCH</Badge>}
                    {resolvedStatus === "mismatch" && <Badge variant="destructive">MISMATCH</Badge>}
                    {!resolvedStatus && <span className="text-muted-foreground">{isVi ? "Chờ" : "Pending"}</span>}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{isVi ? "Tổng UNC CEO khai báo" : "CEO UNC Total Declared"}</Label>
                  <Input value={vnd(resolvedUncDeclared)} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>{isVi ? "Số tiền bù quỹ tiền mặt" : "Cash Fund Top-up Amount"}</Label>
                  <Input value={vnd(Number(cashFundTopupAmount || 0))} readOnly />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{isVi ? "Ghi chú" : "Notes"}</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={isVi ? "Ghi chú (tuỳ chọn)" : "Optional note"} />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "UNC theo folder" : "UNC by folder"}</div><div className="text-xl font-semibold">{vnd(resolvedUncDetail)}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "UNC khai báo" : "UNC Declared"}</div><div className="text-xl font-semibold">{vnd(resolvedUncDeclared)}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Chênh lệch" : "Variance"}</div><div className="text-xl font-semibold">{vnd(resolvedVariance)}</div></CardContent></Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{isVi ? "Kết luận chốt ngày" : "Daily closing decision"}</CardTitle>
                  <CardDescription>{isVi ? "Chọn một trong 3 trạng thái: Không chốt / Chốt có điều kiện / Phê duyệt chốt ngày." : "Pick one of 3 statuses: Reject / Conditional / Approve close."}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-3 md:grid-cols-3">
                    <button
                      type="button"
                      disabled={closeActing || reconciling || (!uncReconSummary && !dailyReconciliation) || closeApprovalLocked}
                      className={`rounded-xl border px-4 py-3 text-sm text-left font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_3px_0_rgba(0,0,0,0.12)] hover:-translate-y-0.5 hover:shadow-[0_6px_14px_rgba(0,0,0,0.18)] active:translate-y-0 active:shadow-[0_2px_0_rgba(0,0,0,0.12)] ${closeDecision === "reject" ? "border-red-500 bg-gradient-to-b from-red-500/25 to-red-600/20 text-red-800 dark:text-red-100" : "border-red-300/70 bg-red-500/10 text-red-700 dark:text-red-200"}`}
                      onClick={() => handleCloseAction("reject")}
                    >
                      {isVi ? "❌ Không chốt" : "❌ Reject close"}
                    </button>
                    <button
                      type="button"
                      disabled={closeActing || reconciling || (!uncReconSummary && !dailyReconciliation) || closeApprovalLocked}
                      className={`rounded-xl border px-4 py-3 text-sm text-left font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_3px_0_rgba(0,0,0,0.12)] hover:-translate-y-0.5 hover:shadow-[0_6px_14px_rgba(0,0,0,0.18)] active:translate-y-0 active:shadow-[0_2px_0_rgba(0,0,0,0.12)] ${closeDecision === "conditional" ? "border-amber-500 bg-gradient-to-b from-amber-400/30 to-amber-500/25 text-amber-900 dark:text-amber-100" : "border-amber-300/70 bg-amber-500/10 text-amber-800 dark:text-amber-200"}`}
                      onClick={() => handleCloseAction("conditional")}
                    >
                      {isVi ? "⚠️ Chốt có điều kiện" : "⚠️ Conditional close"}
                    </button>
                    <button
                      type="button"
                      disabled={closeActing || reconciling || (!uncReconSummary && !dailyReconciliation)}
                      className={`rounded-xl border px-4 py-3 text-sm text-left font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_3px_0_rgba(0,0,0,0.12)] hover:-translate-y-0.5 hover:shadow-[0_6px_14px_rgba(0,0,0,0.18)] active:translate-y-0 active:shadow-[0_2px_0_rgba(0,0,0,0.12)] ${closeDecision === "approve" ? "border-green-500 bg-gradient-to-b from-green-500/25 to-green-600/20 text-green-800 dark:text-green-100" : "border-green-300/70 bg-green-500/10 text-green-700 dark:text-green-200"}`}
                      onClick={() => handleCloseAction("approve")}
                    >
                      <span className="inline-flex items-center gap-2">
                        {closeDecision === "approve" && closeApprovalLocked && <Lock className="h-4 w-4" />}
                        {closeDecision === "approve" && closeApprovalLocked
                          ? (isVi ? "✅ Đã phê duyệt" : "✅ Approved")
                          : (isVi ? "✅ Phê duyệt chốt ngày" : "✅ Approve close")}
                      </span>
                    </button>
                  </div>

                  {closeDecision === "approve" && closeApprovalLocked && (
                    <div className="flex justify-end">
                      <Button type="button" variant="outline" size="sm" onClick={handleUnlockApproval} disabled={closeActing}>
                        <Unlock className="h-4 w-4 mr-2" />
                        {isVi ? "Mở khoá phê duyệt" : "Unlock approval"}
                      </Button>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label>{isVi ? "Giải trình / lý do" : "Explanation / reason"}</Label>
                    <Input value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder={isVi ? "Nhập lý do cho quyết định chốt ngày" : "Enter reason for close decision"} />
                  </div>
                </CardContent>
              </Card>

              {!uncReconSummary && !dailyReconciliation && (
                <div className="text-xs text-amber-600">
                  {isVi ? "Chưa có dữ liệu đối soát cho ngày này. Hãy bấm ‘Đối soát trong ngày’ trước khi chốt." : "No reconciliation data for this date yet. Please run 'Daily reconciliation' first."}
                </div>
              )}


              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{isVi ? "Nhật ký kiểm toán" : "Audit log"}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {!reconciliationAuditLogs.length && <div className="text-muted-foreground">{isVi ? "Chưa có bản ghi" : "No records yet"}</div>}
                  {reconciliationAuditLogs.slice().reverse().slice(0, 8).map((log, idx) => (
                    <div key={`${log.at}-${idx}`} className="rounded border px-3 py-2">
                      <div className="font-medium">{new Date(log.at).toLocaleString("vi-VN")} • {log.actor}</div>
                      <div className="text-muted-foreground">{log.action}{log.detail ? ` — ${log.detail}` : ""}</div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="monthly" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Chốt tháng" : "Monthly Closing"}</CardTitle>
              <CardDescription>{isVi ? "Tổng hợp kết quả đối soát theo ngày" : "Aggregate daily reconciliation results"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-3">
                <Button variant="outline" onClick={() => refetchMonthly()}>{isVi ? "Làm mới" : "Refresh"}</Button>
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Total {isVi ? "UNC chi tiết" : "UNC Detail"}</div><div className="text-xl font-semibold">{vnd(Number(monthlySummary?.totalUncDetail || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Total {isVi ? "UNC khai báo" : "UNC Declared"}</div><div className="text-xl font-semibold">{vnd(Number(monthlySummary?.totalUncDeclared || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Chênh lệch ròng" : "Net variance"}</div><div className="text-xl font-semibold">{vnd(Number(monthlySummary?.netVariance || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Tỷ lệ khớp" : "Match Rate"}</div><div className="text-xl font-semibold">{monthlySummary?.totalDays ? `${monthlySummary.matchDays}/${monthlySummary.totalDays}` : "0/0"}</div></CardContent></Card>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isVi ? "Ngày" : "Date"}</TableHead>
                    <TableHead className="text-right">{isVi ? "UNC chi tiết" : "UNC Detail"}</TableHead>
                    <TableHead className="text-right">{isVi ? "UNC khai báo" : "UNC Declared"}</TableHead>
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
                      <TableCell>{r.status === "match" ? <Badge className="bg-green-600">MATCH</Badge> : r.status === "mismatch" ? <Badge variant="destructive">MISMATCH</Badge> : <Badge variant="secondary">PENDING</Badge>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {!monthlySummary?.rows?.length && (
                <div className="text-sm text-muted-foreground">{isVi ? "Không có dữ liệu đối soát trong tháng" : "No reconciliation data in this month"} ({format(startOfMonth(selectedMonth), "MM/yyyy")} - {format(endOfMonth(selectedMonth), "MM/yyyy")}).</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={uncDialogOpen} onOpenChange={setUncDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isVi ? `Đối soát trong ngày (Bước ${uncStep}/3)` : `Daily reconciliation (Step ${uncStep}/3)`}</DialogTitle>
            <DialogDescription>
              {isVi ? "Tự động quét cả UNC + QTM theo ngày đã chọn, sau đó đối soát với khai báo CEO." : "Automatically scan UNC + QTM by selected date, then reconcile with CEO declaration."}
            </DialogDescription>
          </DialogHeader>

          {uncStep === 1 && (
            <div className="space-y-3">
              <Label>{isVi ? "Đường dẫn quét tự động theo ngày" : "Auto scan path by selected date"}</Label>
              <div className="rounded border p-3 text-sm space-y-1">
                <div>{isVi ? "Ngày đang chọn" : "Selected date"}: <Badge variant="secondary">{format(selectedDate, "dd/MM/yyyy")}</Badge></div>
                <div>{isVi ? "Đường dẫn UNC" : "UNC path"}: <code>{autoDayFolderPath}/UNC</code></div>
                <div>{isVi ? "Đường dẫn QTM" : "QTM path"}: <code>{autoDayFolderPath}/QTM</code></div>
              </div>
              <div className="text-xs text-muted-foreground">
                {isVi
                  ? "Không cần chọn thủ công thư mục. Hệ thống sẽ tự đi theo YYYY/MM/DD từ ngày phía trên."
                  : "No manual folder selection required. System follows YYYY/MM/DD from the selected date above."}
              </div>
            </div>
          )}

          {uncStep === 2 && (
            <div className="space-y-4">
              <div className="text-sm">{isVi ? "Folder sẽ quét:" : "Folders to scan:"} <Badge variant="secondary">{autoDayFolderPath}/UNC</Badge> <Badge variant="secondary">{autoDayFolderPath}/QTM</Badge></div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={uncSkipProcessed} onChange={(e) => setUncSkipProcessed(e.target.checked)} />
                {isVi ? "Bỏ qua file đã xử lý trước đó" : "Skip previously processed files"}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={uncScanImagesOnly} onChange={(e) => setUncScanImagesOnly(e.target.checked)} />
                {isVi ? "Chỉ lấy file ảnh" : "Only include image files"}
              </label>

              <div className="space-y-2">
                <Label>{isVi ? "Ngưỡng confidence cần xác nhận" : "Low-confidence review threshold"}</Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={uncLowConfidenceThreshold}
                  onChange={(e) => setUncLowConfidenceThreshold(Math.max(0, Math.min(1, Number(e.target.value || 0))))}
                />
              </div>
              {reconcilingFolderScan && (
                <div className="rounded border p-3 text-sm">
                  <div>{isVi ? "Tiến độ" : "Progress"}: {reconcileProgress.done}/{reconcileProgress.total}</div>
                  <div className="text-muted-foreground">{reconcileProgress.currentFile}</div>
                </div>
              )}
            </div>
          )}

          {uncStep === 3 && uncReconSummary && (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Folder UNC</div><div className="font-semibold">{vnd(uncReconSummary.folderTotal)}</div></CardContent></Card>
                <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">CEO UNC</div><div className="font-semibold">{vnd(uncReconSummary.ceoTotal)}</div></CardContent></Card>
                <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">{isVi ? "Chênh lệch" : "Delta"}</div><div className="font-semibold">{vnd(uncReconSummary.delta)}</div></CardContent></Card>
                <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Status</div>{uncReconSummary.status === "match" ? <Badge className="bg-green-600">SUCCESS</Badge> : <Badge variant="destructive">MISMATCH</Badge>}</CardContent></Card>
              </div>
              <div className="text-xs text-amber-600">{isVi ? `File confidence thấp cần xác nhận: ${uncReconSummary.lowConfidenceCount}` : `Low confidence files: ${uncReconSummary.lowConfidenceCount}`}</div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{isVi ? "Ngoại lệ & loại trừ" : "Exceptions & exclusions"}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm md:grid-cols-3">
                  <div>{isVi ? "Tổng file scan" : "Total scanned"}: <span className="font-semibold">{uncReconSummary.totalScannedCount}</span></div>
                  <div>{isVi ? "Đã loại trừ QTM" : "QTM excluded"}: <span className="font-semibold">{uncReconSummary.qtmExcludedCount}</span></div>
                  <div>{isVi ? "Bỏ qua do đã xử lý" : "Skipped as processed"}: <span className="font-semibold">{uncReconSummary.processedSkippedCount}</span></div>
                </CardContent>
              </Card>

              <div className="max-h-64 overflow-auto rounded border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Confidence</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {uncReconSummary.items.map((item) => (
                      <TableRow key={item.fileId}>
                        <TableCell>{item.fileName}</TableCell>
                        <TableCell className="text-right">{vnd(item.amount)}</TableCell>
                        <TableCell className="text-right">{item.confidence.toFixed(2)}</TableCell>
                        <TableCell>
                          {item.status === "needs_review" ? <Badge variant="secondary">{isVi ? "Cần xác nhận" : "Needs review"}</Badge> : item.status === "matched" ? <Badge className="bg-green-600">Matched</Badge> : <Badge variant="destructive">Mismatch</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          <DialogFooter>
            {uncStep > 1 && uncStep < 3 && (
              <Button variant="outline" onClick={() => setUncStep((s) => (s === 2 ? 1 : s))}>{isVi ? "Quay lại" : "Back"}</Button>
            )}
            {uncStep === 1 && (
              <Button onClick={() => setUncStep(2)}>{isVi ? "Tiếp tục" : "Continue"}</Button>
            )}
            {uncStep === 2 && (
              <Button onClick={runFolderReconciliation} disabled={reconcilingFolderScan}>{reconcilingFolderScan ? (isVi ? "Đang đối soát..." : "Reconciling...") : (isVi ? "Quét & Đối soát" : "Scan & Reconcile")}</Button>
            )}
            {uncStep === 3 && (
              <Button onClick={() => setUncDialogOpen(false)}>{isVi ? "Đóng" : "Close"}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
