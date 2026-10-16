import type { ReactNode } from "react";
import { DETAILS, fmtDate, fmtMoney, fmtNum, type DebtRow, type DocLine, type DocRef, type PoDetail, type PrDetail } from "./data";

/** A PR or PO opened in full: header chips, links (PO / goods receipt / invoice photo), every line, totals. */
export type DocKey = { kind: "pr" | "po"; id: string };
export type DemoPr = { number: string; supplier: string; amount: number; created_at: string; lines: DocLine[]; oldDocs?: DebtRow[]; state?: "approved" | "rejected" };

const PR_STATUS: Record<string, string> = { pending: "Chờ duyệt", approved: "Đã duyệt", rejected: "Từ chối" };
const PAY_STATUS: Record<string, string> = { unpaid: "Chưa chi", paid: "Đã chi", partial: "Chi một phần" };
const DELIVERY: Record<string, string> = { pending: "Chưa giao đủ", delivered: "Đã giao", partial: "Giao một phần" };
const PAY_TYPE: Record<string, string> = { new_order: "Đơn mới", old_order: "Công nợ cũ" };
const PAY_METHOD: Record<string, string> = { bank_transfer: "Chuyển khoản", cash: "Tiền mặt" };
const PO_STATUS: Record<string, string> = { draft: "Nháp", sent: "Đã gửi NCC", completed: "Hoàn tất", cancelled: "Đã huỷ" };
const GR_STATUS: Record<string, string> = { confirmed: "Đã nhập", received: "Đã nhận", draft: "Nháp", pending: "Chờ nhận" };

const label = (map: Record<string, string>, v: string | null | undefined) => (v ? map[v] ?? v : null);

function Lines({ lines }: { lines: DocLine[] }) {
  if (!lines.length) return <p className="empty">Phiếu không có dòng hàng.</p>;
  return (
    <ol className="doc-lines">
      {lines.map((l, i) => (
        <li key={i}>
          <span className="n">{i + 1}</span>
          <b className="name">{l.name}</b>
          <span className="calc">{fmtNum(l.qty)} {l.unit ?? ""}{l.price ? ` × ${fmtMoney(l.price)}` : ""}</span>
          <b className="tot">{l.total !== null && l.total !== undefined ? fmtMoney(l.total) : "—"}</b>
          {l.change ? <em className={`chg${l.change > 0 ? " up" : " down"}`}>{l.change > 0 ? "▲" : "▼"} {Math.abs(Math.round(l.change))}% so với lần trước</em> : null}
        </li>
      ))}
    </ol>
  );
}

function Ref({ title, doc, extra }: { title: string; doc: DocRef; extra?: string | null }) {
  return (
    <li>
      <small>{title}</small>
      <b>{doc.number}</b>
      <span>{[doc.date ? fmtDate(doc.date) : null, extra, doc.amount ? fmtMoney(doc.amount) : null].filter(Boolean).join(" · ")}</span>
    </li>
  );
}

function Totals({ lines, vat, amount }: { lines: DocLine[]; vat: number | null; amount: number }) {
  const sub = lines.reduce((s, l) => s + (l.total ?? 0), 0);
  return (
    <dl className="doc-total">
      {sub && Math.round(sub) !== Math.round(amount) ? <><dt>Cộng dòng hàng</dt><dd>{fmtMoney(sub)}</dd></> : null}
      {vat ? <><dt>VAT</dt><dd>{fmtMoney(vat)}</dd></> : null}
      <dt>Tổng phiếu</dt><dd className="big">{fmtMoney(amount)}</dd>
    </dl>
  );
}

