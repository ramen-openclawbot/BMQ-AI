import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircle, Sparkles, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type AgentMessage = { role: "user" | "agent"; text: string };
type ModuleContext = { key: string; label: string; suggestions: string[] };
type CreateCustomerDraft = {
  customer_name: string;
  customer_group: string;
  product_group: string;
  emails: string[];
  kb_profile_name: string;
  kb_po_mode: string;
  kb_calc_notes: string | null;
  kb_ops_notes: string | null;
};

const moduleConfig: Array<{ test: (pathname: string) => boolean; context: ModuleContext }> = [
  { test: (p) => p === "/mini-crm", context: { key: "crm", label: "CRM", suggestions: ["Tạo khách hàng Vietjet Test email ops@vietjet.vn", "Checklist setup customer", "Tóm tắt module này"] } },
  { test: (p) => p === "/sales-po-inbox", context: { key: "sales_po", label: "Sales PO Inbox", suggestions: ["Tóm tắt PO đang chờ xử lý", "Checklist review delta trước khi post", "Giải thích auto-post an toàn"] } },
  { test: () => true, context: { key: "general", label: "Dashboard", suggestions: ["Tóm tắt màn hình hiện tại", "Đề xuất 3 việc nên làm tiếp", "Tạo checklist vận hành hôm nay"] } },
];

function getRouteContext(pathname: string): ModuleContext {
  if (pathname.startsWith("/invoices")) return { key: "invoices", label: "Hóa đơn", suggestions: ["Tìm hóa đơn thiếu sản phẩm", "Kiểm tra ảnh hóa đơn/UNC bị thiếu file", "Đề xuất xử lý lỗi tạo invoice từ PR"] };
  if (pathname.startsWith("/sku-costs")) return { key: "sku_costs", label: "SKU Costs", suggestions: ["Checklist cập nhật cost", "Tóm tắt cost anomalies", "Đề xuất kiểm tra tuần này"] };
  if (pathname.startsWith("/kho")) return { key: "warehouse", label: "Kho", suggestions: ["Checklist nhập kho", "Gợi ý kiểm tra tồn", "Tóm tắt thao tác theo ca"] };
  if (pathname === "/finance-control/cost") return { key: "finance_cost", label: "Finance / Cost", suggestions: ["Checklist cost", "KPI cost", "Cảnh báo bất thường"] };
  if (pathname === "/finance-control/revenue") return { key: "finance_revenue", label: "Finance / Revenue", suggestions: ["Checklist posting", "Đối soát doanh thu", "Báo cáo ngày"] };
  return moduleConfig.find((m) => m.test(pathname))!.context;
}

function parseCreateCustomerCommand(raw: string): { draft: CreateCustomerDraft; missing: string[] } {
  const text = String(raw || "").trim();
  const findValue = (keys: string[]) => {
    for (const k of keys) {
      const re = new RegExp(`(?:^|[;,\\n])\\s*${k}\\s*[:=]\\s*([^;\\n]+)`, "i");
      const m = text.match(re);
      if (m?.[1]) return String(m[1]).trim();
    }
    return "";
  };

  const inferredName = (() => {
    const m1 = text.match(/t[aạ]o\s+kh[aá]ch\s+h[aà]ng\s+([^,;\n]+)/i);
    if (m1?.[1]) return m1[1].trim();
    return "";
  })();

  const customerName = findValue(["ten", "tên", "name", "customer_name"]) || inferredName;
  const customerGroupRaw = findValue(["group", "nhom", "nhóm", "customer_group"]) || (/\bb2b\b/i.test(text) ? "b2b" : "");
  const productGroupRaw = findValue(["product_group", "nhom_sp"]) || (/b[aá]nh\s*m[iì]/i.test(text) ? "banhmi" : "");
  const poModeRaw = findValue(["po_mode", "mode", "kb_mode"]) || (/c[oộ]ng\s*d[oồ]n|cumulative/i.test(text) ? "cumulative" : "daily");
  const calcNotes = findValue(["calc", "calculation", "calculation_notes"]);
  const opsNotes = findValue(["ops", "operational", "operational_notes"]);

  const groupMap: Record<string, string> = { b2b: "b2b", banhmi_point: "banhmi_point", banhmi_agency: "banhmi_agency", online: "online" };
  const productMap: Record<string, string> = { banhmi: "banhmi", banhngot: "banhngot" };

  const directEmails = findValue(["email", "emails", "mail"]).split(/[;,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => /@/.test(s));
  const textEmails = Array.from(new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase())));
  const emails = Array.from(new Set([...directEmails, ...textEmails]));

  const missing: string[] = [];
  if (!customerName) missing.push("tên khách hàng");
  if (!emails.length) missing.push("ít nhất 1 email nhận diện");

  const draft: CreateCustomerDraft = {
    customer_name: customerName,
    customer_group: groupMap[String(customerGroupRaw || "").trim().toLowerCase()] || "b2b",
    product_group: productMap[String(productGroupRaw || "").trim().toLowerCase()] || "banhmi",
    emails,
    kb_profile_name: `${customerName || "Customer"} Knowledge`,
    kb_po_mode: String(poModeRaw || "").toLowerCase().includes("cum") ? "cumulative_snapshot" : "daily_new_po",
    kb_calc_notes: calcNotes || null,
    kb_ops_notes: opsNotes || null,
  };

  return { draft, missing };
}

