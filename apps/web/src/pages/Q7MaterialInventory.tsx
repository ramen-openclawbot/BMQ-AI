import { useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, ClipboardCheck, Loader2, PackagePlus, RefreshCw, Scale } from "lucide-react";
import { Q7SignedMaterialIssueQueue } from "@/components/q7-material-inventory/Q7SignedMaterialIssueQueue";
import { useQ7InventoryMutations, useQ7InventoryMovements, useQ7InventorySnapshot } from "@/hooks/useQ7MaterialInventory";

const numberVi = (value: unknown) => Number(value || 0).toLocaleString("vi-VN", { maximumFractionDigits: 3 });
const movementLabel: Record<string, string> = { receipt: "Nhập", production_usage: "Xuất dùng", adjustment: "Điều chỉnh" };

export default function Q7MaterialInventory() {
  const { toast } = useToast();
  const { canEditModule } = useAuth();
  const [asOfDate, setAsOfDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [receiptItemId, setReceiptItemId] = useState("");
  const [receiptQty, setReceiptQty] = useState("");
  const [receiptUnit, setReceiptUnit] = useState("");
  const [receiptReference, setReceiptReference] = useState("");
  const [receiptNote, setReceiptNote] = useState("");
  const [openingItemId, setOpeningItemId] = useState("");
  const [openingQty, setOpeningQty] = useState("");
  const [openingUnit, setOpeningUnit] = useState("");
  const [physicalQty, setPhysicalQty] = useState("");
  const [physicalDate, setPhysicalDate] = useState(asOfDate);
  const [openingNote, setOpeningNote] = useState("");
  const receiptSubmitLockRef = useRef(false);
  const openingSubmitLockRef = useRef(false);

  const snapshotQuery = useQ7InventorySnapshot(asOfDate);
  const movementsQuery = useQ7InventoryMovements(asOfDate);
  const { recordReceiptMutation, backfillOpeningMutation } = useQ7InventoryMutations();
  const rows = snapshotQuery.data || [];
  const movements = useMemo(() => movementsQuery.data || [], [movementsQuery.data]);
  const canWriteQ7 = canEditModule("q7_material_inventory") || canEditModule("kitchen_inventory");

  const todayTotals = useMemo(() => {
    const todayRows = movements.filter((row) => row.movement_date === asOfDate);
    return {
      receipt: todayRows.filter((row) => row.movement_type === "receipt").reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      usage: todayRows.filter((row) => row.movement_type === "production_usage").reduce((sum, row) => sum + Number(row.quantity || 0), 0),
    };
  }, [asOfDate, movements]);
  const negativeCount = rows.filter((row) => row.is_negative).length;

  const submitReceipt = () => {
    if (receiptSubmitLockRef.current || recordReceiptMutation.isPending) return;
    if (!canWriteQ7) {
      toast({ title: "Bạn không có quyền ghi sổ Q7", variant: "destructive" });
      return;
    }
    const quantity = Number(receiptQty);
    if (!receiptItemId || !receiptUnit.trim() || !Number.isFinite(quantity) || quantity <= 0) {
      toast({ title: "Thiếu dữ liệu nhập Q7", description: "Chọn NVL, đơn vị và số lượng dương.", variant: "destructive" });
      return;
    }
    receiptSubmitLockRef.current = true;
    const sourceReference = receiptReference.trim() || `q7-ui-${crypto.randomUUID()}`;
    recordReceiptMutation.mutate({ movementDate: asOfDate, kitchenInventoryItemId: receiptItemId, quantity, unit: receiptUnit.trim(), reference: sourceReference, note: receiptNote.trim() || null }, {
      onSuccess: () => {
        toast({ title: "Đã ghi nhận nhập Q7" });
        setReceiptQty("");
        setReceiptReference("");
        setReceiptNote("");
      },
      onError: () => toast({ title: "Không ghi nhận được nhập Q7", description: "Vui lòng kiểm tra quyền, NVL và đơn vị.", variant: "destructive" }),
      onSettled: () => { receiptSubmitLockRef.current = false; },
    });
  };

  const submitOpening = () => {
    if (openingSubmitLockRef.current || backfillOpeningMutation.isPending) return;
    if (!canWriteQ7) {
      toast({ title: "Bạn không có quyền ghi sổ Q7", variant: "destructive" });
      return;
    }
    const parsedOpening = openingQty.trim() === "" ? null : Number(openingQty);
    const parsedPhysical = physicalQty.trim() === "" ? null : Number(physicalQty);
    if (!openingItemId || !openingUnit.trim() || (parsedOpening !== null && (!Number.isFinite(parsedOpening) || parsedOpening < 0)) || (parsedPhysical !== null && (!Number.isFinite(parsedPhysical) || parsedPhysical < 0))) {
      toast({ title: "Thiếu dữ liệu audit tồn đầu", description: "Chọn NVL, đơn vị và số lượng không âm hoặc để trống tồn đầu.", variant: "destructive" });
      return;
    }
    openingSubmitLockRef.current = true;
    backfillOpeningMutation.mutate({ effectiveDate: asOfDate, kitchenInventoryItemId: openingItemId, openingQty: parsedOpening, unit: openingUnit.trim(), physicalCountQty: parsedPhysical, physicalCountDate: physicalDate || null, note: openingNote.trim() || null }, {
      onSuccess: () => toast({ title: "Đã ghi audit tồn đầu Q7" }),
      onError: () => toast({ title: "Không ghi được audit tồn đầu Q7", description: "Chỉ owner/kế toán/bếp được phân quyền phù hợp mới ghi được.", variant: "destructive" }),
      onSettled: () => { openingSubmitLockRef.current = false; },
    });
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] space-y-5 bg-background pb-8 text-foreground" data-testid="q7-material-inventory-page">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-card md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary"><Scale className="h-3.5 w-3.5" /> Xuất-nhập-tồn NVL Q7</div>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-tight md:text-4xl">Xuất-nhập-tồn NVL Q7</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Theo dõi tồn Q7 không giá tiền: snapshot XNT, phiếu ký, audit tồn đầu và phát sinh an toàn.</p>
          </div>
          <div className="min-w-[190px] space-y-1.5">
            <label htmlFor="q7-as-of-date" className="text-sm font-medium">Ngày xem</label>
            <Input id="q7-as-of-date" type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Tồn âm</p><p className="mt-2 text-3xl font-bold text-amber-700">{negativeCount}</p><p className="mt-1 text-xs text-muted-foreground">Âm tồn để kế toán audit sau</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Xuất dùng hôm nay</p><p className="mt-2 text-3xl font-bold">{numberVi(todayTotals.usage)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Phiếu chờ xử lý</p><p className="mt-2 text-3xl font-bold">—</p><p className="mt-1 text-xs text-muted-foreground">Xem tab Hàng đợi phiếu ký</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">Nhập hôm nay</p><p className="mt-2 text-3xl font-bold">{numberVi(todayTotals.receipt)}</p></CardContent></Card>
      </div>

      {!canWriteQ7 && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">Bạn không có quyền ghi sổ Q7. Có thể xem snapshot, phiếu và lịch sử.</div>}

      <Tabs defaultValue="snapshot" className="space-y-4">
        <TabsList className="flex h-auto flex-wrap justify-start gap-2 bg-muted/40 p-1">
          <TabsTrigger value="snapshot">XNT</TabsTrigger>
          <TabsTrigger value="queue">Hàng đợi phiếu ký</TabsTrigger>
          <TabsTrigger value="audit">Audit tồn đầu</TabsTrigger>
          <TabsTrigger value="history">Lịch sử phát sinh</TabsTrigger>
        </TabsList>

        <TabsContent value="snapshot">
          <Card>
            <CardHeader><CardTitle>Snapshot XNT</CardTitle><p className="text-sm text-muted-foreground">Tồn âm là thông tin để audit sau, không chặn ghi sổ xuất Q7.</p></CardHeader>
            <CardContent>
              {snapshotQuery.isLoading ? <div className="flex min-h-[180px] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" /></div> : snapshotQuery.isError ? <div role="alert" className="rounded-2xl border border-red-300 bg-red-50 p-5 text-red-800">Không tải được snapshot Q7.</div> : (
                <div className="overflow-x-auto rounded-2xl border"><Table className="min-w-[900px]"><TableHeader><TableRow><TableHead>Tên NVL</TableHead><TableHead>ĐVT</TableHead><TableHead className="text-right">Tồn đầu</TableHead><TableHead className="text-right">Nhập</TableHead><TableHead className="text-right">Xuất dùng</TableHead><TableHead className="text-right">Điều chỉnh</TableHead><TableHead className="text-right">Tồn cuối</TableHead><TableHead>Audit</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.kitchen_inventory_item_id} className={row.is_negative ? "bg-amber-50/60" : undefined}><TableCell className="font-medium">{row.item_name}</TableCell><TableCell>{row.unit}</TableCell><TableCell className="text-right">{row.opening_qty === null ? "— Chưa audit" : numberVi(row.opening_qty)}</TableCell><TableCell className="text-right">{numberVi(row.receipt_qty)}</TableCell><TableCell className="text-right">{numberVi(row.usage_qty)}</TableCell><TableCell className="text-right">{numberVi(row.adjustment_qty)}</TableCell><TableCell className="text-right font-semibold">{numberVi(row.balance_qty)}</TableCell><TableCell>{row.opening_audited ? "Đã audit" : "— Chưa audit"}{row.is_negative ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Âm tồn để kế toán audit sau</span> : null}</TableCell></TableRow>)}</TableBody></Table></div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="queue"><Q7SignedMaterialIssueQueue /></TabsContent>

        <TabsContent value="audit">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><PackagePlus className="h-5 w-5 text-primary" /> Ghi nhận nhập hôm nay</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5"><label htmlFor="q7-receipt-item" className="text-sm font-medium">ID NVL Q7</label><Input id="q7-receipt-item" value={receiptItemId} onChange={(event) => setReceiptItemId(event.target.value)} /></div>
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><label htmlFor="q7-receipt-qty" className="text-sm font-medium">Số lượng</label><Input id="q7-receipt-qty" inputMode="decimal" value={receiptQty} onChange={(event) => setReceiptQty(event.target.value)} /></div><div className="space-y-1.5"><label htmlFor="q7-receipt-unit" className="text-sm font-medium">Đơn vị</label><Input id="q7-receipt-unit" value={receiptUnit} onChange={(event) => setReceiptUnit(event.target.value)} /></div></div>
                <div className="space-y-1.5"><label htmlFor="q7-receipt-reference" className="text-sm font-medium">Số chứng từ / tham chiếu</label><Input id="q7-receipt-reference" value={receiptReference} onChange={(event) => setReceiptReference(event.target.value)} /></div>
                <div className="space-y-1.5"><label htmlFor="q7-receipt-note" className="text-sm font-medium">Ghi chú</label><Textarea id="q7-receipt-note" value={receiptNote} onChange={(event) => setReceiptNote(event.target.value)} /></div>
                <Button className="min-h-12 w-full" disabled={!canWriteQ7 || recordReceiptMutation.isPending} onClick={submitReceipt}>{recordReceiptMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackagePlus className="mr-2 h-4 w-4" />}Ghi nhận nhập Q7</Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5 text-primary" /> Audit tồn đầu</CardTitle><p className="text-sm text-muted-foreground">Tồn đầu có thể để trống để đánh dấu cần audit; chỉ người được phân quyền phù hợp mới ghi.</p></CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5"><label htmlFor="q7-opening-item" className="text-sm font-medium">ID NVL Q7</label><Input id="q7-opening-item" value={openingItemId} onChange={(event) => setOpeningItemId(event.target.value)} /></div>
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><label htmlFor="q7-opening-qty" className="text-sm font-medium">Tồn đầu (có thể trống)</label><Input id="q7-opening-qty" inputMode="decimal" value={openingQty} onChange={(event) => setOpeningQty(event.target.value)} /></div><div className="space-y-1.5"><label htmlFor="q7-opening-unit" className="text-sm font-medium">Đơn vị</label><Input id="q7-opening-unit" value={openingUnit} onChange={(event) => setOpeningUnit(event.target.value)} /></div></div>
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><label htmlFor="q7-physical-qty" className="text-sm font-medium">Đếm thực tế</label><Input id="q7-physical-qty" inputMode="decimal" value={physicalQty} onChange={(event) => setPhysicalQty(event.target.value)} /></div><div className="space-y-1.5"><label htmlFor="q7-physical-date" className="text-sm font-medium">Ngày kiểm đếm</label><Input id="q7-physical-date" type="date" value={physicalDate} onChange={(event) => setPhysicalDate(event.target.value)} /></div></div>
                <div className="space-y-1.5"><label htmlFor="q7-opening-note" className="text-sm font-medium">Ghi chú audit</label><Textarea id="q7-opening-note" value={openingNote} onChange={(event) => setOpeningNote(event.target.value)} /></div>
                <Button className="min-h-12 w-full" disabled={!canWriteQ7 || backfillOpeningMutation.isPending} onClick={submitOpening}>{backfillOpeningMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ClipboardCheck className="mr-2 h-4 w-4" />}Ghi audit tồn đầu Q7</Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="history">
          <Card><CardHeader className="gap-4 md:flex-row md:items-center md:justify-between"><div><CardTitle>Lịch sử phát sinh</CardTitle><p className="text-sm text-muted-foreground">Chỉ hiển thị tên NVL, ngày, loại, số lượng, đơn vị và ghi chú vận hành.</p></div><Button variant="outline" onClick={() => void movementsQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" /> Tải lại</Button></CardHeader><CardContent>{movementsQuery.isError ? <div role="alert" className="rounded-2xl border border-red-300 bg-red-50 p-5 text-red-800">Không tải được lịch sử Q7.</div> : <div className="overflow-x-auto rounded-2xl border"><Table className="min-w-[760px]"><TableHeader><TableRow><TableHead>Ngày</TableHead><TableHead>Tên NVL</TableHead><TableHead>Loại</TableHead><TableHead className="text-right">Số lượng</TableHead><TableHead>ĐVT</TableHead><TableHead>Ghi chú</TableHead></TableRow></TableHeader><TableBody>{movements.map((row) => { const joined = Array.isArray(row.kitchen_inventory_items) ? row.kitchen_inventory_items[0] : row.kitchen_inventory_items; return <TableRow key={row.id}><TableCell>{row.movement_date}</TableCell><TableCell>{joined?.name || "NVL Q7"}</TableCell><TableCell>{movementLabel[row.movement_type] || row.movement_type}</TableCell><TableCell className="text-right font-medium">{numberVi(row.quantity)}</TableCell><TableCell>{row.unit}</TableCell><TableCell className="max-w-[260px] break-words text-sm text-muted-foreground">{row.note || "—"}</TableCell></TableRow>; })}</TableBody></Table></div>}</CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
