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

  const [qtmSlipFile, setQtmSlipFile] = useState<File | null>(null);
  const [uncSlipFile, setUncSlipFile] = useState<File | null>(null);
  const [qtmSlipPreview, setQtmSlipPreview] = useState<string>("");
  const [uncSlipPreview, setUncSlipPreview] = useState<string>("");
  const [pendingQtmImageBase64, setPendingQtmImageBase64] = useState<string | null>(null);
  const [pendingUncImageBase64, setPendingUncImageBase64] = useState<string | null>(null);
  const [pendingQtmExtracted, setPendingQtmExtracted] = useState<any>(null);
  const [pendingUncExtracted, setPendingUncExtracted] = useState<any>(null);

  useEffect(() => {
    setUncTotalDeclared(Number(dailyDeclaration?.unc_extracted_amount || dailyDeclaration?.unc_total_declared || 0));
    setCashFundTopupAmount(Number(dailyDeclaration?.qtm_extracted_amount || dailyDeclaration?.cash_fund_topup_amount || 0));
    setNotes(String(dailyDeclaration?.notes || ""));
    setQtmSlipPreview(dailyDeclaration?.qtm_slip_image_base64 ? `data:image/jpeg;base64,${dailyDeclaration.qtm_slip_image_base64}` : "");
    setUncSlipPreview(dailyDeclaration?.unc_slip_image_base64 ? `data:image/jpeg;base64,${dailyDeclaration.unc_slip_image_base64}` : "");

    // clear unsaved local state when data source changes (e.g. switch date)
    setPendingQtmImageBase64(null);
    setPendingUncImageBase64(null);
    setPendingQtmExtracted(null);
    setPendingUncExtracted(null);
    setQtmSlipFile(null);
    setUncSlipFile(null);
  }, [dailyDeclaration]);

  const dateKey = format(selectedDate, "yyyy-MM-dd");

  useEffect(() => {
    // Prevent stale slip previews when switching date while query is refetching
    setQtmSlipPreview("");
    setUncSlipPreview("");
    setPendingQtmImageBase64(null);
    setPendingUncImageBase64(null);
    setPendingQtmExtracted(null);
    setPendingUncExtracted(null);
    setQtmSlipFile(null);
    setUncSlipFile(null);
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

  const processSlipUpload = async (slipType: "qtm" | "unc", file: File) => {
    setExtracting(true);
    try {
      const result = await extractSlipAmount(file, slipType);

      if (slipType === "qtm") {
        setCashFundTopupAmount(Number(result.extracted.amount || 0));
        setQtmSlipPreview(`data:${file.type || "image/jpeg"};base64,${result.imageBase64}`);
        setPendingQtmImageBase64(result.imageBase64);
        setPendingQtmExtracted(result.extracted);
      } else {
        setUncTotalDeclared(Number(result.extracted.amount || 0));
        setUncSlipPreview(`data:${file.type || "image/jpeg"};base64,${result.imageBase64}`);
        setPendingUncImageBase64(result.imageBase64);
        setPendingUncExtracted(result.extracted);
      }

      toast({
        title: "Đã scan slip (chưa lưu)",
        description: slipType === "qtm"
          ? `QTM: ${vnd(Number(result.extracted.amount || 0))}`
          : `UNC: ${vnd(Number(result.extracted.amount || 0))}`,
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
      const payload = {
        closing_date: dateKey,
        unc_total_declared: Number(uncTotalDeclared || 0),
        cash_fund_topup_amount: Number(cashFundTopupAmount || 0),
        qtm_extracted_amount: Number(pendingQtmExtracted?.amount ?? dailyDeclaration?.qtm_extracted_amount ?? cashFundTopupAmount ?? 0),
        unc_extracted_amount: Number(pendingUncExtracted?.amount ?? dailyDeclaration?.unc_extracted_amount ?? uncTotalDeclared ?? 0),
        qtm_slip_image_base64: pendingQtmImageBase64 ?? dailyDeclaration?.qtm_slip_image_base64 ?? null,
        unc_slip_image_base64: pendingUncImageBase64 ?? dailyDeclaration?.unc_slip_image_base64 ?? null,
        extraction_meta: {
          ...(dailyDeclaration?.extraction_meta || {}),
          ...(pendingQtmExtracted ? { qtm: pendingQtmExtracted } : {}),
          ...(pendingUncExtracted ? { unc: pendingUncExtracted } : {}),
        },
        notes: notes || null,
      };

      const { error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .upsert(payload, { onConflict: "closing_date" });

      if (error) throw error;
      toast({ title: "Saved", description: "CEO daily declaration has been updated." });
      setPendingQtmImageBase64(null);
      setPendingUncImageBase64(null);
      setPendingQtmExtracted(null);
      setPendingUncExtracted(null);
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

      <Tabs defaultValue="daily" className="space-y-4">
        <TabsList>
          <TabsTrigger value="daily">{isVi ? "Đối soát ngày" : "Daily Reconciliation"}</TabsTrigger>
          <TabsTrigger value="monthly">{isVi ? "Chốt tháng" : "Monthly Closing"}</TabsTrigger>
        </TabsList>

        <TabsContent value="daily" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Tải slip CEO (tự động trích xuất)" : "CEO Slip Upload (Auto Extract)"}</CardTitle>
              <CardDescription>{isVi ? "Tải 1 hoặc cả 2 slip (QTM/UNC). Hệ thống tự quét số tiền ngay sau upload và lưu ảnh vào DB." : "Upload 1 or both slips (QTM / UNC). System auto scans amount right after upload and stores image in DB."}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>QTM Slip</Label>
                  <Input type="file" accept="image/*" onChange={async (e) => {
                    const f = e.target.files?.[0] || null;
                    setQtmSlipFile(f);
                    if (f) await processSlipUpload("qtm", f);
                  }} />
                  {qtmSlipPreview && <img src={qtmSlipPreview} alt="QTM slip" className="max-h-40 rounded border" />}
                </div>
                <div className="space-y-2">
                  <Label>UNC Slip</Label>
                  <Input type="file" accept="image/*" onChange={async (e) => {
                    const f = e.target.files?.[0] || null;
                    setUncSlipFile(f);
                    if (f) await processSlipUpload("unc", f);
                  }} />
                  {uncSlipPreview && <img src={uncSlipPreview} alt="UNC slip" className="max-h-40 rounded border" />}
                </div>
              </div>

              {extracting && <div className="text-sm text-muted-foreground">{isVi ? "Đang scan slip và cập nhật số tiền..." : "Scanning slips and updating amount..."}</div>}
              {(pendingQtmImageBase64 || pendingUncImageBase64) && (
                <div className="text-sm text-amber-600">{isVi ? "Có dữ liệu slip mới chưa lưu. Vui lòng bấm Lưu khai báo để lưu vào DB." : "There are unsaved slip data. Please click Save Declaration to persist to DB."}</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Chốt ngày" : "Daily Closing"}</CardTitle>
              <CardDescription>{isVi ? "So sánh UNC chi tiết (tự động) với tổng khai báo CEO" : "Compare UNC detail (auto) vs CEO declared total"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>{isVi ? "Ngày chốt" : "Closing Date"}</Label>
                  <Input type="date" value={dateKey} onChange={(e) => setSelectedDate(new Date(e.target.value))} />
                </div>
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
                <div className="space-y-2">
                  <Label>{isVi ? "Tháng" : "Month"}</Label>
                  <Input type="month" value={format(selectedMonth, "yyyy-MM")} onChange={(e) => setSelectedMonth(new Date(`${e.target.value}-01`))} />
                </div>
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