export function DocDetail({ doc, demo, onOpen, actions }: { doc?: DocKey; demo?: DemoPr; onOpen?: (key: DocKey) => void; actions?: ReactNode }) {
  if (demo) {
    const old = demo.oldDocs ?? [];
    return (
      <section className="doc">
        <header className="doc-head">
          <b>{demo.number}</b>
          <span className="chips-row">
            <em className="c-new">MỚI · demo</em>
            <em className={demo.state ? `c-${demo.state}` : "c-pending"}>{demo.state ? PR_STATUS[demo.state] : "Chờ duyệt"}</em>
            <em className="c-unpaid">Chưa chi</em>
          </span>
        </header>
        <dl className="doc-meta"><dt>NCC</dt><dd>{demo.supplier}</dd><dt>Ngày tạo</dt><dd>{fmtDate(demo.created_at)}</dd><dt>Nguồn</dt><dd>Máy đặt hàng (Robot)</dd></dl>
        <h4>Đơn mới · {demo.lines.length} dòng</h4>
        <Lines lines={demo.lines} />
        {old.length ? (
          <>
            <h4>Chi kèm phiếu cũ · {old.length}</h4>
            <ul className="doc-old">
              {old.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => onOpen?.({ kind: r.kind, id: r.id })} data-doc={r.number}>
                    <span className={`kind kind-${r.kind}`}>{r.kind.toUpperCase()}</span>
                    <b>{r.number}</b><span>{fmtDate(r.doc_date)} · {r.age_days} ngày</span><b className="amt">{fmtMoney(r.remaining)}</b><span className="go">Xem ›</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <Totals lines={demo.lines} vat={null} amount={demo.amount} />
        {actions}
      </section>
    );
  }
  if (!doc) return null;
  if (doc.kind === "pr") {
    const pr: PrDetail | undefined = DETAILS.pr[doc.id];
    if (!pr) return <p className="empty">Chưa có chi tiết phiếu này trong bản demo.</p>;
    return (
      <section className="doc">
        <header className="doc-head">
          <b>{pr.number}</b>
          <span className="chips-row">
            <em className={`c-${pr.status}`}>{label(PR_STATUS, pr.status)}</em>
            <em className={`c-${pr.payment_status}`}>{label(PAY_STATUS, pr.payment_status)}</em>
            {pr.payment_type ? <em>{label(PAY_TYPE, pr.payment_type)}</em> : null}
            {pr.payment_method ? <em>{label(PAY_METHOD, pr.payment_method)}</em> : null}
          </span>
        </header>
        <dl className="doc-meta">
          <dt>NCC</dt><dd>{pr.supplier ?? "—"}</dd>
          <dt>Ngày tạo</dt><dd>{fmtDate(pr.created_at)}/{pr.created_at.slice(0, 4)}</dd>
          {pr.title ? <><dt>Tiêu đề</dt><dd>{pr.title}</dd></> : null}
          {pr.description ? <><dt>Nội dung</dt><dd>{pr.description}</dd></> : null}
          {pr.notes ? <><dt>Ghi chú</dt><dd>{pr.notes}</dd></> : null}
          <dt>Giao hàng</dt><dd>{label(DELIVERY, pr.delivery_status) ?? "—"}</dd>
          <dt>Hoá đơn VAT</dt><dd>{pr.invoice_created ? "Đã có" : "Chưa có"}</dd>
        </dl>
        <ul className="doc-refs">
          {pr.po ? <Ref title="Đơn mua (PO)" doc={pr.po} extra={label(PO_STATUS, pr.po.status)} /> : <li className="none"><small>Đơn mua (PO)</small><span>Không gắn PO</span></li>}
          {pr.gr ? <Ref title="Phiếu nhập kho" doc={pr.gr} extra={[label(GR_STATUS, pr.gr.status), pr.gr.has_image ? "có ảnh" : "chưa có ảnh"].filter(Boolean).join(" · ")} /> : <li className="none"><small>Phiếu nhập kho</small><span>Chưa có phiếu nhập</span></li>}
          <li className={pr.has_image ? "" : "none"}><small>Ảnh chứng từ</small><span>{pr.has_image ? "Đã đính kèm (không hiện trong demo)" : "Chưa đính kèm"}</span></li>
        </ul>
        <h4>Dòng hàng · {pr.lines.length}</h4>
        <Lines lines={pr.lines} />
        <Totals lines={pr.lines} vat={pr.vat} amount={pr.amount} />
        {actions}
      </section>
    );
  }
  const po: PoDetail | undefined = DETAILS.po[doc.id];
  if (!po) return <p className="empty">Chưa có chi tiết phiếu này trong bản demo.</p>;
  return (
    <section className="doc">
      <header className="doc-head">
        <b>{po.number}</b>
        <span className="chips-row">
          <em className="c-po">Đơn mua</em>
          <em>{label(PO_STATUS, po.status)}</em>
          <em className={po.prs.length ? "c-pending" : "c-unpaid"}>{po.prs.length ? `${po.prs.length} PR` : "Chưa có PR"}</em>
        </span>
      </header>
      <dl className="doc-meta">
        <dt>NCC</dt><dd>{po.supplier ?? "—"}</dd>
        <dt>Ngày đặt</dt><dd>{po.date ? `${fmtDate(po.date)}/${po.date.slice(0, 4)}` : "—"}</dd>
        {po.expected ? <><dt>Hẹn giao</dt><dd>{fmtDate(po.expected)}</dd></> : null}
        {po.notes ? <><dt>Ghi chú</dt><dd>{po.notes}</dd></> : null}
      </dl>
      <ul className="doc-refs">
        {po.gr ? <Ref title="Phiếu nhập kho" doc={po.gr} extra={[label(GR_STATUS, po.gr.status), po.gr.has_image ? "có ảnh" : "chưa có ảnh"].filter(Boolean).join(" · ")} /> : <li className="none"><small>Phiếu nhập kho</small><span>Chưa có phiếu nhập</span></li>}
        {po.prs.map((p) => <Ref key={p.number} title="Đề nghị chi (PR)" doc={p} extra={[label(PR_STATUS, p.status), label(PAY_STATUS, p.payment_status)].filter(Boolean).join(" · ")} />)}
      </ul>
      <h4>Dòng hàng · {po.lines.length}</h4>
      <Lines lines={po.lines} />
      <Totals lines={po.lines} vat={po.vat} amount={po.amount} />
      {actions}
    </section>
  );
}