async function getNextKnowledgeProfileVersion(customerId: string) {
  const { data, error } = await (supabase as any)
    .from("mini_crm_knowledge_profile_versions")
    .select("version_no")
    .eq("customer_id", customerId)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.version_no || 0) + 1;
}

export function GlobalAgentChatWidget() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [pendingCreateDraft, setPendingCreateDraft] = useState<CreateCustomerDraft | null>(null);
  const [pendingMissing, setPendingMissing] = useState<string[]>([]);
  const [executionArmed, setExecutionArmed] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);

  const routeContext = useMemo(() => getRouteContext(location.pathname), [location.pathname]);

  const pushAgent = (text: string) => setMessages((prev) => [...prev, { role: "agent", text }]);

  const executeCreateCustomer = async () => {
    if (!pendingCreateDraft) return;
    setIsExecuting(true);
    let createdCustomerId: string | null = null;
    try {
      const { data: created, error: createError } = await (supabase as any)
        .from("mini_crm_customers")
        .insert({
          customer_name: pendingCreateDraft.customer_name,
          customer_group: pendingCreateDraft.customer_group,
          product_group: pendingCreateDraft.product_group,
          is_active: true,
        })
        .select("id, customer_name")
        .single();
      if (createError || !created?.id) throw createError || new Error("Không tạo được khách hàng");
      createdCustomerId = created.id;

      if (pendingCreateDraft.emails.length) {
        const { error } = await (supabase as any)
          .from("mini_crm_customer_emails")
          .insert(pendingCreateDraft.emails.map((email, idx) => ({ customer_id: created.id, email, is_primary: idx === 0 })));
        if (error) throw error;
      }

      const { data: kbInserted, error: kbError } = await (supabase as any)
        .from("mini_crm_knowledge_profiles")
        .insert({
          customer_id: created.id,
          profile_name: pendingCreateDraft.kb_profile_name,
          po_mode: pendingCreateDraft.kb_po_mode,
          profile_status: "active",
          calculation_notes: pendingCreateDraft.kb_calc_notes,
          operational_notes: pendingCreateDraft.kb_ops_notes,
        })
        .select("id,profile_name,po_mode,profile_status,calculation_notes,operational_notes")
        .single();
      if (kbError) throw kbError;

      const versionNo = await getNextKnowledgeProfileVersion(created.id);
      const { error: verError } = await (supabase as any)
        .from("mini_crm_knowledge_profile_versions")
        .insert({
          customer_id: created.id,
          knowledge_profile_id: kbInserted?.id || null,
          version_no: versionNo,
          profile_name: kbInserted?.profile_name || pendingCreateDraft.kb_profile_name,
          po_mode: kbInserted?.po_mode || pendingCreateDraft.kb_po_mode,
          profile_status: kbInserted?.profile_status || "active",
          calculation_notes: kbInserted?.calculation_notes || pendingCreateDraft.kb_calc_notes || null,
          operational_notes: kbInserted?.operational_notes || pendingCreateDraft.kb_ops_notes || null,
          changed_by: "agent-ui-global",
          change_note: "Created from Global Agent Chat",
          is_active: true,
          effective_from: new Date().toISOString(),
        });
      if (verError) throw verError;

      await queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] });
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profiles"] });
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profile-versions"] });

      pushAgent(`✅ Đã tạo khách hàng ${created.customer_name} thành công từ Global Chat.`);
      setPendingCreateDraft(null);
      setPendingMissing([]);
      setExecutionArmed(false);
    } catch (e: any) {
      if (createdCustomerId) {
        await (supabase as any).from("mini_crm_customers").delete().eq("id", createdCustomerId);
      }
      pushAgent(`❌ Tạo khách hàng thất bại. Đã rollback nếu có dữ liệu tạm. Lỗi: ${e?.message || "Không rõ"}`);
    } finally {
      setIsExecuting(false);
    }
  };

  const sendMessage = (text?: string) => {
    const content = String(text ?? draft).trim();
    if (!content) return;
    setMessages((prev) => [...prev, { role: "user", text: content }]);
    setDraft("");

    if (routeContext.key === "crm" && /t[aạ]o\s+kh[aá]ch\s+h[aà]ng|customer/i.test(content)) {
      const { draft: parsed, missing } = parseCreateCustomerCommand(content);
      setPendingCreateDraft(parsed);
      setPendingMissing(missing);
      setExecutionArmed(false);
      if (missing.length) {
        pushAgent(`Em đã parse intent tạo khách hàng nhưng còn thiếu: ${missing.join(", ")}. Anh nhập lại đủ thông tin giúp em.`);
      } else {
        pushAgent(
          `Em đã chuẩn bị execution plan tạo khách hàng:\n- Tên: ${parsed.customer_name}\n- Group: ${parsed.customer_group}\n- Product: ${parsed.product_group}\n- Emails: ${parsed.emails.join(", ")}\n- PO mode: ${parsed.kb_po_mode}\nAnh bấm 'Confirm kế hoạch' rồi 'Thực thi ngay'.`
        );
      }
      return;
    }

    const lower = content.toLowerCase();
    if (lower.includes("tóm tắt")) {
      pushAgent(`Em đang ở ngữ cảnh ${routeContext.label}. Em có thể hỗ trợ checklist, parse intent, và execution plan theo module này.`);
      return;
    }
    if (lower.includes("checklist")) {
      pushAgent(`Checklist nhanh cho ${routeContext.label}: 1) kiểm tra dữ liệu đầu vào, 2) preview plan, 3) confirm, 4) execute + audit.`);
      return;
    }
    pushAgent(`Em đã nhận yêu cầu trong ngữ cảnh ${routeContext.label}. Anh có thể dùng quick actions hoặc mô tả mục tiêu cụ thể hơn.`);
  };

  return (
    <>
      <Button
        type="button"
        size="icon"
        className={cn("fixed z-50 right-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom))]", "h-14 w-14 rounded-full shadow-lg", "bg-primary text-primary-foreground hover:bg-primary/90")}
        onClick={() => setOpen(true)}
        aria-label="Mở AI Agent Chat"
      >
        <MessageCircle className="h-6 w-6" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-[92vw] sm:max-w-[420px] p-0 flex flex-col">
          <SheetHeader className="px-4 pt-4 pb-3 border-b">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-primary/10 text-primary grid place-items-center"><Sparkles className="h-4 w-4" /></div>
                <div>
                  <SheetTitle className="text-base">AI Agent</SheetTitle>
                </div>
              </div>
              <Button type="button" size="icon" variant="ghost" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-auto p-4 space-y-3 text-sm">
            {messages.length === 0 && <div className="rounded-lg border bg-muted/30 p-3">Kính chào Quý khách. Hệ thống đã nhận diện ngữ cảnh hiện tại là <b>{routeContext.label}</b>. Vui lòng nhập yêu cầu để AI Agent hỗ trợ.</div>}

            {messages.map((m, idx) => (
              <div key={`${m.role}-${idx}`} className={cn("rounded-lg border p-3 whitespace-pre-wrap", m.role === "user" ? "bg-primary/5" : "bg-background")}>
                <div className="text-xs text-muted-foreground mb-1">{m.role === "user" ? "Anh" : "Agent"}</div>
                {m.text}
              </div>
            ))}

            {pendingCreateDraft && routeContext.key === "crm" && (
              <div className="rounded-lg border p-3 space-y-2">
                <div className="text-xs text-muted-foreground">Execution plan (CRM)</div>
                <div>Tạo customer: <b>{pendingCreateDraft.customer_name || "-"}</b></div>
                <div>Email: <b>{pendingCreateDraft.emails.join(", ") || "-"}</b></div>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm" variant="secondary" onClick={() => setExecutionArmed(true)} disabled={pendingMissing.length > 0}>Confirm kế hoạch</Button>
                  <Button size="sm" onClick={executeCreateCustomer} disabled={!executionArmed || pendingMissing.length > 0 || isExecuting}>
                    {isExecuting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Đang chạy</> : "Thực thi ngay"}
                  </Button>
                </div>
                {pendingMissing.length > 0 && <div className="text-amber-600 text-xs">Thiếu: {pendingMissing.join(", ")}</div>}
              </div>
            )}

            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground mb-2">Quick actions theo module</div>
              <div className="flex flex-wrap gap-2">
                {routeContext.suggestions.map((s) => <Button key={s} type="button" size="sm" variant="outline" onClick={() => sendMessage(s)}>{s}</Button>)}
              </div>
            </div>
          </div>

          <div className="border-t p-3 space-y-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Nhập yêu cầu cho AI Agent..."
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendMessage();
                }
              }}
            />
            <Button type="button" className="w-full" variant="secondary" onClick={() => sendMessage()}>Gửi</Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
