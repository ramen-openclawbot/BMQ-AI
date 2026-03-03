import { useEffect, useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
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

const vnd = (value: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value || 0);

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
  const [loadingUncFolders, setLoadingUncFolders] = useState(false);
  const [uncFolderQuery, setUncFolderQuery] = useState("");
  const [availableUncFolders, setAvailableUncFolders] = useState<Array<{ date: string; fileCount: number; folderId: string }>>([]);
  const [selectedUncFolder, setSelectedUncFolder] = useState<string>("");
  const [uncSkipProcessed, setUncSkipProcessed] = useState(true);
  const [uncScanImagesOnly, setUncScanImagesOnly] = useState(true);
  const [uncLowConfidenceThreshold, setUncLowConfidenceThreshold] = useState(0.75);
  const [reconcilingFolderScan, setReconcilingFolderScan] = useState(false);
  const [reconcileProgress, setReconcileProgress] = useState({ done: 0, total: 0, currentFile: "" });
  const [uncReconSummary, setUncReconSummary] = useState<{
    folderDate: string;
    folderTotal: number;
    ceoTotal: number;
    delta: number;
    status: "match" | "mismatch";
    lowConfidenceCount: number;
    items: Array<{ fileId: string; fileName: string; amount: number; confidence: number; status: "matched" | "mismatch" | "needs_review" }>;
  } | null>(null);

  const { data: dailyDeclaration, refetch: refetchDeclaration } = useDailyDeclaration(selectedDate);
  const { data: uncDetailAmount, refetch: refetchUncDetail } = useUncDetailAmount(selectedDate);
  const { data: dailyReconciliation, refetch: refetchDailyReconciliation } = useDailyReconciliation(selectedDate);
  const { data: monthlySummary, refetch: refetchMonthly } = useMonthlyReconciliation(selectedMonth);

  const [uncTotalDeclared, setUncTotalDeclared] = useState<number>(0);
  const [cashFundTopupAmount, setCashFundTopupAmount] = useState<number>(0);
  const [notes, setNotes] = useState("");

  const [qtmSlipPreviews, setQtmSlipPreviews] = useState<string[]>([]);
  const [uncSlipPreviews, setUncSlipPreviews] = useState<string[]>([]);
  const [pendingQtmImagesBase64, setPendingQtmImagesBase64] = useState<string[]>([]);
  const [pendingUncImagesBase64, setPendingUncImagesBase64] = useState<string[]>([]);
  const [pendingQtmExtractedList, setPendingQtmExtractedList] = useState<any[]>([]);
  const [pendingUncExtractedList, setPendingUncExtractedList] = useState<any[]>([]);

  useEffect(() => {
    setUncTotalDeclared(Number(dailyDeclaration?.unc_extracted_amount || dailyDeclaration?.unc_total_declared || 0));
    setCashFundTopupAmount(Number(dailyDeclaration?.qtm_extracted_amount || dailyDeclaration?.cash_fund_topup_amount || 0));
    setNotes(String(dailyDeclaration?.notes || ""));

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

  useEffect(() => {
    // Prevent stale slip previews when switching date while query is refetching
    setQtmSlipPreviews([]);
    setUncSlipPreviews([]);
    setPendingQtmImagesBase64([]);
    setPendingUncImagesBase64([]);
    setPendingQtmExtractedList([]);
    setPendingUncExtractedList([]);
  }, [dateKey]);

  const expectedFolderFromDate = format(selectedDate, "ddMMyyyy");

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

  const loadUncFolders = async () => {
    setLoadingUncFolders(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const folderUrl = await getUncRootFolderUrl();

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ folderUrl, mode: "list_all_dates" }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error || "Không thể tải danh sách folder UNC");
      }

      const data = await response.json();
      setAvailableUncFolders(Array.isArray(data?.dates) ? data.dates : []);
      setSelectedUncFolder((Array.isArray(data?.dates) ? data.dates.find((d: any) => d.date === expectedFolderFromDate)?.date : "") || "");
    } catch (e: any) {
      toast({ title: "Lỗi tải folder UNC", description: e?.message || "Không thể tải danh sách folder", variant: "destructive" });
    } finally {
      setLoadingUncFolders(false);
    }
  };

  const runFolderReconciliation = async () => {
    if (!selectedUncFolder) {
      toast({ title: "Thiếu folder", description: "Vui lòng chọn folder UNC cần đối soát", variant: "destructive" });
      return;
    }

    setReconcilingFolderScan(true);
    setReconcileProgress({ done: 0, total: 0, currentFile: "" });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const folderUrl = await getUncRootFolderUrl();

      const scanResponse = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ folderUrl, subfolderDate: selectedUncFolder }),
      });

      if (!scanResponse.ok) {
        const err = await scanResponse.json().catch(() => ({}));
        throw new Error(err?.error || "Không thể scan folder UNC");
      }

      const scanData = await scanResponse.json();
      let files = Array.isArray(scanData?.files) ? scanData.files : [];
      if (uncScanImagesOnly) {
        files = files.filter((f: any) => String(f?.mimeType || "").startsWith("image/"));
      }

      if (!files.length) throw new Error("Folder không có file ảnh để đối soát");

      let processedSet = new Set<string>();
      if (uncSkipProcessed) {
        const fileIds = files.map((f: any) => f.id);
        const { data: processedRows } = await supabase
          .from("drive_file_index")
          .select("file_id")
          .eq("folder_type", "bank_slip")
          .eq("processed", true)
          .in("file_id", fileIds);
        processedSet = new Set((processedRows || []).map((r: any) => r.file_id));
      }

      const targetFiles = files.filter((f: any) => !processedSet.has(f.id));
      if (!targetFiles.length) throw new Error("Không còn file mới để đối soát (đã xử lý hết)");

      setReconcileProgress({ done: 0, total: targetFiles.length, currentFile: "" });

      const items: Array<{ fileId: string; fileName: string; amount: number; confidence: number; status: "matched" | "mismatch" | "needs_review" }> = [];
      for (let i = 0; i < targetFiles.length; i += 1) {
        const file = targetFiles[i];
        setReconcileProgress({ done: i, total: targetFiles.length, currentFile: file.name || "" });
        const extracted = await extractSlipAmountFromBase64(file.base64, file.mimeType || "image/jpeg", "unc");
        const amount = Number(extracted?.amount || 0);
        const confidence = Number(extracted?.confidence || 0);
        items.push({
          fileId: file.id,
          fileName: file.name,
          amount,
          confidence,
          status: confidence < uncLowConfidenceThreshold ? "needs_review" : "matched",
        });
      }

      const folderTotal = items.reduce((sum, x) => sum + x.amount, 0);
      const ceoTotal = Number(uncTotalDeclared || 0);
      const delta = folderTotal - ceoTotal;
      const status: "match" | "mismatch" = delta === 0 ? "match" : "mismatch";
      const lowConfidenceCount = items.filter((x) => x.status === "needs_review").length;

      const finalItems = items.map((x) => {
        if (x.status === "needs_review") return x;
        // Item-level mismatch cannot be inferred from total-level delta.
        // Keep per-file status as matched when OCR is confident.
        return { ...x, status: "matched" as const };
      });

      setReconcileProgress({ done: targetFiles.length, total: targetFiles.length, currentFile: "" });
      setUncReconSummary({
        folderDate: selectedUncFolder,
        folderTotal,
        ceoTotal,
        delta,
        status,
        lowConfidenceCount,
        items: finalItems,
      });
      setUncStep(3);
    } catch (e: any) {
      toast({ title: "Lỗi đối soát UNC", description: e?.message || "Không thể đối soát folder UNC", variant: "destructive" });
    } finally {
      setReconcilingFolderScan(false);
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

  const saveDeclaration = async () => {
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
        },
        notes: notes || null,
      };

      const { error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .upsert(payload, { onConflict: "closing_date" });

      if (error) throw error;
      toast({ title: "Saved", description: "CEO daily declaration has been updated." });
      setPendingQtmImagesBase64([]);
      setPendingUncImagesBase64([]);
      setPendingQtmExtractedList([]);
      setPendingUncExtractedList([]);
      await refetchDeclaration();
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Failed to save declaration", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const runReconcile = async () => {
    setReconciling(true);
    try {
      const uncDetail = Number((uncReconSummary?.folderTotal ?? uncDetailAmount) || 0);
      const uncDeclared = Number(uncTotalDeclared || 0);
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
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Reconciliation failed", variant: "destructive" });
    } finally {
      setReconciling(false);
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
          <CardTitle>{isVi ? "Bộ lọc thời gian" : "Time filters"}</CardTitle>
          <CardDescription>{isVi ? "Chọn ngày để làm việc theo ngày và chọn tháng để xem chốt tháng." : "Pick date for daily workflow and month for monthly closing."}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{isVi ? "Ngày" : "Date"}</Label>
            <Input type="date" value={dateKey} onChange={(e) => setSelectedDate(new Date(e.target.value))} />
          </div>
          <div className="space-y-2">
            <Label>{isVi ? "Tháng" : "Month"}</Label>
            <Input type="month" value={format(selectedMonth, "yyyy-MM")} onChange={(e) => setSelectedMonth(new Date(`${e.target.value}-01`))} />
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="daily" className="space-y-4">
        <TabsList>
          <TabsTrigger value="daily">{isVi ? "Đối soát ngày" : "Daily Reconciliation"}</TabsTrigger>
          <TabsTrigger value="monthly">{isVi ? "Chốt tháng" : "Monthly Closing"}</TabsTrigger>
        </TabsList>

        <TabsContent value="daily" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Đối soát UNC theo folder" : "UNC Reconciliation by folder"}</CardTitle>
              <CardDescription>{isVi ? "Chọn folder UNC theo ngày (ddmmyyyy), scan toàn bộ ảnh bank slip và đối soát với tổng UNC CEO đã khai báo." : "Pick UNC date folder (ddmmyyyy), scan all bank slip images, and reconcile with CEO UNC declared total."}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={async () => {
                  setUncDialogOpen(true);
                  setUncStep(1);
                  setUncReconSummary(null);
                  await loadUncFolders();
                }}>
                  {isVi ? "Đối soát UNC theo folder" : "Reconcile UNC folder"}
                </Button>
                <Badge variant="secondary">{isVi ? `Ngày đang chọn: ${expectedFolderFromDate}` : `Expected folder: ${expectedFolderFromDate}`}</Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Tải slip CEO (tự động trích xuất)" : "CEO Slip Upload (Auto Extract)"}</CardTitle>
              <CardDescription>{isVi ? "Cho phép tải nhiều ảnh slip trong ngày cho từng loại (QTM/UNC). Hệ thống tự quét số tiền từng ảnh, cộng dồn và lưu vào DB." : "Allow multiple slip images per day for each type (QTM / UNC). System auto scans each image, accumulates amount, and stores all images in DB."}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>QTM Slip</Label>
                  <Input type="file" accept="image/*" multiple onChange={async (e) => {
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
                  <Label>UNC Slip</Label>
                  <Input type="file" accept="image/*" multiple onChange={async (e) => {
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
                    ? `Có dữ liệu slip mới chưa lưu (QTM +${pendingQtmImagesBase64.length}, UNC +${pendingUncImagesBase64.length}). Vui lòng bấm Lưu khai báo để lưu vào DB.`
                    : `There are unsaved slip data (QTM +${pendingQtmImagesBase64.length}, UNC +${pendingUncImagesBase64.length}). Please click Save Declaration to persist to DB.`}
                </div>
              )}
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
                  <Input value={vnd(Number((uncReconSummary?.folderTotal ?? uncDetailAmount) || 0))} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <div className="h-10 px-3 rounded-md border flex items-center">
                    {(uncReconSummary?.status || dailyReconciliation?.status) === "match" && <Badge className="bg-green-600">MATCH</Badge>}
                    {(uncReconSummary?.status || dailyReconciliation?.status) === "mismatch" && <Badge variant="destructive">MISMATCH</Badge>}
                    {!(uncReconSummary?.status || dailyReconciliation?.status) && <span className="text-muted-foreground">{isVi ? "Chờ" : "Pending"}</span>}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{isVi ? "Tổng UNC CEO khai báo" : "CEO UNC Total Declared"}</Label>
                  <Input value={vnd(Number(uncTotalDeclared || 0))} readOnly />
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
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "UNC theo folder" : "UNC by folder"}</div><div className="text-xl font-semibold">{vnd(Number((uncReconSummary?.folderTotal ?? uncDetailAmount) || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "UNC khai báo" : "UNC Declared"}</div><div className="text-xl font-semibold">{vnd(Number(uncTotalDeclared || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Chênh lệch" : "Variance"}</div><div className="text-xl font-semibold">{vnd(Number(((uncReconSummary?.folderTotal ?? uncDetailAmount) || 0) - (uncTotalDeclared || 0)))}</div></CardContent></Card>
              </div>

              {!uncReconSummary && (
                <div className="text-xs text-amber-600">
                  {isVi ? "Chưa có dữ liệu đối soát folder trong phiên này. Hãy bấm ‘Đối soát UNC theo folder’ phía trên trước khi chốt." : "No folder reconciliation result in this session yet. Please run 'UNC folder reconciliation' first."}
                </div>
              )}

              <div className="flex gap-2">
                <Button onClick={saveDeclaration} disabled={saving}>{saving ? (isVi ? "Đang lưu..." : "Saving...") : (isVi ? "Lưu khai báo" : "Save Declaration")}</Button>
                <Button variant="outline" onClick={async () => { await refetchUncDetail(); await runReconcile(); }} disabled={reconciling || !uncReconSummary}>
                  {reconciling ? (isVi ? "Đang đối soát..." : "Reconciling...") : (isVi ? "Chốt theo kết quả folder" : "Close with folder result")}
                </Button>
              </div>
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
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{isVi ? `Đối soát UNC theo folder (Bước ${uncStep}/3)` : `UNC folder reconciliation (Step ${uncStep}/3)`}</DialogTitle>
            <DialogDescription>
              {isVi ? "Chọn folder UNC, cấu hình scan, rồi chạy đối soát với tổng khai báo CEO." : "Select UNC folder, configure scan options, then reconcile with CEO declared total."}
            </DialogDescription>
          </DialogHeader>

          {uncStep === 1 && (
            <div className="space-y-3">
              <Label>{isVi ? "Chọn folder UNC" : "Select UNC folder"}</Label>
              <Input
                placeholder={isVi ? "Tìm folder..." : "Search folder..."}
                value={uncFolderQuery}
                onChange={(e) => setUncFolderQuery(e.target.value)}
              />
              <div className="max-h-72 overflow-auto rounded border">
                {loadingUncFolders ? (
                  <div className="p-3 text-sm text-muted-foreground">{isVi ? "Đang tải danh sách folder..." : "Loading folders..."}</div>
                ) : availableUncFolders
                  .filter((f) => !uncFolderQuery.trim() || f.date.toLowerCase().includes(uncFolderQuery.toLowerCase()))
                  .map((folder) => (
                    <button
                      key={folder.folderId}
                      className={`flex w-full items-center justify-between border-b px-3 py-2 text-left text-sm last:border-b-0 ${selectedUncFolder === folder.date ? "bg-muted" : ""}`}
                      onClick={() => setSelectedUncFolder(folder.date)}
                    >
                      <span>{folder.date}</span>
                      <span className="text-muted-foreground">{folder.fileCount} files</span>
                    </button>
                  ))}
              </div>
              <div className="text-xs text-muted-foreground">{isVi ? "Format khuyến nghị: ddmmyyyy (ví dụ 02032026)." : "Recommended format: ddmmyyyy (e.g. 02032026)."}</div>
            </div>
          )}

          {uncStep === 2 && (
            <div className="space-y-4">
              <div className="text-sm">{isVi ? "Folder đã chọn:" : "Selected folder:"} <Badge variant="secondary">{selectedUncFolder || "-"}</Badge></div>
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
              <Button onClick={() => setUncStep(2)} disabled={!selectedUncFolder}>{isVi ? "Tiếp tục" : "Continue"}</Button>
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
