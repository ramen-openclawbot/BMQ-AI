import { useEffect, useState } from "react";
import { FlaskConical, PlayCircle, Paperclip, FileText, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import type { KbAiParseSuggestion } from "./kbAiUtils";
import { parseEmailBodyToProductionItems } from "./emailBodyParseUtils";

type ParseMode = "email_body" | "attachment";

type WorkbenchResult = {
  source: "email_body" | "attachment";
  sourceLabel: string;
  items: {
    product_name: string;
    qty_base: number;
    qty_exchange: number;
    qty_total: number;
    note?: string;
  }[];
  confidence: number;
  deliveryDate?: string | null;
};

type Props = {
  customerPos: any[];
  kbAiSuggestion: KbAiParseSuggestion | null;
};

function deriveParseModeFromStrategy(strategy?: string | null): ParseMode {
  if (strategy === "attachment_first") return "attachment";
  return "email_body";
}

export function ParseTestWorkbench({ customerPos, kbAiSuggestion }: Props) {
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);
  const [parseMode, setParseMode] = useState<ParseMode>(
    deriveParseModeFromStrategy(kbAiSuggestion?.parse_strategy),
  );
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<WorkbenchResult | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);

  // Sync mode when kbAiSuggestion changes (e.g. user edits KB config)
  useEffect(() => {
    setParseMode(deriveParseModeFromStrategy(kbAiSuggestion?.parse_strategy));
    setResult(null);
    setAttachError(null);
  }, [kbAiSuggestion?.parse_strategy]);

  const selectedPo = customerPos.find((p) => p.id === selectedPoId) ?? null;

  const showModeToggle = kbAiSuggestion?.parse_strategy !== "email_body_only";

  const runEmailBodyParse = () => {
    if (!selectedPo) return;
    const body = selectedPo.body_preview || selectedPo.raw_payload?.snippet || "";
    const parsed = parseEmailBodyToProductionItems(selectedPo.email_subject, body, kbAiSuggestion);
    const items = parsed.items.map((item: any) => ({
      product_name: String(item.product_name || ""),
      qty_base: Number(item.qty_base ?? 0),
      qty_exchange: Number(item.qty_exchange ?? 0),
      qty_total: Number(item.qty_total ?? item.qty ?? 0),
      note: item.note || undefined,
    }));
    setResult({
      source: "email_body",
      sourceLabel: "Nội dung email",
      items,
      confidence: Number(parsed.confidence ?? 0),
      deliveryDate: parsed.deliveryDate,
    });
    setAttachError(null);
  };

  const runAttachmentParse = async () => {
    if (!selectedPo) return;
    setIsRunning(true);
    setAttachError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("Phiên đăng nhập hết hạn — vui lòng đăng nhập lại");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-parse-inbox-order`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ inboxId: selectedPo.id }),
        },
      );
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || `Lỗi server (${response.status})`);
      }

      const parsedItems: any[] = Array.isArray(json?.parsed?.items) ? json.parsed.items : [];
      const sourceFile = json?.parsed?.xlsx || json?.parsed?.pdf || null;
      const sourceLabel = sourceFile
        ? `File đính kèm — ${sourceFile}`
        : "File đính kèm";

      const items = parsedItems.map((item: any) => ({
        product_name: String(item.product_name || item.sku || ""),
        qty_base: Number(item.qty ?? 0),
        qty_exchange: 0,
        qty_total: Number(item.qty ?? 0),
        note: item.unit ? `${item.unit}${item.unit_price ? ` · ${item.unit_price.toLocaleString("vi-VN")}₫` : ""}` : undefined,
      }));

      const confidence = parsedItems.length > 0 ? 0.9 : 0;
      setResult({
        source: "attachment",
        sourceLabel,
        items,
        confidence,
        deliveryDate: null,
      });
    } catch (err: any) {
      setAttachError(err?.message || "Không parse được file đính kèm");
      setResult(null);
    } finally {
      setIsRunning(false);
    }
  };

  const runTest = () => {
    if (parseMode === "attachment") {
      runAttachmentParse();
    } else {
      runEmailBodyParse();
    }
  };

  const confidence = result?.confidence ?? 0;
  const passGuidance =
    result == null
      ? null
      : confidence >= 0.8
        ? { text: "Parse tốt — đủ tin tưởng để lưu & áp dụng KB.", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" }
        : confidence >= 0.5
          ? { text: "Parse được một phần — nên xem lại rule split và pattern trước khi lưu.", cls: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" }
          : { text: "Parse yếu — cần điều chỉnh KB (split rule, pattern) rồi thử lại.", cls: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300" };

  if (customerPos.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 bg-background/60 px-4 py-5 text-sm">
        <div className="flex items-center gap-2 font-semibold text-foreground mb-1.5">
          <FlaskConical className="h-4 w-4 text-primary" />
          Workbench test parse
        </div>
        <p className="text-muted-foreground">
          Chưa có PO nào của khách hàng này trong hệ thống. Sau khi nhận PO thực tế, anh/chị có thể chọn và test parse tại đây.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/70 bg-background/80 p-4 shadow-sm space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <FlaskConical className="h-4 w-4 text-primary" />
        Workbench test parse — PO thực tế của khách
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Chọn một PO thực tế bên dưới để chạy parse thử với KB/AI config đang draft. Kết quả không ảnh hưởng dữ liệu.
      </p>

      {/* Mode toggle */}
      {showModeToggle && (
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => { setParseMode("email_body"); setResult(null); setAttachError(null); }}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              parseMode === "email_body"
                ? "border-primary/60 bg-primary/5 text-primary"
                : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            Nội dung email
          </button>
          <button
            type="button"
            onClick={() => { setParseMode("attachment"); setResult(null); setAttachError(null); }}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              parseMode === "attachment"
                ? "border-primary/60 bg-primary/5 text-primary"
                : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            }`}
          >
            <Paperclip className="h-3.5 w-3.5" />
            File đính kèm
          </button>
        </div>
      )}

      {/* PO selector */}
      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Chọn PO để test ({customerPos.length} PO gần nhất)
        </div>
        <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
          {customerPos.slice(0, 10).map((po) => {
            const isSelected = po.id === selectedPoId;
            return (
              <button
                key={po.id}
                type="button"
                onClick={() => {
                  setSelectedPoId(po.id);
                  setResult(null);
                  setAttachError(null);
                }}
                className={`w-full text-left rounded-lg border px-3 py-2 text-sm transition-colors ${
                  isSelected
                    ? "border-primary/60 bg-primary/5 text-foreground"
                    : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                }`}
              >
                <div className="font-medium truncate">{po.email_subject || "(không có tiêu đề)"}</div>
                <div className="text-xs mt-0.5 flex flex-wrap gap-3">
                  {po.from_email && <span>{po.from_email}</span>}
                  {po.received_at && (
                    <span>{new Date(po.received_at).toLocaleDateString("vi-VN")}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected PO summary + run button */}
      {selectedPo && (
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-3 space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Tóm tắt PO đã chọn
          </div>
          <div className="text-sm font-medium text-foreground leading-5">
            {selectedPo.email_subject || "(không có tiêu đề)"}
          </div>
          {selectedPo.from_email && (
            <div className="text-xs text-muted-foreground">Từ: {selectedPo.from_email}</div>
          )}
          {selectedPo.received_at && (
            <div className="text-xs text-muted-foreground">
              Nhận: {new Date(selectedPo.received_at).toLocaleString("vi-VN")}
            </div>
          )}
          {parseMode === "email_body" && (selectedPo.body_preview || selectedPo.raw_payload?.snippet) && (
            <div className="text-xs leading-5 text-foreground/80 line-clamp-3 rounded bg-background/60 border border-border/40 px-2 py-1.5">
              {selectedPo.body_preview || selectedPo.raw_payload?.snippet}
            </div>
          )}
          {parseMode === "attachment" && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Paperclip className="h-3 w-3" />
              Sẽ gọi edge function parse file đính kèm của PO này
            </div>
          )}
          <div className="flex justify-end pt-1">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={runTest}
              disabled={isRunning}
            >
              <PlayCircle className="mr-1.5 h-4 w-4" />
              {isRunning ? "Đang parse..." : "Chạy test parse trên PO này"}
            </Button>
          </div>
        </div>
      )}

      {/* Attachment error */}
      {attachError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Parse file đính kèm thất bại</div>
            <div className="text-xs mt-0.5 opacity-80">{attachError}</div>
          </div>
        </div>
      )}

      {/* Parse results */}
      {result && (
        <div className="space-y-3">
          {/* Source badge */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {result.source === "attachment" ? (
              <Paperclip className="h-3.5 w-3.5" />
            ) : (
              <FileText className="h-3.5 w-3.5" />
            )}
            <span>Nguồn: <span className="font-medium text-foreground">{result.sourceLabel}</span></span>
          </div>

          {passGuidance && (
            <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${passGuidance.cls}`}>
              Confidence: {Math.round(confidence * 100)}% — {passGuidance.text}
            </div>
          )}

          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Dòng hàng parse được ({result.items.length} dòng)
            </div>
            {result.items.length > 0 ? (
              result.items.map((item, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
                >
                  <div className="font-medium text-foreground">{item.product_name || "-"}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {result.source === "email_body" ? (
                      <>
                        Cơ bản: {item.qty_base ?? 0}
                        {Number(item.qty_exchange) > 0 && <> · Đổi: {item.qty_exchange}</>}
                        {" · "}Tổng:{" "}
                        <span className="font-medium text-foreground">{item.qty_total ?? 0}</span>
                        {item.note ? <> · {item.note}</> : null}
                      </>
                    ) : (
                      <>
                        Số lượng:{" "}
                        <span className="font-medium text-foreground">{item.qty_total ?? 0}</span>
                        {item.note ? <> · {item.note}</> : null}
                      </>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border/70 bg-background/70 px-3 py-3 text-sm text-muted-foreground">
                {result.source === "attachment"
                  ? "Không parse ra dòng nào từ file đính kèm — file có thể chưa có hoặc không đúng định dạng."
                  : "Không parse ra dòng nào — kiểm tra lại split rule và location/quantity pattern trong KB."}
              </div>
            )}
          </div>

          {result.deliveryDate && (
            <div className="text-xs text-muted-foreground">
              Ngày giao hàng trích từ subject:{" "}
              <span className="font-medium text-foreground">{result.deliveryDate}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
