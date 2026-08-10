import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Box,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Clock3,
  Cookie,
  Flame,
  LayoutDashboard,
  Loader2,
  LogOut,
  MapPin,
  Package,
  PackageOpen,
  Phone,
  Save,
  Send,
  Settings,
  ShieldCheck,
  Store,
  UserRound,
  Wheat,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";
import {
  calculateKioskChannelAmount,
  calculateEffectiveConsumedQuantity,
  calculateInventoryClosing,
  isNegativeInventoryClosing,
  isRetailSaleAllowed,
} from "@/lib/kiosk-report-inventory";
import { cn } from "@/lib/utils";

const REPORT_SESSION_STORAGE_KEY = "bmq_report_session_token";
const SAFE_SAVE_ERROR_MESSAGES = new Set([
  "Vui lòng gửi báo cáo ngày trước trước khi gửi ngày này.",
  "Không thể gửi báo cáo cũ hơn một báo cáo đã gửi.",
  "Tồn cuối không được âm. Vui lòng kiểm tra tồn đầu, nhập hoặc điều chuyển trước khi gửi.",
]);

const DEFAULT_PRODUCTS = [
  { code: "banh_mi_que", product_name: "Bánh mì que", unit: "que", sale_allowed: true, breadstick_consumption_ratio: 0 },
  { code: "pate", product_name: "Pate", unit: "hộp", sale_allowed: false, breadstick_consumption_ratio: 1 / 20 },
  { code: "ot", product_name: "Ớt", unit: "phần", sale_allowed: false, breadstick_consumption_ratio: 0 },
  { code: "banh_mi_say", product_name: "Bánh mì sấy", unit: "gói", sale_allowed: true, breadstick_consumption_ratio: 0 },
];

const DEFAULT_CHANNELS = [
  { code: "khach_le", channel_name: "Khách lẻ" },
  { code: "shopeefood", channel_name: "ShopeeFood" },
  { code: "grabfood", channel_name: "GrabFood" },
  { code: "befood", channel_name: "beFood" },
];

type ReportProduct = {
  code: string;
  product_name: string;
  unit?: string | null;
  sale_allowed?: boolean | null;
  breadstick_consumption_ratio?: number | null;
};

type ReportChannel = {
  code: string;
  channel_name: string;
};

type InventoryRow = {
  product_code: string;
  product_name_snapshot: string;
  opening_quantity: number;
  received_quantity: number;
  shortage_quantity: number;
  transfer_quantity: number;
  waste_quantity: number;
  returns_quantity: number;
  sold_quantity: number;
  consumed_quantity?: number;
  opening_reconciliation_required?: boolean;
  notes?: string | null;
};

type ChannelRow = {
  channel_code: string;
  channel_name_snapshot: string;
  quantity: number;
  amount_vnd: number;
  notes?: string | null;
};

type PublicStaff = {
  full_name?: string | null;
};

type PublicLocation = {
  code?: string | null;
  name?: string | null;
  address?: string | null;
};

type OpeningInventoryRow = Pick<InventoryRow, "product_code" | "opening_quantity" | "opening_reconciliation_required">;

type BootstrapResponse = {
  success?: boolean;
  report_date?: string;
  staff?: PublicStaff | null;
  location?: PublicLocation | null;
  products?: ReportProduct[];
  channels?: ReportChannel[];
  opening_inventory_rows?: OpeningInventoryRow[];
  opening_source_report_date?: string | null;
  report?: {
    report_date?: string | null;
    status?: "draft" | "submitted" | string;
    notes?: string | null;
    submitted_at?: string | null;
    updated_at?: string | null;
    opening_source_report_date?: string | null;
    inventory_rows?: InventoryRow[];
    channel_rows?: ChannelRow[];
  } | null;
};

type AuthStartResponse = {
  success?: boolean;
  otp_required?: boolean;
  message?: string;
  retry_after_seconds?: number;
};

type AuthVerifyResponse = {
  success?: boolean;
  report_token?: string;
  expires_at?: string;
  staff?: PublicStaff | null;
  location?: PublicLocation | null;
};

const vietnamToday = () => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
};

const numberValue = (value: unknown) => {
  const next = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(next) ? next : 0;
};

const formatVnd = (value: number) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value);

const formatReportDate = (value: string) => {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
};

const getInitials = (name?: string | null) => {
  const words = String(name || "Nhân viên").trim().split(/\s+/).filter(Boolean);
  return words.slice(-2).map((word) => word[0]?.toUpperCase()).join("") || "NV";
};

const createInventoryRows = (products: ReportProduct[]): InventoryRow[] =>
  products.map((product) => ({
    product_code: product.code,
    product_name_snapshot: product.product_name,
    opening_quantity: 0,
    received_quantity: 0,
    shortage_quantity: 0,
    transfer_quantity: 0,
    waste_quantity: 0,
    returns_quantity: 0,
    sold_quantity: 0,
    consumed_quantity: 0,
    notes: "",
  }));

const createChannelRows = (channels: ReportChannel[]): ChannelRow[] =>
  channels.map((channel) => ({
    channel_code: channel.code,
    channel_name_snapshot: channel.channel_name,
    quantity: 0,
    amount_vnd: 0,
    notes: "",
  }));

