import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { HACCP_SECTIONS, haccpProgress, type HaccpSectionId } from "@/lib/haccp-schema";
import { SectionBody } from "@/components/haccp/SectionBody";
import type { HaccpStore } from "@/components/haccp/store";
import "@/styles/bmq-shell.css";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-kho.css";
import "@/styles/bmq-haccp.css";

const NAME_KEY = "bmq-haccp-staff-name";

/** The page behind the staff link: phone first, no app shell, no account. */
export default function HaccpStaffUpload({ store }: { store: HaccpStore }) {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [open, setOpen] = useState<HaccpSectionId | null>(null);

  useEffect(() => {
    // Dialogs are portalled to <body>; the theme class on <html> reaches them.
    document.documentElement.classList.add("bmq-d3");
    return () => document.documentElement.classList.remove("bmq-d3");
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [open]);

  const progress = HACCP_SECTIONS.map((s) => ({ section: s, ...haccpProgress(s, store.data, store.layoutFiles) }));
  const overall = Math.floor(progress.reduce((n, p) => n + p.pct, 0) / progress.length);
  const current = progress.find((p) => p.section.id === open);
  const who = name.trim() || "Nhân viên";

  return (
    <main className="hc hc-staff" data-hc-staff>
      {current ? (
        <>
          <header className="hc-staff-bar">
            <button type="button" className="hc-icon-btn is-lg" aria-label="Về danh sách mục" onClick={() => setOpen(null)} data-hc-back><ChevronLeft /></button>
            <div><b>{current.section.title}</b><small>{current.state === "done" ? "Đã đủ" : current.state === "empty" ? "Chưa có thông tin" : `Còn thiếu ${current.missingCells} ô`}</small></div>
          </header>
          <p className="hc-staff-help">{current.section.help}</p>
          <section className="d3-wh-card hc-panel">
            <SectionBody key={current.section.id} section={current.section} store={store} who={who} manager={false} />
          </section>
        </>
      ) : (
        <>
          <header className="hc-staff-head">
            <img src="/assets/brand/bmq-logo-192.png" alt="Bánh Mì Que" width={52} height={52} />
            <div><h1>Nộp hồ sơ <b>HACCP</b></h1><p>Bếp Quận 7</p></div>
          </header>

          <label className="hc-who">
            <UserRound aria-hidden="true" />
            <span><small>Tên của bạn</small>
              <input value={name} maxLength={60} placeholder="Gõ tên để mọi người biết ai nhập" onChange={(e) => { setName(e.target.value); localStorage.setItem(NAME_KEY, e.target.value); }} />
            </span>
          </label>

          <div className="hc-staff-total">
            <strong>{overall}<span>%</span></strong>
            <p><b>Cả bếp đã làm được</b><span className="hc-tile-bar" aria-hidden="true"><i style={{ width: `${overall}%` }} /></span></p>
          </div>

          <ul className="hc-staff-list">
            {progress.map((p, i) => (
              <li key={p.section.id}>
                <button type="button" className={cn(`is-${p.state}`)} onClick={() => setOpen(p.section.id)} data-hc-staff-section={p.section.id}>
                  <span className="hc-tile-no">{p.state === "done" ? <Check aria-label="Đã đủ" /> : i + 1}</span>
                  <span className="hc-staff-text">
                    <b>{p.section.title}</b>
                    <small>{p.state === "done" ? "Đã đủ" : p.state === "empty" ? "Chưa có, bấm để thêm" : `Còn thiếu ${p.missingCells} ô`}</small>
                    <span className="hc-tile-bar" aria-hidden="true"><i style={{ width: `${p.pct}%` }} /></span>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <p className="hc-staff-foot">Thông tin lưu thẳng vào BMQ AI. Quản lý là người xuất file gửi đơn vị tư vấn.</p>
        </>
      )}
    </main>
  );
}
