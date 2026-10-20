/**
 * Mission "Quy đổi đơn vị chứng từ" (owner 20/10): document lines that already match a kho label but
 * carry a unit the material code cannot convert. The game factors that agreed were copied automatically;
 * each row here is a pair with no factor or with disagreeing game values. The owner reads the real
 * documents (rule 17/10: evidence beside every quy đổi), then types "1 {doc unit} = ? {code unit}",
 * says the unit was misread, or skips.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAnswerDocumentUnitQuestion, useDocumentUnitQuestions } from "@/hooks/useDocumentUnitQuestions";
import { getPurchaseOrderImageUrl } from "@/hooks/usePurchaseOrders";
import { getPaymentRequestImageUrl } from "@/hooks/usePaymentRequests";
import { getGoodsReceiptImageUrl } from "@/hooks/useGoodsReceipts";
import { getInvoiceImageUrl } from "@/hooks/useInvoices";
import { candidateLabel, validateAnswer, type DocumentUnitQuestion, type DocumentUnitSampleLine } from "@/lib/document-unit-questions";
import type { MissionDocUnitQuestionsDetail } from "@/lib/missions";
import { missionErrorMessage } from "@/lib/missions";
import { STOCK_UNITS } from "@/lib/stock-units";
import { GamePicker } from "./GamePicker";
import { fmtQty } from "./meta";

const DOC_LABEL: Record<string, string> = {
  purchase_order_items: "PO",
  payment_request_items: "Phiếu chi",
  goods_receipt_items: "Phiếu nhập",
  invoice_items: "Hóa đơn",
};

const imageUrlFor = (table: string, path: string) =>
  table === "purchase_order_items" ? getPurchaseOrderImageUrl(path)
    : table === "payment_request_items" ? getPaymentRequestImageUrl(path)
      : table === "invoice_items" ? getInvoiceImageUrl(path)
        : getGoodsReceiptImageUrl(path);

const vnd = (value: number | null) => (value === null ? "" : `${new Intl.NumberFormat("vi-VN").format(Math.round(value))}đ`);
const shortDate = (iso: string | null) => {
  if (!iso) return "";
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : iso;
};
const parseFactor = (text: string) => Number(text.replace(/\s/g, "").replace(",", "."));

/** One real document line; the photo opens full size in a new tab. */
function DocLine({ line }: { line: DocumentUnitSampleLine }) {
  const url = useQuery({
    queryKey: ["doc-unit-photo", line.table, line.image_path],
    enabled: Boolean(line.image_path),
    staleTime: 50 * 60 * 1000,
    queryFn: async () => (line.image_path ? (await imageUrlFor(line.table, line.image_path)) || null : null),
  });
  return (
    <li className="du-doc" data-bmq-doc-unit-line={line.line_id}>
      {url.data ? (
        <a className="du-thumb" href={url.data} target="_blank" rel="noreferrer" aria-label={`Xem ảnh ${line.document_number ?? "chứng từ"}`}>
          <img src={url.data} alt="" loading="lazy" />
        </a>
      ) : (
        <span className="du-thumb is-empty" aria-hidden="true">{line.image_path ? "…" : "Không ảnh"}</span>
      )}
      <div className="du-doc-text">
        <b>{DOC_LABEL[line.table] ?? "Chứng từ"} {line.document_number ?? ""}{line.document_date ? ` · ${shortDate(line.document_date)}` : ""}</b>
        <span>{line.product_name}</span>
        <span className="du-doc-qty">{fmtQty(line.qty)} {line.unit}{line.unit_price !== null ? ` × ${vnd(line.unit_price)}` : ""}{line.supplier_name ? ` · ${line.supplier_name}` : ""}</span>
      </div>
    </li>
  );
}

