import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  AlertCircle,
  BadgePercent,
  BellRing,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  HelpCircle,
  Home,
  ImageIcon,
  KeyRound,
  Loader2,
  LockKeyhole,
  LogOut,
  MapPin,
  MessageCircle,
  Minus,
  PackagePlus,
  Phone,
  Plus,
  Send,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Timer,
  Truck,
  UserRound,
  WalletCards,
} from "lucide-react";
import bmqLogo from "@/assets/bmq-logo.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type LoginStep = "phone" | "otp" | "catalog";

type Product = {
  id: string;
  skuCode?: string;
  name: string;
  unit: string;
  packSize: string;
  price: number;
  tag: string;
  note: string;
  cutoff: string;
  imageUrl?: string | null;
  priceSource?: "cost_values_selling_price" | "customer_override";
};

type DealerCustomer = {
  id: string;
  name?: string | null;
  code?: string | null;
  group?: string | null;
  address?: string | null;
};

type CatalogProductResponse = {
  id: string;
  sku_code?: string | null;
  product_name?: string | null;
  category?: string | null;
  unit?: string | null;
  price_vnd?: number | string | null;
  unit_price?: number | string | null;
  price_source?: "cost_values_selling_price" | "customer_override";
  notes?: string | null;
  image_url?: string | null;
};

type CatalogResponse = {
  success?: boolean;
  products?: CatalogProductResponse[];
  announcements?: Array<{ id: string; title: string; body: string; severity?: string }>;
  customer?: DealerCustomer | null;
};

type DealerLandingBanner = {
  id?: string;
  eventLabel?: string;
  url?: string | null;
  path?: string | null;
  enabled?: boolean;
  contentTitle?: string;
  contentIntro?: string;
  contentHighlights?: string[];
  contentTerms?: string;
  contentNote?: string;
  published?: boolean;
};

type DealerPublicConfigResponse = {
  success?: boolean;
  landing?: {
    banner_url?: string | null;
    banner_path?: string | null;
    banners?: DealerLandingBanner[];
  };
};

const DEALER_SESSION_STORAGE_KEY = "bmq_dealer_session_token";
const DEALER_ORDER_STEP = 10;

const navItems = [
  { id: "home", label: "Trang chủ", icon: Home, target: "dealer-top" },
  { id: "order", label: "Đặt hàng", icon: ClipboardList, target: "quick-order" },
  { id: "delivery", label: "Giao hàng", icon: Truck, target: "delivery-plan" },
  { id: "support", label: "Hỗ trợ", icon: HelpCircle, target: "dealer-support" },
];

const formatVnd = (value: number) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value);

const mapCatalogProduct = (product: CatalogProductResponse): Product => {
  const price = Number(product.price_vnd ?? product.unit_price ?? 0) || 0;
  const priceSource = product.price_source || "cost_values_selling_price";

  return {
    id: product.id,
    skuCode: product.sku_code || undefined,
    name: product.product_name || product.sku_code || "Sản phẩm BMQ",
    unit: product.unit || "đơn vị",
    packSize: "Theo đơn vị bán",
    price,
    tag: priceSource === "customer_override" ? "Giá riêng" : product.category || "Thành phẩm",
    note: "Sản phẩm thành phẩm BMQ.",
    cutoff: "Chốt trước 20:00",
    imageUrl: product.image_url || null,
    priceSource,
  };
};

const getFunctionErrorMessage = async (error: unknown, fallback: string) => {
  const context = (error as { context?: Response })?.context;
  if (context?.clone) {
    try {
      const payload = await context.clone().json();
      if (typeof payload?.error === "string") return payload.error;
    } catch {
      // Fall through to default message.
    }
  }

  return error instanceof Error ? error.message : fallback;
};

