import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Loader2, MapPin, MapPinPlus, Navigation, RefreshCw, Truck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ConsentSheet } from "@/components/payslip-portal/AttendancePanel";
import { PayslipSessionExpiredError, type PayrollAttendanceSource } from "@/lib/payslip-portal/types";
import { getCurrentLocation, type GeolocationPoint, type GeolocationResult } from "@/lib/payslip-portal/geolocation";
import { compressSelfie } from "@/lib/payslip-portal/selfie-compress";
import type { DeliveryTask, DeliveryToday, PayrollDeliverySource } from "@/lib/payslip-portal/delivery-api";

const BRAND_GRADIENT = { background: "linear-gradient(135deg, #e0578a 0%, #d2456f 100%)" };
const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
const number = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });
const PHOTO_MAX_SIDE = 1280;

function dayLabel(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

function timeLabel(value: string | null): string {
  if (!value) return "";
  return new Date(value).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

export interface DeliveryPanelProps {
  source: PayrollDeliverySource;
  /** Used only for the shared photo + location consent. */
  attendance?: PayrollAttendanceSource;
  onSessionExpired: (message: string) => void;
}

/**
 * Driver deliveries on luong.banhmique.vn. The server builds the list from the
 * dealer orders and decides everything; this screen shows the stops and sends a
 * photo + location when the driver finishes one. Hidden for non-drivers.
 */
export function DeliveryPanel({ source, attendance, onSessionExpired }: DeliveryPanelProps) {
  const [data, setData] = useState<DeliveryToday | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [consentFor, setConsentFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await source.getToday());
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        onSessionExpired(err.message);
        return;
      }
      setLoadError(err instanceof Error ? err.message : "Không tải được việc giao hàng.");
    } finally {
      setLoading(false);
    }
  }, [source, onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (loading && !data) {
    return (
      <section className="mt-6 flex h-32 items-center justify-center rounded-[24px] bg-white ring-1 ring-[#eee8e5]" aria-busy="true">
        <Loader2 className="h-6 w-6 animate-spin text-[#dc4f78]" aria-label="Đang tải việc giao hàng" />
      </section>
    );
  }
  if (loadError && !data) {
    return (
      <section role="alert" className="mt-6 rounded-[20px] border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <p>{loadError}</p>
        <Button variant="outline" className="mt-3 h-11 rounded-xl border-red-200 bg-white" onClick={() => void load()}>
          Thử lại
        </Button>
      </section>
    );
  }
  if (!data || !data.isDriver) return null;

  const tasks = data.tasks.filter((task) => task.status !== "cancelled");
  const todayTasks = tasks.filter((task) => task.deliveryDate === data.deliveryDate);
  const previous = tasks.filter((task) => task.deliveryDate !== data.deliveryDate);
  const totalQuantity = todayTasks.reduce((sum, task) => sum + task.quantity, 0);
  const next = [...previous, ...todayTasks].find((task) => task.status === "pending") ?? null;
  const open = tasks.find((task) => task.id === openId) ?? null;
  const percent = data.totalPoints > 0 ? Math.round((data.completedPoints / data.totalPoints) * 100) : 0;

  const startTask = (taskId: string) => {
    if (!data.consentAccepted && attendance) {
      setConsentFor(taskId);
      return;
    }
    setOpenId(taskId);
  };

  return (
    <section className="mt-6" aria-labelledby="delivery-heading" data-delivery-panel>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="delivery-heading" className="text-[28px] font-extrabold leading-tight tracking-[-0.02em]">
            Giao hàng hôm nay
          </h2>
          <p className="mt-1 text-sm text-[#666263]">
            {dayLabel(data.deliveryDate)} · {todayTasks.length} điểm · đơn chốt lúc 23:59 hôm qua
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#eadfe3] bg-white text-[#80566a] disabled:opacity-60"
          aria-label="Tải lại việc giao hàng"
        >
          <RefreshCw className={cn("h-5 w-5", loading && "animate-spin")} />
        </button>
      </div>

      <div className="mt-4 rounded-[24px] bg-white p-5 shadow-[0_12px_28px_rgba(70,50,55,0.08)] ring-1 ring-[#eee8e5]">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Điểm đã giao" value={`${data.completedPoints}/${data.totalPoints}`} />
          <Stat label="Bánh đã giao" value={number.format(data.deliveredQuantity)} hint={`/${number.format(totalQuantity)}`} />
          <Stat label="Công hôm nay" value={number.format(data.deliveryUnits)} />
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#f3e3e9]" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ giao hàng">
          <div className="h-full rounded-full transition-[width] duration-500" style={{ ...BRAND_GRADIENT, width: `${percent}%` }} />
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="mt-4 rounded-[24px] bg-white p-6 text-center ring-1 ring-[#eee8e5]">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#fdeaf1] text-[#ec5b91]">
            <Truck className="h-6 w-6" />
          </div>
          <p className="mt-3 text-[16px] font-bold">Hôm nay chưa có điểm giao</p>
          <p className="mt-1 text-sm leading-6 text-[#666263]">Danh sách tự tạo lúc 00:05 từ đơn đại lý. Nếu thiếu điểm, báo quản lý.</p>
        </div>
      ) : (
        <div className="mt-4 rounded-[24px] bg-white px-4 py-1 shadow-[0_12px_28px_rgba(70,50,55,0.08)] ring-1 ring-[#eee8e5]">
          {previous.length > 0 ? (
            <p className="mt-3 rounded-[14px] bg-[#fff4c7] px-3 py-2 text-[13px] font-semibold text-[#4a3b00]">
              Còn {previous.length} điểm của ngày trước chưa hoàn thành
            </p>
          ) : null}
          {[...previous, ...todayTasks].map((task, index) => (
            <StopRow
              key={task.id}
              task={task}
              index={index}
              isNext={task.id === next?.id}
              isPrevious={task.deliveryDate !== data.deliveryDate}
              onOpen={() => (task.status === "pending" ? startTask(task.id) : setOpenId(task.id))}
            />
          ))}
        </div>
      )}

      {open ? (
        <StopSheet
          task={open}
          source={source}
          onClose={() => setOpenId(null)}
          onSessionExpired={onSessionExpired}
          onDone={(message) => {
            setOpenId(null);
            setToast(message);
            void load();
          }}
        />
      ) : null}

      {consentFor && attendance ? (
        <ConsentSheet
          mode="gate"
          accepted={data.consentAccepted}
          acceptedAt={data.consentAcceptedAt}
          onClose={() => setConsentFor(null)}
          onAccept={async () => {
            await attendance.acceptConsent(data.consentRequiredVersion);
            const taskId = consentFor;
            setConsentFor(null);
            await load();
            setOpenId(taskId);
          }}
          onWithdraw={async () => {
            await attendance.withdrawConsent();
            setConsentFor(null);
            await load();
          }}
          onSessionExpired={onSessionExpired}
        />
      ) : null}

      {toast ? (
        <div role="status" className="fixed inset-x-4 bottom-6 z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-[#211d1e] px-4 py-3.5 text-[15px] font-semibold text-white shadow-lg">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-[#7ee2a4]" />
          <span>{toast}</span>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-[#fff5f8] px-3 py-2.5">
      <p className="text-[12px] leading-tight text-[#80566a]">{label}</p>
      <p className="mt-1 text-[20px] font-extrabold leading-none">
        {value}
        {hint ? <span className="text-[12px] font-semibold text-[#a08a93]">{hint}</span> : null}
      </p>
    </div>
  );
}

function StopRow({
  task,
  index,
  isNext,
  isPrevious,
  onOpen,
}: {
  task: DeliveryTask;
  index: number;
  isNext: boolean;
  isPrevious: boolean;
  onOpen: () => void;
}) {
  const done = task.status === "completed";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-delivery-stop={task.id}
      className="flex w-full items-start gap-3 border-t border-[#eee8e5] py-3.5 text-left first-of-type:border-t-0"
    >
      <span
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-extrabold",
          done ? "bg-[#e6f5ec] text-[#1f8a4c]" : "bg-[#fdeaf1] text-[#c23e70]",
        )}
      >
        {done ? <CheckCircle2 className="h-[18px] w-[18px]" /> : index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15.5px] font-bold leading-snug">{task.destinationName}</span>
        <span className="mt-0.5 block truncate text-[13px] text-[#666263]">
          {[task.address, task.units > 0 ? `+${number.format(task.units)} công` : ""].filter(Boolean).join(" · ")}
        </span>
        <span className="mt-2 flex flex-wrap gap-1.5">
          {done ? (
            <Chip tone="green" icon={CheckCircle2}>Đã giao {timeLabel(task.completedAt)}</Chip>
          ) : isNext ? (
            <Chip tone="pink">Điểm tiếp theo</Chip>
          ) : (
            <Chip tone="gray">Chưa giao</Chip>
          )}
          {isPrevious ? <Chip tone="amber">Ngày {shortDate(task.deliveryDate)}</Chip> : null}
          {!done && !task.hasLocation ? <Chip tone="amber" icon={MapPinPlus}>Lần đầu – sẽ lưu vị trí</Chip> : null}
          {done && task.locationAttached ? <Chip tone="amber" icon={MapPinPlus}>Vừa lưu vị trí</Chip> : null}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[18px] font-extrabold leading-none">{number.format(task.quantity)}</span>
        <span className="text-[12px] text-[#8a8687]">bánh</span>
      </span>
    </button>
  );
}

