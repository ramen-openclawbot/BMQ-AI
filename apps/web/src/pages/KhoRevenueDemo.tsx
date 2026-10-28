import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { TRU_KHO_DEMO_20261028 } from "@/data/tru-kho-demo-20261028";
import {
  KHO_ORDER,
  MATERIAL_STATE_LABELS,
  buildRevenueDay,
  recentPosted,
  type ChannelPo,
  type MaterialLine,
  type RevenueDay,
  type RevenueKho,
} from "@/lib/kho-revenue-demo";
import { KHO_LABEL, dmy, fmtAmount } from "@/components/kho/kho-meta";
import { cn } from "@/lib/utils";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-kho.css";
import "@/styles/bmq-kho-revenue.css";

/**
 * Trừ kho theo doanh thu — DEMO (owner 28/10). Real figures for one day, frozen in a snapshot, to preview the
 * page before it replaces "Trừ kho chờ duyệt". Read-only: the deduction runs by itself; the page shows each
 * channel's PO for the day → finished SKUs → materials deducted by the cost recipe → stock of each material.
 * Levels open one at a time with a short reveal; nothing is laid out all at once.
 */

const qtyText = (n: number) => n.toLocaleString("vi-VN", { maximumFractionDigits: 0 });
const moneyText = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} triệu đ` : `${qtyText(n)} đ`;
const timeText = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "";

/** Height reveal: grid rows 0fr → 1fr, content mounted on first open, then staggered in. */
function Reveal({ open, id, children, className }: { open: boolean; id: string; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  const ref = useRef<HTMLDivElement | null>(null);
  if (open && !mounted) setMounted(true);
  // React 18 has no `inert` prop: closed content must not take focus or clicks.
  useEffect(() => { ref.current?.toggleAttribute("inert", !open); }, [open]);
  return (
    <div ref={ref} id={id} className={cn("d3-rv-reveal", className)} data-open={open ? "true" : "false"} aria-hidden={!open}>
      <div className="d3-rv-reveal-inner">{mounted ? children : null}</div>
    </div>
  );
}

const stagger = (i: number) => ({ "--i": Math.min(i, 10) }) as CSSProperties;

function WarningNote({ line }: { line: MaterialLine }) {
  if (!line.warning) return null;
  return (
    <p className="d3-rv-warn" role="note" data-bmq-revenue-warning={line.warning.kind}>
      <AlertTriangle aria-hidden="true" />
      {line.warning.kind === "usual"
        ? <>Cả ngày trừ {fmtAmount(line.warning.dayTotal, line.unit)}, gấp {line.warning.multiple.toLocaleString("vi-VN")} lần mức thường ({fmtAmount(line.warning.usual, line.unit)}/ngày). Kiểm tra công thức giá vốn.</>
        : <>{qtyText(line.warning.perUnit)} {line.unit} cho mỗi thành phẩm — nghi công thức sai đơn vị. Kiểm tra công thức giá vốn.</>}
    </p>
  );
}

function StockPanel({ day, line }: { day: RevenueDay; line: MaterialLine }) {
  const item = line.itemId ? day.items.get(line.itemId) : undefined;
  if (!item || !line.location) return null;
  const order: RevenueKho[] = [line.location, ...KHO_ORDER.filter((k) => k !== line.location)];
  const recent = recentPosted(day, line.location, item.id);
  const max = Math.max(1, ...recent.map((r) => Math.abs(r.qty)));
  return (
    <div className="d3-rv-stock d3-rv-stagger" data-bmq-revenue-stock>
      <WarningNote line={line} />
      <dl className="d3-rv-onhand">
        {order.filter((k) => item.qty[k] !== null).map((k, i) => (
          <div key={k} style={stagger(i)} className={cn((item.qty[k] ?? 0) < 0 && "is-negative")}>
            <dt>Tồn {KHO_LABEL[k]}</dt>
            <dd>{fmtAmount(item.qty[k], item.unit)}</dd>
            <small>{item.lastCount[k] ? `Kiểm kê ${dmy(item.lastCount[k])}` : "Chưa kiểm kê"}</small>
          </div>
        ))}
      </dl>
      {recent.length ? (
        <div className="d3-rv-recent" style={stagger(2)}>
          <p>Trừ theo doanh thu ở Kho {KHO_LABEL[line.location]}, 7 ngày</p>
          <ol aria-label="Lượng trừ theo ngày">
            {recent.map((r) => (
              <li key={r.day} title={`${dmy(r.day)}: ${fmtAmount(r.qty, item.unit)}`}>
                <span className="d3-rv-bar" style={{ "--h": `${Math.max(4, Math.round((Math.abs(r.qty) / max) * 100))}%` } as CSSProperties} />
                <small>{r.day.slice(8, 10)}</small>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {line.noHistory ? <p className="d3-rv-quiet" style={stagger(3)}>Món này chưa đủ 5 ngày lịch sử nên chưa so được với mức thường.</p> : null}
    </div>
  );
}

function MaterialRow({ day, line, index }: { day: RevenueDay; line: MaterialLine; index: number }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  return (
    <li className={cn("d3-rv-mat", line.warning && "is-warn")} style={stagger(index)} data-bmq-revenue-material={line.name}>
      <button type="button" className="d3-rv-mat-head" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)}>
        <span className="d3-rv-mat-name">
          <b>{line.name}</b>
          {line.warning ? <small className="is-warn">Cảnh báo</small> : <small>{MATERIAL_STATE_LABELS[line.state]}</small>}
        </span>
        <span className="d3-rv-mat-qty">{fmtAmount(line.qty, line.unit)}</span>
        <ChevronDown className={cn("d3-rv-chev", open && "is-open")} aria-hidden="true" />
      </button>
      <Reveal open={open} id={regionId}><StockPanel day={day} line={line} /></Reveal>
    </li>
  );
}

function ChannelCard({ day, po, index }: { day: RevenueDay; po: ChannelPo; index: number }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const deducted = KHO_ORDER.reduce((n, k) => n + po.materials[k].length, 0);
  return (
    <section className={cn("d3-wh-card d3-kho-card d3-rv-po", open && "is-open")} style={stagger(index)} aria-label={`PO ${po.label}`} data-bmq-revenue-po={po.channel}>
      <button type="button" className="d3-rv-po-head" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)}>
        <span className="d3-rv-po-title">
          <b>{po.label}</b>
          <small>{po.orders} đơn · {po.customers} khách · {moneyText(po.value)}</small>
        </span>
        <span className="d3-rv-po-qty"><b>{qtyText(po.qty)}</b><small>thành phẩm</small></span>
        <ChevronDown className={cn("d3-rv-chev", open && "is-open")} aria-hidden="true" />
      </button>
      <ul className="d3-rv-skus" aria-label={`Thành phẩm ${po.label}`}>
        {po.skus.map((s) => (
          <li key={s.code || s.name}><span>{s.name}</span><b>{qtyText(s.qty)}</b></li>
        ))}
      </ul>
      <div className="d3-rv-po-foot">
        <span>{deducted} nguyên liệu trừ kho{po.unlinked.length ? ` · ${po.unlinked.length} chưa nối kho` : ""}</span>
        {po.warnings ? <span className="d3-rv-badge"><AlertTriangle aria-hidden="true" />{po.warnings} cảnh báo</span> : null}
      </div>
      <Reveal open={open} id={regionId}>
        <div className="d3-rv-mats" data-bmq-revenue-materials>
          {KHO_ORDER.filter((k) => po.materials[k].length).map((k) => (
            <div key={k} className="d3-rv-kho">
              <h3>Kho {KHO_LABEL[k]}<span>{po.materials[k].length}</span></h3>
              <ul className="d3-rv-stagger">
                {po.materials[k].map((m, i) => <MaterialRow key={m.key} day={day} line={m} index={i} />)}
              </ul>
            </div>
          ))}
          {po.unlinked.length ? (
            <div className="d3-rv-kho is-muted">
              <h3>Chưa trừ kho<span>{po.unlinked.length}</span></h3>
              <ul className="d3-rv-stagger">
                {po.unlinked.map((m, i) => (
                  <li key={m.key} className="d3-rv-mat is-static" style={stagger(i)}>
                    <div className="d3-rv-mat-head">
                      <span className="d3-rv-mat-name"><b>{m.name}</b><small>{MATERIAL_STATE_LABELS[m.state]}</small></span>
                      <span className="d3-rv-mat-qty">{fmtAmount(m.qty, m.unit)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Reveal>
    </section>
  );
}

export default function KhoRevenueDemo() {
  const day = useMemo(() => buildRevenueDay(TRU_KHO_DEMO_20261028), []);
  return (
    <div className="d3-wh d3-kho d3-rv min-w-0" data-bmq-kho-revenue>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>Trừ kho theo doanh thu</h1>
          <p className="d3-wh-tag">Doanh thu đã duyệt mỗi kênh → thành phẩm → nguyên liệu trừ theo công thức giá vốn → tồn kho</p>
        </div>
      </header>

      <p className="d3-rv-demo" data-bmq-revenue-demo>
        <b>Bản xem trước</b> · số thật ngày {dmy(day.day)}, chốt lúc {timeText(day.generatedAt)}. Hệ thống tự trừ kho; trang chỉ hiện số và cảnh báo, không cần duyệt.
      </p>

      <dl className="d3-rv-summary" aria-label="Tổng trong ngày">
        <div><dt>Kênh bán</dt><dd>{day.totals.channels}</dd></div>
        <div><dt>Thành phẩm</dt><dd>{qtyText(day.totals.qty)}</dd></div>
        <div className={cn(day.totals.warnings > 0 && "is-warn")}><dt>Cảnh báo</dt><dd>{day.totals.warnings}</dd></div>
      </dl>

      <div className="d3-rv-pos d3-rv-stagger is-on">
        {day.channels.length === 0
          ? <p className="d3-kho-empty" data-bmq-revenue-empty>Ngày này chưa có doanh thu đã duyệt.</p>
          : day.channels.map((po, i) => <ChannelCard key={po.channel} day={day} po={po} index={i} />)}
      </div>
    </div>
  );
}
