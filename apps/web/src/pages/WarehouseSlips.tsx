import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWarehouseGameSnapshot } from "@/hooks/useWarehouseGame";
import { useAuth } from "@/contexts/AuthContext";
import { FinishedGoodsSheet, type FinishedGoodsMode } from "@/game/FinishedGoodsSlip";
import { TransferSheet } from "@/game/TransferSlip";
import { GameLoading } from "@/game/Loading";
import { usePageZoomGuard } from "@/game/zoomGuard";
import "@/game/game.css";
import "@/game/kho2.css";

/**
 * Phiếu kho (owner 21/10/2026): the finished-goods and transfer slips left the warehouse game,
 * which now keeps only Tên hàng + Đếm hàng. Same sheets, same data, own page.
 */
type Panel = { kind: "finished"; mode: FinishedGoodsMode } | { kind: "transfers" } | null;

export default function WarehouseSlips() {
  usePageZoomGuard();
  useEffect(() => {
    const id = "kg-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:wght@600;700;800;900&display=swap";
    document.head.appendChild(link);
  }, []);
  const navigate = useNavigate();
  const q7 = useWarehouseGameSnapshot("q7");
  const tt = useWarehouseGameSnapshot("tan_tao");
  const { isOwner, canEditModule, roles } = useAuth();
  const canTransfer = isOwner || roles.includes("warehouse") || canEditModule("inventory") || canEditModule("q7_material_inventory");
  const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(id);
  }, [toast]);

  const loading = q7.isLoading || tt.isLoading;
  const doors: { key: string; icon: string; title: string; text: string; open: Panel }[] = [
    { key: "in", icon: "🧁", title: "Nhập thành phẩm Q7", text: "Bánh làm xong nhập vào Kho Q7.", open: { kind: "finished", mode: "in" } },
    { key: "out", icon: "🚚", title: "Xuất thành phẩm Q7", text: "Bánh giao đi, trừ Kho Q7.", open: { kind: "finished", mode: "out" } },
    { key: "transfer", icon: "🔁", title: "Chuyển kho Tân Tạo → Q7", text: "Hàng chuyển từ Tân Tạo sang Q7.", open: { kind: "transfers" } },
  ];

  return (
    <div className="kg is-full k2" data-bmq-warehouse-slips data-bmq-warehouse-game>
      <header className="hud">
        <button type="button" className="round-btn" onClick={() => navigate("/warehouse/game")} aria-label="Về game kho">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="title-pill"><b>Phiếu kho</b><small>Thành phẩm Q7 · Chuyển kho</small></div>
        <span />
        <button type="button" className="round-btn exit-btn" onClick={() => navigate("/")} aria-label="Thoát về Tổng quan" title="Thoát về Tổng quan">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </header>
      <main className="stage k2-stage">
        {loading ? <GameLoading lines={["Đang mở phiếu kho…"]} /> : (
          <div className="k2-home is-slips">
            {doors.map((door) => (
              <button key={door.key} type="button" className="k2-door is-names" onClick={() => setPanel(door.open)} data-bmq-slip-door={door.key}>
                <span className="k2-door-icon" aria-hidden="true">{door.icon}</span>
                <span className="k2-door-text"><b>{door.title}</b><small>{door.text}</small></span>
              </button>
            ))}
            {!canTransfer ? <p className="k2-hint is-warn">Tài khoản này chỉ xem được, chưa lập phiếu được.</p> : null}
          </div>
        )}
        {panel?.kind === "finished" ? (
          <FinishedGoodsSheet key={panel.mode} mode={panel.mode} skus={q7.data?.skus ?? []} canEdit={canTransfer} prefillSkuId={null}
            onDone={(message) => setToast(message)} onClose={() => setPanel(null)} />
        ) : null}
        {panel?.kind === "transfers" ? (
          <TransferSheet items={tt.data?.items ?? []} ttStarted={Boolean(tt.data?.cutover_date)} q7Started={Boolean(q7.data?.cutover_date)}
            canTransfer={canTransfer} prefillId={null} onDone={(message) => setToast(message)} onClose={() => setPanel(null)} />
        ) : null}
      </main>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
