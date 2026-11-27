import { useRef, useState } from "react";
import { ArrowRight, Check, Download, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { HACCP_SECTIONS, haccpProgress, type HaccpSectionId } from "@/lib/haccp-schema";
import { ExportPreview } from "@/components/haccp/ExportPreview";
import { SectionBody } from "@/components/haccp/SectionBody";
import { ShareDialog } from "@/components/haccp/ShareDialog";
import type { HaccpStore } from "@/components/haccp/store";
import type { HaccpSupplierPapers } from "@/lib/haccp-api";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-kho.css";
import "@/styles/bmq-haccp.css";

/** Hồ sơ HACCP bếp Quận 7: seven sheets, one place to fill them, one button to export. */
export default function HaccpDossier({ store, who, onOpenStaff, onDownload, embedded = false, supplierPapers = {} }: {
  supplierPapers?: Record<string, HaccpSupplierPapers>;
  /** Shown as a tab of "An toàn thực phẩm": that page owns the title. */
  embedded?: boolean;
  store: HaccpStore;
  who: string;
  onOpenStaff: () => void;
  onDownload: (zip: boolean) => void | Promise<void>;
}) {
  const [active, setActive] = useState<HaccpSectionId>("suppliers");
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const panel = useRef<HTMLElement>(null);

  const progress = HACCP_SECTIONS.map((s) => ({ section: s, ...haccpProgress(s, store.data, store.layoutFiles) }));
  const overall = Math.floor(progress.reduce((n, p) => n + p.pct, 0) / progress.length);
  const done = progress.filter((p) => p.state === "done").length;
  const current = progress.find((p) => p.section.id === active)!;
  const next = progress.find((p) => p.state !== "done" && p.section.id !== active) ?? progress.find((p) => p.state !== "done");
  const go = (id: HaccpSectionId, scroll = false) => {
    setActive(id);
    if (scroll) requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div className="d3-wh d3-kho hc min-w-0" data-hc-page>
      <header className={cn("d3-wh-head", embedded && "hc-embedded-head")}>
        {embedded ? null : (
          <div className="min-w-0">
            <h1>Hồ sơ <b>HACCP</b></h1>
            <p className="d3-wh-tag">Bếp Quận 7 · thông tin gửi đơn vị tư vấn ISO an toàn thực phẩm</p>
          </div>
        )}
        <div className="hc-head-acts">
          <button type="button" className="hc-btn is-lg" onClick={() => setSharing(true)} data-hc-share-open><Link2 />Link cho nhân viên</button>
          <button type="button" className="hc-btn is-ink is-lg" onClick={() => setExporting(true)} data-hc-export-open><Download />Xuất Excel</button>
        </div>
      </header>

      <section className="hc-hero" aria-label="Tiến độ hồ sơ">
        <div className="hc-total">
          <strong data-hc-overall>{overall}<span>%</span></strong>
          <p><b>{done}/7 mục đã đủ</b><span className="hc-meter" aria-hidden="true">{progress.map((p) => <i key={p.section.id} className={`is-${p.state}`}><i style={{ width: `${p.pct}%` }} /></i>)}</span></p>
          {next ? <button type="button" className="hc-next" onClick={() => go(next.section.id, true)}>Làm tiếp: {next.section.short}<ArrowRight /></button> : <span className="hc-next is-done"><Check />Sẵn sàng xuất file</span>}
        </div>
        <div className="hc-tiles" role="tablist" aria-label="7 mục trong file Excel">
          {progress.map((p, i) => (
            <button key={p.section.id} type="button" role="tab" aria-selected={active === p.section.id} className={cn("hc-tile", active === p.section.id && "is-on", `is-${p.state}`)} onClick={() => go(p.section.id)} data-hc-tile={p.section.id}>
              <span className="hc-tile-no">{p.state === "done" ? <Check aria-label="Đã đủ" /> : i + 1}</span>
              <b>{p.section.short}</b>
              <span className="hc-tile-bar" aria-hidden="true"><i style={{ width: `${p.pct}%` }} /></span>
              <small>{p.state === "done" ? "Đã đủ" : p.state === "empty" ? "Chưa có" : `Thiếu ${p.missingCells} ô`}</small>
            </button>
          ))}
        </div>
      </section>

      <button type="button" className="hc-live" onClick={() => setSharing(true)}>
        <span className={cn("hc-dot", !store.link.active && "is-off")} aria-hidden="true" />
        <span className="hc-live-main">{store.link.active ? <>Link nhân viên đang mở đến <b>{store.link.expiresOn}</b></> : <>Chưa có link nhân viên đang mở</>}</span>
        {store.activity[0] ? <span className="hc-live-last"><b>{store.activity[0].who}</b> {store.activity[0].text} · {store.activity[0].at}</span> : null}
      </button>

      <section className="d3-wh-card hc-panel" ref={panel} data-hc-panel={active}>
        <div className="hc-panel-head">
          <div>
            <h2>{current.section.title}</h2>
            <p>{current.section.help}</p>
          </div>
          <span className="hc-sheet-tag">Sheet “{current.section.sheet}”</span>
        </div>
        <SectionBody key={active} section={current.section} store={store} who={who} manager papers={supplierPapers} />
      </section>

      {exporting ? <ExportPreview store={store} paperCount={Object.values(supplierPapers).reduce((n, p) => n + p.papers.length, 0)} start={active} onClose={() => setExporting(false)} onDownload={onDownload} /> : null}
      {sharing ? <ShareDialog store={store} onClose={() => setSharing(false)} onPreview={onOpenStaff} /> : null}
    </div>
  );
}
