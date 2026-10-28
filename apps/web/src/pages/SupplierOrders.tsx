import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, ChevronRight, FileText, Minus, Paperclip, Plus, Search, X } from "lucide-react";
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
  useSetSupplierOrderEmail,
  useSupplierCatalog,
  useSupplierCatalogCandidates,
  useSupplierOrderHistoryBySupplier,
} from "@/hooks/useSupplierOrder";
import {
  SupplierOrderClientError,
  blockerLabel,
  computeOrderAmounts,
  createSupplierOrderRequestId,
  filterSupplierOrderSuppliers,
  formatQuantity,
  formatVnd,
  sortSupplierOrderSuppliersByUrgency,
  type SendSupplierOrderLinesResult,
  type SupplierOrderCatalog,
  type SupplierOrderCatalogItem,
  type SupplierOrderHistoryBySupplierEntry,
  type SupplierOrderPreview,
  type SupplierOrderSupplierFilter,
  type SupplierOrderSupplierListEntry,
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

const RECEIPT_LABEL: Record<string, string> = { draft: "nháp", confirmed: "chờ kho xác nhận", received: "đã nhập kho" };
const PR_LABEL: Record<string, string> = { pending: "chờ duyệt", approved: "đã duyệt", rejected: "từ chối" };
const PAY_LABEL: Record<string, string> = { unpaid: "chưa trả", partial: "trả một phần", paid: "đã trả", overpaid: "trả dư" };

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

const LOCATION_LABEL: Record<string, string> = { q7: "Q7", tan_tao: "Tân Tạo" };
const locationLabel = (code: string) => LOCATION_LABEL[code] ?? code;

/** No count and no usage on record: a 0 here means "unknown", not "in stock" or "empty". */
const neverCounted = (item: SupplierOrderCatalogItem) =>
  !item.estimated && item.stock.lastCountDate === null && item.stock.dailyUsage <= 0;

function stockLine(item: SupplierOrderCatalogItem) {
  const { onHand, daysLeft } = item.stock;
  const where = locationLabel(item.location);
  if (onHand === null) return <>Tồn {where}: chưa có số tồn</>;
  if (neverCounted(item) && onHand <= 0) return <span data-bmq-so-uncounted>Tồn {where}: chưa kiểm kê</span>;
  return (
    <>
      Tồn {where} {fmtAmount(onHand, item.item.unit)}
      {item.estimated ? <span className="d3-so-est" title="Tân Tạo chưa ghi lượng dùng, số ngày ước từ phiếu nhập"> (ước lượng)</span> : null}
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
          <span className="d3-so-proposal"> · {item.proposalQty > 0
            ? `đề xuất ${formatQuantity(item.proposalQty)} ${item.poUnit}`
            : item.stock.dailyUsage <= 0 ? "chưa có lượng dùng để đề xuất" : "chưa cần đặt"}</span>
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
          {row.receipt || row.payment ? (
            <dl className="d3-so-chain" data-bmq-so-chain>
              <div>
                <dt>Nhập kho</dt>
                <dd className={cn(row.receipt?.status === "received" && "is-ok")}>
                  {row.receipt ? `${row.receipt.receiptNumber ?? "—"} · ${RECEIPT_LABEL[row.receipt.status] ?? row.receipt.status}` : "chưa có phiếu nhập"}
                </dd>
              </div>
              <div>
                <dt>Thanh toán</dt>
                <dd className={cn(row.payment?.paymentStatus === "paid" && "is-ok")}>
                  {row.payment
                    ? `${row.payment.requestNumber ?? "—"} · ${PR_LABEL[row.payment.status] ?? row.payment.status} · ${PAY_LABEL[row.payment.paymentStatus] ?? row.payment.paymentStatus}`
                    : "chưa có đề nghị thanh toán"}
                </dd>
              </div>
            </dl>
          ) : null}
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

function SupplierEmailEditor({ supplierId, onToast }: { supplierId: string; onToast: (text: string) => void }) {
  const save = useSetSupplierOrderEmail();
  const [text, setText] = useState("");
  const email = text.trim();
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return (
    <form className="d3-so-email" data-bmq-so-email-form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ok) return;
        save.mutate({ supplierId, email }, {
          onSuccess: () => onToast(`Đã lưu email ${email.toLowerCase()}`),
          onError: (error) => onToast((error as { code?: string }).code === "42501"
            ? "Chỉ chủ hoặc người được sửa Đặt hàng mới lưu được email."
            : "Chưa lưu được email. Kiểm tra lại địa chỉ."),
        });
      }}>
      <label className="d3-kho-field">
        <span>Email nhận đơn của NCC</span>
        <Input type="email" inputMode="email" autoComplete="off" value={text} onChange={(event) => setText(event.target.value)}
          placeholder="ten@congty.vn" aria-invalid={email && !ok ? true : undefined} data-bmq-so-email-input />
      </label>
      <Button type="submit" variant="outline" disabled={!ok || save.isPending} data-bmq-so-email-save>
        {save.isPending ? "Đang lưu…" : "Lưu email"}
      </Button>
    </form>
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
          {formatVnd(pr.remaining ?? pr.totalAmount)} · lập ngày {dmy(pr.createdAt)}{pr.poNumber ? ` · ${pr.poNumber}` : ""}. Phiếu chi chưa trả của lần giao gần nhất.
        </small>
        {pr.officialInvoice ? (
          <small className="d3-so-prepay-inv is-ok" data-bmq-so-prepay-invoice="official">
            Đã có hoá đơn chính thức {pr.officialInvoice.invoiceSeries}-{pr.officialInvoice.invoiceNumber}
            {pr.officialInvoice.invoiceDate ? ` ngày ${dmy(pr.officialInvoice.invoiceDate)}` : ""}
          </small>
        ) : (
          <small className="d3-so-prepay-inv is-warn" data-bmq-so-prepay-invoice="none">
            Chưa có hoá đơn chính thức từ hoadon@ — kiểm tra trước khi trình chi
          </small>
        )}
      </span>
    </label>
  );
}

