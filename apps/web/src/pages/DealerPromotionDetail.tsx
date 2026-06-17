import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarDays, CheckCircle2, Loader2, ShoppingBag } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import bmqLogo from "@/assets/bmq-logo.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";

type DealerLandingBanner = {
  id?: string;
  eventLabel?: string;
  url?: string | null;
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
    banners?: DealerLandingBanner[];
  };
};

const DEALER_ORDERING_HOST = "dathang.banhmique.vn";

const getDealerHomePath = () => (window.location.hostname === DEALER_ORDERING_HOST ? "/" : "/dealer");

const normalizeList = (items?: string[]) => (Array.isArray(items) ? items.filter((item) => item.trim()).slice(0, 6) : []);

export default function DealerPromotionDetail() {
  const { bannerId } = useParams();
  const [banners, setBanners] = useState<DealerLandingBanner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const dealerHomePath = getDealerHomePath();

  const loadPromotion = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data, error: configError } = await callEdgeFunction<DealerPublicConfigResponse>("dealer-public-config", {}, undefined, 8000);
      if (configError) throw new Error(configError);
      const nextBanners = Array.isArray(data?.landing?.banners)
        ? data.landing.banners.filter((banner) => banner?.enabled !== false && Boolean(banner?.url)).slice(0, 3)
        : [];
      setBanners(nextBanners);
    } catch (err) {
      console.warn("Không tải được nội dung promotion đại lý", err);
      setError("Không tải được nội dung promotion. Anh/chị vui lòng quay lại trang đặt hàng và thử lại.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPromotion();
  }, [loadPromotion]);

  const promotion = useMemo(() => {
    if (!banners.length) return null;
    return banners.find((banner) => banner.id === bannerId) || banners[0];
  }, [bannerId, banners]);

  const highlights = normalizeList(promotion?.contentHighlights);
  const title = promotion?.contentTitle?.trim() || promotion?.eventLabel || "Ưu đãi đại lý BMQ";
  const intro = promotion?.contentIntro?.trim() || "Theo dõi chương trình promotion mới nhất dành riêng cho đại lý BMQ và đăng nhập để xem giá đang áp dụng.";

  return (
    <div className="min-h-screen bg-[#16110d] text-amber-50">
      <header className="border-b border-amber-400/10 bg-[#16110d]/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <Link to={dealerHomePath} className="flex items-center gap-3">
            <img src={bmqLogo} alt="BMQ" className="h-10 w-10 rounded-full bg-white object-contain p-1" />
            <div>
              <div className="font-display text-lg font-semibold leading-tight">Bánh Mì Que</div>
              <div className="text-xs text-amber-50/65">Promotion đại lý</div>
            </div>
          </Link>
          <Button asChild variant="outline" className="border-amber-300/35 bg-white/5 text-amber-50 hover:bg-white/10 hover:text-white">
            <Link to={dealerHomePath}>
              <ArrowLeft className="h-4 w-4" />
              Đặt hàng
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-5 px-4 py-5 pb-12">
        {loading ? (
          <Card className="border-amber-400/15 bg-[#20150d] text-amber-50">
            <CardContent className="flex items-center gap-3 p-5 text-sm text-amber-50/75">
              <Loader2 className="h-4 w-4 animate-spin" />
              Đang tải nội dung promotion...
            </CardContent>
          </Card>
        ) : error ? (
          <Card className="border-destructive/30 bg-destructive/10 text-amber-50">
            <CardContent className="p-5 text-sm">{error}</CardContent>
          </Card>
        ) : promotion ? (
          <>
            <section className="overflow-hidden rounded-[28px] border border-amber-400/20 bg-[#20150d] shadow-2xl shadow-black/30">
              {promotion.url ? <img src={promotion.url} alt={promotion.eventLabel || title} className="aspect-[16/10] w-full object-cover md:aspect-[16/7]" /> : null}
              <div className="space-y-4 p-5 md:p-7">
                <Badge className="rounded-full border border-amber-300/35 bg-amber-400/15 text-amber-100 hover:bg-amber-400/15">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {promotion.eventLabel || "Promotion BMQ"}
                </Badge>
                <div className="max-w-3xl space-y-3">
                  <h1 className="font-display text-3xl font-bold leading-tight text-white md:text-5xl">{title}</h1>
                  <p className="text-base leading-7 text-amber-50/80 md:text-lg">{intro}</p>
                </div>
                <Button asChild className="rounded-2xl bg-amber-500 font-semibold text-[#1b1208] hover:bg-amber-400">
                  <Link to={`${dealerHomePath}#dealer-login`}>
                    <ShoppingBag className="h-4 w-4" />
                    Đăng nhập để đặt hàng
                  </Link>
                </Button>
              </div>
            </section>

            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
              <Card className="border-amber-400/15 bg-[#20150d] text-amber-50">
                <CardHeader>
                  <CardTitle>Điểm nổi bật</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {highlights.length ? (
                    highlights.map((item, index) => (
                      <div key={`${item}-${index}`} className="flex gap-3 rounded-xl border border-amber-400/10 bg-white/[0.03] p-3">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                        <span className="text-sm leading-6 text-amber-50/82">{item}</span>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm leading-6 text-amber-50/70">Nội dung chi tiết đang được BMQ cập nhật. Anh/chị có thể đăng nhập để xem giá và chương trình đang áp dụng.</p>
                  )}
                </CardContent>
              </Card>

              <div className="space-y-4">
                <Card className="border-amber-400/15 bg-[#20150d] text-amber-50">
                  <CardHeader>
                    <CardTitle>Điều kiện áp dụng</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm leading-6 text-amber-50/75">
                    {promotion.contentTerms?.trim() || "Áp dụng theo hồ sơ đại lý, khu vực giao hàng và chính sách vận hành BMQ tại thời điểm đặt hàng."}
                  </CardContent>
                </Card>
                <Card className="border-amber-400/15 bg-[#20150d] text-amber-50">
                  <CardHeader>
                    <CardTitle>Ghi chú</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm leading-6 text-amber-50/75">
                    {promotion.contentNote?.trim() || "Cần hỗ trợ thêm, vui lòng liên hệ CSKH / Zalo OA BMQ."}
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        ) : (
          <Card className="border-amber-400/15 bg-[#20150d] text-amber-50">
            <CardContent className="p-5 text-sm text-amber-50/75">Chưa có promotion đang hiển thị.</CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
