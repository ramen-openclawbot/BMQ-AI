import type { ReactNode } from "react";

import { usePaymentDocDetail, type PaymentDocKind } from "@/hooks/useOfficeOrder";
import {
  DELIVERY, GR_STATUS, PAY_METHOD, PAY_STATUS, PAY_TYPE, PO_STATUS, PR_STATUS, docPhotos, docTotals,
  type DocLine, type PaymentDocDetail,
} from "@/lib/office-order";
import { fmtDate, fmtMoney, fmtNum } from "./format";
import { DocPhotos } from "./DocPhotos";

/**
 * A PR or PO opened in full. Photos first (owner 16/10: every document comes with its attached photos for
 * reconciliation): the strip sits right under the header; on desktop it becomes a sticky column beside the lines,
 * so the invoice / delivery note and the line items are read side by side. Then status chips, links, lines, totals.
 */
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

function Ref({ title, number, parts, onOpen }: { title: string; number: string | null; parts: Array<string | null | undefined>; onOpen?: () => void }) {
  const inner = <><small>{title}</small><b>{number ?? "—"}</b><span>{parts.filter(Boolean).join(" · ")}</span></>;
  return <li>{onOpen ? <button type="button" className="ref-open" onClick={onOpen} aria-label={`Mở ${title} ${number ?? ""}`}>{inner}<i>›</i></button> : inner}</li>;
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

export function OfficeDocDetail({ doc, actions, onOpen }: { doc: DocKey; actions?: ReactNode; onOpen?: (key: DocKey) => void }) {
  const detail = usePaymentDocDetail(doc.kind, doc.id);
  if (detail.isLoading) return <p className="empty" data-office-doc-loading>Đang mở phiếu…</p>;
  if (detail.isError) return <p className="empty err">Không mở được phiếu: {String((detail.error as Error)?.message ?? "lỗi").slice(0, 140)}</p>;
  const d = detail.data;
  if (!d) return <p className="empty">Không có quyền xem phiếu này, hoặc phiếu không còn.</p>;
  const photos = docPhotos(d);
  const grPhotoN = d.gr ? (d.gr.image_path ? 1 : 0) + (d.gr.photos?.length ?? 0) : 0;
  const grRef = d.gr
    ? <Ref title="Phiếu nhập kho" number={d.gr.number} parts={[d.gr.date ? fmtDate(d.gr.date) : null, label(GR_STATUS, d.gr.status), grPhotoN ? `${grPhotoN} ảnh` : "chưa có ảnh"]} />
    : <li className="none"><small>Phiếu nhập kho</small><span>Chưa nhập kho</span></li>;
  const photoBlock = (
    <section className="doc-photo-block" data-office-photo-block={photos.length}>
      <h4>Ảnh chứng từ · {photos.length}</h4>
      {photos.length ? <p className="doc-photo-hint">Chạm ảnh để xem lớn và so với dòng hàng.</p> : <p className="doc-photo-hint warn">Phiếu này chưa có ảnh đính kèm để đối soát.</p>}
      <DocPhotos photos={photos} />
    </section>
  );
  const photoChip = <em className={photos.length ? "c-photos" : "c-nophotos"}>{photos.length ? `📷 ${photos.length} ảnh` : "chưa có ảnh"}</em>;

  if (d.kind === "pr") {
    return (
      <section className={`doc${photos.length ? " has-photos" : ""}`} data-office-doc={d.number}>
        <header className="doc-head">
          <b>{d.number}</b>
          <span className="chips-row">
            {d.status ? <em className={`c-${d.status}`}>{label(PR_STATUS, d.status)}</em> : null}
            {d.payment_status ? <em className={`c-${d.payment_status}`}>{label(PAY_STATUS, d.payment_status)}</em> : null}
            {d.payment_type ? <em>{label(PAY_TYPE, d.payment_type)}</em> : null}
            {d.payment_method ? <em>{label(PAY_METHOD, d.payment_method)}</em> : null}
            {photoChip}
          </span>
        </header>
        <div className="doc-grid">
          {photoBlock}
          <div className="doc-facts">
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
              {d.po ? <Ref title="Đơn mua (PO)" number={d.po.number} parts={[d.po.date ? fmtDate(d.po.date) : null, label(PO_STATUS, d.po.status), d.po.amount ? fmtMoney(d.po.amount) : null]} onOpen={onOpen && d.po.id ? () => onOpen({ kind: "po", id: d.po!.id }) : undefined} /> : <li className="none"><small>Đơn mua (PO)</small><span>Không gắn đơn mua</span></li>}
              {grRef}
            </ul>
            <h4>Dòng hàng · {d.lines.length}</h4>
            <Lines lines={d.lines} />
            <Totals doc={d} />
          </div>
        </div>
        {actions}
      </section>
    );
  }
  return (
    <section className={`doc${photos.length ? " has-photos" : ""}`} data-office-doc={d.number}>
      <header className="doc-head">
        <b>{d.number}</b>
        <span className="chips-row">
          <em className="c-po">Đơn mua</em>
          {d.status ? <em>{label(PO_STATUS, d.status)}</em> : null}
          <em className={d.prs.length ? "c-pending" : "c-unpaid"}>{d.prs.length ? `${d.prs.length} PR` : "Chưa có PR"}</em>
          {photoChip}
        </span>
      </header>
      <div className="doc-grid">
        {photoBlock}
        <div className="doc-facts">
          <dl className="doc-meta">
            <dt>NCC</dt><dd>{d.supplier?.name ?? "—"}</dd>
            <dt>Ngày đặt</dt><dd>{d.date ? `${fmtDate(d.date)}/${d.date.slice(0, 4)}` : "—"}</dd>
            {d.expected ? <><dt>Hẹn giao</dt><dd>{fmtDate(d.expected)}</dd></> : null}
            {d.notes ? <><dt>Ghi chú</dt><dd>{d.notes}</dd></> : null}
          </dl>
          <ul className="doc-refs">
            {grRef}
            {d.prs.map((p) => <Ref key={p.id} title="Đề nghị chi (PR)" number={p.number} parts={[label(PR_STATUS, p.status), label(PAY_STATUS, p.payment_status), p.amount ? fmtMoney(p.amount) : null]} onOpen={onOpen ? () => onOpen({ kind: "pr", id: p.id }) : undefined} />)}
          </ul>
          <h4>Dòng hàng · {d.lines.length}</h4>
          <Lines lines={d.lines} />
          <Totals doc={d} />
        </div>
      </div>
      {actions}
    </section>
  );
}
