import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarCheck, Clock3, Gift, Loader2, Sparkles, Ticket, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PayslipSessionExpiredError,
  type PayrollMissionItem,
  type PayrollMissionItemKind,
  type PayrollMissionOffer,
  type PayrollMissionSource,
} from "@/lib/payslip-portal/types";

const BRAND_GRADIENT = { background: "linear-gradient(90deg, #dc4f78 0%, #dc527a 100%)" };
const vnd = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });

function money(value: number): string {
  return `${vnd.format(Math.round(value))}đ`;
}

function shortDate(value: string): string {
  const [, m, d] = value.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : value;
}

function fullDate(value: string): string {
  const [y, m, d] = value.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : value;
}

function daysLeft(endsOn: string): number {
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  today.setHours(0, 0, 0, 0);
  const end = new Date(`${endsOn.slice(0, 10)}T00:00:00`);
  return Math.max(0, Math.round((end.getTime() - today.getTime()) / 86_400_000));
}

const KIND_ICON: Record<PayrollMissionItemKind, typeof Gift> = {
  attendance_regular: CalendarCheck,
  punctual: Clock3,
  draw_ticket: Ticket,
  manual: Trophy,
};

function itemAmount(item: PayrollMissionItem, draw: Record<string, unknown> | null): string {
  if (item.kind === "draw_ticket") {
    const prize = Number(draw?.prize_vnd);
    return Number.isFinite(prize) && prize > 0 ? money(prize) : "Vé bốc thăm";
  }
  return item.amountVnd > 0 ? `+${money(item.amountVnd)}` : "";
}

