import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BadgePercent,
  BellRing,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
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
import "@/styles/dealer-order-history.css";

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

type DealerOrderHistoryItem = {
  id: string;
  sku_code: string;
  product_name: string;
  unit: string;
  ordered_quantity: number;
  exchange_quantity: number;
  makeup_quantity: number;
  physical_quantity: number;
  unit_price_vnd: number;
  line_total_vnd: number;
  route_customer_name?: string | null;
  route_note?: string | null;
};

type DealerOrderHistoryOrder = {
  id: string;
  order_number: string;
  status: string;
  currency: string;
  total_amount_vnd: number;
  requested_delivery_date?: string | null;
  delivery_note?: string | null;
  customer_note?: string | null;
  submitted_at: string;
  physical_quantity: number;
  items: DealerOrderHistoryItem[];
};

type DealerOrderHistoryResponse = {
  success?: boolean;
  code?: string;
  exact_order?: DealerOrderHistoryOrder;
  summary?: {
    order_count?: number;
    total_physical_quantity?: number;
    total_amount_vnd?: number;
  };
  pagination?: {
    page?: number;
    page_size?: number;
    total_orders?: number;
    total_pages?: number;
  };
  orders?: DealerOrderHistoryOrder[];
};

type DealerQuickOrderSuggestionResponse = {
  success?: boolean;
  target_delivery_date: string;
  already_ordered: { order_number: string } | null;
  suggestion: {
    source_order_id: string;
    source_order_number: string;
    source_delivery_date: string;
    items: Array<{
      sku_id: string;
      sku_code: string;
      product_name: string;
      unit: string;
      ordered_quantity: number;
      exchange_quantity: number;
      makeup_quantity: number;
      physical_quantity: number;
    }>;
  } | null;
};

type DealerOrderHistoryGranularity = "day" | "month" | "year";
type DealerOrderHistoryStatus = "idle" | "loading" | "live" | "error";