const calcClosing = (row: InventoryRow, consumedQuantity = 0) => calculateInventoryClosing({
  openingQuantity: numberValue(row.opening_quantity),
  receivedQuantity: numberValue(row.received_quantity),
  shortageQuantity: numberValue(row.shortage_quantity),
  transferQuantity: numberValue(row.transfer_quantity),
  wasteQuantity: numberValue(row.waste_quantity),
  returnsQuantity: numberValue(row.returns_quantity),
  soldQuantity: numberValue(row.sold_quantity),
}, consumedQuantity);

const hasNegativeClosing = (row: InventoryRow, consumedQuantity = 0) => isNegativeInventoryClosing({
  openingQuantity: numberValue(row.opening_quantity),
  receivedQuantity: numberValue(row.received_quantity),
  shortageQuantity: numberValue(row.shortage_quantity),
  transferQuantity: numberValue(row.transfer_quantity),
  wasteQuantity: numberValue(row.waste_quantity),
  returnsQuantity: numberValue(row.returns_quantity),
  soldQuantity: numberValue(row.sold_quantity),
}, consumedQuantity);

const normalizeProducts = (products: ReportProduct[]) => products.map((product) => {
  const fallback = DEFAULT_PRODUCTS.find((candidate) => candidate.code === product.code);
  return {
    ...fallback,
    ...product,
    sale_allowed: product.sale_allowed ?? fallback?.sale_allowed ?? true,
    breadstick_consumption_ratio: product.breadstick_consumption_ratio ?? fallback?.breadstick_consumption_ratio ?? 0,
  };
});

const mergeInventoryRows = (
  products: ReportProduct[],
  rows: Array<Partial<InventoryRow> & Pick<InventoryRow, "product_code">> = [],
) => {
  const byCode = new Map(rows.map((row) => [row.product_code, row]));
  return products.map((product) => ({
    ...createInventoryRows([product])[0],
    ...(byCode.get(product.code) || {}),
    product_code: product.code,
    product_name_snapshot: product.product_name,
  }));
};

const mergeChannelRows = (channels: ReportChannel[], rows: ChannelRow[] = []) => {
  const byCode = new Map(rows.map((row) => [row.channel_code, row]));
  return channels.map((channel) => {
    const merged = {
      ...createChannelRows([channel])[0],
      ...(byCode.get(channel.code) || {}),
      channel_code: channel.code,
      channel_name_snapshot: channel.channel_name,
    };
    return {
      ...merged,
      amount_vnd: calculateKioskChannelAmount(channel.code, merged.quantity, merged.amount_vnd),
    };
  });
};

