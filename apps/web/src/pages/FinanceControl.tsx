import { useEffect, useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { vi } from "date-fns/locale";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
      const uncDetail = Number(uncDetailAmount || 0);
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
              <CardTitle>{isVi ? "Chốt ngày" : "Daily Closing"}</CardTitle>
              <CardDescription>{isVi ? "So sánh UNC chi tiết (tự động) với tổng khai báo CEO" : "Compare UNC detail (auto) vs CEO declared total"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{isVi ? "UNC chi tiết (tự động từ slip)" : "UNC Detail (Auto from slips)"}</Label>
                  <Input value={vnd(Number(uncDetailAmount || 0))} readOnly />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <div className="h-10 px-3 rounded-md border flex items-center">
                    {dailyReconciliation?.status === "match" && <Badge className="bg-green-600">MATCH</Badge>}
                    {dailyReconciliation?.status === "mismatch" && <Badge variant="destructive">MISMATCH</Badge>}
                    {!dailyReconciliation?.status && <span className="text-muted-foreground">{isVi ? "Chờ" : "Pending"}</span>}
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
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "UNC chi tiết" : "UNC Detail"}</div><div className="text-xl font-semibold">{vnd(Number(uncDetailAmount || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "UNC khai báo" : "UNC Declared"}</div><div className="text-xl font-semibold">{vnd(Number(uncTotalDeclared || 0))}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Chênh lệch" : "Variance"}</div><div className="text-xl font-semibold">{vnd(Number((uncDetailAmount || 0) - (uncTotalDeclared || 0)))}</div></CardContent></Card>
              </div>

              <div className="flex gap-2">
                <Button onClick={saveDeclaration} disabled={saving}>{saving ? (isVi ? "Đang lưu..." : "Saving...") : (isVi ? "Lưu khai báo" : "Save Declaration")}</Button>
                <Button variant="outline" onClick={async () => { await refetchUncDetail(); await runReconcile(); }} disabled={reconciling}>
                  {reconciling ? (isVi ? "Đang đối soát..." : "Reconciling...") : (isVi ? "Chạy đối soát" : "Run Reconcile")}
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
    </div>
  );
}
