import { useState } from "react";
import { ChevronLeft, Download, FileArchive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading";
import { useToast } from "@/hooks/use-toast";
import { useTraceCandidates, useTraceReport } from "@/hooks/useKhoTrace";
import { foodCertFileUrl } from "@/hooks/useKhoLots";
import { todayIso } from "@/lib/kho-lots";
import type { KhoTraceReport, TraceMaterial, TraceMissingField, TraceSemiFinishedOverride } from "@/lib/kho-trace";
import { KhoDialog } from "@/components/kho/KhoDialog";

const dmy = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
const num = (n?: number | null) => (n === null || n === undefined ? "" : new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(Number(n)));
const MISSING_LABEL: Record<TraceMissingField, string> = { lot: "mã lô", manufacturer: "nhà sản xuất", nsx: "NSX", hsd: "HSD", receipt: "phiếu nhập" };

function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function fileBase(report: KhoTraceReport) {
  const code = (report.sku_code || report.product_name || "san-pham").replace(/[^\p{L}\p{N}-]+/gu, "-").slice(0, 40);
  return `Truy-xuat-${code}-${(report.production_date ?? "").replace(/-/g, "")}`;
}

/**
 * Truy xuất nguồn gốc (owner 23/10, GĐ3): pick a production order, see the KFM sheet
 * with every gap named, adjust the semi-finished rows, then download Excel or the
 * full bundle (Excel + PDF + the ATTP papers of the manufacturers involved).
 */
export function KhoTraceDialog({ onClose }: { onClose: () => void }) {
  const today = todayIso();
  const [from, setFrom] = useState(shiftDays(today, -14));
  const [to, setTo] = useState(today);
  const [picked, setPicked] = useState<string | null>(null);
  const candidates = useTraceCandidates(from, to);

  return (
    <KhoDialog title="Truy xuất nguồn gốc" sub="Chọn lệnh sản xuất để dựng báo cáo theo mẫu KFM" onClose={onClose} wide data={{ "data-bmq-trace": "" }}>
      {picked ? (
        <TraceReportView itemId={picked} onBack={() => setPicked(null)} />
      ) : (
        <>
          <div className="d3-cert-grid">
            <label className="d3-kho-field"><span>Từ ngày</span><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} data-bmq-trace-from /></label>
            <label className="d3-kho-field"><span>Đến ngày</span><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} data-bmq-trace-to /></label>
          </div>
          {candidates.isLoading ? <LoadingState label="Đang đọc lệnh sản xuất" /> : candidates.isError ? (
            <div className="d3-kho-failed" role="alert">
              <p>Không tải được lệnh sản xuất.</p>
              <Button variant="outline" onClick={() => void candidates.refetch()}>Thử lại</Button>
            </div>
          ) : candidates.data?.length ? (
            <ul className="d3-kho-list d3-trace-picks" data-bmq-trace-list>
              {candidates.data.map((c) => (
                <li key={c.production_order_item_id} className="d3-kho-row is-link">
                  <button type="button" className="d3-kho-row-main" onClick={() => setPicked(c.production_order_item_id)} data-bmq-trace-pick={c.production_order_item_id}>
                    <b>{c.product_name}</b>
                    <small>
                      <span>{dmy(c.production_date)}</span>
                      <span>{c.production_number}</span>
                      {c.qty ? <span>{num(c.qty)} {c.unit ?? ""}</span> : null}
                      {!c.has_issue ? <span className="is-flag">chưa có phiếu xuất NVL</span> : null}
                    </small>
                    <span className="d3-kho-row-act" aria-hidden="true">Xem</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="d3-kho-empty" data-bmq-trace-empty>Không có lệnh sản xuất nào trong khoảng ngày này.</p>}
        </>
      )}
    </KhoDialog>
  );
}

function MaterialRows({ title, rows }: { title: string; rows: TraceMaterial[] }) {
  return (
    <section className="d3-trace-sec" data-bmq-trace-sec={title}>
      <h3>{title}<small>{rows.length}</small></h3>
      {rows.length ? (
        <ul className="d3-trace-rows">
          {rows.map((m) => {
            const lot = m.lots[0];
            return (
              <li key={m.item_id} data-bmq-trace-row={m.item_id}>
                <div className="d3-trace-row-head">
                  <b>{m.name}</b>
                  {m.lots.length > 1 ? <small>{m.lots.length} lô</small> : null}
                </div>
                {lot ? (
                  <small className="d3-trace-facts">
                    <span>{lot.manufacturer_name ?? (lot.supplier_name ? `NCC ${lot.supplier_name}` : "—")}</span>
                    <span>nhập {dmy(lot.received_date)} · {num(lot.quantity)} {lot.unit ?? ""}</span>
                    {lot.manufacture_date ? <span>NSX {dmy(lot.manufacture_date)}</span> : null}
                    {lot.expiry_date ? <span>HSD {dmy(lot.expiry_date)}</span> : null}
                    {lot.lot_code ? <span>Lô {lot.lot_code}{lot.lot_code_internal ? " (nội bộ)" : ""}</span> : null}
                  </small>
                ) : null}
                {m.missing.length ? <small className="d3-trace-missing" data-bmq-trace-missing>Chưa có: {m.missing.map((f) => MISSING_LABEL[f] ?? f).join(", ")}</small> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="d3-kho-quiet">Phiếu xuất NVL của lệnh này không có dòng nào thuộc nhóm này.</p>}
    </section>
  );
}

function TraceReportView({ itemId, onBack }: { itemId: string; onBack: () => void }) {
  const { toast } = useToast();
  const report = useTraceReport(itemId);
  const [semi, setSemi] = useState<TraceSemiFinishedOverride[]>([]);
  const [busy, setBusy] = useState<"xlsx" | "zip" | null>(null);
  const r = report.data;

  if (report.isLoading) return <LoadingState label="Đang dựng báo cáo" />;
  if (report.isError || !r) {
    return (
      <div className="d3-kho-failed" role="alert">
        <p>Không dựng được báo cáo cho lệnh này.</p>
        <div className="d3-kho-actions">
          <Button variant="outline" onClick={() => void report.refetch()}>Thử lại</Button>
          <Button variant="ghost" onClick={onBack}>Chọn lệnh khác</Button>
        </div>
      </div>
    );
  }

  const raw = r.materials.filter((m) => m.section === "raw");
  const pack = r.materials.filter((m) => m.section !== "raw");
  const gaps = r.materials.filter((m) => m.missing.length).length;
  const certs = [...r.certificates, ...r.company_certificates];
  const semiRow = (i: number) => ({ ...r.semi_finished[i], ...(semi[i] ?? {}) });
  const setSemiField = (i: number, patch: TraceSemiFinishedOverride) => setSemi((cur) => {
    const next = [...cur];
    next[i] = { ...(next[i] ?? {}), ...patch };
    return next;
  });

  const download = async (kind: "xlsx" | "zip") => {
    setBusy(kind);
    try {
      const lib = await import("@/lib/kho-trace");
      const xlsx = await lib.buildTraceWorkbook(r, semi);
      if (kind === "xlsx") {
        saveBlob(new Blob([xlsx], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${fileBase(r)}.xlsx`);
        return;
      }
      const withSemi = { ...r, semi_finished: r.semi_finished.map((_, i) => semiRow(i)) };
      const pdf = await lib.buildTracePdf(withSemi);
      let skipped = 0;
      const certificateFiles: { name: string; data: ArrayBuffer }[] = [];
      for (const [i, c] of certs.entries()) {
        try {
          const res = await fetch(await foodCertFileUrl(c.file_path));
          if (!res.ok) throw new Error(String(res.status));
          certificateFiles.push({ name: `giay-attp/${String(i + 1).padStart(2, "0")}-${c.file_name ?? "giay"}`, data: await res.arrayBuffer() });
        } catch {
          skipped += 1;
        }
      }
      saveBlob(await lib.buildTraceZip(r, { xlsx, pdf, certificateFiles }), `${fileBase(r)}.zip`);
      if (skipped) toast({ title: `Chưa kèm được ${skipped} giấy ATTP`, description: "Chỉ người có quyền sửa kho mới tải được file giấy tờ." });
    } catch {
      toast({ title: "Chưa tải được báo cáo", description: "Anh/chị thử lại giúp.", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="d3-trace" data-bmq-trace-report={itemId}>
      <button type="button" className="d3-trace-back" onClick={onBack} data-bmq-trace-back><ChevronLeft aria-hidden="true" />Chọn lệnh khác</button>
      <header className="d3-trace-head">
        <b>{r.product_name}</b>
        <dl>
          <div><dt>NSX</dt><dd>{dmy(r.production_date) || "—"}</dd></div>
          <div><dt>HSD</dt><dd className={r.expiry_date ? undefined : "is-gap"}>{dmy(r.expiry_date) || "chưa có"}</dd></div>
          <div><dt>Số lượng</dt><dd>{r.qty ? `${num(r.qty)} ${r.unit ?? ""}` : "—"}</dd></div>
          <div><dt>Lệnh</dt><dd>{r.production_number}</dd></div>
        </dl>
        {!r.expiry_date ? <p className="d3-kho-quiet">Chưa có hạn dùng cho sản phẩm này. Đặt ở Sản xuất › Sản phẩm › nhãn.</p> : null}
        <p className={gaps ? "d3-trace-sum is-gap" : "d3-trace-sum"} data-bmq-trace-gaps={gaps}>
          {r.materials.length === 0 ? "Lệnh này chưa có phiếu xuất NVL, nên chưa có nguyên liệu để truy xuất." : gaps ? `${gaps}/${r.materials.length} dòng còn thiếu thông tin, sẽ ghi "chưa có" trong báo cáo.` : "Đủ thông tin cho mọi dòng."}
          {` · ${certs.length} giấy ATTP kèm theo`}
        </p>
      </header>

      <MaterialRows title="I. Nguyên liệu" rows={raw} />
      <MaterialRows title="II. Bao bì" rows={pack} />

      <section className="d3-trace-sec" data-bmq-trace-sec="III">
        <h3>III. Bán thành phẩm</h3>
        <p className="d3-kho-quiet">Điền sẵn từ lệnh sản xuất. Sửa lại nếu thực tế khác, chỉ dùng cho file tải về.</p>
        <ul className="d3-trace-rows">
          {r.semi_finished.map((_, i) => {
            const row = semiRow(i);
            return (
              <li key={i} className="d3-trace-semi" data-bmq-trace-semi={i}>
                <b>{row.name}</b>
                <div className="d3-trace-semi-grid">
                  <label className="d3-kho-field"><span>Số lượng SX</span>
                    <Input inputMode="decimal" value={row.qty ?? ""} onChange={(e) => setSemiField(i, { qty: e.target.value === "" ? null : Number(e.target.value.replace(",", ".")) })} data-bmq-trace-semi-qty />
                  </label>
                  <label className="d3-kho-field"><span>Tồn sau giao</span>
                    <Input inputMode="decimal" value={row.remaining ?? ""} placeholder="—" onChange={(e) => setSemiField(i, { remaining: e.target.value === "" ? null : Number(e.target.value.replace(",", ".")) })} data-bmq-trace-semi-left />
                  </label>
                  <label className="d3-kho-field"><span>Mã lô</span>
                    <Input value={row.lot_code ?? ""} maxLength={60} onChange={(e) => setSemiField(i, { lot_code: e.target.value })} data-bmq-trace-semi-lot />
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="d3-kho-actions d3-trace-actions">
        <Button disabled={busy !== null} onClick={() => void download("xlsx")} data-bmq-trace-xlsx>
          <Download className="mr-1.5 h-4 w-4" />{busy === "xlsx" ? "Đang tạo…" : "Tải Excel"}
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => void download("zip")} data-bmq-trace-zip>
          <FileArchive className="mr-1.5 h-4 w-4" />{busy === "zip" ? "Đang gom…" : "Tải bộ hồ sơ"}
        </Button>
      </div>
    </div>
  );
}