function Chip({ tone, icon: Icon, children }: { tone: "green" | "pink" | "gray" | "amber"; icon?: typeof MapPin; children: React.ReactNode }) {
  const tones = {
    green: "bg-[#e6f5ec] text-[#1f8a4c]",
    pink: "bg-[#fdeaf1] text-[#c23e70]",
    gray: "bg-[#f3eeec] text-[#666263]",
    amber: "bg-[#fff4c7] text-[#7a5200]",
  } as const;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold", tones[tone])}>
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {children}
    </span>
  );
}

type LocationState = { status: "idle" } | { status: "loading" } | { status: "ok"; point: GeolocationPoint; at: string } | { status: "error"; message: string };

function StopSheet({
  task,
  source,
  onClose,
  onDone,
  onSessionExpired,
}: {
  task: DeliveryTask;
  source: PayrollDeliverySource;
  onClose: () => void;
  onDone: (message: string) => void;
  onSessionExpired: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [location, setLocation] = useState<LocationState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = task.status === "completed";

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url);
  }, [photo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [busy, onClose]);

  const locate = async () => {
    setLocation({ status: "loading" });
    const result = await getCurrentLocation();
    if (result.ok === true) {
      setLocation({ status: "ok", point: result.point, at: new Date().toISOString() });
      return;
    }
    const failure = result as Extract<GeolocationResult, { ok: false }>;
    setLocation({ status: "error", message: failure.guidance ? `${failure.message} ${failure.guidance}` : failure.message });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const compressed = await compressSelfie(file, PHOTO_MAX_SIDE);
      setPhoto({ blob: compressed.blob, url: URL.createObjectURL(compressed.blob) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không đọc được ảnh. Vui lòng chụp lại.");
      return;
    }
    if (location.status !== "ok") void locate();
  };

  const complete = async () => {
    if (!photo || location.status !== "ok") return;
    setBusy(true);
    setError(null);
    try {
      const result = await source.complete({
        taskId: task.id,
        photo: photo.blob,
        latitude: location.point.latitude,
        longitude: location.point.longitude,
        accuracyM: location.point.accuracyM,
        capturedAt: location.at,
      });
      onDone(`Đã giao ${task.destinationName} lúc ${timeLabel(result.completedAt) || timeLabel(new Date().toISOString())}`);
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        onSessionExpired(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "Không hoàn thành được. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-[rgba(33,29,30,0.38)]" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="stop-title" className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-[28px] bg-[#fefbf9] px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2.5">
        <div className="mx-auto mb-3 h-1.5 w-11 rounded-full bg-[#e2d8dc]" />
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 id="stop-title" className="text-[21px] font-extrabold leading-tight tracking-[-0.02em]">{task.destinationName}</h3>
            <p className="mt-1 text-sm text-[#666263]">
              {[task.address, task.units > 0 ? `điểm phát sinh +${number.format(task.units)} công` : ""].filter(Boolean).join(" · ")}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[#80566a] ring-1 ring-[#eadfe3]" aria-label="Đóng">
            <X className="h-5 w-5" />
          </button>
        </div>

        <a
          href={task.mapsLink}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex h-11 items-center gap-2 rounded-full bg-white px-4 text-[14px] font-bold text-[#211d1e] ring-1 ring-[#eadfe3]"
        >
          <Navigation className="h-4 w-4 text-[#dc4f78]" />
          Chỉ đường
        </a>

        {task.dealerNote ? (
          <p className="mt-3 rounded-[14px] bg-[#fff5f8] px-3 py-2.5 text-[13.5px] leading-6 text-[#80566a]">
            <b>Ghi chú đại lý:</b> {task.dealerNote}
          </p>
        ) : null}

        <div className="mt-3 rounded-[20px] bg-white px-4 ring-1 ring-[#eee8e5]">
          {task.items.map((item, i) => (
            <div key={`${item.productName}-${i}`} className="flex items-center justify-between border-t border-[#eee8e5] py-2.5 text-[15px] first:border-t-0">
              <span>{item.productName}</span>
              <b className="text-[16px]">{number.format(item.quantity)}</b>
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-[#eee8e5] py-2.5 text-[15px]">
            <span className="font-bold">Tổng</span>
            <b className="text-[16px]">{number.format(task.quantity)} bánh</b>
          </div>
        </div>

        {done ? (
          <div className="mt-4 flex items-center gap-3 rounded-[16px] bg-[#e6f5ec] px-4 py-3 text-[14px] text-[#1f6b3d]">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <span>
              <b>Đã giao lúc {timeLabel(task.completedAt)}</b>
              {task.locationAttached ? " · vị trí đã gắn cho điểm này" : ""}
            </span>
          </div>
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => {
                void onFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              data-delivery-photo
              className={cn(
                "relative mt-4 flex h-44 w-full flex-col items-center justify-center gap-1.5 overflow-hidden rounded-[20px] text-[#80566a]",
                photo ? "bg-black" : "border-2 border-dashed border-[#efb6ca] bg-[#fff5f8]",
              )}
            >
              {photo ? (
                <>
                  <img src={photo.url} alt="Ảnh bánh giao" className="h-full w-full object-cover" />
                  <span className="absolute bottom-2.5 right-2.5 rounded-full bg-black/55 px-3 py-1 text-[12px] font-semibold text-white">Chụp lại</span>
                </>
              ) : (
                <>
                  <Camera className="h-8 w-8 text-[#dc4f78]" />
                  <span className="text-[15px] font-bold">Chụp ảnh bánh giao</span>
                  <span className="text-[12.5px]">Chụp rõ số bánh tại đại lý</span>
                </>
              )}
            </button>

            <div className="mt-3 flex items-center gap-2.5 rounded-[16px] bg-white px-3.5 py-3 text-[14px] text-[#666263] ring-1 ring-[#eee8e5]" aria-live="polite">
              {location.status === "loading" ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[#dc4f78]" /> : location.status === "ok" ? <CheckCircle2 className="h-5 w-5 shrink-0 text-[#1f8a4c]" /> : <MapPin className="h-5 w-5 shrink-0 text-[#dc4f78]" />}
              <span className="min-w-0 flex-1">
                {location.status === "idle" && "Vị trí và giờ sẽ được lấy khi chụp ảnh"}
                {location.status === "loading" && "Đang lấy vị trí…"}
                {location.status === "ok" && (
                  <>
                    <b className="text-[#211d1e]">Đã lấy vị trí</b> · sai số ±{Math.round(location.point.accuracyM)} m · {timeLabel(location.at)}
                  </>
                )}
                {location.status === "error" && <span className="text-red-700">{location.message}</span>}
              </span>
              {location.status === "error" ? (
                <button type="button" onClick={() => void locate()} className="shrink-0 rounded-full bg-[#fdeaf1] px-3 py-1.5 text-[13px] font-bold text-[#c23e70]">
                  Thử lại
                </button>
              ) : null}
            </div>

            {!task.hasLocation ? (
              <p className="mt-3 rounded-[14px] bg-[#fff5f8] px-3 py-2.5 text-[13px] leading-6 text-[#80566a]">
                Điểm này chưa có vị trí. Vị trí lúc bấm Hoàn thành sẽ được <b>gắn luôn cho điểm</b>, lần sau mở chỉ đường chính xác.
              </p>
            ) : null}

            {error ? (
              <p role="alert" className="mt-3 rounded-[14px] border border-red-200 bg-red-50 px-3 py-2.5 text-[13.5px] text-red-700">{error}</p>
            ) : null}

            <Button
              type="button"
              className="mt-4 h-14 w-full rounded-2xl border-0 text-[18px] font-bold text-white shadow-none hover:brightness-95 disabled:opacity-100 disabled:[background:#e9d9df]"
              style={photo && location.status === "ok" && !busy ? BRAND_GRADIENT : undefined}
              disabled={!photo || location.status !== "ok" || busy}
              onClick={() => void complete()}
              data-delivery-complete
            >
              {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <CheckCircle2 className="mr-2 h-5 w-5" />}
              Hoàn thành
            </Button>
            {!photo ? <p className="mt-2 text-center text-[12.5px] text-[#8a8687]">Cần chụp ảnh trước khi hoàn thành</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
