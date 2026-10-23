import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, FileText, Minus, Paperclip, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  useOrderSuppliers,
  usePreviewSupplierOrder,
  useSendSupplierOrderLines,
  useSetSupplierCatalogItem,
  useSupplierCatalog,
  useSupplierCatalogCandidates,
  useSupplierOrderHistoryBySupplier,
} from "@/hooks/useSupplierOrder";
import {
  SupplierOrderClientError,
  blockerLabel,
  computeOrderAmounts,
  createSupplierOrderRequestId,
  formatQuantity,
  formatVnd,
  type SendSupplierOrderLinesResult,
  type SupplierOrderCatalog,
  type SupplierOrderCatalogItem,
  type SupplierOrderHistoryBySupplierEntry,
  type SupplierOrderPreview,
} from "@/lib/supplier-order";
import { cn } from "@/lib/utils";
import { dmy, fmtAmount, parseNum } from "@/components/kho/kho-meta";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-kho.css";
import "@/styles/bmq-supplier-order.css";

/**
 * Đặt hàng (owner 23/10/2026): pick a supplier, set quantities from its catalog, read the exact email,
 * then send. Sending creates one PO, emails the supplier from order@bmq.vn with the invoice upload link,
 * and (gối đầu) submits the supplier's oldest unpaid payment request as Trình chi gấp.
 */

const ERROR_TEXT: Record<string, string> = {
  forbidden: "Chỉ chủ hoặc người được sửa PO mới đặt hàng được.",
  mailbox_not_connected: "Chưa kết nối hộp thư order@bmq.vn (Cài đặt → Email đặt hàng).",
  no_supplier_email: "Nhà cung cấp chưa có email đặt hàng.",
  no_price: "Một món chưa có giá mua gần nhất của nhà cung cấp.",
  over_quantity_limit: "Số lượng một món quá lớn so với mức dùng. Giảm bớt rồi lập lại.",
  over_amount_limit: "Đơn vượt hạn mức tiền cho một lần đặt.",
  invalid_lines: "Danh sách món chưa hợp lệ. Kiểm tra lại số lượng.",
  item_not_found: "Một món không còn trong danh mục của nhà cung cấp. Tải lại trang.",
  in_progress: "Đơn này đang được gửi. Đợi vài giây rồi xem lại danh sách đơn đã gửi.",
  email_failed: "Chưa gửi được email. Bấm gửi lại.",
  state_update_failed: "Email có thể đã gửi nhưng chưa lưu được trạng thái. Kiểm tra hộp thư order@bmq.vn trước khi gửi lại.",
  rate_limited: "Hôm nay đã gửi quá nhiều đơn. Thử lại sau.",
};

const STATUS_LABEL: Record<string, string> = { sent: "Đã gửi", failed: "Gửi lỗi", preparing: "Đang gửi" };

const PREPAY_LABEL: Record<string, string> = {
  created: "Đã trình chi gấp",
  skipped_none: "Không có phiếu chi chờ trả",
  skipped_recent: "Phiếu chi đã trình gần đây",
  declined: "Phiếu chi không còn trình được",
  forbidden: "Tài khoản chưa có quyền trình chi",
  failed: "Chưa trình chi được",
};

function errorText(error: unknown): string {
  if (error instanceof SupplierOrderClientError) return ERROR_TEXT[error.code] ?? "Chưa thực hiện được. Thử lại.";
  const code = (error as { code?: string } | null)?.code;
  if (code === "42501") return ERROR_TEXT.forbidden;
  return "Chưa thực hiện được. Thử lại.";
}

/** "1.000" is a vi-VN thousands group, "12,5" a decimal; anything else parses as typed. */
function readQty(text: string): number {
  const raw = text.trim();
  if (!raw) return 0;
  const value = parseNum(/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw) ? raw.replace(/\./g, "") : raw);
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

