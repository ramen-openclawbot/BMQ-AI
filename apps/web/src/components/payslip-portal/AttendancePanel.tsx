import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, CheckCircle2, FileText, Loader2, LogIn, LogOut, MapPin, RefreshCw, ShieldCheck, X, XCircle } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { CONSENT_CHECKBOX, CONSENT_CONTROLLER, CONSENT_SECTIONS, CONSENT_TITLE } from "@/components/payslip-portal/attendanceConsentText";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PayslipSessionExpiredError,
  type AttendanceEventKind,
  type PayrollAttendanceCheckinResult,
  type PayrollAttendanceSource,
  type PayrollAttendanceTodayPayload,
} from "@/lib/payslip-portal/types";
import { getCurrentLocation, getGeolocationGuidance, type GeolocationResult } from "@/lib/payslip-portal/geolocation";
import { compressSelfie } from "@/lib/payslip-portal/selfie-compress";

const BRAND_GRADIENT = { background: "linear-gradient(90deg, #dc4f78 0%, #dc527a 100%)" };

const timeFormat = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date);
}

function formatWorkDate(value: string): string {
  const [y, m, d] = value.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : value;
}

function weekdayLabel(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00+07:00`);
  if (Number.isNaN(date.getTime())) return "";
  const text = new Intl.DateTimeFormat("vi-VN", { weekday: "long", timeZone: "Asia/Ho_Chi_Minh" }).format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cameraGuidance(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Android/i.test(ua)) {
    return "Trên Chrome Android: bấm ⋮ → Cài đặt trang → Quyền → Máy ảnh → Cho phép, rồi tải lại trang.";
  }
  return "Trên Chrome máy tính: bấm biểu tượng cạnh địa chỉ trang → Máy ảnh → Cho phép, rồi tải lại trang.";
}

interface Problem {
  title: string;
  detail?: string;
}

export interface AttendancePanelProps {
  source: PayrollAttendanceSource;
  onSessionExpired: (message: string) => void;
}

/**
 * Employee check-in / check-out on luong.banhmique.vn. The server decides
 * everything; this screen only gathers location + a live selfie and shows the
 * answer. Hidden entirely when attendance is not enabled for the employee.
 */
export function AttendancePanel({ source, onSessionExpired }: AttendancePanelProps) {
  const [today, setToday] = useState<PayrollAttendanceTodayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [captureKind, setCaptureKind] = useState<AttendanceEventKind | null>(null);
  const [result, setResult] = useState<PayrollAttendanceCheckinResult | null>(null);
  // "gate": consent required before this check-in; "view": read/withdraw any time.
  const [consentMode, setConsentMode] = useState<{ mode: "gate" | "view"; kind: AttendanceEventKind | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setToday(await source.getToday());
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        onSessionExpired(err.message);
        return;
      }
      setLoadError(err instanceof Error ? err.message : "Không tải được chấm công hôm nay.");
    } finally {
      setLoading(false);
    }
  }, [source, onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !today) {
    return (
      <section className="mt-6 flex h-40 items-center justify-center rounded-[24px] bg-white ring-1 ring-[#eee8e5]" aria-busy="true">
        <Loader2 className="h-6 w-6 animate-spin text-[#dc4f78]" aria-label="Đang tải chấm công" />
      </section>
    );
  }

  if (loadError) {
    return (
      <section role="alert" className="mt-6 rounded-[20px] border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <p>{loadError}</p>
        <Button variant="outline" className="mt-3 h-11 rounded-xl border-red-200 bg-white" onClick={() => void load()}>
          Thử lại
        </Button>
      </section>
    );
  }

  if (!today || !today.gateEnabled) return null;

  const accepted = today.today.events.filter((event) => event.decision === "accepted");
  const checkIn = accepted.find((event) => event.eventKind === "in") ?? null;
  const checkOut = accepted.find((event) => event.eventKind === "out") ?? null;
  const nextKind: AttendanceEventKind | null = !checkIn ? "in" : !checkOut ? "out" : null;
  const pastIncomplete = today.incompleteDays.filter((day) => day.workDate !== today.today.workDate);

  return (
    <section className="mt-6" aria-labelledby="attendance-heading">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="attendance-heading" className="text-[28px] font-extrabold leading-tight tracking-[-0.02em]">
            Chấm công
          </h2>
          <p className="mt-1 text-sm text-[#666263]">
            {weekdayLabel(today.today.workDate)}, {formatWorkDate(today.today.workDate)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#eadfe3] bg-white text-[#80566a] disabled:opacity-60"
          aria-label="Tải lại chấm công"
        >
          <RefreshCw className={cn("h-5 w-5", loading && "animate-spin")} />
        </button>
      </div>

      <div className="mt-4 rounded-[24px] bg-white p-5 shadow-[0_12px_28px_rgba(70,50,55,0.08)] ring-1 ring-[#eee8e5]">
        <div className="grid grid-cols-2 gap-3">
          <PunchTile label="Giờ vào" icon={LogIn} time={checkIn ? formatTime(checkIn.serverReceivedAt) : null} />
          <PunchTile label="Giờ ra" icon={LogOut} time={checkOut ? formatTime(checkOut.serverReceivedAt) : null} />
        </div>

        <div className="mt-4 flex items-start gap-2 text-sm text-[#666263]">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#dc4f78]" />
          <span>
            {today.siteConfigured
              ? `Chấm công tại ${today.siteName ?? "Bếp Q7"}, trong bán kính ${today.siteRadiusM ?? ""} m.`
              : "Chưa thiết lập vị trí chấm công. Vui lòng liên hệ quản lý."}
          </span>
        </div>

        {nextKind ? (
          <Button
            type="button"
            className="mt-5 h-14 w-full rounded-2xl border-0 text-[19px] font-bold text-white shadow-none hover:brightness-95"
            style={BRAND_GRADIENT}
            disabled={!today.siteConfigured}
            onClick={() => {
              setResult(null);
              // Camera and location are requested only after a valid consent.
              if (today.today.consent.accepted) setCaptureKind(nextKind);
              else setConsentMode({ mode: "gate", kind: nextKind });
            }}
          >
            <Camera className="mr-2 h-5 w-5" />
            {nextKind === "in" ? "Chấm vào" : "Chấm ra"}
          </Button>
        ) : (
          <div className="mt-5 flex items-center justify-center gap-2 rounded-2xl bg-emerald-50 px-4 py-3 text-[15px] font-semibold text-emerald-800">
            <CheckCircle2 className="h-5 w-5" /> Đã chấm đủ vào và ra hôm nay
          </div>
        )}

        {result ? <ResultBanner result={result} /> : null}

        <button
          type="button"
          onClick={() => setConsentMode({ mode: "view", kind: null })}
          className="mt-4 flex min-h-11 w-full items-center justify-center gap-1.5 text-sm font-medium text-[#80566a] underline-offset-4 hover:underline"
        >
          <FileText className="h-4 w-4" />
          {today.today.consent.accepted ? "Thoả thuận hình ảnh và vị trí (đã đồng ý)" : "Xem thoả thuận hình ảnh và vị trí"}
        </button>
      </div>

      {pastIncomplete.length > 0 ? (
        <div className="mt-4 space-y-2">
          {pastIncomplete.map((day) => (
            <div
              key={day.workDate}
              className="flex items-start gap-3 rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold">
                  {formatWorkDate(day.workDate)} · {day.status === "missing_in" ? "Thiếu giờ vào" : "Thiếu giờ ra"}
                </p>
                <p className="mt-0.5">{day.message}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {consentMode ? (
        <ConsentSheet
          mode={consentMode.mode}
          accepted={today.today.consent.accepted}
          acceptedAt={today.today.consent.acceptedAt}
          onClose={() => setConsentMode(null)}
          onAccept={async () => {
            await source.acceptConsent(today.today.consent.requiredVersion);
            const kind = consentMode.kind;
            setConsentMode(null);
            await load();
            if (kind) setCaptureKind(kind);
          }}
          onWithdraw={async () => {
            await source.withdrawConsent();
            setConsentMode(null);
            await load();
          }}
          onSessionExpired={onSessionExpired}
        />
      ) : null}

      {captureKind ? (
        <CaptureSheet
          kind={captureKind}
          source={source}
          onClose={() => setCaptureKind(null)}
          onSessionExpired={onSessionExpired}
          onDone={(outcome) => {
            setCaptureKind(null);
            setResult(outcome);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

function ConsentSheet({
  mode,
  accepted,
  acceptedAt,
  onClose,
  onAccept,
  onWithdraw,
  onSessionExpired,
}: {
  mode: "gate" | "view";
  accepted: boolean;
  acceptedAt: string | null;
  onClose: () => void;
  onAccept: () => Promise<void>;
  onWithdraw: () => Promise<void>;
  onSessionExpired: (message: string) => void;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        onSessionExpired(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "Không lưu được. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] bg-[#fefbf9] shadow-xl sm:rounded-[28px]">
        <div className="flex items-start gap-3 border-b border-[#eee8e5] px-5 pb-4 pt-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#fdeaf1] text-[#dc4f78]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="consent-title" className="text-[18px] font-bold leading-snug">{CONSENT_TITLE}</h2>
            <p className="mt-0.5 text-xs text-[#85808a]">Bên sử dụng dữ liệu: {CONSENT_CONTROLLER} · Phiên bản 09/11/2026</p>
          </div>
          <button type="button" onClick={onClose} className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#80566a]" aria-label="Đóng">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[14px] leading-6 text-[#3b3536]">
          {mode === "gate" ? (
            <p className="rounded-2xl bg-[#fdeaf1] px-4 py-3 text-[#80566a]">
              Trước khi mở máy ảnh và lấy vị trí, bạn vui lòng đọc và xác nhận thoả thuận dưới đây.
            </p>
          ) : null}
          {CONSENT_SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="font-bold text-[#211d1e]">{section.title}</h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="border-t border-[#eee8e5] px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
          {error ? (
            <p role="alert" className="mb-3 rounded-2xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
          ) : null}
          {accepted ? (
            confirmWithdraw ? (
              <div className="space-y-3">
                <p className="text-sm text-[#3b3536]">
                  Sau khi rút lại, bạn không chấm công bằng điện thoại được nữa. Quản lý sẽ hướng dẫn cách chấm công khác; lương của bạn không bị ảnh hưởng.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" className="h-12 rounded-2xl" onClick={() => setConfirmWithdraw(false)} disabled={busy}>
                    Giữ đồng ý
                  </Button>
                  <Button type="button" variant="destructive" className="h-12 rounded-2xl" onClick={() => void run(onWithdraw)} disabled={busy}>
                    {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Rút lại
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="flex items-center gap-2 text-sm text-emerald-800">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  Bạn đã đồng ý{acceptedAt ? ` lúc ${formatTime(acceptedAt)} ngày ${formatWorkDate(new Date(acceptedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }))}` : ""}.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" className="h-12 rounded-2xl" onClick={onClose}>
                    Đóng
                  </Button>
                  <Button type="button" variant="ghost" className="h-12 rounded-2xl text-red-700 hover:bg-red-50 hover:text-red-700" onClick={() => setConfirmWithdraw(true)}>
                    Rút lại đồng ý
                  </Button>
                </div>
              </div>
            )
          ) : (
            <div className="space-y-3">
              <label className="flex cursor-pointer items-start gap-3 text-sm leading-6 text-[#211d1e]">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) => setChecked(value === true)}
                  className="mt-1 h-5 w-5 rounded-md border-[#dc4f78] data-[state=checked]:bg-[#dc4f78]"
                  aria-label="Xác nhận đồng ý thoả thuận"
                />
                <span>{CONSENT_CHECKBOX}</span>
              </label>
              <Button
                type="button"
                className="h-14 w-full rounded-2xl border-0 text-[18px] font-bold text-white shadow-none hover:brightness-95"
                style={BRAND_GRADIENT}
                disabled={!checked || busy}
                onClick={() => void run(onAccept)}
              >
                {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
                Tôi đồng ý{mode === "gate" ? " và tiếp tục" : ""}
              </Button>
              <Button type="button" variant="ghost" className="h-11 w-full rounded-2xl text-[#4d4850]" onClick={onClose} disabled={busy}>
                Để sau
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PunchTile({ label, icon: Icon, time }: { label: string; icon: typeof LogIn; time: string | null }) {
  return (
    <div className={cn("rounded-[18px] px-4 py-3", time ? "bg-[#fdeaf1]" : "bg-[#f7f3f1]")}>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-[#80566a]">
        <Icon className="h-3.5 w-3.5" /> {label}
      </p>
      <p className={cn("mt-1 text-[26px] font-extrabold tabular-nums leading-none", time ? "text-[#211d1e]" : "text-[#b9b2b4]")}>
        {time ?? "--:--"}
      </p>
    </div>
  );
}

function ResultBanner({ result }: { result: PayrollAttendanceCheckinResult }) {
  const ok = result.decision === "accepted";
  return (
    <div
      role={ok ? "status" : "alert"}
      className={cn(
        "mt-4 flex items-start gap-2 rounded-2xl px-4 py-3 text-sm",
        ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700",
      )}
    >
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{ok ? "Đã ghi nhận chấm công." : result.message}</span>
    </div>
  );
}

type CaptureState = "starting" | "ready" | "sending";

/**
 * Full-screen live camera. Location is requested at the same moment the
 * camera opens (both from the tap), so the photo and the fix belong together.
 * Only a live frame is sent: there is no gallery picker.
 */
function CaptureSheet({
  kind,
  source,
  onClose,
  onDone,
  onSessionExpired,
}: {
  kind: AttendanceEventKind;
  source: PayrollAttendanceSource;
  onClose: () => void;
  onDone: (result: PayrollAttendanceCheckinResult) => void;
  onSessionExpired: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const locationRef = useRef<Promise<GeolocationResult> | null>(null);
  const [state, setState] = useState<CaptureState>("starting");
  const [problem, setProblem] = useState<Problem | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    locationRef.current = getCurrentLocation();

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem({ title: "Trình duyệt không mở được máy ảnh.", detail: "Vui lòng dùng Chrome bản mới trên điện thoại Android hoặc máy tính." });
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setState("ready");
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        setProblem(
          name === "NotAllowedError" || name === "SecurityError"
            ? { title: "Chưa cho phép dùng máy ảnh.", detail: cameraGuidance() }
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? { title: "Không tìm thấy máy ảnh trên thiết bị này." }
              : { title: "Không mở được máy ảnh.", detail: "Hãy đóng các ứng dụng khác đang dùng máy ảnh rồi thử lại." },
        );
      }
    };
    void start();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [stopCamera]);

  const capture = async () => {
    const video = videoRef.current;
    if (!video || state !== "ready") return;
    setState("sending");
    setProblem(null);
    try {
      const selfie = await compressSelfie(video);
      stopCamera();
      const location = await (locationRef.current ?? getCurrentLocation());
      if (location.ok === false) {
        const failure = location as Extract<GeolocationResult, { ok: false }>;
        setProblem({ title: failure.message, detail: failure.guidance || getGeolocationGuidance(navigator.userAgent) });
        setState("ready");
        locationRef.current = getCurrentLocation();
        // Re-open the camera for the retry.
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false }).catch(() => null);
        if (stream && videoRef.current) {
          streamRef.current = stream;
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        return;
      }
      const outcome = await source.checkIn({
        kind,
        latitude: location.point.latitude,
        longitude: location.point.longitude,
        accuracyM: location.point.accuracyM,
        capturedAt: new Date().toISOString(),
        selfie: selfie.blob,
        selfieFileName: "selfie.jpg",
      });
      onDone(outcome);
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        stopCamera();
        onSessionExpired(err.message);
        return;
      }
      setProblem({ title: err instanceof Error ? err.message : "Không gửi được chấm công. Vui lòng thử lại." });
      setState(streamRef.current ? "ready" : "starting");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#14090d] text-white" role="dialog" aria-modal="true" aria-label={kind === "in" ? "Chấm vào" : "Chấm ra"}>
      <div className="flex items-center justify-between px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <p className="text-[17px] font-bold">{kind === "in" ? "Chấm vào" : "Chấm ra"}</p>
        <button
          type="button"
          onClick={() => {
            stopCamera();
            onClose();
          }}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10"
          aria-label="Đóng"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="relative mx-auto flex w-full max-w-md flex-1 items-center justify-center overflow-hidden px-4">
        <div className="relative aspect-[3/4] w-full max-h-full overflow-hidden rounded-[28px] bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="h-full w-full -scale-x-100 object-cover"
          />
          {state === "starting" && !problem ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-white/80" aria-label="Đang mở máy ảnh" />
            </div>
          ) : null}
          <div className="pointer-events-none absolute inset-x-0 top-[12%] mx-auto h-[56%] w-[62%] rounded-[50%] border-2 border-white/60" />
        </div>
      </div>

      <div className="mx-auto w-full max-w-md px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
        {problem ? (
          <div role="alert" className="mb-3 rounded-2xl bg-white px-4 py-3 text-sm text-[#211d1e]">
            <p className="font-semibold text-red-700">{problem.title}</p>
            {problem.detail ? <p className="mt-1 text-[#4f4a4b]">{problem.detail}</p> : null}
          </div>
        ) : (
          <p className="mb-3 text-center text-sm text-white/75">Giữ mặt trong khung, đứng tại nơi làm việc rồi bấm chụp.</p>
        )}
        <Button
          type="button"
          className="h-14 w-full rounded-2xl border-0 text-[19px] font-bold text-white shadow-none hover:brightness-95"
          style={BRAND_GRADIENT}
          disabled={state !== "ready"}
          onClick={() => void capture()}
        >
          {state === "sending" ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Camera className="mr-2 h-5 w-5" />}
          {state === "sending" ? "Đang gửi…" : "Chụp và chấm công"}
        </Button>
      </div>
    </div>
  );
}

export default AttendancePanel;
