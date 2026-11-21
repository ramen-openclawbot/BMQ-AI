/* Heo Đất Tết + Lắc Heo (dathang). Owner-approved flow/demo 21/11/2026.
 * One shared store per dealer session; every surface reads it so the portal needs no prop plumbing.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";
import { formatHeoVnd, type DealerHeoStatusResponse, type DealerHeoSummary } from "@/lib/dealer-heo";
import "@/styles/dealer-heo.css";

type ActiveStatus = Extract<DealerHeoStatusResponse, { active: true }>;
type LastOrder = { orderNumber: string; quantity: number; spun: boolean };
type SpinResult = { prize_kind: string; amount_vnd: number; bread_qty: number; is_jackpot: boolean };
type State = { token: string; status: ActiveStatus | null; loading: boolean; lastOrder: LastOrder | null };

let state: State = { token: "", status: null, loading: false, lastOrder: null };
const listeners = new Set<() => void>();
const emit = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

export async function refreshDealerHeo(token = state.token) {
  if (!token) return;
  emit({ loading: true });
  const { data } = await callEdgeFunction<DealerHeoStatusResponse>("dealer-heo", { dealer_token: token, action: "status" }, undefined, 15000);
  if (state.token !== token) return;
  emit({ loading: false, status: data && data.success && data.active ? data : null });
}

/** Called by the portal when the dealer session changes. */
export function setDealerHeoSession(token: string) {
  if (state.token === token) return;
  emit({ token, status: null, lastOrder: null });
  if (token) void refreshDealerHeo(token);
}

/** Called by the portal right after an order is accepted. */
export function noteDealerHeoOrder(orderNumber: string, quantity: number) {
  if (!orderNumber || !state.status) return;
  emit({ lastOrder: { orderNumber, quantity, spun: false } });
  void refreshDealerHeo();
}

function useHeo() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

const baselineOf = (s: ActiveStatus) => Math.max(0, Number(s.baseline_avg_per_day) || 0);
const que = (n: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(n));
const dm = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "");
const spinLabel = (s: { prize_kind: string; amount_vnd: number; bread_qty: number; is_jackpot: boolean }) =>
  s.is_jackpot ? `🐷✨ Heo Vàng +${formatHeoVnd(s.amount_vnd)}`
    : s.prize_kind === "coin" ? `+${formatHeoVnd(s.amount_vnd)}`
      : s.prize_kind === "bread" ? `🍞 +${que(s.bread_qty)} que`
        : "Chúc may mắn lần sau";

function HowItWorks({ open, onOpenChange, status }: { open: boolean; onOpenChange: (v: boolean) => void; status: ActiveStatus }) {
  const base = que(baselineOf(status));
  const rate = formatHeoVnd(status.campaign.rate);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-dealer-ui="dealer-option-c" className="dealer-heo-sheet max-w-sm rounded-[28px]">
        <DialogTitle className="text-xl font-extrabold">Heo của anh/chị lớn thế nào?</DialogTitle>
        <DialogDescription className="sr-only">Cách nhận thưởng chương trình Heo Đất Tết</DialogDescription>
        <ol className="dealer-heo-steps">
          <li><i>1</i><span><b>Đặt vượt {base} que/ngày</b> (mức tháng 11 của anh/chị): mỗi que vượt <b>+{rate}</b> vào heo.</span></li>
          <li><i>2</i><span><b>Đơn từ {base} que</b>: được <b>lắc heo 1 lần</b> — rơi ra xu, bánh tặng hoặc Heo Vàng.{status.campaign.spin_enabled_for_me ? "" : " (Lắc heo sẽ mở sớm.)"}</span></li>
          <li><i>3</i><span><b>Ngày {dm(status.campaign.break_on)} đập heo</b>: tiền trong heo trừ công nợ hoặc chuyển khoản, bánh tặng giao kèm đơn.</span></li>
        </ol>
        <p className="dealer-heo-fine">Chỉ tính que tính tiền; bánh đổi/bù không tính. Không cần đăng ký, không cần mã.</p>
        <button type="button" className="dealer-heo-btn dealer-heo-btn--ink" onClick={() => onOpenChange(false)}>Đã hiểu</button>
      </DialogContent>
    </Dialog>
  );
}