function stockLine(item: SupplierOrderCatalogItem) {
  const { onHand, daysLeft } = item.stock;
  return (
    <>
      Tồn Q7 {fmtAmount(onHand, item.item.unit)}
      {daysLeft === null ? null : daysLeft <= 0
        ? <span className="is-bad" data-bmq-so-out> · đã hết</span>
        : <> · đủ ~{formatQuantity(daysLeft)} ngày</>}
    </>
  );
}

/** One line of the shared amount rule (same as the server quote): list price first, else the PO price. */
const amountInput = (item: SupplierOrderCatalogItem, quantity: number) => ({
  quantity,
  unitPrice: item.listPrice !== null ? item.unitPrice : (item.historyPrice ?? item.unitPrice),
  vatRate: item.vatRate,
  listPrice: item.listPrice,
  listPriceIncludesVat: item.listPriceIncludesVat,
});

/** "20.840 đ/kg gồm VAT", "90.000 đ/kg" — the price the supplier quotes, as it quotes it. */
function priceLabel(item: SupplierOrderCatalogItem): string {
  if (item.listPrice !== null) return `${formatVnd(item.listPrice)}/${item.poUnit}${item.vatRate > 0 ? (item.listPriceIncludesVat ? " gồm VAT" : " chưa VAT") : ""}`;
  if (item.unitPrice !== null) return `${formatVnd(item.unitPrice)}/${item.poUnit}${item.vatRate > 0 ? " chưa VAT" : ""} · giá PO gần nhất`;
  return "Chưa có giá";
}

async function openUpload(path: string) {
  const { data } = await supabase.storage.from("supplier-delivery-docs").createSignedUrl(path, 600);
  if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener");
}

/**
 * The real email, in a frame with no scripts. On a narrow screen the email (laid out for 600px) is scaled
 * down to the frame's width so every column shows; the frame then grows to the email's height.
 */
function EmailFrame({ html, title }: { html: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(640);
  const fit = () => {
    const frame = ref.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body) return;
    doc.body.style.zoom = "";
    const room = frame.clientWidth;
    // Zoom changes the layout a little (rounding, body margin), so measure again and shrink until it fits.
    let zoom = 1;
    for (let tries = 0; room > 0 && tries < 4 && doc.documentElement.scrollWidth > room + 1; tries += 1) {
      zoom = Math.floor(zoom * (room / doc.documentElement.scrollWidth) * 1000) / 1000;
      doc.body.style.zoom = String(zoom);
    }
    setHeight(Math.max(320, Math.ceil(doc.documentElement.scrollHeight) + 2));
  };
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });
  return (
    <iframe ref={ref} className="d3-so-mail" title={title} srcDoc={html} sandbox="allow-same-origin" onLoad={fit}
      style={{ height }} data-bmq-so-mail />
  );
}

