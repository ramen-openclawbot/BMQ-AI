import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Link2Off, Ruler } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GoodsReceiptDetailsDialog } from "@/components/dialogs/GoodsReceiptDetailsDialog";
import { PaymentRequestDetailsDialog } from "@/components/dialogs/PaymentRequestDetailsDialog";
import { useQ7PurchaseUsageItemDetail, useQ7PurchaseUsageReport } from "@/hooks/useQ7PurchaseUsage";
import {
  factorSourceLabel,
  formatStockQty,
  monthLabel,
  purchaseUsageGapText,
  purchaseUsageStatusLabel,
  type Q7PurchaseUsageItem,
  type Q7PurchaseUsagePurchaseLine,
  type Q7PurchaseUsageStatus,
} from "@/lib/q7-purchase-usage";
import { cn } from "@/lib/utils";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-purchase-usage.css";

type RangeKey = "3m" | "6m" | "month";
type Filter = "all" | Exclude<Q7PurchaseUsageStatus, "not_in_recipe">;

const RANGES: Array<{ key: RangeKey; label: string; monthsBack: number }> = [
  { key: "month", label: "Tháng này", monthsBack: 0 },
  { key: "3m", label: "3 tháng", monthsBack: 2 },
  { key: "6m", label: "6 tháng", monthsBack: 5 },
];

const STATUS_TONE: Record<Q7PurchaseUsageStatus, string> = {
  big_gap: "is-red",
  needs_conversion: "is-amber",
  no_purchase_link: "is-grey",
  ok: "is-green",
  not_in_recipe: "is-grey",
};

const KPIS: Array<{ status: Exclude<Filter, "all">; hint: string; Icon: LucideIcon }> = [
  { status: "big_gap", hint: "Mua gấp hơn 3 lần hoặc dưới 1/3 lượng dùng", Icon: ArrowLeftRight },
  { status: "needs_conversion", hint: "Có dòng mua chưa đổi được ra đơn vị kho", Icon: Ruler },
  { status: "no_purchase_link", hint: "Có trong công thức, chưa thấy hàng mua", Icon: Link2Off },
  { status: "ok", hint: "Mua và dùng cùng tầm", Icon: CheckCircle2 },
];

const todayVn = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

function rangeFor(key: RangeKey): { from: string; to: string } {
  const to = todayVn();
  const monthsBack = RANGES.find((range) => range.key === key)?.monthsBack ?? 2;
  const [y, m] = to.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1 - monthsBack, 1));
  return { from: start.toISOString().slice(0, 10), to };
}

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
};

const num = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("vi-VN", { maximumFractionDigits: 2 });

const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error ?? "");
  if (message.includes("insufficient_privilege")) return "Tài khoản này chưa có quyền xem Kho.";
  return message || "Lỗi không rõ.";
};

function StatusChip({ status }: { status: Q7PurchaseUsageStatus }) {
  return <span className={cn("d3-pu-chip", STATUS_TONE[status])}>{purchaseUsageStatusLabel(status)}</span>;
}

function ItemRow({ item, months, onOpen }: { item: Q7PurchaseUsageItem; months: string[]; onOpen: () => void }) {
  const gap = purchaseUsageGapText(item);
  return (
    <li className={cn("d3-pu-item", `is-${item.status}`)} data-bmq-pu-item={item.status}>
      <button type="button" className="d3-pu-row" onClick={onOpen}>
        <span className="d3-pu-name">
          <strong>{item.name}</strong>
          <span className="d3-pu-meta">
            <StatusChip status={item.status} />
            {gap ? <small>{gap}</small> : null}
          </span>
        </span>
        <span className="d3-pu-total">
          <span><small>Dùng theo đơn</small><b>{formatStockQty(item.total.used_qty, item.unit)}</b></span>
          <span><small>Mua về</small><b>{item.total.bought_qty > 0 ? formatStockQty(item.total.bought_qty, item.unit) : "—"}</b></span>
        </span>
      </button>
      {months.length > 1 ? (
        <ol className="d3-pu-months" aria-label={`Theo tháng · ${item.name}`}>
          {months.map((month) => {
            const cell = item.months[month];
            return (
              <li key={month}>
                <span>{monthLabel(month)}</span>
                <b>{cell && cell.used_qty > 0 ? formatStockQty(cell.used_qty, item.unit) : "—"}</b>
                <b>{cell && cell.bought_qty > 0 ? formatStockQty(cell.bought_qty, item.unit) : "—"}</b>
              </li>
            );
          })}
        </ol>
      ) : null}
    </li>
  );
}

