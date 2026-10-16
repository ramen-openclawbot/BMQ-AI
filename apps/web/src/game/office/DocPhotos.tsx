import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";

import { resolveImageUrl } from "@/lib/storage-url";

/**
 * Photos of a PR / PO / goods receipt, opened from the document detail (owner 16/10 IMG_5762: "Ko xem ảnh được").
 * Paths are signed on the client with the same bucket hints the finance pages use; a photo the user may not read
 * simply does not resolve.
 */
export type DocPhoto = { key: string; label: string; path: string; bucket: string; name?: string | null; mime?: string | null };

const isPdf = (p: DocPhoto) => (p.mime ?? "").includes("pdf") || /\.pdf$/i.test(p.name ?? p.path);

export function DocPhotos({ photos }: { photos: DocPhoto[] }) {
  const [view, setView] = useState<{ at: number; turn: number } | null>(null);
  const [zoom, setZoom] = useState(1); // 1× fits the stage; 2× scrolls inside it (tap the photo or the 2× button)
  const open = view?.at ?? null;
  const turn = view?.turn ?? 0;
  // Every photo starts upright; the turn belongs to the photo on screen.
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const showing = view !== null;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => setRoom({ w: el.clientWidth - 16, h: el.clientHeight - 16 });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showing]);
  const go = (at: number | null) => { setZoom(1); setView(at === null ? null : { at: (at + photos.length) % photos.length, turn: 0 }); };
  const urls = useQuery({
    queryKey: ["doc-photo-urls", photos.map((p) => `${p.bucket}:${p.path}`)],
    enabled: photos.length > 0,
    staleTime: 30 * 60 * 1000,
    queryFn: () => Promise.all(photos.map((p) => resolveImageUrl(p.path, { preferredBucket: p.bucket }))),
  });
  useEffect(() => {
    if (open === null) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView(null);
      if (e.key === "ArrowRight") setView((v) => (v ? { at: (v.at + 1) % photos.length, turn: 0 } : v));
      if (e.key === "ArrowLeft") setView((v) => (v ? { at: (v.at - 1 + photos.length) % photos.length, turn: 0 } : v));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, photos.length]);
  if (!photos.length) return <p className="doc-photos-none">Chưa có ảnh chứng từ.</p>;
  const list = urls.data ?? [];
  const current = open !== null ? list[open] : null;
  return (
    <>
      <ul className="doc-photos" data-office-photos={photos.length}>
        {photos.map((p, i) => (
          <li key={p.key}>
            <button type="button" onClick={() => (isPdf(p) ? list[i] && window.open(list[i]!, "_blank", "noopener") : go(i))} disabled={urls.isLoading || !list[i]} aria-label={`Xem ${p.label}`} data-office-photo={p.label}>
              {urls.isLoading ? <span className="ph-wait">…</span>
                : !list[i] ? <span className="ph-miss">Không mở được</span>
                : isPdf(p) ? <span className="ph-pdf">PDF</span>
                : <img src={list[i]!} alt={p.label} loading="lazy" />}
              <small>{p.label}</small>
            </button>
          </li>
        ))}
      </ul>
      {open !== null ? createPortal(
        // Portalled to <body>: inside the sticky photo column of the desktop detail the fixed viewer was painted under the sheet bars.
        <div className="kvp"><div className="photo-viewer" role="dialog" aria-label={photos[open].label} onClick={(e) => { if (e.target === e.currentTarget) go(null); }} data-office-viewer>
          <div className="pv-bar">
            <b>{photos[open].label}</b>
            <span>
              <button type="button" onClick={() => setView((v) => (v ? { ...v, turn: (v.turn + 90) % 360 } : v))} aria-label="Xoay ảnh">↻ Xoay</button>
              <button type="button" onClick={() => setZoom((z) => (z === 1 ? 2 : 1))} aria-pressed={zoom > 1} aria-label={zoom > 1 ? "Thu nhỏ ảnh" : "Phóng to ảnh"} data-office-zoom>{zoom > 1 ? "1×" : "2×"}</button>
              {current ? <a href={current} target="_blank" rel="noopener noreferrer">Mở ảnh gốc</a> : null}
              <button type="button" onClick={() => go(null)} aria-label="Đóng ảnh">✕</button>
            </span>
          </div>
          <div className={`pv-stage${zoom > 1 ? " is-zoom" : ""}`} ref={stage}>
            {current ? (
              <img
                key={open}
                src={current}
                alt={photos[open].label}
                // A sideways photo is fitted to the swapped box so it never spills off a phone screen.
                style={{ transform: `rotate(${turn}deg) scale(${zoom})`, ...(turn % 180 && room.w > 0 ? { maxWidth: room.h, maxHeight: room.w } : null) }}
                onClick={() => setZoom((z) => (z === 1 ? 2 : 1))}
                data-office-viewer-img
              />
            ) : <p>Không mở được ảnh.</p>}
          </div>
          {photos.length > 1 ? (
            <div className="pv-nav">
              <button type="button" onClick={() => go(open - 1)} aria-label="Ảnh trước">‹</button>
              <span>{open + 1}/{photos.length}</span>
              <button type="button" onClick={() => go(open + 1)} aria-label="Ảnh sau">›</button>
            </div>
          ) : null}
        </div></div>,
        document.body,
      ) : null}
    </>
  );
}
