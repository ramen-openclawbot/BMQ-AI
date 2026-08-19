import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, LocateFixed, MapPin, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";
import { cn } from "@/lib/utils";

const GEOLOCATION_TIMEOUT_MS = 12000;

type AttendanceUiState =
  | "idle"
  | "locating"
  | "submitting"
  | "accepted"
  | "already_checked_in"
  | "outside_radius"
  | "low_accuracy"
  | "permission_denied"
  | "timeout"
  | "unavailable"
  | "geofence_not_configured"
  | "rate_limited"
  | "retry";

type AttendanceCheckInResponse = {
  success?: boolean;
  status?: "accepted" | "rejected" | string;
  accepted?: boolean;
  already_checked_in?: boolean;
  reason_code?: string;
  checked_in_at?: string | null;
  accepted_at?: string | null;
  created_at?: string | null;
};

type AttendanceCheckInCardProps = {
  reportToken: string;
  actorLabel?: string;
  className?: string;
};

const stateCopy: Record<AttendanceUiState, { title: string; detail: string; tone: "idle" | "busy" | "success" | "warning" | "error" }> = {
  idle: {
    title: "Chấm công hôm nay",
    detail: "Bấm nút bên dưới khi anh/chị đang có mặt tại điểm làm việc.",
    tone: "idle",
  },
  locating: {
    title: "Đang lấy vị trí...",
    detail: "Vui lòng đứng yên vài giây để GPS ổn định.",
    tone: "busy",
  },
  submitting: {
    title: "Đang gửi chấm công...",
    detail: "Hệ thống đang kiểm tra vị trí trong phạm vi cho phép.",
    tone: "busy",
  },
  accepted: {
    title: "Đã chấm công hôm nay – 1 ngày công",
    detail: "Chấm công đã được ghi nhận.",
    tone: "success",
  },
  already_checked_in: {
    title: "Anh/chị đã chấm công hôm nay rồi",
    detail: "Mỗi ngày chỉ cần chấm công một lần.",
    tone: "success",
  },
  outside_radius: {
    title: "Bạn đang ở ngoài phạm vi chấm công",
    detail: "Vui lòng về đúng điểm làm việc rồi thử lại.",
    tone: "warning",
  },
  low_accuracy: {
    title: "GPS chưa đủ chính xác",
    detail: "Hãy ra gần khu vực thoáng hơn, bật Wi‑Fi/GPS rồi thử lại.",
    tone: "warning",
  },
  permission_denied: {
    title: "Chưa cấp quyền vị trí hoặc GPS đang tắt",
    detail: "Hãy bật quyền vị trí cho trình duyệt rồi thử lại.",
    tone: "error",
  },
  timeout: {
    title: "Định vị quá lâu",
    detail: "Hãy kiểm tra GPS/mạng và thử lại sau vài giây.",
    tone: "warning",
  },
  unavailable: {
    title: "Chưa lấy được vị trí",
    detail: "Hãy bật GPS, kiểm tra kết nối mạng rồi thử lại.",
    tone: "warning",
  },
  geofence_not_configured: {
    title: "Cấu hình điểm chấm công chưa sẵn sàng",
    detail: "Vui lòng báo quản lý BMQ để kiểm tra điểm chấm công.",
    tone: "error",
  },
  rate_limited: {
    title: "Thao tác quá nhanh",
    detail: "Vui lòng chờ một lát rồi thử lại.",
    tone: "warning",
  },
  retry: {
    title: "Chưa chấm công được",
    detail: "Vui lòng thử lại. Nếu vẫn lỗi, báo quản lý BMQ.",
    tone: "error",
  },
};

const embeddedBrowserPattern = /zalo|fbav|fban|fb_iab|instagram|line\//i;

const isLikelyEmbeddedBrowser = () => {
  if (typeof navigator === "undefined") return false;
  return embeddedBrowserPattern.test(navigator.userAgent || "");
};

const formatVietnamTime = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
};

const stateFromReasonCode = (reasonCode?: string, accepted?: boolean, alreadyCheckedIn?: boolean): AttendanceUiState => {
  if (alreadyCheckedIn || reasonCode === "already_checked_in") return "already_checked_in";
  if (accepted) return "accepted";
  if (reasonCode === "outside_geofence") return "outside_radius";
  if (reasonCode === "accuracy_too_low") return "low_accuracy";
  if (reasonCode === "attendance_geofence_not_configured" || reasonCode === "geofence_coordinates_missing") return "geofence_not_configured";
  if (reasonCode === "rate_limited" || reasonCode === "too_many_requests") return "rate_limited";
  if (reasonCode === "report_session_required" || reasonCode === "report_session_invalid") return "retry";
  return "retry";
};

