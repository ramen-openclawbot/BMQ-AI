import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast as sonnerToast } from "sonner";
import { LoadingState } from "@/components/ui/loading";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  useKhoReviewCreateItem, useKhoReviewFactorHint, useKhoReviewFixLineUnit, useKhoReviewJev, useKhoReviewLink, useKhoReviewList,
  KHO_REVIEW_QUERY_KEY, useKhoReviewDismiss, useKhoReviewReadLine, useKhoReviewSearchLines, useKhoReviewUndismiss, useKhoReviewUndoUnitFix,
} from "@/hooks/useKhoReview";
import { useKhoItems, useKhoSaveItem } from "@/hooks/useKhoItems";
import { useSetItemKhoLocations } from "@/hooks/useWarehouseGame";
import type { KhoItem } from "@/lib/kho-items";
import {
  KHO_REVIEW_DISMISS_REASON_LABELS, factorFromRead, jevVerdictText, khoReviewErrorText, reviewReasonText, suggestedFactor,
  type KhoReviewCandidate, type KhoReviewDismissReason, type KhoReviewFactorSource, type KhoReviewItem, type KhoReviewLocation, type KhoReviewMaterial,
} from "@/lib/kho-review";
import type { ReceiptLine } from "@/lib/receipt-lines";
import { cn } from "@/lib/utils";
import { KhoDialog } from "@/components/kho/KhoDialog";
import { ReceiptNotes } from "@/components/kho/ReceiptNotes";
import { useKhoConfirm } from "@/components/kho/KhoConfirm";
import { ITEM_UNITS, KHO_LABEL, KHO_LOCATIONS, fmtAmount, fmtQty, newRequestId, normalizeName, parseNum } from "@/components/kho/kho-meta";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-kho.css";

type View = "items" | "materials";
const money = (value: number | null) => (value === null ? "" : `${Math.round(value).toLocaleString("vi-VN")}đ`);
const dm = (iso: string) => iso.slice(0, 10).split("-").reverse().slice(0, 2).join("/");

/** Candidates as receipt lines, so the delivery-note viewer shows the evidence (owner rule 17/10). */
const asLines = (cands: KhoReviewCandidate[]): ReceiptLine[] => cands.map((c) => ({
  goods_receipt_id: c.receipt_item_id, goods_receipt_item_id: c.receipt_item_id,
  receipt_number: c.receipt_number, receipt_date: c.receipt_date, status: "received",
  supplier_name: c.supplier_name, raw_name: c.product_name, quantity: c.actual_quantity ?? 0,
  unit: c.unit, unit_price: c.unit_price, line_total: null, image_path: c.image_url, photo_paths: [],
}));

/**
 * Rà soát nhập kho (temporary, owner 22/10/2026): items with no purchase line or a negative balance, and recipe
 * materials without a kho item, each with the receipt lines whose names look alike. Link a line (with its
 * conversion) or create the item from it. Remove the tab once the list is empty.
 */