function PriceEditor({ item, supplierId, onToast }: { item: SupplierOrderCatalogItem; supplierId: string; onToast: (text: string) => void }) {
  const setItem = useSetSupplierCatalogItem();
  const [text, setText] = useState(item.listPrice !== null ? formatQuantity(item.listPrice) : "");
  const [gross, setGross] = useState(item.listPrice !== null ? item.listPriceIncludesVat : item.vatRate > 0);
  const value = readQty(text);
  const bad = Number.isNaN(value);
  const save = () => {
    if (bad) return;
    setItem.mutate({
      supplierId, itemId: item.item.id, active: true,
      // Keep the rest of the catalog row as it is: the RPC writes these on every save.
      poUnit: item.poUnit, packSizePo: item.packSizePo, productName: item.productName,
      listPrice: value > 0 ? value : 0, listPriceIncludesVat: gross,
    }, {
      onSuccess: () => onToast(value > 0 ? `Đã lưu giá ${item.item.name}` : `Đã bỏ giá NCC của ${item.item.name}, dùng giá PO gần nhất`),
      onError: () => onToast("Chưa lưu được giá. Thử lại."),
    });
  };
  return (
    <div className="d3-so-price-edit" data-bmq-so-price-edit={item.item.id}>
      <label className="d3-so-price-input">
        <span>Giá NCC</span>
        <Input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} placeholder="—"
          aria-label={`Giá NCC ${item.productName} (đ/${item.poUnit})`} aria-invalid={bad || undefined} data-bmq-so-price={item.item.id} />
        <span>đ/{item.poUnit}</span>
      </label>
      {item.vatRate > 0 ? (
        <label className="d3-so-price-vat">
          <input type="checkbox" checked={gross} onChange={(event) => setGross(event.target.checked)} data-bmq-so-price-gross={item.item.id} />
          <span>đã gồm VAT {formatQuantity(item.vatRate)}%</span>
        </label>
      ) : null}
      <Button size="sm" variant="outline" onClick={save} disabled={bad || setItem.isPending} data-bmq-so-price-save={item.item.id}>Lưu giá</Button>
      <small className="d3-so-price-source">
        {item.listPrice !== null
          ? `Nguồn giá: ${item.listPriceSource ?? "chưa ghi"}${item.listPriceUpdatedAt ? ` · cập nhật ${dmy(item.listPriceUpdatedAt)}` : ""}. Xoá số rồi lưu để dùng giá PO gần nhất.`
          : "Chưa có giá NCC: đang lấy giá PO gần nhất. Nhập giá NCC báo rồi lưu."}
      </small>
    </div>
  );
}

function OrderLine({ item, supplierId, qtyText, onQty, editing, onRemove, removing, onToast }: {
  item: SupplierOrderCatalogItem;
  supplierId: string;
  qtyText: string;
  onQty: (text: string) => void;
  editing: boolean;
  onRemove: () => void;
  removing: boolean;
  onToast: (text: string) => void;
}) {
  const qty = readQty(qtyText);
  const bad = Number.isNaN(qty);
  const priced = item.listPrice !== null || item.unitPrice !== null;
  // What this line costs to pay, VAT included, by the same rule as the server quote.
  const total = !bad && qty > 0 && priced ? computeOrderAmounts([amountInput(item, qty)]).lines[0].grossAmount : null;
  const step = item.packSizePo && item.packSizePo > 0 ? item.packSizePo : 1;
  const bump = (sign: 1 | -1) => {
    const base = bad ? 0 : qty;
    const next = Math.max(0, Math.round((base + sign * step) * 1000) / 1000);
    onQty(next > 0 ? formatQuantity(next) : "");
  };
  // The kho name only adds something when it is not the supplier's wording minus its "(25kg)" bracket.
  const bare = (text: string) => text.replace(/\s*\([^()]*\)\s*$/, "").trim().toLowerCase();
  const showKhoName = bare(item.item.name) !== bare(item.productName);

  return (
    <li className={cn("d3-so-line", qty > 0 && "is-picked")} data-bmq-so-line={item.item.id}>
      <div className="d3-so-line-main">
        <b>{item.productName}</b>
        <small>
          {showKhoName ? <span>{item.item.name}</span> : null}
          <span data-bmq-so-price-label>{priceLabel(item)}</span>
          {item.packSizePo ? <span>bao {formatQuantity(item.packSizePo)} {item.poUnit}</span> : null}
          <span>{item.vatRate > 0 ? `VAT ${formatQuantity(item.vatRate)}%` : "không VAT"}</span>
        </small>
        <p className="d3-so-stock">
          {stockLine(item)}
          <span className="d3-so-proposal"> · {item.proposalQty > 0 ? `đề xuất ${formatQuantity(item.proposalQty)} ${item.poUnit}` : "chưa cần đặt"}</span>
        </p>
        {item.openOrder ? (
          <p className="d3-so-open" data-bmq-so-open-po>
            {item.openOrder.poNumber} ({formatQuantity(item.openOrder.quantity)} {item.openOrder.unit}) đã gửi, chưa nhận hàng.
          </p>
        ) : null}
      </div>
      <div className="d3-so-line-qty">
        <div className="d3-so-stepper">
          <button type="button" onClick={() => bump(-1)} disabled={bad ? false : qty <= 0} aria-label={`Bớt ${formatQuantity(step)} ${item.poUnit} ${item.productName}`}><Minus aria-hidden="true" /></button>
          <Input inputMode="decimal" value={qtyText} onChange={(event) => onQty(event.target.value)}
            aria-label={`Số lượng ${item.productName} (${item.poUnit})`} aria-invalid={bad || undefined} data-bmq-so-qty={item.item.id} />
          <button type="button" onClick={() => bump(1)} aria-label={`Thêm ${formatQuantity(step)} ${item.poUnit} ${item.productName}`}><Plus aria-hidden="true" /></button>
          <span className="d3-so-unit">{item.poUnit}</span>
        </div>
        <b className="d3-so-line-total" data-bmq-so-line-total>{bad ? "Số chưa đúng" : total !== null ? formatVnd(total) : ""}</b>
      </div>
      {editing ? (
        <>
          <PriceEditor key={`${item.listPrice}-${item.listPriceIncludesVat}`} item={item} supplierId={supplierId} onToast={onToast} />
          <button type="button" className="d3-so-remove" onClick={onRemove} disabled={removing} data-bmq-so-remove={item.item.id}>
            <X aria-hidden="true" /> Bỏ khỏi danh mục
          </button>
        </>
      ) : null}
    </li>
  );
}