export default function KioskReportPortal() {
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"phone" | "otp" | "report">("phone");
  const [reportToken, setReportToken] = useState(() => localStorage.getItem(REPORT_SESSION_STORAGE_KEY) || "");
  const [reportDate, setReportDate] = useState(vietnamToday);
  const [staff, setStaff] = useState<PublicStaff | null>(null);
  const [location, setLocation] = useState<PublicLocation | null>(null);
  const [products, setProducts] = useState<ReportProduct[]>(DEFAULT_PRODUCTS);
  const [channels, setChannels] = useState<ReportChannel[]>(DEFAULT_CHANNELS);
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>(() => createInventoryRows(DEFAULT_PRODUCTS));
  const [channelRows, setChannelRows] = useState<ChannelRow[]>(() => createChannelRows(DEFAULT_CHANNELS));
  const [notes, setNotes] = useState("");
  const [reportStatus, setReportStatus] = useState<"draft" | "submitted">("draft");
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
  const [openingLocked, setOpeningLocked] = useState(false);
  const [openingSourceReportDate, setOpeningSourceReportDate] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(Boolean(reportToken));
  const [expandedProductCode, setExpandedProductCode] = useState<string | null>("banh_mi_que");

  const isSubmitted = reportStatus === "submitted";
  const totalAmount = useMemo(
    () => channelRows.reduce((sum, row) => sum + numberValue(row.amount_vnd), 0),
    [channelRows],
  );
  const totalQuantity = useMemo(
    () => channelRows.reduce((sum, row) => sum + numberValue(row.quantity), 0),
    [channelRows],
  );
  const productByCode = useMemo(
    () => new Map(products.map((product) => [product.code, product])),
    [products],
  );
  const breadstickSoldQuantity = numberValue(
    inventoryRows.find((row) => row.product_code === "banh_mi_que")?.sold_quantity,
  );

  const hydrateBootstrap = useCallback((payload: BootstrapResponse) => {
    const nextProducts = normalizeProducts(payload.products?.length ? payload.products : DEFAULT_PRODUCTS);
    const nextChannels = payload.channels?.length ? payload.channels : DEFAULT_CHANNELS;
    setProducts(nextProducts);
    setChannels(nextChannels);
    setStaff(payload.staff || null);
    setLocation(payload.location || null);
    setReportDate(payload.report?.report_date || payload.report_date || vietnamToday());
    setReportStatus(payload.report?.status === "submitted" ? "submitted" : "draft");
    setSubmittedAt(payload.report?.submitted_at || null);
    setNotes(payload.report?.notes || "");
    const openingSourceDate = payload.report?.opening_source_report_date || payload.opening_source_report_date || null;
    setOpeningSourceReportDate(openingSourceDate);
    setOpeningLocked(Boolean(payload.report || openingSourceDate));
    setInventoryRows(mergeInventoryRows(
      nextProducts,
      payload.report?.inventory_rows || payload.opening_inventory_rows || [],
    ));
    setChannelRows(mergeChannelRows(nextChannels, payload.report?.channel_rows || []));
  }, []);

  const loadReport = useCallback(async (token: string, date: string) => {
    if (!token) return;
    setBootstrapping(true);
    setErrorMessage("");
    const sessionResult = await callEdgeFunction<{ success?: boolean }>("report-session", { report_token: token }, undefined, 30000);
    if (sessionResult.error) {
      localStorage.removeItem(REPORT_SESSION_STORAGE_KEY);
      setReportToken("");
      setStep("phone");
      setErrorMessage("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
      setBootstrapping(false);
      return;
    }

    const bootstrapResult = await callEdgeFunction<BootstrapResponse>(
      "report-bootstrap",
      { report_token: token, report_date: date },
      undefined,
      30000,
    );
    if (bootstrapResult.error || !bootstrapResult.data) {
      setErrorMessage("Chưa tải được báo cáo. Vui lòng thử lại.");
      setBootstrapping(false);
      return;
    }
    hydrateBootstrap(bootstrapResult.data);
    setStep("report");
    setStatusMessage("");
    setBootstrapping(false);
  }, [hydrateBootstrap]);

  useEffect(() => {
    if (reportToken) {
      void loadReport(reportToken, reportDate);
    } else {
      setBootstrapping(false);
    }
  }, [loadReport, reportDate, reportToken]);

  const startAuth = async () => {
    setLoading(true);
    setErrorMessage("");
    setStatusMessage("");
    const result = await callEdgeFunction<AuthStartResponse>("report-auth-start", { phone }, undefined, 30000);
    setLoading(false);

    if (result.error || !result.data) {
      setErrorMessage("Chưa gửi được mã OTP. Vui lòng thử lại.");
      return;
    }

    if (result.data.otp_required === false) return;
    setOtp("");
    setStep("otp");
  };

  const verifyOtp = async () => {
    setLoading(true);
    setErrorMessage("");
    const result = await callEdgeFunction<AuthVerifyResponse>("report-auth-verify", { phone, otp }, undefined, 30000);
    setLoading(false);

    if (result.error || !result.data?.report_token) {
      setErrorMessage("Mã OTP không đúng hoặc đã hết hạn.");
      return;
    }

    localStorage.setItem(REPORT_SESSION_STORAGE_KEY, result.data.report_token);
    setReportToken(result.data.report_token);
    setStaff(result.data.staff || null);
    setLocation(result.data.location || null);
    setStatusMessage("Đã xác thực. Anh/chị có thể nhập báo cáo.");
    await loadReport(result.data.report_token, reportDate);
  };

  const saveReport = async (status: "draft" | "submitted") => {
    if (!reportToken || isSubmitted) return;
    if (status === "submitted") {
      const negativeRow = inventoryRows.find((row) => {
        const consumedQuantity = calculateEffectiveConsumedQuantity(
          productByCode.get(row.product_code),
          breadstickSoldQuantity,
          numberValue(row.consumed_quantity),
        );
        return hasNegativeClosing(row, consumedQuantity);
      });
      if (negativeRow) {
        setExpandedProductCode(negativeRow.product_code);
        setErrorMessage("Tồn cuối không được âm. Vui lòng kiểm tra tồn đầu, nhập hoặc điều chuyển trước khi gửi.");
        setStatusMessage("");
        window.setTimeout(() => {
          document
            .querySelector(`[data-kiosk-inventory-product="${negativeRow.product_code}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 0);
        return;
      }
    }
    setLoading(true);
    setErrorMessage("");
    setStatusMessage(status === "submitted" ? "Đang gửi báo cáo..." : "Đang lưu nháp...");
    const result = await callEdgeFunction<BootstrapResponse>(
      "report-daily-save",
      {
        report_token: reportToken,
        report_date: reportDate,
        status,
        notes,
        inventory_rows: inventoryRows.map((row) => ({
          ...row,
          sold_quantity: isRetailSaleAllowed(productByCode.get(row.product_code)) ? row.sold_quantity : 0,
        })),
        channel_rows: channelRows.map((row) => ({
          ...row,
          amount_vnd: calculateKioskChannelAmount(row.channel_code, row.quantity, row.amount_vnd),
        })),
      },
      undefined,
      30000,
    );
    setLoading(false);

    if (result.error) {
      setErrorMessage(
        SAFE_SAVE_ERROR_MESSAGES.has(result.error)
          ? result.error
          : "Chưa lưu được báo cáo. Vui lòng thử lại.",
      );
      setStatusMessage("");
      return;
    }

    setStatusMessage(status === "submitted" ? "Đã gửi báo cáo. Báo cáo đã khóa chỉnh sửa." : "Đã lưu nháp.");
    await loadReport(reportToken, reportDate);
  };

  const logout = async () => {
    if (reportToken) {
      await callEdgeFunction("report-auth-logout", { report_token: reportToken }, undefined, 15000);
    }
    localStorage.removeItem(REPORT_SESSION_STORAGE_KEY);
    setReportToken("");
    setStep("phone");
    setOtp("");
    setStatusMessage("");
    setErrorMessage("");
  };

  const updateInventoryRow = (productCode: string, field: keyof InventoryRow, value: string) => {
    setInventoryRows((current) =>
      current.map((row) => row.product_code === productCode ? { ...row, [field]: field === "notes" ? value : numberValue(value) } : row),
    );
  };

  const updateChannelRow = (channelCode: string, field: keyof ChannelRow, value: string) => {
    setChannelRows((current) =>
      current.map((row) => {
        if (row.channel_code !== channelCode) return row;
        const next = { ...row, [field]: field === "notes" ? value : numberValue(value) };
        return {
          ...next,
          amount_vnd: calculateKioskChannelAmount(next.channel_code, next.quantity, next.amount_vnd),
        };
      }),
    );
  };

  if (bootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#fff8fa] text-[#20212d]">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Đang tải báo cáo...
      </div>
    );
  }

  if (step !== "report") {
    return (
      <main className="min-h-screen bg-[#fefbf9] px-5 text-[#211d1e]">
        <section className="mx-auto flex min-h-screen max-w-md flex-col pb-7 pt-9 sm:pt-12">
          <div className="flex justify-center">
            <img
              src="/assets/brand/bmq-logo-master-1024.png"
              alt="BMQ - Bánh Mì Que Pháp"
              className="h-auto w-[130px] object-contain sm:w-[145px]"
            />
          </div>
          <div className="mb-8 mt-8 text-center">
            <h1 className="text-[40px] font-bold leading-[1.08] tracking-[-0.025em]">Báo cáo bán hàng</h1>
            <p className="mt-3 text-[18px] leading-7 text-[#666263]">Dành cho nhân viên điểm bán BMQ</p>
          </div>

          <div className="rounded-[28px] bg-white px-6 py-7 shadow-[0_12px_28px_rgba(70,50,55,0.10)] ring-1 ring-[#eee8e5]">

            {step === "phone" ? (
              <div className="space-y-6">
                <div className="space-y-3">
                  <Label htmlFor="report-phone" className="text-[18px] font-bold text-[#211d1e]">Số điện thoại</Label>
                  <div className="relative">
                    <Phone className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 fill-[#dc4f78] text-[#dc4f78]" />
                    <Input
                      id="report-phone"
                      inputMode="tel"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      placeholder="09xx xxx xxx"
                      className="h-14 rounded-2xl border-[#ef8caf] bg-white pl-12 text-[17px] shadow-none placeholder:text-[#aaa7a8] focus-visible:ring-[#dc4f78]"
                    />
                  </div>
                </div>
                <Button
                  className="h-14 w-full rounded-2xl border-0 text-[20px] font-bold text-white shadow-none hover:brightness-95"
                  style={{ background: "linear-gradient(90deg, #dc4f78 0%, #dc527a 100%)" }}
                  onClick={startAuth}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
                  Nhận mã OTP qua Zalo
                </Button>
                <div className="flex items-center justify-center gap-3 text-[14px] text-[#4f4a4b]">
                  <ShieldCheck className="h-6 w-6 shrink-0 text-[#dc4f78]" strokeWidth={1.8} />
                  <span>Mã xác thực được gửi qua Zalo</span>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="space-y-2 text-center">
                  <Label>Nhập mã OTP</Label>
                  <div className="flex justify-center">
                    <InputOTP value={otp} onChange={setOtp} maxLength={6}>
                      <InputOTPGroup>
                        {Array.from({ length: 6 }).map((_, index) => (
                          <InputOTPSlot key={index} index={index} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                </div>
                <Button
                  className="h-14 w-full rounded-2xl border-0 text-[20px] font-bold text-white shadow-none hover:brightness-95"
                  style={{ background: "linear-gradient(90deg, #dc4f78 0%, #dc527a 100%)" }}
                  onClick={verifyOtp}
                  disabled={loading || otp.length !== 6}
                >
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Xác thực OTP
                </Button>
                <Button variant="ghost" className="w-full" onClick={() => setStep("phone")}>
                  Đổi số điện thoại
                </Button>
              </div>
            )}

            {statusMessage && (
              <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {statusMessage}
              </div>
            )}
            {errorMessage && (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {errorMessage}
              </div>
            )}
          </div>
          <p className="mt-12 text-center text-[14px] leading-6 text-[#666263] min-[375px]:whitespace-nowrap">
            Số điện thoại chưa được kích hoạt?{" "}
            <a href="mailto:ramen@bmq.vn" className="font-medium text-[#dc4f78] underline underline-offset-4">
              Liên hệ quản lý BMQ
            </a>
          </p>
          <p className="mt-auto pt-12 text-center text-[14px] text-[#8a8687]">© 2026 Bánh Mì Que Pháp BMQ</p>
        </section>
      </main>
    );
  }

  return (
    <main data-testid="report-shell" data-hallmark="compact-operational" className="min-h-screen bg-[#fff8fa] text-[#20212d] lg:pl-[238px]">
      <ReportSidebar staffName={staff?.full_name} onLogout={logout} />

      <div className="mx-auto min-h-screen max-w-[1440px] px-3.5 pb-24 pt-3.5 min-[375px]:px-4 sm:px-6 lg:px-8 lg:pb-8 lg:pt-6 xl:px-10">
        <header className="mb-3.5 lg:mb-5">
          <div className="grid grid-cols-[88px_minmax(0,1fr)_44px] items-start gap-2 lg:hidden">
            <img
              src="/assets/brand/bmq-logo-master-1024.png"
              alt="BMQ"
              className="row-span-2 h-auto w-[88px] shrink-0 object-contain"
            />
            <div className="min-w-0 pt-1">
              <h1 className="whitespace-nowrap text-[23px] font-extrabold leading-tight tracking-[-0.025em]">Báo cáo ngày</h1>
            </div>
            <button
              type="button"
              onClick={logout}
              aria-label="Đăng xuất"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#ec5b91] text-base font-bold text-white shadow-sm"
            >
              {getInitials(staff?.full_name)}
            </button>
            <div className="col-span-2 col-start-2 row-start-2 inline-flex max-w-full items-center gap-1 justify-self-start rounded-lg bg-[#fdeaf1] px-2.5 py-1 text-xs font-medium text-[#b93667]">
              <MapPin className="h-4 w-4 shrink-0 fill-[#ec5b91] text-[#ec5b91]" />
              <span className="truncate">{location?.name || "Điểm bán BMQ"}</span>
            </div>
          </div>

          <div className="hidden items-center justify-between gap-6 lg:flex">
            <div>
              <h1 className="text-[30px] font-extrabold tracking-[-0.02em]">Báo cáo ngày</h1>
              <p className="mt-1 text-sm text-[#74717a]">Nhập và gửi báo cáo vận hành tại điểm bán</p>
            </div>
            <div className="flex items-center gap-3">
              <div aria-label="Thông tin nhân viên" className="flex items-center gap-3 rounded-2xl border border-[#eadfe3] bg-white px-3 py-2 shadow-[0_8px_24px_rgba(78,44,58,0.06)]">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-[#f7a4c1] to-[#e96998] text-sm font-bold text-white">
                  {getInitials(staff?.full_name)}
                </div>
                <div className="max-w-[220px]">
                  <div className="truncate text-sm font-semibold">{staff?.full_name || "Nhân viên"}</div>
                  <div className="truncate text-xs text-[#85808a]">{location?.name || "Điểm bán BMQ"}</div>
                </div>
              </div>
              <Button variant="outline" className="h-12 rounded-2xl border-[#eadfe3] bg-white px-4 text-[#4d4850]" onClick={logout}>
                <LogOut className="mr-2 h-4 w-4" />
                Đăng xuất
              </Button>
            </div>
          </div>
        </header>

        <section className="relative mb-4 flex min-h-[68px] items-center justify-between gap-3 overflow-hidden rounded-[18px] border border-[#f0dfe5] bg-white px-3.5 py-3 shadow-[0_6px_18px_rgba(86,48,63,0.07)] sm:px-5">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <CalendarDays className="h-6 w-6 shrink-0 text-[#ec5b91]" strokeWidth={2.2} />
            <div className="relative">
              <span className="text-[18px] font-extrabold sm:text-[20px]">{formatReportDate(reportDate)}</span>
              <Input
                aria-label="Ngày báo cáo"
                type="date"
                value={reportDate}
                onChange={(event) => setReportDate(event.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </div>
          </div>
          <div className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-semibold sm:px-3 sm:text-sm",
            isSubmitted
              ? "border-[#bfead0] bg-[#edfbf2] text-[#28995a]"
              : "border-[#ffd5a6] bg-[#fff7eb] text-[#f28a24]",
          )}>
            {isSubmitted ? <CheckCircle2 className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}
            {isSubmitted ? "Đã gửi" : "Chưa gửi"}
          </div>
        </section>

        {isSubmitted && (
          <div className="mb-4 rounded-2xl border border-[#bfead0] bg-[#edfbf2] px-4 py-3 text-sm text-[#247d4b]">
            <CheckCircle2 className="mr-2 inline h-4 w-4 align-text-bottom" />
            Báo cáo ngày này đã gửi{submittedAt ? ` lúc ${new Date(submittedAt).toLocaleString("vi-VN")}` : ""} và đã khóa chỉnh sửa.
          </div>
        )}

        {errorMessage && (
          <div className="mb-4 rounded-2xl border border-[#ffc3d1] bg-[#fff2f6] px-4 py-3 text-sm text-[#b93667]">
            <AlertTriangle className="mr-2 inline h-4 w-4 align-text-bottom" />
            {errorMessage}
          </div>
        )}

        {statusMessage && !errorMessage && (
          <div className="mb-4 rounded-2xl border border-[#f0dfe5] bg-white px-4 py-3 text-sm text-[#69636b]">
            {statusMessage}
          </div>
        )}

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.22fr)_minmax(390px,0.78fr)]">
          <section
            data-testid="inventory-section"
            className="overflow-hidden rounded-[20px] border border-[#f0dfe5] bg-white p-3.5 shadow-[0_8px_22px_rgba(86,48,63,0.07)] sm:p-5"
          >
            <SectionTitle icon={Box} title="Tồn kho & luân chuyển" />
            {openingSourceReportDate && (
              <div className="mt-3 rounded-xl border border-[#f2d5df] bg-[#fff8fa] px-3 py-2 text-xs font-medium text-[#80566a] sm:text-sm">
                Tồn đầu được chuyển tự động từ tồn cuối ngày {formatReportDate(openingSourceReportDate)}.
              </div>
            )}
            <div data-testid="inventory-ledger" className="mt-3 divide-y divide-[#f2e5e9] border-y border-[#f2e5e9]">
              {inventoryRows.map((row) => {
                const expanded = expandedProductCode === row.product_code;
                const product = productByCode.get(row.product_code);
                const consumedQuantity = isSubmitted
                  ? numberValue(row.consumed_quantity)
                  : calculateEffectiveConsumedQuantity(product, breadstickSoldQuantity, numberValue(row.consumed_quantity));
                const closingQuantity = calcClosing(row, consumedQuantity);
                const saleAllowed = isRetailSaleAllowed(product);
                return (
                  <div key={row.product_code} data-kiosk-inventory-product={row.product_code} className="bg-white">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpandedProductCode(expanded ? null : row.product_code)}
                      className="flex w-full items-center gap-2.5 px-1 py-2.5 text-left transition-colors hover:bg-[#fff9fb] sm:gap-3 sm:px-2"
                    >
                      <ProductIcon code={row.product_code} />
                      <span className="min-w-0 flex-1 truncate text-[16px] font-bold sm:text-[17px]">{row.product_name_snapshot}</span>
                      {!expanded && (
                        <div className="hidden items-center gap-2 lg:flex">
                          <MetricPill label="Tồn đầu" value={row.opening_quantity} />
                          <MetricPill label="Nhập" value={row.received_quantity} />
                          {consumedQuantity > 0 && <MetricPill label="Tiêu hao" value={consumedQuantity} />}
                          <MetricPill label="Tồn cuối" value={closingQuantity} />
                        </div>
                      )}
                      {expanded
                        ? <ChevronUp className="h-5 w-5 shrink-0 text-[#ec5b91]" />
                        : <ChevronDown className="h-5 w-5 shrink-0 text-[#ec5b91]" />}
                    </button>

                    {!expanded && (
                      <div className="flex flex-wrap gap-1.5 px-1 pb-2.5 lg:hidden">
                        <MetricPill label="Tồn đầu" value={row.opening_quantity} />
                        <MetricPill label="Nhập" value={row.received_quantity} />
                        {consumedQuantity > 0 && <MetricPill label="Tiêu hao" value={consumedQuantity} />}
                        <MetricPill label="Tồn cuối" value={closingQuantity} />
                      </div>
                    )}

                    {expanded && (
                      <div className="px-1 pb-3 pt-1 sm:px-2 sm:pb-4">
                        <div className="grid grid-cols-2 gap-x-2.5 gap-y-2.5 min-[360px]:grid-cols-3 sm:grid-cols-4 sm:gap-x-3">
                          <ReportNumberField label="Tồn đầu" value={row.opening_quantity} disabled={isSubmitted || (openingLocked && !row.opening_reconciliation_required)} onChange={(value) => updateInventoryRow(row.product_code, "opening_quantity", value)} />
                          <ReportNumberField label="Nhập" value={row.received_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "received_quantity", value)} />
                          <ReportNumberField label="Thiếu" value={row.shortage_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "shortage_quantity", value)} />
                          <ReportNumberField label="Điều chuyển" value={row.transfer_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "transfer_quantity", value)} />
                          <ReportNumberField label="Hủy" value={row.waste_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "waste_quantity", value)} />
                          <ReportNumberField label="Đổi trả" value={row.returns_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "returns_quantity", value)} />
                          {saleAllowed && (
                            <ReportNumberField label="Đã bán" value={row.sold_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "sold_quantity", value)} />
                          )}
                          {row.product_code === "ot" && (
                            <ReportNumberField label="Ớt sử dụng" value={row.consumed_quantity || 0} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "consumed_quantity", value)} />
                          )}
                        </div>
                        {!saleAllowed && (
                          <div className="mt-3 rounded-xl border border-[#f2d5df] bg-[#fff8fa] px-3 py-2.5 text-sm text-[#80566a]">
                            {row.product_code === "pate"
                              ? <><strong>Tiêu hao tự động: {consumedQuantity.toLocaleString("vi-VN")} hộp</strong><span className="ml-1.5">• 1 hộp = 20 bánh mì que</span></>
                              : <strong>Nhập lượng ớt sử dụng thực tế trong ngày • Không bán lẻ</strong>}
                          </div>
                        )}
                        {row.opening_reconciliation_required && !isSubmitted && (
                          <div className="mt-3 rounded-xl border border-[#f2b75d] bg-[#fff9ec] px-3 py-2.5 text-sm text-[#8a5a12]">
                            <strong>Tồn hôm trước bị âm.</strong> Vui lòng kiểm đếm và nhập tồn đầu thực tế trước khi gửi.
                          </div>
                        )}
                        {hasNegativeClosing(row, consumedQuantity) && !isSubmitted && (
                          <div className="mt-3 rounded-xl border border-[#f3a3b9] bg-[#fff1f5] px-3 py-2.5 text-sm font-medium text-[#ad315e]">
                            Tồn cuối không được âm. Kiểm tra tồn đầu, nhập hoặc điều chuyển.
                          </div>
                        )}
                        <div data-testid="computed-closing" className={cn("mt-3 flex items-center justify-between rounded-xl border border-dashed px-3 py-2.5", hasNegativeClosing(row, consumedQuantity) ? "border-[#e66f93] bg-[#fff0f4]" : "border-[#efb6ca] bg-[#fff5f8]")}>
                          <div>
                            <div className="text-sm font-semibold text-[#4f4950]">Tồn cuối</div>
                            <div className="text-[11px] text-[#9b5d73]">Hệ thống tính</div>
                          </div>
                          <output className="text-[20px] font-extrabold tabular-nums text-[#c83f70]">
                            {closingQuantity.toLocaleString("vi-VN")}
                          </output>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <div className="space-y-4">
            <section
              data-testid="channel-section"
              className="overflow-hidden rounded-[20px] border border-[#f0dfe5] bg-white p-3.5 shadow-[0_8px_22px_rgba(86,48,63,0.07)] sm:p-5"
            >
              <SectionTitle icon={CircleDollarSign} title="Doanh thu theo kênh" />
              <div className="mt-3 divide-y divide-[#f2e5e9] border-y border-[#f2e5e9]">
                {channelRows.map((row) => {
                  const cashChannel = row.channel_code === "khach_le";
                  return (
                    <div key={row.channel_code} className="grid grid-cols-[36px_minmax(72px,1fr)_52px_62px] items-center gap-1 p-2 min-[360px]:grid-cols-[40px_minmax(86px,1fr)_68px_84px] min-[360px]:gap-1.5 min-[360px]:p-2.5 sm:grid-cols-[48px_minmax(105px,1fr)_100px_128px] sm:gap-3 xl:grid-cols-[40px_minmax(90px,1fr)_76px_98px] xl:gap-2 xl:p-2.5">
                      <ChannelIcon code={row.channel_code} />
                      <div className="self-center whitespace-nowrap text-[13px] font-bold sm:text-[17px]">{row.channel_name_snapshot}</div>
                      <ChannelNumberField label="Số lượng" value={row.quantity} disabled={isSubmitted} onChange={(value) => updateChannelRow(row.channel_code, "quantity", value)} />
                      <ChannelNumberField label="Thành tiền" value={row.amount_vnd} disabled={isSubmitted || cashChannel} placeholder={cashChannel ? undefined : "—"} onChange={(value) => updateChannelRow(row.channel_code, "amount_vnd", value)} />
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-xs font-medium text-[#80566a]">Khách lẻ tự tính 12.000đ × số lượng.</p>
            </section>

            <section className="grid grid-cols-2 divide-x divide-[#eadfe3] rounded-[18px] border border-[#f0dfe5] bg-white px-3 py-3.5 text-center shadow-[0_6px_18px_rgba(86,48,63,0.06)]">
              <div>
                <div className="text-sm text-[#514c53] sm:text-base">Tổng số bán</div>
                <div className="mt-1 text-[27px] font-extrabold text-[#ec5b91] sm:text-[31px]">{totalQuantity.toLocaleString("vi-VN")}</div>
              </div>
              <div>
                <div className="text-sm text-[#514c53] sm:text-base">Tổng doanh thu</div>
                <div className="mt-1 text-[24px] font-extrabold text-[#ec5b91] sm:text-[29px]">{formatVnd(totalAmount)}</div>
              </div>
            </section>

            <details className="group rounded-[18px] border border-[#f0dfe5] bg-white shadow-[0_6px_18px_rgba(86,48,63,0.05)]">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 font-semibold">
                <span>Ghi chú ca bán</span>
                <ChevronDown className="h-5 w-5 text-[#ec5b91] transition-transform group-open:rotate-180" />
              </summary>
              <div className="px-4 pb-4">
                <Textarea
                  id="report-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Ghi chú sự cố hoặc chênh lệch..."
                  disabled={isSubmitted}
                  className="min-h-[96px] rounded-2xl border-[#e7dfe2] bg-[#fffdfd]"
                />
              </div>
            </details>

            <div className="hidden rounded-[22px] border border-[#f0dfe5] bg-white p-4 shadow-[0_8px_24px_rgba(86,48,63,0.07)] lg:block">
              <ActionButtons loading={loading} disabled={isSubmitted} onSaveDraft={() => saveReport("draft")} onSubmit={() => saveReport("submitted")} />
            </div>
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-[#f1dfe6] bg-white/95 px-3 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-8px_22px_rgba(86,48,63,0.09)] backdrop-blur lg:hidden">
        <ActionButtons loading={loading} disabled={isSubmitted} onSaveDraft={() => saveReport("draft")} onSubmit={() => saveReport("submitted")} />
      </div>
    </main>
  );
}

function ReportSidebar({ staffName, onLogout }: { staffName?: string | null; onLogout: () => void }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[238px] flex-col border-r border-[#eee5e8] bg-white lg:flex">
      <div className="flex justify-center px-6 pb-8 pt-7">
        <img src="/assets/brand/bmq-logo-master-1024.png" alt="BMQ - Bánh Mì Que Pháp" className="h-auto w-[164px] object-contain" />
      </div>
      <nav className="space-y-2 px-3">
        <SidebarItem icon={LayoutDashboard} label="Tổng quan" />
        <SidebarItem icon={BarChart3} label="Báo cáo" active />
        <SidebarItem icon={Store} label="Điểm bán" />
        <SidebarItem icon={Settings} label="Cấu hình" />
      </nav>
      <div className="mt-auto border-t border-[#f2eaed] p-4">
        <div className="mb-3 flex items-center gap-3 rounded-2xl bg-[#fff4f8] p-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#ec5b91] text-sm font-bold text-white">{getInitials(staffName)}</div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{staffName || "Nhân viên"}</div>
            <div className="text-xs text-[#888189]">Báo cáo điểm bán</div>
          </div>
        </div>
        <button type="button" onClick={onLogout} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm text-[#6c656d] hover:bg-[#fff4f8] hover:text-[#c23e70]">
          <LogOut className="h-4 w-4" /> Đăng xuất
        </button>
      </div>
    </aside>
  );
}

function SidebarItem({ icon: Icon, label, active = false }: { icon: typeof LayoutDashboard; label: string; active?: boolean }) {
  return (
    <div className={cn("flex h-12 items-center gap-3 rounded-xl border-l-[3px] px-4 text-sm font-medium", active ? "border-[#ec5b91] bg-[#fdebf2] text-[#d84579]" : "border-transparent text-[#39353b]")}>
      <Icon className="h-5 w-5" strokeWidth={1.8} />
      {label}
    </div>
  );
}

function SectionTitle({ icon: Icon, title }: { icon: typeof Box; title: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#fdeaf1] text-[#ec5b91]">
          <Icon className="h-5 w-5" strokeWidth={2.1} />
        </div>
        <h2 className="text-[19px] font-extrabold tracking-[-0.015em] sm:text-[21px]">{title}</h2>
      </div>
      <ChevronUp className="h-5 w-5 shrink-0 text-[#ec5b91]" />
    </div>
  );
}

function ProductIcon({ code }: { code: string }) {
  const Icon = code === "banh_mi_que" ? Wheat : code === "pate" ? PackageOpen : code === "ot" ? Flame : Cookie;
  return <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#fdebf2] text-[#d94479]"><Icon className="h-5 w-5" strokeWidth={2} /></span>;
}

function ChannelIcon({ code }: { code: string }) {
  if (code === "khach_le") {
    return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#fdebf2] text-[#ec5b91]"><UserRound className="h-6 w-6" /></span>;
  }
  if (code === "shopeefood") {
    return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#fff0eb]"><span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#ee4d2d] text-[10px] font-black text-white">SF</span></span>;
  }
  if (code === "grabfood") {
    return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#eaf8ef]"><span className="rounded bg-[#00b14f] px-1 py-1 text-center text-[8px] font-black leading-[8px] text-white">Grab<br />Food</span></span>;
  }
  return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#fff7d8]"><span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#ffd52f] text-[13px] font-black text-[#123b78]">be</span></span>;
}

function MetricPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-xl bg-[#f8f6f7] px-2.5 py-1.5 text-xs text-[#5f5960]">
      {label} <strong className="text-sm text-[#242129]">{numberValue(value).toLocaleString("vi-VN")}</strong>
    </span>
  );
}

function ReportNumberField({ label, value, disabled, onChange }: { label: string; value: number; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block truncate text-xs text-[#625d63] sm:text-sm">{label}</span>
      <Input type="number" inputMode="decimal" min="0" step="any" value={Number.isFinite(value) ? String(value) : "0"} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="h-12 rounded-xl border-[#ddd8da] bg-white px-3 text-left text-[17px] shadow-none focus-visible:ring-[#ec5b91]" />
    </label>
  );
}

function ChannelNumberField({ label, value, disabled, placeholder, onChange }: { label: string; value: number; disabled?: boolean; placeholder?: string; onChange: (value: string) => void }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block truncate text-[10px] text-[#746e75] sm:text-xs">{label}</span>
      <Input type="number" inputMode="decimal" value={placeholder && Number(value) === 0 ? "" : Number.isFinite(value) ? String(value) : "0"} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="h-10 rounded-xl border-[#ded9db] bg-white px-2 text-left text-sm shadow-none placeholder:text-[#4d4850] focus-visible:ring-[#ec5b91] sm:h-11 sm:px-3 sm:text-base" />
    </label>
  );
}

function ActionButtons({ loading, disabled, onSaveDraft, onSubmit }: { loading: boolean; disabled?: boolean; onSaveDraft: () => void; onSubmit: () => void }) {
  return (
    <div className="grid grid-cols-[0.9fr_1.2fr] gap-2.5 sm:gap-3">
      <Button variant="outline" className={cn("h-12 rounded-xl border-[#ec5b91] bg-white px-2 text-[15px] font-bold text-[#d94479] hover:bg-[#fff4f8] sm:text-base", disabled && "opacity-60")} onClick={onSaveDraft} disabled={loading || disabled}>
        {loading ? <Loader2 className="mr-1.5 h-5 w-5 animate-spin" /> : <Save className="mr-1.5 h-5 w-5" />}
        Lưu nháp
      </Button>
      <Button aria-label="Gửi báo cáo" className="h-12 rounded-xl border-0 bg-[#e9568d] px-2 text-[14px] font-bold text-white shadow-none hover:bg-[#d9477d] sm:text-base" onClick={onSubmit} disabled={loading || disabled}>
        {loading ? <Loader2 className="mr-1.5 h-5 w-5 animate-spin" /> : <Send className="mr-1.5 h-5 w-5" />}
        Kiểm tra & gửi
      </Button>
    </div>
  );
}