function ItemRow({
  item,
  draw,
  status,
}: {
  item: PayrollMissionItem;
  draw: Record<string, unknown> | null;
  status?: { tone: "on" | "off" | "wait"; text: string } | null;
}) {
  const Icon = KIND_ICON[item.kind] ?? Gift;
  return (
    <div className="flex items-start gap-3 border-t border-[#f1ebe8] py-3 first:border-t-0">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#fdeaf1] text-[#dc4f78]">
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-bold leading-snug text-[#211d1e]">{item.label}</p>
        {item.detail ? <p className="mt-0.5 text-[12.5px] leading-snug text-[#666263]">{item.detail}</p> : null}
        {status ? (
          <span
            className={cn(
              "mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold",
              status.tone === "on" && "bg-emerald-50 text-emerald-700",
              status.tone === "off" && "bg-red-50 text-red-700",
              status.tone === "wait" && "bg-orange-50 text-orange-700",
            )}
          >
            {status.text}
          </span>
        ) : null}
      </div>
      <span className="shrink-0 whitespace-nowrap text-[14px] font-extrabold text-[#c2416a]">{itemAmount(item, draw)}</span>
    </div>
  );
}

function itemStatus(offer: PayrollMissionOffer, item: PayrollMissionItem): { tone: "on" | "off" | "wait"; text: string } {
  if (offer.review) {
    if (offer.review.disqualified) return { tone: "off", text: "Không áp dụng" };
    if (item.kind === "draw_ticket") {
      return offer.ticket && !offer.ticket.voidReason ? { tone: "on", text: "Đã nhận vé" } : { tone: "off", text: "Không có vé" };
    }
    return offer.review.earned.some((earned) => earned.key === item.key)
      ? { tone: "on", text: "Đã xác nhận" }
      : { tone: "off", text: "Chưa đạt" };
  }
  if (item.kind === "draw_ticket") return { tone: "wait", text: "Khi hoàn thành nhiệm vụ" };
  const progress = offer.progress.find((p) => p.key === item.key);
  if (!progress) return { tone: "wait", text: "Đang theo dõi" };
  return progress.met ? { tone: "on", text: "Đang đạt" } : { tone: "off", text: "Chưa đạt" };
}

export interface MissionPanelProps {
  source: PayrollMissionSource;
  /** Increments after each accepted check-in; a pending offer then opens the gift. */
  checkInSignal: number;
  onSessionExpired: (message: string) => void;
}

/**
 * Monthly mission on luong.banhmique.vn. Everything shown comes from the
 * campaign data (items, rules, draw); nothing about a specific mission is
 * written here. A pending offer opens as a gift right after a check-in.
 */
export function MissionPanel({ source, checkInSignal, onSessionExpired }: MissionPanelProps) {
  const [offer, setOffer] = useState<PayrollMissionOffer | null>(null);
  const [giftOpen, setGiftOpen] = useState(false);
  const lastSignal = useRef(checkInSignal);

  const load = useCallback(async () => {
    try {
      const next = await source.getMission();
      setOffer(next);
      return next;
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) onSessionExpired(err.message);
      return null;
    }
  }, [source, onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (checkInSignal === lastSignal.current) return;
    lastSignal.current = checkInSignal;
    void load().then((next) => {
      if (next?.status === "pending") setGiftOpen(true);
    });
  }, [checkInSignal, load]);

  if (!offer || offer.status === "declined") return null;

  const { campaign } = offer;
  const maxBonus = campaign.items.reduce((sum, item) => sum + (item.kind === "draw_ticket" ? 0 : item.amountVnd), 0);
  const regular = offer.progress.find((p) => p.kind === "attendance_regular");
  const punctual = offer.progress.find((p) => p.kind === "punctual");

  return (
    <>
      {offer.status === "pending" ? (
        <button
          type="button"
          onClick={() => setGiftOpen(true)}
          className="mt-4 flex w-full items-center gap-3 rounded-[20px] border border-[#f5c542] bg-[#fff7e0] px-4 py-3 text-left"
          data-mission-pending
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#ffd34d] to-[#f59e0b] text-white">
            <Gift className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-bold text-[#211d1e]">Bạn có một món quà bất ngờ</span>
            <span className="block text-[12.5px] text-[#7c5a12]">Chạm để xem nhiệm vụ</span>
          </span>
        </button>
      ) : (
        <section className="mt-6" aria-labelledby="mission-heading" data-mission-card>
          <h2 id="mission-heading" className="text-[28px] font-extrabold leading-tight tracking-[-0.02em]">
            Nhiệm vụ tháng
          </h2>
          <p className="mt-1 text-sm text-[#666263]">
            {fullDate(campaign.startsOn)} – {fullDate(campaign.endsOn)}
          </p>
          <div
            className="mt-4 rounded-[22px] p-4 text-white shadow-[0_14px_28px_rgba(220,79,120,0.28)]"
            style={{ background: "linear-gradient(135deg, #e0578a 0%, #c2416a 100%)" }}
          >
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-bold">
              <Gift className="h-3.5 w-3.5" />
              {offer.review ? "Đã chốt kết quả" : `Còn ${daysLeft(campaign.endsOn)} ngày`}
            </span>
            <h3 className="mt-2.5 text-[19px] font-extrabold leading-snug">{campaign.title}</h3>
            {campaign.summary ? <p className="mt-1 text-[12.5px] text-white/90">{campaign.summary}</p> : null}
            {!offer.review && (regular || punctual) ? (
              <div className="mt-3 space-y-2.5 text-[12.5px] font-semibold">
                {regular ? (
                  <ProgressLine
                    label="Ngày chấm đủ vào/ra"
                    value={`${regular.detail.daysComplete}/${regular.detail.daysWithIn}`}
                    ratio={regular.detail.daysWithIn > 0 ? regular.detail.daysComplete / regular.detail.daysWithIn : 0}
                  />
                ) : null}
                {punctual ? (
                  <ProgressLine
                    label="Đúng giờ"
                    value={punctual.detail.daysWithIn > 0 ? `${Math.round((punctual.detail.onTimeDays / punctual.detail.daysWithIn) * 100)}%` : "—"}
                    ratio={punctual.detail.daysWithIn > 0 ? punctual.detail.onTimeDays / punctual.detail.daysWithIn : 0}
                  />
                ) : null}
              </div>
            ) : null}
            {maxBonus > 0 && !offer.review ? (
              <p className="mt-3 text-[12px] text-white/85">Thưởng tối đa +{money(maxBonus)} vào lương</p>
            ) : null}
          </div>
          <div className="mt-3 rounded-[22px] bg-white px-4 py-1 ring-1 ring-[#eee8e5]">
            {campaign.items.map((item) => (
              <ItemRow key={item.key} item={item} draw={campaign.draw} status={itemStatus(offer, item)} />
            ))}
          </div>
          {offer.review?.disqualified ? (
            <p className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-[12.5px] leading-5 text-red-700">
              Nhiệm vụ không được áp dụng thưởng theo quy định. Liên hệ quản lý nếu cần giải thích.
            </p>
          ) : !offer.review ? (
            <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] leading-5 text-amber-900">
              <p className="font-semibold">Kết quả đang tạm tính, thưởng được xác nhận khi chốt lương.</p>
              {campaign.rules.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {campaign.rules.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </section>
      )}

      {giftOpen && offer.status === "pending" ? (
        <GiftSheet
          offer={offer}
          onClose={() => setGiftOpen(false)}
          onRespond={async (decision) => {
            const next = await source.respondMission(offer.id, decision);
            setOffer(next ?? (await load()));
            setGiftOpen(false);
          }}
          onSessionExpired={onSessionExpired}
        />
      ) : null}
    </>
  );
}

function ProgressLine({ label, value, ratio }: { label: string; value: string; ratio: number }) {
  return (
    <div>
      <div className="flex justify-between">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/25">
        <div className="h-full rounded-full bg-white" style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} />
      </div>
    </div>
  );
}

function GiftSheet({
  offer,
  onClose,
  onRespond,
  onSessionExpired,
}: {
  offer: PayrollMissionOffer;
  onClose: () => void;
  onRespond: (decision: "accept" | "decline") => Promise<void>;
  onSessionExpired: (message: string) => void;
}) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { campaign } = offer;

  const respond = async (decision: "accept" | "decline") => {
    setBusy(decision);
    setError(null);
    try {
      await onRespond(decision);
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        onSessionExpired(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "Không gửi được. Vui lòng thử lại.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(20,9,13,0.55)] sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="gift-title">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-[28px] bg-[#fefbf9] px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-6 shadow-xl sm:rounded-[28px]">
        <div className="mx-auto flex h-[68px] w-[68px] items-center justify-center rounded-[22px] bg-gradient-to-br from-[#ffd34d] to-[#f59e0b] text-white shadow-[0_12px_26px_rgba(245,158,11,0.4)]">
          <Gift className="h-8 w-8" />
        </div>
        <h2 id="gift-title" className="mt-2 text-center text-[20px] font-extrabold">
          Bạn có một món quà bất ngờ!
        </h2>
        <p className="mt-1 text-center text-[13px] text-[#666263]">
          {campaign.title} · {shortDate(campaign.startsOn)} – {fullDate(campaign.endsOn)}
        </p>
        {campaign.summary ? <p className="mt-2 text-center text-[13px] leading-5 text-[#3b3536]">{campaign.summary}</p> : null}

        <div className="mt-3 rounded-[18px] border border-[#eee8e5] bg-white px-3">
          {campaign.items.map((item) => (
            <ItemRow key={item.key} item={item} draw={campaign.draw} />
          ))}
        </div>

        {campaign.rules.length > 0 ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-[12px] leading-5 text-[#666263]">
            {campaign.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        ) : null}

        {error ? <p role="alert" className="mt-3 rounded-2xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}

        {confirmDecline ? (
          <div className="mt-4 space-y-3">
            <p className="text-center text-[13px] text-[#3b3536]">Từ chối thì bạn sẽ không nhận được phần thưởng của nhiệm vụ này. Bạn chắc chứ?</p>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" className="h-12 rounded-2xl" disabled={busy !== null} onClick={() => setConfirmDecline(false)}>
                Quay lại
              </Button>
              <Button type="button" variant="destructive" className="h-12 rounded-2xl" disabled={busy !== null} onClick={() => void respond("decline")}>
                {busy === "decline" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Từ chối
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-[52px] rounded-2xl border-[#e5dcdf] text-[16px] font-bold text-[#4d4850]"
              disabled={busy !== null}
              onClick={() => setConfirmDecline(true)}
            >
              Từ chối
            </Button>
            <Button
              type="button"
              className="h-[52px] whitespace-nowrap rounded-2xl border-0 px-2 text-[15px] font-extrabold text-white shadow-none hover:brightness-95 min-[360px]:text-[16px]"
              style={BRAND_GRADIENT}
              disabled={busy !== null}
              onClick={() => void respond("accept")}
            >
              {busy === "accept" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 hidden h-4 w-4 min-[360px]:inline" />}
              Nhận nhiệm vụ
            </Button>
          </div>
        )}
        <button type="button" onClick={onClose} disabled={busy !== null} className="mt-2 min-h-11 w-full text-sm text-[#80566a]">
          Để sau
        </button>
      </div>
    </div>
  );
}

export default MissionPanel;