type DuplicateOrderPrompt = {
  items: Array<Record<string, unknown>>;
  chatNative: boolean;
  clientSubmissionId: string;
  orderNumber: string;
  requestedDeliveryDate?: string;
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
const DEALER_ORDER_DEEP_LINK_STORAGE_KEY = "bmq_dealer_order_deep_link";
const DEALER_ORDER_STEP = 10;
const DEFAULT_DEALER_CHAT_PRODUCT_SKU = "BMQ-001";

function readDealerOrderDeepLink() {
  const searchParams = new URLSearchParams(window.location.search);
  const linkedOrder = searchParams.get("view") === "orders" ? searchParams.get("order")?.trim() || "" : "";
  if (linkedOrder) sessionStorage.setItem(DEALER_ORDER_DEEP_LINK_STORAGE_KEY, linkedOrder);
  return linkedOrder || sessionStorage.getItem(DEALER_ORDER_DEEP_LINK_STORAGE_KEY) || "";
}

const DEALER_HALLMARK_TOKENS = {
  "--dealer-paper": "#fff9f5",
  "--dealer-surface": "#ffffff",
  "--dealer-surface-soft": "#fff2f7",
  "--dealer-ink": "#34252c",
  "--dealer-ink-muted": "#806873",
  "--dealer-rule": "#edd4df",
  "--dealer-accent": "#d94f8a",
  "--dealer-accent-strong": "#bd3f75",
  "--dealer-accent-soft": "#f5dce7",
  "--dealer-focus": "#b83b70",
} as CSSProperties;

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

const formatDealerQuantity = (value: number) =>
  new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(value);

const currentDealerHistoryAnchor = (granularity: DealerOrderHistoryGranularity) => {
  const vietnamToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (granularity === "day") return vietnamToday;
  if (granularity === "year") return vietnamToday.slice(0, 4);
  return vietnamToday.slice(0, 7);
};

const formatDealerOrderTime = (value: string) =>
  new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

const formatDealerDeliveryDate = (value?: string | null) => {
  if (!value) return "Chưa hẹn ngày";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
};

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
            {error || "Quý Khách Hàng bấm tải lại. Nếu vẫn lỗi, vui lòng đăng xuất rồi đăng nhập OTP lại để làm mới phiên đại lý."}
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
  const [activeNav, setActiveNav] = useState("messages");
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
  const [duplicateOrderPrompt, setDuplicateOrderPrompt] = useState<DuplicateOrderPrompt | null>(null);
  const orderSubmissionIdRef = useRef(crypto.randomUUID());
  const orderSubmittingRef = useRef(false);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [nppQuantities, setNppQuantities] = useState<Record<string, number>>({});
  const [nppExchangeQuantities, setNppExchangeQuantities] = useState<Record<string, number>>({});
  const [nppMakeupQuantities, setNppMakeupQuantities] = useState<Record<string, number>>({});
  const [nppNotes, setNppNotes] = useState<Record<string, string>>({});
  const [nppOrderText, setNppOrderText] = useState("");
  const [nppLastSentOrderText, setNppLastSentOrderText] = useState("");
  const [nppParseMessage, setNppParseMessage] = useState("");
  const [nppParseStatus, setNppParseStatus] = useState<"idle" | "processing" | "success">("idle");
  const [chatProductId, setChatProductId] = useState("");
  const [directCatalogOrder, setDirectCatalogOrder] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [draftQuantity, setDraftQuantity] = useState("");
  const [quantityModalError, setQuantityModalError] = useState("");
  const [activeCategory, setActiveCategory] = useState("Tất cả");
  const [productSearch, setProductSearch] = useState("");
  const [dealerProfileOpen, setDealerProfileOpen] = useState(false);
  const [orderHistoryGranularity, setOrderHistoryGranularity] = useState<DealerOrderHistoryGranularity>("month");
  const [orderHistoryAnchor, setOrderHistoryAnchor] = useState(() => currentDealerHistoryAnchor("month"));
  const [orderHistoryPage, setOrderHistoryPage] = useState(1);
  const [orderHistoryStatus, setOrderHistoryStatus] = useState<DealerOrderHistoryStatus>("idle");
  const [orderHistoryError, setOrderHistoryError] = useState("");
  const [orderHistoryData, setOrderHistoryData] = useState<DealerOrderHistoryResponse | null>(null);
  const [selectedHistoryOrder, setSelectedHistoryOrder] = useState<DealerOrderHistoryOrder | null>(null);
  const [pendingOrderDeepLink, setPendingOrderDeepLink] = useState(readDealerOrderDeepLink);
  const [deepLinkedOrderActive, setDeepLinkedOrderActive] = useState(false);
  const [quickOrderSuggestion, setQuickOrderSuggestion] = useState<DealerQuickOrderSuggestionResponse | null>(null);
  const [quickOrderSuggestionStatus, setQuickOrderSuggestionStatus] = useState<"idle" | "loading" | "live">("idle");

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

  const loadOrderHistory = useCallback(async () => {
    if (!sessionToken || activeNav !== "orders" || pendingOrderDeepLink || deepLinkedOrderActive) return;
    setOrderHistoryStatus("loading");
    setOrderHistoryError("");

    const { data, error, isSessionExpired } = await callEdgeFunction<DealerOrderHistoryResponse>("dealer-order-history", {
      dealer_token: sessionToken,
      granularity: orderHistoryGranularity,
      anchor: orderHistoryAnchor,
      page: orderHistoryPage,
      page_size: 10,
    }, undefined, 12000);

    if (error || !data) {
      if (isSessionExpired) {
        localStorage.removeItem(DEALER_SESSION_STORAGE_KEY);
        localStorage.removeItem(DEALER_PROFILE_CACHE_KEY);
        localStorage.removeItem(DEALER_CATALOG_CACHE_KEY);
        setSessionToken("");
        setLoginStep("phone");
        setActiveNav("messages");
      }
      setOrderHistoryError(error || "Không tải được lịch sử đơn hàng. Vui lòng thử lại.");
      setOrderHistoryStatus("error");
      return;
    }

    setOrderHistoryData(data);
    setOrderHistoryStatus("live");
  }, [activeNav, deepLinkedOrderActive, orderHistoryAnchor, orderHistoryGranularity, orderHistoryPage, pendingOrderDeepLink, sessionToken]);

  useEffect(() => {
    void loadOrderHistory();
  }, [loadOrderHistory]);

  useEffect(() => {
    if (!pendingOrderDeepLink) return;
    setActiveNav("orders");
    if (!sessionToken) return;

    let cancelled = false;
    const loadExactOrder = async () => {
      setOrderHistoryStatus("loading");
      setOrderHistoryError("");
      const { data, error, isSessionExpired } = await callEdgeFunction<DealerOrderHistoryResponse>("dealer-order-history", {
        dealer_token: sessionToken,
        order_number: pendingOrderDeepLink,
      }, undefined, 12000);
      if (cancelled) return;
      if (error || !data?.exact_order) {
        if (isSessionExpired) {
          localStorage.removeItem(DEALER_SESSION_STORAGE_KEY);
          setSessionToken("");
          setLoginStep("phone");
          return;
        }
        setOrderHistoryError("Không tìm thấy đơn hàng trong tài khoản này.");
        setOrderHistoryStatus("error");
        sessionStorage.removeItem(DEALER_ORDER_DEEP_LINK_STORAGE_KEY);
        setPendingOrderDeepLink("");
        return;
      }

      const exactOrder = data.exact_order;
      setOrderHistoryData({
        success: true,
        summary: {
          order_count: 1,
          total_physical_quantity: exactOrder.physical_quantity,
          total_amount_vnd: exactOrder.total_amount_vnd,
        },
        pagination: { page: 1, page_size: 10, total_orders: 1, total_pages: 1 },
        orders: [exactOrder],
      });
      setSelectedHistoryOrder(exactOrder);
      setOrderHistoryStatus("live");
      setDeepLinkedOrderActive(true);
      sessionStorage.removeItem(DEALER_ORDER_DEEP_LINK_STORAGE_KEY);
      setPendingOrderDeepLink("");
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("view");
      cleanUrl.searchParams.delete("order");
      window.history.replaceState({}, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    };
    void loadExactOrder();
    return () => {
      cancelled = true;
    };
  }, [pendingOrderDeepLink, sessionToken]);

  const handleOrderHistoryGranularityChange = (granularity: DealerOrderHistoryGranularity) => {
    setDeepLinkedOrderActive(false);
    setOrderHistoryGranularity(granularity);
    setOrderHistoryAnchor(currentDealerHistoryAnchor(granularity));
    setOrderHistoryPage(1);
    setSelectedHistoryOrder(null);
  };

  const handleOrderHistoryAnchorChange = (anchor: string) => {
    setDeepLinkedOrderActive(false);
    setOrderHistoryAnchor(anchor);
    setOrderHistoryPage(1);
    setSelectedHistoryOrder(null);
  };

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
      setActiveNav(pendingOrderDeepLink ? "orders" : "messages");
      setOtp("");
      setAuthMessage("Đã xác thực đại lý. Quý Khách Hàng có thể gửi đơn thật.");
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
    setNppLastSentOrderText("");
    setNppParseMessage("");
    setNppParseStatus("idle");
    setDirectCatalogOrder(false);
    setActiveNav("messages");
    setOrderHistoryData(null);
    setOrderHistoryStatus("idle");
    setOrderHistoryError("");
    setOrderHistoryPage(1);
    setSelectedHistoryOrder(null);
    setDeepLinkedOrderActive(false);
    setLoginStep("phone");
    setOtp("");
    setAuthMessage("");
    setAuthError("");
    setOrderMessage("");
    setOrderError("");
    setDuplicateOrderPrompt(null);
    orderSubmissionIdRef.current = crypto.randomUUID();
  };

  const submitOrderPayload = async (
    items: Array<Record<string, unknown>>,
    options: {
      chatNative?: boolean;
      duplicateAction?: "continue";
      clientSubmissionId?: string;
      requestedDeliveryDate?: string;
      quickReorder?: boolean;
    } = {},
  ) => {
    if (orderSubmittingRef.current) return false;
    orderSubmittingRef.current = true;
    setOrderSubmitting(true);
    setOrderMessage("");
    setOrderError("");

    const clientSubmissionId = options.clientSubmissionId || orderSubmissionIdRef.current;
    try {
      const { data, error } = await supabase.functions.invoke<{
        success?: boolean;
        code?: string;
        message?: string;
        order_number?: string;
        total_amount_vnd?: number;
        duplicate_order?: { order_number?: string };
      }>("dealer-order-submit", {
        body: {
          dealer_token: sessionToken,
          items,
          client_submission_id: clientSubmissionId,
          ...(options.requestedDeliveryDate ? { requested_delivery_date: options.requestedDeliveryDate } : {}),
          ...(options.quickReorder ? { quick_reorder: true } : {}),
          ...(options.duplicateAction ? { duplicate_action: options.duplicateAction } : {}),
        },
      });

      if (error) throw error;
      if (data?.code === "similar_order_exists") {
        const previousOrderNumber = data.duplicate_order?.order_number || "đơn gần nhất";
        setDuplicateOrderPrompt({
          items,
          chatNative: Boolean(options.chatNative),
          clientSubmissionId,
          orderNumber: previousOrderNumber,
          requestedDeliveryDate: options.requestedDeliveryDate,
        });
        setNppConfirmOpen(false);
        setNppParseStatus("success");
        setNppParseMessage(data.message || "Đơn hàng tương tự đã được đặt! Quý khách hàng muốn tiếp tục hay huỷ?");
        return false;
      }
      if (data?.code === "target_delivery_date_exists") {
        setOrderError(data.message || "Đã có đơn cho ngày giao này.");
        setQuickOrderSuggestion(null);
        return false;
      }
      if (!data?.success) throw new Error(data?.message || "Không gửi được đơn hàng.");

      const nextOrderNumber = data.order_number || "";
      setDuplicateOrderPrompt(null);
      setOrderSuccessNumber(nextOrderNumber);
      setOrderSuccessOpen(!options.chatNative);
      setNppConfirmOpen(false);
      setOrderMessage(
        options.chatNative
          ? `${nextOrderNumber ? `Mã đơn ${nextOrderNumber}. ` : ""}Cảm ơn Quý Khách Hàng đã đặt hàng cùng BMQ.`
          : `Đã gửi đơn ${nextOrderNumber}. Xin cảm ơn quý khách đã chọn lựa Bánh Mì Que Pháp BMQ.`,
      );
      setQuantities({});
      setNppQuantities({});
      setNppExchangeQuantities({});
      setNppMakeupQuantities({});
      setNppNotes({});
      setNppOrderText("");
      setNppParseMessage("");
      setNppParseStatus("idle");
      orderSubmissionIdRef.current = crypto.randomUUID();
      return true;
    } catch (error) {
      setOrderError(await getFunctionErrorMessage(error, "Không gửi được đơn hàng."));
      return false;
    } finally {
      orderSubmittingRef.current = false;
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

  const handleStartNewNppOrder = () => {
    setNppConfirmOpen(false);
    setNppQuantities({});
    setNppExchangeQuantities({});
    setNppMakeupQuantities({});
    setNppNotes({});
    setNppOrderText("");
    setNppLastSentOrderText("");
    setNppParseMessage("");
    setNppParseStatus("idle");
    setDirectCatalogOrder(false);
    setOrderMessage("");
    setOrderError("");
    setDuplicateOrderPrompt(null);
    orderSubmissionIdRef.current = crypto.randomUUID();
  };


  const handleParseNppOrderText = () => {
    const submittedText = nppOrderText.trim();
    if (!submittedText) return;

    setNppLastSentOrderText(submittedText);
    setNppOrderText("");
    if (isDealerChatConfirmationIntent(submittedText)) {
      const hasReadyOrder = nppSelectedLines.length > 0;
      setOrderMessage("");
      setOrderError("");
      setNppParseStatus(hasReadyOrder ? "success" : "idle");
      setNppParseMessage(
        hasReadyOrder
          ? "Đơn đã sẵn sàng. Quý Khách Hàng kiểm tra lần cuối trước khi gửi nhé."
          : "Quý Khách Hàng chưa có đơn để xác nhận. Hãy nhập đơn mới hoặc chọn Xem mẫu.",
      );
      if (hasReadyOrder) setNppConfirmOpen(true);
      return;
    }
    setDuplicateOrderPrompt(null);
    orderSubmissionIdRef.current = crypto.randomUUID();
    if (isNppMode) setDirectCatalogOrder(false);
    setNppParseStatus("processing");
    setNppParseMessage("");
    setOrderMessage("");
    setOrderError("");
    setNppQuantities({});
    setNppExchangeQuantities({});
    setNppMakeupQuantities({});
    setNppNotes({});

    window.setTimeout(() => {
      const parsedLines = isNppMode
        ? parseDealerChatOrderText(submittedText, dealerRoutes)
        : parseRetailDealerChatOrderText(submittedText, retailDealerRoute);
      if (!parsedLines.length) {
        setNppParseStatus("idle");
        setNppParseMessage(
          isNppMode
            ? "Em chưa nhận diện được điểm bán. Quý Khách Hàng có thể nhắn theo mẫu: Rạch Giá 200 đổi 10, ĐVC 100 bù 3."
            : "Em chưa nhận diện được số lượng. Quý Khách Hàng chỉ cần nhắn số lượng, đổi hoặc bù, ví dụ: 200 đổi 14 bù 5.",
        );
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
      const matchedLineCount = parsedLines.length - unmatched.length;
      if (matchedLineCount === 0) {
        setNppParseStatus("idle");
        setNppParseMessage(`Em chưa nhận diện được điểm bán: ${unmatched.slice(0, 3).join(", ")}. Quý Khách Hàng chọn Xem mẫu hoặc nhập lại đơn nhé.`);
        return;
      }
      setNppParseStatus("success");
      setNppParseMessage(
        unmatched.length
          ? `Em đã chuẩn bị ${matchedLineCount} dòng để xác nhận. Chưa khớp: ${unmatched.slice(0, 3).join(", ")}.`
          : "Em đã chuẩn bị bản xác nhận đơn. Quý Khách Hàng kiểm tra giúp em nhé.",
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
      ...(isNppMode && !directCatalogOrder
        ? {
            route_customer_id: line.route.id,
            route_customer_name: line.route.name,
            route_note: line.note,
          }
        : {
            route_customer_name: dealerDisplayName,
            route_note: line.note,
          }),
    })), { chatNative: true });
  };

  const handleDuplicateOrderContinue = async () => {
    if (!duplicateOrderPrompt) return;
    await submitOrderPayload(duplicateOrderPrompt.items, {
      chatNative: duplicateOrderPrompt.chatNative,
      duplicateAction: "continue",
      clientSubmissionId: duplicateOrderPrompt.clientSubmissionId,
      requestedDeliveryDate: duplicateOrderPrompt.requestedDeliveryDate,
    });
  };

  const handleDuplicateOrderCancel = () => {
    if (!duplicateOrderPrompt) return;
    const keptOrderNumber = duplicateOrderPrompt.orderNumber;
    setDuplicateOrderPrompt(null);
    setNppConfirmOpen(false);
    setNppQuantities({});
    setNppExchangeQuantities({});
    setNppMakeupQuantities({});
    setNppNotes({});
    setOrderError("");
    setOrderMessage("");
    setNppParseStatus("idle");
    setNppParseMessage(`Đã huỷ đơn trùng. Đơn ${keptOrderNumber} trước đó vẫn được giữ nguyên.`);
    orderSubmissionIdRef.current = crypto.randomUUID();
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
  const dealerDisplayName = toDisplayName(dealerCustomer?.name) || dealerCustomer?.code || "Đại lý BMQ";
  const retailDealerRoute = useMemo<DealerRoute | null>(() => dealerCustomer ? ({
    id: dealerCustomer.id,
    name: dealerDisplayName,
    code: dealerCustomer.code,
    address: dealerCustomer.address,
  }) : null, [dealerCustomer, dealerDisplayName]);
  const directDealerOrder = !isNppMode || directCatalogOrder;
  const chatOrderRoutes = useMemo(
    () => directDealerOrder && retailDealerRoute ? [retailDealerRoute] : dealerRoutes,
    [dealerRoutes, directDealerOrder, retailDealerRoute],
  );
  const nppProduct = useMemo(
    () => catalogProducts.find(
      (product) => product.skuCode?.trim().toUpperCase() === DEFAULT_DEALER_CHAT_PRODUCT_SKU,
    ) || catalogProducts.find(
      (product) => normalizeDealerChatText(`${product.name} ${product.skuCode || ""}`).includes("banh mi que"),
    ) || null,
    [catalogProducts],
  );
  const chatProduct = useMemo(
    () => catalogProducts.find((product) => product.id === chatProductId) || nppProduct,
    [catalogProducts, chatProductId, nppProduct],
  );
  const quickOrderItem = quickOrderSuggestion?.suggestion?.items[0] || null;
  const quickOrderProduct = useMemo(
    () => !quickOrderItem ? null : catalogProducts.find((product) =>
      product.id === quickOrderItem.sku_id || product.skuCode?.trim().toUpperCase() === quickOrderItem.sku_code.trim().toUpperCase()
    ) || null,
    [catalogProducts, quickOrderItem],
  );

  useEffect(() => {
    if (!sessionToken || catalogStatus !== "live" || isNppMode) {
      setQuickOrderSuggestion(null);
      setQuickOrderSuggestionStatus("idle");
      return;
    }

    let cancelled = false;
    setQuickOrderSuggestionStatus("loading");
    void (async () => {
      const { data, error } = await callEdgeFunction<DealerQuickOrderSuggestionResponse>("dealer-order-history", {
        dealer_token: sessionToken,
        quick_reorder: true,
      }, undefined, 8000);
      if (cancelled) return;
      if (error || !data?.success) {
        setQuickOrderSuggestion(null);
        setQuickOrderSuggestionStatus("live");
        return;
      }
      setQuickOrderSuggestion(data);
      setQuickOrderSuggestionStatus("live");
    })();
    return () => { cancelled = true; };
  }, [catalogStatus, isNppMode, sessionToken]);

  const handleQuickReorderSubmit = async () => {
    if (!quickOrderSuggestion?.suggestion || !quickOrderItem || !quickOrderProduct) return;
    if (quickOrderItem.ordered_quantity % DEALER_ORDER_STEP !== 0) {
      setOrderError(`Số lượng ${quickOrderProduct.name} phải là bội số ${DEALER_ORDER_STEP} ${quickOrderProduct.unit || "que"}.`);
      return;
    }
    const submitted = await submitOrderPayload([{
      sku_id: quickOrderProduct.id,
      quantity: quickOrderItem.ordered_quantity,
      ordered_quantity: quickOrderItem.ordered_quantity,
      exchange_quantity: 0,
      makeup_quantity: 0,
      physical_quantity: quickOrderItem.ordered_quantity,
      route_customer_name: dealerDisplayName,
      route_note: "",
    }], {
      chatNative: true,
      requestedDeliveryDate: quickOrderSuggestion.target_delivery_date,
      quickReorder: true,
    });
    if (submitted) setQuickOrderSuggestion(null);
  };

  const handleQuickReorderEdit = () => {
    if (!quickOrderItem || !quickOrderProduct) return;
    setSelectedProduct(quickOrderProduct);
    setDraftQuantity(String(quickOrderItem.ordered_quantity));
    setQuantityModalError("");
  };

  const handleViewExistingQuickOrder = () => {
    const orderNumber = quickOrderSuggestion?.already_ordered?.order_number;
    if (!orderNumber) return;
    sessionStorage.setItem(DEALER_ORDER_DEEP_LINK_STORAGE_KEY, orderNumber);
    setPendingOrderDeepLink(orderNumber);
    setActiveNav("orders");
  };
  const nppSelectedLines = useMemo<NppOrderLine[]>(
    () => !chatProduct ? [] : chatOrderRoutes
      .map((route) => {
        const quantity = nppQuantities[route.id] || 0;
        const exchangeQuantity = nppExchangeQuantities[route.id] || 0;
        const makeupQuantity = nppMakeupQuantities[route.id] || 0;
        const physicalQuantity = quantity + exchangeQuantity + makeupQuantity;
        return {
          route,
          product: chatProduct,
          quantity,
          exchangeQuantity,
          makeupQuantity,
          physicalQuantity,
          note: nppNotes[route.id] || "",
          lineTotal: quantity * chatProduct.price,
        };
      })
      .filter((line) => line.physicalQuantity > 0),
    [chatOrderRoutes, chatProduct, nppExchangeQuantities, nppMakeupQuantities, nppNotes, nppQuantities],
  );
  const chatTotalItems = nppSelectedLines.reduce((sum, line) => sum + line.physicalQuantity, 0);
  const chatCartTotal = nppSelectedLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const totalItems = isNppMode ? chatTotalItems : selectedLines.reduce((sum, product) => sum + product.quantity, 0);
  const cartTotal = isNppMode ? chatCartTotal : selectedLines.reduce((sum, product) => sum + product.lineTotal, 0);
  const isCatalogUnlocked = loginStep === "catalog" && Boolean(sessionToken);
  const isCatalogRestoring = isCatalogUnlocked && isCatalogRefreshing && !dealerProfileCache.customer;
  const activeLandingBanner = landingBanners[activeLandingBannerIndex] || landingBanners[0];
  const activeLandingBannerUrl = activeLandingBanner?.url || landingBannerUrl;
  const activePromotionPath = window.location.hostname === "dathang.banhmique.vn"
    ? `/promotion/${activeLandingBanner?.id || "event-1"}`
    : `/dealer/promotion/${activeLandingBanner?.id || "event-1"}`;
  const categoryChips = ["Tất cả", "Bánh mì", "Bánh ngọt", "Bán chạy"];
  const featuredProducts = catalogProducts.slice(0, 3);
  const productCarouselProducts = catalogProducts;
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
    openProductDialog(product);
  };

  const resetChatOrderForProduct = (product: Product) => {
    setChatProductId(product.id);
    setNppQuantities({});
    setNppExchangeQuantities({});
    setNppMakeupQuantities({});
    setNppNotes({});
    setNppOrderText("");
    setNppLastSentOrderText("");
    setOrderMessage("");
    setOrderError("");
    setDuplicateOrderPrompt(null);
    orderSubmissionIdRef.current = crypto.randomUUID();
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

    if (activeNav === "order") {
      if (!retailDealerRoute || nextQuantity <= 0) {
        setQuantityModalError(`Vui lòng nhập ít nhất ${DEALER_ORDER_STEP} ${selectedProduct.unit || "đơn vị"}.`);
        return;
      }
      resetChatOrderForProduct(selectedProduct);
      setDirectCatalogOrder(true);
      setNppQuantities({ [retailDealerRoute.id]: nextQuantity });
      setNppLastSentOrderText(`${selectedProduct.name} ${nextQuantity}`);
      setNppParseStatus("success");
      setNppParseMessage("Em đã chuẩn bị bản xác nhận đơn. Quý Khách Hàng kiểm tra giúp em nhé.");
      setSelectedProduct(null);
      setDraftQuantity("");
      setQuantityModalError("");
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

  const shouldShowAgentLogin = () => !isCatalogUnlocked;

  if (shouldShowAgentLogin()) {
    return (
      <div
        className="min-h-[100dvh] bg-[#fff9f5] text-[#271f23]"
        data-dealer-agent-screen="login"
        data-hallmark-dna="dealer-conversational-catalogue"
        style={DEALER_HALLMARK_TOKENS}
      >
        <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(28px,env(safe-area-inset-top))] sm:justify-center sm:py-10">
          <div className="flex flex-1 flex-col justify-center py-8 sm:flex-none" data-hallmark-login="branded-rounded">
            <div className="text-center">
              <img src={bmqLogo} alt="BMQ" className="mx-auto h-16 w-auto object-contain" />
              <h1 className="mt-6 text-3xl font-extrabold tracking-tight">Đặt món cùng BMQ Agent</h1>
              <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#78636d]">
                Nhắn một câu, BMQ chuẩn bị đơn hàng cho Quý Khách Hàng ngay.
              </p>
            </div>

            <div className="mt-7 flex items-start gap-3 rounded-[24px] border border-[#f5d8e5] bg-white p-4 shadow-[0_16px_45px_rgba(217,79,138,0.09)]">
              <div className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f3c7d9] bg-[#fff4f8]">
                <img src={bmqLogo} alt="BMQ Agent" className="h-10 w-10 object-contain" />
              </div>
              <div className="rounded-2xl rounded-tl-md bg-[#fff2f7] px-4 py-3 text-sm font-medium leading-6 text-[#5b3a48]">
                Hôm nay mình dùng món gì ạ?
              </div>
            </div>

            <section className="mt-5 rounded-[28px] border border-[#f3dce6] bg-white p-5 shadow-[0_18px_55px_rgba(87,42,61,0.08)]">
              {authMessage ? (
                <div className="mb-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{authMessage}</span>
                </div>
              ) : null}
              {authError ? (
                <div className="mb-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              ) : null}

              {loginStep === "phone" ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="dealer-phone-agent" className="text-sm font-semibold">Số điện thoại</Label>
                    <div className="relative">
                      <Phone className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#aa8194]" />
                      <Input
                        id="dealer-phone-agent"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="Nhập số điện thoại của Quý Khách Hàng"
                        value={phone}
                        onChange={(event) => setPhone(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && phone.trim() && !authLoading) void handleStartAuth();
                        }}
                        className="h-[52px] rounded-2xl border-[#efd6e1] bg-[#fffafb] pl-11 text-xs sm:text-base focus-visible:ring-[#df6da0]"
                      />
                    </div>
                  </div>
                  <Button
                    className="h-12 w-full whitespace-nowrap rounded-2xl bg-[#d94f8a] text-base font-bold text-white shadow-lg shadow-[#d94f8a]/20 hover:bg-[#c83f7b]"
                    onClick={handleStartAuth}
                    disabled={authLoading || !phone.trim()}
                  >
                    {authLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                    Gửi mã OTP Zalo
                  </Button>
                </div>
              ) : null}

              {loginStep === "otp" ? (
                <div className="space-y-4">
                  <div>
                    <div className="font-bold">Nhập mã OTP</div>
                    <p className="mt-1 text-sm leading-6 text-[#78636d]">Mã gồm 6 số đã được gửi qua Zalo cho {phone.trim()}.</p>
                  </div>
                  <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                    <InputOTPGroup className="w-full justify-between gap-2">
                      {[0, 1, 2, 3, 4, 5].map((index) => (
                        <InputOTPSlot key={index} index={index} className="h-12 w-11 rounded-xl border-[#efd6e1]" />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                  <Button
                    className="h-12 w-full whitespace-nowrap rounded-2xl bg-[#d94f8a] text-base font-bold text-white hover:bg-[#c83f7b]"
                    onClick={handleVerifyAuth}
                    disabled={authLoading || otp.length !== 6}
                  >
                    {authLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    Xác thực OTP
                  </Button>
                  <Button variant="ghost" className="h-10 w-full whitespace-nowrap rounded-xl text-[#9a667d]" onClick={() => setLoginStep("phone")}>
                    Đổi số điện thoại
                  </Button>
                </div>
              ) : null}
            </section>

            <div className="mt-5 flex items-center justify-center gap-2 text-xs font-medium text-[#8d7180]">
              <ShieldCheck className="h-4 w-4 text-[#d94f8a]" />
              Thông tin của Quý Khách Hàng được BMQ bảo mật
            </div>
          </div>
          <footer data-dealer-login-footer className="pt-8 text-center text-[11px] font-medium text-[#9a7e8b]">
            <span className="block">© 2026 Bánh Mì Que Pháp</span>
            <span className="block">BMQ. All rights reserved. Powered by VNAgent.ai</span>
          </footer>
        </main>
      </div>
    );
  }

  if (isCatalogRestoring) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[#fff9f5]" aria-label="Đang tải dữ liệu đại lý">
        <div className="text-center">
          <Loader2 className="mx-auto h-7 w-7 animate-spin text-[#d94f8a]" />
          <p className="mt-3 text-sm font-medium text-[#78636d]">Đang mở BMQ Agent…</p>
        </div>
      </div>
    );
  }

  if (activeNav === "orders") {
    const historyOrders = orderHistoryData?.orders || [];
    const historySummary = orderHistoryData?.summary || {};
    const historyPagination = orderHistoryData?.pagination || {};
    const historyTotalPages = Math.max(1, historyPagination.total_pages || 1);
    const currentHistoryYear = Number(currentDealerHistoryAnchor("year"));
    const historyYearOptions = Array.from({ length: 6 }, (_, index) => String(currentHistoryYear - index));

    return (
      <div
        className="min-h-[100dvh] overflow-x-clip bg-[var(--dealer-paper)] text-[var(--dealer-ink)]"
        data-dealer-agent-screen="orders"
        data-dealer-order-history="mobile-first"
        data-hallmark-dna="dealer-conversational-catalogue"
        style={DEALER_HALLMARK_TOKENS}
      >
        <header className="sticky top-0 z-30 border-b border-[var(--dealer-rule)] bg-white/95 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <button
              type="button"
              aria-label="Quay lại danh sách tin nhắn"
              className="dealer-history-icon-button -ml-2"
              onClick={() => setActiveNav("messages")}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-extrabold tracking-tight sm:text-2xl">Đơn hàng của tôi</h1>
              <p className="truncate text-sm font-medium text-[var(--dealer-ink-muted)]">{dealerDisplayName}</p>
            </div>
            <button
              type="button"
              aria-label="Mở tài khoản"
              className="dealer-history-avatar"
              onClick={() => setDealerProfileOpen(true)}
            >
              {(dealerDisplayName.trim().charAt(0) || "B").toLocaleUpperCase("vi-VN")}
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-3xl px-4 pb-28 pt-5 sm:pt-7">
          <section className="space-y-4" data-dealer-order-history-filter>
            <div className="dealer-history-period-tabs" role="tablist" aria-label="Lọc lịch sử theo thời gian">
              {([
                ["day", "Ngày"],
                ["month", "Tháng"],
                ["year", "Năm"],
              ] as Array<[DealerOrderHistoryGranularity, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={orderHistoryGranularity === value}
                  className="dealer-history-period-tab"
                  data-active={orderHistoryGranularity === value ? "true" : "false"}
                  onClick={() => handleOrderHistoryGranularityChange(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            <label className="block">
              <span className="mb-2 block text-sm font-bold text-[var(--dealer-ink)]">
                {orderHistoryGranularity === "day" ? "Chọn ngày" : orderHistoryGranularity === "month" ? "Chọn tháng" : "Chọn năm"}
              </span>
              {orderHistoryGranularity === "year" ? (
                <select
                  value={orderHistoryAnchor}
                  className="dealer-history-period-input"
                  onChange={(event) => handleOrderHistoryAnchorChange(event.target.value)}
                >
                  {historyYearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
              ) : (
                <Input
                  type={orderHistoryGranularity === "day" ? "date" : "month"}
                  value={orderHistoryAnchor}
                  className="dealer-history-period-input"
                  onChange={(event) => handleOrderHistoryAnchorChange(event.target.value)}
                />
              )}
            </label>
          </section>

          <section className="dealer-history-summary mt-5" data-dealer-order-history-summary aria-label="Tổng hợp lịch sử đơn hàng">
            <div className="dealer-history-summary-item">
              <span>Số đơn</span>
              <strong>{formatDealerQuantity(Number(historySummary.order_count || 0))}</strong>
            </div>
            <div className="dealer-history-summary-item">
              <span>Tổng số bánh giao</span>
              <strong>{formatDealerQuantity(Number(historySummary.total_physical_quantity || 0))}</strong>
            </div>
            <div className="dealer-history-summary-item dealer-history-summary-amount">
              <span>Tổng tiền</span>
              <strong>{formatVnd(Number(historySummary.total_amount_vnd || 0))}</strong>
            </div>
          </section>

          {orderHistoryStatus === "loading" ? (
            <section className="mt-5 space-y-3" data-dealer-order-history-state="loading" aria-label="Đang tải lịch sử đơn hàng">
              {[0, 1, 2].map((item) => (
                <div key={item} className="dealer-history-skeleton" aria-hidden="true">
                  <div className="h-4 w-36 rounded-full bg-[#f2dce5]" />
                  <div className="mt-3 h-3 w-52 max-w-full rounded-full bg-[#f8eaf0]" />
                  <div className="mt-4 h-6 w-full rounded-lg bg-[#f8eaf0]" />
                </div>
              ))}
            </section>
          ) : null}

          {orderHistoryStatus === "error" ? (
            <section className="dealer-history-state mt-5" data-dealer-order-history-state="error" aria-live="polite">
              <AlertCircle className="h-6 w-6 text-red-600" />
              <div>
                <h2 className="font-extrabold">Chưa tải được lịch sử đơn hàng</h2>
                <p>{orderHistoryError || "Kết nối chưa ổn định. Vui lòng tải lại."}</p>
              </div>
              <Button type="button" variant="outline" className="dealer-history-state-action" onClick={() => void loadOrderHistory()}>
                Tải lại
              </Button>
            </section>
          ) : null}

          {orderHistoryStatus === "live" && historyOrders.length === 0 ? (
            <section className="dealer-history-state mt-5" data-dealer-order-history-state="empty">
              <ClipboardList className="h-7 w-7 text-[var(--dealer-accent)]" />
              <div>
                <h2 className="font-extrabold">Chưa có đơn trong kỳ này</h2>
                <p>Đổi khoảng thời gian hoặc bắt đầu một đơn mới cùng BMQ Agent.</p>
              </div>
              <Button type="button" className="dealer-history-state-action bg-[var(--dealer-accent)] text-white hover:bg-[var(--dealer-accent-strong)]" onClick={() => setActiveNav("order")}>
                Đặt đơn mới
              </Button>
            </section>
          ) : null}

          {orderHistoryStatus === "live" && historyOrders.length > 0 ? (
            <section className="mt-5" data-dealer-order-history-list aria-label="Danh sách đơn hàng">
              <div className="dealer-history-list">
                {historyOrders.map((order) => (
                  <button
                    key={order.id}
                    type="button"
                    className="dealer-history-row"
                    onClick={() => setSelectedHistoryOrder(order)}
                    aria-label={`Xem chi tiết đơn ${order.order_number}`}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="dealer-history-order-number">{order.order_number}</div>
                        <div className="mt-1 text-sm text-[var(--dealer-ink-muted)]">{formatDealerOrderTime(order.submitted_at)}</div>
                      </div>
                      <span className="dealer-history-status">Đã ghi nhận</span>
                    </div>
                    <div className="dealer-history-row-values">
                      <div>
                        <span>Ngày giao</span>
                        <strong>{formatDealerDeliveryDate(order.requested_delivery_date)}</strong>
                      </div>
                      <div>
                        <span>Số bánh giao</span>
                        <strong>{formatDealerQuantity(order.physical_quantity)}</strong>
                      </div>
                      <div>
                        <span>Tổng tiền</span>
                        <strong>{formatVnd(order.total_amount_vnd)}</strong>
                      </div>
                      <ChevronRight className="h-5 w-5 shrink-0 text-[var(--dealer-accent)]" aria-hidden="true" />
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {orderHistoryStatus === "live" && historyOrders.length > 0 ? (
            <nav className="dealer-history-pagination mt-5" data-dealer-order-history-pagination aria-label="Phân trang lịch sử đơn hàng">
              <button
                type="button"
                className="dealer-history-page-button"
                disabled={orderHistoryPage <= 1}
                onClick={() => {
                  setDeepLinkedOrderActive(false);
                  setOrderHistoryPage((page) => Math.max(1, page - 1));
                }}
              >
                <ChevronLeft className="h-4 w-4" />
                Trước
              </button>
              <span className="whitespace-nowrap text-sm font-bold text-[var(--dealer-ink-muted)]">Trang {orderHistoryPage}/{historyTotalPages}</span>
              <button
                type="button"
                className="dealer-history-page-button"
                disabled={orderHistoryPage >= historyTotalPages}
                onClick={() => {
                  setDeepLinkedOrderActive(false);
                  setOrderHistoryPage((page) => Math.min(historyTotalPages, page + 1));
                }}
              >
                Sau
                <ChevronRight className="h-4 w-4" />
              </button>
            </nav>
          ) : null}
        </main>

        <nav className="dealer-history-bottom-nav" data-dealer-agent-nav="messages-orders-account">
          <div className="mx-auto grid h-16 max-w-3xl grid-cols-3">
            <button type="button" onClick={() => setActiveNav("messages")}>
              <MessageCircle className="h-5 w-5" />
              <span>Tin nhắn</span>
            </button>
            <button type="button" className="is-active" aria-current="page">
              <ClipboardList className="h-5 w-5" />
              <span>Đơn hàng</span>
            </button>
            <button type="button" onClick={() => setDealerProfileOpen(true)}>
              <UserRound className="h-5 w-5" />
              <span>Tài khoản</span>
            </button>
          </div>
        </nav>

        <Dialog open={Boolean(selectedHistoryOrder)} onOpenChange={(open) => !open && setSelectedHistoryOrder(null)}>
          <DialogContent
            data-dealer-order-history-detail
            className="dealer-history-detail max-w-xl p-0"
            style={DEALER_HALLMARK_TOKENS}
          >
            {selectedHistoryOrder ? (
              <>
                <div className="border-b border-[var(--dealer-rule)] px-5 pb-4 pt-5 sm:px-6">
                  <DialogHeader>
                    <DialogTitle className="pr-8 text-xl font-extrabold">{selectedHistoryOrder.order_number}</DialogTitle>
                    <DialogDescription className="text-[var(--dealer-ink-muted)]">
                      Đặt lúc {formatDealerOrderTime(selectedHistoryOrder.submitted_at)} · giao {formatDealerDeliveryDate(selectedHistoryOrder.requested_delivery_date)}
                    </DialogDescription>
                  </DialogHeader>
                </div>
                <div className="max-h-[calc(100dvh-12rem)] space-y-4 overflow-y-auto px-5 py-4 sm:max-h-[65dvh] sm:px-6">
                  {selectedHistoryOrder.items.map((item) => (
                    <article key={item.id} className="dealer-history-detail-item">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="font-extrabold leading-5">{item.product_name}</h3>
                          <p className="mt-1 text-sm text-[var(--dealer-ink-muted)]">{item.route_customer_name || dealerDisplayName}</p>
                        </div>
                        <strong className="shrink-0 text-sm text-[var(--dealer-accent-strong)]">{formatVnd(item.line_total_vnd)}</strong>
                      </div>
                      <div className="dealer-history-quantity-grid">
                        {([
                          ["Đặt", item.ordered_quantity],
                          ["Đổi", item.exchange_quantity],
                          ["Bù", item.makeup_quantity],
                          ["Giao", item.physical_quantity],
                        ] as Array<[string, number]>).map(([label, value]) => (
                          <div key={label}>
                            <span>{label}</span>
                            <strong>{formatDealerQuantity(value)}</strong>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3 text-sm text-[var(--dealer-ink-muted)]">
                        <span>{formatVnd(item.unit_price_vnd)} / {item.unit}</span>
                        {item.route_note ? <span className="min-w-0 truncate text-right">{item.route_note}</span> : null}
                      </div>
                    </article>
                  ))}
                  {selectedHistoryOrder.customer_note || selectedHistoryOrder.delivery_note ? (
                    <div className="dealer-history-note">
                      <span className="font-extrabold">Ghi chú</span>
                      <span>{selectedHistoryOrder.customer_note || selectedHistoryOrder.delivery_note}</span>
                    </div>
                  ) : null}
                </div>
                <div className="dealer-history-detail-total">
                  <span>{formatDealerQuantity(selectedHistoryOrder.physical_quantity)} bánh giao</span>
                  <strong>{formatVnd(selectedHistoryOrder.total_amount_vnd)}</strong>
                </div>
              </>
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog open={dealerProfileOpen} onOpenChange={setDealerProfileOpen}>
          <DialogContent className="max-w-sm rounded-[28px] border-[#f0d5e1] bg-[#fff9fb] text-[#35252c]">
            <DialogHeader>
              <DialogTitle>Tài khoản đặt hàng</DialogTitle>
              <DialogDescription>{dealerDisplayName}</DialogDescription>
            </DialogHeader>
            <Button variant="outline" className="h-11 rounded-2xl border-[#efd3df] bg-white text-[#b33f72]" onClick={handleLogoutDealer}>
              <LogOut className="h-4 w-4" />
              Đăng xuất
            </Button>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  if (activeNav === "messages") {
    return (
      <div
        className="min-h-[100dvh] bg-[var(--dealer-surface)] text-[var(--dealer-ink)]"
        data-dealer-agent-screen="inbox"
        data-hallmark-dna="dealer-conversational-catalogue"
        style={DEALER_HALLMARK_TOKENS}
      >
        <header className="sticky top-0 z-30 bg-[#df78a7] px-4 pb-4 pt-[max(14px,env(safe-area-inset-top))] text-white shadow-sm">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
            <h1 className="text-[28px] font-extrabold tracking-tight">Tin nhắn</h1>
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Tìm kiếm" className="flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-white/15">
                <Search className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label="Mở tài khoản"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/60 bg-[#fce5ef] text-sm font-extrabold text-[#b33f72]"
                onClick={() => setDealerProfileOpen(true)}
              >
                {(dealerDisplayName.trim().charAt(0) || "M").toLocaleUpperCase("vi-VN")}
              </button>
            </div>
          </div>
          <div className="mx-auto mt-3 max-w-2xl">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9d7184]" />
              <Input
                readOnly
                aria-label="Tìm kiếm BMQ Agent"
                placeholder="Tìm kiếm BMQ Agent"
                className="h-11 rounded-full border-0 bg-white pl-11 text-[#362831] shadow-none placeholder:text-[#9d7184] focus-visible:ring-2 focus-visible:ring-white/60"
              />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-2xl pb-24">
          <button
            type="button"
            data-dealer-agent-row="order"
            className="flex w-full items-center gap-3 border-b border-[#f1e8ec] px-4 py-4 text-left transition hover:bg-[#fff7fa] active:bg-[#fcecf3]"
            onClick={() => setActiveNav("order")}
          >
            <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f0ccdc] bg-[#fff4f8]">
              <img src={bmqLogo} alt="BMQ Agent" className="h-12 w-12 object-contain" />

            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="truncate text-base font-extrabold">BMQ Agent</div>
                <span className="rounded-full bg-[#fce7f0] px-2 py-0.5 text-[11px] font-bold text-[#bd4a7c]">Đặt bánh</span>
              </div>
              <p className="mt-1 truncate text-sm text-[#776b71]">Chào {dealerDisplayName}. Hôm nay mình đặt món gì ạ?</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <span className="text-xs text-[#9a8e94]">Bây giờ</span>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#d94f8a] px-1.5 text-[11px] font-bold text-white">1</span>
            </div>
          </button>

          <div className="bg-[#faf7f8] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#96858d]">Hỗ trợ khác</div>
          <button type="button" className="flex w-full items-center gap-3 border-b border-[#f1e8ec] px-4 py-4 text-left hover:bg-[#fff7fa]" onClick={() => setActiveNav("support")}>
            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f0ccdc] bg-[#fff4f8]">
              <img src={bmqLogo} alt="BMQ Chăm sóc khách hàng" className="h-10 w-10 object-contain" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold">BMQ Chăm sóc khách hàng</div>
              <div className="mt-1 truncate text-sm text-[#776b71]">Hỗ trợ thay đổi hoặc phản hồi đơn hàng</div>
            </div>
            <span className="text-xs text-[#9a8e94]">T6</span>
          </button>
        </main>

        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-[#eee4e8] bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-5px_20px_rgba(71,39,53,0.05)] backdrop-blur" data-dealer-agent-nav="messages-orders-account">
          <div className="mx-auto grid h-16 max-w-2xl grid-cols-3">
            <button type="button" className="flex flex-col items-center justify-center gap-1 text-[#d94f8a]">
              <MessageCircle className="h-5 w-5" />
              <span className="text-[11px] font-bold">Tin nhắn</span>
            </button>
            <button type="button" className="flex flex-col items-center justify-center gap-1 text-[#88777f]" onClick={() => setActiveNav("orders")}>
              <ClipboardList className="h-5 w-5" />
              <span className="whitespace-nowrap text-[11px] font-medium">Đơn hàng</span>
            </button>
            <button type="button" className="flex flex-col items-center justify-center gap-1 text-[#88777f]" onClick={() => setDealerProfileOpen(true)}>
              <UserRound className="h-5 w-5" />
              <span className="text-[11px] font-medium">Tài khoản</span>
            </button>
          </div>
        </nav>

        <Dialog open={dealerProfileOpen} onOpenChange={setDealerProfileOpen}>
          <DialogContent className="max-w-sm rounded-[28px] border-[#f0d5e1] bg-[#fff9fb] text-[#35252c]">
            <DialogHeader>
              <DialogTitle>Tài khoản đặt hàng</DialogTitle>
              <DialogDescription>{dealerDisplayName}</DialogDescription>
            </DialogHeader>
            <Button variant="outline" className="h-11 rounded-2xl border-[#efd3df] bg-white text-[#b33f72]" onClick={handleLogoutDealer}>
              <LogOut className="h-4 w-4" />
              Đăng xuất
            </Button>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  if (activeNav === "order") {
    return (
      <div
        className="min-h-[100dvh] bg-[var(--dealer-paper)] text-[var(--dealer-ink)]"
        data-dealer-agent-screen="chat"
        data-hallmark-dna="dealer-conversational-catalogue"
        data-hallmark-chat="bottom-clustered"
        style={DEALER_HALLMARK_TOKENS}
      >
        <header className="sticky top-0 z-40 border-b border-[#f2dce5] bg-white/95 px-3 pb-3 pt-[max(10px,env(safe-area-inset-top))] backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <button type="button" aria-label="Quay lại danh sách tin nhắn" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#5a4650] hover:bg-[#fff0f6]" onClick={() => setActiveNav("messages")}>
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f0cada] bg-[#fff5f9]">
              <img src={bmqLogo} alt="BMQ Agent" className="h-9 w-9 object-contain" />

            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-extrabold">BMQ Agent</div>
              <div className="text-xs font-medium text-[#927681]">Trợ lý đặt hàng</div>
            </div>
            <button type="button" aria-label="Tài khoản" className="flex h-9 w-9 items-center justify-center rounded-full text-[#7f6672] hover:bg-[#fff0f6]" onClick={() => setDealerProfileOpen(true)}>
              <UserRound className="h-5 w-5" />
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-2xl px-3 py-4 sm:px-4">
          <NppQuickOrderPanel
            routes={chatOrderRoutes}
            isRetailDealer={directDealerOrder}
            product={chatProduct}
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
            sentOrderText={nppLastSentOrderText}
            successMessage={orderMessage}
            errorMessage={orderError}
            duplicateOrderPrompt={duplicateOrderPrompt}
            quickOrderSuggestion={quickOrderSuggestion}
            quickOrderSuggestionStatus={quickOrderSuggestionStatus}
            quickOrderProduct={quickOrderProduct}
            onDuplicateContinue={handleDuplicateOrderContinue}
            onDuplicateCancel={handleDuplicateOrderCancel}
            onQuickReorderSubmit={handleQuickReorderSubmit}
            onQuickReorderEdit={handleQuickReorderEdit}
            onViewExistingQuickOrder={handleViewExistingQuickOrder}
            onProductSuggestion={handleProductCta}
            parseMessage={nppParseMessage}
            parseStatus={nppParseStatus}
            onParse={handleParseNppOrderText}
            detailOpen={nppConfirmOpen}
            setDetailOpen={setNppConfirmOpen}
            totalItems={chatTotalItems}
            cartTotal={chatCartTotal}
            canSubmit={Boolean(sessionToken) && catalogStatus === "live" && nppSelectedLines.length > 0}
            submitting={orderSubmitting}
            onSubmit={handleSubmitNppOrder}
            onStartNewOrder={handleStartNewNppOrder}
          />
          <ProductDetailDialog
            product={selectedProduct}
            draftQuantity={draftQuantity}
            quantityError={quantityModalError}
            onDraftQuantityChange={(value) => {
              setDraftQuantity(value);
              setQuantityModalError("");
            }}
            onClose={() => {
              setSelectedProduct(null);
              setDraftQuantity("");
              setQuantityModalError("");
            }}
            onSubmit={handleProductQuantitySubmit}
          />
        </main>
        <Dialog open={dealerProfileOpen} onOpenChange={setDealerProfileOpen}>
          <DialogContent className="max-w-sm rounded-[28px] border-[#f0d5e1] bg-[#fff9fb]">
            <DialogHeader><DialogTitle>{dealerDisplayName}</DialogTitle></DialogHeader>
            <Button variant="outline" className="h-11 rounded-2xl" onClick={handleLogoutDealer}><LogOut className="h-4 w-4" />Đăng xuất</Button>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur" data-dealer-secondary-header="true">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              data-dealer-agent-back="secondary-screen"
              aria-label="Quay lại danh sách tin nhắn"
              className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#5a4650] transition hover:bg-[#fff0f6] active:bg-[#fce2ed]"
              onClick={() => setActiveNav("messages")}
            >
              <ArrowLeft className="h-6 w-6" />
            </button>
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
                routes={chatOrderRoutes}
                isRetailDealer={directDealerOrder}
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
                sentOrderText={nppLastSentOrderText}
                successMessage={orderMessage}
                errorMessage={orderError}
                duplicateOrderPrompt={duplicateOrderPrompt}
                quickOrderSuggestion={null}
                quickOrderSuggestionStatus="idle"
                quickOrderProduct={null}
                onDuplicateContinue={handleDuplicateOrderContinue}
                onDuplicateCancel={handleDuplicateOrderCancel}
                onQuickReorderSubmit={handleQuickReorderSubmit}
                onQuickReorderEdit={handleQuickReorderEdit}
                onViewExistingQuickOrder={handleViewExistingQuickOrder}
                onProductSuggestion={handleProductCta}
                parseMessage={nppParseMessage}
                parseStatus={nppParseStatus}
                onParse={handleParseNppOrderText}
                detailOpen={nppConfirmOpen}
                setDetailOpen={setNppConfirmOpen}
                totalItems={chatTotalItems}
                cartTotal={chatCartTotal}
                canSubmit={Boolean(sessionToken) && catalogStatus === "live" && nppSelectedLines.length > 0}
                submitting={orderSubmitting}
                onSubmit={handleSubmitNppOrder}
                onStartNewOrder={handleStartNewNppOrder}
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
        <span className="block">© 2026 Bánh Mì Que Pháp</span>
        <span className="block">BMQ. All rights reserved. Powered by VNAgent.ai</span>
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
                    {isNppMode ? ". Quý Khách Hàng nhập số lượng theo từng điểm bán trong ô chat sau khi xem thông tin sản phẩm." : `. Đặt theo bội số ${DEALER_ORDER_STEP} ${selectedProduct.unit || "đơn vị"}.`}
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
                      placeholder="Nhập số lượng"
                      onChange={(event) => {
                        setDraftQuantity(event.target.value.replace(/[^0-9]/g, ""));
                        setQuantityModalError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleProductQuantitySubmit();
                      }}
                      className="h-12 rounded-2xl border-amber-200 bg-white text-center text-lg font-extrabold text-[#3f2411] placeholder:font-normal placeholder:text-[#b99aa8] focus-visible:ring-amber-400"
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


function ProductDetailDialog({
  product,
  draftQuantity,
  quantityError,
  onDraftQuantityChange,
  onClose,
  onSubmit,
}: {
  product: Product | null;
  draftQuantity: string;
  quantityError: string;
  onDraftQuantityChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={Boolean(product)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-dealer-product-detail="label-specs" className="top-3 max-h-[calc(100dvh-1.5rem)] max-w-sm translate-y-0 overflow-y-auto rounded-3xl border-[#f0d5e1] bg-[#fff9fb] p-0 pb-[env(safe-area-inset-bottom)] text-[#3f2411] shadow-2xl sm:top-[50%] sm:translate-y-[-50%]">
        {product ? (
          <>
            <div className="h-36 bg-[#fff0f6] sm:h-48">
              {product.imageUrl ? (
                <img src={product.imageUrl} alt={product.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#fff0f6] text-[#b33f72]">
                  <ImageIcon className="h-8 w-8" />
                  <span className="text-sm font-medium">Ảnh sản phẩm</span>
                </div>
              )}
            </div>
            <div className="space-y-4 p-5">
              <DialogHeader>
                <DialogTitle className="text-xl font-display font-extrabold leading-tight">{product.name}</DialogTitle>
                <DialogDescription className="text-sm leading-6 text-[#765333]">
                  {formatVnd(product.price)} / {product.unit}. Đặt theo bội số {DEALER_ORDER_STEP} {product.unit || "đơn vị"}.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-3 gap-2" data-dealer-product-specs="weight-shelf-life">
                {[
                  ["Giá bán", formatVnd(product.price)],
                  ["Trọng lượng", formatProductWeight(product)],
                  ["HSD", formatProductShelfLife(product)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-2xl border border-[#f0d5e1] bg-white px-2 py-3 text-center">
                    <div className="text-[10px] font-bold uppercase tracking-wide text-[#927681]">{label}</div>
                    <div className="mt-1 truncate text-sm font-extrabold text-[#4a343e]">{value}</div>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <Label htmlFor="dealer-product-quantity">Số lượng đặt</Label>
                <Input
                  id="dealer-product-quantity"
                  type="number"
                  inputMode="numeric"
                  min={DEALER_ORDER_STEP}
                  step={DEALER_ORDER_STEP}
                  value={draftQuantity}
                  placeholder="Nhập số lượng"
                  onChange={(event) => onDraftQuantityChange(event.target.value.replace(/[^0-9]/g, ""))}
                  onKeyDown={(event) => { if (event.key === "Enter") onSubmit(); }}
                  className="h-12 rounded-2xl border-[#e7b9cd] bg-white text-center text-lg font-extrabold text-[#4a343e] placeholder:font-normal placeholder:text-[#b99aa8] focus-visible:ring-[#d94f8a]"
                />
                {quantityError ? <div className="text-sm font-medium text-destructive">{quantityError}</div> : null}
              </div>
              <DialogFooter className="grid grid-cols-2 gap-2 sm:grid-cols-2 sm:gap-2">
                <Button variant="outline" className="h-11 rounded-2xl border-[#e7b9cd] bg-white text-[#704f5e]" onClick={onClose}>Đóng</Button>
                <Button className="h-11 rounded-2xl bg-[#d94f8a] font-bold text-white hover:bg-[#c43f79]" onClick={onSubmit}>Đặt sản phẩm này</Button>
              </DialogFooter>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}


function NppQuickOrderPanel({
  routes,
  isRetailDealer,
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
  sentOrderText,
  successMessage,
  errorMessage,
  duplicateOrderPrompt,
  quickOrderSuggestion,
  quickOrderSuggestionStatus,
  quickOrderProduct,
  onDuplicateContinue,
  onDuplicateCancel,
  onQuickReorderSubmit,
  onQuickReorderEdit,
  onViewExistingQuickOrder,
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
  onStartNewOrder,
}: {
  routes: DealerRoute[];
  isRetailDealer: boolean;
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
  sentOrderText: string;
  successMessage: string;
  errorMessage: string;
  duplicateOrderPrompt: DuplicateOrderPrompt | null;
  quickOrderSuggestion: DealerQuickOrderSuggestionResponse | null;
  quickOrderSuggestionStatus: "idle" | "loading" | "live";
  quickOrderProduct: Product | null;
  onDuplicateContinue: () => void;
  onDuplicateCancel: () => void;
  onQuickReorderSubmit: () => void;
  onQuickReorderEdit: () => void;
  onViewExistingQuickOrder: () => void;
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
  onStartNewOrder: () => void;
}) {
  const unitLabel = product?.unit || "que";
  const selectedRoutes = routes.filter((route) => {
    const ordered = quantities[route.id] || 0;
    const exchange = exchangeQuantities[route.id] || 0;
    const makeup = makeupQuantities[route.id] || 0;
    return ordered + exchange + makeup > 0;
  });
  const selectedRouteCount = selectedRoutes.length;
  const [isEditingOrder, setIsEditingOrder] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!sentOrderText && !successMessage && !errorMessage && !duplicateOrderPrompt) return;
    const frame = window.requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [duplicateOrderPrompt, errorMessage, parseStatus, selectedRouteCount, sentOrderText, successMessage]);

  const openOrderConfirmation = () => {
    setIsEditingOrder(false);
    setDetailOpen(true);
  };

  const focusComposer = () => {
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const showOrderExample = () => {
    setOrderText(isRetailDealer ? "200 đổi 14 bù 5" : "Rạch Giá 200 đổi 10\nĐVC 100 bù 3");
    focusComposer();
  };

  const handleDetailOpenChange = (open: boolean) => {
    setDetailOpen(open);
    if (!open) setIsEditingOrder(false);
  };
  const quickOrderItem = quickOrderSuggestion?.suggestion?.items[0] || null;
  const showQuickOrder = isRetailDealer
    && !sentOrderText
    && !successMessage
    && !errorMessage
    && !duplicateOrderPrompt
    && parseStatus === "idle"
    && selectedRouteCount === 0;

  if (!product) {
    return (
      <div className="rounded-3xl border border-dashed border-amber-200 bg-white p-5 text-sm text-[#765333]">
        {isRetailDealer
          ? "Chưa có sản phẩm bánh mì que đang mở bán cho đại lý này. Vui lòng liên hệ BMQ để kiểm tra giá."
          : "Chưa có sản phẩm bánh mì que đang mở bán cho account NPP này. Vui lòng liên hệ BMQ để kiểm tra giá."}
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-88px)] min-w-0 w-full max-w-full flex-col pb-[max(12px,env(safe-area-inset-bottom))]" data-stitch-dealer-chat-agent="conversation-v1" data-stitch-dealer-chat-overflow="contained-v1">
      <div className="py-2 text-center text-[11px] font-medium text-[#a18d96]">Hôm nay</div>

      {!sentOrderText && !successMessage && !errorMessage && parseStatus === "idle" && !parseMessage ? (
        <div className="flex min-w-0 items-start gap-2 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f0ccdc] bg-white shadow-sm">
            <img src={bmqLogo} alt="BMQ Agent" className="h-8 w-8 object-contain" />
          </div>
          <div className="min-w-0 flex-1 whitespace-normal break-words max-w-[85%] rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm leading-6 text-[#543943] shadow-sm ring-1 ring-[#f4e5eb]">
            {isRetailDealer
              ? "Đại lý đã được xác nhận. Quý Khách Hàng chỉ cần nhắn số lượng, đổi hoặc bù; không cần nhập lại tên đại lý."
              : "Hôm nay mình đặt món gì ạ? Quý Khách Hàng nhắn nội dung đơn, em sẽ tách từng điểm giao để kiểm tra trước khi gửi."}
          </div>
        </div>
      ) : null}

      {showQuickOrder && quickOrderSuggestionStatus === "loading" ? (
        <div className="ml-11 max-w-sm rounded-[22px] border border-[#f0d5e1] bg-white p-4 shadow-sm" data-dealer-quick-reorder="loading" aria-live="polite">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#806873]"><Loader2 className="h-4 w-4 animate-spin text-[#d94f8a]" />Đang xem đơn gần nhất...</div>
        </div>
      ) : null}

      {showQuickOrder && quickOrderSuggestion?.already_ordered ? (
        <div className="ml-11 max-w-sm rounded-[22px] border border-[#e8cad7] bg-white p-4 shadow-sm" data-dealer-quick-reorder="already-ordered">
          <div className="text-sm font-extrabold text-[#4a343e]">Đã có đơn giao ngày {formatDealerDeliveryDate(quickOrderSuggestion.target_delivery_date)}</div>
          <div className="mt-1 text-xs font-medium text-[#806873]">Mã đơn {quickOrderSuggestion.already_ordered.order_number}</div>
          <Button type="button" variant="outline" className="mt-3 h-10 w-full rounded-xl border-[#e7b9cd] bg-white font-bold text-[#a73f70] hover:bg-[#fff0f6]" onClick={onViewExistingQuickOrder}>
            Xem đơn
          </Button>
        </div>
      ) : null}

      {showQuickOrder && quickOrderSuggestion?.suggestion && quickOrderItem && quickOrderProduct ? (
        <div className="ml-11 max-w-sm rounded-[22px] border border-[#ebc7d7] bg-white p-4 shadow-[0_8px_20px_rgba(105,49,73,0.08)]" data-dealer-quick-reorder="suggestion">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#a73f70]">Đặt lại như đơn ngày {formatDealerDeliveryDate(quickOrderSuggestion.suggestion.source_delivery_date)}</div>
          <div className="mt-3 flex min-w-0 items-center gap-3 border-y border-[#f2dfe7] py-3">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-[#f1dbe4] bg-[#fff3f8]">
              {quickOrderProduct.imageUrl ? <img src={quickOrderProduct.imageUrl} alt={quickOrderProduct.name} className="h-full w-full object-cover" /> : <img src={bmqLogo} alt="BMQ" className="h-full w-full object-contain p-2" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-extrabold text-[#4a343e]">{quickOrderProduct.name}</div>
              <div className="mt-1 text-lg font-extrabold text-[#b33f72]">{formatDealerQuantity(quickOrderItem.ordered_quantity)} {quickOrderProduct.unit}</div>
              <div className="text-xs font-semibold text-[#806873]">Giao {formatDealerDeliveryDate(quickOrderSuggestion.target_delivery_date)} · {formatVnd(quickOrderProduct.price)} / {quickOrderProduct.unit}</div>
            </div>
          </div>
          <div className="mt-3 flex items-baseline justify-between gap-3">
            <span className="text-xs font-bold text-[#927681]">Tổng tiền theo giá hiện tại</span>
            <span className="whitespace-nowrap text-lg font-extrabold text-[#b33f72]">{formatVnd(quickOrderProduct.price * quickOrderItem.ordered_quantity)}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button type="button" className="h-11 rounded-xl bg-[#d94f8a] font-extrabold text-white hover:bg-[#c43f79]" data-dealer-quick-reorder-action="submit" disabled={submitting} onClick={onQuickReorderSubmit}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Đặt nhanh
            </Button>
            <Button type="button" variant="outline" className="h-11 rounded-xl border-[#e7b9cd] bg-white font-extrabold text-[#a73f70] hover:bg-[#fff0f6]" data-dealer-quick-reorder-action="edit" disabled={submitting} onClick={onQuickReorderEdit}>
              Đổi số lượng
            </Button>
          </div>
        </div>
      ) : null}

      {sentOrderText ? (
        <div className="flex justify-end py-2" data-dealer-chat-message="customer">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-[#d94f8a] px-4 py-3 text-sm leading-6 text-white shadow-sm">
            {sentOrderText}
          </div>
        </div>
      ) : null}

      {parseStatus === "processing" ? (
        <div className="flex min-w-0 items-start gap-2 py-2" data-dealer-chat-status="processing" aria-live="polite">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f0ccdc] bg-white shadow-sm">
            <img src={bmqLogo} alt="BMQ Agent" className="h-8 w-8 object-contain" />
          </div>
          <div className="flex items-center gap-2 rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm font-semibold text-[#704f5e] shadow-sm ring-1 ring-[#f4e5eb]">
            <span>BMQ Agent đang xử lý</span>
            <span className="flex items-center gap-1" aria-hidden="true">
              {[0, 1, 2].map((dot) => <span key={dot} className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#d94f8a]" style={{ animationDelay: `${dot * 140}ms` }} />)}
            </span>
          </div>
        </div>
      ) : null}

      {parseMessage && parseStatus !== "processing" && !duplicateOrderPrompt ? (
        <div className="flex min-w-0 items-start gap-2 py-2" data-dealer-chat-message="agent">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f0ccdc] bg-white shadow-sm">
            <img src={bmqLogo} alt="BMQ Agent" className="h-8 w-8 object-contain" />
          </div>
          <div className="min-w-0 max-w-[85%] whitespace-normal break-words rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm font-medium leading-6 text-[#543943] shadow-sm ring-1 ring-[#f4e5eb]">
            {parseMessage}
          </div>
        </div>
      ) : null}

      {duplicateOrderPrompt ? (
        <div className="ml-11 max-w-sm rounded-2xl border border-[#e7b9cd] bg-[#fff7fb] p-3 shadow-sm" data-dealer-chat-choices="duplicate-order" role="group" aria-label="Xử lý đơn hàng tương tự">
          <div className="text-sm font-extrabold leading-6 text-[#543943]">Đơn hàng tương tự đã được đặt! Quý khách hàng muốn tiếp tục hay huỷ?</div>
          <div className="mt-1 text-xs font-semibold text-[#8a6f7a]">Mã đơn trước: {duplicateOrderPrompt.orderNumber}</div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button type="button" className="h-11 rounded-xl bg-[#d94f8a] font-extrabold text-white hover:bg-[#c43f79]" data-dealer-chat-choice="duplicate-continue" disabled={submitting} onClick={onDuplicateContinue}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />} Tiếp tục
            </Button>
            <Button type="button" variant="outline" className="h-11 rounded-xl border-[#d7bdc8] bg-white font-extrabold text-[#704f5e] hover:bg-[#fff0f6]" data-dealer-chat-choice="duplicate-cancel" disabled={submitting} onClick={onDuplicateCancel}>
              Huỷ
            </Button>
          </div>
        </div>
      ) : null}

      {parseMessage && parseStatus === "idle" && selectedRouteCount === 0 ? (
        <div className="ml-11 grid max-w-sm grid-cols-2 gap-2 pb-2" data-dealer-chat-choices="parse-recovery" role="group" aria-label="Chọn cách tiếp tục">
          <Button type="button" variant="outline" className="h-10 rounded-full border-[#e7b9cd] bg-white text-sm font-bold text-[#a73f70] hover:bg-[#fff0f6]" onClick={focusComposer}>
            Nhập lại đơn
          </Button>
          <Button type="button" variant="outline" className="h-10 rounded-full border-[#e7b9cd] bg-white text-sm font-bold text-[#a73f70] hover:bg-[#fff0f6]" onClick={showOrderExample}>
            Xem mẫu
          </Button>
        </div>
      ) : null}

      {parseStatus === "success" && selectedRouteCount > 0 && !duplicateOrderPrompt ? (
        <div className="py-2">
          <div className="flex min-w-0 items-start gap-2">
            <div className="w-9 shrink-0" aria-hidden="true" />
            <div
              className="min-w-0 flex-1 max-w-sm rounded-[22px] border border-[#ebc7d7] bg-white p-3 shadow-[0_8px_20px_rgba(105,49,73,0.08)]"
              data-hallmark-preview="single-layer"
            >
              <button
                type="button"
                className="block w-full rounded-2xl text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d94f8a]"
                data-dealer-order-preview-card="chat-attachment"
                aria-label="Xem chi tiết xác nhận đơn hàng"
                onClick={openOrderConfirmation}
              >
                <div className="flex items-center gap-2 text-[#a73f70]">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[#fff0f6]">
                    <ClipboardList className="h-4 w-4" />
                  </div>
                  <div className="text-[11px] font-extrabold uppercase tracking-[0.12em]">Xác nhận đơn hàng</div>
                </div>
                <div className="mt-3 flex items-center gap-3 border-y border-[#f2dfe7] py-3" data-dealer-order-preview-product="compact">
                  <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-[#f1dbe4] bg-white" data-dealer-order-preview-product-image>
                    {product.imageUrl ? (
                      <img src={product.imageUrl} alt={product.name} loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-[#fff3f8]">
                        <img src={bmqLogo} alt="BMQ" className="h-9 w-9 object-contain" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-extrabold text-[#4a343e]">{product.name}</div>
                    <div className="mt-1 truncate text-sm font-bold text-[#c34f82]">{formatVnd(product.price)} / {unitLabel}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[#bd8ca1]" />
                </div>
                <div className="mt-1 divide-y divide-[#f2dfe7]" data-dealer-order-preview-totals="divider-rows">
                  <div className="flex items-baseline justify-between gap-3 py-3" data-dealer-order-preview-total="quantity">
                    <div className="text-xs font-bold text-[#927681]">Tổng số lượng</div>
                    <div className="whitespace-nowrap text-2xl font-extrabold tracking-tight text-[#4a343e]">{totalItems} {unitLabel}</div>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 py-3" data-dealer-order-preview-total="amount">
                    <div className="text-xs font-bold text-[#927681]">Tổng tiền</div>
                    <div className="whitespace-nowrap text-xl font-extrabold tabular-nums tracking-tight text-[#b33f72] sm:text-2xl">{formatVnd(cartTotal)}</div>
                  </div>
                </div>
              </button>
              <div className="mt-1 space-y-1 border-t border-[#f2dfe7] pt-3" data-dealer-chat-choices="order-ready" role="group" aria-label="Chọn thao tác với đơn hàng">
                <Button type="button" className="h-11 w-full whitespace-nowrap rounded-xl bg-[#d94f8a] font-extrabold text-white shadow-sm hover:bg-[#c43f79]" data-dealer-chat-choice="quick-submit" disabled={!canSubmit || submitting} onClick={onSubmit}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Đặt nhanh
                </Button>
                <div className="flex items-center justify-between gap-2">
                  <Button type="button" variant="ghost" className="h-10 min-w-0 whitespace-nowrap rounded-xl px-3 font-bold text-[#a73f70] hover:bg-[#fff0f6]" data-dealer-chat-choice="edit" onClick={openOrderConfirmation}>
                    Xem / chỉnh sửa
                  </Button>
                  <Button type="button" variant="ghost" className="h-10 min-w-0 whitespace-nowrap rounded-xl px-3 font-bold text-[#704f5e] hover:bg-[#fff0f6]" data-dealer-chat-choice="new-order" onClick={onStartNewOrder}>
                    Đặt đơn khác
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {successMessage ? (
        <div className="space-y-2 py-2">
          <div className="flex min-w-0 items-start gap-2" data-dealer-chat-message="success" aria-live="polite">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f0ccdc] bg-white shadow-sm">
              <img src={bmqLogo} alt="BMQ Agent" className="h-8 w-8 object-contain" />
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800 shadow-sm">
              <div className="flex items-center gap-2 font-extrabold"><CheckCircle2 className="h-4 w-4" />Đã nhận đơn thành công</div>
              <div className="mt-1">{successMessage}</div>
            </div>
          </div>
          <div className="ml-11" data-dealer-chat-choices="order-complete">
            <Button type="button" variant="outline" className="h-10 rounded-full border-[#e7b9cd] bg-white font-bold text-[#a73f70] hover:bg-[#fff0f6]" onClick={onStartNewOrder}>
              Đặt đơn khác
            </Button>
          </div>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="flex min-w-0 items-start gap-2 py-2" data-dealer-chat-message="error" aria-live="polite">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f0ccdc] bg-white shadow-sm">
            <img src={bmqLogo} alt="BMQ Agent" className="h-8 w-8 object-contain" />
          </div>
          <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700 shadow-sm">
            <div className="flex items-center gap-2 font-bold"><AlertCircle className="h-4 w-4" />Chưa gửi được đơn</div>
            <div className="mt-1">{errorMessage}</div>
          </div>
        </div>
      ) : null}

      {productSuggestions.length > 0 && !sentOrderText && parseStatus === "idle" && !successMessage ? (
        <div data-hallmark-chat-actions="catalogue" className="mt-auto min-w-0 w-full max-w-full space-y-2 overflow-hidden pt-8">
          <div className="flex items-center justify-between gap-3 px-1">
            <h4 className="text-sm font-extrabold text-[#4a343e]">Gợi ý sản phẩm</h4>
            <span className="text-xs font-medium text-[#927681]">{productSuggestions.length} sản phẩm • Vuốt để xem hết</span>
          </div>
          <div className="flex min-w-0 w-full max-w-full gap-3 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none]">
            {productSuggestions.map((suggestedProduct) => (
              <button
                key={suggestedProduct.id}
                type="button"
                data-dealer-product-suggestion="card"
                aria-label={`Xem và đặt ${suggestedProduct.name}`}
                title={suggestedProduct.name}
                className="flex h-[154px] w-[150px] shrink-0 flex-col rounded-2xl border border-[#f0d7e2] bg-white p-2 text-left shadow-sm transition-colors hover:border-[#df78a7] hover:bg-[#fffafb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d94f8a] sm:w-[164px]"
                onClick={() => onProductSuggestion(suggestedProduct)}
              >
                <div className="w-full shrink-0 overflow-hidden rounded-xl border border-[#f4e4eb] bg-[#fff7fa]">
                  {suggestedProduct.imageUrl ? (
                    <img src={suggestedProduct.imageUrl} alt={suggestedProduct.name} loading="lazy" className="h-20 w-full object-cover" />
                  ) : (
                    <div className="flex h-20 items-center justify-center bg-[#fff3f8]">
                      <img src={bmqLogo} alt="BMQ" className="h-10 w-10 object-contain" />
                    </div>
                  )}
                </div>
                <div className="mt-2 w-full truncate text-sm font-bold leading-5 text-[#4a343e]">{suggestedProduct.name}</div>
                <div className="mt-auto w-full truncate text-xs font-semibold text-[#c34f82]">{formatVnd(suggestedProduct.price)} / {suggestedProduct.unit}</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div ref={chatEndRef} aria-hidden="true" data-dealer-chat-scroll-anchor />

      <div
        data-hallmark-chat-composer="inline-sticky"
        className="sticky bottom-[max(12px,env(safe-area-inset-bottom))] z-20 mt-3 flex min-w-0 w-full max-w-full items-end gap-2 overflow-hidden rounded-[20px] border border-[#edccda] bg-white p-2 shadow-[0_8px_24px_rgba(105,49,73,0.1)] focus-within:ring-2 focus-within:ring-[#e8a6c3]"
      >
        <Textarea
          ref={composerRef}
          value={orderText}
          onChange={(event) => setOrderText(event.target.value)}
          placeholder="Nhắn BMQ Agent…"
          className="min-h-[52px] max-h-32 w-0 min-w-0 flex-1 resize-none border-0 bg-transparent text-base leading-6 text-[#3f2731] shadow-none placeholder:text-[#a98997] focus-visible:ring-0"
        />
        <Button
          type="button"
          size="icon"
          aria-label="Gửi nội dung đơn"
          className="h-12 w-12 shrink-0 whitespace-nowrap rounded-xl bg-[#d94f8a] text-white hover:bg-[#c43f79]"
          onClick={onParse}
          disabled={parseStatus === "processing" || !orderText.trim()}
        >
          {parseStatus === "processing" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
        </Button>
      </div>

      <Dialog open={detailOpen} onOpenChange={handleDetailOpenChange}>
        <DialogContent
          data-dealer-order-confirmation-mode={isEditingOrder ? "edit" : "review"}
          className="top-3 max-h-[calc(100dvh-1.5rem)] max-w-lg translate-y-0 overflow-y-auto rounded-[20px] border-[#efcfdd] bg-[#fff5f9] p-0 pb-[env(safe-area-inset-bottom)] text-[#4a343e] shadow-2xl sm:top-[50%] sm:translate-y-[-50%]"
        >
          <div className="sticky top-0 z-10 border-b border-[#f1dbe4] bg-[#fff5f9]/95 p-5 backdrop-blur">
            <DialogHeader>
              <DialogTitle className="text-xl font-display font-extrabold">
                {isEditingOrder ? "Chỉnh sửa đơn hàng" : "Xác nhận đơn hàng"}
              </DialogTitle>
              <DialogDescription className="text-sm text-[#927681]">
                {selectedRouteCount} dòng • giao {totalItems} {unitLabel} • tạm tính {formatVnd(cartTotal)}
              </DialogDescription>
            </DialogHeader>
          </div>
          <div className="space-y-3 p-5">
            {!isEditingOrder ? (
              <div className="border-b border-[#efcfdd] pb-4 text-sm font-medium leading-6 text-[#704f5e]">
                {isRetailDealer
                  ? "Quý Khách Hàng kiểm tra lại số lượng của đại lý trước khi xác nhận gửi đơn."
                  : "Quý Khách Hàng kiểm tra lại số lượng và điểm giao trước khi xác nhận gửi đơn."}
              </div>
            ) : null}
            {routes.map((route) => {
              const ordered = quantities[route.id] || 0;
              const exchange = exchangeQuantities[route.id] || 0;
              const makeup = makeupQuantities[route.id] || 0;
              const physical = ordered + exchange + makeup;
              if (physical <= 0) return null;
              return (
                <div key={route.id} className="border-b border-[#efcfdd] py-4 last:border-b-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-extrabold text-[#4a343e]">{route.name}</div>
                      <div className="mt-1 text-xs font-medium text-[#927681]">
                        Giao {physical} {unitLabel} • Tính tiền {ordered} {unitLabel}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-sm font-extrabold text-[#c43f79]">
                      {formatVnd(ordered * product.price)}
                    </div>
                  </div>
                  {isEditingOrder ? (
                    <>
                      <div className="mt-3 grid grid-cols-4 gap-2">
                        <MiniQuantityField label="Đặt" value={ordered} step={DEALER_ORDER_STEP} onChange={(value) => setQuantities((current) => ({ ...current, [route.id]: value }))} />
                        <MiniQuantityField label="Đổi" value={exchange} step={1} onChange={(value) => setExchangeQuantities((current) => ({ ...current, [route.id]: value }))} />
                        <MiniQuantityField label="Bù" value={makeup} step={1} onChange={(value) => setMakeupQuantities((current) => ({ ...current, [route.id]: value }))} />
                        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-2 py-2 text-center">
                          <div className="text-[11px] font-bold uppercase text-emerald-700">Giao</div>
                          <div className="mt-1 text-base font-extrabold text-[#4a343e]">{physical}</div>
                        </div>
                      </div>
                      <Input
                        value={notes[route.id] || ""}
                        placeholder="Ghi chú"
                        className="mt-2 h-10 rounded-2xl border-[#efcfdd] bg-white text-sm text-[#4a343e] focus-visible:ring-[#d94f8a]"
                        onChange={(event) => setNotes((current) => ({ ...current, [route.id]: event.target.value.slice(0, 160) }))}
                      />
                    </>
                  ) : (
                    <>
                      <div className="mt-3 grid grid-cols-4 divide-x divide-[#f1dbe4] border-y border-[#f1dbe4]" data-dealer-order-review-values>
                        {[
                          ["Đặt", ordered],
                          ["Đổi", exchange],
                          ["Bù", makeup],
                        ].map(([label, value]) => (
                          <div key={label} className="px-2 py-2 text-center">
                            <div className="text-[10px] font-bold uppercase text-[#a06f85]">{label}</div>
                            <div className="mt-1 text-base font-extrabold text-[#4a343e]">{value}</div>
                          </div>
                        ))}
                        <div className="px-2 py-2 text-center">
                          <div className="text-[10px] font-bold uppercase text-emerald-700">Giao</div>
                          <div className="mt-1 text-base font-extrabold text-[#4a343e]">{physical}</div>
                        </div>
                      </div>
                      {notes[route.id] ? (
                        <div className="mt-2 rounded-2xl bg-[#fff0f6] px-3 py-2 text-xs leading-5 text-[#704f5e]">
                          <span className="font-bold text-[#a73f70]">Ghi chú:</span> {notes[route.id]}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {errorMessage ? (
            <div
              data-dealer-order-confirmation-error
              aria-live="assertive"
              className="mx-5 mb-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold leading-5 text-red-700"
            >
              Chưa gửi được đơn: {errorMessage}
            </div>
          ) : null}
          <DialogFooter className="sticky bottom-0 grid grid-cols-2 gap-2 border-t border-[#f1dbe4] bg-[#fff5f9]/95 p-5 backdrop-blur sm:flex">
            <Button type="button" variant="outline" className="h-11 whitespace-nowrap rounded-xl border-[#e7b9cd] text-[#704f5e] hover:bg-[#fff0f6]" onClick={() => handleDetailOpenChange(false)}>
              Đóng
            </Button>
            {isEditingOrder ? (
              <Button type="button" className="h-11 whitespace-nowrap rounded-xl bg-[#d94f8a] font-bold text-white hover:bg-[#c43f79]" onClick={() => setIsEditingOrder(false)}>
                Lưu thay đổi
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" className="h-11 whitespace-nowrap rounded-xl border-[#e7b9cd] text-[#a73f70] hover:bg-[#fff0f6]" onClick={() => setIsEditingOrder(true)}>
                  Chỉnh sửa đơn
                </Button>
                <Button type="button" className="col-span-2 h-11 whitespace-nowrap rounded-xl bg-[#d94f8a] font-bold text-white hover:bg-[#c43f79] sm:col-span-1" disabled={!canSubmit || submitting} onClick={onSubmit}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Xác nhận & gửi đơn
                </Button>
              </>
            )}
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
    <label className="rounded-2xl border border-[#efcfdd] bg-white px-2 py-2 text-center">
      <span className="text-[11px] font-bold uppercase text-[#a06f85]">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={step}
        value={value || ""}
        placeholder="0"
        className="mt-1 h-9 border-0 bg-transparent p-0 text-center text-base font-extrabold text-[#4a343e] shadow-none focus-visible:ring-0"
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

const DEALER_CHAT_CONFIRMATION_INTENTS = new Set([
  "ok",
  "okay",
  "oke",
  "oki",
  "dong y",
  "xac nhan",
  "gui",
  "gui don",
  "chot don",
]);

const isDealerChatConfirmationIntent = (value: string) =>
  DEALER_CHAT_CONFIRMATION_INTENTS.has(normalizeDealerChatText(value));

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

function parseRetailDealerChatOrderText(text: string, retailDealerRoute: DealerRoute | null): ParsedDealerChatLine[] {
  if (!retailDealerRoute) return [];
  const rawLine = String(text || "").trim();
  if (!rawLine || rawLine.includes("\n")) return [];
  const normalizedLine = rawLine.replace(/^(?:đặt|dat)\s+/i, "");

  const orderedMatch = normalizedLine.match(/^\s*(\d+(?:[.,]\d+)?)\b/i);
  const exchangeMatch = normalizedLine.match(/(?:^|\s)(?:đổi|doi)\s+(\d+(?:[.,]\d+)?)/i);
  const makeupMatch = normalizedLine.match(/(?:^|\s)(?:bù|bu)\s+(\d+(?:[.,]\d+)?)/i);
  if (!orderedMatch && !exchangeMatch && !makeupMatch) return [];

  const orderedQuantity = numberFromDealerChatText(orderedMatch?.[1]);
  const exchangeQuantity = numberFromDealerChatText(exchangeMatch?.[1]);
  const makeupQuantity = numberFromDealerChatText(makeupMatch?.[1]);
  const physicalQuantity = orderedQuantity + exchangeQuantity + makeupQuantity;
  if (![orderedQuantity, exchangeQuantity, makeupQuantity, physicalQuantity].every(Number.isFinite) || physicalQuantity <= 0) return [];

  const note = normalizedLine
    .replace(/^\s*\d+(?:[.,]\d+)?\b/i, "")
    .replace(/(?:^|\s)(?:đổi|doi)\s+\d+(?:[.,]\d+)?/gi, " ")
    .replace(/(?:^|\s)(?:bù|bu)\s+\d+(?:[.,]\d+)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return [{
    route: retailDealerRoute,
    routeText: retailDealerRoute.name,
    orderedQuantity,
    exchangeQuantity,
    makeupQuantity,
    note,
  }];
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

