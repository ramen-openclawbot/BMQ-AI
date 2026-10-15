import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getGoodsReceiptImageUrl } from "@/hooks/useGoodsReceipts";
import type { ReceiptLine } from "@/lib/receipt-lines";
import { receiptPhotos } from "@/lib/receipt-photos";

/**
 * "Đang đọc hóa đơn" (owner 14/10): while the invoice photo is being read, a scan beam sweeps the real
 * thumbnail and three steps light up so the player can see the machine working.
 */
const STEPS = [
  { at: 0, label: "Tải ảnh hóa đơn" },
  { at: 2.5, label: "Đọc các dòng hàng" },
  { at: 7, label: "Đối chiếu giá & số lượng" },
];

export function InvoiceScanner({ lines }: { lines: ReceiptLine[] | undefined }) {
  const line = (lines ?? []).find((row) => receiptPhotos(row.image_path, row.photo_paths).length > 0) ?? null;
  const path = line ? receiptPhotos(line.image_path, line.photo_paths)[0]?.path ?? null : null;
  const url = useQuery({
    queryKey: ["gr-note-url", path],
    enabled: Boolean(path),
    staleTime: 50 * 60 * 1000,
    queryFn: async () => (path ? (await getGoodsReceiptImageUrl(path)) || null : null),
  });
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => window.clearInterval(timer);
  }, []);
  const current = STEPS.reduce((index, step, i) => (elapsed >= step.at ? i : index), 0);

  return (
    <div className="inv-scan" role="status" aria-live="polite" data-bmq-invoice-scanner>
      <div className="inv-scan-bed" aria-hidden="true">
        {url.data ? <img src={url.data} alt="" /> : (
          <svg viewBox="0 0 80 100" className="inv-scan-paper">
            <rect x="6" y="4" width="68" height="92" rx="4" />
            {[16, 26, 36, 46, 56, 66, 76].map((y) => <line key={y} x1="14" x2={y % 20 ? 66 : 52} y1={y} y2={y} />)}
          </svg>
        )}
        <i className="inv-scan-beam" />
        <b className="inv-scan-corner is-tl" /><b className="inv-scan-corner is-tr" />
        <b className="inv-scan-corner is-bl" /><b className="inv-scan-corner is-br" />
      </div>
      <div className="inv-scan-talk">
        <strong>Đang đọc hóa đơn</strong>
        <ol className="inv-scan-steps">
          {STEPS.map((step, i) => (
            <li key={step.label} className={i < current ? "is-done" : i === current ? "is-now" : undefined}>
              <span aria-hidden="true">{i < current ? "✓" : i === current ? "●" : "○"}</span>{step.label}
            </li>
          ))}
        </ol>
        <small>{Math.floor(elapsed)} giây{elapsed > 25 ? " · ảnh nhiều dòng, chờ thêm chút" : ""}</small>
      </div>
    </div>
  );
}
