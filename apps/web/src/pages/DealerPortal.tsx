import { useCallback, useEffect, useMemo, useState, type ComponentType, type Dispatch, type SetStateAction } from "react";
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
  PackagePlus,
  Phone,
  Search,
  Send,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Timer,
  UserRound,
  WalletCards,
} from "lucide-react";
import bmqLogo from "@/assets/bmq-logo.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";
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
  shelfLifeDays?: number | null;
  netWeightValue?: number | null;
  netWeightUnit?: string | null;
};

type DealerCustomer = {
  id: string;
  name?: string | null;
  code?: string | null;
  group?: string | null;
  address?: string | null;
};

type DealerRoute = {
  id: string;
  name: string;
  code?: string | null;
  address?: string | null;
};

type NppOrderLine = {
  route: DealerRoute;
  product: Product;
  quantity: number;
  exchangeQuantity: number;
  makeupQuantity: number;
  physicalQuantity: number;
  note: string;
  lineTotal: number;
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
  shelf_life_days?: number | string | null;
  net_weight_value?: number | string | null;
  net_weight_unit?: string | null;
};

type CatalogResponse = {
  success?: boolean;
  products?: CatalogProductResponse[];
  announcements?: Array<{ id: string; title: string; body: string; severity?: string }>;
  customer?: DealerCustomer | null;
  dealer_routes?: DealerRoute[];
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
const DEALER_PROFILE_CACHE_KEY = "bmq_dealer_profile_cache";
const DEALER_CATALOG_CACHE_KEY = "bmq_dealer_catalog_cache";
const DEALER_ORDER_STEP = 10;

type DealerProfileCache = {
  customer: DealerCustomer | null;
  hasDealerRoutes: boolean;
};

type DealerCatalogCache = {
  products: Product[];
  announcements: CatalogResponse["announcements"];
  dealerRoutes: DealerRoute[];
};

const readDealerProfileCache = (): DealerProfileCache => {
  try {
    const raw = localStorage.getItem(DEALER_PROFILE_CACHE_KEY);
    if (!raw) return { customer: null, hasDealerRoutes: false };
    const parsed = JSON.parse(raw) as Partial<DealerProfileCache>;
    return {
      customer: parsed.customer || null,
      hasDealerRoutes: Boolean(parsed.hasDealerRoutes),
    };
  } catch {
    return { customer: null, hasDealerRoutes: false };
  }
};

const readDealerCatalogCache = (): DealerCatalogCache => {
  try {
    const raw = localStorage.getItem(DEALER_CATALOG_CACHE_KEY);
    if (!raw) return { products: [], announcements: [], dealerRoutes: [] };
    const parsed = JSON.parse(raw) as Partial<DealerCatalogCache>;
    return {
      products: Array.isArray(parsed.products) ? parsed.products : [],
      announcements: Array.isArray(parsed.announcements) ? parsed.announcements : [],
      dealerRoutes: Array.isArray(parsed.dealerRoutes) ? parsed.dealerRoutes : [],
    };
  } catch {
    return { products: [], announcements: [], dealerRoutes: [] };
  }
};

const navItems = [
  { id: "home", label: "Trang chủ", icon: Home },
  { id: "products", label: "Sản phẩm", icon: PackagePlus },
  { id: "order", label: "Đặt hàng", icon: ClipboardList },
  { id: "support", label: "Hỗ trợ", icon: HelpCircle },
];

const formatVnd = (value: number) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value);

const toNullableNumber = (value: number | string | null | undefined) => {
  if (value === null || value === undefined || value === "") return null;
  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : null;
};

const formatProductWeight = (product: Pick<Product, "netWeightValue" | "netWeightUnit">) => {
  const value = product.netWeightValue;
  if (value === null || value === undefined) return "Chưa cấu hình";
  const formatted = Number.isInteger(value) ? String(value) : value.toLocaleString("vi-VN");
  return `${formatted}${product.netWeightUnit || "g"}`;
};

const formatProductShelfLife = (product: Pick<Product, "shelfLifeDays">) => {
  const days = product.shelfLifeDays;
  if (!days || days < 1) return "Chưa cấu hình";
  return `${days} ngày`;
};

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
    shelfLifeDays: toNullableNumber(product.shelf_life_days),
    netWeightValue: toNullableNumber(product.net_weight_value),
    netWeightUnit: product.net_weight_unit || null,
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