/** Red card at the top of the chat. */
export function DealerHeoBanner() {
  const { status } = useHeo();
  const [open, setOpen] = useState(false);
  if (!status) return null;
  const s = status.summary;
  return (
    <section className="dealer-heo-banner" data-dealer-heo-banner aria-label="Chương trình Heo Đất Tết">
      <div className="dealer-heo-kicker">{status.campaign.title.toUpperCase()}</div>
      <div className="dealer-heo-pigrow">
        <span className="dealer-heo-pig" aria-hidden="true">🐷</span>
        <div className="min-w-0">
          <strong>{formatHeoVnd(s.total_vnd)}</strong>
          <span>{s.bread_qty > 0 ? `+ ${que(s.bread_qty)} que bánh tặng · ` : ""}đập heo {dm(status.campaign.break_on)}</span>
        </div>
      </div>
      <p>Đặt vượt {que(baselineOf(status))} que/ngày: mỗi que +{formatHeoVnd(status.campaign.rate)} vào heo.</p>
      <button type="button" className="dealer-heo-btn dealer-heo-btn--light" onClick={() => setOpen(true)}>Xem cách nhận</button>
      <HowItWorks open={open} onOpenChange={setOpen} status={status} />
      <DealerHeoWelcome />
    </section>
  );
}

const WELCOME_KEY = "bmq_heo_welcome_ack";
const vnToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

/** Big notice when the dealer opens dathang: shown once per day until "Đã hiểu" is tapped. */
export function DealerHeoWelcome() {
  const { status, token } = useHeo();
  const [open, setOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  useEffect(() => {
    if (!status || !token) { setOpen(false); return; }
    let seen = "";
    try { seen = localStorage.getItem(WELCOME_KEY) || ""; } catch { /* storage may be blocked */ }
    if (seen === "done" || seen === vnToday()) return;
    setOpen(true);
  }, [status, token]);
  if (!status) return null;
  const ack = (final: boolean) => {
    try { localStorage.setItem(WELCOME_KEY, final ? "done" : vnToday()); } catch { /* ignore */ }
    setOpen(false);
  };
  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) ack(false); }}>
        <DialogContent data-dealer-ui="dealer-option-c" className="dealer-heo-welcome max-w-sm rounded-[28px]" data-dealer-heo-welcome>
          <DialogTitle className="sr-only">Chương trình Heo Đất Tết</DialogTitle>
          <DialogDescription className="sr-only">Giới thiệu chương trình Heo Đất Tết</DialogDescription>
          <div className="dealer-heo-welcome-hero">
            <div className="dealer-heo-bigpig" aria-hidden="true">🐷</div>
            <div className="dealer-heo-kicker">BMQ TẶNG ANH/CHỊ</div>
            <strong>Heo Đất Tết</strong>
          </div>
          <p className="dealer-heo-welcome-line">
            Bán thêm mỗi que, heo thêm <b>{formatHeoVnd(status.campaign.rate)}</b>. Mỗi đơn đủ mức còn được <b>lắc heo</b> trúng quà.
            Đập heo ngày <b>{dm(status.campaign.break_on)}</b> lấy tiền tiêu Tết.
          </p>
          <p className="dealer-heo-fine">Không cần đăng ký, không cần mã. Anh/chị đặt hàng như mọi ngày là heo tự lớn.</p>
          <button type="button" className="dealer-heo-btn dealer-heo-btn--ink" onClick={() => ack(true)}>Đã hiểu</button>
          <button type="button" className="dealer-heo-btn dealer-heo-btn--ghost" onClick={() => { ack(false); setHowOpen(true); }}>Xem heo của tôi</button>
        </DialogContent>
      </Dialog>
      <HowItWorks open={howOpen} onOpenChange={setHowOpen} status={status} />
    </>
  );
}