function PurchaseLine({ line, unit, onOpen }: { line: Q7PurchaseUsagePurchaseLine; unit: string; onOpen: () => void }) {
  const known = line.book_qty !== null;
  return (
    <li className={cn("d3-pu-line", !known && "is-unknown")} data-bmq-pu-line={line.source}>
      <div className="d3-pu-line-top">
        <button type="button" className="d3-pu-doc" onClick={onOpen} data-bmq-pu-open-doc>
          {line.document_number ?? (line.source === "goods_receipt" ? "Phiếu nhập" : "Đề nghị chi")}
        </button>
        <small>
          {shortDate(line.doc_date)} · {line.source === "goods_receipt" ? "Phiếu nhập" : "Chi không có phiếu nhập"}
          {line.supplier_name ? ` · ${line.supplier_name}` : ""}
        </small>
      </div>
      <p className="d3-pu-line-name">{line.product_name}</p>
      <p className="d3-pu-line-math">
        <span>{num(line.quantity)} {line.unit ?? ""}</span>
        {known ? (
          <>
            <span>× {num(line.factor)} {unit}</span>
            <b>= {formatStockQty(line.book_qty, unit)}</b>
          </>
        ) : (
          <b className="is-bad">chưa đổi được ra {unit}</b>
        )}
      </p>
      <small className="d3-pu-line-src">
        {factorSourceLabel(line.factor_source)}
        {line.source === "goods_receipt" ? (line.image_url ? ` · có ảnh phiếu${line.photo_count > 0 ? ` + ${line.photo_count} ảnh hàng` : ""}` : " · chưa có ảnh phiếu") : ""}
      </small>
    </li>
  );
}

