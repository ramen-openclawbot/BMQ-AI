import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  EyeOff,
  Loader2,
  LogOut,
  Phone,
  ReceiptText,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { cn } from "@/lib/utils";
import {
  PayslipSessionExpiredError,
  type Payslip,
  type PayslipEmployee,
  type PayslipLine,
  type PayslipPortalSource,
} from "@/lib/payslip-portal/types";

const BRAND_GRADIENT = { background: "linear-gradient(90deg, #dc4f78 0%, #dc527a 100%)" };
const LOGO_SRC = "/assets/brand/bmq-logo-master-1024.png";

type Step = "loading" | "phone" | "otp" | "list" | "detail";

const vnd = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const qty = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });

function formatMoney(value: number): string {
  return `${vnd.format(Math.round(value))} đ`;
}

function formatLineValue(line: PayslipLine): string {
  if (line.unit === "vnd") return formatMoney(line.value);
  return `${qty.format(line.value)} ${line.unit === "day" ? "ngày" : "giờ"}`;
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function periodRange(payslip: Payslip): string {
  if (!payslip.dateFrom || !payslip.dateTo) return "";
  return `${formatDate(payslip.dateFrom)} – ${formatDate(payslip.dateTo)}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[0] ?? "?").toUpperCase();
}

function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return d.length >= 4 ? `••• ••• ${d.slice(-4)}` : phone;
}

const HIDDEN = "••••••";

export interface PayslipPortalProps {
  source: PayslipPortalSource;
  /** Shows the demo banner and OTP hint. */
  demo?: boolean;
}

export default function PayslipPortal({ source, demo = false }: PayslipPortalProps) {
  const [step, setStep] = useState<Step>("loading");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [employee, setEmployee] = useState<PayslipEmployee | null>(null);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  const resetToLogin = useCallback((message?: string) => {
    setEmployee(null);
    setPayslips([]);
    setSelectedId(null);
    setOtp("");
    setNotice(null);
    setError(message ?? null);
    setStep("phone");
  }, []);

  const loadPayslips = useCallback(async () => {
    setBusy(true);
    setListError(null);
    try {
      const data = await source.listPayslips();
      setEmployee(data.employee);
      setPayslips(data.payslips);
      setStep((current) => (current === "detail" ? current : "list"));
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        resetToLogin(err.message);
      } else {
        setListError(err instanceof Error ? err.message : "Không tải được phiếu lương. Vui lòng thử lại.");
        setStep("list");
      }
    } finally {
      setBusy(false);
    }
  }, [source, resetToLogin]);

  useEffect(() => {
    let cancelled = false;
    source
      .restoreSession()
      .then((current) => {
        if (cancelled) return;
        if (current) {
          setEmployee(current);
          void loadPayslips();
        } else {
          setStep("phone");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof PayslipSessionExpiredError) resetToLogin(err.message);
        else setStep("phone");
      });
    return () => {
      cancelled = true;
    };
  }, [source, loadPayslips, resetToLogin]);

  const startOtp = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await source.startOtp(phone);
      setNotice(result.message);
      setOtp("");
      setStep("otp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không gửi được mã OTP. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    setBusy(true);
    setError(null);
    try {
      await source.verifyOtp(phone, otp);
      setNotice(null);
      await loadPayslips();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mã OTP không đúng hoặc đã hết hạn.");
      setOtp("");
      setBusy(false);
    }
  };

  const logout = async () => {
    await source.logout().catch(() => undefined);
    setPhone("");
    resetToLogin();
  };

  const selected = useMemo(
    () => payslips.find((p) => p.periodId === selectedId) ?? null,
    [payslips, selectedId],
  );

  if (step === "loading") {
    return (
      <Shell demo={demo}>
        <div className="flex min-h-[70vh] items-center justify-center text-[#80566a]">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Đang tải…
        </div>
      </Shell>
    );
  }

  if (step === "phone" || step === "otp") {
    return (
      <Shell demo={demo}>
        <section className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col px-5 pb-7 pt-9 sm:pt-12">
          <div className="flex justify-center">
            <img src={LOGO_SRC} alt="BMQ - Bánh Mì Que Pháp" className="h-auto w-[130px] object-contain sm:w-[145px]" />
          </div>
          <div className="mb-8 mt-8 text-center">
            <h1 className="text-[40px] font-bold leading-[1.08] tracking-[-0.025em]">Phiếu lương</h1>
            <p className="mt-3 text-[18px] leading-7 text-[#666263]">Dành cho nhân viên BMQ</p>
          </div>

          <div className="rounded-[28px] bg-white px-6 py-7 shadow-[0_12px_28px_rgba(70,50,55,0.10)] ring-1 ring-[#eee8e5]">
            {step === "phone" ? (
              <form
                className="space-y-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy) void startOtp();
                }}
              >
                <div className="space-y-3">
                  <Label htmlFor="payslip-phone" className="text-[18px] font-bold text-[#211d1e]">
                    Số điện thoại
                  </Label>
                  <div className="relative">
                    <Phone className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 fill-[#dc4f78] text-[#dc4f78]" />
                    <Input
                      id="payslip-phone"
                      inputMode="tel"
                      autoComplete="tel"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      placeholder="09xx xxx xxx"
                      className="h-14 rounded-2xl border-[#ef8caf] bg-white pl-12 text-[17px] shadow-none placeholder:text-[#aaa7a8] focus-visible:ring-[#dc4f78]"
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  className="h-14 w-full rounded-2xl border-0 text-[18px] font-bold text-white shadow-none hover:brightness-95 min-[375px]:text-[20px]"
                  style={BRAND_GRADIENT}
                  disabled={busy || phone.trim().length === 0}
                >
                  {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
                  Nhận mã OTP qua Zalo
                </Button>
                <div className="flex items-center justify-center gap-3 text-[14px] text-[#4f4a4b]">
                  <ShieldCheck className="h-6 w-6 shrink-0 text-[#dc4f78]" strokeWidth={1.8} />
                  <span>Chỉ bạn xem được phiếu lương của mình</span>
                </div>
              </form>
            ) : (
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy && otp.length === 6) void verifyOtp();
                }}
              >
                <div className="space-y-3 text-center">
                  <Label className="text-[18px] font-bold text-[#211d1e]">Nhập mã OTP</Label>
                  <p className="text-sm text-[#666263]">Mã gồm 6 số, gửi qua Zalo tới số {maskPhone(phone)}</p>
                  <div className="flex justify-center">
                    <InputOTP value={otp} onChange={setOtp} maxLength={6} autoFocus>
                      <InputOTPGroup>
                        {Array.from({ length: 6 }).map((_, index) => (
                          <InputOTPSlot key={index} index={index} className="h-12 w-10 text-lg min-[360px]:w-11" />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                </div>
                <Button
                  type="submit"
                  className="h-14 w-full rounded-2xl border-0 text-[20px] font-bold text-white shadow-none hover:brightness-95"
                  style={BRAND_GRADIENT}
                  disabled={busy || otp.length !== 6}
                >
                  {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
                  Xem phiếu lương
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-[#4d4850]"
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setStep("phone");
                  }}
                >
                  Đổi số điện thoại
                </Button>
              </form>
            )}

            {notice && !error && step === "otp" && (
              <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>
            )}
            {error && (
              <div role="alert" className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
            {demo && (
              <p className="mt-4 rounded-2xl border border-dashed border-[#efb6ca] bg-[#fff5f8] px-3 py-2 text-xs leading-5 text-[#80566a]">
                Bản demo: nhập số bất kỳ, mã OTP <b>123456</b>. Số <b>0900 000 000</b> để xem trường hợp chưa có phiếu lương.
              </p>
            )}
          </div>

          <p className="mt-10 text-center text-[14px] leading-6 text-[#666263]">
            Chưa đăng nhập được? Hãy báo quản lý bếp để cập nhật số điện thoại.
          </p>
          <p className="mt-auto pt-10 text-center text-[14px] text-[#8a8687]">© 2026 Bánh Mì Que Pháp BMQ</p>
        </section>
      </Shell>
    );
  }

  return (
    <Shell demo={demo}>
      <div className="mx-auto max-w-xl px-4 pb-10 pt-4 sm:px-6 sm:pt-6">
        <header className="flex items-center gap-3">
          <img src={LOGO_SRC} alt="BMQ" className="h-10 w-auto shrink-0 object-contain" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold leading-tight">{employee?.name ?? "Nhân viên"}</p>
            <p className="truncate text-xs text-[#85808a]">
              {[employee?.code, employee?.groupName].filter(Boolean).join(" · ")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setHidden((v) => !v)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#eadfe3] bg-white text-[#80566a]"
            aria-label={hidden ? "Hiện số tiền" : "Ẩn số tiền"}
            aria-pressed={hidden}
          >
            {hidden ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
          <button
            type="button"
            onClick={logout}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#ec5b91] text-white"
            aria-label="Đăng xuất"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </header>

        {step === "detail" && selected ? (
          <PayslipDetail payslip={selected} hidden={hidden} onBack={() => setStep("list")} />
        ) : (
          <PayslipList
            payslips={payslips}
            hidden={hidden}
            busy={busy}
            error={listError}
            onRetry={loadPayslips}
            onOpen={(id) => {
              setSelectedId(id);
              setStep("detail");
              window.scrollTo({ top: 0 });
            }}
          />
        )}
      </div>
    </Shell>
  );
}

function Shell({ demo, children }: { demo: boolean; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-[#fefbf9] text-[#211d1e]">
      {demo && (
        <div className="bg-[#20212d] px-4 py-2 text-center text-xs font-semibold tracking-wide text-white">
          BẢN DEMO · dữ liệu giả, không phải lương thật
        </div>
      )}
      {children}
    </main>
  );
}

function PayslipList({
  payslips,
  hidden,
  busy,
  error,
  onRetry,
  onOpen,
}: {
  payslips: Payslip[];
  hidden: boolean;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: (periodId: string) => void;
}) {
  const [latest, ...older] = payslips;

  return (
    <section className="mt-6">
      <h1 className="text-[28px] font-extrabold leading-tight tracking-[-0.02em]">Phiếu lương</h1>
      <p className="mt-1 text-sm text-[#666263]">Các kỳ lương đã chốt</p>

      {error ? (
        <div role="alert" className="mt-5 rounded-[20px] border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>{error}</p>
          <Button variant="outline" className="mt-3 h-11 rounded-xl border-red-200 bg-white" onClick={onRetry} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Thử lại
          </Button>
        </div>
      ) : busy && payslips.length === 0 ? (
        <div className="mt-8 flex items-center justify-center text-[#80566a]">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Đang tải phiếu lương…
        </div>
      ) : !latest ? (
        <div className="mt-6 rounded-[24px] border border-dashed border-[#efb6ca] bg-white px-6 py-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#fdeaf1] text-[#ec5b91]">
            <ReceiptText className="h-7 w-7" />
          </div>
          <p className="mt-4 text-[17px] font-bold">Chưa có phiếu lương</p>
          <p className="mt-2 text-sm leading-6 text-[#666263]">
            Phiếu lương sẽ hiện ở đây sau khi quản lý chốt kỳ lương.
          </p>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onOpen(latest.periodId)}
            className="mt-5 block w-full overflow-hidden rounded-[24px] p-5 text-left text-white shadow-[0_14px_30px_rgba(220,79,120,0.28)] transition hover:brightness-[1.03]"
            style={{ background: "linear-gradient(135deg, #e0578a 0%, #d2456f 100%)" }}
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/20 px-2.5 py-1 text-xs font-semibold">
                <CalendarDays className="h-3.5 w-3.5" /> Kỳ mới nhất
              </span>
              <span className="whitespace-nowrap text-xs text-white/85">{periodRange(latest)}</span>
            </div>
            <p className="mt-4 text-[15px] font-semibold text-white/90">{latest.periodName}</p>
            <p className="mt-1 text-[13px] text-white/80">Thực nhận</p>
            <p className="mt-0.5 break-words text-[34px] font-extrabold leading-tight tracking-[-0.02em] tabular-nums">
              {hidden ? HIDDEN : formatMoney(latest.netPay)}
            </p>
            <span className="mt-4 inline-flex items-center text-sm font-semibold">
              Xem chi tiết <ChevronRight className="ml-1 h-4 w-4" />
            </span>
          </button>

          {older.length > 0 && (
            <>
              <h2 className="mt-8 text-sm font-bold uppercase tracking-wide text-[#85808a]">Kỳ trước</h2>
              <ul className="mt-3 divide-y divide-[#f2e5e9] overflow-hidden rounded-[20px] border border-[#f0dfe5] bg-white">
                {older.map((p) => (
                  <li key={p.periodId}>
                    <button
                      type="button"
                      onClick={() => onOpen(p.periodId)}
                      className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-[#fff9fb]"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#fdeaf1] text-[#ec5b91]">
                        <ReceiptText className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold">{p.periodName}</p>
                        <p className="truncate text-xs text-[#85808a]">{periodRange(p)}</p>
                        <p className="mt-1 text-[15px] font-bold tabular-nums min-[400px]:hidden">{hidden ? HIDDEN : formatMoney(p.netPay)}</p>
                      </div>
                      <span className="hidden shrink-0 text-[15px] font-bold tabular-nums min-[400px]:inline">{hidden ? HIDDEN : formatMoney(p.netPay)}</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-[#b9a9b0]" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

const SECTION_META: Record<PayslipLine["unit"], { title: string; icon: typeof Wallet }> = {
  day: { title: "Ngày công", icon: CalendarDays },
  hour: { title: "Giờ làm", icon: Clock3 },
  vnd: { title: "Thu nhập", icon: Wallet },
};

function PayslipDetail({ payslip, hidden, onBack }: { payslip: Payslip; hidden: boolean; onBack: () => void }) {
  const sections = (["day", "hour", "vnd"] as const)
    .map((unit) => ({ unit, lines: payslip.lines.filter((l) => l.unit === unit) }))
    .filter((s) => s.lines.length > 0);

  return (
    <section className="mt-5">
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 inline-flex h-11 items-center rounded-xl px-2 text-sm font-semibold text-[#c23e70] hover:bg-[#fff4f8]"
      >
        <ChevronLeft className="mr-1 h-4 w-4" /> Tất cả phiếu lương
      </button>

      <div className="mt-2 rounded-[24px] bg-white p-5 shadow-[0_12px_28px_rgba(70,50,55,0.08)] ring-1 ring-[#eee8e5]">
        <p className="text-[13px] font-semibold uppercase tracking-wide text-[#85808a]">{payslip.periodName}</p>
        <p className="mt-0.5 text-sm text-[#666263]">{periodRange(payslip)}</p>
        <div className="mt-4 rounded-2xl bg-[#fff5f8] px-4 py-3.5">
          <p className="text-[13px] font-medium text-[#80566a]">Thực nhận</p>
          <p className="mt-0.5 break-words text-[32px] font-extrabold leading-tight tracking-[-0.02em] text-[#c23e70] tabular-nums">
            {hidden ? HIDDEN : formatMoney(payslip.netPay)}
          </p>
        </div>
        <p className="mt-3 text-xs leading-5 text-[#85808a]">
          Thực nhận làm tròn đến 1.000 đồng · Đã chốt ngày {formatDate(payslip.publishedAt)}
        </p>
      </div>

      {sections.map(({ unit, lines }) => {
        const { title, icon: Icon } = SECTION_META[unit];
        return (
          <div key={unit} className="mt-4 rounded-[20px] border border-[#f0dfe5] bg-white p-4 sm:p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-bold">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#fdeaf1] text-[#ec5b91]">
                <Icon className="h-4 w-4" />
              </span>
              {title}
            </h2>
            <dl className="mt-2 divide-y divide-[#f2e5e9]">
              {lines.map((line) => {
                const total = line.key === "gross_pay";
                return (
                  <div key={line.key} className={cn("flex items-baseline justify-between gap-4 py-2.5", total && "pt-3")}>
                    <dt className={cn("min-w-0 text-[15px] text-[#4d4850]", total && "font-bold text-[#211d1e]")}>{line.label}</dt>
                    <dd className={cn("shrink-0 text-right text-[15px] font-semibold tabular-nums", total && "font-extrabold")}>
                      {hidden && line.unit === "vnd" ? HIDDEN : formatLineValue(line)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        );
      })}

      {payslip.note && (
        <div className="mt-4 rounded-[20px] border border-[#f2d5df] bg-[#fff8fa] px-4 py-3 text-sm leading-6 text-[#80566a]">
          <span className="font-semibold">Ghi chú: </span>
          {payslip.note}
        </div>
      )}

      <p className="mt-6 text-center text-[13px] leading-6 text-[#85808a]">
        Thắc mắc về phiếu lương? Hãy liên hệ quản lý bếp.
      </p>
    </section>
  );
}
