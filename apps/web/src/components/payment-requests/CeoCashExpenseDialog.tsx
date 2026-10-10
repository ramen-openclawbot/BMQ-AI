/* Chi tiền mặt (CEO): pick one or more photos of cash vouchers (hoá đơn bán lẻ, biên nhận,
 * phiếu chi). The server reads each one into a draft; the CEO checks amount, date, cost
 * category and content, then "Ghi nhận" creates the payment request, approves it, records
 * the cash payment and attaches the photo as its payment evidence in one step per voucher
 * (useCeoCashExpense.recordAll). Nothing is written until the CEO confirms.
 */
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Banknote, Check, ImagePlus, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fileToJpegBase64 } from "@/components/payment-requests/UncApprovalDialog";
import { supabase } from "@/integrations/supabase/client";
import {
  useCeoCashExpense,
  type CeoCashExpenseDraft,
  type CeoCashExpenseRecordOutcome,
} from "@/hooks/useCeoCashExpense";
import {
  CEO_CASH_UNMAPPED_CATEGORY,
  ceoCashExpenseErrorMessage,
  validateCeoCashExpenseForm,
  vietnamToday,
  type CeoCashExpenseFormFields,
} from "@/lib/ceo-cash-expense";
import { cn } from "@/lib/utils";
import "@/styles/bmq-unc-approval.css";
import "@/styles/bmq-unc-bulk.css";
import "@/styles/bmq-ceo-cash.css";

