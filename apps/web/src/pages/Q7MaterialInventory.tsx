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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown, ClipboardCheck, Loader2, PackagePlus, RefreshCw, Scale } from "lucide-react";
import { Q7SignedMaterialIssueQueue } from "@/components/q7-material-inventory/Q7SignedMaterialIssueQueue";
import { type Q7InventoryPickerRow, useQ7InventoryMutations, useQ7InventoryMovements, useQ7InventoryPicker, useQ7InventorySnapshot } from "@/hooks/useQ7MaterialInventory";
import { cn } from "@/lib/utils";

const numberVi = (value: unknown) => Number(value || 0).toLocaleString("vi-VN", { maximumFractionDigits: 3 });
const movementLabel: Record<string, string> = { receipt: "Nhập", production_usage: "Xuất dùng", adjustment: "Điều chỉnh" };

function Q7MaterialPicker({
  id,
  q7PickerRows,
  value,
  selected,
  placeholder,
  loading,
  onChange,
}: {
  id: string;
  q7PickerRows: Q7InventoryPickerRow[];
  value: string;
  selected?: Q7InventoryPickerRow;
  placeholder: string;
  loading?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={placeholder}
          className="min-h-12 w-full min-w-0 justify-between text-left font-normal"
        >
          <span className="min-w-0 flex-1 break-words text-sm">
            {selected?.display_label || selected?.canonical_name || "Chọn nguyên vật liệu"}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,640px)] p-0">
        <Command>
          <CommandInput placeholder="Tìm theo mã, tên chuẩn, đơn vị location..." />
          <CommandList className="max-h-[min(70vh,420px)] overflow-y-auto">
            <CommandEmpty>{loading ? "Đang tải danh mục Q7..." : "Không tìm thấy NVL Q7 đã duyệt."}</CommandEmpty>
            <CommandGroup heading="Mã · Tên chuẩn · đơn vị location">
              {q7PickerRows.map((row) => (
                <CommandItem
                  key={row.q7_mapping_id || row.kitchen_inventory_item_id}
                  value={`${row.material_code} ${row.canonical_name} ${row.location_unit} ${row.display_label}`}
                  onSelect={() => {
                    onChange(row.kitchen_inventory_item_id);
                    setOpen(false);
                  }}
                  className="min-h-12 items-start gap-2 break-words py-3"
                >
                  <Check className={cn("mt-0.5 h-4 w-4 shrink-0", value === row.kitchen_inventory_item_id ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1 break-words leading-5">
                    {row.display_label || `${row.material_code} · ${row.canonical_name} · ${row.location_unit}`}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function Q7MaterialInventory() {
  const { toast } = useToast();
  const { canEditModule } = useAuth();
  const [asOfDate, setAsOfDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [activeTab, setActiveTab] = useState("snapshot");
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
  const pickerQuery = useQ7InventoryPicker();
  const { recordReceiptMutation, backfillOpeningMutation } = useQ7InventoryMutations();
  const rows = snapshotQuery.data || [];
  const q7PickerRows = pickerQuery.data || [];
  const selectedReceiptPickerItem = q7PickerRows.find((row) => row.kitchen_inventory_item_id === receiptItemId);
  const selectedOpeningPickerItem = q7PickerRows.find((row) => row.kitchen_inventory_item_id === openingItemId);
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

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="flex h-auto w-full flex-nowrap justify-start gap-2 overflow-x-auto bg-muted/40 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="snapshot">XNT</TabsTrigger>
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="queue">Phiếu ký</TabsTrigger>
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="receipt">Nhập kho</TabsTrigger>
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="audit">Audit tồn đầu</TabsTrigger>
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="history">Lịch sử</TabsTrigger>
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

        <TabsContent value="receipt">
          <div className="mx-auto max-w-2xl">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><PackagePlus className="h-5 w-5 text-primary" /> Ghi nhận nhập hôm nay</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5"><label htmlFor="q7-receipt-item" className="text-sm font-medium">Tên NVL Q7</label><Q7MaterialPicker id="q7-receipt-item" q7PickerRows={q7PickerRows} value={receiptItemId} selected={selectedReceiptPickerItem} placeholder="Chọn nguyên vật liệu" onChange={(value) => { setReceiptItemId(value); const selected = q7PickerRows.find((row) => row.kitchen_inventory_item_id === value) as Q7InventoryPickerRow; setReceiptUnit(selected.location_unit || ""); }} loading={pickerQuery.isLoading} /></div>
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><label htmlFor="q7-receipt-qty" className="text-sm font-medium">Số lượng</label><Input id="q7-receipt-qty" className="min-h-12" inputMode="decimal" value={receiptQty} onChange={(event) => setReceiptQty(event.target.value)} /></div><div className="space-y-1.5"><label htmlFor="q7-receipt-unit" className="text-sm font-medium">Đơn vị</label><Input id="q7-receipt-unit" className="min-h-12 bg-muted/40" readOnly placeholder="Tự động theo NVL đã chọn" value={receiptUnit} /></div></div>
                <div className="space-y-1.5"><label htmlFor="q7-receipt-reference" className="text-sm font-medium">Số chứng từ / tham chiếu</label><Input id="q7-receipt-reference" value={receiptReference} onChange={(event) => setReceiptReference(event.target.value)} /></div>
                <div className="space-y-1.5"><label htmlFor="q7-receipt-note" className="text-sm font-medium">Ghi chú</label><Textarea id="q7-receipt-note" value={receiptNote} onChange={(event) => setReceiptNote(event.target.value)} /></div>
                <Button className="min-h-12 w-full" disabled={!canWriteQ7 || recordReceiptMutation.isPending} onClick={submitReceipt}>{recordReceiptMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackagePlus className="mr-2 h-4 w-4" />}Ghi nhận nhập Q7</Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="audit">
          <div className="mx-auto max-w-2xl">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5 shrink-0 text-primary" /> Audit tồn đầu</CardTitle><p className="text-sm leading-6 text-muted-foreground">Chọn NVL, nhập tồn đầu đã được kế toán xác nhận. Nếu có kiểm đếm thực tế, nhập thêm số lượng và ngày kiểm đếm để lưu dấu audit.</p></CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm leading-6"><span className="font-semibold">Ngày hiệu lực:</span> {asOfDate}. Tồn đầu chưa kiểm xong có thể để trống và bổ sung sau.</div>
                <div className="space-y-1.5"><label htmlFor="q7-opening-item" className="text-sm font-medium">Tên NVL Q7</label><Q7MaterialPicker id="q7-opening-item" q7PickerRows={q7PickerRows} value={openingItemId} selected={selectedOpeningPickerItem} placeholder="Chọn nguyên vật liệu cần audit" onChange={(value) => { setOpeningItemId(value); const selected = q7PickerRows.find((row) => row.kitchen_inventory_item_id === value) as Q7InventoryPickerRow; setOpeningUnit(selected.location_unit || ""); }} loading={pickerQuery.isLoading} /></div>
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><label htmlFor="q7-opening-qty" className="text-sm font-medium">Tồn đầu đã xác nhận</label><Input id="q7-opening-qty" className="min-h-12" inputMode="decimal" placeholder="Có thể để trống" value={openingQty} onChange={(event) => setOpeningQty(event.target.value)} /></div><div className="space-y-1.5"><label htmlFor="q7-opening-unit" className="text-sm font-medium">Đơn vị</label><Input id="q7-opening-unit" className="min-h-12 bg-muted/40" readOnly placeholder="Tự động theo NVL đã chọn" value={openingUnit} /></div></div>
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
