import type { ReactNode } from "react";

import { usePaymentDocDetail, type PaymentDocKind } from "@/hooks/useOfficeOrder";
import {
  DELIVERY, GR_STATUS, PAY_METHOD, PAY_STATUS, PAY_TYPE, PO_STATUS, PR_STATUS, docTotals,
  type DocLine, type PaymentDocDetail,
} from "@/lib/office-order";
import { fmtDate, fmtMoney, fmtNum } from "./format";

/** A PR or PO opened in full: status chips, links (PO / goods receipt / photo), every line, totals. */
export type DocKey = { kind: PaymentDocKind; id: string };

const label = (map: Record<string, string>, v: string | null | undefined) => (v ? map[v] ?? v : null);

function Lines({ lines }: { lines: DocLine[] }) {
  if (!lines.length) return <p className="empty">Phiếu không có dòng hàng.</p>;
  return (
    <ol className="doc-lines">
      {lines.map((l, i) => (
        <li key={i}>
          <span className="n">{i + 1}</span>
          <b className="name">{l.name}</b>
          <span className="calc">{l.qty !== null ? fmtNum(l.qty) : "—"} {l.unit ?? ""}{l.price ? ` × ${fmtMoney(l.price)}` : ""}</span>
          <b className="tot">{l.total !== null && l.total !== undefined ? fmtMoney(l.total) : l.qty && l.price ? fmtMoney(l.qty * l.price) : "—"}</b>
          {l.change ? <em className={`chg${l.change > 0 ? " up" : " down"}`}>{l.change > 0 ? "▲" : "▼"} {Math.abs(Math.round(l.change))}% so với lần trước</em> : null}
        </li>
      ))}
    </ol>
  );
}

function Ref({ title, number, parts }: { title: string; number: string | null; parts: Array<string | null | undefined> }) {
  return (
    <li>
      <small>{title}</small>
      <b>{number ?? "—"}</b>
      <span>{parts.filter(Boolean).join(" · ")}</span>
    </li>
  );
}

function Totals({ doc }: { doc: PaymentDocDetail }) {
  const t = docTotals(doc.lines, doc.vat, doc.amount);
  return (
    <dl className="doc-total">
      {t.showLinesSum ? <><dt>Cộng dòng hàng</dt><dd>{fmtMoney(t.linesSum)}</dd></> : null}
      {t.vat ? <><dt>VAT</dt><dd>{fmtMoney(t.vat)}</dd></> : null}
      <dt>Tổng phiếu</dt><dd className="big">{fmtMoney(t.amount ?? t.linesSum)}</dd>
    </dl>
  );
}

