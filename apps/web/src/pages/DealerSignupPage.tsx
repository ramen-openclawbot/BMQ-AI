import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import bmqLogo from "@/assets/bmq-logo.png";
import {
  DEALER_SIGNUP_THRESHOLD_M,
  DealerSignupApiError,
  checkDealerSignupLocation,
  checkDealerSignupVerification,
  createDealerSignupIdempotencyKey,
  createDealerSignupVerificationSessionId,
  geocodeAddressPhoton,
  getDealerSignupConfig,
  sendDealerSignupVerification,
  submitDealerSignup,
  type DealerSignupCheckResult,
  type DealerSignupVerifyChannel,
  type DealerSignupConfig,
  type DealerSignupSubmitResult,
  type PhotonGeocodeResult,
} from "@/lib/dealer-signup-api";
import { HCMC, OSM_TILES, loadLeaflet, type LMap, type LMarker, type LatLng } from "@/lib/leaflet-loader";

/*
 * Public franchise landing + signup for new BMQ dealers (dathang.banhmique.vn/dai-ly-moi).
 * Summarises the owner's dealer contract, lets the applicant pin the exact spot on an
 * OpenStreetMap (Leaflet) map, checks the 2 km route rule on the server and requests
 * the contract by email. Palette follows the dealer portal (pink on warm paper).
 */

const PIN_HTML =
  '<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#d94f8a;border:3px solid #fff;box-shadow:0 2px 8px rgba(52,37,44,.35)"></div>';

const formatKm = (m: number | null | undefined) =>
  m === null || m === undefined ? "" : `${(m / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km`;

const PRICE_TIERS = [
  { level: "Cấp 1", volume: "Đến 3.000 que/tháng", price: "6.500đ" },
  { level: "Cấp 2", volume: "3.000 – 6.000 que/tháng", price: "6.000đ" },
  { level: "Cấp 3", volume: "Trên 6.000 que/tháng", price: "5.500đ" },
];

const HIGHLIGHTS = [
  { value: "0đ", label: "Phí gia nhập" },
  { value: "0đ", label: "Tiền đặt cọc" },
  { value: "3 ngày", label: "Bàn giao kỹ thuật" },
  { value: "Miễn phí", label: "Giao từ 100 ổ" },
];

const STEPS = [
  { title: "Đặt bánh trước 20h", body: "Đặt cho ngày hôm sau trên Zalo App của BMQ. Số lượng chia hết cho 20, tối thiểu 100 ổ." },
  { title: "BMQ giao tận điểm bán", body: "Giao miễn phí trong khu vực của anh/chị, giờ giao linh động trong ngày." },
  { title: "Kiểm hàng khi nhận", body: "Bánh lỗi báo trong vòng 1 giờ sau khi nhận, BMQ cử người xác nhận và đổi lại." },
  { title: "Trả trước, trừ dần", body: "Nạp trước tối thiểu 1.000.000đ. Tiền hàng trừ dần, còn khoảng 100 bánh (~650.000đ) thì nạp thêm." },
];

const BMQ_SUPPORT = [
  "Bàn giao kỹ thuật làm bánh trong 3 ngày làm việc sau khi ký",
  "Đào tạo miễn phí: trét pate, nướng bánh, bảo quản",
  "Tư vấn xử lý khiếu nại của khách",
  "Đổi bánh lỗi theo biên bản giao nhận",
];

const DEALER_COMMITMENTS = [
  "Chỉ bán sản phẩm do BMQ cung cấp, không bán sản phẩm tương tự",
  "Tự chọn địa điểm, bảo quản bánh và giữ vệ sinh an toàn thực phẩm",
  "Thanh toán đầy đủ, đúng hạn; báo trước 24h nếu đổi điểm nhận hàng",
  "Trong 3 tháng sau khi dừng hợp đồng, không kinh doanh sản phẩm tương tự",
];

const OTHER_TERMS = [
  { label: "Thời hạn hợp đồng", value: "1 năm, xem xét gia hạn 7 ngày trước khi hết hạn" },
  { label: "Giá bán lẻ gợi ý", value: "14.000đ/ổ (đã gồm VAT), đại lý được tự chọn giá" },
  { label: "Xe bán bánh", value: "Không bắt buộc. Nếu cần: 5.000.000đ + phí vận chuyển" },
  { label: "Mở thêm chi nhánh", value: "5.000.000đ cho mỗi điểm mở thêm" },
  { label: "Ngừng kinh doanh", value: "Ngừng 2 tháng liên tiếp không báo, BMQ có thể thanh lý hợp đồng" },
];

