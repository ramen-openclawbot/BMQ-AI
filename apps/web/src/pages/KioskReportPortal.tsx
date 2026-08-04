import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Loader2,
  LogOut,
  MapPin,
  Phone,
  Save,
  Send,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";
import { cn } from "@/lib/utils";

const REPORT_SESSION_STORAGE_KEY = "bmq_report_session_token";

const DEFAULT_PRODUCTS = [
  { code: "banh_mi_que", product_name: "Bánh mì que", unit: "que" },
  { code: "pate", product_name: "Pate", unit: "hộp" },
  { code: "ot", product_name: "Ớt", unit: "phần" },
  { code: "banh_mi_say", product_name: "Bánh mì sấy", unit: "gói" },
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

type BootstrapResponse = {
  success?: boolean;
  report_date?: string;
  staff?: PublicStaff | null;
  location?: PublicLocation | null;
  products?: ReportProduct[];
  channels?: ReportChannel[];
  report?: {
    report_date?: string | null;
    status?: "draft" | "submitted" | string;
    notes?: string | null;
    submitted_at?: string | null;
    updated_at?: string | null;
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

const calcClosing = (row: InventoryRow) =>
  numberValue(row.opening_quantity)
  + numberValue(row.received_quantity)
  - numberValue(row.shortage_quantity)
  + numberValue(row.transfer_quantity)
  - numberValue(row.waste_quantity)
  - numberValue(row.returns_quantity)
  - numberValue(row.sold_quantity);

const mergeInventoryRows = (products: ReportProduct[], rows: InventoryRow[] = []) => {
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
  return channels.map((channel) => ({
    ...createChannelRows([channel])[0],
    ...(byCode.get(channel.code) || {}),
    channel_code: channel.code,
    channel_name_snapshot: channel.channel_name,
  }));
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
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(Boolean(reportToken));

  const isSubmitted = reportStatus === "submitted";
  const totalAmount = useMemo(
    () => channelRows.reduce((sum, row) => sum + numberValue(row.amount_vnd), 0),
    [channelRows],
  );
  const totalQuantity = useMemo(
    () => channelRows.reduce((sum, row) => sum + numberValue(row.quantity), 0),
    [channelRows],
  );

  const hydrateBootstrap = useCallback((payload: BootstrapResponse) => {
    const nextProducts = payload.products?.length ? payload.products : DEFAULT_PRODUCTS;
    const nextChannels = payload.channels?.length ? payload.channels : DEFAULT_CHANNELS;
    setProducts(nextProducts);
    setChannels(nextChannels);
    setStaff(payload.staff || null);
    setLocation(payload.location || null);
    setReportDate(payload.report?.report_date || payload.report_date || vietnamToday());
    setReportStatus(payload.report?.status === "submitted" ? "submitted" : "draft");
    setSubmittedAt(payload.report?.submitted_at || null);
    setNotes(payload.report?.notes || "");
    setInventoryRows(mergeInventoryRows(nextProducts, payload.report?.inventory_rows || []));
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
      setErrorMessage(sessionResult.error);
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
      setErrorMessage(bootstrapResult.error || "Không tải được báo cáo.");
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
      setErrorMessage(result.error || "Không gửi được OTP.");
      return;
    }

    setStatusMessage(result.data.message || "Mã OTP được gửi qua Zalo.");
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
      setErrorMessage(result.error || "Không xác thực được OTP.");
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
        inventory_rows: inventoryRows,
        channel_rows: channelRows,
      },
      undefined,
      30000,
    );
    setLoading(false);

    if (result.error) {
      setErrorMessage(result.error);
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
      current.map((row) => row.channel_code === channelCode ? { ...row, [field]: field === "notes" ? value : numberValue(value) } : row),
    );
  };

  if (bootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f3f4f6] text-slate-700">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Đang tải báo cáo...
      </div>
    );
  }

  if (step !== "report") {
    return (
      <main className="min-h-screen bg-[#f3f4f6] px-4 py-8 text-slate-950">
        <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col justify-center">
          <div className="mb-6 flex justify-center">
            <img src="/assets/brand/bmq-logo-master-1024.png" alt="BMQ" className="h-24 w-24 object-contain" />
          </div>
          <div className="rounded-[28px] bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div className="mb-5 text-center">
              <h1 className="text-2xl font-bold tracking-normal">Báo cáo điểm bán</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Mã OTP được gửi qua Zalo ZNS. Trường hợp Zalo lỗi, hệ thống dùng SMS dự phòng.
              </p>
            </div>

            {step === "phone" ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="report-phone">Nhập số điện thoại</Label>
                  <div className="relative">
                    <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      id="report-phone"
                      inputMode="tel"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      placeholder="VD: 0966998999"
                      className="h-12 rounded-2xl border-slate-200 pl-10 text-base"
                    />
                  </div>
                </div>
                <Button
                  className="h-12 w-full rounded-2xl bg-[#b71c1c] text-base font-semibold hover:bg-[#991818]"
                  onClick={startAuth}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Gửi mã OTP Zalo
                </Button>
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
                  className="h-12 w-full rounded-2xl bg-[#b71c1c] text-base font-semibold hover:bg-[#991818]"
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
          <p className="mt-5 text-center text-xs text-slate-500">
            BMQ bảo mật số điện thoại và chỉ dùng cho Báo cáo điểm bán.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f3f4f6] text-slate-950">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 pb-28 pt-5 md:px-8 md:pb-10">
        <header className="mb-5 space-y-4">
          <div className="flex justify-center">
            <img src="/assets/brand/bmq-logo-master-1024.png" alt="BMQ" className="h-20 w-20 object-contain" />
          </div>
          <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-slate-200 md:p-5">
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_180px_auto] md:items-center">
              <InfoTile icon={UserRound} label="Thông tin nhân viên" value={staff?.full_name || "Nhân viên"} />
              <InfoTile
                icon={MapPin}
                label="Điểm bán"
                value={location?.name || "Điểm bán"}
                detail={[location?.code, location?.address].filter(Boolean).join(" · ")}
              />
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Ngày báo cáo</Label>
                <div className="relative">
                  <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    type="date"
                    value={reportDate}
                    onChange={(event) => setReportDate(event.target.value)}
                    className="h-11 rounded-2xl border-slate-200 pl-10"
                  />
                </div>
              </div>
              <Button variant="outline" className="h-11 rounded-2xl" onClick={logout}>
                <LogOut className="mr-2 h-4 w-4" />
                Đăng xuất
              </Button>
            </div>
          </div>
        </header>

        {isSubmitted && (
          <div className="mb-4 rounded-[20px] border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800">
            <CheckCircle2 className="mr-2 inline h-4 w-4 align-text-bottom" />
            Báo cáo ngày này đã gửi{submittedAt ? ` lúc ${new Date(submittedAt).toLocaleString("vi-VN")}` : ""}. Báo cáo đã khóa chỉnh sửa.
          </div>
        )}

        {errorMessage && (
          <div className="mb-4 rounded-[20px] border border-red-200 bg-white px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="mr-2 inline h-4 w-4 align-text-bottom" />
            {errorMessage}
          </div>
        )}

        {statusMessage && !errorMessage && (
          <div className="mb-4 rounded-[20px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
            {statusMessage}
          </div>
        )}

        <div className="grid flex-1 gap-5 lg:grid-cols-[1.25fr_0.75fr]">
          <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-slate-200 md:p-5">
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold tracking-normal">Tồn kho & luân chuyển</h2>
                <p className="text-sm text-slate-500">Tồn cuối = đầu + nhận - thiếu + luân chuyển - hủy - trả - bán.</p>
              </div>
            </div>

            <div className="space-y-4 md:hidden">
              {inventoryRows.map((row) => (
                <div key={row.product_code} className="rounded-[22px] border border-slate-200 p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold">{row.product_name_snapshot}</div>
                      <div className="text-xs text-slate-500">Tồn cuối: {calcClosing(row).toLocaleString("vi-VN")}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberField label="Đầu" value={row.opening_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "opening_quantity", value)} />
                    <NumberField label="Nhận" value={row.received_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "received_quantity", value)} />
                    <NumberField label="Thiếu" value={row.shortage_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "shortage_quantity", value)} />
                    <NumberField label="Luân chuyển (+/-)" value={row.transfer_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "transfer_quantity", value)} />
                    <NumberField label="Hủy" value={row.waste_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "waste_quantity", value)} />
                    <NumberField label="Trả" value={row.returns_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "returns_quantity", value)} />
                    <NumberField label="Bán" value={row.sold_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "sold_quantity", value)} />
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <div className="min-w-[920px]">
                <div className="grid grid-cols-[140px_repeat(8,1fr)] gap-2 border-b border-slate-200 pb-2 text-xs font-semibold uppercase text-slate-500">
                  <div>Sản phẩm</div>
                  <div>Đầu</div>
                  <div>Nhận</div>
                  <div>Thiếu</div>
                  <div>Luân chuyển</div>
                  <div>Hủy</div>
                  <div>Trả</div>
                  <div>Bán</div>
                  <div>Tồn cuối</div>
                </div>
                <div className="divide-y divide-slate-100">
                  {inventoryRows.map((row) => (
                    <div key={row.product_code} className="grid grid-cols-[140px_repeat(8,1fr)] items-center gap-2 py-3">
                      <div className="font-medium">{row.product_name_snapshot}</div>
                      <InlineNumber value={row.opening_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "opening_quantity", value)} />
                      <InlineNumber value={row.received_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "received_quantity", value)} />
                      <InlineNumber value={row.shortage_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "shortage_quantity", value)} />
                      <InlineNumber value={row.transfer_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "transfer_quantity", value)} />
                      <InlineNumber value={row.waste_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "waste_quantity", value)} />
                      <InlineNumber value={row.returns_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "returns_quantity", value)} />
                      <InlineNumber value={row.sold_quantity} disabled={isSubmitted} onChange={(value) => updateInventoryRow(row.product_code, "sold_quantity", value)} />
                      <div className="rounded-2xl bg-slate-100 px-3 py-2 text-right font-semibold">{calcClosing(row).toLocaleString("vi-VN")}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-5">
            <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-slate-200 md:p-5">
              <h2 className="text-xl font-bold tracking-normal">Doanh thu theo kênh</h2>
              <p className="mb-4 text-sm text-slate-500">Nhập số lượng và số tiền từng kênh.</p>
              <div className="space-y-3">
                {channelRows.map((row) => (
                  <div key={row.channel_code} className="rounded-[22px] border border-slate-200 p-3">
                    <div className="mb-3 font-semibold">{row.channel_name_snapshot}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <NumberField label="Số lượng" value={row.quantity} disabled={isSubmitted} onChange={(value) => updateChannelRow(row.channel_code, "quantity", value)} />
                      <NumberField label="Doanh thu" value={row.amount_vnd} disabled={isSubmitted} onChange={(value) => updateChannelRow(row.channel_code, "amount_vnd", value)} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-[22px] bg-slate-50 p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">Tổng số lượng</span>
                  <span className="font-semibold">{totalQuantity.toLocaleString("vi-VN")}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-sm">
                  <span className="text-slate-500">Tổng doanh thu</span>
                  <span className="font-semibold text-[#b71c1c]">{formatVnd(totalAmount)}</span>
                </div>
              </div>
            </div>

            <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-slate-200 md:p-5">
              <Label htmlFor="report-notes">Ghi chú</Label>
              <Textarea
                id="report-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Ghi chú ca bán, sự cố, chênh lệch..."
                disabled={isSubmitted}
                className="mt-2 min-h-[120px] rounded-2xl border-slate-200"
              />
            </div>

            <div className="hidden rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-slate-200 md:block">
              <ActionButtons
                loading={loading}
                disabled={isSubmitted}
                onSaveDraft={() => saveReport("draft")}
                onSubmit={() => saveReport("submitted")}
              />
            </div>
          </section>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 p-3 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur md:hidden">
        <ActionButtons
          loading={loading}
          disabled={isSubmitted}
          onSaveDraft={() => saveReport("draft")}
          onSubmit={() => saveReport("submitted")}
        />
      </div>
    </main>
  );
}

function InfoTile({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof UserRound;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-[22px] bg-slate-50 p-3">
      <div className="mt-0.5 rounded-2xl bg-white p-2 text-[#b71c1c] shadow-sm">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-slate-500">{label}</div>
        <div className="truncate font-semibold">{value}</div>
        {detail ? <div className="mt-0.5 line-clamp-2 text-xs text-slate-500">{detail}</div> : null}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-slate-500">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? String(value) : "0"}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="h-10 rounded-2xl border-slate-200 text-right"
      />
    </div>
  );
}

function InlineNumber({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      value={Number.isFinite(value) ? String(value) : "0"}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="h-10 rounded-2xl border-slate-200 text-right"
    />
  );
}

function ActionButtons({
  loading,
  disabled,
  onSaveDraft,
  onSubmit,
}: {
  loading: boolean;
  disabled?: boolean;
  onSaveDraft: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button
        variant="outline"
        className={cn("h-12 rounded-2xl text-base font-semibold", disabled && "opacity-60")}
        onClick={onSaveDraft}
        disabled={loading || disabled}
      >
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
        Lưu nháp
      </Button>
      <Button
        className="h-12 rounded-2xl bg-[#b71c1c] text-base font-semibold hover:bg-[#991818]"
        onClick={onSubmit}
        disabled={loading || disabled}
      >
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
        Gửi báo cáo
      </Button>
    </div>
  );
}
