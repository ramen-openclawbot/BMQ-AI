/* Tạo chi tiền mặt: a dedicated form for small cash expenses. Each invoice photo becomes one
 * khoản (scan-invoice → cashLineFromScan); khoản without an invoice are typed by hand. The phiếu
 * is created as cash, no supplier, no warehouse receipt (create_cash_payment_request), then the
 * invoices are stored as Chứng từ kèm theo. It then follows the cash flow: Zalo → CEO pays →
 * staff uploads the small receipts.
 */
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Banknote, ImagePlus, Loader2, Plus, ScanLine, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useCreateCashPaymentRequest } from "@/hooks/useCreateCashPaymentRequest";
import { useAuth } from "@/contexts/AuthContext";
import { SalaryPayoutCreate } from "@/components/payment-requests/SalaryPayoutCreate";
import { cashLineFromScan, validateCashPrForm } from "@/lib/cash-pr-lines";
import { scanInvoiceFile } from "@/lib/scan-invoice-client";
import "@/styles/bmq-unc-approval.css";
import "@/styles/bmq-unc-bulk.css";
import "@/styles/bmq-cash-settlement.css";

const vnd = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;
const ddmm = () => {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()); // YYYY-MM-DD
  return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
};

interface Line {
  key: string;
  name: string;
  amount: string;
  category: string;
  /** 1-based invoice number this khoản was read from. */
  invoice: number | null;
  note: string | null;
}

interface Invoice {
  file: File;
  preview: string;
  read: "idle" | "reading" | "done" | "error";
}

let lineSeq = 0;
const newLine = (partial: Partial<Line> = {}): Line => ({
  key: `l${(lineSeq += 1)}`,
  name: "",
  amount: "",
  category: "",
  invoice: null,
  note: null,
  ...partial,
});

function useCostCategoryOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["cost-categories-active"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cost_categories")
        .select("code,label,sort_order")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((c) => ({ code: c.code as string, label: c.label as string }));
    },
  });
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CashPaymentRequestDialog({ open, onOpenChange }: Props) {
  const { create, resetSessionKey } = useCreateCashPaymentRequest();
  const { isOwner, canEditModule } = useAuth();
  // Chi lương is only offered to the owner and users with the Chi lương permission.
  const canSalary = isOwner || canEditModule("salary_cash");
  const [mode, setMode] = useState<"cash" | "salary">("cash");
  const { data: categories } = useCostCategoryOptions(open);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const errorsRef = useRef<HTMLParagraphElement>(null);

  // The error line sits at the end of a long scrolling form, under the sticky footer: also
  // show a toast and scroll it into view so pressing the button never looks like nothing happened.
  const showErrors = (messages: string[]) => {
    setErrors(messages);
    if (messages.length) {
      toast.error(messages.length > 1 ? `${messages[0]} (+${messages.length - 1} lỗi khác)` : messages[0]);
      requestAnimationFrame(() => errorsRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
    }
  };

  const reset = () => {
    setTitle("");
    setDescription("");
    setInvoices([]);
    setLines([newLine()]);
    setErrors([]);
    setTried(false);
    setMode("cash");
    resetSessionKey();
  };

  const close = (next: boolean) => {
    if (!next && (scanning || saving)) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const pickInvoices = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/") || f.type === "");
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () =>
        setInvoices((prev) => [...prev, { file, preview: String(reader.result), read: "idle" as const }].slice(0, 20));
      reader.readAsDataURL(file);
    });
  };

  const removeInvoice = (index: number) => {
    setInvoices((prev) => prev.filter((_, i) => i !== index));
    // Khoản read from it stay (they may have been edited); just drop the link.
    setLines((prev) => prev.map((l) => (l.invoice === index + 1 ? { ...l, invoice: null } : l.invoice && l.invoice > index + 1 ? { ...l, invoice: l.invoice - 1 } : l)));
  };

  const unread = invoices.map((inv, i) => ({ inv, i })).filter(({ inv }) => inv.read !== "done");

  const readInvoices = async () => {
    if (unread.length === 0) return;
    setScanning(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error("Phiên đăng nhập đã hết. Đăng nhập lại rồi thử lại.");
        return;
      }
      const added: Line[] = [];
      const failed: number[] = [];
      let reason = "";
      for (const { inv, i } of unread) {
        setInvoices((prev) => prev.map((x, j) => (j === i ? { ...x, read: "reading" } : x)));
        try {
          const extracted = await scanInvoiceFile(inv.file, session.access_token);
          const line = cashLineFromScan(extracted, i);
          added.push(newLine({ name: line.name, amount: line.amount ? String(Math.round(line.amount)) : "", invoice: i + 1, note: line.amount ? null : "Chưa đọc được số tiền" }));
          setInvoices((prev) => prev.map((x, j) => (j === i ? { ...x, read: "done" } : x)));
        } catch (err) {
          failed.push(i + 1);
          if (!reason && err instanceof Error) reason = err.message;
          added.push(newLine({ name: `Hoá đơn ${i + 1}`, invoice: i + 1, note: "Chưa đọc được, nhập tay" }));
          setInvoices((prev) => prev.map((x, j) => (j === i ? { ...x, read: "error" } : x)));
        }
      }
      setLines((prev) => {
        // Re-reading an invoice fills its existing khoản only while that khoản has no amount yet.
        const kept = prev.filter((l) => l.name.trim() || l.amount);
        const next = [...kept];
        for (const line of added) {
          const at = next.findIndex((l) => l.invoice === line.invoice);
          if (at === -1) next.push(line);
          else if (!next[at].amount && line.amount) next[at] = { ...next[at], name: line.name, amount: line.amount, note: null };
        }
        return next;
      });
      if (!title.trim()) setTitle(`Chi tiền mặt ${ddmm()}`);
      if (failed.length) toast.error(`Chưa đọc được hoá đơn ${failed.join(", ")}${reason ? ` (${reason})` : ""}. Nhập tay số tiền.`);
    } finally {
      setScanning(false);
    }
  };

  const setLine = (key: string, patch: Partial<Line>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const items = useMemo(
    () =>
      lines
        .filter((l) => l.name.trim() || l.amount)
        .map((l) => ({ name: l.name.trim(), amount: Number(l.amount || 0), cost_category_code: l.category || null })),
    [lines],
  );
  const total = items.reduce((s, i) => s + (Number.isFinite(i.amount) ? i.amount : 0), 0);

  const save = async () => {
    const effectiveTitle = title.trim() || `Chi tiền mặt ${ddmm()}`;
    setTried(true);
    const check = validateCashPrForm({ title: effectiveTitle, description, items });
    if (!check.ok) {
      showErrors(check.messages);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const result = await create({
        title: effectiveTitle,
        description: description.trim() || null,
        items,
        invoiceFiles: invoices.map((i) => i.file),
      });
      toast.success(`Đã tạo ${result.request_number} · ${vnd(result.total)}. Phiếu đã gửi nhóm duyệt chi.`);
      if (result.attachmentsFailed) toast.warning("Chưa tải được ảnh hoá đơn lên. Mở phiếu để thêm lại.");
      reset();
      onOpenChange(false);
    } catch (err) {
      // Supabase errors are plain objects with a message, not Error instances.
      const message = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? "");
      showErrors([
        message.includes("insufficient_privilege")
          ? "Anh/chị chưa có quyền tạo phiếu chi."
          : message.includes("invalid_amount") || message.includes("amount_over_limit")
            ? "Có khoản chưa có số tiền hợp lệ (1 đến 50.000.000 đ)."
            : message || "Chưa tạo được phiếu. Thử lại.",
      ]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="d3-unc d3-ub d3-cpr"
        data-bmq-cash-pr-dialog
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader className="d3-unc-head text-left sm:text-left">
          <span className="d3-unc-tag">Chi tiền mặt</span>
          <DialogTitle className="d3-unc-title">Tạo chi tiền mặt</DialogTitle>
          <DialogDescription className="d3-unc-sub">
            {mode === "salary"
              ? "Lấy lương thực nhận từ bảng lương Q7. CEO chuyển tiền cho kế toán, kế toán nộp bank slip từng nhân viên."
              : "Mỗi hoá đơn là một khoản. Khoản không có hoá đơn thì thêm tay. Không cần nhà cung cấp, không nhập kho."}
          </DialogDescription>
        </DialogHeader>

        {canSalary && (
          <div className="d3-cpr-modes" role="tablist" aria-label="Loại chi tiền mặt">
            <button type="button" role="tab" aria-selected={mode === "cash"} className={mode === "cash" ? "is-on" : undefined} onClick={() => setMode("cash")} disabled={saving || scanning} data-bmq-cash-pr-mode="cash">
              Khoản chi lẻ
            </button>
            <button type="button" role="tab" aria-selected={mode === "salary"} className={mode === "salary" ? "is-on" : undefined} onClick={() => setMode("salary")} disabled={saving || scanning} data-bmq-cash-pr-mode="salary">
              Chi lương
            </button>
          </div>
        )}

        {mode === "salary" && canSalary ? (
          <SalaryPayoutCreate onDone={() => { reset(); onOpenChange(false); }} />
        ) : (
        <>

        <section className="d3-cs" aria-label="Hoá đơn">
          <div className="d3-cs-head"><h3>Hoá đơn{invoices.length ? ` · ${invoices.length}` : ""}</h3></div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            data-bmq-cash-pr-file
            onChange={(e) => {
              pickInvoices(e.target.files);
              e.currentTarget.value = "";
            }}
          />
          {invoices.length === 0 ? (
            <button type="button" className="d3-unc-drop" onClick={() => fileRef.current?.click()} data-bmq-cash-pr-pick>
              <ImagePlus className="h-6 w-6" />
              <span>Chọn ảnh hoá đơn</span>
              <small>Chọn nhiều ảnh một lần · có thể bỏ qua nếu không có hoá đơn</small>
            </button>
          ) : (
            <>
              <div className="d3-cpr-invoices" data-bmq-cash-pr-invoices={invoices.length}>
                {invoices.map((inv, i) => (
                  <figure key={i} className={`is-${inv.read}`}>
                    <img src={inv.preview} alt={`Hoá đơn ${i + 1}`} />
                    <figcaption>{inv.read === "reading" ? <Loader2 className="h-3 w-3 animate-spin" /> : i + 1}</figcaption>
                    <button type="button" aria-label={`Bỏ hoá đơn ${i + 1}`} onClick={() => removeInvoice(i)} disabled={scanning}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </figure>
                ))}
                <button type="button" className="d3-cpr-add" onClick={() => fileRef.current?.click()} disabled={scanning} aria-label="Thêm hoá đơn">
                  <Plus className="h-5 w-5" />
                  <span>Thêm</span>
                </button>
              </div>
              {unread.length > 0 && (
                <Button type="button" variant="outline" className="h-11 w-full gap-2" onClick={() => void readInvoices()} disabled={scanning} data-bmq-cash-pr-read>
                  {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
                  {scanning ? "Đang đọc hoá đơn…" : `Đọc ${unread.length} hoá đơn thành khoản chi`}
                </Button>
              )}
            </>
          )}
        </section>

        <section className="d3-cs" aria-label="Các khoản chi">
          <div className="d3-cs-head"><h3>Các khoản chi</h3></div>
          <ul className="d3-cpr-lines">
            {lines.map((l, idx) => (
              <li key={l.key} data-bmq-cash-pr-line={idx}>
                <div className="d3-cpr-line-top">
                  <span className="d3-cpr-tag">{l.invoice ? `HĐ ${l.invoice}` : "Tay"}</span>
                  <button type="button" className="d3-cs-x" aria-label="Bỏ khoản" onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((x) => x.key !== l.key) : [newLine()]))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <Input value={l.name} onChange={(e) => setLine(l.key, { name: e.target.value })} placeholder="Nội dung, ví dụ: Tiền nước Q7" maxLength={200} aria-label="Nội dung khoản" data-bmq-cash-pr-name />
                <div className="d3-cpr-line-row">
                  <Input
                    inputMode="numeric"
                    value={l.amount ? new Intl.NumberFormat("vi-VN").format(Number(l.amount)) : ""}
                    onChange={(e) => setLine(l.key, { amount: e.target.value.replace(/[^\d]/g, ""), note: null })}
                    placeholder="Số tiền"
                    aria-label="Số tiền"
                    data-bmq-cash-pr-amount
                  />
                  <select className="d3-cs-select" value={l.category} onChange={(e) => setLine(l.key, { category: e.target.value })} aria-label="Nhóm chi phí" data-bmq-cash-pr-category>
                    <option value="">Nhóm chi phí…</option>
                    {(categories ?? []).map((c) => (
                      <option key={c.code} value={c.code}>{c.label}</option>
                    ))}
                  </select>
                </div>
                {tried && l.name.trim() && !Number(l.amount) ? (
                  <small className="d3-cpr-note is-bad" data-bmq-cash-pr-missing-amount>Nhập số tiền cho khoản này</small>
                ) : l.note ? (
                  <small className="d3-cpr-note">{l.note}</small>
                ) : null}
              </li>
            ))}
          </ul>
          <Button type="button" variant="outline" className="h-11 w-full gap-2" onClick={() => setLines((prev) => [...prev, newLine()])} data-bmq-cash-pr-add-line>
            <Plus className="h-4 w-4" /> Thêm khoản không có hoá đơn
          </Button>
        </section>

        <section className="d3-cs" aria-label="Thông tin phiếu">
          <label className="d3-cc-f">
            <span className="d3-unc-label">Tiêu đề</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Chi tiền mặt ${ddmm()}`} maxLength={200} data-bmq-cash-pr-title />
          </label>
          <label className="d3-cc-f">
            <span className="d3-unc-label">Ghi chú (không bắt buộc)</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </label>
        </section>

        {errors.length > 0 && (
          <p ref={errorsRef} className="d3-ub-why is-bad" role="alert" data-bmq-cash-pr-errors>
            <TriangleAlert className="h-3.5 w-3.5" /> {errors.join(" ")}
          </p>
        )}

        <div className="d3-ub-foot">
          <p>
            <b>{items.length}</b> khoản · <b>{vnd(total)}</b>
          </p>
          <Button className="d3-ub-go" disabled={saving || scanning || items.length === 0} onClick={() => void save()} data-bmq-cash-pr-save>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
            Tạo phiếu chi
          </Button>
        </div>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}