function DocUnitRow({ row, onSaved }: { row: DocumentUnitQuestion; onSaved: (text: string) => void }) {
  const answer = useAnswerDocumentUnitQuestion();
  const [factorText, setFactorText] = useState(row.candidates.length === 1 ? String(row.candidates[0].factor) : "");
  const [misread, setMisread] = useState(false);
  const [actualUnit, setActualUnit] = useState("");
  const name = row.material?.canonical_name ?? "Mã nguyên vật liệu";
  const codeUnit = row.material?.default_unit ?? row.default_unit;
  const lines = row.sample_lines.filter((line, index, all) => all.findIndex((other) => other.line_id === line.line_id) === index);
  const factor = factorText.trim() ? parseFactor(factorText) : null;
  const action = misread ? "misread" : "factor";
  const problem = validateAnswer(action, factor, misread ? actualUnit : null);
  const ready = !problem && !answer.isPending;

  const send = (skip: boolean) => answer.mutate(
    skip
      ? { questionId: row.id, action: "skip" }
      : { questionId: row.id, action, factor, actualUnit: misread ? actualUnit : null, reason: `Quy đổi chứng từ: 1 ${misread ? actualUnit : row.doc_unit} = ${factorText || "chuẩn"} ${codeUnit}` },
    { onSuccess: () => onSaved(skip ? `Bỏ qua “${name} · ${row.doc_unit}”` : `Đã ghi quy đổi ${name}: 1 ${row.doc_unit} → ${codeUnit}`) },
  );

  if (row.status !== "open") {
    return (
      <li className="task-row is-fixed du-row" data-bmq-doc-unit-question={row.id} data-status={row.status}>
        <div className="task-head"><b>{name}</b><small>{row.line_count} dòng chứng từ ghi “{row.doc_unit}”</small></div>
        <span className="task-ok">
          {row.status === "skipped"
            ? "Đã bỏ qua"
            : row.action === "misread"
              ? `✓ Đơn vị đọc sai, thật ra là ${row.actual_unit ?? ""}${row.factor ? ` · 1 ${row.actual_unit} = ${fmtQty(row.factor)} ${codeUnit}` : ""}`
              : `✓ 1 ${row.doc_unit} = ${fmtQty(row.factor ?? 0)} ${codeUnit}`}
        </span>
      </li>
    );
  }

  return (
    <li className="task-row du-row" data-bmq-doc-unit-question={row.id} data-status="open">
      <div className="task-head">
        <b>{name}</b>
        <small>{row.line_count} dòng chứng từ ghi “{row.doc_unit}” · mã tính theo {codeUnit}</small>
      </div>
      {lines.length ? <ul className="du-docs" aria-label="Chứng từ để đối soát">{lines.map((line) => <DocLine key={line.line_id} line={line} />)}</ul> : <p className="note">Chưa có ảnh chứng từ cho cặp này.</p>}
      {row.candidates.length ? (
        <div className="du-cands" data-bmq-doc-unit-candidates={row.candidates.length}>
          <span>{row.candidates.length > 1 ? "Game đang có các số khác nhau:" : "Số đã có:"}</span>
          {row.candidates.map((candidate) => (
            <button
              key={`${candidate.factor}-${candidate.source}`}
              type="button"
              className={`du-cand${factor === candidate.factor && !misread ? " is-on" : ""}`}
              onClick={() => { setMisread(false); setFactorText(String(candidate.factor)); }}
            >
              {candidateLabel(candidate)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="seg du-mode" role="radiogroup" aria-label="Cách trả lời">
        <button type="button" role="radio" aria-checked={!misread} className={!misread ? "is-on" : undefined} onClick={() => setMisread(false)}>Nhập hệ số</button>
        <button type="button" role="radio" aria-checked={misread} className={misread ? "is-on" : undefined} onClick={() => setMisread(true)} data-bmq-doc-unit-misread>Đơn vị đọc sai</button>
      </div>
      {misread ? (
        <label className="field du-actual">
          “{row.doc_unit}” thật ra là
          <GamePicker
            value={actualUnit}
            onChange={setActualUnit}
            placeholder="Chọn đơn vị đúng…"
            title={`Đơn vị đúng của “${row.doc_unit}”`}
            ariaLabel={`Đơn vị đúng của ${row.doc_unit}`}
            options={STOCK_UNITS.map((unit) => ({ value: unit.code, label: unit.label }))}
          />
        </label>
      ) : null}
      <label className="conv">
        1 {misread ? actualUnit || "…" : row.doc_unit} =
        <input
          inputMode="decimal"
          value={factorText}
          onChange={(event) => setFactorText(event.target.value)}
          placeholder={misread ? "tự đổi" : "?"}
          aria-label={`Quy đổi 1 ${row.doc_unit} ${name}`}
          data-bmq-doc-unit-factor
        />
        {codeUnit}
      </label>
      {misread ? <p className="note">Để trống nếu là đổi chuẩn (ví dụ kg sang g).</p> : null}
      <div className="row cq-actions">
        <button type="button" className="btn" disabled={!ready} onClick={() => send(false)} title={problem ?? undefined} data-bmq-doc-unit-save>{answer.isPending ? "Đang ghi…" : "Ghi quy đổi"}</button>
        <button type="button" className="btn ghost" disabled={answer.isPending} onClick={() => send(true)} data-bmq-doc-unit-skip>Bỏ qua</button>
      </div>
      {answer.error ? <div className="err">{missionErrorMessage(answer.error)}</div> : null}
    </li>
  );
}

export function DocUnitQuestionsTool({ detail, onSaved }: { detail: MissionDocUnitQuestionsDetail | undefined; onSaved: (text: string) => void }) {
  const questions = useDocumentUnitQuestions(detail?.batch ?? "2026-10-20");
  if (questions.isLoading) return <p className="note">Đang tải câu hỏi…</p>;
  if (questions.error) return <div className="err">{missionErrorMessage(questions.error)}</div>;
  const rows = [...(questions.data ?? [])].sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open") || b.line_count - a.line_count);
  return (
    <>
      <p className="hint">Hệ số anh đã chốt trong game và đổi chuẩn (kg↔g…) đã được lấy tự động. Còn lại các cặp chưa có số, hoặc game có hai số khác nhau. Xem chứng từ rồi gõ 1 đơn vị trên chứng từ bằng bao nhiêu đơn vị của mã. Trả lời xong, các dòng đó tự nối mã.</p>
      <ul className="task-list" data-bmq-doc-unit-questions>{rows.map((row) => <DocUnitRow key={row.id} row={row} onSaved={onSaved} />)}</ul>
    </>
  );
}