export function OfficeDocDetail({ doc, actions }: { doc: DocKey; actions?: ReactNode }) {
  const detail = usePaymentDocDetail(doc.kind, doc.id);
  if (detail.isLoading) return <p className="empty" data-office-doc-loading>Đang mở phiếu…</p>;
  if (detail.isError) return <p className="empty err">Không mở được phiếu: {String((detail.error as Error)?.message ?? "lỗi").slice(0, 140)}</p>;
  const d = detail.data;
  if (!d) return <p className="empty">Không có quyền xem phiếu này, hoặc phiếu không còn.</p>;

  if (d.kind === "pr") {
    return (
      <section className="doc" data-office-doc={d.number}>
        <header className="doc-head">
          <b>{d.number}</b>
          <span className="chips-row">
            {d.status ? <em className={`c-${d.status}`}>{label(PR_STATUS, d.status)}</em> : null}
            {d.payment_status ? <em className={`c-${d.payment_status}`}>{label(PAY_STATUS, d.payment_status)}</em> : null}
            {d.payment_type ? <em>{label(PAY_TYPE, d.payment_type)}</em> : null}
            {d.payment_method ? <em>{label(PAY_METHOD, d.payment_method)}</em> : null}
          </span>
        </header>
        <dl className="doc-meta">
          <dt>NCC</dt><dd>{d.supplier?.name ?? "—"}</dd>
          <dt>Ngày tạo</dt><dd>{d.created_at ? `${fmtDate(d.created_at)}/${d.created_at.slice(0, 4)}` : "—"}</dd>
          {d.title ? <><dt>Tiêu đề</dt><dd>{d.title}</dd></> : null}
          {d.description ? <><dt>Nội dung</dt><dd>{d.description}</dd></> : null}
          {d.notes ? <><dt>Ghi chú</dt><dd>{d.notes}</dd></> : null}
          <dt>Giao hàng</dt><dd>{label(DELIVERY, d.delivery_status) ?? "—"}</dd>
          <dt>Hoá đơn VAT</dt><dd>{d.invoice_created ? "Đã có" : "Chưa có"}</dd>
        </dl>
        <ul className="doc-refs">
          {d.po ? <Ref title="Đơn mua (PO)" number={d.po.number} parts={[d.po.date ? fmtDate(d.po.date) : null, label(PO_STATUS, d.po.status), d.po.amount ? fmtMoney(d.po.amount) : null]} /> : <li className="none"><small>Đơn mua (PO)</small><span>Không gắn PO</span></li>}
          {d.gr ? <Ref title="Phiếu nhập kho" number={d.gr.number} parts={[d.gr.date ? fmtDate(d.gr.date) : null, label(GR_STATUS, d.gr.status), d.gr.has_image ? "có ảnh" : "chưa có ảnh"]} /> : <li className="none"><small>Phiếu nhập kho</small><span>Chưa có phiếu nhập</span></li>}
          <li className={d.has_image ? "" : "none"}><small>Ảnh chứng từ</small><span>{d.has_image ? "Đã đính kèm · xem ở trang Đề nghị chi" : "Chưa đính kèm"}</span></li>
        </ul>
        <h4>Dòng hàng · {d.lines.length}</h4>
        <Lines lines={d.lines} />
        <Totals doc={d} />
        {actions}
      </section>
    );
  }
  return (
    <section className="doc" data-office-doc={d.number}>
      <header className="doc-head">
        <b>{d.number}</b>
        <span className="chips-row">
          <em className="c-po">Đơn mua</em>
          {d.status ? <em>{label(PO_STATUS, d.status)}</em> : null}
          <em className={d.prs.length ? "c-pending" : "c-unpaid"}>{d.prs.length ? `${d.prs.length} PR` : "Chưa có PR"}</em>
        </span>
      </header>
      <dl className="doc-meta">
        <dt>NCC</dt><dd>{d.supplier?.name ?? "—"}</dd>
        <dt>Ngày đặt</dt><dd>{d.date ? `${fmtDate(d.date)}/${d.date.slice(0, 4)}` : "—"}</dd>
        {d.expected ? <><dt>Hẹn giao</dt><dd>{fmtDate(d.expected)}</dd></> : null}
        {d.notes ? <><dt>Ghi chú</dt><dd>{d.notes}</dd></> : null}
      </dl>
      <ul className="doc-refs">
        {d.gr ? <Ref title="Phiếu nhập kho" number={d.gr.number} parts={[d.gr.date ? fmtDate(d.gr.date) : null, label(GR_STATUS, d.gr.status), d.gr.has_image ? "có ảnh" : "chưa có ảnh"]} /> : <li className="none"><small>Phiếu nhập kho</small><span>Chưa có phiếu nhập</span></li>}
        {d.prs.map((p) => <Ref key={p.id} title="Đề nghị chi (PR)" number={p.number} parts={[label(PR_STATUS, p.status), label(PAY_STATUS, p.payment_status), p.amount ? fmtMoney(p.amount) : null]} />)}
      </ul>
      <h4>Dòng hàng · {d.lines.length}</h4>
      <Lines lines={d.lines} />
      <Totals doc={d} />
      {actions}
    </section>
  );
}