export function AttendanceCheckInCard({ reportToken, actorLabel = "Nhân viên", className }: AttendanceCheckInCardProps) {
  const [state, setState] = useState<AttendanceUiState>("idle");
  const [checkedInTime, setCheckedInTime] = useState("");
  const mountedRef = useRef(false);
  const latestReportTokenRef = useRef(reportToken);
  const requestIdRef = useRef(0);
  const likelyEmbeddedBrowser = useMemo(isLikelyEmbeddedBrowser, []);
  const copy = stateCopy[state];
  const busy = state === "locating" || state === "submitting";
  const shouldSuggestExternalBrowser = likelyEmbeddedBrowser && ["permission_denied", "unavailable", "timeout"].includes(state);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      latestReportTokenRef.current = "";
      requestIdRef.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    latestReportTokenRef.current = reportToken;
    return () => {
      latestReportTokenRef.current = "";
      requestIdRef.current += 1;
    };
  }, [reportToken]);

  const isActiveRequest = (requestId: number, capturedReportToken: string) =>
    mountedRef.current &&
    requestIdRef.current === requestId &&
    latestReportTokenRef.current === capturedReportToken;

  const handleCheckIn = () => {
    if (!reportToken || busy) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState("unavailable");
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const capturedReportToken = reportToken;
    setCheckedInTime("");
    setState("locating");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (!isActiveRequest(requestId, capturedReportToken)) return;
        const capturedAt = Number.isFinite(position.timestamp)
          ? new Date(position.timestamp).toISOString()
          : new Date().toISOString();
        setState("submitting");
        const response = await callEdgeFunction<AttendanceCheckInResponse>("attendance-check-in", {
          report_token: capturedReportToken,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          captured_at: capturedAt,
        }, undefined, 15000);

        if (!isActiveRequest(requestId, capturedReportToken)) return;

        if (response.isSessionExpired) {
          setState("retry");
          return;
        }

        const reasonCode = response.isRateLimited
          ? "rate_limited"
          : response.error === "Cấu hình vị trí chấm công chưa sẵn sàng."
            ? "attendance_geofence_not_configured"
            : response.data?.reason_code;
        const nextState = response.error
          ? stateFromReasonCode(reasonCode, false, false)
          : stateFromReasonCode(reasonCode, response.data?.accepted, response.data?.already_checked_in);
        setState(nextState);
        if (nextState === "accepted" || nextState === "already_checked_in") {
          setCheckedInTime(formatVietnamTime(response.data?.checked_in_at || response.data?.accepted_at || response.data?.created_at || capturedAt));
        }
      },
      (error) => {
        if (!isActiveRequest(requestId, capturedReportToken)) return;
        if (error.code === error.PERMISSION_DENIED) {
          setState("permission_denied");
        } else if (error.code === error.TIMEOUT) {
          setState("timeout");
        } else {
          setState("unavailable");
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: GEOLOCATION_TIMEOUT_MS,
      },
    );
  };

  const Icon = copy.tone === "success" ? CheckCircle2 : copy.tone === "busy" ? Loader2 : copy.tone === "idle" ? MapPin : TriangleAlert;

  return (
    <section
      data-testid="attendance-check-in-card"
      className={cn(
        "rounded-[20px] border bg-white p-4 shadow-[0_8px_22px_rgba(86,48,63,0.07)] sm:p-5",
        copy.tone === "success" ? "border-emerald-200" : copy.tone === "error" ? "border-[#ffc3d1]" : "border-[#f0dfe5]",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
          copy.tone === "success" ? "bg-emerald-50 text-emerald-600" : copy.tone === "error" ? "bg-[#fff2f6] text-[#b93667]" : "bg-[#fdeaf1] text-[#ec5b91]",
        )}>
          <Icon className={cn("h-6 w-6", copy.tone === "busy" && "animate-spin")} strokeWidth={2.1} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-[#9b5d73]">Chấm công GPS • {actorLabel}</div>
          <div aria-live="polite" role="status" className="mt-1 text-[19px] font-extrabold leading-tight text-[#20212d]">
            {copy.title}{checkedInTime ? ` lúc ${checkedInTime}` : ""}
          </div>
          <p className="mt-1.5 text-sm leading-6 text-[#5f5960]">{copy.detail}</p>
          {shouldSuggestExternalBrowser && (
            <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
              Nếu đang mở trong Zalo/Facebook, chọn Mở bằng Safari hoặc Chrome rồi thử lại.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-2xl bg-[#fff8fa] px-3 py-2.5 text-sm leading-6 text-[#80566a]">
        <ShieldCheck className="mr-1.5 inline h-4 w-4 align-text-bottom text-[#ec5b91]" />
        Vị trí chỉ dùng để xác nhận anh/chị đang ở đúng điểm làm việc khi chấm công, không theo dõi nền. Trình duyệt có thể báo vị trí sai nếu GPS/Wi‑Fi yếu hoặc thiết bị bị can thiệp; BMQ chỉ ghi nhận kết quả chấm công và thông tin cần thiết để xử lý khiếu nại.
      </div>

      <Button
        type="button"
        onClick={handleCheckIn}
        disabled={busy || !reportToken}
        className="mt-4 h-12 min-h-[44px] w-full rounded-2xl border-0 bg-[#e9568d] text-[17px] font-bold text-white shadow-none hover:bg-[#d9477d] disabled:opacity-70"
      >
        {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : state === "retry" ? <RefreshCw className="mr-2 h-5 w-5" /> : <LocateFixed className="mr-2 h-5 w-5" />}
        {busy ? (state === "locating" ? "Đang lấy vị trí" : "Đang gửi") : "Chấm công hôm nay"}
      </Button>
    </section>
  );
}

export default AttendanceCheckInCard;
