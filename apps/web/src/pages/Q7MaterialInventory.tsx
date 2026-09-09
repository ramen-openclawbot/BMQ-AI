import { useProductionCopy } from "@/i18n/useProductionCopy";
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
  const c = useProductionCopy();
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
            {selected?.display_label || selected?.canonical_name || c.m15}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,640px)] p-0">
        <Command>
          <CommandInput placeholder={c.m16} />
          <CommandList className="max-h-[min(70vh,420px)] overflow-y-auto">
            <CommandEmpty>{loading ? c.m17 : c.m18}</CommandEmpty>
            <CommandGroup heading={c.m19}>
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
  const c = useProductionCopy();
  const movementLabel: Record<string, string> = { receipt: c.m12, production_usage: c.m13, adjustment: c.m14 };
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
      toast({ title: c.m20, variant: "destructive" });
      return;
    }
    const quantity = Number(receiptQty);
    if (!receiptItemId || !receiptUnit.trim() || !Number.isFinite(quantity) || quantity <= 0) {
      toast({ title: c.m21, description: c.m22, variant: "destructive" });
      return;
    }
    receiptSubmitLockRef.current = true;
    const sourceReference = receiptReference.trim() || `q7-ui-${crypto.randomUUID()}`;
    recordReceiptMutation.mutate({ movementDate: asOfDate, kitchenInventoryItemId: receiptItemId, quantity, unit: receiptUnit.trim(), reference: sourceReference, note: receiptNote.trim() || null }, {
      onSuccess: () => {
        toast({ title: c.m23 });
        setReceiptQty("");
        setReceiptReference("");
        setReceiptNote("");
      },
      onError: () => toast({ title: c.m24, description: c.m25, variant: "destructive" }),
      onSettled: () => { receiptSubmitLockRef.current = false; },
    });
  };

  const submitOpening = () => {
    if (openingSubmitLockRef.current || backfillOpeningMutation.isPending) return;
    if (!canWriteQ7) {
      toast({ title: c.m26, variant: "destructive" });
      return;
    }
    const parsedOpening = openingQty.trim() === "" ? null : Number(openingQty);
    const parsedPhysical = physicalQty.trim() === "" ? null : Number(physicalQty);
    if (!openingItemId || !openingUnit.trim() || (parsedOpening !== null && (!Number.isFinite(parsedOpening) || parsedOpening < 0)) || (parsedPhysical !== null && (!Number.isFinite(parsedPhysical) || parsedPhysical < 0))) {
      toast({ title: c.m27, description: c.m28, variant: "destructive" });
      return;
    }
    openingSubmitLockRef.current = true;
    backfillOpeningMutation.mutate({ effectiveDate: asOfDate, kitchenInventoryItemId: openingItemId, openingQty: parsedOpening, unit: openingUnit.trim(), physicalCountQty: parsedPhysical, physicalCountDate: physicalDate || null, note: openingNote.trim() || null }, {
      onSuccess: () => toast({ title: c.m29 }),
      onError: () => toast({ title: c.m30, description: c.m31, variant: "destructive" }),
      onSettled: () => { openingSubmitLockRef.current = false; },
    });
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] space-y-5 bg-background pb-8 text-foreground" data-production-i18n="c-production-v1" data-testid="q7-material-inventory-page">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-card md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary"><Scale className="h-3.5 w-3.5" /> {c.m32}</div>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-tight md:text-4xl">{c.m33}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{c.m34}</p>
          </div>
          <div className="min-w-[190px] space-y-1.5">
            <label htmlFor="q7-as-of-date" className="text-sm font-medium">{c.m35}</label>
            <Input id="q7-as-of-date" type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{c.m36}</p><p className="mt-2 text-3xl font-bold text-amber-700">{negativeCount}</p><p className="mt-1 text-xs text-muted-foreground">{c.m37}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{c.m38}</p><p className="mt-2 text-3xl font-bold">{numberVi(todayTotals.usage)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{c.m39}</p><p className="mt-2 text-3xl font-bold">—</p><p className="mt-1 text-xs text-muted-foreground">{c.m40}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{c.m41}</p><p className="mt-2 text-3xl font-bold">{numberVi(todayTotals.receipt)}</p></CardContent></Card>
      </div>

      {!canWriteQ7 && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">{c.m42}</div>}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="flex h-auto w-full flex-nowrap justify-start gap-2 overflow-x-auto bg-muted/40 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="snapshot">{c.label0}</TabsTrigger>
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="queue">{c.m43}</TabsTrigger>
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="receipt">{c.m44}</TabsTrigger>
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="audit">{c.m45}</TabsTrigger>
          <TabsTrigger className="shrink-0 rounded-full border border-transparent px-4 py-2.5 text-sm font-semibold data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm" value="history">{c.m46}</TabsTrigger>
        </TabsList>

        <TabsContent value="snapshot">
          <Card>
            <CardHeader><CardTitle>{c.label1}</CardTitle><p className="text-sm text-muted-foreground">{c.m47}</p></CardHeader>
            <CardContent>
              {snapshotQuery.isLoading ? <div className="flex min-h-[180px] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" /></div> : snapshotQuery.isError ? <div role="alert" className="rounded-2xl border border-red-300 bg-red-50 p-5 text-red-800">{c.m48}</div> : (
                <div className="overflow-x-auto rounded-2xl border"><Table className="min-w-[900px]"><TableHeader><TableRow><TableHead>{c.m49}</TableHead><TableHead>{c.m50}</TableHead><TableHead className="text-right">{c.m51}</TableHead><TableHead className="text-right">{c.m52}</TableHead><TableHead className="text-right">{c.m53}</TableHead><TableHead className="text-right">{c.m54}</TableHead><TableHead className="text-right">{c.m55}</TableHead><TableHead>{c.label2}</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.kitchen_inventory_item_id} className={row.is_negative ? "bg-amber-50/60" : undefined}><TableCell className="font-medium">{row.item_name}</TableCell><TableCell>{row.unit}</TableCell><TableCell className="text-right">{row.opening_qty === null ? c.m56 : numberVi(row.opening_qty)}</TableCell><TableCell className="text-right">{numberVi(row.receipt_qty)}</TableCell><TableCell className="text-right">{numberVi(row.usage_qty)}</TableCell><TableCell className="text-right">{numberVi(row.adjustment_qty)}</TableCell><TableCell className="text-right font-semibold">{numberVi(row.balance_qty)}</TableCell><TableCell>{row.opening_audited ? c.m57 : c.m58}{row.is_negative ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">{c.m59}</span> : null}</TableCell></TableRow>)}</TableBody></Table></div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="queue"><Q7SignedMaterialIssueQueue /></TabsContent>

        <TabsContent value="receipt">
          <div className="mx-auto max-w-2xl">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><PackagePlus className="h-5 w-5 text-primary" /> {c.m60}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5"><label htmlFor="q7-receipt-item" className="text-sm font-medium">{c.m61}</label><Q7MaterialPicker id="q7-receipt-item" q7PickerRows={q7PickerRows} value={receiptItemId} selected={selectedReceiptPickerItem} placeholder={c.m62} onChange={(value) => { setReceiptItemId(value); const selected = q7PickerRows.find((row) => row.kitchen_inventory_item_id === value) as Q7InventoryPickerRow; setReceiptUnit(selected.location_unit || ""); }} loading={pickerQuery.isLoading} /></div>
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><label htmlFor="q7-receipt-qty" className="text-sm font-medium">{c.m63}</label><Input id="q7-receipt-qty" className="min-h-12" inputMode="decimal" value={receiptQty} onChange={(event) => setReceiptQty(event.target.value)} /></div><div className="space-y-1.5"><label htmlFor="q7-receipt-unit" className="text-sm font-medium">{c.m64}</label><Input id="q7-receipt-unit" className="min-h-12 bg-muted/40" readOnly placeholder={c.m65} value={receiptUnit} /></div></div>
                <div className="space-y-1.5"><label htmlFor="q7-receipt-reference" className="text-sm font-medium">{c.m66}</label><Input id="q7-receipt-reference" value={receiptReference} onChange={(event) => setReceiptReference(event.target.value)} /></div>
                <div className="space-y-1.5"><label htmlFor="q7-receipt-note" className="text-sm font-medium">{c.m67}</label><Textarea id="q7-receipt-note" value={receiptNote} onChange={(event) => setReceiptNote(event.target.value)} /></div>
                <Button className="min-h-12 w-full" disabled={!canWriteQ7 || recordReceiptMutation.isPending} onClick={submitReceipt}>{recordReceiptMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackagePlus className="mr-2 h-4 w-4" />}{c.m68}</Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="audit">
          <div className="mx-auto max-w-2xl">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5 shrink-0 text-primary" /> {c.m69}</CardTitle><p className="text-sm leading-6 text-muted-foreground">{c.m70}</p></CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm leading-6"><span className="font-semibold">{c.m71}</span> {asOfDate}{c.m72}</div>
                <div className="space-y-1.5"><label htmlFor="q7-opening-item" className="text-sm font-medium">{c.m73}</label><Q7MaterialPicker id="q7-opening-item" q7PickerRows={q7PickerRows} value={openingItemId} selected={selectedOpeningPickerItem} placeholder={c.m74} onChange={(value) => { setOpeningItemId(value); const selected = q7PickerRows.find((row) => row.kitchen_inventory_item_id === value) as Q7InventoryPickerRow; setOpeningUnit(selected.location_unit || ""); }} loading={pickerQuery.isLoading} /></div>
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><label htmlFor="q7-opening-qty" className="text-sm font-medium">{c.m75}</label><Input id="q7-opening-qty" className="min-h-12" inputMode="decimal" placeholder={c.m76} value={openingQty} onChange={(event) => setOpeningQty(event.target.value)} /></div><div className="space-y-1.5"><label htmlFor="q7-opening-unit" className="text-sm font-medium">{c.m77}</label><Input id="q7-opening-unit" className="min-h-12 bg-muted/40" readOnly placeholder={c.m78} value={openingUnit} /></div></div>
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><label htmlFor="q7-physical-qty" className="text-sm font-medium">{c.m79}</label><Input id="q7-physical-qty" inputMode="decimal" value={physicalQty} onChange={(event) => setPhysicalQty(event.target.value)} /></div><div className="space-y-1.5"><label htmlFor="q7-physical-date" className="text-sm font-medium">{c.m80}</label><Input id="q7-physical-date" type="date" value={physicalDate} onChange={(event) => setPhysicalDate(event.target.value)} /></div></div>
                <div className="space-y-1.5"><label htmlFor="q7-opening-note" className="text-sm font-medium">{c.m81}</label><Textarea id="q7-opening-note" value={openingNote} onChange={(event) => setOpeningNote(event.target.value)} /></div>
                <Button className="min-h-12 w-full" disabled={!canWriteQ7 || backfillOpeningMutation.isPending} onClick={submitOpening}>{backfillOpeningMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ClipboardCheck className="mr-2 h-4 w-4" />}{c.m82}</Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="history">
          <Card><CardHeader className="gap-4 md:flex-row md:items-center md:justify-between"><div><CardTitle>{c.m83}</CardTitle><p className="text-sm text-muted-foreground">{c.m84}</p></div><Button variant="outline" onClick={() => void movementsQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" /> {c.m85}</Button></CardHeader><CardContent>{movementsQuery.isError ? <div role="alert" className="rounded-2xl border border-red-300 bg-red-50 p-5 text-red-800">{c.m86}</div> : <div className="overflow-x-auto rounded-2xl border"><Table className="min-w-[760px]"><TableHeader><TableRow><TableHead>{c.m87}</TableHead><TableHead>{c.m88}</TableHead><TableHead>{c.m89}</TableHead><TableHead className="text-right">{c.m90}</TableHead><TableHead>{c.m91}</TableHead><TableHead>{c.m92}</TableHead></TableRow></TableHeader><TableBody>{movements.map((row) => { const joined = Array.isArray(row.kitchen_inventory_items) ? row.kitchen_inventory_items[0] : row.kitchen_inventory_items; return <TableRow key={row.id}><TableCell>{row.movement_date}</TableCell><TableCell>{joined?.name || c.materialFallback}</TableCell><TableCell>{movementLabel[row.movement_type] || row.movement_type}</TableCell><TableCell className="text-right font-medium">{numberVi(row.quantity)}</TableCell><TableCell>{row.unit}</TableCell><TableCell className="max-w-[260px] break-words text-sm text-muted-foreground">{row.note || "—"}</TableCell></TableRow>; })}</TableBody></Table></div>}</CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
