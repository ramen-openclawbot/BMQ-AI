import { useQuery } from "@tanstack/react-query";
import { getGoodsReceiptImageUrl } from "@/hooks/useGoodsReceipts";
import { useCrateReceiptLines, useItemReceiptLines } from "@/hooks/useWarehouseGame";
import type { ReceiptLine } from "@/lib/receipt-lines";
import { receiptPhotos } from "@/lib/receipt-photos";
import "@/styles/bmq-doc-evidence.css";

/**
 * Delivery notes beside a unit-conversion input on the web pages (owner rule 17/10: every quy đổi
 * shows the delivery note / attached file). The Kho 2D game uses its own ReceiptNotes strip.
 */
const shortDate = (iso: string) => {
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : iso;
};
const qty = (value: number) => value.toLocaleString("vi-VN", { maximumFractionDigits: 3 });

function DocThumb({ line }: { line: ReceiptLine }) {
  const first = receiptPhotos(line.image_path, line.photo_paths)[0]?.path ?? null;
  const url = useQuery({
    queryKey: ["gr-note-url", first],
    enabled: Boolean(first),
    staleTime: 50 * 60 * 1000,
    queryFn: async () => (first ? (await getGoodsReceiptImageUrl(first)) || null : null),
  });
  const meta = (
    <span className="d3-doc-meta">
      <b>{line.receipt_number}</b>
      <small>{shortDate(line.receipt_date)} · {line.quantity > 0 ? `${qty(line.quantity)} ${line.unit ?? ""}` : "chưa ghi số lượng"}</small>
      <small className="d3-doc-raw">{line.raw_name}</small>
    </span>
  );
  if (!first) return <span className="d3-doc-card is-empty" data-bmq-doc={line.receipt_number}><span className="d3-doc-thumb"><em>chưa có ảnh</em></span>{meta}</span>;
  return (
    <a className="d3-doc-card" href={url.data ?? undefined} target="_blank" rel="noreferrer" aria-label={`Mở phiếu ${line.receipt_number}`} data-bmq-doc={line.receipt_number}>
      <span className="d3-doc-thumb">{url.data ? <img src={url.data} alt={`Phiếu giao hàng ${line.receipt_number}`} loading="lazy" /> : <i aria-hidden="true" />}</span>
      {meta}
    </a>
  );
}

export function DocEvidence({ title = "Phiếu giao hàng để đối soát", lines, loading, error }: { title?: string; lines: ReceiptLine[] | undefined; loading: boolean; error: unknown }) {
  const list = lines ?? [];
  const withPhoto = list.filter((line) => receiptPhotos(line.image_path, line.photo_paths).length > 0).length;
  return (
    <section className="d3-doc-evidence" data-bmq-doc-evidence>
      <div className="d3-doc-head"><b>📄 {title}</b><small>{loading ? "đang tải…" : `${list.length} lần nhập · ${withPhoto} có ảnh`}</small></div>
      {error ? <p className="d3-doc-note">Chưa tải được phiếu nhập.</p> : null}
      {!loading && !error && list.length === 0 ? <p className="d3-doc-note">Chưa có phiếu nhập nào.</p> : null}
      {list.length ? <div className="d3-doc-row">{list.slice(0, 8).map((line) => <DocThumb key={line.goods_receipt_item_id} line={line} />)}</div> : null}
    </section>
  );
}

export function ItemDocEvidence({ itemId, title }: { itemId: string | null; title?: string }) {
  const lines = useItemReceiptLines(itemId, Boolean(itemId));
  return <DocEvidence title={title} lines={lines.data} loading={Boolean(itemId) && lines.isLoading} error={lines.error} />;
}

export function CrateDocEvidence({ location, supplierId, normalizedName, title }: { location: "q7" | "tan_tao"; supplierId: string | null; normalizedName: string | null; title?: string }) {
  const lines = useCrateReceiptLines(location, supplierId, normalizedName, Boolean(normalizedName));
  return <DocEvidence title={title} lines={lines.data} loading={Boolean(normalizedName) && lines.isLoading} error={lines.error} />;
}
