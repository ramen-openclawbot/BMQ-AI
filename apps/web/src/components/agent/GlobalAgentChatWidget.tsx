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

const routeLabelMap: Record<string, string> = {
  "/": "Dashboard",
  "/inventory": "Tồn kho",
  "/suppliers": "Nhà cung cấp",
  "/invoices": "Hóa đơn",
  "/payment-requests": "Yêu cầu thanh toán",
  "/goods-receipts": "Nhập kho",
  "/purchase-orders": "Đơn mua hàng",
  "/low-stock": "Tồn thấp",
  "/reports": "Báo cáo",
  "/niraan-dashboard": "Niraan Dashboard",
  "/mini-crm": "CRM",
  "/sales-po-inbox": "Sales PO Inbox",
  "/settings": "Cài đặt",
  "/finance-control/cost": "Finance Control / Cost",
  "/finance-control/revenue": "Finance Control / Revenue",
};

function getContextLabel(pathname: string) {
  if (pathname.startsWith("/sku-costs")) return "SKU Costs";
  if (pathname.startsWith("/kho")) return "Kho";
  return routeLabelMap[pathname] || pathname;
}

export function GlobalAgentChatWidget() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const contextLabel = useMemo(() => getContextLabel(location.pathname), [location.pathname]);

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
                    Ngữ cảnh hiện tại: <span className="font-medium text-foreground">{contextLabel}</span>
                  </SheetDescription>
                </div>
              </div>
              <Button type="button" size="icon" variant="ghost" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-auto p-4 space-y-3 text-sm">
            <div className="rounded-lg border bg-muted/30 p-3">
              Xin chào anh Tâm, em đang ở chế độ Phase 1 (UI shell). Em đã nhận diện module hiện tại là <b>{contextLabel}</b>.
            </div>
            <div className="rounded-lg border p-3">
              Gợi ý nhanh:
              <ul className="mt-2 list-disc pl-4 text-muted-foreground">
                <li>"Tóm tắt màn hình này"</li>
                <li>"Đề xuất 3 thao tác nên làm tiếp"</li>
                <li>"Chuẩn bị lệnh tạo dữ liệu mẫu để test"</li>
              </ul>
            </div>
          </div>

          <div className="border-t p-3 space-y-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Nhập yêu cầu cho AI Agent..."
            />
            <Button type="button" className="w-full" variant="secondary" disabled>
              Gửi (sẽ bật ở Phase 2)
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
