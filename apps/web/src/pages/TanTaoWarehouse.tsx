import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, Clock3, PackageCheck, Send, Warehouse } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { parseTanTaoWarehouseCommand, type TanTaoWarehouseCommand } from "@/lib/tan-tao-warehouse";
import bmqLogo from "@/assets/bmq-logo.png";
import "@/styles/bmq-warehouse.css";

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

  const stateText = (value: unknown, unit = "que") =>
    snapshotQuery.isLoading ? "…" : snapshotQuery.isError ? "—" : `${qty(value)} ${unit}`;
  const barMax = (item: WarehouseItem) =>
    Math.max(1, item.on_hand_quantity, item.reserved_quantity, Math.abs(item.atp_quantity), item.incoming_quantity);

  return (
    <div className="d3-wh min-w-0" data-bmq-warehouse-layout="demo3-v1">
      <header className="d3-wh-head">
        <div className="min-w-0">
          <span className="d3-wh-tag">Kho Tân Tạo · Bánh mì tươi, bánh mì đông lạnh và Pate · Sổ kho do BMQ Agent vận hành</span>
          <h1>
            Kho Tân Tạo{" "}
            <b>{snapshotQuery.isLoading ? "…" : snapshotQuery.isError ? "chưa đọc được sổ" : snapshot?.needs_attention ? "cần xử lý" : `ATP ${qty(snapshot?.atp_quantity)} que`}</b>
          </h1>
        </div>
        <Badge className="d3-wh-beta">Đang thử nghiệm</Badge>
      </header>

      <section className="d3-wh-kpis">
        {metrics.map(({ label, value, hint, Icon }, k) => (
          <div key={label} className="d3-wh-kpi" style={{ ["--i" as string]: k }}>
            <span><Icon className="h-4 w-4" />{String(label)}</span>
            <strong>{snapshotQuery.isLoading ? "…" : snapshotQuery.isError ? "—" : qty(value)}{snapshotQuery.isSuccess ? <small>que</small> : null}</strong>
            <small>{String(hint)}</small>
          </div>
        ))}
      </section>

      {snapshotQuery.isError ? (
        <div className="d3-wh-alert is-error">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div><strong>Không tải được sổ kho.</strong> Hệ thống không thay lỗi bằng tồn 0. Vui lòng tải lại hoặc kiểm tra quyền truy cập trước khi ghi nghiệp vụ.</div>
        </div>
      ) : null}

      {snapshot?.needs_attention ? (
        <div className="d3-wh-alert is-warn">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div><strong>Cần xử lý:</strong> ATP đang âm {qty(Math.abs(snapshot.atp_quantity))} que. Hệ thống giữ lịch sử nhưng sẽ chặn xuất thực tế khi tồn vật lý không đủ.</div>
        </div>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {warehouseItems.map((item, k) => {
          const approved = TAN_TAO_ITEMS.find((approvedItem) => approvedItem.sku_code === item.sku_code);
          const isSelected = selectedStockCountSku === item.sku_code;
          const kgValue = item.on_hand_quantity * (approved?.weightKgPerUnit || 0);
          const max = barMax(item);
          const atpColor = item.atp_quantity < 0 ? "#f4442e" : "#29bf12";
          const bars: Array<[string, number, string | null]> = [
            ["Tồn", item.on_hand_quantity, null],
            ["Giữ", item.reserved_quantity, null],
            ["ATP", item.atp_quantity, snapshotQuery.isSuccess ? atpColor : null],
            ["Về", item.incoming_quantity, null],
          ];
          return (
            <button
              key={item.sku_code}
              type="button"
              data-bmq-tan-tao-multi-item-card
              onClick={() => setSelectedStockCountSku(item.sku_code)}
              aria-pressed={isSelected}
              className={`d3-wh-item${isSelected ? " is-selected" : ""}${item.needs_attention ? " is-alert" : ""}`}
              style={{ ["--i" as string]: k + 1 }}
            >
              <span className="d3-wh-sku">{item.sku_code} · {item.unit}</span>
              <h3>{item.product_name}</h3>
              <div className="d3-wh-item-row">
                <div className="d3-wh-onhand">
                  <strong>
                    {snapshotQuery.isLoading ? "…" : snapshotQuery.isError ? "—" : qty(item.on_hand_quantity)}
                    {snapshotQuery.isSuccess ? <i className="d3-wh-dot" style={{ background: atpColor }} aria-hidden="true" /> : null}
                  </strong>
                  <small>tồn · ATP {stateText(item.atp_quantity, item.unit)}</small>
                </div>
                <div className="d3-wh-mbars" aria-hidden="true">
                  {bars.map(([label, value, color], j) => (
                    <i key={label} className={color ? "is-hi" : undefined} style={{ ["--h" as string]: snapshotQuery.isError ? 0 : Math.max(0.04, Math.abs(value) / max), ["--c" as string]: color || undefined, ["--dl" as string]: `${300 + j * 80}ms` }}>
                      <small>{label}</small>
                    </i>
                  ))}
                </div>
              </div>
              {approved?.weightKgPerUnit ? <p>Quy đổi tham khảo hiện tại: {qty(kgValue)}kg</p> : <p>Theo dõi đơn vị vận hành: {item.unit}</p>}
            </button>
          );
        })}
      </section>

      {canManageWarehouse ? (
        <section className="d3-wh-card d3-wh-count" style={{ ["--i" as string]: 5 }}>
          <div className="d3-wh-card-h">
            <h2>Ghi nhận kiểm kê vật lý</h2>
            <span className="d3-wh-pill">{selectedStockCountItem.sku_code} · {selectedStockCountItem.product_name}</span>
          </div>
          <div className="d3-wh-count-grid">
            <div>
              <Label htmlFor="tan-tao-stock-count-sku">Mặt hàng kiểm kê</Label>
              <select
                id="tan-tao-stock-count-sku"
                value={selectedStockCountSku}
                onChange={(event) => setSelectedStockCountSku(event.target.value)}
                disabled={stockCountMutation.isPending}
                className="d3-wh-select"
              >
                {warehouseItems.map((item) => <option key={item.sku_code} value={item.sku_code}>{item.sku_code} · {item.product_name}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="tan-tao-stock-count-quantity">Số lượng kiểm kê vật lý</Label>
              <Input
                id="tan-tao-stock-count-quantity"
                inputMode="decimal"
                value={physicalCountValue}
                onChange={(event) => setPhysicalCountValue(event.target.value)}
                disabled={stockCountMutation.isPending}
                placeholder={`Nhập số ${selectedStockCountItem.unit}`}
              />
            </div>
            <div className="d3-wh-count-reason">
              <Label htmlFor="tan-tao-stock-count-reason">Nhập lý do/ghi chú kiểm kê</Label>
              <Input
                id="tan-tao-stock-count-reason"
                value={physicalCountReason}
                onChange={(event) => setPhysicalCountReason(event.target.value)}
                disabled={stockCountMutation.isPending}
                placeholder="VD: Kiểm kê cuối ca"
              />
            </div>
            <Button type="button" onClick={submitStockCount} disabled={!canSubmitStockCount} className="d3-wh-submit">
              Ghi nhận kiểm kê vật lý
            </Button>
          </div>
          <p className="d3-wh-note">Tổng Pate quy đổi từ tồn hiện tại: {qty(pateKgTotal)}kg. Hộp Pate 500g và Pate 200g được giữ thành hai ô riêng; kg chỉ là thông tin tham khảo.</p>
        </section>
      ) : (
        <div className="d3-wh-alert">Bạn chỉ có quyền xem Kho Tân Tạo; các form ghi nghiệp vụ và kiểm kê được ẩn.</div>
      )}

      <div className="d3-wh-grid">
        <section className="d3-wh-card d3-wh-chat" style={{ ["--i" as string]: 6 }}>
          <div className="d3-wh-card-h">
            <div className="flex items-center gap-3">
              <span className="d3-wh-spark"><Bot className="h-4 w-4" /></span>
              <div><h2>BMQ Agent</h2><small>Trợ lý nghiệp vụ Kho Tân Tạo</small></div>
            </div>
          </div>

          <div className="d3-wh-messages">
            <div className="d3-wh-msg is-agent">
              <img src={bmqLogo} alt="" />
              <p>Anh cứ nhắn nghiệp vụ. Em sẽ tự lập phiếu, ghi sổ kho và trả lại tồn trước/sau. Đơn NCC chỉ vào <strong>Hàng đang về</strong>; đơn khách chỉ <strong>giữ ATP</strong> cho đến khi xuất thực tế.</p>
            </div>
            {messages.map((message) => (
              <div key={message.id} className={`d3-wh-msg ${message.role === "user" ? "is-user" : "is-agent"}`}>
                {message.role === "agent" ? <img src={bmqLogo} alt="" /> : null}
                <p>{message.text}</p>
              </div>
            ))}
            {commandMutation.isPending ? <div className="d3-wh-typing">BMQ Agent đang lập chứng từ…</div> : null}
          </div>

          {canManageWarehouse ? (
            <div className="d3-wh-composer">
              <div className="d3-wh-chips">
                {examples.map((example) => (
                  <button key={example} type="button" onClick={() => setComposer(example)}>
                    {example}
                  </button>
                ))}
              </div>
              <div className="d3-wh-ask">
                <Textarea disabled={snapshotQuery.isLoading || snapshotQuery.isError} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendCommand(); } }} placeholder="Nhắn nghiệp vụ kho…" />
                <Button type="button" onClick={() => sendCommand()} disabled={!composer.trim() || commandMutation.isPending || snapshotQuery.isLoading || snapshotQuery.isError} aria-label="Gửi lệnh">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <p className="d3-wh-note">Chế độ xem: BMQ Agent không hiển thị nút ghi sổ cho tài khoản không có quyền quản lý.</p>
          )}
        </section>

        <section className="d3-wh-card" style={{ ["--i" as string]: 7 }}>
          <div className="d3-wh-card-h">
            <h2>Chứng từ gần đây</h2>
            <span className="d3-wh-pill">{recentDocuments.length}</span>
            <p>Phiếu được AI lập nhưng vẫn là dữ liệu nghiệp vụ chuẩn và có audit.</p>
          </div>
          {recentDocuments.length === 0 ? (
            <div className="d3-wh-empty">Chưa có chứng từ. Anh có thể bắt đầu bằng khai báo tồn đầu.</div>
          ) : (
            <ul className="d3-wh-tl">
              {recentDocuments.map((document, k) => (
                <li key={document.id} className={k === 0 ? "is-now" : "is-done"} style={{ ["--dl" as string]: `${300 + k * 100}ms` }}>
                  <i aria-hidden="true" />
                  <small>{new Date(document.created_at).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" })} · {new Date(document.created_at).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" })} · {document.status}</small>
                  <b>{documentLabel[document.document_type] || document.document_type} {document.document_number}</b>
                  <span>
                    {qty(document.physical_quantity || document.quantity)} {selectedStockCountItem.unit} · {document.reference_label || "BMQ Agent"}
                  </span>
                  {document.document_type === "outbound_order" ? <span>Đặt {qty(document.ordered_quantity)} · Đổi {qty(document.exchange_quantity)} · Bù {qty(document.makeup_quantity)}</span> : null}
                  {document.document_type === "supplier_order" && number(document.supplier_credit_quantity) > 0 ? (
                    <span>
                      Lò tính tiền {qty(document.supplier_billable_quantity)} · Khấu trừ công nợ lò {qty(document.supplier_credit_quantity)}{" "}
                      (Đổi {qty(document.supplier_exchange_quantity)} · Bù {qty(document.supplier_makeup_quantity)})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