function Section({ id, eyebrow, title, children }: { id?: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto w-full max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#bd3f75]">{eyebrow}</p>
      <h2 className="mt-2 max-w-2xl text-2xl font-bold leading-tight text-[#34252c] sm:text-[2rem]">{title}</h2>
      <div className="mt-7">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-semibold text-[#34252c]">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint ? <span className="mt-1 block text-xs leading-5 text-[#806873]">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  "h-12 w-full rounded-xl border border-[#edd4df] bg-white px-3.5 text-base text-[#34252c] outline-none transition placeholder:text-[#b59aa6] focus:border-[#d94f8a] focus:ring-2 focus:ring-[#f5dce7]";
const primaryButton =
  "inline-flex h-12 items-center justify-center rounded-xl bg-[#d94f8a] px-6 text-base font-semibold text-white transition hover:bg-[#bd3f75] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b83b70] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton =
  "inline-flex h-12 items-center justify-center rounded-xl border border-[#edd4df] bg-white px-5 text-base font-semibold text-[#34252c] transition hover:border-[#d94f8a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b83b70] disabled:opacity-50";

function errorMessage(error: unknown): string {
  if (error instanceof DealerSignupApiError) {
    if (error.rateLimited && error.code !== "too_many_attempts") return "Anh/chị thao tác quá nhiều lần. Vui lòng thử lại sau ít phút.";
    return error.message || "Có lỗi xảy ra. Vui lòng thử lại.";
  }
  return "Không kết nối được máy chủ BMQ. Vui lòng thử lại.";
}

export default function DealerSignupPage() {
  const [config, setConfig] = useState<DealerSignupConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [mapState, setMapState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState<LatLng | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState("");
  const [suggestions, setSuggestions] = useState<PhotonGeocodeResult[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<DealerSignupCheckResult | null>(null);
  const [checkError, setCheckError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitted, setSubmitted] = useState<DealerSignupSubmitResult | null>(null);
  const [form, setForm] = useState({
    applicant_name: "",
    business_name: "",
    cccd: "",
    cccd_valid_until: "",
    phone: "",
    email: "",
    terms_accepted: false,
  });
  // Địa chỉ bên ký hợp đồng (Bên B); mặc định giống địa chỉ bán hàng.
  const [contractAddressSame, setContractAddressSame] = useState(true);
  const [contractAddress, setContractAddress] = useState("");

  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LMap | null>(null);
  const markerRef = useRef<LMarker | null>(null);
  const idempotencyKey = useMemo(() => createDealerSignupIdempotencyKey(), []);
  const verifySessionId = useMemo(() => createDealerSignupVerificationSessionId(), []);
  const [verify, setVerify] = useState<Record<DealerSignupVerifyChannel, VerifyState>>({
    phone: EMPTY_VERIFY,
    email: EMPTY_VERIFY,
  });
  const [verificationToken, setVerificationToken] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const pending = (["phone", "email"] as const).some((c) => verify[c].resendAt > now);
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [verify, now]);

  const patchVerify = (channel: DealerSignupVerifyChannel, patch: Partial<VerifyState>) =>
    setVerify((prev) => ({ ...prev, [channel]: { ...prev[channel], ...patch } }));

  useEffect(() => {
    document.title = "Mở đại lý Bánh Mì Que BMQ";
    getDealerSignupConfig()
      .then(setConfig)
      .catch(() => setConfigError(true));
  }, []);

  // A moved pin invalidates any earlier check result.
  const placePin = useCallback((point: LatLng) => {
    setPin(point);
    setCheck(null);
    setCheckError("");
    markerRef.current?.setLatLng([point.lat, point.lng]);
    mapRef.current?.panTo([point.lat, point.lng]);
  }, []);

  useEffect(() => {
    if (!config) return;
    setMapState("loading");
    let cancelled = false;
    let created: LMap | null = null;
    loadLeaflet()
      .then((L) => {
        if (cancelled || !mapEl.current) return;
        const center = config.map_center || config.default_center || HCMC;
        const map = L.map(mapEl.current, { zoomControl: true }).setView([center.lat, center.lng], 12);
        L.tileLayer(config.tile_url || OSM_TILES, {
          maxZoom: 19,
          attribution: config.tile_attribution || "© OpenStreetMap contributors",
        }).addTo(map);
        const icon = L.divIcon({ className: "", html: PIN_HTML, iconSize: [26, 26], iconAnchor: [4, 30] });
        const marker = L.marker([center.lat, center.lng], { draggable: true, icon, keyboard: false }).addTo(map);
        marker.on("dragend", () => {
          const p = marker.getLatLng();
          placePin({ lat: p.lat, lng: p.lng });
        });
        map.on("click", (ev) => placePin({ lat: ev.latlng.lat, lng: ev.latlng.lng }));
        created = map;
        mapRef.current = map;
        markerRef.current = marker;
        setMapState("ready");
      })
      .catch(() => !cancelled && setMapState("unavailable"));
    return () => {
      cancelled = true;
      created?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [config, placePin]);

  const chooseSuggestion = (index: number, list: PhotonGeocodeResult[] = suggestions) => {
    const item = list[index];
    if (!item) return;
    setChosen(index);
    placePin({ lat: item.lat, lng: item.lng });
    mapRef.current?.setView([item.lat, item.lng], 17);
  };

  const findAddress = async () => {
    if (address.trim().length < 8) {
      setLocateError("Nhập địa chỉ đầy đủ: số nhà, tên đường, phường, tỉnh/thành.");
      return;
    }
    setLocating(true);
    setLocateError("");
    try {
      const results = await geocodeAddressPhoton(address.trim());
      setSuggestions(results);
      if (!results.length) {
        setChosen(null);
        setLocateError("Không tìm thấy địa chỉ này. Kiểm tra lại, hoặc chạm vào bản đồ để đặt ghim đúng vị trí.");
        return;
      }
      chooseSuggestion(0, results);
    } finally {
      setLocating(false);
    }
  };

  const runCheck = async () => {
    if (!pin) return;
    setChecking(true);
    setCheckError("");
    try {
      setCheck(await checkDealerSignupLocation({ lat: pin.lat, lng: pin.lng, address_text: address.trim() }));
    } catch (error) {
      setCheckError(errorMessage(error));
    } finally {
      setChecking(false);
    }
  };

  const phoneValue = form.phone.replace(/[\s.]/g, "");
  const emailValue = form.email.trim();
  const phoneShapeOk = /^(0|\+84)\d{9,10}$/.test(phoneValue);
  const emailShapeOk = /\S+@\S+\.\S+/.test(emailValue);

  const sendCode = async (channel: DealerSignupVerifyChannel) => {
    patchVerify(channel, { sending: true, error: "", code: "" });
    try {
      const result = await sendDealerSignupVerification({
        sessionId: verifySessionId,
        channel,
        phone: channel === "phone" ? phoneValue : undefined,
        email: channel === "email" ? emailValue : undefined,
      });
      setNow(Date.now());
      patchVerify(channel, {
        sent: true,
        verified: Boolean(result.already_verified),
        resendAt: Date.now() + (result.resend_after_seconds ?? 60) * 1000,
      });
    } catch (error) {
      patchVerify(channel, { error: errorMessage(error) });
    } finally {
      patchVerify(channel, { sending: false });
    }
  };

  const confirmCode = async (channel: DealerSignupVerifyChannel) => {
    const code = verify[channel].code.trim();
    if (!/^\d{6}$/.test(code)) {
      patchVerify(channel, { error: "Nhập đủ 6 số." });
      return;
    }
    patchVerify(channel, { checking: true, error: "" });
    try {
      const result = await checkDealerSignupVerification({
        sessionId: verifySessionId,
        channel,
        code,
        phone: phoneShapeOk ? phoneValue : undefined,
        email: emailShapeOk ? emailValue : undefined,
      });
      setVerify((prev) => ({
        phone: { ...prev.phone, verified: result.verified.phone || prev.phone.verified },
        email: { ...prev.email, verified: result.verified.email || prev.email.verified },
      }));
      if (result.verification_token) setVerificationToken(result.verification_token);
    } catch (error) {
      patchVerify(channel, { error: errorMessage(error) });
    } finally {
      patchVerify(channel, { checking: false });
    }
  };

  const formValid =
    form.applicant_name.trim().length >= 2 &&
    /^\d{9}$|^\d{12}$/.test(form.cccd.trim()) &&
    form.cccd_valid_until !== "" &&
    /^(0|\+84)\d{9,10}$/.test(form.phone.replace(/[\s.]/g, "")) &&
    /\S+@\S+\.\S+/.test(form.email.trim()) &&
    (contractAddressSame || contractAddress.trim().length >= 5) &&
    form.terms_accepted &&
    verificationToken !== "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pin || !formValid) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const result = await submitDealerSignup({
        applicant_name: form.applicant_name.trim(),
        business_name: form.business_name.trim(),
        cccd: form.cccd.trim(),
        cccd_valid_until: form.cccd_valid_until,
        phone: form.phone.replace(/[\s.]/g, ""),
        email: form.email.trim(),
        address_text: address.trim(),
        contract_address_text: contractAddressSame ? address.trim() : contractAddress.trim(),
        lat: pin.lat,
        lng: pin.lng,
        terms_accepted: form.terms_accepted,
        idempotency_key: idempotencyKey,
        verification_token: verificationToken,
      });
      setSubmitted(result);
      window.scrollTo({ top: document.getElementById("dang-ky")?.offsetTop ?? 0, behavior: "smooth" });
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const update = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    // A changed phone/email needs a fresh code for that channel.
    if (key === "phone" || key === "email") {
      patchVerify(key, EMPTY_VERIFY);
      setVerificationToken("");
    }
    setForm((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const thresholdKm = formatKm(config?.threshold_m ?? DEALER_SIGNUP_THRESHOLD_M).replace(",0", "");
  const canContinue = check?.result === "eligible" || check?.result === "manual_review";

  return (
    <div className="min-h-[100dvh] bg-[#fff9f5] text-[#34252c] antialiased">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-[#f3dce6] bg-[#fff9f5]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-2.5">
            <img src={bmqLogo} alt="" className="h-9 w-9 rounded-full object-contain" />
            <span className="text-base font-bold">Bánh Mì Que BMQ</span>
          </div>
          <a href="#dang-ky" className="inline-flex h-10 items-center rounded-xl bg-[#d94f8a] px-4 text-sm font-semibold text-white hover:bg-[#bd3f75]">
            Đăng ký mở điểm
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto w-full max-w-5xl px-5 pb-10 pt-12 sm:px-8 sm:pb-14 sm:pt-20">
        <p className="inline-flex rounded-full bg-[#f5dce7] px-3 py-1 text-xs font-semibold text-[#bd3f75]">Hợp đồng đại lý mở 01 điểm</p>
        <h1 className="mt-5 max-w-3xl text-[2.1rem] font-extrabold leading-[1.12] tracking-tight sm:text-[3.25rem]">
          Mở điểm bán Bánh Mì Que BMQ, không phí gia nhập, không đặt cọc.
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-[#806873] sm:text-lg sm:leading-8">
          BMQ giao bánh, pate và giấy gói tận nơi mỗi ngày, đào tạo anh/chị cách làm bánh. Anh/chị chọn địa điểm và bán. Mỗi điểm bán cách đại lý gần nhất ít nhất {thresholdKm} đường xe máy.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <a href="#dang-ky" className={primaryButton}>Kiểm tra địa điểm của tôi</a>
          <a href="#gia-si" className={secondaryButton}>Xem giá sỉ</a>
        </div>
        <dl className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-[#edd4df] bg-[#edd4df] sm:grid-cols-4">
          {HIGHLIGHTS.map((item) => (
            <div key={item.label} className="bg-white px-4 py-5">
              <dt className="text-xs font-medium text-[#806873]">{item.label}</dt>
              <dd className="mt-1 text-2xl font-extrabold text-[#bd3f75]">{item.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Wholesale price */}
      <div className="border-y border-[#f3dce6] bg-white">
        <Section id="gia-si" eyebrow="Giá sỉ" title="Bán càng nhiều, giá nhập càng thấp">
          <div className="overflow-hidden rounded-2xl border border-[#edd4df]">
            {PRICE_TIERS.map((tier, index) => (
              <div key={tier.level} className={`flex items-center justify-between gap-4 px-5 py-4 ${index ? "border-t border-[#f3dce6]" : ""}`}>
                <div>
                  <div className="text-sm font-semibold text-[#bd3f75]">{tier.level}</div>
                  <div className="mt-0.5 text-base">{tier.volume}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-extrabold tabular-nums">{tier.price}</div>
                  <div className="text-xs text-[#806873]">/que, chưa VAT</div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm leading-6 text-[#806873]">
            Giá bán lẻ gợi ý 14.000đ/ổ (đã gồm VAT). BMQ báo trước 15 ngày làm việc khi điều chỉnh giá.
          </p>
        </Section>
      </div>

      {/* How it works */}
      <Section eyebrow="Vận hành mỗi ngày" title="Đặt hôm nay, nhận bánh ngày mai">
        <ol className="grid gap-4 sm:grid-cols-2">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-2xl border border-[#edd4df] bg-white p-5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#f5dce7] text-sm font-bold text-[#bd3f75]">{index + 1}</span>
              <h3 className="mt-3 text-lg font-bold">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-[#806873]">{step.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* Commitments */}
      <div className="border-y border-[#f3dce6] bg-white">
        <Section eyebrow="Hai bên cam kết" title="BMQ lo sản phẩm, anh/chị lo điểm bán">
          <div className="grid gap-8 sm:grid-cols-2">
            {[
              { title: "BMQ hỗ trợ", items: BMQ_SUPPORT },
              { title: "Đại lý cam kết", items: DEALER_COMMITMENTS },
            ].map((col) => (
              <div key={col.title}>
                <h3 className="text-base font-bold">{col.title}</h3>
                <ul className="mt-3 space-y-3">
                  {col.items.map((item) => (
                    <li key={item} className="flex gap-3 text-[15px] leading-6">
                      <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#d94f8a]" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* Other terms */}
      <Section eyebrow="Các điều khoản khác" title="Rõ ràng trước khi ký">
        <dl className="divide-y divide-[#f3dce6] rounded-2xl border border-[#edd4df] bg-white">
          {OTHER_TERMS.map((term) => (
            <div key={term.label} className="grid gap-1 px-5 py-4 sm:grid-cols-[220px_1fr] sm:gap-6">
              <dt className="text-sm font-semibold">{term.label}</dt>
              <dd className="text-sm leading-6 text-[#806873]">{term.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm leading-6 text-[#806873]">
          Đây là tóm tắt. Nội dung đầy đủ nằm trong hợp đồng BMQ gửi vào email của anh/chị sau khi đăng ký.
        </p>
      </Section>

      {/* Signup */}
      <div id="dang-ky" className="scroll-mt-16 border-t border-[#f3dce6] bg-[#fff2f7]">
        <section className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#bd3f75]">Đăng ký</p>
          <h2 className="mt-2 text-2xl font-bold leading-tight sm:text-[2rem]">Kiểm tra địa điểm muốn mở</h2>
          <p className="mt-3 text-base leading-7 text-[#806873]">
            Nhập chính xác địa chỉ rồi đặt ghim đúng vị trí điểm bán. Hệ thống đo quãng đường xe máy tới các đại lý BMQ hiện có: điểm mới cần cách ít nhất {thresholdKm}.
          </p>

          {submitted ? (
            <SubmittedCard result={submitted} email={form.email.trim()} />
          ) : (
            <div className="mt-8 space-y-6">
              {/* Step 1: location */}
              <div className="rounded-2xl border border-[#edd4df] bg-white p-5 sm:p-6">
                <StepTitle n={1} title="Vị trí điểm bán" />
                <div className="mt-4 space-y-3">
                  <Field label="Địa chỉ bán hàng" hint="Ví dụ: 125 Tô Ký, Phường Đông Hưng Thuận, TP.HCM">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        className={inputClass}
                        value={address}
                        onChange={(e) => {
                          setAddress(e.target.value);
                          setCheck(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void findAddress();
                          }
                        }}
                        placeholder="Số nhà, tên đường, phường, tỉnh/thành"
                        autoComplete="street-address"
                      />
                      <button type="button" className={`${secondaryButton} shrink-0`} onClick={findAddress} disabled={locating}>
                        {locating ? "Đang tìm…" : "Tìm trên bản đồ"}
                      </button>
                    </div>
                  </Field>
                  {locateError ? <p className="text-sm text-[#b42318]">{locateError}</p> : null}
                  {suggestions.length > 1 ? (
                    <div>
                      <p className="text-xs font-semibold text-[#806873]">Chọn kết quả đúng nhất:</p>
                      <ul className="mt-1.5 divide-y divide-[#f3dce6] overflow-hidden rounded-xl border border-[#edd4df]">
                        {suggestions.map((item, index) => (
                          <li key={`${item.lat},${item.lng},${index}`}>
                            <button
                              type="button"
                              onClick={() => chooseSuggestion(index)}
                              aria-pressed={chosen === index}
                              className={`flex min-h-11 w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm leading-5 transition ${chosen === index ? "bg-[#fff2f7] font-semibold text-[#bd3f75]" : "bg-white hover:bg-[#fff9f5]"}`}
                            >
                              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${chosen === index ? "bg-[#d94f8a]" : "bg-[#edd4df]"}`} />
                              {item.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="relative isolate overflow-hidden rounded-xl border border-[#edd4df] bg-[#fff9f5]">
                    <div ref={mapEl} className="h-[300px] w-full sm:h-[360px]" aria-label="Bản đồ chọn vị trí điểm bán" />
                    {mapState !== "ready" ? (
                      <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm leading-6 text-[#806873]">
                        {configError || mapState === "unavailable"
                          ? "Bản đồ tạm thời chưa sẵn sàng. Vui lòng quay lại sau hoặc gọi hotline 1900 555591."
                          : "Đang tải bản đồ…"}
                      </div>
                    ) : null}
                  </div>
                  <p className="text-xs leading-5 text-[#806873]">Kéo ghim hoặc chạm vào bản đồ để chỉnh đúng cửa điểm bán. Bản đồ đường phố có thể thiếu số nhà, hãy kiểm tra vị trí ghim.</p>

                  <button type="button" className={`${primaryButton} w-full`} onClick={runCheck} disabled={!pin || checking || address.trim().length < 8}>
                    {checking ? "Đang đo quãng đường…" : "Kiểm tra khoảng cách"}
                  </button>
                  {checkError ? <p className="text-sm text-[#b42318]">{checkError}</p> : null}
                  {check ? <CheckResult result={check} thresholdKm={thresholdKm} /> : null}
                </div>
              </div>

              {/* Step 2: applicant info */}
              {canContinue ? (
                <form onSubmit={submit} className="rounded-2xl border border-[#edd4df] bg-white p-5 sm:p-6" noValidate>
                  <StepTitle n={2} title="Thông tin người đăng ký" />
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field label="Họ và tên">
                      <input className={inputClass} value={form.applicant_name} onChange={update("applicant_name")} autoComplete="name" />
                    </Field>
                    <Field label="Tên hộ kinh doanh / doanh nghiệp" hint="Không bắt buộc">
                      <input className={inputClass} value={form.business_name} onChange={update("business_name")} autoComplete="organization" />
                    </Field>
                    <Field label="Số CCCD" hint="12 số (hoặc CMND 9 số)">
                      <input className={inputClass} value={form.cccd} onChange={update("cccd")} inputMode="numeric" maxLength={12} />
                    </Field>
                    <Field label="CCCD có giá trị đến">
                      <input className={inputClass} type="date" value={form.cccd_valid_until} onChange={update("cccd_valid_until")} />
                    </Field>
                  </div>
                  <div className="mt-4 space-y-3">
                    <label className="flex items-start gap-3 text-sm leading-6">
                      <input
                        type="checkbox"
                        className="mt-1 h-5 w-5 shrink-0 accent-[#d94f8a]"
                        checked={contractAddressSame}
                        onChange={(e) => setContractAddressSame(e.target.checked)}
                      />
                      <span>Địa chỉ bên ký hợp đồng giống địa chỉ bán hàng</span>
                    </label>
                    {!contractAddressSame ? (
                      <Field label="Địa chỉ bên ký hợp đồng" hint="Ghi theo giấy đăng ký kinh doanh hoặc CCCD. Địa chỉ này được điền vào hợp đồng.">
                        <input
                          className={inputClass}
                          value={contractAddress}
                          onChange={(e) => setContractAddress(e.target.value)}
                          placeholder="Số nhà, tên đường, phường, tỉnh/thành"
                          maxLength={500}
                        />
                      </Field>
                    ) : null}
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <VerifyField
                      id="phone"
                      label="Số điện thoại"
                      hint="Mã xác minh gửi qua Zalo của số này."
                      value={form.phone}
                      onChange={update("phone")}
                      inputProps={{ inputMode: "tel", autoComplete: "tel" }}
                      canSend={phoneShapeOk}
                      state={verify.phone}
                      now={now}
                      onSend={() => sendCode("phone")}
                      onCode={(code) => patchVerify("phone", { code, error: "" })}
                      onConfirm={() => confirmCode("phone")}
                    />
                    <VerifyField
                      id="email"
                      label="Email nhận hợp đồng"
                      hint="Mã xác minh gửi tới email này (xem cả mục Spam)."
                      value={form.email}
                      onChange={update("email")}
                      inputProps={{ type: "email", autoComplete: "email" }}
                      canSend={emailShapeOk}
                      state={verify.email}
                      now={now}
                      onSend={() => sendCode("email")}
                      onCode={(code) => patchVerify("email", { code, error: "" })}
                      onConfirm={() => confirmCode("email")}
                    />
                  </div>
                  <label className="mt-5 flex items-start gap-3 text-sm leading-6">
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0 accent-[#d94f8a]"
                      checked={form.terms_accepted}
                      onChange={(e) => setForm((prev) => ({ ...prev, terms_accepted: e.target.checked }))}
                    />
                    <span>Tôi đã đọc các ý chính ở trên và đồng ý nhận hợp đồng đại lý BMQ qua email. Hợp đồng chỉ có hiệu lực khi hai bên ký.</span>
                  </label>
                  {!verificationToken ? (
                    <p className="mt-4 text-sm text-[#806873]">Xác minh số điện thoại và email để gửi hồ sơ.</p>
                  ) : null}
                  {submitError ? <p className="mt-4 text-sm text-[#b42318]">{submitError}</p> : null}
                  <button type="submit" className={`${primaryButton} mt-5 w-full`} disabled={!formValid || submitting}>
                    {submitting ? "Đang gửi…" : check?.result === "manual_review" ? "Gửi hồ sơ cho BMQ" : "Nhận hợp đồng qua email"}
                  </button>
                </form>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <footer className="border-t border-[#f3dce6] bg-[#fff9f5]">
        <div className="mx-auto flex max-w-5xl flex-col gap-1 px-5 py-8 text-sm text-[#806873] sm:flex-row sm:justify-between sm:px-8">
          <span>Công ty Cổ phần Thực phẩm BMQ · Tầng 2, 68 Nguyễn Huệ, Phường Sài Gòn, TP.HCM</span>
          <a href="tel:1900555591" className="font-semibold text-[#bd3f75]">Hotline 1900 555591</a>
        </div>
      </footer>
    </div>
  );
}

type VerifyState = {
  sent: boolean;
  sending: boolean;
  checking: boolean;
  verified: boolean;
  code: string;
  error: string;
  resendAt: number;
};

const EMPTY_VERIFY: VerifyState = {
  sent: false,
  sending: false,
  checking: false,
  verified: false,
  code: "",
  error: "",
  resendAt: 0,
};

function VerifyField({
  id,
  label,
  hint,
  value,
  onChange,
  inputProps,
  canSend,
  state,
  now,
  onSend,
  onCode,
  onConfirm,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  inputProps: { inputMode?: "tel"; type?: string; autoComplete: string };
  canSend: boolean;
  state: VerifyState;
  now: number;
  onSend: () => void;
  onCode: (code: string) => void;
  onConfirm: () => void;
}) {
  const wait = Math.max(0, Math.ceil((state.resendAt - now) / 1000));
  const sendLabel = state.sending ? "Đang gửi…" : wait > 0 ? `Gửi lại (${wait}s)` : state.sent ? "Gửi lại mã" : "Gửi mã";
  return (
    <div data-verify-field={id}>
      <label htmlFor={`dealer-${id}`} className="text-sm font-semibold text-[#34252c]">{label}</label>
      <div className="mt-1.5 flex gap-2">
        <input
          id={`dealer-${id}`}
          className={`${inputClass} min-w-0 flex-1`}
          value={value}
          onChange={onChange}
          {...inputProps}
        />
        {state.verified ? (
          <span className="inline-flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-[#ecfdf3] px-3 text-sm font-semibold text-[#067647]">
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z" clipRule="evenodd" /></svg>
            Đã xác minh
          </span>
        ) : (
          <button
            type="button"
            className="inline-flex h-12 shrink-0 items-center justify-center rounded-xl border border-[#d94f8a] bg-white px-3.5 text-sm font-semibold text-[#bd3f75] transition hover:bg-[#fff1f6] disabled:cursor-not-allowed disabled:border-[#edd4df] disabled:text-[#b59aa6]"
            onClick={onSend}
            disabled={!canSend || state.sending || wait > 0}
          >
            {sendLabel}
          </button>
        )}
      </div>
      {state.sent && !state.verified ? (
        <div className="mt-2 flex gap-2">
          <input
            aria-label={`Mã xác minh ${label.toLowerCase()}`}
            className={`${inputClass} min-w-0 flex-1 tracking-[0.3em]`}
            value={state.code}
            onChange={(e) => onCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onConfirm();
              }
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 số"
          />
          <button
            type="button"
            className="inline-flex h-12 shrink-0 items-center justify-center rounded-xl bg-[#34252c] px-4 text-sm font-semibold text-white transition hover:bg-[#1f1519] disabled:opacity-50"
            onClick={onConfirm}
            disabled={state.checking || state.code.length !== 6}
          >
            {state.checking ? "Đang kiểm tra…" : "Xác nhận"}
          </button>
        </div>
      ) : null}
      {state.error ? (
        <p className="mt-1.5 text-sm text-[#b42318]">{state.error}</p>
      ) : (
        <p className="mt-1 text-xs leading-5 text-[#806873]">{hint}</p>
      )}
    </div>
  );
}

function StepTitle({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#d94f8a] text-sm font-bold text-white">{n}</span>
      <h3 className="text-lg font-bold">{title}</h3>
    </div>
  );
}

function CheckResult({ result, thresholdKm }: { result: DealerSignupCheckResult; thresholdKm: string }) {
  if (result.result === "too_close") {
    return (
      <div role="status" className="rounded-xl border border-[#f4c7c3] bg-[#fef3f2] p-4">
        <p className="font-bold text-[#b42318]">Chưa thể mở điểm tại vị trí này</p>
        <p className="mt-1 text-sm leading-6 text-[#7a271a]">
          Đã có đại lý BMQ cách khoảng {formatKm(result.nearest_distance_m)} đường xe máy
          {result.nearest_dealer_label ? ` (khu vực ${result.nearest_dealer_label})` : ""}, trong bán kính {thresholdKm}. Anh/chị có thể chọn một vị trí khác và kiểm tra lại.
        </p>
      </div>
    );
  }
  if (result.result === "manual_review") {
    return (
      <div role="status" className="rounded-xl border border-[#fedf89] bg-[#fffaeb] p-4">
        <p className="font-bold text-[#93370d]">BMQ cần kiểm tra thêm vị trí này</p>
        <p className="mt-1 text-sm leading-6 text-[#7a2e0e]">
          Hệ thống chưa kết luận tự động được. Anh/chị điền thông tin bên dưới, BMQ sẽ kiểm tra và liên hệ lại.
        </p>
      </div>
    );
  }
  return (
    <div role="status" className="rounded-xl border border-[#abefc6] bg-[#ecfdf3] p-4">
      <p className="font-bold text-[#067647]">Vị trí này mở được</p>
      <p className="mt-1 text-sm leading-6 text-[#085d3a]">
        {result.nearest_distance_m !== null
          ? `Đại lý gần nhất cách khoảng ${formatKm(result.nearest_distance_m)} đường xe máy.`
          : `Không có đại lý BMQ nào trong bán kính ${thresholdKm}.`}{" "}
        Điền thông tin bên dưới để nhận hợp đồng.
      </p>
    </div>
  );
}

function SubmittedCard({ result, email }: { result: DealerSignupSubmitResult; email: string }) {
  const sent = result.status === "contract_sent" || result.status === "approved_waiting_slip";
  const awaitingSlip = result.status === "approved_waiting_slip";
  const rejected = result.status === "rejected_too_close";
  return (
    <div role="status" className="mt-8 rounded-2xl border border-[#edd4df] bg-white p-6 sm:p-8">
      <p className="text-sm font-semibold text-[#bd3f75]">Mã hồ sơ {result.application_code}</p>
      <h3 className="mt-2 text-2xl font-bold">
        {sent ? "Hợp đồng đã được gửi" : rejected ? "Chưa thể mở điểm tại vị trí này" : "BMQ đã nhận hồ sơ"}
      </h3>
      <p className="mt-3 text-base leading-7 text-[#806873]">
        {sent
          ? awaitingSlip
            ? `BMQ đã gửi hợp đồng đại lý (PDF) tới ${email}, kèm link upload bank slip. Anh/chị đăng nhập được dathang.banhmique.vn bằng số điện thoại vừa đăng ký; sau khi upload bank slip là đặt bánh được.`
            : `BMQ đã gửi hợp đồng đại lý (PDF) tới ${email}. Anh/chị kiểm tra hộp thư (cả mục Spam), đọc kỹ, ký và gửi lại cho BMQ.`
          : rejected
          ? "Khi kiểm tra lại, vị trí này nằm trong bán kính của một đại lý BMQ hiện có. Anh/chị có thể chọn vị trí khác."
          : "Vị trí cần BMQ kiểm tra thêm. BMQ sẽ liên hệ anh/chị qua điện thoại hoặc email trong thời gian sớm nhất."}
      </p>
      <p className="mt-5 text-sm text-[#806873]">
        Cần hỗ trợ: <a href="tel:1900555591" className="font-semibold text-[#bd3f75]">1900 555591</a>
      </p>
    </div>
  );
}