function CatalogAdder({ supplierId, onToast }: { supplierId: string; onToast: (text: string) => void }) {
  const candidates = useSupplierCatalogCandidates(supplierId);
  const setItem = useSetSupplierCatalogItem();
  const rows = candidates.data ?? [];
  if (candidates.isLoading) return <LoadingState flat rows={2} label="Đang tìm món đã từng mua" />;
  if (!rows.length) return <p className="d3-kho-hint" data-bmq-so-no-candidates>Không còn món nào khác nhà cung cấp này từng giao.</p>;
  return (
    <div className="d3-so-adder" data-bmq-so-candidates>
      <p className="d3-kho-hint">Món nhà cung cấp này từng giao, chưa có trong danh mục:</p>
      <ul>
        {rows.map((row) => (
          <li key={row.itemId}>
            <span>
              <b>{row.latestProductName || row.name}</b>
              <small>{row.name} · {row.lineCount} lần trên phiếu{row.lastOrderDate ? ` · gần nhất ${dmy(row.lastOrderDate)}` : ""}</small>
            </span>
            <Button size="sm" variant="outline" disabled={setItem.isPending}
              onClick={() => setItem.mutate({ supplierId, itemId: row.itemId, active: true, poUnit: "kg" }, {
                onSuccess: () => onToast(`Đã thêm ${row.name} vào danh mục`),
                onError: (error) => onToast((error as { message?: string }).message?.includes("unit_not_convertible")
                  ? `${row.name} không đặt theo kg được. Món này cần đơn vị đặt khác.`
                  : "Chưa thêm được món. Thử lại."),
              })} data-bmq-so-add={row.itemId}>
              <Plus aria-hidden="true" /> Thêm
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function History({ rows }: { rows: SupplierOrderHistoryBySupplierEntry[] }) {
  if (!rows.length) return <p className="d3-kho-hint" data-bmq-so-history-empty>Chưa có đơn nào gửi qua email cho nhà cung cấp này.</p>;
  return (
    <ul className="d3-so-hist" data-bmq-so-history>
      {rows.map((row) => (
        <li key={row.id ?? row.requestId ?? row.poNumber ?? ""}>
          <div className="d3-so-hist-head">
            <b>{row.poNumber ?? "PO chưa tạo"}</b>
            <span>{dmy(row.sentAt ?? row.createdAt)}</span>
            <span className={cn("d3-so-status", row.status === "failed" && "is-bad", row.status === "sent" && "is-ok")}>{STATUS_LABEL[row.status] ?? row.status}</span>
            <b className="d3-so-hist-total">{row.total !== null ? formatVnd(row.total) : ""}</b>
          </div>
          <p className="d3-so-hist-lines">{row.lines.map((line) => `${line.productName} ${formatQuantity(line.quantity)} ${line.unit}`).join(" · ")}</p>
          {row.prepay?.status === "created" ? (
            <p className="d3-so-hist-meta">Gối đầu: {row.prepay.submissionNumber} ({row.prepay.requestNumber})</p>
          ) : null}
          {row.uploads.length ? (
            <div className="d3-kho-order-files">
              {row.uploads.map((file, index) => (
                <button key={file.storagePath} type="button" onClick={() => void openUpload(file.storagePath)}>
                  {file.mimeType === "application/pdf" ? <FileText aria-hidden="true" /> : <Paperclip aria-hidden="true" />}
                  {file.fileName ?? `File ${index + 1}`}
                </button>
              ))}
            </div>
          ) : row.status === "sent" ? (
            <p className="d3-so-hist-meta">Nhà cung cấp chưa tải hoá đơn giao hàng</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PrepayChoice({ catalog, checked, onChange }: { catalog: SupplierOrderCatalog; checked: boolean; onChange: (value: boolean) => void }) {
  const pr = catalog.prepay;
  if (!pr) {
    return <p className="d3-so-prepay is-none" data-bmq-so-prepay="none">Gối đầu: nhà cung cấp này không có phiếu chi nào đang chờ trả.</p>;
  }
  if (pr.recentSubmission) {
    return (
      <p className="d3-so-prepay is-none" data-bmq-so-prepay="recent">
        Gối đầu: {pr.requestNumber} đã nằm trong {pr.recentSubmission.submissionNumber} ngày {dmy(pr.recentSubmission.createdAt)}, lần này không trình lại.
      </p>
    );
  }
  return (
    <label className="d3-so-prepay" data-bmq-so-prepay="pr">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} data-bmq-so-prepay-check />
      <span>
        <b>Trình chi gấp gối đầu {pr.requestNumber}</b>
        <small>
          {formatVnd(pr.remaining ?? pr.totalAmount)} · lập ngày {dmy(pr.createdAt)}{pr.poNumber ? ` · ${pr.poNumber}` : ""}. Phiếu chi chưa trả cũ nhất của nhà cung cấp này.
        </small>
      </span>
    </label>
  );
}

type Step = "form" | "preview" | "sent";

function SupplierPanel({ supplierId, onToast }: { supplierId: string; onToast: (text: string) => void }) {
  const catalog = useSupplierCatalog(supplierId);
  const history = useSupplierOrderHistoryBySupplier(supplierId);
  const preview = usePreviewSupplierOrder();
  const send = useSendSupplierOrderLines();
  const setItem = useSetSupplierCatalogItem();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [seeded, setSeeded] = useState(false);
  const [note, setNote] = useState("");
  const [prepay, setPrepay] = useState(true);
  const [step, setStep] = useState<Step>("form");
  const [editing, setEditing] = useState(false);
  const [requestId, setRequestId] = useState(createSupplierOrderRequestId);
  const [shown, setShown] = useState<SupplierOrderPreview | null>(null);
  const [result, setResult] = useState<SendSupplierOrderLinesResult | null>(null);
  const top = useRef<HTMLElement>(null);
  const data = catalog.data;

  // Start from the proposals once per supplier; the person changes them freely afterwards.
  useEffect(() => {
    if (seeded || !data) return;
    const start: Record<string, string> = {};
    for (const item of data.items) if (item.proposalQty > 0) start[item.item.id] = formatQuantity(item.proposalQty);
    setQty(start);
    setSeeded(true);
  }, [data, seeded]);

  const lines = useMemo(() => (data?.items ?? [])
    .map((item) => ({ item, value: readQty(qty[item.item.id] ?? "") }))
    .filter(({ value }) => Number.isNaN(value) || value > 0), [data, qty]);
  const invalid = lines.some(({ value }) => Number.isNaN(value));
  // Same rule as the server quote (list price gồm VAT → tiền hàng = tổng / 1,08; else VAT on the PO price).
  const amounts = computeOrderAmounts(lines
    .filter(({ item, value }) => !Number.isNaN(value) && (item.listPrice !== null || item.unitPrice !== null))
    .map(({ item, value }) => amountInput(item, value)));
  const subtotal = amounts.subtotal;
  const vat = amounts.vatAmount;
  const total = amounts.total;
  const blockers = data?.blockers ?? [];
  const usePrepay = Boolean(prepay && data?.prepay && !data.prepay.recentSubmission);

  const scrollTop = () => top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  const body = () => ({
    supplierId,
    lines: lines.map(({ item, value }) => ({ itemId: item.item.id, quantity: value })),
    note: note.trim(),
    requestId,
    prepay: usePrepay,
  });

  const makePreview = () => {
    if (!lines.length || invalid || blockers.length) return;
    send.reset();
    preview.mutate(body(), {
      onSuccess: (value) => { setShown(value); setStep("preview"); scrollTop(); },
    });
  };
  const backToForm = () => {
    setStep("form");
    setShown(null);
    send.reset();
    // A changed order is a new order: a fresh id, so a retry never replays the old lines.
    setRequestId(createSupplierOrderRequestId());
  };
  const doSend = () => {
    send.mutate(body(), {
      onSuccess: (value) => {
        setResult(value);
        setStep("sent");
        setQty({});
        setNote("");
        setShown(null);
        setRequestId(createSupplierOrderRequestId());
        onToast(`Đã gửi ${value.poNumber ?? "đơn"} tới ${value.toEmail ?? "nhà cung cấp"}`);
        scrollTop();
      },
    });
  };

  if (catalog.isLoading) return <section className="d3-wh-card"><LoadingState rows={3} flat label="Đang tính lượng cần đặt" /></section>;
  if (catalog.error || !data) {
    return (
      <section className="d3-wh-card">
        <div className="d3-kho-failed" role="alert">
          <p>{errorText(catalog.error)}</p>
          <Button variant="outline" onClick={() => void catalog.refetch()}>Thử lại</Button>
        </div>
      </section>
    );
  }

  const supplierName = data.supplier?.name ?? "nhà cung cấp";

  return (
    <>
      <section className="d3-wh-card d3-so-card" ref={top} data-bmq-so-card data-bmq-so-step={step}>
        {step === "form" ? (
          <>
            <div className="d3-so-card-head">
              <div className="min-w-0">
                <h2>Đơn mới cho {supplierName}</h2>
                <p>Gửi tới <b className="is-wrap">{data.supplier?.email || "chưa có email"}</b> từ order@bmq.vn, kèm link để NCC tải hoá đơn giao hàng.</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setEditing((value) => !value)} aria-pressed={editing} data-bmq-so-edit>
                {editing ? <><Check aria-hidden="true" /> Xong</> : "Sửa danh mục"}
              </Button>
            </div>

            {data.items.length ? (
              <ul className="d3-so-lines" data-bmq-so-lines>
                {data.items.map((item) => (
                  <OrderLine key={item.item.id} item={item} supplierId={supplierId} onToast={onToast} qtyText={qty[item.item.id] ?? ""} editing={editing} removing={setItem.isPending}
                    onQty={(text) => setQty((prev) => ({ ...prev, [item.item.id]: text }))}
                    onRemove={() => setItem.mutate({ supplierId, itemId: item.item.id, active: false }, {
                      onSuccess: () => { setQty((prev) => { const next = { ...prev }; delete next[item.item.id]; return next; }); onToast(`Đã bỏ ${item.item.name} khỏi danh mục`); },
                      onError: () => onToast("Chưa bỏ được món. Thử lại."),
                    })} />
                ))}
              </ul>
            ) : (
              <p className="d3-kho-hint" data-bmq-so-empty>Danh mục của {supplierName} đang trống. Bấm Sửa danh mục để thêm món đã từng mua.</p>
            )}
            {editing ? <CatalogAdder supplierId={supplierId} onToast={onToast} /> : null}

            <div className="d3-so-foot">
              <p className="d3-so-delivery">
                Giao tới {data.delivery.address || "—"}{data.delivery.contactName ? ` · ${data.delivery.contactName}` : ""}{data.delivery.contactPhone ? ` ${data.delivery.contactPhone}` : ""}
              </p>
              <label className="d3-kho-field">
                <span>Ghi chú cho NCC (không bắt buộc)</span>
                <textarea className="d3-kho-notearea" rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)}
                  placeholder="Ví dụ: giao trước 10h sáng" data-bmq-so-note />
              </label>
              <PrepayChoice catalog={data} checked={prepay} onChange={setPrepay} />
              {blockers.length ? (
                <ul className="d3-kho-error d3-kho-order-blockers" data-bmq-so-blockers>
                  {blockers.map((code) => <li key={code}>{blockerLabel(code)}</li>)}
                </ul>
              ) : null}
              {preview.error ? <p className="d3-kho-error" role="alert" data-bmq-so-error>{errorText(preview.error)}</p> : null}
              <div className="d3-so-submit">
                <div className="d3-so-total">
                  {vat > 0 ? (
                    <dl className="d3-so-sum" data-bmq-so-sum>
                      <div><dt>Tiền hàng</dt><dd data-bmq-so-subtotal>{formatVnd(subtotal)}</dd></div>
                      <div><dt>Thuế GTGT</dt><dd data-bmq-so-vat>{formatVnd(vat)}</dd></div>
                    </dl>
                  ) : null}
                  <span>{lines.length ? `${lines.length} món · tổng thanh toán` : "Chưa chọn món"}</span>
                  <b data-bmq-so-total>{formatVnd(total)}</b>
                </div>
                <Button onClick={makePreview} disabled={!lines.length || invalid || blockers.length > 0 || preview.isPending} data-bmq-so-make>
                  {preview.isPending ? "Đang lập phiếu…" : "Lập phiếu đặt hàng"}
                </Button>
              </div>
            </div>
          </>
        ) : step === "preview" && shown ? (
          <div className="d3-so-preview" data-bmq-so-preview>
            <div className="d3-so-card-head">
              <div className="min-w-0">
                <h2>Xem trước email</h2>
                <p>Đây đúng là email nhà cung cấp sẽ nhận. Số PO và link tải hoá đơn được cấp khi gửi.</p>
              </div>
            </div>
            <dl className="d3-so-facts">
              <div><dt>Gửi tới</dt><dd className="is-wrap">{shown.toEmail || "—"}</dd></div>
              <div><dt>Tiêu đề</dt><dd className="is-wrap">{shown.subject}</dd></div>
              <div>
                <dt>Tổng thanh toán</dt>
                <dd data-bmq-so-preview-total>
                  {formatVnd(shown.total)}
                  {shown.vatAmount ? <small> · gồm VAT {formatVnd(shown.vatAmount)}</small> : null}
                </dd>
              </div>
              <div>
                <dt>Gối đầu</dt>
                <dd>{usePrepay && shown.prepay ? `Trình chi gấp ${shown.prepay.requestNumber} · ${formatVnd(shown.prepay.remaining ?? shown.prepay.totalAmount)}` : "Không trình chi"}</dd>
              </div>
            </dl>
            <EmailFrame html={shown.html} title={`Email đặt hàng gửi ${supplierName}`} />
            {send.error ? <p className="d3-kho-error" role="alert" data-bmq-so-send-error>{errorText(send.error)}</p> : null}
            <div className="d3-so-actions">
              <Button onClick={doSend} disabled={send.isPending} data-bmq-so-send>{send.isPending ? "Đang gửi…" : "Gửi email đặt hàng"}</Button>
              <Button variant="outline" onClick={backToForm} disabled={send.isPending} data-bmq-so-back><ArrowLeft aria-hidden="true" /> Sửa lại</Button>
            </div>
          </div>
        ) : step === "sent" && result ? (
          <div className="d3-so-done" role="status" data-bmq-so-done>
            <span className="d3-so-done-mark" aria-hidden="true"><Check /></span>
            <div className="min-w-0">
              <h2>Đã gửi {result.poNumber ?? "đơn"}</h2>
              <p>Email đã tới {result.toEmail ?? supplierName}. Khi giao hàng, nhà cung cấp tải hoá đơn qua link trong email.</p>
              {result.prepay ? (
                <p data-bmq-so-done-prepay>
                  {result.prepay.status === "created"
                    ? `Gối đầu: đã trình chi gấp ${result.prepay.submissionNumber} cho ${result.prepay.requestNumber}.`
                    : `Gối đầu: ${PREPAY_LABEL[result.prepay.status] ?? result.prepay.status}${result.prepay.requestNumber ? ` (${result.prepay.requestNumber})` : ""}.`}
                </p>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => { setStep("form"); setResult(null); setSeeded(false); }} data-bmq-so-new>Lập đơn mới</Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="d3-wh-card d3-so-card" data-bmq-so-history-card>
        <div className="d3-so-card-head"><h2>Đơn đã gửi</h2></div>
        {history.isLoading ? <LoadingState flat rows={2} label="Đang đọc đơn đã gửi" /> : <History rows={history.data ?? []} />}
      </section>
    </>
  );
}

export default function SupplierOrders() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const suppliers = useOrderSuppliers();
  const list = suppliers.data ?? [];
  const wanted = params.get("ncc");
  const current = list.find((row) => row.id === wanted) ?? list[0] ?? null;
  const onToast = (text: string) => toast({ title: text });

  return (
    <div className="d3-wh d3-kho d3-so min-w-0" data-bmq-supplier-orders>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>Đặt hàng</h1>
          <p className="d3-wh-tag">Gửi đơn cho nhà cung cấp từ order@bmq.vn, xem trước email rồi mới gửi.</p>
        </div>
      </header>

      {suppliers.isLoading ? (
        <section className="d3-wh-card"><LoadingState rows={3} flat label="Đang đọc nhà cung cấp" /></section>
      ) : suppliers.error ? (
        <section className="d3-wh-card">
          <div className="d3-kho-failed" role="alert">
            <p>{errorText(suppliers.error)}</p>
            <Button variant="outline" onClick={() => void suppliers.refetch()}>Thử lại</Button>
          </div>
        </section>
      ) : !current ? (
        <section className="d3-wh-card"><p className="d3-kho-hint" data-bmq-so-no-suppliers>Chưa có nhà cung cấp nào có danh mục đặt hàng.</p></section>
      ) : (
        <>
          <div className="d3-kho-tabs d3-so-tabs" role="tablist" aria-label="Nhà cung cấp" data-bmq-so-suppliers>
            {list.map((row) => (
              <button key={row.id} type="button" role="tab" aria-selected={row.id === current.id} className={cn(row.id === current.id && "is-on")}
                onClick={() => setParams((prev) => { const next = new URLSearchParams(prev); next.set("ncc", row.id); return next; }, { replace: true })}
                data-bmq-so-supplier={row.id}>
                {row.name}<small>{row.itemCount} món</small>
              </button>
            ))}
          </div>
          <SupplierPanel key={current.id} supplierId={current.id} onToast={onToast} />
        </>
      )}
    </div>
  );
}