export default function DealerPortal() {
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem(DEALER_SESSION_STORAGE_KEY) || "");
  const [loginStep, setLoginStep] = useState<LoginStep>(() =>
    localStorage.getItem(DEALER_SESSION_STORAGE_KEY) ? "catalog" : "phone",
  );
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [activeNav, setActiveNav] = useState("order");
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "live" | "error">("idle");
  const [catalogMessage, setCatalogMessage] = useState("Đăng nhập để xem sản phẩm và giá bán dành cho đại lý.");
  const [landingBannerUrl, setLandingBannerUrl] = useState("");
  const [landingBanners, setLandingBanners] = useState<DealerLandingBanner[]>([]);
  const [activeLandingBannerIndex, setActiveLandingBannerIndex] = useState(0);
  const [announcements, setAnnouncements] = useState<CatalogResponse["announcements"]>([]);
  const [dealerCustomer, setDealerCustomer] = useState<DealerCustomer | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [orderMessage, setOrderMessage] = useState("");
  const [orderError, setOrderError] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [activeCategory, setActiveCategory] = useState("Tất cả");

  const loadLandingConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke<DealerPublicConfigResponse>("dealer-public-config", {
        body: {},
      });

      if (error) throw error;
      const nextBanners = Array.isArray(data?.landing?.banners)
        ? data.landing.banners.filter((banner) => banner?.enabled !== false && Boolean(banner?.url)).slice(0, 3)
        : [];
      setLandingBanners(nextBanners);
      setActiveLandingBannerIndex(0);
      setLandingBannerUrl(nextBanners[0]?.url || data?.landing?.banner_url || "");
    } catch (error) {
      console.warn("Không tải được banner landing đại lý", error);
      setLandingBannerUrl("");
    }
  }, []);

  useEffect(() => {
    void loadLandingConfig();
  }, [loadLandingConfig]);

  useEffect(() => {
    if (landingBanners.length <= 1) return undefined;

    const timer = window.setInterval(() => {
      setActiveLandingBannerIndex((current) => (current + 1) % landingBanners.length);
    }, 5200);

    return () => window.clearInterval(timer);
  }, [landingBanners.length]);

  const loadCatalog = useCallback(async (token?: string) => {
    if (!token) {
      setCatalogProducts([]);
      setAnnouncements([]);
      setDealerCustomer(null);
      setCatalogStatus("idle");
      setCatalogMessage("Đăng nhập để xem sản phẩm và giá bán dành cho đại lý.");
      return;
    }

    setCatalogStatus("loading");

    try {
      const { data, error } = await supabase.functions.invoke<CatalogResponse>("dealer-catalog", {
        body: token ? { dealer_token: token } : {},
      });

      if (error) throw error;

      const nextProducts = Array.isArray(data?.products) ? data.products.map(mapCatalogProduct) : [];
      setCatalogProducts(nextProducts);
      setAnnouncements(data?.announcements || []);
      setDealerCustomer(data?.customer || null);
      setCatalogStatus("live");
      setCatalogMessage(
        nextProducts.length
          ? "Sản phẩm và giá bán đã sẵn sàng để đặt hàng."
          : "Chưa có sản phẩm đang mở bán trên trang đặt hàng.",
      );
    } catch (error) {
      const message = await getFunctionErrorMessage(error, "Không tải được danh sách sản phẩm.");
      setCatalogProducts([]);
      setAnnouncements([]);
      setCatalogStatus("error");
      setCatalogMessage(message || "Không tải được danh sách sản phẩm.");
    }
  }, []);

  useEffect(() => {
    void loadCatalog(sessionToken);
  }, [loadCatalog, sessionToken]);

  const handleStartAuth = async () => {
    setAuthLoading(true);
    setAuthError("");
    setAuthMessage("");
    setOrderMessage("");
    setOrderError("");

    try {
      const { data, error } = await supabase.functions.invoke<{
        success?: boolean;
        message?: string;
        dev_otp?: string;
      }>("dealer-auth-start", {
        body: { phone },
      });

      if (error) throw error;

      setLoginStep("otp");
      setAuthMessage(
        data?.dev_otp
          ? `${data.message || "Đã tạo OTP."} Dev OTP: ${data.dev_otp}`
          : data?.message || "Nếu số điện thoại hợp lệ, mã OTP sẽ được gửi qua Zalo.",
      );
    } catch (error) {
      setAuthError(await getFunctionErrorMessage(error, "Không gửi được mã OTP."));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleVerifyAuth = async () => {
    setAuthLoading(true);
    setAuthError("");
    setAuthMessage("");

    try {
      const { data, error } = await supabase.functions.invoke<{
        success?: boolean;
        dealer_token?: string;
        customer?: DealerCustomer | null;
      }>("dealer-auth-verify", {
        body: { phone, otp },
      });

      if (error) throw error;
      if (!data?.dealer_token) throw new Error("Không nhận được phiên đại lý.");

      localStorage.setItem(DEALER_SESSION_STORAGE_KEY, data.dealer_token);
      setSessionToken(data.dealer_token);
      setDealerCustomer(data.customer || null);
      setLoginStep("catalog");
      setOtp("");
      setAuthMessage("Đã xác thực đại lý. Anh có thể gửi đơn thật.");
    } catch (error) {
      setAuthError(await getFunctionErrorMessage(error, "Không xác thực được OTP."));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogoutDealer = () => {
    localStorage.removeItem(DEALER_SESSION_STORAGE_KEY);
    setSessionToken("");
    setDealerCustomer(null);
    setLoginStep("phone");
    setOtp("");
    setAuthMessage("");
    setAuthError("");
    setOrderMessage("");
    setOrderError("");
  };

  const handleSubmitOrder = async () => {
    if (!sessionToken || selectedLines.length === 0) return;

    const invalidQuantityLine = selectedLines.find((line) => line.quantity % DEALER_ORDER_STEP !== 0);
    if (invalidQuantityLine) {
      setOrderError(`Số lượng ${invalidQuantityLine.name} phải là bội số ${DEALER_ORDER_STEP}.`);
      return;
    }

    setOrderSubmitting(true);
    setOrderMessage("");
    setOrderError("");

    try {
      const { data, error } = await supabase.functions.invoke<{
        success?: boolean;
        order_number?: string;
        total_amount_vnd?: number;
      }>("dealer-order-submit", {
        body: {
          dealer_token: sessionToken,
          items: selectedLines.map((line) => ({
            sku_id: line.id,
            quantity: line.quantity,
          })),
        },
      });

      if (error) throw error;

      setOrderMessage(`Đã gửi đơn ${data?.order_number || ""}. BMQ sẽ xác nhận lại theo lịch giao hàng.`);
      setQuantities({});
    } catch (error) {
      setOrderError(await getFunctionErrorMessage(error, "Không gửi được đơn hàng."));
    } finally {
      setOrderSubmitting(false);
    }
  };

  const selectedLines = useMemo(
    () =>
      catalogProducts
        .map((product) => ({
          ...product,
          quantity: quantities[product.id] || 0,
          lineTotal: (quantities[product.id] || 0) * product.price,
        }))
        .filter((product) => product.quantity > 0),
    [catalogProducts, quantities],
  );

  const totalItems = selectedLines.reduce((sum, product) => sum + product.quantity, 0);
  const cartTotal = selectedLines.reduce((sum, product) => sum + product.lineTotal, 0);
  const isCatalogUnlocked = loginStep === "catalog" && Boolean(sessionToken);
  const dealerDisplayName = dealerCustomer?.name || dealerCustomer?.code || "Đại lý BMQ";
  const activeLandingBanner = landingBanners[activeLandingBannerIndex] || landingBanners[0];
  const activeLandingBannerUrl = activeLandingBanner?.url || landingBannerUrl;
  const activePromotionPath = window.location.hostname === "dathang.banhmique.vn"
    ? `/promotion/${activeLandingBanner?.id || "event-1"}`
    : `/dealer/promotion/${activeLandingBanner?.id || "event-1"}`;
  const categoryChips = ["Tất cả", "Bánh mì", "Bánh ngọt", "Combo", "Bán chạy"];
  const featuredProducts = catalogProducts.slice(0, 3);
  const filteredProducts = catalogProducts.filter((product) => {
    if (activeCategory === "Tất cả") return true;
    const haystack = `${product.name} ${product.tag}`.toLowerCase();
    if (activeCategory === "Bánh mì") return haystack.includes("bánh mì") || haystack.includes("que") || haystack.includes("pate");
    if (activeCategory === "Bánh ngọt") return haystack.includes("ngọt") || haystack.includes("bánh bao") || haystack.includes("cake");
    if (activeCategory === "Combo") return haystack.includes("combo") || haystack.includes("set");
    if (activeCategory === "Bán chạy") return featuredProducts.some((item) => item.id === product.id);
    return true;
  });

  const updateQuantity = (productId: string, delta: number) => {
    setQuantities((current) => {
      const normalizedCurrent = Math.round((current[productId] || 0) / DEALER_ORDER_STEP) * DEALER_ORDER_STEP;

      return {
        ...current,
        [productId]: Math.max(0, normalizedCurrent + delta * DEALER_ORDER_STEP),
      };
    });
  };

  const handleNav = (item: (typeof navItems)[number]) => {
    setActiveNav(item.id);
    document.getElementById(item.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <img src={bmqLogo} alt="BMQ" className="h-9 w-auto shrink-0" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold leading-tight">Bánh Mì Que</div>
              <div className="truncate text-xs text-muted-foreground">Portal đặt hàng đại lý</div>
            </div>
          </div>
          {isCatalogUnlocked ? (
            <div className="flex min-w-0 max-w-[52vw] items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-[#3f2411] shadow-sm">
              <Building2 className="h-4 w-4 shrink-0 text-amber-700" />
              <span className="truncate text-sm font-semibold">{dealerDisplayName}</span>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="h-9 px-3" onClick={() => handleNav(navItems[3])}>
              <MessageCircle className="h-4 w-4" />
              Zalo OA
            </Button>
          )}
        </div>
      </header>

      {isCatalogUnlocked ? (
        <section id="dealer-top" className="bg-[#fffaf0] text-[#3f2411]">
          <div className="mx-auto max-w-6xl px-4 pb-3 pt-4 md:pb-5 md:pt-6">
            <div className="overflow-hidden rounded-[28px] border border-amber-200 bg-gradient-to-br from-[#fff7df] via-[#fffaf0] to-[#eefbea] shadow-xl shadow-amber-900/10">
              <div className="grid gap-0 md:grid-cols-[1.05fr_0.95fr]">
                <div className="space-y-4 p-5 sm:p-6 md:p-7">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="rounded-full bg-amber-500 text-[#2b1708] hover:bg-amber-500">
                      <Sparkles className="h-3.5 w-3.5" />
                      Ưu đãi hôm nay
                    </Badge>
                    <Badge variant="outline" className="rounded-full border-amber-300 bg-white/70 text-amber-800">
                      Mua 10 tặng 1
                    </Badge>
                    <Badge variant="outline" className="rounded-full border-emerald-200 bg-emerald-50 text-emerald-700">
                      Freeship từ 500k
                    </Badge>
                  </div>
                  <div>
                    <h1 className="text-3xl font-display font-extrabold leading-[1.05] tracking-tight sm:text-4xl">
                      Tăng đơn dễ hơn với combo bán chạy
                    </h1>
                    <p className="mt-3 max-w-xl text-sm leading-6 text-[#765333] sm:text-base">
                      Xem nhanh chương trình khuyến mãi, thêm sản phẩm bán kèm và gửi đơn đại lý chỉ trong vài thao tác.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      className="h-12 rounded-2xl bg-amber-500 px-5 text-base font-bold text-[#2b1708] shadow-lg shadow-amber-900/20 hover:bg-amber-400"
                      onClick={() => document.getElementById("quick-order")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                    >
                      <PackagePlus className="h-4 w-4" />
                      Thêm combo
                    </Button>
                    <Button
                      asChild
                      variant="outline"
                      className="h-12 rounded-2xl border-amber-300 bg-white/80 px-5 text-[#5b3418] hover:bg-amber-50"
                    >
                      <a href={activePromotionPath}>
                        Xem chương trình
                        <ChevronRight className="h-4 w-4" />
                      </a>
                    </Button>
                  </div>
                </div>
                <div className="relative min-h-[220px] overflow-hidden bg-[#2b1708] md:min-h-full">
                  {activeLandingBannerUrl ? (
                    <img src={activeLandingBannerUrl} alt={activeLandingBanner?.eventLabel || "Ưu đãi đại lý BMQ"} className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full bg-[radial-gradient(circle_at_70%_25%,rgba(245,158,11,0.55),transparent_28%),linear-gradient(135deg,#7c2d12,#f59e0b_55%,#fff7ed)]" />
                  )}

                </div>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section id="dealer-top" className="border-b bg-[#16110d] text-amber-50">
          <div className="mx-auto max-w-6xl px-4 py-4 pb-6 md:py-5">
            <div className="overflow-hidden rounded-[28px] border border-amber-400/20 bg-gradient-to-br from-[#3b210d] via-[#25160e] to-[#120d09] shadow-2xl shadow-black/35">
              <div className="relative h-[210px] overflow-hidden bg-[#24150d] sm:h-[240px] md:h-[300px] lg:h-[340px]">
                {activeLandingBannerUrl ? (
                  <img src={activeLandingBannerUrl} alt={activeLandingBanner?.eventLabel || "Banner khuyến mãi BMQ"} className="h-full w-full object-contain" />
                ) : (
                  <div className="h-full w-full bg-[radial-gradient(circle_at_78%_18%,rgba(245,178,65,0.42),transparent_28%),linear-gradient(135deg,rgba(197,121,19,0.36),transparent_48%)]" />
                )}
                <Button
                  asChild
                  size="sm"
                  className="absolute bottom-3 right-3 h-9 rounded-full bg-amber-500/95 px-4 text-sm font-semibold text-[#1b1208] shadow-lg shadow-black/25 hover:bg-amber-400"
                >
                  <a href={activePromotionPath}>
                    Xem ngay
                    <ChevronRight className="h-4 w-4" />
                  </a>
                </Button>
                {landingBanners.length > 1 ? (
                  <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/20 px-2 py-1 backdrop-blur-sm">
                    {landingBanners.map((banner, index) => (
                      <button
                        key={banner.id || index}
                        type="button"
                        className={cn("h-1.5 rounded-full transition-all", index === activeLandingBannerIndex ? "w-5 bg-white" : "w-1.5 bg-white/55")}
                        aria-label={`Xem banner ${index + 1}`}
                        onClick={() => setActiveLandingBannerIndex(index)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-4 p-5 sm:p-6 md:flex-row md:items-end md:justify-between md:p-7 lg:p-8">
                <div className="space-y-3">
                  <Badge className="rounded-full border border-amber-300/40 bg-amber-400/15 px-3 py-1 text-amber-100 hover:bg-amber-400/15">
                    <Sparkles className="h-3.5 w-3.5" />
                    Khuyến mãi tháng này
                  </Badge>
                  <div className="max-w-2xl space-y-2">
                    <h1 className="text-3xl font-display font-bold leading-[1.05] tracking-tight text-white sm:text-4xl md:text-[2.5rem]">
                      Ưu đãi đơn sỉ cho đại lý BMQ
                    </h1>
                    <p className="max-w-xl text-sm leading-6 text-amber-50/82 sm:text-base">
                      Đăng nhập để xem giá riêng, chương trình đang áp dụng và gửi đơn xác nhận cho BMQ.
                    </p>
                  </div>
                </div>

                <div className="space-y-3 md:min-w-[240px] md:text-right">
                  <Button
                    className="h-12 w-full rounded-2xl bg-amber-500 text-base font-semibold text-[#1b1208] shadow-lg shadow-amber-950/30 hover:bg-amber-400 md:w-auto md:px-6"
                    onClick={() => document.getElementById("dealer-login")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  >
                    <Phone className="h-4 w-4" />
                    Đăng nhập để đặt hàng
                  </Button>
                  <div className="text-center text-xs text-amber-50/75 md:text-right">Cần hỗ trợ? Gọi CSKH / Zalo OA BMQ</div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      <main className={cn("mx-auto grid max-w-6xl gap-4 px-4 pt-4", isCatalogUnlocked ? "bg-[#fffaf0] pb-40 lg:grid-cols-[minmax(0,1fr)_340px] lg:pb-12" : "pb-28")}>
        <div className="space-y-4">
          <Card id="dealer-login" className="scroll-mt-24 rounded-md">
            <CardHeader className="p-4 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-lg">Đăng nhập đại lý</CardTitle>
                  <CardDescription className="mt-1">
                    Xác thực số điện thoại bằng OTP Zalo trước khi đặt hàng.
                  </CardDescription>
                </div>
                <Badge variant={loginStep === "catalog" ? "default" : "outline"} className="shrink-0 rounded-md">
                  {loginStep === "catalog" ? "Đã xác thực" : "Cần OTP"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-0">
              {authMessage ? (
                <div className="flex items-start gap-2 rounded-md border bg-success/10 p-3 text-sm text-success">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{authMessage}</span>
                </div>
              ) : null}
              {authError ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              ) : null}
              {loginStep === "catalog" ? (
                <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/50 p-3 text-sm">
                  <span className="truncate text-muted-foreground">Phiên đại lý đang hoạt động.</span>
                  <Button variant="ghost" size="sm" onClick={handleLogoutDealer}>
                    <LogOut className="h-4 w-4" />
                    Đăng xuất
                  </Button>
                </div>
              ) : null}
              {loginStep === "phone" ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="dealer-phone">Số điện thoại đại lý</Label>
                    <div className="relative">
                      <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="dealer-phone"
                        inputMode="tel"
                        placeholder="09xx xxx xxx"
                        value={phone}
                        onChange={(event) => setPhone(event.target.value)}
                        className="h-12 pl-9"
                      />
                    </div>
                  </div>
                  <div className="rounded-md border border-dashed bg-muted/50 p-3 text-sm text-muted-foreground">
                    Hệ thống sẽ kiểm tra số điện thoại đã đăng ký và gửi OTP qua Zalo nếu hợp lệ.
                  </div>
                  <Button className="h-11 w-full btn-gradient" onClick={handleStartAuth} disabled={authLoading}>
                    {authLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                    Gửi mã OTP Zalo
                  </Button>
                </div>
              ) : null}

              {loginStep === "otp" ? (
                <div className="space-y-4">
                  <div className="rounded-md bg-muted/60 p-3 text-sm">
                    <div className="font-medium">OTP Zalo</div>
                    <div className="mt-1 text-muted-foreground">
                      Nhập mã OTP đã gửi qua Zalo cho {phone.trim() || "số điện thoại đại lý"}.
                    </div>
                  </div>
                  <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                    <InputOTPGroup className="w-full justify-between gap-2">
                      {[0, 1, 2, 3, 4, 5].map((index) => (
                        <InputOTPSlot key={index} index={index} className="h-11 w-10 rounded-md border" />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" className="h-11" onClick={() => setLoginStep("phone")}>
                      Đổi số
                    </Button>
                    <Button className="h-11" onClick={handleVerifyAuth} disabled={authLoading || otp.length !== 6}>
                      {authLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Xác thực OTP
                    </Button>
                  </div>
                </div>
              ) : null}

              {loginStep === "catalog" ? (
                <div className="flex items-start gap-3 rounded-md border bg-success/10 p-3 text-sm">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <div>
                    <div className="font-medium">{dealerCustomer?.name || "Đại lý đã xác thực"}</div>
                    <div className="mt-1 text-muted-foreground">
                      Phiên OTP hợp lệ. Đơn gửi sẽ được BMQ tiếp nhận và xác nhận.
                    </div>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {isCatalogUnlocked ? (
            <div className="contents">
          <section id="quick-order" className="scroll-mt-24 space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">Đặt hàng đại lý</div>
                <h2 className="text-2xl font-display font-extrabold text-[#3f2411]">Sản phẩm & gợi ý bán kèm</h2>
                <p className="mt-1 text-sm text-[#765333]">{catalogMessage} Số lượng đặt theo bội số 10 bánh.</p>
              </div>
              <Badge variant="outline" className="rounded-full border-amber-300 bg-white text-amber-800">
                {catalogStatus === "loading" ? "Đang tải" : `${catalogProducts.length} sản phẩm`}
              </Badge>
            </div>

            {orderMessage ? (
              <div className="flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{orderMessage}</span>
              </div>
            ) : null}
            {orderError ? (
              <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{orderError}</span>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["Combo sáng mai", "Thêm nhóm món dễ bán cho ca sáng", "bg-amber-500/15 text-amber-800"],
                ["Bán chạy", "Ưu tiên các món đại lý hay đặt", "bg-emerald-500/12 text-emerald-700"],
                ["Sản phẩm mới", "Gợi ý để đại lý thử bán thêm", "bg-orange-500/12 text-orange-700"],
              ].map(([title, desc, tone]) => (
                <button
                  key={title}
                  type="button"
                  className="group rounded-2xl border border-amber-100 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md"
                  onClick={() => setActiveCategory(title === "Bán chạy" ? "Bán chạy" : title === "Combo sáng mai" ? "Combo" : "Tất cả")}
                >
                  <div className={cn("mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl", tone)}>
                    <BadgePercent className="h-5 w-5" />
                  </div>
                  <div className="font-bold text-[#3f2411]">{title}</div>
                  <div className="mt-1 text-sm leading-5 text-[#765333]">{desc}</div>
                </button>
              ))}
            </div>

            <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none]">
              {categoryChips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className={cn(
                    "h-10 shrink-0 rounded-full border px-4 text-sm font-semibold transition",
                    activeCategory === chip
                      ? "border-amber-500 bg-amber-500 text-[#2b1708] shadow-sm"
                      : "border-amber-200 bg-white text-[#765333] hover:border-amber-400 hover:bg-amber-50",
                  )}
                  onClick={() => setActiveCategory(chip)}
                >
                  {chip}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {catalogProducts.length === 0 ? (
                <div className="col-span-2 rounded-2xl border border-dashed border-amber-200 bg-white p-5 text-sm text-[#765333] md:col-span-3">
                  {catalogStatus === "loading"
                    ? "Đang tải sản phẩm..."
                    : "Chưa có sản phẩm để đặt. Vui lòng liên hệ BMQ để được hỗ trợ."}
                </div>
              ) : null}
              {filteredProducts.map((product) => {
                const quantity = quantities[product.id] || 0;

                return (
                  <Card key={product.id} className="overflow-hidden rounded-3xl border-amber-100 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md">
                    <CardContent className="flex h-full flex-col gap-3 p-3">
                      <div className="relative overflow-hidden rounded-2xl border border-amber-100 bg-amber-50">
                        {product.imageUrl ? (
                          <img
                            src={product.imageUrl}
                            alt={product.name}
                            loading="lazy"
                            className="h-32 w-full object-cover sm:h-36"
                          />
                        ) : (
                          <div className="flex h-32 w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_70%_20%,rgba(245,158,11,0.28),transparent_30%),linear-gradient(135deg,#fff7ed,#fef3c7)] text-amber-800 sm:h-36">
                            <ImageIcon className="h-6 w-6" />
                            <span className="text-xs font-medium">Ảnh sản phẩm</span>
                          </div>
                        )}
                        <Badge className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-white">
                          {product.tag}
                        </Badge>
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="line-clamp-2 text-sm font-extrabold leading-snug text-[#3f2411] sm:text-base">{product.name}</h3>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#765333]">{product.note}</p>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-extrabold text-[#3f2411]">{formatVnd(product.price)}</div>
                          <div className="text-xs text-[#8a6a4a]">/{product.unit}</div>
                        </div>
                        <div className="grid h-11 w-32 shrink-0 grid-cols-[38px_1fr_38px] overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/70">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-11 rounded-none text-[#5b3418]"
                            aria-label={`Giảm ${product.name}`}
                            onClick={() => updateQuantity(product.id, -1)}
                          >
                            <Minus className="h-4 w-4" />
                          </Button>
                          <div className="flex flex-col items-center justify-center border-x border-amber-200 leading-none text-[#3f2411]">
                            <span className="text-sm font-bold">{quantity}</span>
                            <span className="mt-0.5 text-[9px] font-semibold uppercase text-[#8a6a4a]">bước 10</span>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-11 rounded-none bg-amber-500/95 text-[#2b1708] hover:bg-amber-400"
                            aria-label={`Tăng ${product.name}`}
                            onClick={() => updateQuantity(product.id, 1)}
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {featuredProducts.length ? (
              <div className="rounded-3xl border border-amber-100 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-display font-extrabold text-[#3f2411]">Đại lý thường đặt kèm</h3>
                    <p className="mt-1 text-sm text-[#765333]">Gợi ý cross-sale để tăng giá trị đơn hàng.</p>
                  </div>
                  <ShoppingCart className="h-5 w-5 text-amber-600" />
                </div>
                <div className="mt-3 space-y-2">
                  {featuredProducts.map((product) => (
                    <div key={product.id} className="flex items-center gap-3 rounded-2xl border border-amber-100 bg-amber-50/60 p-3">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white text-amber-700">
                        {product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-full w-full object-cover" /> : <PackagePlus className="h-5 w-5" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold text-[#3f2411]">{product.name}</div>
                        <div className="text-xs text-[#765333]">{formatVnd(product.price)} / {product.unit}</div>
                      </div>
                      <Button type="button" size="sm" className="h-10 rounded-2xl bg-[#3f2411] px-3 text-amber-50 hover:bg-[#5b3418]" onClick={() => updateQuantity(product.id, 1)}>
                        Thêm
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section id="delivery-plan" className="scroll-mt-24 space-y-3">
            <h2 className="text-xl font-display font-bold">Giao hàng & thanh toán</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <StatusTile
                icon={CalendarDays}
                title="Lịch giao"
                description="Khung chính: sáng hôm sau; tuyến giao sẽ được BMQ xác nhận theo địa chỉ đã đăng ký."
              />
              <StatusTile
                icon={MapPin}
                title="Điểm nhận"
                description="Địa chỉ giao hàng sẽ được xác nhận theo thông tin đại lý đã đăng ký."
              />
              <StatusTile
                icon={WalletCards}
                title="Công nợ"
                description="COD hoặc công nợ theo chính sách đã duyệt, chưa tính tự động."
              />
            </div>
          </section>

          <section id="dealer-support" className="scroll-mt-24 space-y-3">
            <h2 className="text-xl font-display font-bold">Hỗ trợ đơn hàng</h2>
            <div className="rounded-md border bg-card p-4">
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-primary/10 p-2 text-primary">
                  <UserRound className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">Kênh hỗ trợ đại lý</div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Kênh Zalo OA/hotline sẽ dùng cho xác nhận đơn, đổi đơn sau cutoff và hỗ trợ giao hàng.
                  </p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button variant="outline" disabled>
                  <Phone className="h-4 w-4" />
                  Hotline
                </Button>
                <Button variant="outline" disabled>
                  <MessageCircle className="h-4 w-4" />
                  Zalo OA
                </Button>
              </div>
            </div>
          </section>
            </div>
          ) : (
            <PublicLandingSupport />
          )}
        </div>

        {isCatalogUnlocked ? (
          <aside className="hidden lg:block">
            <div className="sticky top-20">
              <CartSummary
                selectedLines={selectedLines}
                totalItems={totalItems}
                cartTotal={cartTotal}
                canSubmit={Boolean(sessionToken) && catalogStatus === "live" && selectedLines.length > 0}
                submitting={orderSubmitting}
                onSubmit={handleSubmitOrder}
              />
            </div>
          </aside>
        ) : null}
      </main>

      {isCatalogUnlocked ? (
        <div className="fixed inset-x-0 bottom-14 z-30 border-t bg-card/95 px-4 py-3 shadow-lg backdrop-blur lg:hidden">
          <div className="mx-auto max-w-6xl">
            <CartSummary
              selectedLines={selectedLines}
              totalItems={totalItems}
              cartTotal={cartTotal}
              compact
              canSubmit={Boolean(sessionToken) && catalogStatus === "live" && selectedLines.length > 0}
              submitting={orderSubmitting}
              onSubmit={handleSubmitOrder}
            />
          </div>
        </div>
      ) : (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-amber-400/20 bg-[#16110d]/95 px-4 py-3 text-amber-50 shadow-2xl backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-md items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Đăng nhập / OTP</div>
              <div className="truncate text-xs text-amber-50/65">Phiên bảo mật 30 ngày</div>
            </div>
            <Button
              size="sm"
              className="shrink-0 rounded-xl bg-amber-500 text-[#1b1208] hover:bg-amber-400"
              onClick={() => document.getElementById("dealer-login")?.scrollIntoView({ behavior: "smooth", block: "center" })}
            >
              <KeyRound className="h-4 w-4" />
              Đăng nhập
            </Button>
          </div>
        </div>
      )}

      {isCatalogUnlocked ? (
        <nav
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-2 pt-1 backdrop-blur lg:hidden"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.25rem)" }}
        >
        <div className="mx-auto grid max-w-md grid-cols-4">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeNav === item.id;

            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "flex h-12 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium text-muted-foreground transition-colors",
                  isActive && "bg-primary/10 text-primary",
                )}
                onClick={() => handleNav(item)}
              >
                <Icon className="h-4 w-4" />
                <span className="max-w-full truncate px-1">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      ) : null}
    </div>
  );
}

function PublicLandingSupport() {
  const benefits = [
    { icon: BadgePercent, title: "Giá đại lý riêng", description: "Giá bán và chương trình chỉ mở sau khi xác thực đúng hồ sơ đại lý." },
    { icon: Timer, title: "Chốt đơn nhanh", description: "Gửi đơn theo khung BMQ, hạn chế gọi lại thủ công." },
    { icon: ShieldCheck, title: "Theo dõi xác nhận", description: "Đơn được ghi nhận để đội BMQ kiểm tra và xác nhận." },
  ];

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden rounded-2xl border-amber-200/40 bg-gradient-to-br from-amber-50 via-card to-card shadow-sm dark:border-amber-500/20 dark:from-amber-950/25">
        <CardContent className="space-y-4 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-amber-500/15 p-3 text-amber-700 dark:text-amber-300">
              <LockKeyhole className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold">Sản phẩm & giá bán chỉ hiển thị sau khi đăng nhập đại lý.</div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Landing page public chỉ dùng để giới thiệu chương trình và đăng nhập. Catalog, giá riêng và nút đặt hàng sẽ được mở sau OTP.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-xl font-display font-bold">Quyền lợi đại lý</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {benefits.map((item) => {
            const Icon = item.icon;
            return (
              <Card key={item.title} className="rounded-2xl">
                <CardContent className="space-y-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="font-semibold">{item.title}</div>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.description}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-display font-bold">Cách đặt hàng</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ["1", "Nhập SĐT", "Dùng số điện thoại đại lý đã đăng ký."],
            ["2", "Xác thực OTP", "Nhận và nhập mã OTP qua Zalo."],
            ["3", "Đặt hàng", "Xem catalog, chọn số lượng và gửi đơn xác nhận."],
          ].map(([step, title, description]) => (
            <div key={step} className="rounded-2xl border bg-card p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{step}</div>
                <div>
                  <div className="font-semibold">{title}</div>
                  <div className="mt-1 text-sm leading-5 text-muted-foreground">{description}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatusTile({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-center gap-2 font-semibold">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}

function CartSummary({
  selectedLines,
  totalItems,
  cartTotal,
  compact = false,
  canSubmit,
  submitting,
  onSubmit,
}: {
  selectedLines: Array<Product & { quantity: number; lineTotal: number }>;
  totalItems: number;
  cartTotal: number;
  compact?: boolean;
  canSubmit: boolean;
  submitting: boolean;
  onSubmit: () => void;
}) {
  if (compact) {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShoppingCart className="h-4 w-4 text-primary" />
            {selectedLines.length} dòng • {totalItems} bánh
          </div>
          <div className="truncate text-xs text-muted-foreground">Tạm tính {formatVnd(cartTotal)}</div>
        </div>
        <Button size="sm" disabled={!canSubmit || submitting} onClick={onSubmit} className="shrink-0">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Gửi đơn
        </Button>
      </div>
    );
  }

  return (
    <Card className="rounded-md">
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShoppingCart className="h-5 w-5 text-primary" />
          Giỏ hàng
        </CardTitle>
        <CardDescription>Đơn sẽ được gửi cho BMQ sau khi đại lý xác thực OTP.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <div className="space-y-3">
          {selectedLines.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              Chưa chọn sản phẩm.
            </div>
          ) : (
            selectedLines.map((line) => (
              <div key={line.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{line.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {line.quantity} x {line.unit}
                  </div>
                </div>
                <div className="shrink-0 font-medium">{formatVnd(line.lineTotal)}</div>
              </div>
            ))
          )}
        </div>

        <div className="border-t pt-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Tổng số bánh</span>
            <span>{totalItems}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-base font-semibold">
            <span>Tạm tính</span>
            <span>{formatVnd(cartTotal)}</span>
          </div>
        </div>

        <Button className="h-11 w-full" disabled={!canSubmit || submitting} onClick={onSubmit}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
          Gửi đơn
        </Button>
        <p className="text-xs leading-5 text-muted-foreground">
          Cần OTP hợp lệ và danh sách sản phẩm đang mở bán trước khi gửi đơn.
        </p>
      </CardContent>
    </Card>
  );
}