const vnd = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value)))} đ`;

const SCAN_ERROR_TEXT: Record<string, string> = {
  not_owner: "Chỉ CEO (chủ) được ghi chi tiền mặt.",
  image_too_large: "Ảnh quá lớn. Hãy chụp lại hoặc chọn ảnh nhỏ hơn.",
  invalid_image_type: "Chỉ nhận ảnh JPG, PNG hoặc WEBP.",
  scan_failed: "Chưa tải được ảnh này lên. Thử lại sau.",
};

type Phase = "pick" | "reading" | "review" | "saving" | "done";

interface RowForm {
  amount: string;
  expense_date: string;
  cost_category_code: string;
  description: string;
  payee_name: string;
}

interface Row {
  index: number;
  draft: CeoCashExpenseDraft | null;
  /** The image was already recorded earlier (same photo uploaded again). */
  alreadyRecorded: boolean;
  scanError: string | null;
  discarded: boolean;
}

interface Category {
  code: string;
  label: string;
}

function useActiveCostCategories(enabled: boolean) {
  return useQuery({
    queryKey: ["cost-categories-active"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Category[]> => {
      const { data, error } = await supabase
        .from("cost_categories")
        .select("code,label,sort_order")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((c) => ({ code: c.code, label: c.label }));
    },
  });
}

const formFromDraft = (draft: CeoCashExpenseDraft): RowForm => ({
  amount: draft.amount && draft.amount > 0 ? String(Math.round(draft.amount)) : "",
  expense_date: draft.expense_date || vietnamToday(),
  cost_category_code: draft.cost_category_code || CEO_CASH_UNMAPPED_CATEGORY,
  description: draft.description || "",
  payee_name: draft.payee_name || "",
});

const toFields = (form: RowForm, draft: CeoCashExpenseDraft): CeoCashExpenseFormFields => ({
  amount: form.amount ? Number(form.amount) : null,
  expense_date: form.expense_date || null,
  cost_category_code: form.cost_category_code || null,
  description: form.description.trim() || null,
  payee_name: form.payee_name.trim() || null,
  items: draft.items,
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

export function CeoCashExpenseDialog({ open, onOpenChange, onDone }: Props) {
  const { scanFiles, recordAll, discard, reset } = useCeoCashExpense();
  const { data: categories } = useActiveCostCategories(open);
  const [phase, setPhase] = useState<Phase>("pick");
  const [previews, setPreviews] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [forms, setForms] = useState<Map<number, RowForm>>(new Map());
  // Rows the CEO unticked by hand; every valid draft is ticked by default.
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [outcomes, setOutcomes] = useState<Map<number, CeoCashExpenseRecordOutcome>>(new Map());
  const [discarding, setDiscarding] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const close = (next: boolean) => {
    if (!next && (phase === "reading" || phase === "saving")) return;
    if (!next) {
      if (phase === "done") onDone?.();
      reset();
      setPhase("pick");
      setPreviews([]);
      setRows([]);
      setForms(new Map());
      setSkipped(new Set());
      setOutcomes(new Map());
    }
    onOpenChange(next);
  };

  const pickFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/") || f.type === "");
    if (files.length === 0) return;
    setPhase("reading");
    const images = await Promise.all(files.map((f) => fileToJpegBase64(f)));
    setPreviews(images.map((i) => i.preview));
    setRows(images.map((_, index) => ({ index, draft: null, alreadyRecorded: false, scanError: null, discarded: false })));
    const scanned = await scanFiles(images.map((i) => ({ image_base64: i.base64, mime_type: i.mime })));
    const nextForms = new Map<number, RowForm>();
    setRows(
      scanned.map((item) => {
        const draft = item.draft;
        if (draft && draft.status === "draft") nextForms.set(item.index, formFromDraft(draft));
        return {
          index: item.index,
          draft,
          alreadyRecorded: draft?.status === "recorded",
          scanError: item.status === "error" ? item.errorCode || "scan_failed" : null,
          discarded: false,
        };
      }),
    );
    setForms(nextForms);
    setSkipped(new Set());
    setPhase("review");
  };

  const setField = (index: number, key: keyof RowForm, value: string) =>
    setForms((prev) => {
      const next = new Map(prev);
      const current = next.get(index);
      if (current) next.set(index, { ...current, [key]: value });
      return next;
    });

  const toggle = (index: number) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const validation = useMemo(() => {
    const map = new Map<number, ReturnType<typeof validateCeoCashExpenseForm>>();
    rows.forEach((row) => {
      const form = forms.get(row.index);
      if (row.draft && form) map.set(row.index, validateCeoCashExpenseForm(toFields(form, row.draft)));
    });
    return map;
  }, [rows, forms]);

  const editable = (row: Row) => !!row.draft && row.draft.status === "draft" && !row.discarded && forms.has(row.index);
  const chosen = rows.filter((row) => editable(row) && !skipped.has(row.index) && validation.get(row.index)?.ok);
  const chosenTotal = chosen.reduce((sum, row) => sum + Number(forms.get(row.index)?.amount || 0), 0);

  const save = async () => {
    if (chosen.length === 0) return;
    setPhase("saving");
    const results = await recordAll(
      chosen.map((row) => ({ draftId: row.draft!.id, fields: toFields(forms.get(row.index)!, row.draft!) })),
    );
    const byDraft = new Map(results.map((r) => [r.draftId, r]));
    const next = new Map<number, CeoCashExpenseRecordOutcome>();
    chosen.forEach((row) => {
      const outcome = byDraft.get(row.draft!.id);
      if (outcome) next.set(row.index, outcome);
    });
    setOutcomes(next);
    setPhase("done");
  };

  const discardRow = async (row: Row) => {
    if (!row.draft) return;
    setDiscarding(row.index);
    try {
      await discard(row.draft.id);
      setRows((prev) => prev.map((r) => (r.index === row.index ? { ...r, discarded: true } : r)));
    } catch {
      // Leave the row as is; the CEO can simply untick it.
    } finally {
      setDiscarding(null);
    }
  };

  const savedCount = [...outcomes.values()].filter((o) => o.ok).length;
  const failedCount = outcomes.size - savedCount;
  const categoryList = categories ?? [];
  const labelOf = (code: string) => categoryList.find((c) => c.code === code)?.label ?? code;

  const chip = (row: Row): { label: string; tone: string } => {
    const outcome = outcomes.get(row.index);
    if (outcome) return outcome.ok ? { label: "Đã ghi", tone: "is-green" } : { label: "Lỗi", tone: "is-red" };
    if (phase === "saving" && chosen.some((c) => c.index === row.index)) return { label: "Đang ghi", tone: "is-blue" };
    if (row.scanError) return { label: "Lỗi", tone: "is-red" };
    if (row.alreadyRecorded) return { label: "Đã ghi trước", tone: "is-amber" };
    if (row.discarded) return { label: "Đã bỏ", tone: "" };
    if (!row.draft) return { label: "Đang đọc", tone: "" };
    if (validation.get(row.index)?.ok === false) return { label: "Cần sửa", tone: "is-amber" };
    return skipped.has(row.index) ? { label: "Bỏ qua", tone: "" } : { label: "Sẽ ghi", tone: "is-green" };
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="d3-unc d3-ub d3-cc"
        data-bmq-ceo-cash-dialog={phase}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader className="d3-unc-head text-left sm:text-left">
          <span className="d3-unc-tag">Chi tiền mặt</span>
          <DialogTitle className="d3-unc-title">
            {phase === "pick" ? "Up chứng từ chi tiền mặt" : phase === "done" ? <>Đã ghi <b>{savedCount}</b> khoản chi</> : <><b>{previews.length}</b> chứng từ</>}
          </DialogTitle>
          <DialogDescription className="d3-unc-sub">
            {phase === "pick"
              ? "Chọn ảnh hoá đơn, biên nhận hoặc phiếu chi. Hệ thống đọc số tiền, ngày và nội dung. Chưa ghi gì cho đến khi anh bấm Ghi nhận."
              : phase === "reading"
                ? "Đang đọc từng ảnh…"
                : phase === "done"
                  ? failedCount > 0 ? `${failedCount} khoản chưa ghi được — xem lý do bên dưới.` : "Mỗi khoản đã có đề nghị chi, đã duyệt, đã chi tiền mặt và đính kèm ảnh chứng từ."
                  : "Kiểm tra từng khoản. Khoản đã tick sẽ được tạo đề nghị chi, duyệt và ghi đã chi tiền mặt."}
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          data-bmq-ceo-cash-file
          onChange={(e) => {
            void pickFiles(e.target.files);
            e.currentTarget.value = "";
          }}
        />

        {phase === "pick" ? (
          <button type="button" className="d3-unc-drop" onClick={() => fileRef.current?.click()} data-bmq-ceo-cash-pick>
            <ImagePlus className="h-6 w-6" />
            <span>Chọn ảnh chứng từ</span>
            <small>Chọn được nhiều ảnh một lần · mỗi ảnh là một khoản chi</small>
          </button>
        ) : (
          <ul className="d3-ub-list" aria-live="polite">
            {rows.map((row) => {
              const form = forms.get(row.index);
              const check = validation.get(row.index);
              const canEdit = phase === "review" && editable(row);
              const on = editable(row) && !skipped.has(row.index) && check?.ok === true;
              const outcome = outcomes.get(row.index);
              const st = chip(row);
              return (
                <li key={row.index} className={cn("d3-ub-row d3-cc-row", on && phase !== "done" && "is-on")} data-bmq-ceo-cash-row={st.label}>
                  <div className="d3-ub-top">
                    {previews[row.index] ? <img src={previews[row.index]} alt={`Chứng từ ${row.index + 1}`} /> : <span className="d3-ub-ph" />}
                    <div className="d3-ub-read">
                      <span className="d3-ub-amt">
                        {!row.draft && !row.scanError ? <Loader2 className="h-4 w-4 animate-spin" /> : vnd(form?.amount ? Number(form.amount) : row.draft?.amount ?? null)}
                      </span>
                      <small>{row.draft?.payee_name || (row.draft ? "Không đọc được người nhận" : row.scanError ? "" : "Đang đọc…")}</small>
                      {row.draft?.matched_supplier_id && <small>Khớp nhà cung cấp trong app</small>}
                    </div>
                    <span className={cn("d3-up-chip", st.tone)}>
                      {st.label === "Đang ghi" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      {st.label}
                    </span>
                  </div>

                  {row.scanError ? (
                    <p className="d3-ub-why is-bad"><TriangleAlert className="h-3.5 w-3.5" /> {SCAN_ERROR_TEXT[row.scanError] || ceoCashExpenseErrorMessage(row.scanError)}</p>
                  ) : row.alreadyRecorded ? (
                    <p className="d3-ub-why" data-bmq-ceo-cash-already>Ảnh này đã được ghi chi trước đó. Không ghi lại.</p>
                  ) : row.discarded ? (
                    <p className="d3-ub-why">Đã bỏ ảnh này.</p>
                  ) : outcome ? (
                    outcome.ok ? (
                      <p className="d3-ub-why is-ok" data-bmq-ceo-cash-saved>
                        <Check className="h-3.5 w-3.5" /> {outcome.result.request_number ? `${outcome.result.request_number} · ` : ""}đã duyệt, đã chi tiền mặt, đã đính kèm chứng từ
                        {outcome.result.replayed ? " (đã ghi từ trước)" : ""}
                      </p>
                    ) : (
                      <p className="d3-ub-why is-bad" data-bmq-ceo-cash-failed><TriangleAlert className="h-3.5 w-3.5" /> {"message" in outcome ? outcome.message : ceoCashExpenseErrorMessage(null)}</p>
                    )
                  ) : null}

                  {row.draft?.ocr_error && !row.alreadyRecorded && !row.discarded && !outcome && (
                    <p className="d3-ub-why">Chưa đọc được ảnh rõ. Anh nhập số tiền và nội dung giúp.</p>
                  )}

                  {form && !row.alreadyRecorded && !row.discarded && !outcome && (
                    <div className="d3-cc-form">
                      <label className="d3-cc-f d3-cc-amount">
                        <span className="d3-unc-label">Số tiền</span>
                        <Input
                          inputMode="numeric"
                          value={form.amount ? new Intl.NumberFormat("vi-VN").format(Number(form.amount)) : ""}
                          onChange={(e) => setField(row.index, "amount", e.target.value.replace(/[^\d]/g, ""))}
                          placeholder="Nhập số tiền"
                          disabled={!canEdit}
                          data-bmq-ceo-cash-amount
                        />
                      </label>
                      <label className="d3-cc-f d3-cc-date">
                        <span className="d3-unc-label">Ngày chi</span>
                        <Input
                          type="date"
                          value={form.expense_date}
                          max={vietnamToday()}
                          onChange={(e) => setField(row.index, "expense_date", e.target.value)}
                          disabled={!canEdit}
                          data-bmq-ceo-cash-date
                        />
                      </label>
                      <label className="d3-cc-f d3-cc-wide">
                        <span className="d3-unc-label">Nhóm chi phí</span>
                        <select
                          className="d3-cc-select"
                          value={form.cost_category_code}
                          onChange={(e) => setField(row.index, "cost_category_code", e.target.value)}
                          disabled={!canEdit}
                          data-bmq-ceo-cash-category
                        >
                          {!categoryList.some((c) => c.code === form.cost_category_code) && (
                            <option value={form.cost_category_code}>{labelOf(form.cost_category_code)}</option>
                          )}
                          {categoryList.map((c) => (
                            <option key={c.code} value={c.code}>{c.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="d3-cc-f d3-cc-wide">
                        <span className="d3-unc-label">Nội dung chi</span>
                        <Input
                          value={form.description}
                          onChange={(e) => setField(row.index, "description", e.target.value)}
                          placeholder="Ví dụ: Mua đá, gas, sửa máy…"
                          maxLength={500}
                          disabled={!canEdit}
                          data-bmq-ceo-cash-description
                        />
                      </label>
                      <label className="d3-cc-f d3-cc-wide">
                        <span className="d3-unc-label">Người nhận (không bắt buộc)</span>
                        <Input
                          value={form.payee_name}
                          onChange={(e) => setField(row.index, "payee_name", e.target.value)}
                          maxLength={160}
                          disabled={!canEdit}
                        />
                      </label>
                      {form.cost_category_code === CEO_CASH_UNMAPPED_CATEGORY && (
                        <p className="d3-ub-why d3-cc-wide">Chưa rõ nhóm chi phí: khoản này sẽ vào hàng chờ phân loại. Chọn nhóm nếu anh biết.</p>
                      )}
                      {check && check.ok === false && (
                        <p className="d3-ub-why is-bad d3-cc-wide" data-bmq-ceo-cash-invalid><TriangleAlert className="h-3.5 w-3.5" /> {check.message}</p>
                      )}
                      {canEdit && (
                        <div className="d3-cc-acts d3-cc-wide">
                          <label className="d3-unc-toggle">
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={check?.ok !== true}
                              onChange={() => toggle(row.index)}
                              data-bmq-ceo-cash-tick
                            />
                            <span>Ghi khoản này</span>
                          </label>
                          <button
                            type="button"
                            className="d3-cc-drop"
                            onClick={() => void discardRow(row)}
                            disabled={discarding !== null}
                            data-bmq-ceo-cash-discard
                          >
                            {discarding === row.index ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            Bỏ ảnh
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {phase !== "pick" && (
          <div className="d3-ub-foot">
            {phase === "done" ? (
              <Button className="d3-ub-go" onClick={() => close(false)} data-bmq-ceo-cash-close>Xong</Button>
            ) : (
              <>
                <p>
                  {phase === "reading" ? "Đang đọc ảnh…" : <>Sẽ ghi <b>{chosen.length}</b> khoản · <b>{vnd(chosenTotal)}</b></>}
                </p>
                <Button
                  className="d3-ub-go"
                  disabled={phase !== "review" || chosen.length === 0}
                  onClick={() => void save()}
                  data-bmq-ceo-cash-confirm
                >
                  {phase === "saving" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                  Ghi nhận ({chosen.length})
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
