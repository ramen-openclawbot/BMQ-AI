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
type State = { token: string; status: ActiveStatus | null; loading: boolean; lastOrder: LastOrder | null; offerOpen: boolean; enrolling: boolean; enrollError: string };

let state: State = { token: "", status: null, loading: false, lastOrder: null, offerOpen: false, enrolling: false, enrollError: "" };
const listeners = new Set<() => void>();
const emit = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

const CACHE_KEY = "bmq_heo_status_cache";
const cacheRead = (token: string): ActiveStatus | null => {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return raw && raw.token === token && raw.status ? raw.status as ActiveStatus : null;
  } catch { return null; }
};
const cacheWrite = (token: string, status: ActiveStatus | null) => {
  try { if (status) localStorage.setItem(CACHE_KEY, JSON.stringify({ token, status })); else localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
};

export async function refreshDealerHeo(token = state.token) {
  if (!token) return;
  emit({ loading: true });
  const { data } = await callEdgeFunction<DealerHeoStatusResponse>("dealer-heo", { dealer_token: token, action: "status" }, undefined, 15000);
  if (state.token !== token) return;
  const next = data && data.success && data.active ? data : null;
  cacheWrite(token, next);
  emit({ loading: false, status: next });
}

/** Called by the portal when the dealer session changes. */
export function setDealerHeoSession(token: string) {
  if (state.token === token) return;
  // Show the last known status at once (same session) while the fresh one loads.
  emit({ token, status: token ? cacheRead(token) : null, lastOrder: null, offerOpen: false, enrollError: "" });
  if (token) void refreshDealerHeo(token);
}

/** Called by the portal right after an order is accepted. */
export function noteDealerHeoOrder(orderNumber: string, quantity: number) {
  if (!orderNumber || !state.status) return;
  emit({ lastOrder: { orderNumber, quantity, spun: false } });
  void refreshDealerHeo();
}

const OFFER_DISMISS_KEY = "bmq_heo_offer_later";

/** Opens the big offer dialog (from any "Tham gia" / "Xem thể lệ" entry). */
export function openDealerHeoOffer() { emit({ offerOpen: true, enrollError: "" }); }

export async function enrollDealerHeo(action: "enroll" | "decline") {
  if (!state.token || state.enrolling) return;
  emit({ enrolling: true, enrollError: "" });
  const token = state.token;
  // Optimistic: the screen changes at once; it is rolled back if the server refuses.
  const before = state.status;
  const optimistic = before ? { ...before, enrollment: { status: action === "enroll" ? "joined" as const : "declined" as const, joined_on: before.enrollment?.joined_on ?? null } } : before;
  if (optimistic) emit({ status: optimistic, offerOpen: false });
  const { data, error } = await callEdgeFunction<{ success?: boolean; enrollment?: { status: "none" | "joined" | "declined"; joined_on: string | null }; summary?: DealerHeoSummary }>(
    "dealer-heo", { dealer_token: token, action }, undefined, 15000,
  );
  if (error || !data?.success || !data.enrollment) {
    emit({ enrolling: false, status: before, offerOpen: true, enrollError: error || "Chưa lưu được lựa chọn. Vui lòng thử lại." });
    return;
  }
  try { sessionStorage.removeItem(OFFER_DISMISS_KEY); } catch { /* ignore */ }
  // Apply the response directly: no second round trip.
  const next = state.status ? { ...state.status, enrollment: data.enrollment, summary: data.summary ?? state.status.summary } : state.status;
  cacheWrite(token, next);
  emit({ enrolling: false, offerOpen: false, status: next });
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

const enrollOf = (s: ActiveStatus) => s.enrollment?.status ?? "none";
const phaseOf = (s: ActiveStatus) => s.phase ?? "live";
/** "20:00 ngày 30/11" in Vietnam time. */
const openLabel = (s: ActiveStatus) => {
  const at = s.campaign.opens_at ? new Date(s.campaign.opens_at) : null;
  if (!at || Number.isNaN(at.getTime())) return dm(s.campaign.starts_on);
  const vn = new Date(at.getTime() + 7 * 3600 * 1000).toISOString();
  return `${vn.slice(11, 16)} ngày ${dm(vn.slice(0, 10))}`;
};
const requiredOf = (s: ActiveStatus) => Math.max(1, Number(s.spin_required_quantity) || Math.ceil(baselineOf(s)) || 1);

/** Full rules, shown inside the offer dialog and "Thể lệ" sheets. */
function RulesList({ status }: { status: ActiveStatus }) {
  const base = que(baselineOf(status));
  const need = que(requiredOf(status));
  const rate = formatHeoVnd(status.campaign.rate);
  return (
    <ol className="dealer-heo-steps">
      <li><i>1</i><span><b>Mức của anh/chị là {base} que/ngày</b> — trung bình mỗi ngày trong tháng 11 của chính anh/chị.</span></li>
      <li><i>2</i><span><b>Đặt vượt mức mỗi ngày:</b> mỗi que vượt <b>+{rate}</b> vào heo. Ngày đặt thấp hơn mức thì không bị trừ.</span></li>
      <li><i>3</i><span><b>Lắc heo:</b> mỗi đơn từ <b>{need} que trở lên</b> được lắc 1 lần, rơi ra xu, bánh tặng hoặc Heo Vàng. Đơn dưới {need} que chưa được lắc.</span></li>
      <li><i>4</i><span><b>Đập heo ngày {dm(status.campaign.break_on)}:</b> tiền trong heo trừ vào công nợ hoặc chuyển khoản, bánh tặng giao kèm đơn.</span></li>
    </ol>
  );
}

function OfferDialog() {
  const { status, offerOpen, enrolling, enrollError } = useHeo();
  if (!status) return null;
  const close = (v: boolean) => {
    if (v) return;
    try { sessionStorage.setItem(OFFER_DISMISS_KEY, "1"); } catch { /* ignore */ }
    emit({ offerOpen: false });
  };
  const joined = enrollOf(status) === "joined";
  const phase = phaseOf(status);
  const canJoin = phase !== "announce" && !joined;
  return (
    <Dialog open={offerOpen} onOpenChange={close}>
      <DialogContent data-dealer-ui="dealer-option-c" className="dealer-heo-offer max-w-sm rounded-[28px]" data-dealer-heo-offer>
        <DialogTitle className="sr-only">Chương trình Heo Đất Tết</DialogTitle>
        <DialogDescription className="sr-only">Nội dung, thể lệ và điều kiện tham gia chương trình Heo Đất Tết</DialogDescription>
        <div className="dealer-heo-welcome-hero">
          <div className="dealer-heo-bigpig" aria-hidden="true">🐷</div>
          <div className="dealer-heo-kicker">BMQ TẶNG ANH/CHỊ</div>
          <strong>Heo Đất Tết</strong>
        </div>
        <p className="dealer-heo-welcome-line">
          Bán thêm mỗi que, heo thêm <b>{formatHeoVnd(status.campaign.rate)}</b>. Đập heo ngày <b>{dm(status.campaign.break_on)}</b> lấy tiền tiêu Tết.
        </p>
        {phase !== "live" ? (
          <div className="dealer-heo-notice" data-dealer-heo-notice>
            <b>Áp dụng từ {dm(status.campaign.starts_on)}</b>
            <span>{phase === "announce" ? `Mở đăng ký tham gia lúc ${openLabel(status)}.` : "Đã mở đăng ký. Anh/chị bấm Tham gia để đặt đơn giao từ ngày " + dm(status.campaign.starts_on) + " được tính thưởng."}</span>
          </div>
        ) : null}
        <div className="dealer-heo-baseline" data-dealer-heo-baseline>
          <b>{que(baselineOf(status))} que/ngày</b>
          <span>Mức trung bình tháng {Number(status.baseline_month?.slice(5) || 11)} của anh/chị. Đặt trên mức này là có thưởng.</span>
        </div>
        <RulesList status={status} />
        <p className="dealer-heo-fine">
          Chương trình từ {dm(status.campaign.starts_on)} đến {dm(status.campaign.ends_on)}. Chỉ tính que bánh mì que tính tiền; bánh đổi/bù không tính.
          {phase === "live" ? "Heo tính từ ngày anh/chị bấm Tham gia." : `Heo tính từ các đơn giao từ ngày ${dm(status.campaign.starts_on)}.`}{" "}
          {canJoin ? "Không tham gia thì đặt hàng bình thường, anh/chị vẫn tham gia lại được bất cứ lúc nào." : ""}
        </p>
        {enrollError ? <p className="dealer-heo-err" role="alert">{enrollError}</p> : null}
        <div className="dealer-heo-offer-actions">
        {!canJoin ? (
          <button type="button" className="dealer-heo-btn dealer-heo-btn--ink" onClick={() => emit({ offerOpen: false })}>{joined ? "Đóng" : "Đã hiểu"}</button>
        ) : (
          <>
            <button type="button" className="dealer-heo-btn dealer-heo-btn--red" data-dealer-heo-join disabled={enrolling} onClick={() => void enrollDealerHeo("enroll")}>
              {enrolling ? "Đang lưu…" : "🐷 Tham gia"}
            </button>
            <button type="button" className="dealer-heo-btn dealer-heo-btn--ghost" data-dealer-heo-decline disabled={enrolling} onClick={() => void enrollDealerHeo("decline")}>
              Không tham gia
            </button>
          </>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Opens the offer on entering dathang while the dealer has not chosen yet. */
function OfferAutoOpen() {
  const { status, token } = useHeo();
  useEffect(() => {
    if (!status || !token || enrollOf(status) !== "none" || phaseOf(status) === "announce") return;
    let later = "";
    try { later = sessionStorage.getItem(OFFER_DISMISS_KEY) || ""; } catch { /* ignore */ }
    if (!later) openDealerHeoOffer();
  }, [status, token]);
  return null;
}

/** Banner at the top of the chat. Joined = red heo card; otherwise an offer card. */
export function DealerHeoBanner() {
  const { status } = useHeo();
  if (!status) return null;
  const mode = enrollOf(status);
  const phase = phaseOf(status);
  const s = status.summary;
  return (
    <section className="dealer-heo-banner" data-dealer-heo-banner data-enrollment={mode} data-phase={phase} aria-label="Chương trình Heo Đất Tết">
      <OfferAutoOpen />
      <OfferDialog />
      <div className="dealer-heo-kicker">{status.campaign.title.toUpperCase()}{phase !== "live" ? ` · ÁP DỤNG TỪ ${dm(status.campaign.starts_on)}` : ""}</div>
      {phase === "announce" ? (
        <>
          <div className="dealer-heo-pigrow">
            <span className="dealer-heo-pig" aria-hidden="true">🐷</span>
            <div className="min-w-0">
              <strong>Sắp có chương trình mới</strong>
              <span>Mức của anh/chị: {que(baselineOf(status))} que/ngày</span>
            </div>
          </div>
          <p>Bán thêm mỗi que, heo thêm {formatHeoVnd(status.campaign.rate)}. Chương trình <b>áp dụng từ {dm(status.campaign.starts_on)}</b>. Mở đăng ký tham gia lúc <b>{openLabel(status)}</b>.</p>
          <button type="button" className="dealer-heo-btn dealer-heo-btn--light" data-dealer-heo-open-offer onClick={openDealerHeoOffer}>Xem thể lệ</button>
        </>
      ) : mode === "joined" && phase === "open" ? (
        <>
          <div className="dealer-heo-pigrow">
            <span className="dealer-heo-pig" aria-hidden="true">🐷</span>
            <div className="min-w-0">
              <strong>Đã tham gia ✓</strong>
              <span>Heo bắt đầu tính từ đơn giao ngày {dm(status.campaign.starts_on)}</span>
            </div>
          </div>
          <p>Mức của anh/chị: <b>{que(baselineOf(status))} que/ngày</b>. Đặt vượt mức mỗi ngày: mỗi que +{formatHeoVnd(status.campaign.rate)} vào heo.</p>
          <button type="button" className="dealer-heo-btn dealer-heo-btn--light" onClick={openDealerHeoOffer}>Xem thể lệ</button>
        </>
      ) : mode === "joined" ? (
        <>
          <div className="dealer-heo-pigrow">
            <span className="dealer-heo-pig" aria-hidden="true">🐷</span>
            <div className="min-w-0">
              <strong>{formatHeoVnd(s.total_vnd)}</strong>
              <span>{s.bread_qty > 0 ? `+ ${que(s.bread_qty)} que bánh tặng · ` : ""}đập heo {dm(status.campaign.break_on)}</span>
            </div>
          </div>
          <div className="dealer-heo-extra" data-dealer-heo-extra>
            <div><b>{que(s.extra_que)} que</b><span>đã bán thêm</span></div>
            <div><b>{que(baselineOf(status))} que/ngày</b><span>mức của anh/chị (T{Number(status.baseline_month?.slice(5) || 11)})</span></div>
          </div>
          <p>Đặt vượt mức mỗi ngày: mỗi que +{formatHeoVnd(status.campaign.rate)} vào heo. Đơn từ {que(requiredOf(status))} que được lắc heo.</p>
          <button type="button" className="dealer-heo-btn dealer-heo-btn--light" onClick={openDealerHeoOffer}>Xem thể lệ</button>
        </>
      ) : (
        <>
          <div className="dealer-heo-pigrow">
            <span className="dealer-heo-pig" aria-hidden="true">🐷</span>
            <div className="min-w-0">
              <strong>Mức của anh/chị: {que(baselineOf(status))} que/ngày</strong>
              <span>Đặt trên mức này mỗi ngày là có thưởng</span>
            </div>
          </div>
          <p>{mode === "declined" ? "Anh/chị đang không tham gia. Muốn tham gia lại bất cứ lúc nào." : "Bán thêm mỗi que, heo thêm " + formatHeoVnd(status.campaign.rate) + ". Đập heo " + dm(status.campaign.break_on) + " lấy tiền Tết."}</p>
          <button type="button" className="dealer-heo-btn dealer-heo-btn--light" data-dealer-heo-open-offer onClick={openDealerHeoOffer}>
            {mode === "declined" ? "Tham gia lại" : "Xem thể lệ & tham gia"}
          </button>
        </>
      )}
    </section>
  );
}

/** Thin line pinned at the top of the chat while the dealer scrolls. */
export function DealerHeoPinned() {
  const { status } = useHeo();
  if (!status) return null;
  const mode = enrollOf(status);
  return (
    <button type="button" className="dealer-heo-pinned" data-dealer-heo-pinned data-enrollment={mode} onClick={openDealerHeoOffer}>
      <span aria-hidden="true">🐷</span>
      {phaseOf(status) === "announce" ? (
        <><b>Heo Đất Tết</b><span>· áp dụng từ {dm(status.campaign.starts_on)}, mở đăng ký {openLabel(status)}</span></>
      ) : mode === "joined" && phaseOf(status) === "open" ? (
        <><b>Heo Đất Tết</b><span>· đã tham gia, tính từ {dm(status.campaign.starts_on)}</span></>
      ) : mode === "joined" ? (
        <><b>{formatHeoVnd(status.summary.total_vnd)}</b><span>· bán thêm {que(status.summary.extra_que)} que</span></>
      ) : (
        <><b>Heo Đất Tết</b><span>· {mode === "declined" ? "bấm để tham gia lại" : "bấm để xem thể lệ & tham gia"}</span></>
      )}
      <i aria-hidden="true">›</i>
    </button>
  );
}

/** Compact card at the top of Đơn hàng (history tab). */
export function DealerHeoOrdersCard() {
  const { status } = useHeo();
  if (!status) return null;
  const mode = enrollOf(status);
  const s = status.summary;
  return (
    <button type="button" className="dealer-heo-orders-card" data-dealer-heo-orders-card data-enrollment={mode} onClick={openDealerHeoOffer} aria-label="Xem thể lệ Heo Đất Tết">
      <span className="dealer-heo-pig" aria-hidden="true">🐷</span>
      <span className="min-w-0 flex-1 text-left">
        {phaseOf(status) === "announce" ? (
          <>
            <b>Heo Đất Tết · áp dụng từ {dm(status.campaign.starts_on)}</b>
            <small>Mở đăng ký lúc {openLabel(status)} · mức của anh/chị {que(baselineOf(status))} que/ngày</small>
          </>
        ) : mode === "joined" && phaseOf(status) === "open" ? (
          <>
            <b>Heo Đất Tết · đã tham gia ✓</b>
            <small>Heo bắt đầu tính từ đơn giao ngày {dm(status.campaign.starts_on)} · mức {que(baselineOf(status))} que/ngày</small>
          </>
        ) : mode === "joined" ? (
          <>
            <b>Heo Đất Tết · {formatHeoVnd(s.total_vnd)}</b>
            <small>Đã bán thêm {que(s.extra_que)} que · mức {que(baselineOf(status))} que/ngày · còn {s.days_to_break} ngày đập heo</small>
          </>
        ) : (
          <>
            <b>Heo Đất Tết · {mode === "declined" ? "Tham gia lại" : "Tham gia ngay"}</b>
            <small>Mức của anh/chị {que(baselineOf(status))} que/ngày · đặt trên mức là có thưởng</small>
          </>
        )}
      </span>
      <i aria-hidden="true">›</i>
    </button>
  );
}

/** One line inside the order confirmation card (before submit). */
export function DealerHeoOrderStrip({ quantity }: { quantity: number }) {
  const { status } = useHeo();
  if (!status || !(quantity > 0) || phaseOf(status) !== "live") return null;
  const mode = enrollOf(status);
  if (mode !== "joined") {
    return (
      <button type="button" className="dealer-heo-strip dealer-heo-strip--join" data-dealer-heo-strip onClick={openDealerHeoOffer}>
        <span aria-hidden="true">🐷</span>
        <div><b>Tham gia Heo Đất Tết để đơn này được tính thưởng</b><small>Mức của anh/chị {que(baselineOf(status))} que/ngày · bấm xem thể lệ</small></div>
      </button>
    );
  }
  const base = baselineOf(status);
  const extra = Math.max(0, quantity - base);
  const need = status.campaign.is_test ? 1 : requiredOf(status);
  const missing = Math.max(0, need - quantity);
  return (
    <div className="dealer-heo-strip" data-dealer-heo-strip>
      <span aria-hidden="true">🐷</span>
      <div>
        {extra > 0
          ? <b>Vượt {que(extra)} que → +{formatHeoVnd(extra * status.campaign.rate)} vào heo</b>
          : <b>Thêm {que(Math.max(1, Math.ceil(base - quantity)))} que nữa là bắt đầu bỏ heo</b>}
        <small>
          Heo đang có {formatHeoVnd(status.summary.total_vnd)}
          {status.campaign.spin_enabled_for_me
            ? (missing === 0 ? " · đơn này được lắc heo" : ` · còn thiếu ${que(missing)} que để được lắc heo (từ ${que(need)} que)`)
            : ""}
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
  if (!status || !lastOrder || !status.campaign.spin_enabled_for_me || enrollOf(status) !== "joined" || phaseOf(status) !== "live") return null;
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
  if (!status || enrollOf(status) !== "joined" || phaseOf(status) !== "live") return null;
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
        <div><b>{formatHeoVnd(s.from_extra_vnd)}</b><span>Từ {que(s.extra_que)} que bán thêm (mức {que(baselineOf(status))}/ngày)</span></div>
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
