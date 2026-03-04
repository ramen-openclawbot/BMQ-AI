import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { MessageCircle, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type AgentMessage = {
  role: "user" | "agent";
  text: string;
};

type ModuleContext = {
  key: string;
  label: string;
  suggestions: string[];
};

const moduleConfig: Array<{ test: (pathname: string) => boolean; context: ModuleContext }> = [
  {
    test: (p) => p === "/mini-crm",
    context: {
      key: "crm",
      label: "CRM",
      suggestions: [
        "Tạo khách hàng mới để test",
        "Gợi ý dữ liệu KB profile chuẩn",
        "Liệt kê checklist setup customer",
      ],
    },
  },
  {
    test: (p) => p === "/sales-po-inbox",
    context: {
      key: "sales_po",
      label: "Sales PO Inbox",
      suggestions: [
        "Tóm tắt PO đang chờ xử lý",
        "Giải thích điều kiện auto-post an toàn",
        "Checklist review delta trước khi post",
      ],
    },
  },
  {
    test: (p) => p === "/finance-control/revenue",
    context: {
      key: "finance_revenue",
      label: "Finance Control / Revenue",
      suggestions: [
        "Giải thích luồng đối soát doanh thu",
        "Tạo checklist kiểm tra posting",
        "Đề xuất báo cáo cần theo dõi mỗi ngày",
      ],
    },
  },
  {
    test: (p) => p === "/finance-control/cost",
    context: {
      key: "finance_cost",
      label: "Finance Control / Cost",
      suggestions: [
        "Tóm tắt các KPI cost cần theo dõi",
        "Checklist kiểm tra chứng từ đầu ngày",
        "Gợi ý cảnh báo cost bất thường",
      ],
    },
  },
  {
    test: (p) => p.startsWith("/sku-costs"),
    context: {
      key: "sku_costs",
      label: "SKU Costs",
      suggestions: [
        "Giải thích cấu trúc costing theo SKU",
        "Checklist cập nhật định mức nguyên liệu",
        "Đề xuất kiểm tra sai lệch cost tuần này",
      ],
    },
  },
  {
    test: (p) => p.startsWith("/kho"),
    context: {
      key: "warehouse",
      label: "Kho",
      suggestions: [
        "Checklist nhập kho trong ngày",
        "Gợi ý kiểm tra tồn bất thường",
        "Tóm tắt thao tác kho theo ca",
      ],
    },
  },
  {
    test: () => true,
    context: {
      key: "general",
      label: "Dashboard",
      suggestions: [
        "Tóm tắt màn hình hiện tại",
        "Đề xuất 3 việc nên làm tiếp",
        "Tạo checklist vận hành hôm nay",
      ],
    },
  },
];

function getRouteContext(pathname: string): ModuleContext {
  return moduleConfig.find((m) => m.test(pathname))!.context;
}

function buildSelectedEntity(search: string) {
  const q = new URLSearchParams(search);
  const selected = {
    customerId: q.get("customerId") || q.get("customer_id") || null,
    poId: q.get("poId") || q.get("po_id") || null,
    recordId: q.get("id") || null,
  };
  return selected;
}

function generateContextAwareReply(input: string, context: ModuleContext, selectedEntity: ReturnType<typeof buildSelectedEntity>) {
  const lower = input.toLowerCase();
  const selectedText = selectedEntity.customerId || selectedEntity.poId || selectedEntity.recordId
    ? `\n- Bản ghi đang chọn: ${selectedEntity.customerId || selectedEntity.poId || selectedEntity.recordId}`
    : "";

  if (lower.includes("tóm tắt") || lower.includes("summary")) {
    return `Em đang hiểu ngữ cảnh là **${context.label}**.${selectedText}\n- Mục tiêu chính: thao tác đúng quy trình của module này\n- Em có thể hỗ trợ: hướng dẫn bước, chuẩn bị lệnh thao tác, checklist kiểm tra trước khi execute.`;
  }

  if (lower.includes("checklist")) {
    return `Checklist nhanh cho **${context.label}**:${selectedText}\n1) Xác nhận dữ liệu đầu vào\n2) Review thay đổi/điều kiện an toàn\n3) Confirm trước khi ghi dữ liệu\n4) Kiểm tra kết quả + audit log.`;
  }

  if (lower.includes("tạo khách") || lower.includes("khách hàng")) {
    return `Em đã nhận intent liên quan tạo/cập nhật khách hàng trong ngữ cảnh **${context.label}**.${selectedText}\nAnh có thể nhập theo dạng tự nhiên, em sẽ parse -> preview -> confirm -> execute.`;
  }

  return `Em đã nhận yêu cầu trong ngữ cảnh **${context.label}**.${selectedText}\nGợi ý tiếp theo: chọn một quick action bên dưới hoặc nói rõ mục tiêu để em chuẩn bị execution plan.`;
}

export function GlobalAgentChatWidget() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);

  const routeContext = useMemo(() => getRouteContext(location.pathname), [location.pathname]);
  const selectedEntity = useMemo(() => buildSelectedEntity(location.search), [location.search]);

  const sendMessage = (text?: string) => {
    const content = String(text ?? draft).trim();
    if (!content) return;

    const userMessage: AgentMessage = { role: "user", text: content };
    const agentMessage: AgentMessage = {
      role: "agent",
      text: generateContextAwareReply(content, routeContext, selectedEntity),
    };

    setMessages((prev) => [...prev, userMessage, agentMessage]);
    setDraft("");
  };

  return (
    <>
      <Button
        type="button"
        size="icon"
        className={cn(
          "fixed z-50 right-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom))]",
          "h-14 w-14 rounded-full shadow-lg",
          "bg-primary text-primary-foreground hover:bg-primary/90"
        )}
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
                <div className="h-8 w-8 rounded-full bg-primary/10 text-primary grid place-items-center">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div>
                  <SheetTitle className="text-base">AI Agent</SheetTitle>
                  <SheetDescription className="text-xs">
                    Ngữ cảnh hiện tại: <span className="font-medium text-foreground">{routeContext.label}</span>
                  </SheetDescription>
                </div>
              </div>
              <Button type="button" size="icon" variant="ghost" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-auto p-4 space-y-3 text-sm">
            {messages.length === 0 && (
              <div className="rounded-lg border bg-muted/30 p-3">
                Xin chào anh Tâm, em đã nhận diện module hiện tại là <b>{routeContext.label}</b>.
              </div>
            )}

            {messages.map((m, idx) => (
              <div
                key={`${m.role}-${idx}`}
                className={cn(
                  "rounded-lg border p-3 whitespace-pre-wrap",
                  m.role === "user" ? "bg-primary/5" : "bg-background"
                )}
              >
                <div className="text-xs text-muted-foreground mb-1">{m.role === "user" ? "Anh" : "Agent"}</div>
                {m.text}
              </div>
            ))}

            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground mb-2">Quick actions theo module</div>
              <div className="flex flex-wrap gap-2">
                {routeContext.suggestions.map((s) => (
                  <Button key={s} type="button" size="sm" variant="outline" onClick={() => sendMessage(s)}>
                    {s}
                  </Button>
                ))}
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
            <Button type="button" className="w-full" variant="secondary" onClick={() => sendMessage()}>
              Gửi
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