export default function KhoReview() {
  const list = useKhoReviewList();
  const [view, setView] = useState<View>("items");
  const [kho, setKho] = useState<KhoReviewLocation>("q7");
  const [query, setQuery] = useState("");
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [openMat, setOpenMat] = useState<string | null>(null);
  const { confirm, dialog } = useKhoConfirm();
  const { toast } = useToast();
  const jev = useKhoReviewJev();
  const runJev = (targetKeys?: string[]) => jev.mutate({ targetKeys, limit: 40 }, {
    onSuccess: (r) => toast({ title: r.asked ? `Jev đã chấm ${r.marks.length} dòng gợi ý` : "Các gợi ý đã được Jev chấm trước đó", description: r.skipped ? `Còn ${r.skipped} dòng chưa chấm, bấm lần nữa để chấm tiếp.` : undefined }),
    onError: (e) => toast({ title: "Jev chưa chấm được", description: khoReviewErrorText(e), variant: "destructive" }),
  });
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const materials = useMemo(() => list.data?.materials ?? [], [list.data]);
  const key = normalizeName(query);
  const rows = items.filter((r) => r.location === kho && (!key || normalizeName(r.name).includes(key)));
  const mats = materials.filter((m) => !key || normalizeName(m.name).includes(key));
  const counts = { tan_tao: items.filter((r) => r.location === "tan_tao").length, q7: items.filter((r) => r.location === "q7").length };
  const item = items.find((r) => `${r.item_id}:${r.location}` === openItem) ?? null;
  const mat = materials.find((m) => `${m.canonical_material_id}:${m.recipe_unit}` === openMat) ?? null;

  return (
    <div className="d3-wh d3-kho min-w-0" data-bmq-kho-review>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>Rà soát nhập kho</h1>
          <p className="d3-wh-tag">{list.isLoading ? "Đang đọc phiếu mua…" : list.isError ? "Chưa đọc được" : `${items.length} món kho · ${materials.length} NVL giá vốn cần xử lý`}</p>
        </div>
        {view === "items" ? (
          <div className="d3-sl-switch d3-kho-switch" role="tablist" aria-label="Kho">
            {KHO_LOCATIONS.map((loc) => (
              <button key={loc} type="button" role="tab" aria-selected={kho === loc} className={cn(kho === loc && "is-on")} onClick={() => setKho(loc)} data-bmq-review-loc={loc}>
                Kho {KHO_LABEL[loc]}{list.data ? <small>{counts[loc]}</small> : null}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <section className="d3-wh-card d3-kho-card">
        <div className="d3-kho-tabs" role="tablist" aria-label="Nhóm">
          <button type="button" role="tab" aria-selected={view === "items"} className={cn(view === "items" && "is-on")} onClick={() => setView("items")} data-bmq-review-view="items">
            Món kho<small>{list.data ? items.length : "…"}</small>
          </button>
          <button type="button" role="tab" aria-selected={view === "materials"} className={cn(view === "materials" && "is-on")} onClick={() => setView("materials")} data-bmq-review-view="materials">
            NVL giá vốn<small>{list.data ? materials.length : "…"}</small>
          </button>
        </div>
        <div className="d3-kho-tools">
          <span className="d3-kho-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm món…" aria-label="Tìm món" enterKeyHint="search" />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Xóa tìm kiếm"><X /></button> : null}
          </span>
        </div>
        <div className="d3-kr-jev">
          <Button variant="outline" size="sm" disabled={jev.isPending || list.isLoading} onClick={() => runJev()} data-bmq-review-jev>
            {jev.isPending ? "Jev đang chấm…" : "Nhờ Jev chấm"}
          </Button>
          <small>Jev xem từng dòng phiếu có đúng món không. Chỉ đánh dấu, không tự nối.</small>
        </div>
        <p className="d3-kho-hint">
          {view === "items"
            ? "Món chưa có phiếu mua nào hoặc đang âm. Chọn món, xem phiếu có tên gần giống rồi nối vào đúng món."
            : "Nguyên liệu trong công thức giá vốn chưa có món kho. Tạo món từ phiếu mua, công thức tự trừ vào món đó."}
        </p>

        {list.isLoading ? <LoadingState label="Đang đọc phiếu mua" /> : list.isError ? (
          <div className="d3-kho-failed" role="alert">
            <p>Không tải được danh sách. {khoReviewErrorText(list.error)}</p>
            <Button variant="outline" onClick={() => void list.refetch()}>Thử lại</Button>
          </div>
        ) : view === "items" ? (
          rows.length ? (
            <ul className="d3-kho-list" data-bmq-review-items>
              {rows.map((r) => (
                <li key={`${r.item_id}:${r.location}`} className="d3-kho-row">
                  <button type="button" className="d3-kho-row-main" onClick={() => setOpenItem(`${r.item_id}:${r.location}`)} data-bmq-review-item={r.item_id}>
                    <b>{r.name}</b>
                    <small>
                      <span className={cn(r.reason !== "no_docs" && "is-flag")}>{reviewReasonText(r.reason)}</span>
                      <span>{r.candidates.length ? `${r.candidates.length} phiếu gần giống` : "chưa thấy phiếu gần giống"}</span>
                    </small>
                  </button>
                  <span className={cn("d3-kho-row-qty", r.qty < 0 && "is-short")}>{fmtAmount(r.qty, r.unit)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="d3-kho-empty">Kho {KHO_LABEL[kho]} không còn món nào cần rà soát.</p>
        ) : mats.length ? (
          <ul className="d3-kho-list" data-bmq-review-materials>
            {mats.map((m) => (
              <li key={`${m.canonical_material_id}:${m.recipe_unit}`} className="d3-kho-row is-link">
                <button type="button" className="d3-kho-row-main" onClick={() => setOpenMat(`${m.canonical_material_id}:${m.recipe_unit}`)} data-bmq-review-material={m.canonical_material_id}>
                  <b>{m.name}</b>
                  <small>
                    <span>{m.recipe_unit}</span>
                    <span>{m.sku_codes.join(", ")}</span>
                    <span className={cn(!m.candidates.length && "is-flag")}>{m.candidates.length ? `${m.candidates.length} phiếu gần giống` : "chưa có phiếu mua"}</span>
                  </small>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="d3-kho-empty">Mọi NVL trong giá vốn đã có món kho.</p>}
      </section>

      {item ? <ItemReview item={item} confirm={confirm} onClose={() => setOpenItem(null)} onJev={() => runJev([item.target_key])} jevBusy={jev.isPending} /> : null}
      {mat ? <MaterialReview mat={mat} onClose={() => setOpenMat(null)} onJev={() => runJev([mat.target_key])} jevBusy={jev.isPending} /> : null}
      {dialog}
    </div>
  );
}

function CandidateCard({ c, children, note }: { c: KhoReviewCandidate; children?: ReactNode; note?: string }) {
  return (
    <li className="d3-kr-cand" data-bmq-review-cand={c.receipt_item_id}>
      <div className="d3-kr-cand-head">
        <b>{c.product_name}</b>
        <span className="d3-kr-score" title="Mức giống tên">{Math.round(c.score * 100)}%</span>
      </div>
      {c.raw_name ? <small data-bmq-review-raw-name>Tên quét trên phiếu: {c.raw_name}</small> : null}
      {jevVerdictText(c.jev_verdict, c.jev_probability) ? (
        <span className={cn("d3-kr-jevtag", c.jev_verdict && `is-${c.jev_verdict}`)} data-bmq-review-jevtag={c.jev_verdict ?? ""}>{jevVerdictText(c.jev_verdict, c.jev_probability)}</span>
      ) : null}
      <small>
        {c.receipt_number} · {dm(c.receipt_date)} · Kho {c.location ? KHO_LABEL[c.location] : "?"}
        {c.supplier_name ? ` · ${c.supplier_name}` : ""}
      </small>
      <small>
        {c.actual_quantity !== null ? `${fmtQty(c.actual_quantity)} ${c.unit ?? ""}` : "chưa ghi số lượng"}
        {c.unit_price !== null ? ` × ${money(c.unit_price)}` : ""}
        {c.posted ? " · đã vào sổ kho" : ""}
      </small>
      {note ? <small className="is-flag">{note}</small> : null}
      {children}
    </li>
  );
}

const HINT_WHY: Record<KhoReviewFactorSource, string> = {
  approved_conversion: "theo quy đổi đã duyệt của món",
  alias: "theo lần nối trước của nhà cung cấp này",
  name_pack: "theo quy cách ghi trong tên hàng",
  standard: "theo bảng đổi chuẩn",
};

/**
 * Reads the picked line's photo (Indra OCR on the Mac, DeepSeek fallback) as soon as a line is chosen, offers to
 * fix a mis-scanned document unit (7 kg -> 7 hộp) and proposes a factor only with a reason. Never links by itself.
 */
function useLineAssist(c: KhoReviewCandidate | null, targetUnit: string, itemId: string | null) {
  const read = useKhoReviewReadLine();
  const fix = useKhoReviewFixLineUnit();
  const undo = useKhoReviewUndoUnitFix();
  const [fixed, setFixed] = useState<{ id: string; fixId: string | null; from: string | null; to: string } | null>(null);
  const id = c?.receipt_item_id ?? "";
  useEffect(() => {
    setFixed(null);
    fix.reset();
    undo.reset();
    if (id) read.mutate({ receiptItemId: id });
    else read.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read per picked line
  }, [id]);
  const data = read.data && read.variables?.receiptItemId === id ? read.data : null;
  const myFix = fixed && fixed.id === id ? fixed : null;
  const unit = myFix ? myFix.to : c?.unit ?? null;
  const hint = useKhoReviewFactorHint({ receiptItemId: id, itemId, docUnit: unit, enabled: Boolean(id && unit && itemId) });

  // A printed pack ("Hộp 100 cái") counts per printed unit, so it only applies once the line carries that unit.
  const printed = data?.found && (!data.unit_mismatch || myFix) ? factorFromRead(data, targetUnit) : null;
  const proven = hint.data?.source && hint.data.factor !== null && hint.data.factor > 0 ? hint.data : null;
  const standard = suggestedFactor(unit, targetUnit);
  const suggestion: { factor: number; why: string } | null = printed !== null
    ? { factor: printed, why: "theo quy cách in trên phiếu" }
    : proven ? { factor: Number(proven.factor), why: HINT_WHY[proven.source as KhoReviewFactorSource] }
    : standard !== null ? { factor: standard, why: HINT_WHY.standard } : null;

  const canFix = Boolean(c && data?.found && data.unit_mismatch && data.doc_unit && !myFix && !c.posted && !c.linked_item_id);
  const doFix = () => {
    if (!c || !data?.doc_unit) return;
    fix.mutate({ receiptItemId: c.receipt_item_id, newUnit: data.doc_unit, requestId: newRequestId() }, {
      onSuccess: (r) => setFixed({ id: c.receipt_item_id, fixId: r.fix_id ?? null, from: r.old_unit, to: r.new_unit }),
    });
  };
  const doUndo = () => {
    if (!myFix?.fixId) return;
    undo.mutate({ fixId: myFix.fixId }, { onSuccess: () => setFixed(null) });
  };

  const panel = c ? (
    <div className="d3-kr-read" data-bmq-review-read={read.isPending ? "reading" : read.isError ? "error" : data ? (data.found ? "found" : "missing") : ""}>
      {read.isPending ? <small className="d3-kr-read-wait">Đang đọc ảnh phiếu…</small>
        : read.isError ? <small>Chưa đọc được ảnh phiếu: {khoReviewErrorText(read.error)}</small>
        : data && !data.found ? <small>Không thấy dòng này trên ảnh phiếu, xem ảnh bên dưới.</small>
        : data ? (
          <p className="d3-kr-read-line">
            <span>Phiếu ghi</span>
            <b>{data.doc_quantity !== null ? `${fmtQty(data.doc_quantity)} ` : ""}{data.doc_unit}{data.doc_unit_price !== null ? ` × ${money(data.doc_unit_price)}` : ""}</b>
            {data.pack_count !== null && data.pack_unit ? <span>quy cách {fmtQty(data.pack_count)} {data.pack_unit}/{data.doc_unit}</span> : null}
          </p>
        ) : null}
      {canFix ? (
        <div className="d3-kr-read-fix" data-bmq-review-unit-mismatch>
          <small>Dữ liệu đang ghi <b>{c.unit ?? "?"}</b>, phiếu ghi <b>{data?.doc_unit}</b>.</small>
          <Button size="sm" variant="outline" disabled={fix.isPending} onClick={doFix} data-bmq-review-fix-unit>{fix.isPending ? "Đang sửa…" : `Sửa thành ${data?.doc_unit}`}</Button>
        </div>
      ) : null}
      {myFix ? (
        <div className="d3-kr-read-fix is-done" data-bmq-review-unit-fixed>
          <small>Đã sửa đơn vị dòng này: {myFix.from ?? "?"} → {myFix.to}. Số lượng, tiền giữ nguyên.</small>
          {myFix.fixId ? <Button size="sm" variant="ghost" disabled={undo.isPending} onClick={doUndo} data-bmq-review-undo-unit>{undo.isPending ? "Đang hoàn tác…" : "Hoàn tác"}</Button> : null}
        </div>
      ) : null}
      {fix.error ? <p className="d3-kho-error">{khoReviewErrorText(fix.error)}</p> : null}
      {undo.error ? <p className="d3-kho-error">{khoReviewErrorText(undo.error)}</p> : null}
    </div>
  ) : null;

  return { panel, unit, suggestion, reading: read.isPending };
}

/** Prefills the factor from the assist suggestion until the user types their own. */
function useSuggestedFactor(suggestion: { factor: number } | null, pickedId: string | null, touched: boolean, set: (v: string) => void) {
  const value = suggestion?.factor ?? null;
  useEffect(() => {
    if (!touched && value !== null) set(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the suggestion or picked line changes
  }, [value, pickedId]);
}

/** Search every receipt line (all dates, corrected + scanned names) when the suggestions are wrong or missing. */
function LineSearch({ targetKey, exclude, onPick }: { targetKey: string; exclude: string[]; onPick: (c: KhoReviewCandidate) => void }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), 300);
    return () => window.clearTimeout(t);
  }, [text]);
  const search = useKhoReviewSearchLines(targetKey, query);
  const rows = (search.data ?? []).filter((r) => !exclude.includes(r.receipt_item_id));
  return (
    <section className="d3-kr-exist" data-bmq-review-search>
      <div className="d3-kr-exist-head">
        <b>Tìm phiếu mua</b>
        <small>Gợi ý sai hoặc không có? Gõ tên hàng, mã GRN/PO hoặc nhà cung cấp; tìm trên mọi phiếu nhập.</small>
      </div>
      <span className="d3-kho-search">
        <Search aria-hidden="true" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ví dụ: opp, GRN-000435, Ngọc Trân" aria-label="Tìm phiếu mua" enterKeyHint="search" data-bmq-review-search-input />
        {text ? <button type="button" onClick={() => setText("")} aria-label="Xóa tìm kiếm"><X /></button> : null}
      </span>
      {query.length < 2 ? null
        : search.isLoading ? <small className="d3-kr-read-wait">Đang tìm…</small>
        : search.isError ? <p className="d3-kho-error">{khoReviewErrorText(search.error)}</p>
        : !rows.length ? <p className="d3-kho-hint">Không có phiếu nào có “{query}”.</p>
        : (
          <ul className="d3-kr-exist-list">
            {rows.map((r) => (
              <li key={r.receipt_item_id}>
                <button type="button" className="d3-kr-exist-item" onClick={() => onPick(r)} data-bmq-review-search-row={r.receipt_item_id}>
                  <b>{r.product_name}</b>
                  <small>
                    <span>{r.receipt_number} · {dm(r.receipt_date)}</span>
                    {r.supplier_name ? <span>{r.supplier_name}</span> : null}
                    <span>{r.actual_quantity !== null ? `${fmtQty(r.actual_quantity)} ${r.unit ?? ""}` : "chưa ghi số lượng"}</span>
                    {r.linked_item_id ? <span className="is-off">đang nối món khác</span> : null}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

const DISMISS_REASONS: KhoReviewDismissReason[] = ["no_receipt", "self_made", "gift", "other"];

/** An item that will never have a receipt leaves the list with a reason, or is turned off; both can be undone. */
function NoReceipt({ item, confirm, onDone }: { item: KhoReviewItem; confirm: ReturnType<typeof useKhoConfirm>["confirm"]; onDone: () => void }) {
  const { toast } = useToast();
  const dismiss = useKhoReviewDismiss();
  const undismiss = useKhoReviewUndismiss();
  const saveItem = useKhoSaveItem();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<KhoReviewDismissReason | null>(null);
  const [note, setNote] = useState("");
  const markIt = () => {
    if (!reason) return;
    dismiss.mutate({ targetKey: item.target_key, reason, note: note.trim() || null, requestId: newRequestId() }, {
      onSuccess: () => {
        // The app renders sonner only; its action button is the undo.
        sonnerToast(`“${item.name}” rời danh sách: ${KHO_REVIEW_DISMISS_REASON_LABELS[reason]}`, {
          duration: 8000,
          action: { label: "Hoàn tác", onClick: () => undismiss.mutate({ targetKey: item.target_key, requestId: newRequestId() }) },
        });
        onDone();
      },
    });
  };
  const turnOff = async () => {
    const ok = await confirm({ title: "Tắt món", message: `Tắt “${item.name}”? Món không hiện ở danh mục và kiểm kê nữa; bật lại được trong Danh mục kho.`, ok: "Tắt món", cancel: "Thôi" });
    if (!ok) return;
    saveItem.mutate({ itemId: item.item_id, name: item.name, unit: item.unit, active: false, requestId: newRequestId() }, {
      onSuccess: (r) => {
        if (r.status !== "saved") { toast({ title: "Chưa tắt được món", description: "Mở Danh mục kho để tắt.", variant: "destructive" }); return; }
        void queryClient.invalidateQueries({ queryKey: [KHO_REVIEW_QUERY_KEY] });
        toast({ title: `Đã tắt “${item.name}”` });
        onDone();
      },
    });
  };
  return (
    <section className="d3-kr-exist" data-bmq-review-noreceipt>
      <div className="d3-kr-exist-head">
        <b>Không có phiếu mua?</b>
        <small>Chọn lý do để món rời danh sách, hoặc tắt món nếu không dùng nữa.</small>
      </div>
      <div className="d3-kho-seg d3-kr-reasons" role="group" aria-label="Lý do">
        {DISMISS_REASONS.map((r) => (
          <button key={r} type="button" aria-pressed={reason === r} className={cn(reason === r && "is-on")} onClick={() => setReason(r)} data-bmq-review-reason={r}>{KHO_REVIEW_DISMISS_REASON_LABELS[r]}</button>
        ))}
      </div>
      {reason ? <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ghi chú (không bắt buộc)" aria-label="Ghi chú" data-bmq-review-reason-note /> : null}
      {dismiss.error ? <p className="d3-kho-error">{khoReviewErrorText(dismiss.error)}</p> : null}
      <div className="d3-kho-actions">
        <Button disabled={!reason || dismiss.isPending} onClick={markIt} data-bmq-review-dismiss>{dismiss.isPending ? "Đang lưu…" : "Đánh dấu không có phiếu"}</Button>
        <Button variant="outline" disabled={saveItem.isPending} onClick={() => void turnOff()} data-bmq-review-turnoff>Tắt món</Button>
      </div>
    </section>
  );
}

function HiddenNote({ n }: { n?: number }) {
  return n ? <p className="d3-kho-hint" data-bmq-review-hidden>Đã ẩn {n} dòng Jev chấm khác loại.</p> : null;
}

function ItemReview({ item, confirm, onClose, onJev, jevBusy }: { item: KhoReviewItem; confirm: ReturnType<typeof useKhoConfirm>["confirm"]; onClose: () => void; onJev: () => void; jevBusy: boolean }) {
  const { toast } = useToast();
  const link = useKhoReviewLink();
  const [picked, setPicked] = useState<string | null>(null);
  const [factorText, setFactorText] = useState("");
  const [touched, setTouched] = useState(false);
  const [extra, setExtra] = useState<KhoReviewCandidate[]>([]);
  const all = useMemo(() => [...extra.filter((e) => !item.candidates.some((c) => c.receipt_item_id === e.receipt_item_id)), ...item.candidates], [extra, item.candidates]);
  const cand = all.find((c) => c.receipt_item_id === picked) ?? null;
  const assist = useLineAssist(cand, item.unit, item.item_id);
  useSuggestedFactor(assist.suggestion, picked, touched, setFactorText);
  const x = parseNum(factorText);
  const factorOk = Number.isFinite(x) && x > 0;

  const pick = (c: KhoReviewCandidate) => {
    setPicked(c.receipt_item_id);
    setTouched(false);
    const f = suggestedFactor(c.unit, item.unit);
    setFactorText(f !== null ? String(f) : "");
  };
  const save = async () => {
    if (!cand || !factorOk) return;
    if (cand.location !== item.location) {
      const ok = await confirm({ title: "Phiếu ở kho khác", message: `Phiếu này nhận ở Kho ${cand.location ? KHO_LABEL[cand.location] : "?"}, món đang rà ở Kho ${KHO_LABEL[item.location]}. Nếu món không có chỗ ở kho của phiếu, phiếu chỉ được nối làm chứng từ, không cộng tồn. Vẫn nối?`, ok: "Vẫn nối", cancel: "Thôi" });
      if (!ok) return;
    }
    link.mutate({ receiptItemId: cand.receipt_item_id, itemId: item.item_id, factor: x, requestId: newRequestId() }, {
      onSuccess: (r) => {
        toast(r.status === "evidence"
          ? { title: `Đã nối “${cand.product_name}” làm chứng từ cho ${item.name}`, description: `Phiếu nhận ở Kho ${KHO_LABEL[r.location]}, món không có chỗ ở kho đó nên không cộng tồn.` }
          : { title: `Đã nối “${cand.product_name}” vào ${item.name}`, description: r.posted ? "Phiếu đã vào sổ kho." : "Phiếu trước ngày kiểm kê nên không cộng tồn; các phiếu sau tự vào đúng món." });
        onClose();
      },
    });
  };

  return (
    <KhoDialog title={item.name} sub={`Kho ${KHO_LABEL[item.location]} · ${reviewReasonText(item.reason)} · tồn ${fmtAmount(item.qty, item.unit)}`} onClose={onClose} wide data={{ "data-bmq-review-dialog": "" }}>
      {item.candidates.length && item.candidates.some((c) => !c.jev_verdict) ? (
        <Button variant="outline" size="sm" className="d3-kr-pick" disabled={jevBusy} onClick={onJev} data-bmq-review-jev-one>{jevBusy ? "Jev đang chấm…" : "Nhờ Jev chấm các dòng này"}</Button>
      ) : null}
      <HiddenNote n={item.hidden_different} />
      {all.length ? (
        <ul className="d3-kr-cands">
          {all.map((c) => (
            <CandidateCard key={c.receipt_item_id} c={c} note={c.linked_item_id && c.linked_item_id !== item.item_id ? "Tên này đang nối vào món khác" : c.linked_item_id === item.item_id ? "Đã nối vào món này" : undefined}>
              {picked === c.receipt_item_id ? (
                <div className="d3-kho-ask">
                  {assist.panel}
                  <b>{assist.suggestion && !touched ? "Quy đổi: đã điền sẵn, kiểm tra lại" : "Quy đổi: xem ảnh phiếu bên dưới rồi gõ"}</b>
                  <label className="d3-kho-conv">
                    1 {assist.unit ?? "đơn vị"} =
                    <Input inputMode="decimal" value={factorText} onChange={(e) => { setTouched(true); setFactorText(e.target.value); }} placeholder="?" aria-label={`1 ${assist.unit ?? "đơn vị"} bằng bao nhiêu ${item.unit}`} data-bmq-review-factor />
                    {item.unit}
                  </label>
                  {assist.suggestion && !touched ? <small data-bmq-review-factor-why>Điền {fmtQty(assist.suggestion.factor)} {assist.suggestion.why}.</small> : null}
                  {link.error ? <p className="d3-kho-error">{khoReviewErrorText(link.error)}</p> : null}
                  <div className="d3-kho-actions">
                    <Button disabled={!factorOk || link.isPending} onClick={() => void save()} data-bmq-review-link>{link.isPending ? "Đang nối…" : "Nối vào món này"}</Button>
                    <Button variant="outline" onClick={() => setPicked(null)}>Thôi</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" className="d3-kr-pick" onClick={() => pick(c)} data-bmq-review-pick>Chọn dòng này</Button>
              )}
            </CandidateCard>
          ))}
        </ul>
      ) : <p className="d3-kho-hint">Chưa thấy phiếu mua nào có tên gần giống. Tìm phiếu bên dưới, hoặc đánh dấu không có phiếu.</p>}
      <LineSearch targetKey={item.target_key} exclude={all.map((c) => c.receipt_item_id)} onPick={(r) => { setExtra((x) => [r, ...x]); pick(r); }} />
      <NoReceipt item={item} confirm={confirm} onDone={onClose} />
      {all.length ? <ReceiptNotes title="Ảnh phiếu giao của các dòng trên" lines={asLines(all)} loading={false} error={null} /> : null}
    </KhoDialog>
  );
}

/** First two words of a recipe name without pack sizes, e.g. "Nho khô vàng 10kg/thùng" -> "Nho khô". */
function searchSeed(name: string): string {
  return name.split(/\s+/).filter((w) => !/\d/.test(w) && !w.includes("/")).slice(0, 2).join(" ");
}

/**
 * Point a recipe material at a kho item that already exists (owner 23/10): search every item, on or off, pick the
 * kho, set the recipe-unit factor. An off item is turned back on and a missing kho place is added before the
 * recipe link, because cogs_decide_ingredient only accepts an active item placed at that kho.
 */
function LinkExisting({ mat, onDone }: { mat: KhoReviewMaterial; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const items = useKhoItems();
  const saveItem = useKhoSaveItem();
  const setPlaces = useSetItemKhoLocations();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(() => searchSeed(mat.name));
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [loc, setLoc] = useState<KhoReviewLocation>("q7");
  const [factorText, setFactorText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = normalizeName(query);
  const all = items.data?.items ?? [];
  const hits = key.length < 2 ? [] : all.filter((it) => normalizeName(it.name).includes(key) || normalizeName(it.item_code ?? "") === key).slice(0, 8);
  const picked: KhoItem | null = all.find((it) => it.id === pickedId) ?? null;
  const x = parseNum(factorText);
  const factorOk = Number.isFinite(x) && x > 0;
  const placed = picked ? (loc === "q7" ? picked.in_q7 : picked.in_tan_tao ?? !picked.in_q7) : false;

  const pick = (it: KhoItem) => {
    setPickedId(it.id);
    setError(null);
    setLoc(it.in_q7 ? "q7" : "tan_tao");
    const f = suggestedFactor(mat.recipe_unit, it.unit);
    setFactorText(f !== null ? String(f) : "");
  };
  const save = async () => {
    if (!picked || !factorOk) return;
    setBusy(true);
    setError(null);
    try {
      if (!picked.active) {
        const r = await saveItem.mutateAsync({ itemId: picked.id, name: picked.name, unit: picked.unit, active: true, requestId: newRequestId() });
        if (r.status === "name_taken") throw new Error(`Đã có món “${r.other.name}” cùng tên${r.other.active ? " đang bật" : ""}. Chọn món đó.`);
        if (r.status !== "saved") throw new Error("Chưa bật lại được món này. Mở Danh mục kho để bật.");
      }
      if (!placed) {
        const inTanTao = picked.in_tan_tao ?? !picked.in_q7;
        await setPlaces.mutateAsync({ itemId: picked.id, tanTao: inTanTao || loc === "tan_tao", q7: picked.in_q7 || loc === "q7", requestId: newRequestId() });
      }
      const { error: rpcError } = await (supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: unknown }> })
        .rpc("cogs_decide_ingredient", {
          p_canonical_material_id: mat.canonical_material_id, p_recipe_unit: mat.recipe_unit, p_action: "deduct",
          p_location: loc, p_item_id: picked.id, p_factor: x, p_request_id: newRequestId(),
        });
      if (rpcError) throw rpcError;
      void queryClient.invalidateQueries({ queryKey: [KHO_REVIEW_QUERY_KEY] });
      toast({ title: `Đã nối công thức vào “${picked.name}”`, description: `Kho ${KHO_LABEL[loc]} · 1 ${mat.recipe_unit} = ${fmtQty(x)} ${picked.unit}` });
      onDone();
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : khoReviewErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" className="d3-kr-pick" onClick={() => setOpen(true)} data-bmq-review-existing-open>
        Nối vào món kho có sẵn
      </Button>
    );
  }
  return (
    <section className="d3-kr-exist" data-bmq-review-existing>
      <div className="d3-kr-exist-head">
        <b>Nối vào món kho có sẵn</b>
        <small>Tìm cả món đang tắt. Công thức sẽ trừ vào món này.</small>
      </div>
      <span className="d3-kho-search">
        <Search aria-hidden="true" />
        <input value={query} onChange={(e) => { setQuery(e.target.value); setPickedId(null); }} placeholder="Tên hoặc mã món…" aria-label="Tìm món kho" enterKeyHint="search" data-bmq-review-existing-search />
        {query ? <button type="button" onClick={() => { setQuery(""); setPickedId(null); }} aria-label="Xóa tìm kiếm"><X /></button> : null}
      </span>
      {items.isLoading ? <LoadingState label="Đang đọc danh mục kho" />
        : items.isError ? <p className="d3-kho-error">Chưa đọc được danh mục kho. {khoReviewErrorText(items.error)}</p>
        : key.length >= 2 && !hits.length ? <p className="d3-kho-hint">Không có món nào tên “{query}”. Tạo món từ một dòng phiếu ở trên.</p>
        : (
          <ul className="d3-kr-exist-list">
            {hits.map((it) => (
              <li key={it.id}>
                <button type="button" className={cn("d3-kr-exist-item", it.id === pickedId && "is-on")} aria-pressed={it.id === pickedId} onClick={() => pick(it)} data-bmq-review-existing-item={it.id}>
                  <b>{it.name}</b>
                  <small>
                    <span>{it.item_code ?? "chưa có mã"}</span>
                    <span>{it.unit}</span>
                    <span>{[it.in_q7 ? "Kho Q7" : null, (it.in_tan_tao ?? !it.in_q7) ? "Kho Tân Tạo" : null].filter(Boolean).join(" · ")}</span>
                    {!it.active ? <span className="is-off">đang tắt</span> : null}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
      {picked ? (
        <div className="d3-kho-ask" data-bmq-review-existing-form>
          <div className="d3-kho-field"><span>Trừ ở kho</span>
            <div className="d3-kho-seg" role="group" aria-label="Kho trừ">
              {KHO_LOCATIONS.map((l) => (
                <button key={l} type="button" aria-pressed={loc === l} className={cn(loc === l && "is-on")} onClick={() => setLoc(l)} data-bmq-review-existing-loc={l}>Kho {KHO_LABEL[l]}</button>
              ))}
            </div>
          </div>
          <label className="d3-kho-conv">
            1 {mat.recipe_unit} =
            <Input inputMode="decimal" value={factorText} onChange={(e) => setFactorText(e.target.value)} placeholder="?" aria-label={`1 ${mat.recipe_unit} bằng bao nhiêu ${picked.unit}`} data-bmq-review-existing-factor />
            {picked.unit}
          </label>
          {!picked.active || !placed ? (
            <small data-bmq-review-existing-note>
              {[!picked.active ? "Món đang tắt, sẽ bật lại" : null, !placed ? `sẽ thêm món vào Kho ${KHO_LABEL[loc]}` : null].filter(Boolean).join("; ")}.
            </small>
          ) : null}
          {error ? <p className="d3-kho-error">{error}</p> : null}
          <div className="d3-kho-actions">
            <Button disabled={!factorOk || busy} onClick={() => void save()} data-bmq-review-existing-link>{busy ? "Đang nối…" : "Nối công thức vào món này"}</Button>
            <Button variant="outline" onClick={() => { setOpen(false); setPickedId(null); }}>Thôi</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MaterialReview({ mat, onClose, onJev, jevBusy }: { mat: KhoReviewMaterial; onClose: () => void; onJev: () => void; jevBusy: boolean }) {
  const { toast } = useToast();
  const create = useKhoReviewCreateItem();
  const [picked, setPicked] = useState<string | null>(null);
  const [extra, setExtra] = useState<KhoReviewCandidate[]>([]);
  const all = useMemo(() => [...extra.filter((e) => !mat.candidates.some((c) => c.receipt_item_id === e.receipt_item_id)), ...mat.candidates], [extra, mat.candidates]);
  const cand = all.find((c) => c.receipt_item_id === picked) ?? null;
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("g");
  const [cls, setCls] = useState<"raw_material" | "packaging_supply">("raw_material");
  const [factorText, setFactorText] = useState("");
  const [touched, setTouched] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const assist = useLineAssist(cand, unit, null);
  useSuggestedFactor(assist.suggestion, picked ? `${picked}:${unit}` : null, touched, setFactorText);
  const x = parseNum(factorText);
  const factorOk = Number.isFinite(x) && x > 0;

  const pick = (c: KhoReviewCandidate) => {
    setPicked(c.receipt_item_id);
    setName(c.product_name.trim());
    setTouched(false);
    const f = suggestedFactor(c.unit, unit);
    setFactorText(f !== null ? String(f) : "");
  };
  const save = () => {
    if (!cand || !factorOk || name.trim().length < 2) return;
    setLinkError(null);
    create.mutate({ receiptItemId: cand.receipt_item_id, name: name.trim(), unit, itemClass: cls, factor: x, requestId: newRequestId() }, {
      onSuccess: async (r) => {
        // Point the recipe line at the new item when the recipe unit converts by the standard table.
        const recipeFactor = suggestedFactor(mat.recipe_unit, unit);
        let recipeLinked = false;
        if (r.item_id && recipeFactor !== null) {
          const { error } = await (supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: unknown }> })
            .rpc("cogs_decide_ingredient", {
              p_canonical_material_id: mat.canonical_material_id, p_recipe_unit: mat.recipe_unit, p_action: "deduct",
              p_location: r.location, p_item_id: r.item_id, p_factor: recipeFactor, p_request_id: newRequestId(),
            });
          recipeLinked = !error;
          if (error) setLinkError("Đã tạo món nhưng chưa nối được vào công thức giá vốn. Nhắn VNAgent để nối.");
        }
        toast({
          title: `Đã tạo món “${name.trim()}” ở Kho ${KHO_LABEL[r.location]}`,
          description: recipeLinked ? "Công thức giá vốn đã trừ vào món này." : `Đơn vị công thức (${mat.recipe_unit}) khác đơn vị món (${unit}): nhắn VNAgent để nối công thức.`,
        });
        if (recipeLinked || recipeFactor === null) onClose();
      },
    });
  };

  return (
    <KhoDialog title={mat.name} sub={`NVL giá vốn · ${mat.recipe_unit} · ${mat.sku_codes.join(", ")}`} onClose={onClose} wide data={{ "data-bmq-review-dialog": "" }}>
      {mat.candidates.length && mat.candidates.some((c) => !c.jev_verdict) ? (
        <Button variant="outline" size="sm" className="d3-kr-pick" disabled={jevBusy} onClick={onJev} data-bmq-review-jev-one>{jevBusy ? "Jev đang chấm…" : "Nhờ Jev chấm các dòng này"}</Button>
      ) : null}
      <HiddenNote n={mat.hidden_different} />
      {all.length ? (
        <ul className="d3-kr-cands">
          {all.map((c) => (
            <CandidateCard key={c.receipt_item_id} c={c} note={c.linked_item_id ? "Tên này đã nối vào một món kho: dùng “Nối vào món kho có sẵn” bên dưới" : undefined}>
              {picked === c.receipt_item_id ? (
                <div className="d3-kho-ask">
                  {assist.panel}
                  <label className="d3-kho-field"><span>Tên món kho</span>
                    <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} data-bmq-review-name />
                  </label>
                  <div className="d3-kho-field"><span>Loại hàng</span>
                    <div className="d3-kho-seg" role="group" aria-label="Loại hàng">
                      <button type="button" aria-pressed={cls === "raw_material"} className={cn(cls === "raw_material" && "is-on")} onClick={() => setCls("raw_material")}>Nguyên liệu</button>
                      <button type="button" aria-pressed={cls === "packaging_supply"} className={cn(cls === "packaging_supply" && "is-on")} onClick={() => setCls("packaging_supply")}>Bao bì & vật tư</button>
                    </div>
                  </div>
                  <label className="d3-kho-field"><span>Đơn vị kho</span>
                    <select className="d3-kr-select" value={unit} onChange={(e) => { setUnit(e.target.value); setTouched(false); }} data-bmq-review-unit>
                      {ITEM_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </label>
                  <label className="d3-kho-conv">
                    1 {assist.unit ?? "đơn vị"} =
                    <Input inputMode="decimal" value={factorText} onChange={(e) => { setTouched(true); setFactorText(e.target.value); }} placeholder="?" aria-label={`1 ${assist.unit ?? "đơn vị"} bằng bao nhiêu ${unit}`} data-bmq-review-factor />
                    {unit}
                  </label>
                  {assist.suggestion && !touched ? <small data-bmq-review-factor-why>Điền {fmtQty(assist.suggestion.factor)} {assist.suggestion.why}.</small> : null}
                  {create.error ? <p className="d3-kho-error">{khoReviewErrorText(create.error)}</p> : null}
                  {linkError ? <p className="d3-kho-error">{linkError}</p> : null}
                  <div className="d3-kho-actions">
                    <Button disabled={!factorOk || name.trim().length < 2 || create.isPending} onClick={save} data-bmq-review-create>{create.isPending ? "Đang tạo…" : "Tạo món từ dòng này"}</Button>
                    <Button variant="outline" onClick={() => setPicked(null)}>Thôi</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" className="d3-kr-pick" onClick={() => pick(c)} data-bmq-review-pick>Tạo món từ dòng này</Button>
              )}
            </CandidateCard>
          ))}
        </ul>
      ) : <p className="d3-kho-hint">Chưa thấy phiếu mua nào có tên gần giống. Tìm phiếu bên dưới, hoặc nối vào món kho có sẵn.</p>}
      <LineSearch targetKey={mat.target_key} exclude={all.map((c) => c.receipt_item_id)} onPick={(r) => { setExtra((x) => [r, ...x]); pick(r); }} />
      <LinkExisting mat={mat} onDone={onClose} />
      {all.length ? <ReceiptNotes title="Ảnh phiếu giao của các dòng trên" lines={asLines(all)} loading={false} error={null} /> : null}
    </KhoDialog>
  );
}
