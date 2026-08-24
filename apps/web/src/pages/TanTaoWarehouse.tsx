import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, Clock3, Menu, PackageCheck, Send, Warehouse } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { parseTanTaoWarehouseCommand, type TanTaoWarehouseCommand } from "@/lib/tan-tao-warehouse";
import bmqLogo from "@/assets/bmq-logo.png";

interface WarehouseDocument {
  id: string;
  document_number: string;
  document_type: string;
  status: string;
  quantity: number;
  ordered_quantity: number;
  exchange_quantity: number;
  makeup_quantity: number;
  physical_quantity: number;
  supplier_billable_quantity: number;
  supplier_credit_quantity: number;
  supplier_exchange_quantity: number;
  supplier_makeup_quantity: number;
  reference_label?: string | null;
  note?: string | null;
  created_at: string;
}

interface WarehouseItem {
  sku_id?: string | null;
  sku_code: string;
  product_name: string;
  unit: string;
  on_hand_quantity: number;
  reserved_quantity: number;
  atp_quantity: number;
  incoming_quantity: number;
  projected_quantity: number;
  needs_attention: boolean;
  recent_documents: WarehouseDocument[];
}

interface WarehouseSnapshot {
  location_code: string;
  location_name: string;
  sku_code: string;
  unit: string;
  on_hand_quantity: number;
  reserved_quantity: number;
  atp_quantity: number;
  incoming_quantity: number;
  projected_quantity: number;
  needs_attention: boolean;
  recent_documents: WarehouseDocument[];
  can_manage?: boolean;
  items?: WarehouseItem[];
}

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
}

