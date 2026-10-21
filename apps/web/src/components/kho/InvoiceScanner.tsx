import { useEffect, useState } from "react";
import { Check, FileText } from "lucide-react";
import type { ReceiptLine } from "@/lib/receipt-lines";
import { receiptPhotos } from "@/lib/receipt-photos";
import { cn } from "@/lib/utils";
import { useNoteUrl } from "./ReceiptNotes";

/**
 * "Đang đọc hóa đơn" (owner 14/10): reading an invoice photo takes 5–30 s, so the real thumbnail shows
 * with a thin reading line and three steps that light up in turn, and the seconds count up.
 */
const STEPS = [
  { at: 0, label: "Tải ảnh hóa đơn" },
  { at: 2.5, label: "Đọc các dòng hàng" },
  { at: 7, label: "Đối chiếu giá và số lượng" },
];

export function InvoiceScanner({ lines }: { lines: ReceiptLine[] | undefined }) {
  const line = (lines ?? []).find((row) => receiptPhotos(row.image_path, row.photo_paths).length > 0) ?? null;
  const path = line ? receiptPhotos(line.image_path, line.photo_paths)[0]?.path ?? null : null;
  const url = useNoteUrl(path);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => window.clearInterval(timer);
  }, []);
  const current = STEPS.reduce((index, step, i) => (elapsed >= step.at ? i : index), 0);

  return (
    <div className="d3-kho-scan" role="status" aria-live="polite" data-bmq-invoice-scanner>
      <div className="d3-kho-scan-bed" aria-hidden="true">
        {url.data ? <img src={url.data} alt="" /> : <FileText />}
        <i className="d3-kho-scan-line" />
      </div>
      <div className="d3-kho-scan-text">
        <b>Đang đọc hóa đơn</b>
        <ol>
          {STEPS.map((step, i) => (
            <li key={step.label} className={cn(i < current && "is-done", i === current && "is-now")}>
              <span className="d3-kho-scan-dot" aria-hidden="true">{i < current ? <Check /> : null}</span>
              {step.label}
            </li>
          ))}
        </ol>
        <small>{Math.floor(elapsed)} giây{elapsed > 25 ? " · ảnh nhiều dòng, chờ thêm chút" : ""}</small>
      </div>
    </div>
  );
}