const toDisplayName = (value?: string | null) =>
  (value || "")
    .trim()
    .toLocaleLowerCase("vi-VN")
    .replace(/(^|[\s'’.-])([\p{L}])/gu, (_, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase("vi-VN")}`);

function CatalogEmptyState({
  status,
  error,
  onRetry,
  className,
}: {
  status: "idle" | "loading" | "live" | "error";
  error?: string;
  onRetry: () => void;
  className?: string;
}) {
  const isLoading = status === "idle" || status === "loading";

  return (
    <div className={cn("rounded-2xl border border-dashed border-amber-200 bg-white p-4 text-sm text-[#765333]", className)}>
      {isLoading ? (
        <div className="flex items-center gap-2 font-medium">
          <Loader2 className="h-4 w-4 animate-spin text-amber-700" />
          <span>Đang tải sản phẩm...</span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="font-semibold text-[#3f2411]">Không tải được sản phẩm.</div>
          <div className="text-xs leading-5 text-[#8a6a4a]">
            {error || "Anh/chị bấm tải lại. Nếu vẫn lỗi, vui lòng đăng xuất rồi đăng nhập OTP lại để làm mới phiên đại lý."}
          </div>
          <Button type="button" size="sm" variant="outline" className="rounded-xl border-amber-300 bg-amber-50 text-[#765333]" onClick={onRetry}>
            Tải lại sản phẩm
          </Button>
        </div>
      )}
    </div>
  );
}

export default function DealerPortal() {
  const [dealerProfileCache, setDealerProfileCache] = useState<DealerProfileCache>(() => readDealerProfileCache());
  const [, setDealerCatalogCache] = useState<DealerCatalogCache>(() => readDealerCatalogCache());
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem(DEALER_SESSION_STORAGE_KEY) || "");
  const [loginStep, setLoginStep] = useState<LoginStep>(() =>
    localStorage.getItem(DEALER_SESSION_STORAGE_KEY) ? "catalog" : "phone",
  );
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [activeNav, setActiveNav] = useState("home");
  const [catalogProducts, setCatalogProducts] = useState<Product[]>(() => readDealerCatalogCache().products);
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "live" | "error">("idle");
  const [catalogError, setCatalogError] = useState("");
  const [landingBannerUrl, setLandingBannerUrl] = useState("");
  const [landingBanners, setLandingBanners] = useState<DealerLandingBanner[]>([]);
  const [activeLandingBannerIndex, setActiveLandingBannerIndex] = useState(0);
  const [announcements, setAnnouncements] = useState<CatalogResponse["announcements"]>(() => readDealerCatalogCache().announcements);
  const [dealerCustomer, setDealerCustomer] = useState<DealerCustomer | null>(() => dealerProfileCache.customer);
  const [dealerRoutes, setDealerRoutes] = useState<DealerRoute[]>(() => readDealerCatalogCache().dealerRoutes);
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [orderMessage, setOrderMessage] = useState("");
  const [orderError, setOrderError] = useState("");
  const [orderSuccessOpen, setOrderSuccessOpen] = useState(false);
  const [orderSuccessNumber, setOrderSuccessNumber] = useState("");
  const [nppConfirmOpen, setNppConfirmOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [nppQuantities, setNppQuantities] = useState<Record<string, number>>({});
  const [nppExchangeQuantities, setNppExchangeQuantities] = useState<Record<string, number>>({});
  const [nppMakeupQuantities, setNppMakeupQuantities] = useState<Record<string, number>>({});
  const [nppNotes, setNppNotes] = useState<Record<string, string>>({});
  const [nppOrderText, setNppOrderText] = useState("");
  const [nppParseMessage, setNppParseMessage] = useState("");
  const [nppParseStatus, setNppParseStatus] = useState<"idle" | "processing" | "success">("idle");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [draftQuantity, setDraftQuantity] = useState("");
  const [quantityModalError, setQuantityModalError] = useState("");
  const [activeCategory, setActiveCategory] = useState("Tất cả");
  const [productSearch, setProductSearch] = useState("");
  const [dealerProfileOpen, setDealerProfileOpen] = useState(false);

  const loadLandingConfig = useCallback(async () => {
    try {
      const { data, error } = await callEdgeFunction<DealerPublicConfigResponse>("dealer-public-config", {}, undefined, 8000);

      if (error) throw new Error(error);
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
      setDealerRoutes([]);
      setDealerCatalogCache({ products: [], announcements: [], dealerRoutes: [] });
      localStorage.removeItem(DEALER_CATALOG_CACHE_KEY);
      setCatalogError("");
      setCatalogStatus("idle");
      return;
    }

    const cachedCatalog = readDealerCatalogCache();
    if (cachedCatalog.products.length > 0) {
      setCatalogProducts(cachedCatalog.products);
      setAnnouncements(cachedCatalog.announcements || []);
      setDealerRoutes(cachedCatalog.dealerRoutes || []);
      setDealerCatalogCache(cachedCatalog);
    }

    setCatalogError("");
    setCatalogStatus("loading");

    try {
      const { data, error, isSessionExpired } = await callEdgeFunction<CatalogResponse>("dealer-catalog", token ? { dealer_token: token } : {}, undefined, 12000);

      if (error) {
        if (isSessionExpired) {
          localStorage.removeItem(DEALER_SESSION_STORAGE_KEY);
          localStorage.removeItem(DEALER_PROFILE_CACHE_KEY);
          localStorage.removeItem(DEALER_CATALOG_CACHE_KEY);
          setDealerProfileCache({ customer: null, hasDealerRoutes: false });
          setDealerCatalogCache({ products: [], announcements: [], dealerRoutes: [] });
          setDealerCustomer(null);
          setDealerRoutes([]);
          setLoginStep("phone");
          setSessionToken("");
        }
        throw new Error(error);
      }

      const nextProducts = Array.isArray(data?.products) ? data.products.map(mapCatalogProduct) : [];
      const nextRoutes = Array.isArray(data?.dealer_routes) ? data.dealer_routes : [];
      const nextProfileCache = {
        customer: data?.customer || null,
        hasDealerRoutes: nextRoutes.length > 0,
      };
      const nextCatalogCache = {
        products: nextProducts,
        announcements: data?.announcements || [],
        dealerRoutes: nextRoutes,
      };
      setCatalogProducts(nextProducts);
      setAnnouncements(nextCatalogCache.announcements);
      setDealerCustomer(nextProfileCache.customer);
      setDealerRoutes(nextRoutes);
      setDealerProfileCache(nextProfileCache);
      setDealerCatalogCache(nextCatalogCache);
      localStorage.setItem(DEALER_PROFILE_CACHE_KEY, JSON.stringify(nextProfileCache));
      localStorage.setItem(DEALER_CATALOG_CACHE_KEY, JSON.stringify(nextCatalogCache));
      setCatalogError("");
      setCatalogStatus("live");
    } catch (error) {
      const message = await getFunctionErrorMessage(error, "Không tải được danh sách sản phẩm.");
      if (cachedCatalog.products.length === 0) {
        setCatalogProducts([]);
        setAnnouncements([]);
        setDealerRoutes([]);
      }
      setCatalogError(message || "Không tải được danh sách sản phẩm.");
      setCatalogStatus("error");
      console.warn("Không tải được danh sách sản phẩm đại lý", message || error);
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
        otp_required?: boolean;
        reason?: string;
        dev_otp?: string;
      }>("dealer-auth-start", {
        body: { phone },
      });

      if (error) throw error;

      if (data?.otp_required === false) {
        setLoginStep("phone");
        setOtp("");
        setAuthError(
          data.message ||
            "Số điện thoại này chưa có trong hệ thống đại lý BMQ hoặc chưa được kích hoạt. Vui lòng liên hệ CSKH BMQ để được hỗ trợ thêm số điện thoại.",
        );
        return;
      }

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
      setDealerProfileCache((current) => ({ ...current, customer: data.customer || null }));
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
    localStorage.removeItem(DEALER_PROFILE_CACHE_KEY);
    localStorage.removeItem(DEALER_CATALOG_CACHE_KEY);
    setDealerProfileCache({ customer: null, hasDealerRoutes: false });
    setDealerCatalogCache({ products: [], announcements: [], dealerRoutes: [] });
    setCatalogError("");
    setSessionToken("");
    setDealerCustomer(null);
    setDealerRoutes([]);
    setNppQuantities({});
    setNppExchangeQuantities({});
    setNppMakeupQuantities({});
    setNppNotes({});
    setNppOrderText("");
    setNppParseMessage("");
    setNppParseStatus("idle");
    setLoginStep("phone");
    setOtp("");
    setAuthMessage("");
    setAuthError("");
    setOrderMessage("");
    setOrderError("");
  };

  const submitOrderPayload = async (items: Array<Record<string, unknown>>) => {
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
          items,
        },
      });

      if (error) throw error;

      const nextOrderNumber = data?.order_number || "";
      setOrderSuccessNumber(nextOrderNumber);
      setOrderSuccessOpen(true);
      setNppConfirmOpen(false);
      setOrderMessage(`Đã gửi đơn ${nextOrderNumber}. Xin cảm ơn quý khách đã chọn lựa Bánh Mì Que Pháp BMQ.`);
      setQuantities({});
      setNppQuantities({});
      setNppExchangeQuantities({});
      setNppMakeupQuantities({});
      setNppNotes({});
      setNppOrderText("");
      setNppParseMessage("");
      setNppParseStatus("idle");
    } catch (error) {
      setOrderError(await getFunctionErrorMessage(error, "Không gửi được đơn hàng."));
    } finally {
      setOrderSubmitting(false);
    }
  };

  const handleSubmitOrder = async () => {
    if (!sessionToken || selectedLines.length === 0) return;

    const invalidQuantityLine = selectedLines.find((line) => line.quantity % DEALER_ORDER_STEP !== 0);
    if (invalidQuantityLine) {
      setOrderError(`Số lượng ${invalidQuantityLine.name} phải là bội số ${DEALER_ORDER_STEP} ${invalidQuantityLine.unit || "đơn vị"}.`);
      return;
    }

    await submitOrderPayload(selectedLines.map((line) => ({
      sku_id: line.id,
      quantity: line.quantity,
    })));
  };

  const validateNppOrder = () => {
    if (!sessionToken || nppSelectedLines.length === 0) return false;

    const invalidQuantityLine = nppSelectedLines.find((line) => line.quantity % DEALER_ORDER_STEP !== 0);
    if (invalidQuantityLine) {
      setOrderError(`Số lượng ${invalidQuantityLine.route.name} phải là bội số ${DEALER_ORDER_STEP} ${invalidQuantityLine.product.unit || "que"}.`);
      return false;
    }

    setOrderError("");
    return true;
  };

  const handleSubmitNppOrder = () => {
    if (!validateNppOrder()) return;
    void confirmSubmitNppOrder();
  };


  const handleParseNppOrderText = () => {
    setNppParseStatus("processing");
    setNppParseMessage("");

    window.setTimeout(() => {
      const parsedLines = parseDealerChatOrderText(nppOrderText, dealerRoutes);
      if (!parsedLines.length) {
        setNppParseStatus("idle");
        setNppParseMessage("Chưa nhận diện được điểm bán. Anh có thể nhập theo mẫu: Rạch Giá 200 đổi 10, ĐVC 100 bù 3.");
        return;
      }

      const nextQuantities: Record<string, number> = {};
      const nextExchangeQuantities: Record<string, number> = {};
      const nextMakeupQuantities: Record<string, number> = {};
      const nextNotes: Record<string, string> = {};
      const unmatched: string[] = [];

      parsedLines.forEach((line) => {
        if (!line.route) {
          unmatched.push(line.routeText);
          return;
        }
        nextQuantities[line.route.id] = line.orderedQuantity;
        nextExchangeQuantities[line.route.id] = line.exchangeQuantity;
        nextMakeupQuantities[line.route.id] = line.makeupQuantity;
        nextNotes[line.route.id] = line.note;
      });

      setNppQuantities(nextQuantities);
      setNppExchangeQuantities(nextExchangeQuantities);
      setNppMakeupQuantities(nextMakeupQuantities);
      setNppNotes(nextNotes);
      setOrderError("");
      setNppParseStatus("success");
      setNppParseMessage(
        unmatched.length
          ? `Đã nhận ${parsedLines.length - unmatched.length} dòng. Chưa khớp: ${unmatched.slice(0, 3).join(", ")}.`
          : `Đã nhận ${parsedLines.length} dòng. Anh có thể chỉnh trực tiếp ở chi tiết đơn.`,
      );
    }, 650);
  };

  const confirmSubmitNppOrder = async () => {
    if (!sessionToken || nppSelectedLines.length === 0) return;
    await submitOrderPayload(nppSelectedLines.map((line) => ({
      sku_id: line.product.id,
      quantity: line.quantity,
      ordered_quantity: line.quantity,
      exchange_quantity: line.exchangeQuantity,
      makeup_quantity: line.makeupQuantity,
      physical_quantity: line.physicalQuantity,
      route_customer_id: line.route.id,
      route_customer_name: line.route.name,
      route_note: line.note,
    })));
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

  const isCatalogRefreshing = catalogStatus === "idle" || catalogStatus === "loading";
  const isNppMode = dealerRoutes.length > 0 || (isCatalogRefreshing && dealerProfileCache.hasDealerRoutes);
  const nppProduct = useMemo(
    () => catalogProducts.find((product) => `${product.name} ${product.skuCode || ""}`.toLocaleLowerCase("vi-VN").includes("que")) || catalogProducts[0] || null,
    [catalogProducts],
  );
  const nppSelectedLines = useMemo<NppOrderLine[]>(
    () => !nppProduct ? [] : dealerRoutes
      .map((route) => {
        const quantity = nppQuantities[route.id] || 0;
        const exchangeQuantity = nppExchangeQuantities[route.id] || 0;
        const makeupQuantity = nppMakeupQuantities[route.id] || 0;
        const physicalQuantity = quantity + exchangeQuantity + makeupQuantity;
        return {
          route,
          product: nppProduct,
          quantity,
          exchangeQuantity,
          makeupQuantity,
          physicalQuantity,
          note: nppNotes[route.id] || "",
          lineTotal: quantity * nppProduct.price,
        };
      })
      .filter((line) => line.physicalQuantity > 0),
    [dealerRoutes, nppExchangeQuantities, nppMakeupQuantities, nppNotes, nppProduct, nppQuantities],
  );
  const totalItems = isNppMode ? nppSelectedLines.reduce((sum, line) => sum + line.physicalQuantity, 0) : selectedLines.reduce((sum, product) => sum + product.quantity, 0);
  const cartTotal = isNppMode ? nppSelectedLines.reduce((sum, line) => sum + line.lineTotal, 0) : selectedLines.reduce((sum, product) => sum + product.lineTotal, 0);
  const isCatalogUnlocked = loginStep === "catalog" && Boolean(sessionToken);
  const isCatalogRestoring = isCatalogUnlocked && isCatalogRefreshing && !dealerProfileCache.customer;
  const dealerDisplayName = toDisplayName(dealerCustomer?.name) || dealerCustomer?.code || "Đại lý BMQ";
  const activeLandingBanner = landingBanners[activeLandingBannerIndex] || landingBanners[0];
  const activeLandingBannerUrl = activeLandingBanner?.url || landingBannerUrl;
  const activePromotionPath = window.location.hostname === "dathang.banhmique.vn"
    ? `/promotion/${activeLandingBanner?.id || "event-1"}`
    : `/dealer/promotion/${activeLandingBanner?.id || "event-1"}`;
  const categoryChips = ["Tất cả", "Bánh mì", "Bánh ngọt", "Bán chạy"];
  const featuredProducts = catalogProducts.slice(0, 3);
  const productCarouselProducts = catalogProducts.filter((product) => product.id !== nppProduct?.id).slice(0, 10);
  const filteredProducts = catalogProducts.filter((product) => {
    if (activeCategory === "Tất cả") return true;
    const haystack = `${product.name} ${product.tag}`.toLowerCase();
    if (activeCategory === "Bánh mì") return haystack.includes("bánh mì") || haystack.includes("que") || haystack.includes("pate");
    if (activeCategory === "Bánh ngọt") return haystack.includes("ngọt") || haystack.includes("bánh bao") || haystack.includes("cake");
    if (activeCategory === "Combo") return haystack.includes("combo") || haystack.includes("set");
    if (activeCategory === "Bán chạy") return featuredProducts.some((item) => item.id === product.id);
    return true;
  });
  const normalizedProductSearch = productSearch.trim().toLocaleLowerCase("vi-VN");
  const homeProducts = filteredProducts.filter((product) => {
    if (!normalizedProductSearch) return true;
    return `${product.name} ${product.skuCode || ""} ${product.tag}`
      .toLocaleLowerCase("vi-VN")
      .includes(normalizedProductSearch);
  });

  const openProductDialog = (product: Product) => {
    setSelectedProduct(product);
    setDraftQuantity(quantities[product.id] ? String(quantities[product.id]) : "");
    setQuantityModalError("");
  };

  const handleProductCta = (product: Product) => {
    if (isNppMode) {
      setActiveNav("order");
      setNppParseStatus("idle");
      setNppParseMessage("");
      openProductDialog(product);
      return;
    }
    openProductDialog(product);
  };

  const handleProductQuantitySubmit = () => {
    if (!selectedProduct) return;

    const nextQuantity = draftQuantity ? Number(draftQuantity) : 0;
    if (!Number.isFinite(nextQuantity) || nextQuantity < 0) {
      setQuantityModalError("Vui lòng nhập số lượng hợp lệ.");
      return;
    }
    if (nextQuantity % DEALER_ORDER_STEP !== 0) {
      setQuantityModalError(`Số lượng phải là bội số ${DEALER_ORDER_STEP} ${selectedProduct.unit || "đơn vị"}.`);
      return;
    }

    setQuantities((current) => ({
      ...current,
      [selectedProduct.id]: nextQuantity,
    }));
    setSelectedProduct(null);
    setDraftQuantity("");
    setQuantityModalError("");
  };

  const handleNav = (item: (typeof navItems)[number]) => {
    setActiveNav(item.id);
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-background text-foreground">
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
            <button
              type="button"
              className="flex min-w-0 max-w-[52vw] items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-[#3f2411] shadow-sm transition hover:border-amber-300 hover:bg-amber-100"
              onClick={() => setDealerProfileOpen(true)}
            >
              <Building2 className="h-4 w-4 shrink-0 text-amber-700" />
              <span className="truncate text-sm font-semibold">{dealerDisplayName}</span>
            </button>
          ) : (
            <Button variant="outline" size="sm" className="h-9 px-3" onClick={() => handleNav(navItems[3])}>
              <MessageCircle className="h-4 w-4" />
              Zalo OA
            </Button>
          )}
        </div>
      </header>

      {isCatalogRestoring ? (
        <section id="dealer-top" className="bg-[#fffaf0] text-[#3f2411]">
          <div className="mx-auto max-w-6xl px-4 pb-3 pt-4 md:pb-5 md:pt-6">
            <div className="rounded-[28px] border border-amber-100 bg-white/70 p-5 shadow-sm sm:p-6" aria-label="Đang tải dữ liệu đại lý">
              <div className="space-y-3">
                <div className="h-4 w-28 animate-pulse rounded-full bg-amber-100" />
                <div className="h-8 w-3/4 animate-pulse rounded-full bg-amber-100 sm:w-1/2" />
                <div className="h-4 w-full max-w-xl animate-pulse rounded-full bg-amber-50" />
                <div className="h-11 w-52 animate-pulse rounded-2xl bg-amber-100" />
              </div>
            </div>
          </div>
        </section>
      ) : isCatalogUnlocked && activeNav === "home" ? (
        <section id="dealer-top" className="bg-[#fffaf0] text-[#3f2411]">
          <div className="mx-auto max-w-6xl px-4 pb-3 pt-4 md:pb-5 md:pt-6">
            <div className="overflow-hidden rounded-[28px] border border-amber-200 bg-white shadow-xl shadow-amber-900/10">
              <div className="relative h-[220px] overflow-hidden bg-[#24150d] sm:h-[260px] md:h-[300px]" data-stitch-dealer-banner="responsive-cover-v1">
                {activeLandingBannerUrl ? (
                  <>
                    <img src={activeLandingBannerUrl} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl opacity-65" />
                    <div className="absolute inset-0 bg-gradient-to-r from-[#24150d]/20 via-transparent to-[#24150d]/55" />
                    <img src={activeLandingBannerUrl} alt={activeLandingBanner?.eventLabel || "Banner khuyến mãi BMQ"} className="relative z-[1] h-full w-full object-contain" />
                  </>
                ) : (
                  <div className="h-full w-full bg-[radial-gradient(circle_at_78%_18%,rgba(245,178,65,0.42),transparent_28%),linear-gradient(135deg,rgba(197,121,19,0.36),transparent_48%)]" />
                )}
                <Button
                  asChild
                  size="sm"
                  className="absolute bottom-3 right-3 z-10 h-9 rounded-full bg-amber-500/95 px-4 text-sm font-semibold text-[#1b1208] shadow-lg shadow-black/25 hover:bg-amber-400"
                >
                  <a href={activePromotionPath}>
                    Xem chương trình
                    <ChevronRight className="h-4 w-4" />
                  </a>
                </Button>
                {landingBanners.length > 1 ? (
                  <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/20 px-2 py-1 backdrop-blur-sm">
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
            </div>
          </div>
        </section>
      ) : !isCatalogUnlocked ? (
        <section id="dealer-top" className="border-b bg-[#16110d] text-amber-50">
          <div className="mx-auto max-w-6xl px-4 py-4 pb-6 md:py-5">
            <div className="overflow-hidden rounded-[28px] border border-amber-400/20 bg-gradient-to-br from-[#3b210d] via-[#25160e] to-[#120d09] shadow-2xl shadow-black/35">
              <div className="relative h-[220px] overflow-hidden bg-[#24150d] sm:h-[260px] md:h-[300px]" data-stitch-dealer-banner="responsive-cover-v1">
                {activeLandingBannerUrl ? (
                  <>
                    <img src={activeLandingBannerUrl} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl opacity-65" />
                    <div className="absolute inset-0 bg-gradient-to-r from-[#24150d]/20 via-transparent to-[#24150d]/55" />
                    <img src={activeLandingBannerUrl} alt={activeLandingBanner?.eventLabel || "Banner khuyến mãi BMQ"} className="relative z-[1] h-full w-full object-contain" />
                  </>
                ) : (
                  <div className="h-full w-full bg-[radial-gradient(circle_at_78%_18%,rgba(245,178,65,0.42),transparent_28%),linear-gradient(135deg,rgba(197,121,19,0.36),transparent_48%)]" />
                )}
                <Button
                  asChild
                  size="sm"
                  className="absolute bottom-3 right-3 z-10 h-9 rounded-full bg-amber-500/95 px-4 text-sm font-semibold text-[#1b1208] shadow-lg shadow-black/25 hover:bg-amber-400"
                >
                  <a href={activePromotionPath}>
                    Xem ngay
                    <ChevronRight className="h-4 w-4" />
                  </a>
                </Button>
                {landingBanners.length > 1 ? (
                  <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/20 px-2 py-1 backdrop-blur-sm">
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
      ) : null}

      <main className={cn(
        "mx-auto grid min-w-0 w-full max-w-6xl gap-4 px-4 pt-4",
        isCatalogUnlocked
          ? cn("bg-[#fffaf0] pb-40 lg:pb-12", !isNppMode && activeNav !== "home" && activeNav !== "support" && "lg:grid-cols-[minmax(0,1fr)_340px]")
          : "pb-28",
      )}>
        <div className="min-w-0 space-y-4">
          <Card id="dealer-login" className={cn("scroll-mt-24 rounded-md", isCatalogUnlocked && "hidden")}>
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
                    Nếu số điện thoại chưa có trong CRM đại lý BMQ, vui lòng liên hệ CSKH BMQ để thêm số điện thoại của bạn.
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

          {isCatalogRestoring ? (
            <Card className="rounded-md border-amber-200 bg-amber-50/70">
              <CardContent className="flex items-center gap-3 p-4 text-sm text-[#765333]" aria-label="Đang tải dữ liệu đại lý">
                <Loader2 className="h-4 w-4 animate-spin text-amber-700" />
                <span>Đang tải...</span>
              </CardContent>
            </Card>
          ) : null}

          {isCatalogUnlocked && !isCatalogRestoring ? (
            <div className="contents">
          {activeNav === "home" ? (
            <section id="dealer-home" className="min-w-0 space-y-4" data-dealer-page="home" data-stitch-dealer-home="responsive-grid-v1">
              <div className="rounded-3xl border border-amber-100 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">Trang chủ đại lý</div>
                    <h2 className="mt-1 text-2xl font-display font-extrabold text-[#3f2411] sm:text-3xl">Sản phẩm BMQ</h2>
                    <p className="mt-1 text-sm text-[#8a6a4a]">Chọn sản phẩm để xem chi tiết và đặt hàng nhanh.</p>
                  </div>
                  <div className="flex w-full items-center gap-2 lg:w-auto">
                    <div className="relative min-w-0 flex-1 lg:w-80">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#a7835d]" />
                      <Input
                        value={productSearch}
                        onChange={(event) => setProductSearch(event.target.value)}
                        placeholder="Tìm sản phẩm"
                        aria-label="Tìm sản phẩm"
                        className="h-11 rounded-2xl border-amber-200 bg-[#fffaf0] pl-10 text-[#3f2411] placeholder:text-[#a7835d] focus-visible:ring-amber-400"
                      />
                    </div>
                    <Button
                      type="button"
                      className="hidden h-11 rounded-2xl bg-amber-500 px-4 font-bold text-[#2b1708] hover:bg-amber-400 lg:inline-flex"
                      data-stitch-dealer-home-order-cta="desktop"
                      onClick={() => setActiveNav("order")}
                    >
                      <ShoppingCart className="h-4 w-4" />
                      Đặt hàng
                    </Button>
                  </div>
                </div>

                <div className="mt-4 flex max-w-full gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {categoryChips.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className={cn(
                        "h-10 shrink-0 rounded-full border px-4 text-sm font-semibold transition",
                        activeCategory === chip
                          ? "border-[#3f2411] bg-[#3f2411] text-amber-50 shadow-sm"
                          : "border-amber-200 bg-white text-[#765333] hover:border-amber-400 hover:bg-amber-50",
                      )}
                      onClick={() => setActiveCategory(chip)}
                    >
                      {chip}
                    </button>
                  ))}
                </div>

                <div className="mt-4 grid min-w-0 grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3" data-stitch-dealer-product-grid="responsive-2-3-4">
                  {catalogProducts.length === 0 ? (
                    <CatalogEmptyState status={catalogStatus} error={catalogError} onRetry={() => void loadCatalog(sessionToken)} className="col-span-2 md:col-span-3 lg:col-span-4" />
                  ) : null}
                  {catalogProducts.length > 0 && homeProducts.length === 0 ? (
                    <div className="col-span-2 rounded-2xl border border-dashed border-amber-200 bg-[#fffaf0] p-5 text-center text-sm text-[#765333] md:col-span-3 lg:col-span-4">
                      Không tìm thấy sản phẩm phù hợp.
                    </div>
                  ) : null}
                  {homeProducts.map((product) => {
                    const quantity = quantities[product.id] || 0;
                    return (
                      <Card key={product.id} className="min-w-0 overflow-hidden rounded-3xl border-amber-100 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md">
                        <button type="button" className="flex h-full min-w-0 w-full flex-col gap-3 p-2.5 text-left sm:p-3" onClick={() => handleProductCta(product)}>
                          <div className="aspect-[4/3] w-full overflow-hidden rounded-2xl border border-amber-100 bg-amber-50">
                            {product.imageUrl ? (
                              <img src={product.imageUrl} alt={product.name} loading="lazy" className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center bg-amber-50">
                                <img src={bmqLogo} alt="BMQ" className="h-12 w-12 object-contain" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="line-clamp-2 text-sm font-extrabold leading-snug text-[#3f2411] sm:text-base">{product.name}</h3>
                            <div className="mt-1 truncate text-xs font-semibold text-amber-700 sm:text-sm">{formatVnd(product.price)} / {product.unit}</div>
                          </div>
                          <div className={cn("w-full rounded-full px-3 py-2 text-center text-xs font-bold", quantity > 0 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800")}>
                            {quantity > 0 ? `${quantity} ${product.unit}` : isNppMode ? "Xem cách đặt" : "Chọn"}
                          </div>
                        </button>
                      </Card>
                    );
                  })}
                </div>
              </div>
            </section>
          ) : null}

          <section id="quick-order" className={cn("min-w-0 space-y-4", activeNav !== "order" && "hidden")}>
            <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">Đặt hàng đại lý</div>
                <h2 className="break-words text-2xl font-display font-extrabold text-[#3f2411]">Chat với BMQ Agent để đặt hàng</h2>
              </div>
              <Badge variant="outline" className="rounded-full border-amber-300 bg-white text-amber-800">
                BMQ Agent
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

            {isNppMode ? (
              <NppQuickOrderPanel
                routes={dealerRoutes}
                product={nppProduct}
                productSuggestions={productCarouselProducts}
                quantities={nppQuantities}
                notes={nppNotes}
                exchangeQuantities={nppExchangeQuantities}
                makeupQuantities={nppMakeupQuantities}
                setQuantities={setNppQuantities}
                setExchangeQuantities={setNppExchangeQuantities}
                setMakeupQuantities={setNppMakeupQuantities}
                setNotes={setNppNotes}
                orderText={nppOrderText}
                setOrderText={setNppOrderText}
                onProductSuggestion={handleProductCta}
                parseMessage={nppParseMessage}
                parseStatus={nppParseStatus}
                onParse={handleParseNppOrderText}
                detailOpen={nppConfirmOpen}
                setDetailOpen={setNppConfirmOpen}
                totalItems={totalItems}
                cartTotal={cartTotal}
                canSubmit={Boolean(sessionToken) && catalogStatus === "live" && nppSelectedLines.length > 0}
                submitting={orderSubmitting}
                onSubmit={handleSubmitNppOrder}
              />
            ) : null}

            {!isNppMode ? (
            <>
            <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none]">
              {[
                ["Combo", "bg-amber-50 text-amber-800 border-amber-200"],
                ["Bán chạy", "bg-emerald-50 text-emerald-700 border-emerald-200"],
                ["Sản phẩm mới", "bg-orange-50 text-orange-700 border-orange-200"],
              ].map(([title, tone]) => (
                <button
                  key={title}
                  type="button"
                  className={cn(
                    "h-10 shrink-0 rounded-full border px-4 text-sm font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md",
                    tone,
                  )}
                  onClick={() => setActiveCategory(title === "Bán chạy" ? "Bán chạy" : title === "Combo" ? "Combo" : "Tất cả")}
                >
                  {title}
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
                <CatalogEmptyState status={catalogStatus} error={catalogError} onRetry={() => void loadCatalog(sessionToken)} className="col-span-2 md:col-span-3" />
              ) : null}
              {filteredProducts.map((product) => {
                const quantity = quantities[product.id] || 0;

                return (
                  <Card key={product.id} className="overflow-hidden rounded-3xl border-amber-100 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md">
                    <button
                      type="button"
                      className="flex h-full w-full flex-col gap-3 p-3 text-left"
                      onClick={() => openProductDialog(product)}
                    >
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
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="line-clamp-2 text-sm font-extrabold leading-snug text-[#3f2411] sm:text-base">{product.name}</h3>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-extrabold text-[#3f2411]">{formatVnd(product.price)}</div>
                          <div className="text-xs text-[#8a6a4a]">/{product.unit}</div>
                        </div>
                        <div className={cn("rounded-full px-3 py-1 text-xs font-bold", quantity > 0 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800")}>
                          {quantity > 0 ? `${quantity} ${product.unit}` : "Chọn"}
                        </div>
                      </div>
                    </button>
                  </Card>
                );
              })}
            </div>

            {featuredProducts.length ? (
              <div className="rounded-3xl border border-amber-100 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-display font-extrabold text-[#3f2411]">Đại lý thường đặt kèm</h3>
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
                      <Button type="button" size="sm" className="h-10 rounded-2xl bg-[#3f2411] px-3 text-amber-50 hover:bg-[#5b3418]" onClick={() => openProductDialog(product)}>
                        Chọn
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            </>
            ) : null}
          </section>

          {activeNav === "products" ? (
            <section id="dealer-products" className="space-y-4" data-dealer-page="products">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">Sản phẩm BMQ</div>
                  <h2 className="text-2xl font-display font-extrabold text-[#3f2411]">Danh sách SKU đang mở bán</h2>
                </div>
                <Button type="button" variant="outline" className="rounded-2xl border-amber-200 bg-white text-[#765333]" onClick={() => setActiveNav("order")}>
                  Mở chat đặt hàng
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {catalogProducts.length === 0 ? (
                  <CatalogEmptyState status={catalogStatus} error={catalogError} onRetry={() => void loadCatalog(sessionToken)} className="col-span-2 md:col-span-3" />
                ) : null}
                {catalogProducts.map((product) => (
                  <Card key={product.id} className="overflow-hidden rounded-3xl border-amber-100 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md">
                    <button type="button" className="flex h-full w-full flex-col gap-3 p-3 text-left" onClick={() => handleProductCta(product)}>
                      <div className="overflow-hidden rounded-2xl border border-amber-100 bg-amber-50">
                        {product.imageUrl ? (
                          <img src={product.imageUrl} alt={product.name} loading="lazy" className="h-32 w-full object-cover sm:h-36" />
                        ) : (
                          <div className="flex h-32 w-full items-center justify-center bg-amber-50 sm:h-36">
                            <img src={bmqLogo} alt="BMQ" className="h-12 w-12 object-contain" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="line-clamp-2 text-sm font-extrabold leading-snug text-[#3f2411] sm:text-base">{product.name}</h3>
                        <div className="mt-1 text-xs font-semibold text-amber-700">{formatVnd(product.price)} / {product.unit}</div>
                      </div>
                      <div className="rounded-full bg-amber-100 px-3 py-1 text-center text-xs font-bold text-amber-800">
                        {isNppMode ? "Hỏi BMQ Agent" : "Chọn"}
                      </div>
                    </button>
                  </Card>
                ))}
              </div>
            </section>
          ) : null}

          <section id="delivery-plan" className={cn("space-y-3", activeNav !== "support" && "hidden")}>
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

          <section id="dealer-support" className={cn("space-y-3", activeNav !== "support" && "hidden")}>
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

        {isCatalogUnlocked && !isCatalogRestoring && !isNppMode && activeNav !== "home" && activeNav !== "support" ? (
          <aside className="hidden lg:block">
            <div className="sticky top-20">
              <CartSummary
                selectedLines={selectedLines}
                nppLines={nppSelectedLines}
                totalItems={totalItems}
                cartTotal={cartTotal}
                isNppMode={isNppMode}
                canSubmit={Boolean(sessionToken) && catalogStatus === "live" && (isNppMode ? nppSelectedLines.length > 0 : selectedLines.length > 0)}
                submitting={orderSubmitting}
                onSubmit={isNppMode ? handleSubmitNppOrder : handleSubmitOrder}
              />
            </div>
          </aside>
        ) : null}
      </main>

      <footer className="border-t border-amber-100 bg-[#fffaf0] px-4 py-5 pb-24 text-center text-xs font-medium text-[#8a6a4a] lg:pb-5">
        © 2026 Bánh Mì Que Pháp BMQ. All rights reserved. Powered by VNAgent.ai
      </footer>

      {isCatalogUnlocked && !isCatalogRestoring && activeNav === "home" ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-amber-200 bg-white/95 px-4 py-3 shadow-[0_-10px_30px_rgba(63,36,17,0.14)] backdrop-blur lg:hidden" data-stitch-dealer-home-order-bar="mobile">
          <div className="mx-auto flex max-w-md items-center gap-3">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setActiveNav("order")}>
              <div className="flex items-center gap-2 text-sm font-extrabold text-[#3f2411]">
                <ShoppingCart className="h-4 w-4 text-amber-700" />
                {isNppMode ? "Đặt hàng với BMQ Agent" : `${selectedLines.length} sản phẩm • ${totalItems} đơn vị`}
              </div>
              <div className="truncate text-xs font-medium text-[#765333]">
                {isNppMode ? "Nhập đơn nhanh bằng tin nhắn" : `Tạm tính ${formatVnd(cartTotal)}`}
              </div>
            </button>
            <Button type="button" className="h-11 shrink-0 rounded-2xl bg-amber-500 px-4 font-bold text-[#2b1708] hover:bg-amber-400" onClick={() => setActiveNav("order")}>
              Đặt hàng
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {isCatalogUnlocked && !isCatalogRestoring && !isNppMode && activeNav !== "home" && activeNav !== "support" ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 px-4 py-3 shadow-lg backdrop-blur lg:hidden">
          <div className="mx-auto max-w-6xl">
            <CartSummary
              selectedLines={selectedLines}
              nppLines={nppSelectedLines}
              totalItems={totalItems}
              cartTotal={cartTotal}
              compact
              isNppMode={isNppMode}
              canSubmit={Boolean(sessionToken) && catalogStatus === "live" && selectedLines.length > 0}
              submitting={orderSubmitting}
              onSubmit={handleSubmitOrder}
            />
          </div>
        </div>
      ) : null}

      {!isCatalogUnlocked ? (
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
      ) : null}

      {isCatalogUnlocked ? (
        <Dialog open={dealerProfileOpen} onOpenChange={setDealerProfileOpen}>
          <DialogContent className="max-w-sm rounded-3xl border-amber-200 bg-[#fffaf0] text-[#3f2411] shadow-2xl">
            <DialogHeader>
              <DialogTitle className="text-xl font-display font-extrabold">Đăng nhập đại lý</DialogTitle>
              <DialogDescription className="text-sm leading-6 text-[#765333]">
                Xác thực số điện thoại bằng OTP Zalo trước khi đặt hàng.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 rounded-2xl border bg-white/70 p-3 text-sm">
                <span className="truncate text-[#765333]">Phiên đại lý đang hoạt động.</span>
                <Button variant="ghost" size="sm" onClick={handleLogoutDealer}>
                  <LogOut className="h-4 w-4" />
                  Đăng xuất
                </Button>
              </div>
              <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-semibold">{dealerDisplayName}</div>
                  <div className="mt-1 text-emerald-800/80">Phiên OTP hợp lệ. Đơn gửi sẽ được BMQ tiếp nhận và xác nhận.</div>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      <Dialog
        open={Boolean(selectedProduct)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedProduct(null);
            setDraftQuantity("");
            setQuantityModalError("");
          }
        }}
      >
        <DialogContent className="top-3 max-h-[calc(100dvh-1.5rem)] max-w-sm translate-y-0 overflow-y-auto rounded-3xl border-amber-200 bg-[#fffaf0] p-0 pb-[env(safe-area-inset-bottom)] text-[#3f2411] shadow-2xl sm:top-[50%] sm:translate-y-[-50%]">
          {selectedProduct ? (
            <>
              <div className="h-32 bg-amber-50 sm:h-48">
                {selectedProduct.imageUrl ? (
                  <img src={selectedProduct.imageUrl} alt={selectedProduct.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_70%_20%,rgba(245,158,11,0.28),transparent_30%),linear-gradient(135deg,#fff7ed,#fef3c7)] text-amber-800">
                    <ImageIcon className="h-8 w-8" />
                    <span className="text-sm font-medium">Ảnh sản phẩm</span>
                  </div>
                )}
              </div>
              <div className="space-y-4 p-5" data-dealer-product-detail="label-specs">
                <DialogHeader>
                  <DialogTitle className="text-xl font-display font-extrabold leading-tight">{selectedProduct.name}</DialogTitle>
                  <DialogDescription className="text-sm leading-6 text-[#765333]">
                    {formatVnd(selectedProduct.price)} / {selectedProduct.unit}
                    {isNppMode ? ". Anh nhập số lượng theo từng điểm bán trong ô chat sau khi xem thông tin sản phẩm." : `. Đặt theo bội số ${DEALER_ORDER_STEP} ${selectedProduct.unit || "đơn vị"}.`}
                  </DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-3 gap-2" data-dealer-product-specs="weight-shelf-life">
                  <div className="rounded-2xl border border-amber-100 bg-white px-2 py-3 text-center">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-[#8a6a4a]">Giá bán</div>
                    <div className="mt-1 truncate text-sm font-extrabold text-[#3f2411]">{formatVnd(selectedProduct.price)}</div>
                  </div>
                  <div className="rounded-2xl border border-amber-100 bg-white px-2 py-3 text-center">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-[#8a6a4a]">Trọng lượng</div>
                    <div className="mt-1 truncate text-sm font-extrabold text-[#3f2411]">{formatProductWeight(selectedProduct)}</div>
                  </div>
                  <div className="rounded-2xl border border-amber-100 bg-white px-2 py-3 text-center">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-[#8a6a4a]">HSD</div>
                    <div className="mt-1 truncate text-sm font-extrabold text-[#3f2411]">{formatProductShelfLife(selectedProduct)}</div>
                  </div>
                </div>
                {!isNppMode ? (
                  <div className="space-y-2">
                    <Label htmlFor="dealer-product-quantity">Số lượng đặt</Label>
                    <Input
                      id="dealer-product-quantity"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={DEALER_ORDER_STEP}
                      value={draftQuantity}
                      placeholder="VD: 100"
                      onChange={(event) => {
                        setDraftQuantity(event.target.value.replace(/[^0-9]/g, ""));
                        setQuantityModalError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleProductQuantitySubmit();
                      }}
                      className="h-12 rounded-2xl border-amber-200 bg-white text-center text-lg font-extrabold text-[#3f2411] focus-visible:ring-amber-400"
                    />
                    <div className="text-xs text-[#8a6a4a]">Nhập 0 để bỏ sản phẩm khỏi đơn.</div>
                    {quantityModalError ? <div className="text-sm font-medium text-destructive">{quantityModalError}</div> : null}
                  </div>
                ) : null}
                <DialogFooter className="gap-2 sm:gap-2">
                  <Button variant="outline" className="h-11 w-full rounded-2xl border-amber-200 bg-white text-[#765333]" onClick={() => setSelectedProduct(null)}>
                    Đóng
                  </Button>
                  {isNppMode ? (
                    <Button className="h-11 w-full rounded-2xl bg-amber-500 text-base font-bold text-[#2b1708] hover:bg-amber-400" onClick={() => setSelectedProduct(null)}>
                      Đặt bằng chat
                    </Button>
                  ) : (
                    <Button className="h-11 w-full rounded-2xl bg-amber-500 text-base font-bold text-[#2b1708] hover:bg-amber-400" onClick={handleProductQuantitySubmit}>
                      Gửi
                    </Button>
                  )}
                </DialogFooter>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>



      <Dialog open={orderSuccessOpen} onOpenChange={setOrderSuccessOpen}>
        <DialogContent className="max-w-sm rounded-3xl border-amber-200 bg-[#fffaf0] text-[#3f2411] shadow-2xl">
          <DialogHeader className="items-center text-center">
            <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <DialogTitle className="text-2xl font-display font-extrabold">Đặt hàng thành công</DialogTitle>
            <DialogDescription className="text-center text-sm leading-6 text-[#765333]">
              {orderSuccessNumber ? `Đơn ${orderSuccessNumber} đã được ghi nhận. ` : "Đơn hàng đã được ghi nhận. "}
              Xin cảm ơn quý khách đã chọn lựa Bánh Mì Que Pháp BMQ.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button className="h-11 w-full rounded-2xl bg-amber-500 font-bold text-[#2b1708] hover:bg-amber-400" onClick={() => setOrderSuccessOpen(false)}>
              Đã hiểu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


function NppQuickOrderPanel({
  routes,
  product,
  productSuggestions,
  quantities,
  notes,
  exchangeQuantities,
  makeupQuantities,
  setQuantities,
  setExchangeQuantities,
  setMakeupQuantities,
  setNotes,
  orderText,
  setOrderText,
  onProductSuggestion,
  parseMessage,
  parseStatus,
  onParse,
  detailOpen,
  setDetailOpen,
  totalItems,
  cartTotal,
  canSubmit,
  submitting,
  onSubmit,
}: {
  routes: DealerRoute[];
  product: Product | null;
  productSuggestions: Product[];
  quantities: Record<string, number>;
  notes: Record<string, string>;
  exchangeQuantities: Record<string, number>;
  makeupQuantities: Record<string, number>;
  setQuantities: Dispatch<SetStateAction<Record<string, number>>>;
  setExchangeQuantities: Dispatch<SetStateAction<Record<string, number>>>;
  setMakeupQuantities: Dispatch<SetStateAction<Record<string, number>>>;
  setNotes: Dispatch<SetStateAction<Record<string, string>>>;
  orderText: string;
  setOrderText: Dispatch<SetStateAction<string>>;
  onProductSuggestion: (product: Product) => void;
  parseMessage: string;
  parseStatus: "idle" | "processing" | "success";
  onParse: () => void;
  detailOpen: boolean;
  setDetailOpen: Dispatch<SetStateAction<boolean>>;
  totalItems: number;
  cartTotal: number;
  canSubmit: boolean;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const unitLabel = product?.unit || "que";
  const selectedRoutes = routes.filter((route) => {
    const ordered = quantities[route.id] || 0;
    const exchange = exchangeQuantities[route.id] || 0;
    const makeup = makeupQuantities[route.id] || 0;
    return ordered + exchange + makeup > 0;
  });
  const selectedRouteCount = selectedRoutes.length;
  if (!product) {
    return (
      <div className="rounded-3xl border border-dashed border-amber-200 bg-white p-5 text-sm text-[#765333]">
        Chưa có sản phẩm bánh mì que đang mở bán cho account NPP này. Vui lòng liên hệ BMQ để kiểm tra giá.
      </div>
    );
  }

  return (
    <div className="min-w-0 w-full max-w-full space-y-4 pb-28" data-stitch-dealer-chat-agent="bottom-bar-v2" data-stitch-dealer-chat-overflow="contained-v1">
      <div className="min-w-0 w-full max-w-full overflow-hidden rounded-3xl border border-amber-100 bg-white p-3 shadow-sm sm:p-4">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-amber-100 bg-white shadow-sm">
              <img src={bmqLogo} alt="BMQ Agent" className="h-9 w-9 object-contain" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">BMQ Agent</div>
              <h3 className="text-lg font-display font-extrabold leading-tight text-[#3f2411] sm:text-xl">Nhập đơn bằng tin nhắn</h3>
            </div>
          </div>
          <Badge variant="outline" className="rounded-full border-emerald-200 bg-emerald-50 text-xs text-emerald-700">
            Đơn sẽ được BMQ xác nhận
          </Badge>
        </div>

        <div className="mt-4 min-w-0 space-y-3 rounded-3xl bg-[#fff8e8] p-2 sm:p-3">
          <div className="flex min-w-0 items-start gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-amber-700 shadow-sm">
              {parseStatus === "processing" ? <Loader2 className="h-4 w-4 animate-spin" /> : parseStatus === "success" ? <CheckCircle2 className="h-4 w-4 text-emerald-700" /> : <Sparkles className="h-4 w-4" />}
            </div>
            <div className="min-w-0 flex-1 whitespace-normal break-words rounded-2xl rounded-tl-md bg-white px-3 py-2 text-sm leading-6 text-[#5f3b1d] shadow-sm">
              {parseStatus === "processing"
                ? "Em đang đọc nội dung đơn..."
                : parseStatus === "success"
                  ? "Đã nhận đơn. Anh bấm thanh bên dưới để xem và chỉnh chi tiết."
                  : "Chào anh, gửi nội dung đơn ở ô bên dưới. Em sẽ tách đơn để anh kiểm tra trước khi gửi."}
            </div>
          </div>
          <div className="flex min-w-0 w-full max-w-full items-end gap-2 overflow-hidden rounded-3xl border border-amber-200 bg-white p-2 shadow-sm focus-within:ring-2 focus-within:ring-amber-300">
            <Textarea
              value={orderText}
              onChange={(event) => setOrderText(event.target.value)}
              placeholder="Dán nội dung đơn ở đây..."
              className="min-h-28 w-0 min-w-0 flex-1 resize-none border-0 bg-transparent text-base leading-7 text-[#3f2411] shadow-none placeholder:text-[#a7835d] focus-visible:ring-0"
            />
            <Button
              type="button"
              size="icon"
              aria-label="Gửi nội dung đơn"
              className="h-12 w-12 shrink-0 rounded-2xl bg-amber-500 text-[#2b1708] hover:bg-amber-400"
              onClick={onParse}
              disabled={parseStatus === "processing" || !orderText.trim()}
            >
              {parseStatus === "processing" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </Button>
          </div>
          {parseMessage ? (
            <div className={cn(
              "rounded-2xl px-3 py-2 text-sm font-medium",
              parseStatus === "success" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-[#765333]",
            )}>
              {parseMessage}
            </div>
          ) : null}
        </div>

        {productSuggestions.length > 0 ? (
          <div className="mt-4 min-w-0 w-full max-w-full space-y-2 overflow-hidden">
            <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <h4 className="text-sm font-extrabold text-[#3f2411]">Sản phẩm BMQ khác</h4>
              <span className="text-xs font-medium text-[#8a6a4a]">Chạm để xem cách đặt</span>
            </div>
            <div className="flex min-w-0 w-full max-w-full gap-3 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none]">
              {productSuggestions.map((suggestedProduct) => (
                <button
                  key={suggestedProduct.id}
                  type="button"
                  className="w-[170px] shrink-0 rounded-2xl border border-amber-100 bg-[#fffaf0] p-2 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-md sm:w-[190px]"
                  onClick={() => onProductSuggestion(suggestedProduct)}
                >
                  <div className="overflow-hidden rounded-xl border border-amber-100 bg-white">
                    {suggestedProduct.imageUrl ? (
                      <img src={suggestedProduct.imageUrl} alt={suggestedProduct.name} loading="lazy" className="h-20 w-full object-cover" />
                    ) : (
                      <div className="flex h-20 items-center justify-center bg-amber-50">
                        <img src={bmqLogo} alt="BMQ" className="h-10 w-10 object-contain" />
                      </div>
                    )}
                  </div>
                  <div className="mt-2 line-clamp-2 text-sm font-bold leading-5 text-[#3f2411]">{suggestedProduct.name}</div>
                  <div className="mt-1 truncate text-xs font-semibold text-amber-700">{formatVnd(suggestedProduct.price)} / {suggestedProduct.unit}</div>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {selectedRouteCount > 0 ? (
        <>
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-amber-200 bg-white/95 px-4 pb-3 pt-3 shadow-[0_-10px_30px_rgba(63,36,17,0.16)] backdrop-blur lg:hidden" data-stitch-dealer-order-bottom-bar="mobile">
            <div className="mx-auto flex max-w-6xl items-center gap-3">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setDetailOpen(true)}>
                <div className="text-sm font-extrabold text-[#3f2411]">{selectedRouteCount} dòng • giao {totalItems} {unitLabel}</div>
                <div className="truncate text-xs font-medium text-[#765333]">Tạm tính {formatVnd(cartTotal)} • Bấm để xem chi tiết</div>
              </button>
              <Button type="button" className="h-12 shrink-0 rounded-2xl bg-amber-500 px-4 font-bold text-[#2b1708] hover:bg-amber-400" disabled={!canSubmit || submitting} onClick={onSubmit}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Gửi đơn
              </Button>
            </div>
          </div>

          <div className="hidden rounded-3xl border border-amber-100 bg-white p-4 shadow-sm lg:block" data-stitch-dealer-order-bottom-bar="desktop">
            <div className="flex items-center justify-between gap-3">
              <button type="button" className="min-w-0 text-left" onClick={() => setDetailOpen(true)}>
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">Đơn đã nhận</div>
                <h3 className="mt-1 text-xl font-display font-extrabold text-[#3f2411]">{selectedRouteCount} dòng • giao {totalItems} {unitLabel}</h3>
                <div className="text-sm font-medium text-[#765333]">Bấm để xem và chỉnh chi tiết</div>
              </button>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-xs text-[#8a6a4a]">Tạm tính</div>
                  <div className="text-lg font-extrabold text-[#3f2411]">{formatVnd(cartTotal)}</div>
                </div>
                <Button type="button" className="h-12 rounded-2xl bg-amber-500 px-5 font-bold text-[#2b1708] hover:bg-amber-400" disabled={!canSubmit || submitting} onClick={onSubmit}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Gửi đơn
                </Button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="top-3 max-h-[calc(100dvh-1.5rem)] max-w-lg translate-y-0 overflow-y-auto rounded-3xl border-amber-200 bg-[#fffaf0] p-0 pb-[env(safe-area-inset-bottom)] text-[#3f2411] shadow-2xl sm:top-[50%] sm:translate-y-[-50%]">
          <div className="sticky top-0 z-10 border-b border-amber-100 bg-[#fffaf0]/95 p-5 backdrop-blur">
            <DialogHeader>
              <DialogTitle className="text-xl font-display font-extrabold">Chi tiết đơn hàng</DialogTitle>
              <DialogDescription className="text-sm text-[#765333]">
                {selectedRouteCount} dòng • giao {totalItems} {unitLabel} • tạm tính {formatVnd(cartTotal)}
              </DialogDescription>
            </DialogHeader>
          </div>
          <div className="space-y-3 p-5">
            {routes.map((route) => {
              const ordered = quantities[route.id] || 0;
              const exchange = exchangeQuantities[route.id] || 0;
              const makeup = makeupQuantities[route.id] || 0;
              const physical = ordered + exchange + makeup;
              if (physical <= 0) return null;
              return (
                <div key={route.id} className="rounded-3xl border border-amber-100 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-extrabold text-[#3f2411]">{route.name}</div>
                      <div className="mt-1 text-xs font-medium text-[#8a6a4a]">
                        Giao {physical} {unitLabel} • Tính tiền {ordered} {unitLabel}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-sm font-extrabold text-[#3f2411]">
                      {formatVnd(ordered * product.price)}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2">
                    <MiniQuantityField label="Đặt" value={ordered} step={DEALER_ORDER_STEP} onChange={(value) => setQuantities((current) => ({ ...current, [route.id]: value }))} />
                    <MiniQuantityField label="Đổi" value={exchange} step={1} onChange={(value) => setExchangeQuantities((current) => ({ ...current, [route.id]: value }))} />
                    <MiniQuantityField label="Bù" value={makeup} step={1} onChange={(value) => setMakeupQuantities((current) => ({ ...current, [route.id]: value }))} />
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-2 py-2 text-center">
                      <div className="text-[11px] font-bold uppercase text-emerald-700">Giao</div>
                      <div className="mt-1 text-base font-extrabold text-[#3f2411]">{physical}</div>
                    </div>
                  </div>
                  <Input
                    value={notes[route.id] || ""}
                    placeholder="Ghi chú"
                    className="mt-2 h-10 rounded-2xl border-amber-100 bg-white text-sm"
                    onChange={(event) => setNotes((current) => ({ ...current, [route.id]: event.target.value.slice(0, 160) }))}
                  />
                </div>
              );
            })}
          </div>
          <DialogFooter className="sticky bottom-0 border-t border-amber-100 bg-[#fffaf0]/95 p-5 backdrop-blur">
            <Button type="button" variant="outline" className="h-11 rounded-2xl border-amber-200" onClick={() => setDetailOpen(false)}>
              Đóng
            </Button>
            <Button type="button" className="h-11 rounded-2xl bg-amber-500 font-bold text-[#2b1708] hover:bg-amber-400" disabled={!canSubmit || submitting} onClick={onSubmit}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Gửi đơn
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


function QuantityCell({
  value,
  step,
  placeholder,
  onChange,
}: {
  value: number | string;
  step: number;
  placeholder: string;
  onChange: (value: number) => void;
}) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={0}
      step={step}
      value={value}
      placeholder={placeholder}
      className="h-11 rounded-2xl border-amber-200 bg-amber-50/70 text-right text-base font-extrabold text-[#3f2411] focus-visible:ring-amber-400"
      onChange={(event) => {
        const nextValue = Number(event.target.value.replace(/[^0-9]/g, ""));
        onChange(Number.isFinite(nextValue) ? nextValue : 0);
      }}
    />
  );
}


function MiniQuantityField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="rounded-2xl border border-amber-100 bg-white px-2 py-2 text-center">
      <span className="text-[11px] font-bold uppercase text-[#8a6a4a]">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={step}
        value={value || ""}
        placeholder="0"
        className="mt-1 h-9 border-0 bg-transparent p-0 text-center text-base font-extrabold text-[#3f2411] shadow-none focus-visible:ring-0"
        onChange={(event) => {
          const nextValue = Number(event.target.value.replace(/[^0-9]/g, ""));
          onChange(Number.isFinite(nextValue) ? nextValue : 0);
        }}
      />
    </label>
  );
}

type ParsedDealerChatLine = {
  route: DealerRoute | null;
  routeText: string;
  orderedQuantity: number;
  exchangeQuantity: number;
  makeupQuantity: number;
  note: string;
};

const DEALER_CHAT_ROUTE_ALIASES: Array<{ canonicalIncludes: string; aliases: string[] }> = [
  { canonicalIncludes: "rach gia", aliases: ["rach gia", "rạch giá"] },
  { canonicalIncludes: "dong van cong", aliases: ["dvc", "đvc", "dong van cong", "đồng văn cống"] },
  { canonicalIncludes: "topsmarket au co", aliases: ["topsmarket au co", "topsmarket âu cơ", "au co", "âu cơ"] },
  { canonicalIncludes: "coopmart nat", aliases: ["coopmart nat", "nat", "hoc mon", "hóc môn"] },
  { canonicalIncludes: "satra cu chi", aliases: ["satra cu chi", "củ chi", "cu chi"] },
  { canonicalIncludes: "quang trung", aliases: ["quang trung"] },
  { canonicalIncludes: "linh trung", aliases: ["linh trung", "xtra linh trung"] },
  { canonicalIncludes: "di an", aliases: ["di an", "dĩ an"] },
  { canonicalIncludes: "my tho", aliases: ["my tho", "mỹ tho"] },
  { canonicalIncludes: "phan thiet", aliases: ["phan thiet", "phan thiết"] },
];

const normalizeDealerChatText = (value: string) =>
  String(value || "")
    .toLocaleLowerCase("vi-VN")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/ð/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const splitDealerChatOrderLines = (text: string) =>
  String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/,\s*(?=[^,\n]+\s+\d)/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const numberFromDealerChatText = (value: string | undefined) => Number(String(value || "0").replace(",", "."));

function findDealerChatRoute(routeText: string, routes: DealerRoute[]) {
  const routeKey = normalizeDealerChatText(routeText.replace(/^đại\s+lý\s+/i, ""));
  const direct = routes.find((route) => {
    const nameKey = normalizeDealerChatText(route.name.replace(/^đại\s+lý\s+/i, ""));
    return nameKey === routeKey || nameKey.includes(routeKey) || routeKey.includes(nameKey);
  });
  if (direct) return direct;

  const alias = DEALER_CHAT_ROUTE_ALIASES.find((entry) => entry.aliases.some((value) => normalizeDealerChatText(value) === routeKey));
  if (!alias) return null;
  return routes.find((route) => normalizeDealerChatText(route.name).includes(alias.canonicalIncludes)) || null;
}

function parseDealerChatOrderText(text: string, routes: DealerRoute[]): ParsedDealerChatLine[] {
  return splitDealerChatOrderLines(text).map((rawLine) => {
    const match = rawLine.match(/^\s*(?:\d+[.)]\s*)?(.+?)\s+(\d+(?:[.,]\d+)?)\b(.*)$/i);
    if (!match) return null;
    const routeText = match[1].trim();
    const orderedQuantity = numberFromDealerChatText(match[2]);
    const tail = String(match[3] || "");
    const exchangeQuantity = numberFromDealerChatText(tail.match(/(?:^|\s)(?:đổi|doi)\s+(\d+(?:[.,]\d+)?)/i)?.[1]);
    const makeupQuantity = numberFromDealerChatText(tail.match(/(?:^|\s)(?:bù|bu)\s+(\d+(?:[.,]\d+)?)/i)?.[1]);
    if (!routeText || !Number.isFinite(orderedQuantity) || orderedQuantity < 0) return null;
    return {
      route: findDealerChatRoute(routeText, routes),
      routeText,
      orderedQuantity,
      exchangeQuantity: Number.isFinite(exchangeQuantity) ? exchangeQuantity : 0,
      makeupQuantity: Number.isFinite(makeupQuantity) ? makeupQuantity : 0,
      note: tail.trim(),
    };
  }).filter((line): line is ParsedDealerChatLine => Boolean(line));
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
  nppLines = [],
  totalItems,
  cartTotal,
  compact = false,
  isNppMode = false,
  canSubmit,
  submitting,
  onSubmit,
}: {
  selectedLines: Array<Product & { quantity: number; lineTotal: number }>;
  nppLines?: NppOrderLine[];
  totalItems: number;
  cartTotal: number;
  compact?: boolean;
  isNppMode?: boolean;
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
            {isNppMode ? nppLines.length : selectedLines.length} dòng • {totalItems} {isNppMode ? (nppLines[0]?.product.unit || "que") : "đơn vị"}
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
          {isNppMode ? "Đơn NPP" : "Giỏ hàng"}
        </CardTitle>
        <CardDescription>{isNppMode ? "Một đơn NPP gồm nhiều điểm bán con." : "Đơn sẽ được gửi cho BMQ sau khi đại lý xác thực OTP."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <div className="space-y-3">
          {(isNppMode ? nppLines.length : selectedLines.length) === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              {isNppMode ? "Chưa nhập số lượng cho điểm bán." : "Chưa chọn sản phẩm."}
            </div>
          ) : isNppMode ? (
            nppLines.map((line) => (
              <div key={line.route.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{line.route.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Giao {line.physicalQuantity} {line.product.unit} • tính tiền {line.quantity}
                  </div>
                </div>
                <div className="shrink-0 font-medium">{formatVnd(line.lineTotal)}</div>
              </div>
            ))
          ) : (
            selectedLines.map((line) => (
              <div key={line.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{line.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {line.quantity} {line.unit}
                  </div>
                </div>
                <div className="shrink-0 font-medium">{formatVnd(line.lineTotal)}</div>
              </div>
            ))
          )}
        </div>

        <div className="border-t pt-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{isNppMode ? "Tổng số lượng" : "Tổng số lượng"}</span>
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
          {isNppMode ? "Bấm gửi sẽ mở màn hình xác nhận các điểm bán trước khi ghi đơn." : "Cần OTP hợp lệ và danh sách sản phẩm đang mở bán trước khi gửi đơn."}
        </p>
      </CardContent>
    </Card>
  );
}

