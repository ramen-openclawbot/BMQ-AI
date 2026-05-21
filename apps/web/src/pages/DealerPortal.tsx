import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  AlertCircle,
  BellRing,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  HelpCircle,
  Home,
  ImageIcon,
  Loader2,
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

const DEALER_SESSION_STORAGE_KEY = "bmq_dealer_session_token";

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
    name: product.product_name || product.sku_code || "SKU đại lý",
    unit: product.unit || "đơn vị",
    packSize: "Theo đơn vị bán",
    price,
    tag: priceSource === "customer_override" ? "Giá riêng" : product.category || "Thành phẩm",
    note: product.notes || "Sản phẩm thành phẩm BMQ.",
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
  const [catalogMessage, setCatalogMessage] = useState("Đăng nhập để tải sản phẩm, giá bán và ảnh từ Tổng quan giá vốn.");
  const [announcements, setAnnouncements] = useState<CatalogResponse["announcements"]>([]);
  const [dealerCustomer, setDealerCustomer] = useState<DealerCustomer | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [orderMessage, setOrderMessage] = useState("");
  const [orderError, setOrderError] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const loadCatalog = useCallback(async (token?: string) => {
    if (!token) {
      setCatalogProducts([]);
      setAnnouncements([]);
      setDealerCustomer(null);
      setCatalogStatus("idle");
      setCatalogMessage("Đăng nhập để tải sản phẩm, giá bán và ảnh từ Tổng quan giá vốn.");
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
          ? "Sản phẩm, giá bán và ảnh đã đồng bộ từ Tổng quan giá vốn."
          : "Chưa có SKU thành phẩm đang bật cho trang đặt hàng.",
      );
    } catch (error) {
      const message = await getFunctionErrorMessage(error, "Không tải được danh sách sản phẩm từ Tổng quan giá vốn.");
      setCatalogProducts([]);
      setAnnouncements([]);
      setCatalogStatus("error");
      setCatalogMessage(message || "Không tải được danh sách sản phẩm từ Tổng quan giá vốn.");
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
          : data?.message || "Nếu số điện thoại hợp lệ, mã OTP sẽ được gửi qua Zalo ZNS.",
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

      setOrderMessage(`Đã gửi đơn ${data?.order_number || ""}. BMQ sẽ xác nhận lại theo lịch vận hành.`);
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

  const updateQuantity = (productId: string, delta: number) => {
    setQuantities((current) => ({
      ...current,
      [productId]: Math.max(0, (current[productId] || 0) + delta),
    }));
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
          <Button variant="outline" size="sm" className="h-9 px-3" onClick={() => handleNav(navItems[3])}>
            <MessageCircle className="h-4 w-4" />
            Zalo OA
          </Button>
        </div>
      </header>

      <section
        id="dealer-top"
        className="border-b bg-gradient-to-br from-primary/15 via-background to-emerald-50/80 dark:to-emerald-950/20"
      >
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-5 md:grid-cols-[1.2fr_0.8fr] md:py-7">
          <div className="space-y-3">
            <Badge variant="secondary" className="rounded-md">
              Cổng đặt hàng đại lý
            </Badge>
            <div>
              <h1 className="text-2xl font-display font-bold leading-tight text-foreground md:text-4xl">
                Đặt bánh nhanh cho đại lý BMQ
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
                Chốt đơn theo ngày, xem nhanh khung giao, tổng tiền tạm tính và trạng thái xác thực trước khi gửi đơn thật.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs md:max-w-xl md:grid-cols-4">
              <div className="rounded-md border bg-card/80 p-3">
                <div className="font-semibold">20:00</div>
                <div className="text-muted-foreground">Cutoff hôm nay</div>
              </div>
              <div className="rounded-md border bg-card/80 p-3">
                <div className="font-semibold">Sáng mai</div>
                <div className="text-muted-foreground">Khung giao chính</div>
              </div>
              <div className="rounded-md border bg-card/80 p-3">
                <div className="font-semibold">ZNS OTP</div>
                <div className="text-muted-foreground">Xác thực số điện thoại</div>
              </div>
              <div className="rounded-md border bg-card/80 p-3">
                <div className="font-semibold">COD / công nợ</div>
                <div className="text-muted-foreground">Theo hồ sơ đại lý</div>
              </div>
            </div>
          </div>

          <div className="rounded-md border bg-card/85 p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-primary/10 p-2 text-primary">
                <Building2 className="h-5 w-5" />
              </div>
              <div>
                <div className="font-semibold">BMQ Company Ordering</div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Đăng nhập bằng số điện thoại đã đăng ký trong CRM, xác thực Zalo ZNS OTP và gửi đơn trực tiếp cho vận hành BMQ.
                </p>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-md border border-dashed bg-background/70 p-3 text-sm">
              <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
              <span className="text-muted-foreground">Đơn chỉ gửi khi phiên đại lý đã xác thực OTP và catalog thật tải thành công.</span>
            </div>
          </div>
        </div>
      </section>

      <main className="mx-auto grid max-w-6xl gap-4 px-4 pb-40 pt-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:pb-12">
        <div className="space-y-4">
          <Card className="rounded-md">
            <CardHeader className="p-4 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-lg">Đăng nhập đại lý</CardTitle>
                  <CardDescription className="mt-1">
                    Xác thực số điện thoại bằng Zalo ZNS OTP trước khi nhận đơn production.
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
                    Hệ thống sẽ kiểm tra số này trong CRM đại lý và gửi OTP qua Zalo ZNS nếu hợp lệ.
                  </div>
                  <Button className="h-11 w-full btn-gradient" onClick={handleStartAuth} disabled={authLoading}>
                    {authLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                    Gửi mã OTP Zalo ZNS
                  </Button>
                </div>
              ) : null}

              {loginStep === "otp" ? (
                <div className="space-y-4">
                  <div className="rounded-md bg-muted/60 p-3 text-sm">
                    <div className="font-medium">Zalo ZNS OTP</div>
                    <div className="mt-1 text-muted-foreground">
                      Nhập mã OTP đã gửi qua Zalo ZNS cho {phone.trim() || "số điện thoại đại lý"}.
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
                      Phiên OTP hợp lệ. Đơn gửi sẽ được ghi vào dealer_orders để vận hành xác nhận.
                    </div>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <section id="quick-order" className="scroll-mt-24 space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-xl font-display font-bold">Đặt nhanh</h2>
                <p className="mt-1 text-sm text-muted-foreground">{catalogMessage}</p>
              </div>
              <Badge variant="outline" className="rounded-md">
                {catalogStatus === "loading" ? "Đang tải" : `${catalogProducts.length} SKU`}
              </Badge>
            </div>

            {orderMessage ? (
              <div className="flex items-start gap-2 rounded-md border bg-success/10 p-3 text-sm text-success">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{orderMessage}</span>
              </div>
            ) : null}
            {orderError ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{orderError}</span>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              {catalogProducts.length === 0 ? (
                <div className="rounded-md border border-dashed bg-card p-5 text-sm text-muted-foreground md:col-span-2">
                  {catalogStatus === "loading"
                    ? "Đang tải sản phẩm từ Tổng quan giá vốn..."
                    : "Chưa có sản phẩm để đặt. Vui lòng đăng nhập hoặc kiểm tra SKU thành phẩm chưa bị ẩn khỏi trang đặt hàng."}
                </div>
              ) : null}
              {catalogProducts.map((product) => {
                const quantity = quantities[product.id] || 0;

                return (
                  <Card key={product.id} className="rounded-md">
                    <CardContent className="flex h-full flex-col gap-4 p-4">
                      <div className="overflow-hidden rounded-md border bg-muted/40">
                        {product.imageUrl ? (
                          <img
                            src={product.imageUrl}
                            alt={product.name}
                            loading="lazy"
                            className="h-32 w-full object-cover sm:h-36"
                          />
                        ) : (
                          <div className="flex h-32 w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-primary/10 via-background to-muted text-muted-foreground sm:h-36">
                            <ImageIcon className="h-6 w-6" />
                            <span className="text-xs">Chưa có ảnh SKU</span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Badge variant="secondary" className="mb-2 rounded-md">
                            {product.tag}
                          </Badge>
                          <h3 className="text-base font-semibold leading-snug">{product.name}</h3>
                          <p className="mt-1 text-sm leading-5 text-muted-foreground">{product.note}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="font-semibold">{formatVnd(product.price)}</div>
                          <div className="text-xs text-muted-foreground">{product.unit}</div>
                        </div>
                      </div>

                      <div className="mt-auto flex items-center justify-between gap-3">
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            <PackagePlus className="h-3.5 w-3.5" />
                            {product.packSize}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <BellRing className="h-3.5 w-3.5" />
                            {product.cutoff}
                          </div>
                        </div>
                        <div className="grid h-10 w-32 grid-cols-[40px_1fr_40px] overflow-hidden rounded-md border">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-10 rounded-none"
                            aria-label={`Giảm ${product.name}`}
                            onClick={() => updateQuantity(product.id, -1)}
                          >
                            <Minus className="h-4 w-4" />
                          </Button>
                          <div className="flex items-center justify-center border-x text-sm font-semibold">{quantity}</div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-10 rounded-none"
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
          </section>

          <section id="delivery-plan" className="scroll-mt-24 space-y-3">
            <h2 className="text-xl font-display font-bold">Giao hàng & thanh toán</h2>
            <div className="grid gap-3 md:grid-cols-3">
              <StatusTile
                icon={CalendarDays}
                title="Lịch giao"
                description="Khung chính: sáng hôm sau; tuyến giao sẽ lấy theo hồ sơ CRM khi vận hành xác nhận."
              />
              <StatusTile
                icon={MapPin}
                title="Điểm nhận"
                description="Địa chỉ sẽ lấy từ CRM sau khi OTP xác thực số điện thoại."
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
      </main>

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
            {totalItems} dòng hàng
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
        <CardDescription>Đơn sẽ được ghi vào dealer_orders sau khi đại lý xác thực OTP.</CardDescription>
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
            <span>Tổng số lượng</span>
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
          Cần OTP hợp lệ và catalog thật từ hệ thống BMQ trước khi gửi đơn production.
        </p>
      </CardContent>
    </Card>
  );
}

