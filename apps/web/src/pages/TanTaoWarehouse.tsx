import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, Clock3, Menu, PackageCheck, Send, Warehouse } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
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

const commandArgs = (command: TanTaoWarehouseCommand, idempotencyKey: string) => ({
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
  const submissionLockRef = useRef(false);

  const snapshotQuery = useQuery({
    queryKey: ["tan-tao-warehouse-snapshot"],
    queryFn: async () => {
      const { data, error } = await warehouseRpc("get_tan_tao_warehouse_snapshot");
      if (error) throw new Error(error.message);
      return data as WarehouseSnapshot;
    },
  });

  const snapshot = snapshotQuery.data;
  const recentDocuments = useMemo(() => snapshot?.recent_documents || [], [snapshot]);

  const commandMutation = useMutation({
    mutationFn: async ({ command, raw, idempotencyKey }: { command: TanTaoWarehouseCommand; raw: string; idempotencyKey: string }) => {
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
    if (snapshotQuery.isLoading || snapshotQuery.isError) return;
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
          text: "Em chưa nhận diện được nghiệp vụ. Anh có thể khai báo tồn đầu, đặt Tuyết Anh, xác nhận đã nhận, nhập đơn Đặt/Đổi/Bù hoặc kiểm kê thực tế.",
        },
      ]);
      return;
    }
    submissionLockRef.current = true;
    commandMutation.mutate({ command: parsed, raw, idempotencyKey: `trusted-chat:${crypto.randomUUID()}` });
  };

  const examples = [
    "Tồn đầu BMQ-001 350 que",
    "Đặt Tuyết Anh 2480",
    "Đã nhận đủ 2480 que",
    "Anh Thanh đặt 780 đổi 16 bù 101",
    "Kiểm kê thực tế còn 172 que",
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
              <p className="truncate text-xs font-medium text-[#817278] sm:text-sm">BMQ-001 · Bánh mì que Pate · Sổ kho do BMQ Agent vận hành</p>
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
                    <div><span className="text-[#817278]">Số lượng</span><div className="font-black">{qty(document.physical_quantity || document.quantity)} que</div></div>
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