function ItemDetail({
  item,
  range,
  onClose,
}: {
  item: Q7PurchaseUsageItem | null;
  range: { from: string; to: string };
  onClose: () => void;
}) {
  const detail = useQ7PurchaseUsageItemDetail(item?.kitchen_inventory_item_id ?? null, range.from, range.to);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const data = detail.data;
  const unit = data?.unit || item?.unit || "";

  return (
    <>
      <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="d3-pu-dialog" data-bmq-pu-detail onOpenAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="d3-pu-dialog-title">{item?.name}</DialogTitle>
            <DialogDescription className="d3-pu-dialog-sub">
              {item ? <StatusChip status={item.status} /> : null}
              <span>{shortDate(range.from)} – {shortDate(range.to)}</span>
            </DialogDescription>
          </DialogHeader>

          {item ? (
            <div className="d3-pu-sum">
              <span><small>Dùng theo đơn</small><b>{formatStockQty(item.total.used_qty, unit)}</b></span>
              <span><small>Mua về</small><b>{item.total.bought_qty > 0 ? formatStockQty(item.total.bought_qty, unit) : "—"}</b></span>
              <span><small>Mua / dùng</small><b>{item.ratio !== null ? `${num(item.ratio)} lần` : "—"}</b></span>
            </div>
          ) : null}

          {detail.isLoading ? (
            <div className="d3-wh-empty">Đang tải phiếu…</div>
          ) : detail.isError ? (
            <div className="d3-wh-alert is-error"><AlertTriangle className="h-5 w-5 shrink-0" /><div>{errorText(detail.error)}</div></div>
          ) : data ? (
            <>
              <section className="d3-pu-sec">
                <h3>Dùng cho sản phẩm</h3>
                {data.usage_by_product.length === 0 ? (
                  <p className="d3-pu-none">Không có phiếu xuất theo đơn trong kỳ.</p>
                ) : (
                  <ul className="d3-pu-products">
                    {data.usage_by_product.map((row) => (
                      <li key={row.finished_sku_id ?? "none"}>
                        <span>{row.product_name ?? "Chưa rõ sản phẩm"}<small>{row.issue_count} phiếu xuất</small></span>
                        <b>{formatStockQty(row.used_qty, unit)}</b>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="d3-pu-sec">
                <h3>Phiếu mua <small>{data.purchases.length}</small></h3>
                {data.purchases.length === 0 ? (
                  <p className="d3-pu-none">
                    Chưa thấy hàng mua nào nối với món này. Có thể phiếu mua đang ghi tên khác: nối tên ở Kho 2D → Bàn mã chuẩn.
                  </p>
                ) : (
                  <ul className="d3-pu-lines">
                    {data.purchases.map((line, index) => (
                      <PurchaseLine
                        key={`${line.document_id}:${index}`}
                        line={line}
                        unit={unit}
                        onOpen={() => (line.source === "goods_receipt" ? setReceiptId(line.document_id) : setRequestId(line.document_id))}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <GoodsReceiptDetailsDialog receiptId={receiptId} open={Boolean(receiptId)} onOpenChange={(open) => !open && setReceiptId(null)} />
      <PaymentRequestDetailsDialog requestId={requestId} open={Boolean(requestId)} onOpenChange={(open) => !open && setRequestId(null)} />
    </>
  );
}

export default function PurchaseUsage() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("3m");
  const [filter, setFilter] = useState<Filter>("all");
  const [openItem, setOpenItem] = useState<Q7PurchaseUsageItem | null>(null);
  const range = useMemo(() => rangeFor(rangeKey), [rangeKey]);
  const report = useQ7PurchaseUsageReport(range.from, range.to);
  const items = useMemo(() => report.data?.items ?? [], [report.data]);
  const months = report.data?.months ?? [];
  const extra = report.data?.q7_extra_purchases ?? [];
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const item of items) out[item.status] = (out[item.status] ?? 0) + 1;
    return out;
  }, [items]);
  const shown = filter === "all" ? items : items.filter((item) => item.status === filter);
  const loading = report.isLoading;
  const failed = report.isError;

  return (
    <div className="d3-wh d3-sl d3-pu min-w-0" data-bmq-purchase-usage>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <span className="d3-wh-tag">Đơn KFM/Vietjet × công thức · so với phiếu nhập và chi tiền mặt</span>
          <h1>
            Mua so với Dùng <b>NVL Q7</b>
          </h1>
        </div>
        <div className="d3-sl-switch" role="tablist" aria-label="Chọn kỳ">
          {RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={rangeKey === option.key}
              className={cn(rangeKey === option.key && "is-on")}
              onClick={() => setRangeKey(option.key)}
              data-bmq-pu-range={option.key}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <section className="d3-wh-kpis">
        {KPIS.map(({ status, hint, Icon }, k) => (
          <button
            key={status}
            type="button"
            className={cn("d3-wh-kpi d3-pu-kpi", `is-${status}`, filter === status && "is-on")}
            style={{ ["--i" as string]: k }}
            aria-pressed={filter === status}
            onClick={() => setFilter((current) => (current === status ? "all" : status))}
            data-bmq-pu-filter={status}
          >
            <span><Icon className="h-4 w-4" />{purchaseUsageStatusLabel(status)}</span>
            <strong>{loading ? "…" : failed ? "—" : String(counts[status] ?? 0)}</strong>
            <small>{hint}</small>
          </button>
        ))}
      </section>

      {failed ? (
        <div className="d3-wh-alert is-error">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div><strong>Không tải được bảng.</strong> {errorText(report.error)}</div>
        </div>
      ) : (
        <div className="d3-wh-alert is-warn">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div>
            <strong>Mua khác dùng chưa chắc là hao hụt.</strong> Chênh lệch gồm cả hàng còn trong kho. Muốn biết hao hụt thật cần 2 lần kiểm kê.
            Bấm từng món để xem từng phiếu mua và cách quy đổi.
          </div>
        </div>
      )}

      {failed ? null : (
      <section className="d3-wh-card" style={{ ["--i" as string]: 1 }}>
        <div className="d3-wh-card-h">
          <h2>{filter === "all" ? "NVL trong công thức" : purchaseUsageStatusLabel(filter)}</h2>
          <span className="d3-wh-pill">{shown.length} món</span>
          {filter !== "all" ? (
            <button type="button" className="d3-ap-link" onClick={() => setFilter("all")} data-bmq-pu-show-all>
              Xem tất cả {items.length}
            </button>
          ) : null}
          {months.length > 1 ? (
            <p className="d3-pu-legend">Theo tháng: số trên là dùng theo đơn, số dưới là mua về.</p>
          ) : null}
        </div>
        {loading ? (
          <div className="d3-wh-empty">Đang tính…</div>
        ) : shown.length === 0 ? (
          <div className="d3-wh-empty">{items.length === 0 ? "Chưa có phiếu xuất theo đơn trong kỳ này." : "Không có món nào ở nhóm này."}</div>
        ) : (
          <ul className="d3-pu-list">
            {shown.map((item) => (
              <ItemRow key={item.kitchen_inventory_item_id} item={item} months={months} onOpen={() => setOpenItem(item)} />
            ))}
          </ul>
        )}
      </section>
      )}

      {extra.length > 0 ? (
        <section className="d3-wh-card" style={{ ["--i" as string]: 2 }} data-bmq-pu-extra>
          <div className="d3-wh-card-h">
            <h2>Mua cho Q7, không có trong công thức</h2>
            <span className="d3-wh-pill">{extra.length} món</span>
            <p>Bao bì, đồ dùng hoặc NVL chưa đưa vào công thức.</p>
          </div>
          <ul className="d3-sl-items">
            {extra.map((row) => (
              <li key={row.kitchen_inventory_item_id}>
                <div className="d3-sl-item-name">
                  <strong>{row.name}</strong>
                  <small>{row.purchase_lines} dòng mua{row.unknown_lines > 0 ? ` · ${row.unknown_lines} dòng chưa quy đổi` : ""}</small>
                </div>
                <div className="d3-sl-item-qty">
                  <strong>{row.bought_qty > 0 ? formatStockQty(row.bought_qty, row.unit) : "—"}</strong>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ItemDetail item={openItem} range={range} onClose={() => setOpenItem(null)} />
    </div>
  );
}