/** Thin line that stays pinned at the top of the chat while the dealer scrolls. */
export function DealerHeoPinned() {
  const { status } = useHeo();
  const [open, setOpen] = useState(false);
  if (!status) return null;
  return (
    <>
      <button type="button" className="dealer-heo-pinned" data-dealer-heo-pinned onClick={() => setOpen(true)}>
        <span aria-hidden="true">🐷</span>
        <b>{formatHeoVnd(status.summary.total_vnd)}</b>
        <span>· đập heo {dm(status.campaign.break_on)}</span>
        <i aria-hidden="true">›</i>
      </button>
      <HowItWorks open={open} onOpenChange={setOpen} status={status} />
    </>
  );
}

/** Compact card at the top of Đơn hàng (all tabs). */
export function DealerHeoOrdersCard() {
  const { status } = useHeo();
  const [open, setOpen] = useState(false);
  if (!status) return null;
  const s = status.summary;
  return (
    <>
      <button type="button" className="dealer-heo-orders-card" data-dealer-heo-orders-card onClick={() => setOpen(true)} aria-label="Xem cách nhận heo">
        <span className="dealer-heo-pig" aria-hidden="true">🐷</span>
        <span className="min-w-0 flex-1 text-left">
          <b>Heo Đất Tết · {formatHeoVnd(s.total_vnd)}</b>
          <small>Còn {s.days_to_break} ngày đập heo · bán thêm mỗi que +{formatHeoVnd(status.campaign.rate)}</small>
        </span>
        <i aria-hidden="true">›</i>
      </button>
      <HowItWorks open={open} onOpenChange={setOpen} status={status} />
    </>
  );
}

/** One line inside the order confirmation card (before submit). */
export function DealerHeoOrderStrip({ quantity }: { quantity: number }) {
  const { status } = useHeo();
  if (!status || !(quantity > 0)) return null;
  const base = baselineOf(status);
  const extra = Math.max(0, quantity - base);
  const eligible = quantity >= (status.campaign.is_test ? 1 : (base > 0 ? base : 1));
  return (
    <div className="dealer-heo-strip" data-dealer-heo-strip>
      <span aria-hidden="true">🐷</span>
      <div>
        {extra > 0
          ? <><b>Vượt {que(extra)} que → +{formatHeoVnd(extra * status.campaign.rate)} vào heo</b></>
          : <><b>Thêm {que(Math.ceil(base - quantity) || 1)} que nữa</b> là bắt đầu bỏ heo</>}
        <small>
          Heo đang có {formatHeoVnd(status.summary.total_vnd)}
          {eligible && status.campaign.spin_enabled_for_me ? " · đơn này được lắc heo" : ""}
        </small>
      </div>
    </div>
  );
}