type Step = "form" | "preview" | "sent";

function SupplierPanel({ supplierId, onToast, onBack }: { supplierId: string; onToast: (text: string) => void; onBack: () => void }) {
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
  const noEmail = !data.supplier?.email;

  return (
    <>
      <button type="button" className="d3-so-back" onClick={onBack} data-bmq-so-back-list>
        <ArrowLeft aria-hidden="true" /> Tất cả nhà cung cấp
      </button>
      <section className="d3-wh-card d3-so-card" ref={top} data-bmq-so-card data-bmq-so-step={step}>
        {step === "form" ? (
          <>
            <div className="d3-so-card-head">
              <div className="min-w-0">
                <h2>Đơn mới cho {supplierName}</h2>
                <p>Gửi tới <b className="is-wrap">{data.supplier?.email || "chưa có email"}</b> từ order@bmq.vn, kèm link để NCC tải hoá đơn giao hàng.</p>
              </div>
              <div className="d3-so-head-actions">
                <Button asChild variant="ghost" size="sm" data-bmq-so-profile-link>
                  <Link to={`/suppliers?id=${supplierId}`}>Hồ sơ NCC</Link>
                </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing((value) => !value)} aria-pressed={editing} data-bmq-so-edit>
                {editing ? <><Check aria-hidden="true" /> Xong</> : "Sửa danh mục"}
              </Button>
              </div>
            </div>

            {noEmail ? <SupplierEmailEditor supplierId={supplierId} onToast={onToast} /> : null}

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

const FILTERS: { id: SupplierOrderSupplierFilter; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "need_order", label: "Cần đặt" },
  { id: "low_stock", label: "Sắp hết" },
  { id: "no_email", label: "Chưa có email" },
];

function SupplierRow({ row, on, onPick }: { row: SupplierOrderSupplierListEntry; on: boolean; onPick: () => void }) {
  const tone = row.outOfStockCount > 0 ? "is-bad" : row.needOrderCount > 0 ? "is-warn" : row.lowStockCount > 0 ? "is-warn" : "";
  return (
    <li>
      <button type="button" className={cn("d3-so-sup", on && "is-on")} onClick={onPick} aria-current={on || undefined} data-bmq-so-supplier={row.id}>
        <span className="d3-so-sup-main">
          <b>{row.name}</b>
          <small>
            <span>{row.activeItemCount} món</span>
            {row.locations.length ? <span>{row.locations.map(locationLabel).join(" · ")}</span> : null}
            {row.lastOrder?.sentAt ? <span>đơn gần nhất {dmy(row.lastOrder.sentAt)}</span> : null}
            {row.unpaidCount > 0 ? <span>{row.unpaidCount} phiếu chưa trả</span> : null}
          </small>
        </span>
        <span className="d3-so-sup-flags">
          {row.outOfStockCount > 0 ? <em className="is-bad">{row.outOfStockCount} đã hết</em> : null}
          {row.needOrderCount > 0 ? <em className={tone}>{row.needOrderCount} cần đặt</em>
            : row.lowStockCount > 0 ? <em className="is-warn">{row.lowStockCount} sắp hết</em> : null}
          {!row.hasEmail ? <em className="is-muted">chưa có email</em> : null}
        </span>
        <ChevronRight className="d3-so-sup-go" aria-hidden="true" />
      </button>
    </li>
  );
}

export default function SupplierOrders() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const suppliers = useOrderSuppliers();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SupplierOrderSupplierFilter>("all");
  const list = useMemo(() => sortSupplierOrderSuppliersByUrgency(suppliers.data ?? []), [suppliers.data]);
  const shown = useMemo(() => filterSupplierOrderSuppliers(list, { query, filter }), [list, query, filter]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(({ id }) => [id, filterSupplierOrderSuppliers(list, { filter: id }).length])), [list]);
  const wanted = params.get("ncc");
  const picked = list.find((row) => row.id === wanted) ?? null;
  // Wide screens always show an order next to the list; on a phone the list comes first.
  const current = picked ?? list[0] ?? null;
  const onToast = (text: string) => toast({ title: text });
  const pick = (id: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id) next.set("ncc", id); else next.delete("ncc");
    return next;
  }, { replace: !id });
  const open = (id: string | null) => { pick(id); window.scrollTo({ top: 0 }); };

  return (
    <div className={cn("d3-wh d3-kho d3-so min-w-0", picked && "is-picked")} data-bmq-supplier-orders>
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
        <section className="d3-wh-card"><p className="d3-kho-hint" data-bmq-so-no-suppliers>Chưa có nhà cung cấp nào mua hàng trong 60 ngày gần đây.</p></section>
      ) : (
        <div className="d3-so-split">
          <aside className="d3-so-list" aria-label="Nhà cung cấp" data-bmq-so-suppliers>
            <label className="d3-so-search">
              <Search aria-hidden="true" />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm nhà cung cấp" aria-label="Tìm nhà cung cấp" data-bmq-so-search />
            </label>
            <div className="d3-so-filters" role="group" aria-label="Lọc nhà cung cấp">
              {FILTERS.map(({ id, label }) => (
                <button key={id} type="button" className={cn(filter === id && "is-on")} aria-pressed={filter === id}
                  onClick={() => setFilter(id)} data-bmq-so-filter={id}>
                  {label}<small>{counts[id]}</small>
                </button>
              ))}
            </div>
            {shown.length ? (
              <ul className="d3-so-sups">
                {shown.map((row) => (
                  <SupplierRow key={row.id} row={row} on={row.id === current.id} onPick={() => open(row.id)} />
                ))}
              </ul>
            ) : (
              <p className="d3-kho-hint d3-so-none" data-bmq-so-no-match>Không có nhà cung cấp nào khớp. Đổi bộ lọc hoặc từ khoá.</p>
            )}
          </aside>
          <div className="d3-so-detail min-w-0">
            <SupplierPanel key={current.id} supplierId={current.id} onToast={onToast} onBack={() => open(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