const warehouseRpc = (fn: string, args?: Record<string, unknown>) => (
  supabase as unknown as {
    rpc: (name: string, parameters?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  }
).rpc(fn, args);

const number = (value: unknown) => Number(value || 0);
const qty = (value: unknown) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(number(value));

const documentLabel: Record<string, string> = {
  opening: "Phiếu tồn đầu",
  supplier_order: "Đơn nhà cung cấp",
  receipt: "Phiếu nhập",
  outbound_order: "Phiếu giữ hàng",
  dispatch: "Phiếu xuất",
  stock_count: "Phiếu kiểm kê",
  adjustment: "Phiếu điều chỉnh",
  cancellation: "Phiếu huỷ giữ hàng",
};

const TAN_TAO_ITEMS: Array<{ sku_code: string; product_name: string; unit: string; weightKgPerUnit?: number }> = [
  { sku_code: "BMQ-001", product_name: "Bánh mì tươi", unit: "que" },
  { sku_code: "BMQ-002", product_name: "Bánh mì đông lạnh", unit: "que" },
  { sku_code: "PATE-500G", product_name: "Pate 500g", unit: "hộp", weightKgPerUnit: 0.5 },
  { sku_code: "PATE-200G", product_name: "Pate 200g", unit: "hộp", weightKgPerUnit: 0.2 },
];

type LegacyChatCommand = Exclude<TanTaoWarehouseCommand, { type: "stock_count" }>;

const commandArgs = (command: LegacyChatCommand, idempotencyKey: string) => ({
  p_command_type: command.type,
  p_idempotency_key: idempotencyKey,
  p_quantity: "quantity" in command ? command.quantity : null,
  p_ordered_quantity: "orderedQuantity" in command ? command.orderedQuantity : 0,
  p_exchange_quantity: "exchangeQuantity" in command ? command.exchangeQuantity : 0,
  p_makeup_quantity: "makeupQuantity" in command ? command.makeupQuantity : 0,
  p_reference_label: "referenceLabel" in command ? command.referenceLabel : null,
  p_reference_type: "trusted_owner_chat",
  p_reference_id: null,
  p_source_document_number: "sourceDocumentNumber" in command ? command.sourceDocumentNumber : null,
  p_note: null,
});

export default function TanTaoWarehouse() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [composer, setComposer] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedStockCountSku, setSelectedStockCountSku] = useState("BMQ-001");
  const [physicalCountValue, setPhysicalCountValue] = useState("");
  const [physicalCountReason, setPhysicalCountReason] = useState("");
  const submissionLockRef = useRef(false);
  const stockCountSubmissionLockRef = useRef(false);

  const snapshotQuery = useQuery({
    queryKey: ["tan-tao-warehouse-snapshot"],
    queryFn: async () => {
      const { data, error } = await warehouseRpc("get_tan_tao_warehouse_snapshot");
      if (error) throw new Error(error.message);
      return data as WarehouseSnapshot;
    },
  });

  const snapshot = snapshotQuery.data;
  const canManageWarehouse = snapshot?.can_manage === true;
  const warehouseItems = useMemo<WarehouseItem[]>(() => {
    const itemBySku = new Map((snapshot?.items || []).map((item) => [item.sku_code, item]));
    return TAN_TAO_ITEMS.map((item) => {
      const fromSnapshot = itemBySku.get(item.sku_code);
      return {
        sku_id: fromSnapshot?.sku_id || null,
        sku_code: item.sku_code,
        product_name: fromSnapshot?.product_name || item.product_name,
        unit: fromSnapshot?.unit || item.unit,
        on_hand_quantity: number(fromSnapshot?.on_hand_quantity),
        reserved_quantity: number(fromSnapshot?.reserved_quantity),
        atp_quantity: number(fromSnapshot?.atp_quantity),
        incoming_quantity: number(fromSnapshot?.incoming_quantity),
        projected_quantity: number(fromSnapshot?.projected_quantity),
        needs_attention: Boolean(fromSnapshot?.needs_attention),
        recent_documents: fromSnapshot?.recent_documents || [],
      };
    });
  }, [snapshot?.items]);
  const selectedStockCountItem = warehouseItems.find((item) => item.sku_code === selectedStockCountSku) || warehouseItems[0];
  const recentDocuments = useMemo(() => selectedStockCountItem?.recent_documents || snapshot?.recent_documents || [], [selectedStockCountItem?.recent_documents, snapshot?.recent_documents]);
  const pateKgTotal = useMemo(() => warehouseItems.reduce((total, item) => {
    const approved = TAN_TAO_ITEMS.find((approvedItem) => approvedItem.sku_code === item.sku_code);
    return total + item.on_hand_quantity * (approved?.weightKgPerUnit || 0);
  }, 0), [warehouseItems]);

  const stockCountMutation = useMutation({
    mutationFn: async ({ skuCode, count, reason, idempotencyKey }: { skuCode: string; count: number; reason: string; idempotencyKey: string }) => {
      const { data, error } = await warehouseRpc("record_tan_tao_stock_count", {
        p_sku_code: skuCode,
        p_count: count,
        p_reason: reason,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw new Error(error.message);
      return data as { status: string; document: WarehouseDocument; snapshot: WarehouseSnapshot };
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["tan-tao-warehouse-snapshot"], result.snapshot);
      setPhysicalCountValue("");
      setPhysicalCountReason("");
      toast({ title: "Đã ghi nhận kiểm kê vật lý", description: result.document.document_number });
    },
    onError: (error: unknown) => {
      const text = error instanceof Error ? error.message : "Không thể ghi nhận kiểm kê vật lý.";
      toast({ title: "Cần xử lý", description: text, variant: "destructive" });
    },
    onSettled: () => {
      stockCountSubmissionLockRef.current = false;
    },
  });

  const commandMutation = useMutation({
    mutationFn: async ({ command, raw, idempotencyKey }: { command: LegacyChatCommand; raw: string; idempotencyKey: string }) => {
      const { data, error } = await warehouseRpc("execute_tan_tao_warehouse_command", commandArgs(command, idempotencyKey));
      if (error) throw new Error(error.message);
      return { result: data as { status: string; document: WarehouseDocument; snapshot: WarehouseSnapshot }, raw };
    },
    onSuccess: ({ result }) => {
      const document = result.document;
      const next = result.snapshot;
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Đã lập ${documentLabel[document.document_type] || "chứng từ"} ${document.document_number}. Tồn vật lý ${qty(next.on_hand_quantity)} que · Đã giữ ${qty(next.reserved_quantity)} · ATP ${qty(next.atp_quantity)}.`,
        },
      ]);
      queryClient.setQueryData(["tan-tao-warehouse-snapshot"], next);
      toast({ title: "BMQ Agent đã ghi nhận", description: document.document_number });
    },
    onError: (error: unknown) => {
      const text = error instanceof Error ? error.message : "Không thể ghi nhận nghiệp vụ.";
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "agent", text: `Cần xử lý: ${text}` }]);
      toast({ title: "Cần xử lý", description: text, variant: "destructive" });
    },
    onSettled: () => {
      submissionLockRef.current = false;
    },
  });

  const sendCommand = (rawInput?: string) => {
    if (!canManageWarehouse || snapshotQuery.isLoading || snapshotQuery.isError) return;
    const raw = (rawInput ?? composer).trim();
    if (!raw || commandMutation.isPending || submissionLockRef.current) return;
    const parsed = parseTanTaoWarehouseCommand(raw);
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: raw }]);
    setComposer("");
    if (!parsed) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: "Em chưa nhận diện được nghiệp vụ. Anh có thể khai báo tồn đầu, đặt Tuyết Anh, xác nhận đã nhận, hoặc nhập đơn Đặt/Đổi/Bù.",
        },
      ]);
      return;
    }
    if (parsed.type === "stock_count") {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: "Chọn mặt hàng trong form Ghi nhận kiểm kê vật lý, nhập số lượng thực tế và lý do/ghi chú. Để tránh sai SKU và thiếu lý do, hệ thống không ghi kiểm kê vật lý qua khung chat.",
        },
      ]);
      return;
    }
    submissionLockRef.current = true;
    commandMutation.mutate({ command: parsed, raw, idempotencyKey: `trusted-chat:${crypto.randomUUID()}` });
  };

  const countNumber = Number(physicalCountValue);
  const canSubmitStockCount = canManageWarehouse && physicalCountValue.trim() !== "" && Number.isFinite(countNumber) && countNumber >= 0 && physicalCountReason.trim().length > 0 && !stockCountMutation.isPending && !stockCountSubmissionLockRef.current;

  const submitStockCount = () => {
    if (!canSubmitStockCount || stockCountSubmissionLockRef.current) return;
    if (!window.confirm(`Ghi nhận kiểm kê ${selectedStockCountItem.product_name} còn ${qty(countNumber)} ${selectedStockCountItem.unit}?`)) return;
    stockCountSubmissionLockRef.current = true;
    const idempotencyKey = `stock-count:${selectedStockCountSku}:${crypto.randomUUID()}`;
    stockCountMutation.mutate({
      skuCode: selectedStockCountSku,
      count: Number(physicalCountValue),
      reason: physicalCountReason.trim(),
      idempotencyKey,
    });
  };

  const examples = [
    "Tồn đầu BMQ-001 350 que",
    "Đặt Tuyết Anh 2480",
    "Đã nhận đủ 2480 que",
    "Anh Thanh đặt 780 đổi 16 bù 101",
  ];

  const metrics: Array<{ label: string; value: unknown; hint: string; Icon: LucideIcon }> = [
    { label: "Tồn vật lý", value: snapshot?.on_hand_quantity, hint: "Sổ nhập − xuất", Icon: PackageCheck },
    { label: "Đã giữ cho đơn", value: snapshot?.reserved_quantity, hint: "Chưa xuất thực tế", Icon: Clock3 },
    { label: "ATP khả dụng", value: snapshot?.atp_quantity, hint: "Tồn vật lý − đã giữ", Icon: CheckCircle2 },
    { label: "Hàng đang về", value: snapshot?.incoming_quantity, hint: "Đã đặt, chưa nhập", Icon: Warehouse },
  ];

  return (
    <div className="min-h-screen bg-[#f7f4f1] text-[#342b2f]">
      <div className="mx-auto max-w-7xl px-3 py-4 sm:px-6 lg:px-8">
        <header className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button type="button" variant="ghost" size="icon" className="md:hidden" onClick={() => window.dispatchEvent(new Event("bmq:open-sidebar"))} aria-label="Mở menu">
              <Menu className="h-5 w-5" />
            </Button>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-[#eadfe4]">
              <Warehouse className="h-6 w-6 text-[#c54f82]" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-black tracking-tight sm:text-2xl">Kho Tân Tạo</h1>
              <p className="truncate text-xs font-medium text-[#817278] sm:text-sm">Kho Tân Tạo · Bánh mì tươi, bánh mì đông lạnh và Pate · Sổ kho do BMQ Agent vận hành</p>
            </div>
          </div>
          <Badge className="shrink-0 border-0 bg-[#f8dbe8] text-[#a83b6c] hover:bg-[#f8dbe8]">Đang thử nghiệm</Badge>
        </header>

        <section className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {metrics.map(({ label, value, hint, Icon }) => (
            <Card key={label} className="border-[#eadfe4] bg-white shadow-none">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center justify-between gap-2 text-xs font-bold text-[#817278]">
                  <span>{String(label)}</span>
                  <Icon className="h-4 w-4 text-[#c54f82]" />
                </div>
                <div className="mt-2 text-2xl font-black tabular-nums">{snapshotQuery.isLoading ? "…" : snapshotQuery.isError ? "—" : qty(value)} <span className="text-xs font-bold text-[#817278]">que</span></div>
                <p className="mt-1 text-[11px] text-[#9a8b91]">{String(hint)}</p>
              </CardContent>
            </Card>
          ))}
        </section>

        {snapshotQuery.isError ? (
          <div className="mb-4 flex items-start gap-3 rounded-2xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div><strong>Không tải được sổ kho.</strong> Hệ thống không thay lỗi bằng tồn 0. Vui lòng tải lại hoặc kiểm tra quyền truy cập trước khi ghi nghiệp vụ.</div>
          </div>
        ) : null}

        {snapshot?.needs_attention ? (
          <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div><strong>Cần xử lý:</strong> ATP đang âm {qty(Math.abs(snapshot.atp_quantity))} que. Hệ thống giữ lịch sử nhưng sẽ chặn xuất thực tế khi tồn vật lý không đủ.</div>
          </div>
        ) : null}

        <section className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {warehouseItems.map((item) => {
            const approved = TAN_TAO_ITEMS.find((approvedItem) => approvedItem.sku_code === item.sku_code);
            const isSelected = selectedStockCountSku === item.sku_code;
            const kgValue = item.on_hand_quantity * (approved?.weightKgPerUnit || 0);
            return (
              <button
                key={item.sku_code}
                type="button"
                data-bmq-tan-tao-multi-item-card
                onClick={() => setSelectedStockCountSku(item.sku_code)}
                className={`rounded-3xl border bg-white p-4 text-left shadow-sm transition ${isSelected ? "border-[#c54f82] ring-2 ring-[#f2bfd5]" : "border-[#eadfe4] hover:border-[#d8b6c5]"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-black uppercase tracking-wide text-[#a83b6c]">{item.sku_code}</div>
                    <h3 className="mt-1 text-base font-black text-[#342b2f]">{item.product_name}</h3>
                  </div>
                  <Badge variant="outline" className="bg-[#fff8fb]">{item.unit}</Badge>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-2xl bg-[#fcfaf9] p-2"><span className="text-[#817278]">Tồn</span><div className="font-black tabular-nums">{snapshotQuery.isLoading ? "…" : snapshotQuery.isError ? "—" : qty(item.on_hand_quantity)} {item.unit}</div></div>
                  <div className="rounded-2xl bg-[#fcfaf9] p-2"><span className="text-[#817278]">ATP</span><div className="font-black tabular-nums">{snapshotQuery.isLoading ? "…" : snapshotQuery.isError ? "—" : qty(item.atp_quantity)} {item.unit}</div></div>
                </div>
                {approved?.weightKgPerUnit ? <p className="mt-3 text-xs font-bold text-[#817278]">Quy đổi tham khảo hiện tại: {qty(kgValue)}kg</p> : <p className="mt-3 text-xs font-bold text-[#817278]">Theo dõi đơn vị vận hành: {item.unit}</p>}
              </button>
            );
          })}
        </section>

        {canManageWarehouse ? (
          <Card className="mb-4 border-[#eadfe4] bg-white shadow-sm">
            <CardContent className="p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <div className="min-w-[180px] flex-1">
                  <Label htmlFor="tan-tao-stock-count-sku" className="text-xs font-black text-[#817278]">Mặt hàng kiểm kê</Label>
                  <select
                    id="tan-tao-stock-count-sku"
                    value={selectedStockCountSku}
                    onChange={(event) => setSelectedStockCountSku(event.target.value)}
                    disabled={stockCountMutation.isPending}
                    className="mt-1 h-11 w-full rounded-xl border border-[#e2d4da] bg-white px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-[#efb7cf] disabled:opacity-60"
                  >
                    {warehouseItems.map((item) => <option key={item.sku_code} value={item.sku_code}>{item.sku_code} · {item.product_name}</option>)}
                  </select>
                </div>
                <div className="min-w-[160px] flex-1">
                  <Label htmlFor="tan-tao-stock-count-quantity" className="text-xs font-black text-[#817278]">Số lượng kiểm kê vật lý</Label>
                  <Input
                    id="tan-tao-stock-count-quantity"
                    inputMode="decimal"
                    value={physicalCountValue}
                    onChange={(event) => setPhysicalCountValue(event.target.value)}
                    disabled={stockCountMutation.isPending}
                    placeholder={`Nhập số ${selectedStockCountItem.unit}`}
                    className="mt-1 h-11 rounded-xl border-[#e2d4da]"
                  />
                </div>
                <div className="min-w-[220px] flex-[1.4]">
                  <Label htmlFor="tan-tao-stock-count-reason" className="text-xs font-black text-[#817278]">Nhập lý do/ghi chú kiểm kê</Label>
                  <Input
                    id="tan-tao-stock-count-reason"
                    value={physicalCountReason}
                    onChange={(event) => setPhysicalCountReason(event.target.value)}
                    disabled={stockCountMutation.isPending}
                    placeholder="VD: Kiểm kê cuối ca"
                    className="mt-1 h-11 rounded-xl border-[#e2d4da]"
                  />
                </div>
                <Button type="button" onClick={submitStockCount} disabled={!canSubmitStockCount} className="h-11 rounded-xl bg-[#c54f82] px-5 font-black hover:bg-[#ad3e70]">
                  Ghi nhận kiểm kê vật lý
                </Button>
              </div>
              <p className="mt-2 text-xs text-[#9a8b91]">Tổng Pate quy đổi từ tồn hiện tại: {qty(pateKgTotal)}kg. Hộp Pate 500g và Pate 200g được giữ thành hai ô riêng; kg chỉ là thông tin tham khảo.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="mb-4 rounded-2xl border border-[#eadfe4] bg-white p-3 text-sm text-[#817278]">Bạn chỉ có quyền xem Kho Tân Tạo; các form ghi nghiệp vụ và kiểm kê được ẩn.</div>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
          <Card className="overflow-hidden border-[#eadfe4] bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-[#efe5e9] px-4 py-3">
              <img src={bmqLogo} alt="BMQ Agent" className="h-10 w-10 rounded-full border border-[#eadfe4] bg-white object-contain p-1" />
              <div>
                <div className="flex items-center gap-2"><h2 className="font-black">BMQ Agent</h2><Bot className="h-4 w-4 text-[#c54f82]" /></div>
                <p className="text-xs text-[#817278]">Trợ lý nghiệp vụ Kho Tân Tạo</p>
              </div>
            </div>

            <div className="h-[390px] space-y-3 overflow-y-auto bg-[#fcfaf9] p-4 sm:h-[470px]">
              <div className="flex gap-2">
                <img src={bmqLogo} alt="" className="h-7 w-7 rounded-full border bg-white object-contain p-0.5" />
                <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-[#eadfe4] bg-white px-3 py-2 text-sm leading-6 shadow-sm">
                  Anh cứ nhắn nghiệp vụ. Em sẽ tự lập phiếu, ghi sổ kho và trả lại tồn trước/sau. Đơn NCC chỉ vào <strong>Hàng đang về</strong>; đơn khách chỉ <strong>giữ ATP</strong> cho đến khi xuất thực tế.
                </div>
              </div>
              {messages.map((message) => (
                <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "gap-2"}`}>
                  {message.role === "agent" ? <img src={bmqLogo} alt="" className="h-7 w-7 rounded-full border bg-white object-contain p-0.5" /> : null}
                  <div className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-6 ${message.role === "user" ? "rounded-tr-md bg-[#c54f82] text-white" : "rounded-tl-md border border-[#eadfe4] bg-white"}`}>
                    {message.text}
                  </div>
                </div>
              ))}
              {commandMutation.isPending ? <div className="ml-9 text-xs font-semibold text-[#a83b6c]">BMQ Agent đang lập chứng từ…</div> : null}
            </div>

            {canManageWarehouse ? (
              <div className="border-t border-[#efe5e9] p-3">
                <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
                  {examples.map((example) => (
                    <button key={example} type="button" onClick={() => setComposer(example)} className="whitespace-nowrap rounded-full border border-[#eadfe4] bg-[#fff8fb] px-3 py-1.5 text-xs font-bold text-[#a83b6c]">
                      {example}
                    </button>
                  ))}
                </div>
                <div className="flex items-end gap-2 rounded-2xl border border-[#e2d4da] bg-white p-2 focus-within:ring-2 focus-within:ring-[#efb7cf]">
                  <Textarea disabled={snapshotQuery.isLoading || snapshotQuery.isError} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendCommand(); } }} placeholder="Nhắn nghiệp vụ kho…" className="min-h-[44px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0" />
                  <Button type="button" size="icon" onClick={() => sendCommand()} disabled={!composer.trim() || commandMutation.isPending || snapshotQuery.isLoading || snapshotQuery.isError} className="h-11 w-11 shrink-0 rounded-xl bg-[#c54f82] hover:bg-[#ad3e70]" aria-label="Gửi lệnh">
                    <Send className="h-5 w-5" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="border-t border-[#efe5e9] p-3 text-sm text-[#817278]">Chế độ xem: BMQ Agent không hiển thị nút ghi sổ cho tài khoản không có quyền quản lý.</div>
            )}
          </Card>

          <Card className="border-[#eadfe4] bg-white shadow-sm">
            <div className="border-b border-[#efe5e9] p-4">
              <div className="flex items-center justify-between gap-3"><h2 className="font-black">Chứng từ gần đây</h2><Badge variant="outline">{recentDocuments.length}</Badge></div>
              <p className="mt-1 text-xs text-[#817278]">Phiếu được AI lập nhưng vẫn là dữ liệu nghiệp vụ chuẩn và có audit.</p>
            </div>
            <div className="max-h-[640px] space-y-2 overflow-y-auto p-3">
              {recentDocuments.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[#dfd0d6] p-6 text-center text-sm text-[#817278]">Chưa có chứng từ. Anh có thể bắt đầu bằng khai báo tồn đầu.</div>
              ) : recentDocuments.map((document) => (
                <div key={document.id} className="rounded-2xl border border-[#eadfe4] bg-[#fcfaf9] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><div className="text-xs font-bold uppercase tracking-wide text-[#a83b6c]">{documentLabel[document.document_type] || document.document_type}</div><div className="mt-1 truncate text-sm font-black">{document.document_number}</div></div>
                    <Badge variant="outline" className="shrink-0 bg-white">{document.status}</Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-[#817278]">Số lượng</span><div className="font-black">{qty(document.physical_quantity || document.quantity)} {selectedStockCountItem.unit}</div></div>
                    <div><span className="text-[#817278]">Nguồn</span><div className="truncate font-bold">{document.reference_label || "BMQ Agent"}</div></div>
                  </div>
                  {document.document_type === "outbound_order" ? <div className="mt-2 text-xs text-[#817278]">Đặt {qty(document.ordered_quantity)} · Đổi {qty(document.exchange_quantity)} · Bù {qty(document.makeup_quantity)}</div> : null}
                  {document.document_type === "supplier_order" && number(document.supplier_credit_quantity) > 0 ? (
                    <div className="mt-2 text-xs text-[#817278]">
                      Lò tính tiền {qty(document.supplier_billable_quantity)} · Khấu trừ công nợ lò {qty(document.supplier_credit_quantity)}{" "}
                      (Đổi {qty(document.supplier_exchange_quantity)} · Bù {qty(document.supplier_makeup_quantity)})
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