/** Shown under the "Đã nhận đơn" bubble. */
export function DealerHeoSpinPrompt() {
  const { status, lastOrder, token } = useHeo();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "shaking" | "done" | "error">("idle");
  const [result, setResult] = useState<SpinResult | null>(null);
  const [error, setError] = useState("");
  const [total, setTotal] = useState(0);

  useEffect(() => { setPhase("idle"); setResult(null); setError(""); }, [lastOrder?.orderNumber]);
  if (!status || !lastOrder || !status.campaign.spin_enabled_for_me) return null;
  const base = baselineOf(status);
  // Test accounts can spin on any order; real dealers need the order to reach their November average.
  if (lastOrder.quantity < (status.campaign.is_test ? 1 : (base > 0 ? base : 1))) return null;

  const spin = async () => {
    setOpen(true);
    if (phase === "done") return;
    setPhase("shaking");
    const started = Date.now();
    const { data, error: err } = await callEdgeFunction<{ success?: boolean; spin?: SpinResult; summary?: DealerHeoSummary }>(
      "dealer-heo", { dealer_token: token, action: "spin", order_number: lastOrder.orderNumber }, undefined, 15000,
    );
    await new Promise((r) => setTimeout(r, Math.max(0, 1400 - (Date.now() - started))));
    if (err || !data?.success || !data.spin) {
      setError(err || "Chưa lắc được heo. Vui lòng thử lại.");
      setPhase("error");
      return;
    }
    setResult(data.spin);
    setTotal(data.summary?.total_vnd ?? status.summary.total_vnd);
    setPhase("done");
    emit({ lastOrder: { ...lastOrder, spun: true } });
    void refreshDealerHeo();
  };

  return (
    <>
      <button type="button" className="dealer-heo-btn dealer-heo-btn--red" data-dealer-heo-spin onClick={spin}>
        🐷 {phase === "done" ? "Xem quà lắc heo" : "Lắc heo ngay"}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-dealer-ui="dealer-option-c" className="dealer-heo-shake max-w-sm rounded-[28px]">
          <DialogTitle className="sr-only">Lắc heo</DialogTitle>
          <DialogDescription className="sr-only">Kết quả lắc heo của đơn {lastOrder.orderNumber}</DialogDescription>
          <div className="dealer-heo-stage" data-phase={phase}>
            <div className="dealer-heo-coins" aria-hidden="true">🪙 🪙 🪙</div>
            <div className="dealer-heo-bigpig" aria-hidden="true">🐷</div>
            {phase === "shaking" ? <p className="dealer-heo-wait">Đang lắc heo…</p> : null}
            {phase === "done" && result ? (
              <div aria-live="polite">
                <div className="dealer-heo-win" data-kind={result.prize_kind}>{spinLabel(result)}</div>
                <p className="dealer-heo-winsub">
                  {result.prize_kind === "none" ? "Đơn sau lại được lắc tiếp nhé!" : "đã rơi vào heo của anh/chị!"}
                </p>
                <p className="dealer-heo-fine">Heo đang có <b>{formatHeoVnd(total)}</b></p>
              </div>
            ) : null}
            {phase === "error" ? <p className="dealer-heo-err" role="alert">{error}</p> : null}
            <div className="dealer-heo-prizes" aria-label="Các phần quà">
              {["+5k", "+10k", "+20k", "+50k", "🍞 +10 que", "🍞 +20 que", "🐷✨ Heo Vàng"].map((p) => <span key={p}>{p}</span>)}
            </div>
            {phase === "error"
              ? <button type="button" className="dealer-heo-btn dealer-heo-btn--ink" onClick={spin}>Thử lại</button>
              : <button type="button" className="dealer-heo-btn dealer-heo-btn--ink" disabled={phase === "shaking"} onClick={() => setOpen(false)}>{phase === "done" ? "Tuyệt! Quay về" : "Đợi chút…"}</button>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Top of Đơn hàng → Báo cáo. */
export function DealerHeoReportCard({ sessionToken }: { sessionToken: string }) {
  const { status } = useHeo();
  useEffect(() => { setDealerHeoSession(sessionToken); }, [sessionToken]);
  if (!status) return null;
  const s = status.summary;
  return (
    <section className="dealer-heo-report" data-dealer-heo-report aria-label="Heo Đất Tết">
      <div className="dealer-heo-banner dealer-heo-banner--flat">
        <div className="dealer-heo-kicker">HEO ĐẤT TẾT</div>
        <div className="dealer-heo-pigrow">
          <span className="dealer-heo-pig" aria-hidden="true">🐷</span>
          <div><strong>{formatHeoVnd(s.total_vnd)}</strong><span>{s.bread_qty > 0 ? `+ ${que(s.bread_qty)} que bánh tặng` : "Chưa có bánh tặng"}</span></div>
        </div>
      </div>
      <div className="dealer-heo-split">
        <div><b>{formatHeoVnd(s.from_extra_vnd)}</b><span>Từ {que(s.extra_que)} que vượt mức</span></div>
        <div><b>{formatHeoVnd(s.from_spins_vnd)}</b><span>Từ {que(s.spin_count)} lượt lắc heo</span></div>
      </div>
      <div className="dealer-heo-count"><span>Đập heo sau</span><b>{s.days_to_break} ngày · {dm(status.campaign.break_on)}</b></div>
      {s.recent_spins.length > 0 ? (
        <ul className="dealer-heo-hist" aria-label="Lắc heo gần đây">
          {s.recent_spins.map((r) => (
            <li key={r.order_id}><span>{dm(r.created_at.slice(0, 10))}</span><b>{spinLabel(r)}</b></li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
