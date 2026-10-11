import type { ReactNode } from "react";

/** Spiral-bound notebook card: bottom sheet on phones, right-hand card on desktop. */
export function Sheet({ title, sub, tag, onClose, children }: { title: string; sub?: string; tag?: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <section className="sheet" role="dialog" aria-label={title}>
        <div className="spiral" aria-hidden="true">{Array.from({ length: 9 }).map((_, i) => <i key={i} />)}</div>
        <button type="button" className="close" onClick={onClose} aria-label="Đóng">✕</button>
        <div className="sheet-head">
          {tag ? <span className="sheet-tag">{tag}</span> : null}
          <h2>{title}</h2>
          {sub ? <p className="sub">{sub}</p> : null}
        </div>
        {children}
      </section>
    </>
  );
}
